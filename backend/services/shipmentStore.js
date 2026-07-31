// Read facade for the dashboard.  Decides DB-vs-TMS for any shipment read.
//
// - If the requested range is within what the ETL has synced, query SQLite
//   (sub-100ms even for 200k rows on commodity laptops thanks to the index).
// - If the range is outside, lazy-backfill via the ETL and then query SQLite.
// - If the ETL is disabled or the DB is empty, fall back to direct TMS pulls
//   (slow path — the old behavior).

const tms = require('./tmsClient');
const db = require('./db');
const etl = require('./etl');

const ETL_ENABLED = (process.env.ETL_ENABLED || 'true').toLowerCase() === 'true'
  && (process.env.DEMO_MODE || 'false').toLowerCase() !== 'true';

async function getShipmentsInRange({ from, till }) {
  if (!ETL_ENABLED) return tms.getShipmentsInRange({ from, till });

  const stats = db.getStats();
  if (stats.total === 0 || !stats.syncedFrom) {
    // ETL hasn't backfilled anything yet — answer from TMS direct so the
    // dashboard is usable while the first backfill runs.
    return tms.getShipmentsInRange({ from, till });
  }

  // Lazy-backfill any uncovered slice (rare in steady state).
  if (from < stats.syncedFrom || till > stats.syncedTill) {
    try {
      await etl.ensureCovered(from, till);
    } catch (err) {
      console.warn('[store] lazy-backfill failed, falling back to TMS:', err.message);
      return tms.getShipmentsInRange({ from, till });
    }
  }

  return db.getShipmentsInRange(from, till);
}

function listCustomers() {
  if (!ETL_ENABLED) return tms.listCustomers();
  const rows = db.listAllCustomers();
  // The ETL covers a wide window so this list is far more complete than what
  // the in-memory cache produces.  Keep the legacy shape: {code, name, email}.
  return rows.map(r => ({ code: r.code, name: r.name, email: r.email }));
}

async function getShipmentDetail(id) {
  // Detail is per-id: serve from DB if present, else TMS.
  // The DB row already has the dashboard-shaped fields the certificate /
  // drill-down need; for the few extras (raw consignments, fleetInfo) the
  // TMS detail endpoint is still the authority.
  return tms.getShipmentDetail(id);
}

function getEtlStatus() {
  return db.getStats();
}

module.exports = {
  getShipmentsInRange,
  listCustomers,
  getShipmentDetail,
  getEtlStatus,
  isEtlEnabled: () => ETL_ENABLED,
};
