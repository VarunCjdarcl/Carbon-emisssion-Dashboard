// ETL: pulls shipments from TMS into the local SQLite store.
//
// Three modes:
//   - backfill(days): first-run / catch-up sync of a long window.  Runs in
//     14-day chunks with progress logging.
//   - syncIncremental(): runs every 15 min, syncs the last 14 days (overlap
//     catches any post-completion updates to recent shipments).
//   - syncFullRefresh(): runs nightly, re-syncs from synced_from..now to pick
//     up any backdated changes to historical shipments.

const tms = require('./tmsClient');
const db = require('./db');
// `rollup` is loaded lazily — it depends on `db`, and requiring at module top
// would create a load-order dependency during db bootstrap.
let rollup;
function refreshRollupSafe(from, till) {
  try {
    if (!rollup) rollup = require('./rollup');
    rollup.refreshRange(from, till);
  } catch (err) {
    console.warn('[etl] post-sync rollup refresh failed:', err.message);
  }
}

const ONE_DAY_MS = 86400000;
const BACKFILL_DAYS = Number(process.env.ETL_BACKFILL_DAYS || 180);
const INCREMENTAL_DAYS = Number(process.env.ETL_INCREMENTAL_DAYS || 14);
const INCREMENTAL_INTERVAL_MS = Number(process.env.ETL_INCREMENTAL_INTERVAL_MS || 15 * 60 * 1000);
const FULL_REFRESH_INTERVAL_MS = Number(process.env.ETL_FULL_REFRESH_INTERVAL_MS || 24 * 60 * 60 * 1000);
// We sync the long backfill in 14-day chunks so progress is visible and
// failures retry only the last chunk, not the whole window.
const BACKFILL_CHUNK_MS = 14 * ONE_DAY_MS;

let inProgress = null; // promise of the in-flight sync, if any

async function syncRange(from, till, label = 'sync') {
  const t0 = Date.now();
  // Reuse tmsClient's window-sliced, retried, GC-friendly fetch path.  It
  // already returns mapped shipment objects in dashboard shape.
  const items = await tms.fetchAllShipmentsInRange({ from, till });
  db.upsertMany(items);
  // Keep the daily rollup in sync with the shipments we just wrote — otherwise
  // fresh shipments only show up in charts after the next 02:00 IST rebuild.
  if (items.length > 0) refreshRollupSafe(from, till);
  const elapsed = Date.now() - t0;
  console.log(`[etl] ${label} ${new Date(from).toISOString().slice(0,10)}..${new Date(till).toISOString().slice(0,10)}: ${items.length} shipments in ${elapsed}ms`);
  return items.length;
}

async function backfill(days = BACKFILL_DAYS) {
  const now = Date.now();
  const from = now - days * ONE_DAY_MS;
  const till = now;
  console.log(`[etl] backfill starting: ${days} days, ${new Date(from).toISOString().slice(0,10)}..${new Date(till).toISOString().slice(0,10)}`);
  // Reverse-chronological: most-recent chunks first so the dashboard becomes
  // useful for thisMonth/last30 long before the older chunks finish.
  const chunks = [];
  for (let cur = till; cur > from; cur -= BACKFILL_CHUNK_MS) {
    const chunkFrom = Math.max(from, cur - BACKFILL_CHUNK_MS);
    chunks.push({ from: chunkFrom, till: cur });
  }
  // Pre-set synced_till so dashboard reads stop falling back to TMS for
  // already-covered "right edge" queries the instant the first chunk lands.
  db.setState('synced_till', String(till));
  let total = 0;
  let coveredFrom = till; // shrinks toward `from` as chunks complete
  for (const chunk of chunks) {
    try {
      total += await syncRange(chunk.from, chunk.till, 'backfill chunk');
      // Extend the covered window as far back as this chunk reaches.
      coveredFrom = Math.min(coveredFrom, chunk.from);
      db.setState('synced_from', String(coveredFrom));
      db.setState('last_sync_at', String(Date.now()));
    } catch (err) {
      console.warn('[etl] backfill chunk failed, continuing:', err.message);
    }
  }
  console.log(`[etl] backfill complete: ${total} shipments inserted/updated, covered ${new Date(coveredFrom).toISOString().slice(0,10)}..${new Date(till).toISOString().slice(0,10)}`);
  return total;
}

