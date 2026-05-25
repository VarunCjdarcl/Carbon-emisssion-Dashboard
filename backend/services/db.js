// Local SQLite store for the dashboard.  Holds one row per shipment plus a
// small key-value table for ETL bookkeeping.  All numbers are kept as their
// natural types (INTEGER for ms timestamps, REAL for emissions / distance)
// so we can do range queries and SUM aggregates straight in SQL.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DASHBOARD_DB_PATH
  || path.join(__dirname, '..', 'data', 'dashboard.sqlite');

// Ensure the data directory exists before SQLite tries to open the file.
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');         // concurrent read safety + faster
db.pragma('synchronous = NORMAL');       // good durability/speed balance
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 268435456');      // 256MB mmap for large scans

db.exec(`
CREATE TABLE IF NOT EXISTS shipments (
  id                       TEXT PRIMARY KEY,
  shipment_no              TEXT,
  consignment_number       TEXT,
  vehicle_type             TEXT,
  source                   TEXT,
  destination              TEXT,
  transportation_mode      TEXT,
  carbon_emission_value    REAL,
  total_distance           REAL,
  fuel_used                TEXT,
  aversion_value_lng       REAL,
  aversion_value_electric  REAL,
  aversion_value_hydrogen  REAL,
  aversion_value_rail      REAL,
  customer_code            TEXT,
  customer_name            TEXT,
  customer_email           TEXT,
  completion_time          INTEGER,
  shipment_date            INTEGER,
  status                   TEXT,
  updated_at               INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ship_completion ON shipments(completion_time);
CREATE INDEX IF NOT EXISTS idx_ship_customer   ON shipments(customer_code);
CREATE INDEX IF NOT EXISTS idx_ship_mode       ON shipments(transportation_mode);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

const upsertStmt = db.prepare(`
INSERT INTO shipments (
  id, shipment_no, consignment_number, vehicle_type, source, destination,
  transportation_mode, carbon_emission_value, total_distance, fuel_used,
  aversion_value_lng, aversion_value_electric, aversion_value_hydrogen, aversion_value_rail,
  customer_code, customer_name, customer_email,
  completion_time, shipment_date, status, updated_at
) VALUES (
  @id, @shipment_no, @consignment_number, @vehicle_type, @source, @destination,
  @transportation_mode, @carbon_emission_value, @total_distance, @fuel_used,
  @aversion_value_lng, @aversion_value_electric, @aversion_value_hydrogen, @aversion_value_rail,
  @customer_code, @customer_name, @customer_email,
  @completion_time, @shipment_date, @status, @updated_at
)
ON CONFLICT(id) DO UPDATE SET
  shipment_no             = excluded.shipment_no,
  consignment_number      = excluded.consignment_number,
  vehicle_type            = excluded.vehicle_type,
  source                  = excluded.source,
  destination             = excluded.destination,
  transportation_mode     = excluded.transportation_mode,
  carbon_emission_value   = excluded.carbon_emission_value,
  total_distance          = excluded.total_distance,
  fuel_used               = excluded.fuel_used,
  aversion_value_lng      = excluded.aversion_value_lng,
  aversion_value_electric = excluded.aversion_value_electric,
  aversion_value_hydrogen = excluded.aversion_value_hydrogen,
  aversion_value_rail     = excluded.aversion_value_rail,
  customer_code           = excluded.customer_code,
  customer_name           = excluded.customer_name,
  customer_email          = excluded.customer_email,
  completion_time         = excluded.completion_time,
  shipment_date           = excluded.shipment_date,
  status                  = excluded.status,
  updated_at              = excluded.updated_at
`);

// Convert the dashboard-shape shipment object (from tmsClient.mapShipment)
// into the SQL row shape.  Null-safe.
function rowFromShipment(s, now = Date.now()) {
  return {
    id: s.id,
    shipment_no: s.shipmentNo || null,
    consignment_number: s.consignmentNumber || null,
    vehicle_type: s.vehicleType || null,
    source: s.source || null,
    destination: s.destination || null,
    transportation_mode: s.transportationMode || null,
    carbon_emission_value: numOrNull(s.carbonEmissionValue),
    total_distance: numOrNull(s.totalDistance),
    fuel_used: s.fuelUsed || null,
    aversion_value_lng: numOrNull(s.aversionValue_lng),
    aversion_value_electric: numOrNull(s.aversionValue_electric),
    aversion_value_hydrogen: numOrNull(s.aversionValue_hydrogen),
    aversion_value_rail: numOrNull(s.aversionValue_rail),
    customer_code: s.customerCode || null,
    customer_name: s.customerName || null,
    customer_email: s.customerEmail || null,
    completion_time: s.completionTime || null,
    shipment_date: s.shipmentDate || null,
    status: s.status || null,
    updated_at: now,
  };
}

// Reverse: SQL row -> dashboard shape
function shipmentFromRow(r) {
  return {
    id: r.id,
    shipmentNo: r.shipment_no,
    consignmentNumber: r.consignment_number,
    vehicleType: r.vehicle_type,
    source: r.source,
    destination: r.destination,
    transportationMode: r.transportation_mode,
    carbonEmissionValue: r.carbon_emission_value,
    totalDistance: r.total_distance,
    fuelUsed: r.fuel_used,
    aversionValue_lng: r.aversion_value_lng,
    aversionValue_electric: r.aversion_value_electric,
    aversionValue_hydrogen: r.aversion_value_hydrogen,
    aversionValue_rail: r.aversion_value_rail,
    customerCode: r.customer_code,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    completionTime: r.completion_time,
    shipmentDate: r.shipment_date,
    status: r.status,
  };
}

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Bulk upsert.  Wrapped in a single transaction — better-sqlite3 handles
// 50k inserts/sec when batched this way (vs ~5k/sec without).
const upsertMany = db.transaction((shipments) => {
  const now = Date.now();
  for (const s of shipments) {
    if (!s || !s.id) continue;
    upsertStmt.run(rowFromShipment(s, now));
  }
});

// Range query.  Uses idx_ship_completion.  Falls back to shipment_date when
// completion_time is null so partially-completed legs still appear.
const rangeStmt = db.prepare(`
SELECT * FROM shipments
WHERE COALESCE(completion_time, shipment_date) BETWEEN ? AND ?
ORDER BY COALESCE(completion_time, shipment_date) DESC
`);

function getShipmentsInRange(from, till) {
  return rangeStmt.all(from, till).map(shipmentFromRow);
}

const countStmt = db.prepare(`
SELECT COUNT(*) AS n FROM shipments
WHERE COALESCE(completion_time, shipment_date) BETWEEN ? AND ?
`);
function countShipmentsInRange(from, till) {
  return countStmt.get(from, till).n;
}

// Indexed lookup for a single customer's shipments inside a range.  Used by
// drill-down + excel export + certificate so we never load 600k rows just to
// filter one customer out.
const customerRangeStmt = db.prepare(`
SELECT * FROM shipments
WHERE customer_code = ?
  AND COALESCE(completion_time, shipment_date) BETWEEN ? AND ?
ORDER BY COALESCE(completion_time, shipment_date) DESC
`);
function getShipmentsByCustomerInRange(code, from, till) {
  return customerRangeStmt.all(code, from, till).map(shipmentFromRow);
}

// Per-customer totals straight from the raw shipments table.  Used by the
// certificate endpoint which only needs sums + a name/email.
const customerTotalsStmt = db.prepare(`
SELECT MAX(customer_name)  AS customer_name,
       MAX(customer_email) AS customer_email,
       SUM(COALESCE(carbon_emission_value, 0)) AS road,
       SUM(COALESCE(aversion_value_rail, 0))   AS rail,
       SUM(COALESCE(total_distance, 0))        AS distance,
       COUNT(*) AS cnt
FROM shipments
WHERE customer_code = ?
  AND COALESCE(completion_time, shipment_date) BETWEEN ? AND ?
`);
function getCustomerTotals(code, from, till) {
  const r = customerTotalsStmt.get(code, from, till) || {};
  return {
    customerName: r.customer_name || code,
    customerEmail: r.customer_email || '',
    totalEmission: Number(r.road) || 0,
    totalAversionRail: Number(r.rail) || 0,
    totalDistance: Number(r.distance) || 0,
    shipmentCount: Number(r.cnt) || 0,
  };
}

// Sync state: last_synced_from, last_synced_till
const getStateStmt = db.prepare('SELECT value FROM sync_state WHERE key = ?');
const setStateStmt = db.prepare(
  'INSERT INTO sync_state(key, value) VALUES (?, ?) ' +
  'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
function getState(key) {
  const r = getStateStmt.get(key);
  return r ? r.value : null;
}
function setState(key, value) {
  setStateStmt.run(key, String(value));
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM shipments').get().n;
  const oldest = db.prepare('SELECT MIN(COALESCE(completion_time, shipment_date)) AS t FROM shipments').get().t;
  const newest = db.prepare('SELECT MAX(COALESCE(completion_time, shipment_date)) AS t FROM shipments').get().t;
  return {
    total,
    oldest,
    newest,
    syncedFrom: Number(getState('synced_from')) || null,
    syncedTill: Number(getState('synced_till')) || null,
    lastSyncAt: Number(getState('last_sync_at')) || null,
    dbPath: DB_PATH,
  };
}

// Distinct customers for the searchable dropdown.
const distinctCustomersStmt = db.prepare(`
SELECT customer_code AS code,
       COALESCE(customer_name, customer_code) AS name,
       COALESCE(customer_email, '') AS email,
       COUNT(*) AS shipments
FROM shipments
WHERE customer_code IS NOT NULL
GROUP BY customer_code
ORDER BY shipments DESC
`);
function listAllCustomers() {
  return distinctCustomersStmt.all();
}

module.exports = {
  db,
  upsertMany,
  getShipmentsInRange,
  countShipmentsInRange,
  getShipmentsByCustomerInRange,
  getCustomerTotals,
  getState, setState,
  getStats,
  listAllCustomers,
  DB_PATH,
};
