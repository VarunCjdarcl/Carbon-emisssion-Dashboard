const axios = require('axios');
const { shipments: MOCK_SHIPMENTS, customers: MOCK_CUSTOMERS } = require('../data/mockShipments');

const BASE = process.env.TMS_BASE_URL || 'https://tmsapis.cjdarcl.com';
const TOKEN = process.env.TMS_AUTH_TOKEN || '';
const DEMO = (process.env.DEMO_MODE || 'true').toLowerCase() === 'true';

const http = axios.create({
  baseURL: BASE,
  timeout: 120000,
  headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
});

// Per-uuid cache for full shipment detail (used by drill-down only).0
const detailCache = new Map();

// Cache list results by date-range query.  The TMS list endpoint at size=5000
// returns the full set of customFields we need (carbonEmissionValue,
// aversionValue_rail, TotalDistance, vehicle, stages, consignments — same
// shape as the detail endpoint), so we no longer fan out per-shipment.
const listCache = new Map();
const LIST_TTL_MS = 30 * 60 * 1000;
// Single in-flight promise per cacheKey, so concurrent dashboard endpoints
// (time + customers + customer-list) trigger only one upstream fetch.
const inFlight = new Map();
// Per-window upstream page size.  The TMS list endpoint accepts up to ~10k
// per call, but anything above ~2000 frequently makes nginx return 504, and
// concurrent large queries make it worse.  At size=2000 a single 7-day window
// completes in ~3-5s and rarely hits the cap.
const PAGE_SIZE = 2000;

function cfMap(item) {
  if (!item || !Array.isArray(item.customFields)) return {};
  const out = {};
  for (const cf of item.customFields) {
    if (!cf) continue;
    out[cf.fieldKey] = cf.value;
  }
  return out;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Map a TMS list-or-detail item into the shape the dashboard works with.
// The list endpoint returns an array of shipment objects whose business
// fields live in `customFields[]` (an array of {fieldKey,value}).  The
// detail endpoint returns one such object plus extra arrays like
// `consignments` and `shipmentStages` we can mine for source/destination.
function mapShipment(item) {
  if (!item) return null;
  const cf = cfMap(item);

  // Source / destination — prefer the hub.name on each shipment stage
  // because stageName sometimes contains "undefined, ..." junk, and hub.name
  // is consistently a clean place name (e.g. "PATAUDI", "MERAMUNDALI").
  const cleanStage = s => {
    if (!s) return null;
    const trimmed = String(s).replace(/^undefined,\s*/i, '').trim();
    return trimmed || null;
  };
  const stageName = stage =>
    cleanStage(stage?.hub?.name) ||
    cleanStage(stage?.place?.name) ||
    cleanStage(stage?.stageName) ||
    cleanStage(stage?.location?.name) ||
    null;
  let source = null, destination = null;
  if (Array.isArray(item.shipmentStages) && item.shipmentStages.length > 0) {
    source = stageName(item.shipmentStages[0]);
    destination = stageName(item.shipmentStages[item.shipmentStages.length - 1]);
  }
  if ((!source || !destination) && Array.isArray(item.consignments) && item.consignments.length) {
    const c = item.consignments[0];
    source = source || cleanStage(c?.source?.name) || cleanStage(c?.origin?.name);
    destination = destination || cleanStage(c?.destination?.name);
  }

  // Vehicle type — vehicleLoadType.name is the descriptive label
  // (e.g. "TRUCK-16W_FULLBODY_30FT"), category is the family bucket, and
  // the registration number is a last-resort identifier.
  const vehicleType = item.fleetInfo?.vehicle?.vehicleLoadType?.name
                   || item.fleetInfo?.vehicle?.category
                   || item.fleetInfo?.vehicle?.vehicleType
                   || item.fleetInfo?.vehicle?.vehicleRegistrationNumber
                   || null;

  // Consignment number — derive from consignments array if present
  const consignmentNumber = (Array.isArray(item.consignments) && item.consignments.length)
    ? item.consignments.map(c => c.consignmentNumber || c.cnNumber).filter(Boolean).join('|')
    : (cf.consignmentNumber || null);

  // Customer name — `CustomerName` and `customerNames` are both populated on
  // different shipments (legacy vs new schema); take whichever has a value.
  // Some shipments are "empty run" repositioning legs with no customer — group
  // those under a distinct bucket so they don't pollute customer counts.
  let customerName = cf.CustomerName || cf.customerNames || null;
  let customerCode;
  if (!customerName && cf.EmptyRunReason) {
    customerName = 'Empty Runs';
    customerCode = 'EMPTY_RUN';
  } else {
    // Customer code — `customerExtIds` is the stable upstream code; fall back
    // to a slug of the customer name so similar names group together cleanly.
    customerCode = cf.customerExtIds
      || (customerName ? slugify(customerName) : null)
      || 'UNKNOWN';
  }

  // The TMS data uses ISO transportationMode like "ByRoad" / "ByRail"
  const mode = item.transportationMode || cf.transportationMode || 'ByRoad';

  return {
    id: item.uuid || item.id,
    shipmentNo: item.shipmentNumber || cf.shipmentNumber || null,
    consignmentNumber,
    vehicleType,
    source,
    destination,
    transportationMode: mode,
    carbonEmissionValue: num(cf.carbonEmissionValue),
    // Detail responses use TotalDistance (a per-shipment computed value);
    // list responses use "Route Km" which is often 0. Prefer the detail one.
    totalDistance: num(cf.TotalDistance) ?? num(cf['Route Km']) ?? num(cf.totalDistance),
    fuelUsed: num(cf.fuelUsed) ?? num(cf.FuelUsed),
    aversionValue_lng: num(cf.aversionValue_lng),
    aversionValue_electric: num(cf.aversionValue_electric),
    aversionValue_hydrogen: num(cf.aversionValue_hydrogen),
    aversionValue_rail: num(cf.aversionValue_rail),
    customerCode,
    customerName: customerName || customerCode,
    customerEmail: cf.customerEmail || null,
    completionTime: item.completionTime || null,
    shipmentDate: item.shipmentDate || null,
    status: item.shipmentStatus || null,
    raw: undefined, // omit raw to keep payloads small
  };
}

function slugify(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24);
}