async function syncIncremental() {
  const now = Date.now();
  const from = now - INCREMENTAL_DAYS * ONE_DAY_MS;
  const till = now;
  const count = await syncRange(from, till, 'incremental');
  // Advance the right edge of synced range; the left edge stays where the
  // backfill set it.
  const syncedTill = Number(db.getState('synced_till')) || 0;
  if (till > syncedTill) db.setState('synced_till', String(till));
  db.setState('last_sync_at', String(now));
  return count;
}

async function syncFullRefresh() {
  const syncedFrom = Number(db.getState('synced_from'));
  const now = Date.now();
  if (!syncedFrom) return backfill();
  const count = await syncRange(syncedFrom, now, 'full refresh');
  db.setState('synced_till', String(now));
  db.setState('last_sync_at', String(now));
  return count;
}

// Lazy backfill: when the dashboard asks for a range outside what the DB has
// covered, fetch just the missing left-hand portion.
async function ensureCovered(from, till) {
  const syncedFrom = Number(db.getState('synced_from')) || Infinity;
  const syncedTill = Number(db.getState('synced_till')) || 0;
  if (from >= syncedFrom && till <= syncedTill) return; // already covered
  // Pull the gaps.  We don't try to be clever about overlapping windows —
  // upsert is idempotent so re-syncing a sliver is fine.
  if (from < syncedFrom) {
    const t0 = Date.now();
    console.log(`[etl] lazy-backfill ${new Date(from).toISOString().slice(0,10)}..${new Date(syncedFrom).toISOString().slice(0,10)}`);
    await syncRange(from, syncedFrom - 1, 'lazy backfill');
    db.setState('synced_from', String(from));
    console.log(`[etl] lazy-backfill done in ${Date.now() - t0}ms`);
  }
  if (till > syncedTill) {
    await syncRange(syncedTill, till, 'lazy forward');
    db.setState('synced_till', String(till));
  }
}

// Coalesce concurrent syncIncremental triggers (timer + manual call) so we
// never have two upstream pulls fighting each other.
function singleflight(fn) {
  return async (...args) => {
    if (inProgress) return inProgress;
    inProgress = (async () => {
      try { return await fn(...args); }
      finally { inProgress = null; }
    })();
    return inProgress;
  };
}

const syncIncrementalSafe = singleflight(syncIncremental);
const syncFullRefreshSafe = singleflight(syncFullRefresh);

function start() {
  if ((process.env.DEMO_MODE || 'true').toLowerCase() === 'true') {
    console.log('[etl] demo mode — ETL disabled');
    return;
  }
  // Decide initial action: empty DB → backfill; otherwise → incremental
  const stats = db.getStats();
  if (stats.total === 0 || !stats.syncedFrom) {
    console.log('[etl] empty DB — kicking off backfill');
    backfill().catch(err => console.error('[etl] backfill failed:', err.message));
  } else {
    console.log(`[etl] DB has ${stats.total} shipments (${new Date(stats.oldest).toISOString().slice(0,10)} .. ${new Date(stats.newest).toISOString().slice(0,10)}) — running incremental catch-up`);
    syncIncrementalSafe().catch(err => console.error('[etl] catch-up failed:', err.message));
  }
  // Schedule periodic syncs
  setInterval(() => {
    syncIncrementalSafe().catch(err => console.warn('[etl] periodic incremental failed:', err.message));
  }, INCREMENTAL_INTERVAL_MS);
  setInterval(() => {
    syncFullRefreshSafe().catch(err => console.warn('[etl] periodic full refresh failed:', err.message));
  }, FULL_REFRESH_INTERVAL_MS);
}

module.exports = {
  start,
  syncRange,
  backfill,
  syncIncremental: syncIncrementalSafe,
  syncFullRefresh: syncFullRefreshSafe,
  ensureCovered,
};
