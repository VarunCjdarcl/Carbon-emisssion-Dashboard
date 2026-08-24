const express = require('express');
const router = express.Router();

const db = require('../services/db');
const store = require('../services/shipmentStore');
const rollup = require('../services/rollup');
const etl = require('../services/etl');
const { resolvePreset, presetLabel } = require('../services/dateRange');

const ONE_DAY_MS = 86400000;
// Cache "we just pulled window X" per range so a chart with 3-4 concurrent
// requests (time + customers + customer-list) doesn't fire 3-4 TMS syncs.
// Entries expire after 5 min — enough to coalesce a page load, short enough
// that the next visit re-checks.
const lazyFillCache = new Map();
const LAZY_FILL_TTL_MS = 5 * 60 * 1000;

// If the requested window extends past what the ETL has synced, pull the
// missing slice from TMS on the spot and refresh the rollup so the chart
// renders with real data. Runs at most once per (from,till) window per 5 min.
// Never throws: if TMS is down or the token is bad, we log and let the caller
// aggregate whatever is already in the DB.
async function lazyFillIfStale(from, till) {
  try {
    const stats = db.getStats();
    const newest = stats.newest || 0;
    // Window fully inside what we already have → nothing to do.
    if (till <= newest + ONE_DAY_MS) return;
    const key = `${from}-${till}`;
    const cached = lazyFillCache.get(key);
    if (cached && Date.now() - cached < LAZY_FILL_TTL_MS) return;
    lazyFillCache.set(key, Date.now());
    console.log(`[lazyfill] window ${new Date(from).toISOString().slice(0,10)}..${new Date(till).toISOString().slice(0,10)} not covered (newest=${new Date(newest).toISOString().slice(0,10)}) — pulling from TMS`);
    await etl.ensureCovered(from, till);
    // ensureCovered writes shipments; refresh the rollup for the same window
    // so the aggregate query returns the fresh rows.
    rollup.refreshRange(from, till);
  } catch (err) {
    console.warn('[lazyfill] failed — serving whatever the DB has:', err.message);
  }
}

// GET /api/emissions/time?preset=thisMonth&from=&till=&customer=
router.get('/time', async (req, res, next) => {
  try {
    const { preset = 'thisMonth', from, till, customer, now } = req.query;
    const range = resolvePreset(preset, { from, till, now });
    await lazyFillIfStale(range.from, range.till);
    const agg = rollup.aggregateTime({ ...range, preset, customerCode: customer });
    res.json({
      preset,
      presetLabel: presetLabel(preset),
      range,
      ...agg,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/emissions/customers?preset=&from=&till=&customer=
router.get('/customers', async (req, res, next) => {
  try {
    const { preset = 'thisMonth', from, till, customer, now } = req.query;
    const range = resolvePreset(preset, { from, till, now });
    await lazyFillIfStale(range.from, range.till);
    const agg = rollup.aggregateByCustomer({ ...range, customerCode: customer });
    res.json({
      preset,
      presetLabel: presetLabel(preset),
      range,
      ...agg,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers — full list for the searchable dropdown.
// Source it from the DB (same data the customer chart aggregates) so the
// dropdown lists every customer that actually has shipments — otherwise, in
// demo/ETL-off mode store.listCustomers() returns only a tiny curated list and
// searching for a real customer from the chart finds nothing.
router.get('/customer-list', async (req, res, next) => {
  try {
    const dbRows = db.listAllCustomers();
    const list = (dbRows && dbRows.length)
      ? dbRows.map(r => ({ code: r.code, name: r.name, email: r.email }))
      : store.listCustomers();
    res.json({ customers: list });
  } catch (err) {
    next(err);
  }
});

// GET /api/emissions/customer-shipments?customer=<name>&preset=&from=&till=
// `customer` is the company NAME (the dashboard-wide identifier). Passed as a
// query param so names with dots/slashes/spaces don't break path routing.
router.get('/customer-shipments', async (req, res, next) => {
  try {
    const { customer, preset = 'thisMonth', from, till, now } = req.query;
    if (!customer) return res.status(400).json({ error: 'customer required' });
    const range = resolvePreset(preset, { from, till, now });
    await lazyFillIfStale(range.from, range.till);
    const filtered = db.getShipmentsByCustomerInRange(customer, range.from, range.till);

    res.json({
      preset,
      presetLabel: presetLabel(preset),
      range,
      customerCode: customer,
      customerName: filtered[0]?.customerName || customer,
      customerEmail: filtered[0]?.customerEmail || '',
      shipments: filtered,
      totals: summariseShipments(filtered),
    });
  } catch (err) {
    next(err);
  }
});

function summariseShipments(list) {
  let road = 0, rail = 0, dist = 0;
  for (const s of list) {
    if (typeof s.carbonEmissionValue === 'number') road += s.carbonEmissionValue;
    if (typeof s.aversionValue_rail === 'number') rail += s.aversionValue_rail;
    if (typeof s.totalDistance === 'number') dist += s.totalDistance;
  }
  return {
    totalShipments: list.length,
    totalEmission: round2(road),
    totalAversionRail: round2(rail),
    totalDistance: round2(dist),
  };
}
function round2(n) { return Math.round(n * 100) / 100; }

module.exports = router;