async function fetchListPage({ from, till, shipmentType = null, size = PAGE_SIZE }) {
  // The TMS list endpoint accepts a `filters` JSON blob plus `activeShipments`
  // and `size`.  Pagination params (skip/offset/page/limit) are silently
  // ignored — only `size` actually affects the response.  At size>=500 the
  // response includes the same custom fields the detail endpoint returns
  // (carbonEmissionValue, aversionValue_rail, TotalDistance, vehicle, stages,
  // consignments), so we don't need to fan out per-shipment.
  // Without `shipmentType` the endpoint returns only road (ByRoad) shipments;
  // shipmentType=["MainLeg"] returns rail (ByTrain) shipments which is the
  // only place `aversionValue_rail` is populated.
  const filters = {
    __version: 2,
    completionTime: {
      isTillExpression: false,
      isFromExpression: false,
      from, till,
    },
  };
  if (shipmentType) filters.shipmentType = shipmentType;
  const params = {
    filters: JSON.stringify(filters),
    activeShipments: true,
    size,
  };
  const res = await http.get('/shipment-view/shipments/v1', { params });
  return Array.isArray(res.data) ? res.data : (res.data?.data || res.data?.items || []);
}

// Fetch every shipment of `shipmentType` in [from..till].  TMS's nginx times
// out (504) on broad-range / size=5000 queries and resets connections under
// concurrent load, so we proactively slice into ~7-day windows, fetch with
// bounded concurrency, and retry transient failures.
const CHUNK_MS = 14 * 86400000;
const MAX_CONCURRENCY = 4;
const RETRYABLE = new Set([502, 503, 504]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchListPageWithRetry(args, { attempts = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchListPage(args);
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      const code = e?.code;
      const retryable =
        RETRYABLE.has(status) ||
        code === 'ECONNRESET' ||
        code === 'ECONNABORTED' ||
        code === 'ETIMEDOUT';
      if (!retryable || i === attempts - 1) throw e;
      // Backoff: 1s, 2s, 4s
      await sleep(1000 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

async function fetchWindow({ from, till, shipmentType }) {
  const arr = await fetchListPageWithRetry({ from, till, shipmentType, size: PAGE_SIZE });
  if (arr.length < PAGE_SIZE) return arr;
  const ONE_DAY_MS = 86400000;
  if (till - from <= ONE_DAY_MS) return arr;
  const mid = Math.floor((from + till) / 2);
  const [a, b] = await Promise.all([
    fetchWindow({ from, till: mid, shipmentType }),
    fetchWindow({ from: mid + 1, till, shipmentType }),
  ]);
  return a.concat(b);
}

async function fetchSlice({ from, till, shipmentType }) {
  // Map each window's raw items to the compact dashboard shape immediately
  // so the heavy raw response objects (5–10kB each, including nested stages,
  // consignments, fleetInfo, customField metadata) can be GC'd before the
  // next batch.  Without this, large queries (months × many windows) pin
  // hundreds of MB of raw response data and OOM the process.
  const windows = [];
  for (let cur = from; cur <= till; cur += CHUNK_MS) {
    windows.push({ from: cur, till: Math.min(cur + CHUNK_MS - 1, till) });
  }
  const out = [];
  let failed = 0;
  for (let i = 0; i < windows.length; i += MAX_CONCURRENCY) {
    const batch = windows.slice(i, i + MAX_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(w => fetchWindow({ ...w, shipmentType })),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const raw of r.value) {
          const mapped = mapShipment(raw);
          if (mapped) out.push(mapped);
        }
        // Help GC: drop the array reference held by the settled value
        r.value.length = 0;
      } else {
        failed++;
        console.warn('[tms] window fetch failed', shipmentType, r.reason?.message || r.reason);
      }
    }
  }
  if (failed) console.warn(`[tms] slice ${shipmentType ? 'rail' : 'road'} returned ${out.length} items with ${failed}/${windows.length} windows failing`);
  return out;
}

// Returns the compact (already-mapped) shape directly — callers can use them
// as-is without another mapShipment pass.
async function fetchAllShipmentsInRange({ from, till }) {
  const [road, rail] = await Promise.all([
    fetchSlice({ from, till, shipmentType: null }),
    fetchSlice({ from, till, shipmentType: ['MainLeg'] }),
  ]);
  const seen = new Set();
  const out = [];
  for (const it of road) { if (it.id && !seen.has(it.id)) { seen.add(it.id); out.push(it); } }
  for (const it of rail) { if (it.id && !seen.has(it.id)) { seen.add(it.id); out.push(it); } }
  return out;
}

async function listCompletedShipments({ from, till }) {
  if (DEMO) {
    return MOCK_SHIPMENTS
      .filter(s => s.completionTime >= from && s.completionTime <= till)
      .map(s => ({ id: s.id, completionTime: s.completionTime }));
  }
  const items = await fetchAllShipmentsInRange({ from, till });
  return items.map(it => ({ id: it.id, completionTime: it.completionTime }));
}

async function getShipmentDetail(shipmentId) {
  if (DEMO) {
    return MOCK_SHIPMENTS.find(s => s.id === shipmentId) || null;
  }
  if (detailCache.has(shipmentId)) return detailCache.get(shipmentId);
  try {
    const res = await http.get(`/shipment/v1/shipment/${shipmentId}`, {
      params: { skipCn: true },
    });
    const data = res.data?.data || res.data || {};
    if (!data || data === null) return null;
    const mapped = mapShipment(data);
    if (mapped) detailCache.set(shipmentId, mapped);
    return mapped;
  } catch (e) {
    return null;
  }
}

// Live (TMS-direct) read path.  Used by the ETL worker to populate SQLite
// and as a fallback when the DB doesn't cover the requested range.
async function getShipmentsInRange({ from, till }) {
  if (DEMO) {
    return MOCK_SHIPMENTS.filter(s => s.completionTime >= from && s.completionTime <= till);
  }
  const cacheKey = `${from}-${till}`;
  const cached = listCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < LIST_TTL_MS) return cached.data;

  // Coalesce concurrent dashboard endpoints (time + customers + customer-list)
  // into a single upstream fetch — without this, every request fans out.
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const promise = (async () => {
    // Items come back already mapped (compact form) so we don't double-map.
    const items = await fetchAllShipmentsInRange({ from, till });
    const filtered = [];
    for (const s of items) {
      const ts = s.completionTime || s.shipmentDate;
      if (!ts) continue;
      if (ts < from || ts > till) continue;
      if (!s.completionTime) s.completionTime = s.shipmentDate;
      filtered.push(s);
    }
    listCache.set(cacheKey, { at: Date.now(), data: filtered });
    return filtered;
  })().finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, promise);
  return promise;
}

function listCustomers() {
  if (DEMO) return MOCK_CUSTOMERS;
  // Build live customer list from the most recent cached page (or empty if
  // nothing fetched yet).  Future enhancement: derive from a recent fetch.
  const seen = new Map();
  for (const entry of listCache.values()) {
    for (const s of entry.data) {
      if (!s.customerCode) continue;
      if (!seen.has(s.customerCode)) {
        seen.set(s.customerCode, {
          code: s.customerCode,
          name: s.customerName || s.customerCode,
          email: s.customerEmail || '',
        });
      }
    }
  }
  return Array.from(seen.values());
}

module.exports = {
  isDemo: () => DEMO,
  listCompletedShipments,
  getShipmentDetail,
  getShipmentsInRange,
  listCustomers,
  // Exposed so the ETL worker can pull-and-store directly without going
  // through the in-memory cache layer.
  fetchAllShipmentsInRange,
  mapShipment,
};
