// Pre-aggregated daily rollup of shipments by (day_ist, customer_code).
//
// The dashboard charts only need bucketed sums.  Reading 600k raw rows just to
// SUM() them in JS is the bottleneck we saw on "Last 1 Year" queries.  This
// table holds one row per (IST day, customer) with pre-computed sums, refreshed
// on startup and every night at 02:00 IST.
//
// Time series queries fetch <=366 daily rows and bucket them in JS for the
// chosen granularity (week / month / quarter).  Customer charts group ~few-hundred
// rows in SQL.  Sub-100ms even for a full-year window.
//
// "Hour" granularity (Today / Yesterday presets only) bypasses the rollup and
// hits the raw shipments table directly — the window is at most ~2 days, so
// the indexed query is already fast.

const db = require('./db');
const { pickGranularity, GRANULARITY, fillEmptyBuckets, round2 } = require('./aggregator');

const IST_OFFSET_MS = 5.5 * 3600 * 1000; // 19,800,000 — UTC → IST shift
const ONE_DAY_MS    = 86400000;
const ONE_HOUR_MS   = 3600000;

// --- Schema ---------------------------------------------------------------

db.db.exec(`
CREATE TABLE IF NOT EXISTS shipment_rollup_daily (
  day_ist           INTEGER NOT NULL,
  customer_code     TEXT    NOT NULL DEFAULT '',
  customer_name     TEXT,
  customer_email    TEXT,
  road_emission     REAL    NOT NULL DEFAULT 0,
  rail_emission     REAL    NOT NULL DEFAULT 0,
  rail_aversion     REAL    NOT NULL DEFAULT 0,
  lng_aversion      REAL    NOT NULL DEFAULT 0,
  electric_aversion REAL    NOT NULL DEFAULT 0,
  hydrogen_aversion REAL    NOT NULL DEFAULT 0,
  total_distance    REAL    NOT NULL DEFAULT 0,
  shipment_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_ist, customer_code)
);
CREATE INDEX IF NOT EXISTS idx_rollup_day      ON shipment_rollup_daily(day_ist);
CREATE INDEX IF NOT EXISTS idx_rollup_customer ON shipment_rollup_daily(customer_code);
`);
// Idempotent add of the rail_emission column so existing DBs pick it up on the
// next boot without needing a full rebuild. SQLite raises "duplicate column"
// if it's already there — swallow that specific error, re-throw anything else.
try {
  const has = db.db.prepare(
    `SELECT 1 FROM pragma_table_info('shipment_rollup_daily') WHERE name='rail_emission'`
  ).get();
  if (!has) db.db.exec(`ALTER TABLE shipment_rollup_daily ADD COLUMN rail_emission REAL NOT NULL DEFAULT 0`);
} catch (err) {
  if (!/duplicate column/i.test(err.message)) throw err;
}

// --- Day index helpers ----------------------------------------------------

// IST-aligned integer day index. floor((utcMs + 5h30m) / 1day).
function dayIstFromMs(ms) {
  return Math.floor((ms + IST_OFFSET_MS) / ONE_DAY_MS);
}
// UTC ms at the start of an IST day.
function startOfIstDayUtcMs(dayIst) {
  return dayIst * ONE_DAY_MS - IST_OFFSET_MS;
}
// A representative ts for an IST day, safe for local-time formatting on
// IST-clock machines (the existing aggregator labels use local time).
function midIstDayMs(dayIst) {
  return startOfIstDayUtcMs(dayIst) + 12 * ONE_HOUR_MS;
}

// --- Refresh --------------------------------------------------------------

const deleteRangeStmt = db.db.prepare(
  `DELETE FROM shipment_rollup_daily WHERE day_ist BETWEEN ? AND ?`
);
// Split carbon_emission_value by transportation mode: rail-mode shipments
// contribute to rail_emission, everything else to road_emission. TMS uses
// "ByRoad" / "ByRail" / "ByTrain" — match either rail flavor case-insensitively.
const isRailSql = `(
  LOWER(COALESCE(transportation_mode, '')) LIKE '%rail%'
  OR LOWER(COALESCE(transportation_mode, '')) LIKE '%train%'
)`;
const insertRangeStmt = db.db.prepare(`
INSERT INTO shipment_rollup_daily (
  day_ist, customer_code, customer_name, customer_email,
  road_emission, rail_emission, rail_aversion, lng_aversion, electric_aversion, hydrogen_aversion,
  total_distance, shipment_count
)
SELECT
  (COALESCE(completion_time, shipment_date) + ${IST_OFFSET_MS}) / ${ONE_DAY_MS} AS day_ist,
  COALESCE(customer_code, '')               AS customer_code,
  MAX(customer_name)                        AS customer_name,
  MAX(customer_email)                       AS customer_email,
  SUM(CASE WHEN ${isRailSql} THEN 0 ELSE COALESCE(carbon_emission_value, 0) END) AS road_emission,
  SUM(CASE WHEN ${isRailSql} THEN COALESCE(carbon_emission_value, 0) ELSE 0 END) AS rail_emission,
  SUM(COALESCE(aversion_value_rail, 0))     AS rail_aversion,
  SUM(COALESCE(aversion_value_lng, 0))      AS lng_aversion,
  SUM(COALESCE(aversion_value_electric, 0)) AS electric_aversion,
  SUM(COALESCE(aversion_value_hydrogen, 0)) AS hydrogen_aversion,
  SUM(COALESCE(total_distance, 0))          AS total_distance,
  COUNT(*)                                  AS shipment_count
FROM shipments
WHERE COALESCE(completion_time, shipment_date) BETWEEN ? AND ?
  AND COALESCE(completion_time, shipment_date) IS NOT NULL
GROUP BY day_ist, COALESCE(customer_code, '')
`);

const refreshTxn = db.db.transaction((fromDay, tillDay, fromMs, tillMs) => {
  deleteRangeStmt.run(fromDay, tillDay);
  insertRangeStmt.run(fromMs, tillMs);
});

function refreshRange(fromMs, tillMs) {
  const fromDay = dayIstFromMs(fromMs);
  const tillDay = dayIstFromMs(tillMs);
  // Expand the source-row scan to the full IST day boundaries so we don't lose
  // shipments at the edge of the window.
  const scanFromMs = startOfIstDayUtcMs(fromDay);
  const scanTillMs = startOfIstDayUtcMs(tillDay + 1) - 1;
  const t0 = Date.now();
  refreshTxn(fromDay, tillDay, scanFromMs, scanTillMs);
  const n = db.db.prepare(
    `SELECT COUNT(*) AS n FROM shipment_rollup_daily WHERE day_ist BETWEEN ? AND ?`
  ).get(fromDay, tillDay).n;
  console.log(`[rollup] refreshed days ${fromDay}..${tillDay} → ${n} rows in ${Date.now() - t0}ms`);
  return n;
}

function refreshLastYear() {
  const till = Date.now();
  const from = till - 366 * ONE_DAY_MS;
  return refreshRange(from, till);
}

function refreshAll() {
  // Cover whatever's in the shipments table; safer than relying on an env knob.
  const r = db.db.prepare(
    `SELECT MIN(COALESCE(completion_time, shipment_date)) AS lo,
            MAX(COALESCE(completion_time, shipment_date)) AS hi FROM shipments`
  ).get();
  if (!r || !r.lo || !r.hi) {
    console.log('[rollup] no shipments to roll up yet');
    return 0;
  }
  return refreshRange(r.lo, r.hi);
}

// --- Read paths -----------------------------------------------------------

const dailySeriesStmt = db.db.prepare(`
SELECT day_ist,
       SUM(road_emission)   AS road,
       SUM(rail_emission)   AS railEmission,
       SUM(rail_aversion)   AS rail,
       SUM(shipment_count)  AS cnt
FROM shipment_rollup_daily
WHERE day_ist BETWEEN ? AND ?
GROUP BY day_ist
ORDER BY day_ist
`);
const dailySeriesByCustomerStmt = db.db.prepare(`
SELECT day_ist,
       SUM(road_emission)   AS road,
       SUM(rail_emission)   AS railEmission,
       SUM(rail_aversion)   AS rail,
       SUM(shipment_count)  AS cnt
FROM shipment_rollup_daily
WHERE day_ist BETWEEN ? AND ?
  AND COALESCE(customer_name, customer_code) = ?
GROUP BY day_ist
ORDER BY day_ist
`);

function dailySeries(fromMs, tillMs, customerCode) {
  const fromDay = dayIstFromMs(fromMs);
  const tillDay = dayIstFromMs(tillMs);
  if (customerCode) return dailySeriesByCustomerStmt.all(fromDay, tillDay, customerCode);
  return dailySeriesStmt.all(fromDay, tillDay);
}

// One row per company NAME (codes merged), so the chart shows each company
// once. `code` is set to the name to stay the dashboard-wide identifier.
const customerTotalsStmt = db.db.prepare(`
SELECT COALESCE(customer_name, customer_code) AS code,
       COALESCE(customer_name, customer_code) AS name,
       MAX(customer_email) AS email,
       SUM(road_emission)  AS road,
       SUM(rail_aversion)  AS rail,
       SUM(shipment_count) AS cnt
FROM shipment_rollup_daily
WHERE day_ist BETWEEN ? AND ?
GROUP BY COALESCE(customer_name, customer_code)
ORDER BY road DESC
`);

function customerTotalsForRange(fromMs, tillMs) {
  const fromDay = dayIstFromMs(fromMs);
  const tillDay = dayIstFromMs(tillMs);
  return customerTotalsStmt.all(fromDay, tillDay);
}

// Hour-granularity series — straight from shipments (small window only).
function hourSeriesFromShipments(fromMs, tillMs, customerCode) {
  const sql = `
    SELECT (COALESCE(completion_time, shipment_date) + ${IST_OFFSET_MS}) / ${ONE_HOUR_MS} AS hour_ist,
           SUM(CASE WHEN ${isRailSql} THEN 0 ELSE COALESCE(carbon_emission_value, 0) END) AS road,
           SUM(CASE WHEN ${isRailSql} THEN COALESCE(carbon_emission_value, 0) ELSE 0 END) AS railEmission,
           SUM(COALESCE(aversion_value_rail, 0))   AS rail,
           COUNT(*)                                AS cnt
    FROM shipments
    WHERE COALESCE(completion_time, shipment_date) BETWEEN ? AND ?
      ${customerCode ? 'AND customer_code = ?' : ''}
    GROUP BY hour_ist
    ORDER BY hour_ist
  `;
  return customerCode
    ? db.db.prepare(sql).all(fromMs, tillMs, customerCode)
    : db.db.prepare(sql).all(fromMs, tillMs);
}

// --- Aggregation: chart-ready shapes --------------------------------------

function aggregateTime({ from, till, preset, customerCode }) {
  const granularity = pickGranularity(preset, from, till);
  if (granularity === 'hour') return aggregateTimeHourly(from, till, customerCode);

  const g = GRANULARITY[granularity];
  const rows = dailySeries(from, till, customerCode);

  const buckets = new Map();
  let totalRoad = 0, totalRailEm = 0, totalRail = 0, totalCount = 0;
  for (const r of rows) {
    const ts = midIstDayMs(r.day_ist);
    const key = g.key(ts, from);
    const label = g.label(ts, from);
    if (!buckets.has(key)) {
      buckets.set(key, { key, label, sortTs: ts, road: 0, railEmission: 0, rail: 0, count: 0 });
    }
    const b = buckets.get(key);
    b.road         += r.road         || 0;
    b.railEmission += r.railEmission || 0;
    b.rail         += r.rail         || 0;
    b.count        += r.cnt          || 0;
    if (ts < b.sortTs) b.sortTs = ts;
    totalRoad   += r.road         || 0;
    totalRailEm += r.railEmission || 0;
    totalRail   += r.rail         || 0;
    totalCount  += r.cnt          || 0;
  }

  fillEmptyBuckets(buckets, from, till, granularity);
  const series = Array.from(buckets.values()).sort((a, b) => a.sortTs - b.sortTs);

  return {
    granularity,
    series: series.map(b => ({
      label: b.label,
      road:  round2(b.road),
      railEmission: round2(b.railEmission || 0),
      rail:  round2(b.rail),
      count: b.count,
    })),
    totals: {
      totalRoadEmissions:    round2(totalRoad),
      totalRailEmissions:    round2(totalRailEm),
      totalRailComparison:   round2(totalRail),
      totalShipments:        totalCount,
      avgEmissionPerShipment: totalCount ? round2(totalRoad / totalCount) : 0,
    },
  };
}

function aggregateTimeHourly(from, till, customerCode) {
  const g = GRANULARITY.hour;
  const rows = hourSeriesFromShipments(from, till, customerCode);
  const buckets = new Map();
  let totalRoad = 0, totalRailEm = 0, totalRail = 0, totalCount = 0;
  for (const r of rows) {
    const ts = r.hour_ist * ONE_HOUR_MS - IST_OFFSET_MS + 30 * 60 * 1000; // mid-hour
    const key = g.key(ts, from);
    const label = g.label(ts, from);
    if (!buckets.has(key)) {
      buckets.set(key, { key, label, sortTs: ts, road: 0, railEmission: 0, rail: 0, count: 0 });
    }
    const b = buckets.get(key);
    b.road         += r.road         || 0;
    b.railEmission += r.railEmission || 0;
    b.rail         += r.rail         || 0;
    b.count        += r.cnt          || 0;
    if (ts < b.sortTs) b.sortTs = ts;
    totalRoad   += r.road         || 0;
    totalRailEm += r.railEmission || 0;
    totalRail   += r.rail         || 0;
    totalCount  += r.cnt          || 0;
  }
  fillEmptyBuckets(buckets, from, till, 'hour');
  const series = Array.from(buckets.values()).sort((a, b) => a.sortTs - b.sortTs);
  return {
    granularity: 'hour',
    series: series.map(b => ({
      label: b.label,
      road:  round2(b.road),
      railEmission: round2(b.railEmission || 0),
      rail:  round2(b.rail),
      count: b.count,
    })),
    totals: {
      totalRoadEmissions:    round2(totalRoad),
      totalRailEmissions:    round2(totalRailEm),
      totalRailComparison:   round2(totalRail),
      totalShipments:        totalCount,
      avgEmissionPerShipment: totalCount ? round2(totalRoad / totalCount) : 0,
    },
  };
}

function aggregateByCustomer({ from, till, customerCode }) {
  const rows = customerTotalsForRange(from, till);
  const filtered = customerCode ? rows.filter(r => r.code === customerCode) : rows;
  const list = filtered.map(r => ({
    customerCode:    r.code || 'UNK',
    customerName:    r.name || r.code || 'UNK',
    customerEmail:   r.email || '',
    totalEmissions:  round2(r.road || 0),
    totalRail:       round2(r.rail || 0),
    totalShipments:  r.cnt || 0,
  })).sort((a, b) => b.totalEmissions - a.totalEmissions);

  const sumEmissions = list.reduce((a, b) => a + b.totalEmissions, 0);
  const avg = list.length ? sumEmissions / list.length : 0;
  return {
    customers: list,
    totals: {
      total: round2(sumEmissions),
      avg:   round2(avg),
      top:   list[0]?.customerName || null,
    },
  };
}

function getRollupStats() {
  const r = db.db.prepare(
    `SELECT COUNT(*) AS n,
            MIN(day_ist) AS lo,
            MAX(day_ist) AS hi FROM shipment_rollup_daily`
  ).get();
  return {
    rows:       r.n || 0,
    fromDay:    r.lo,
    tillDay:    r.hi,
    fromIstMs:  r.lo != null ? startOfIstDayUtcMs(r.lo) : null,
    tillIstMs:  r.hi != null ? startOfIstDayUtcMs(r.hi + 1) - 1 : null,
  };
}

// --- 2 AM IST scheduler ---------------------------------------------------

function msUntilNext2amIst() {
  const nowUtc = Date.now();
  const nowIst = nowUtc + IST_OFFSET_MS;
  const todayIstStart = Math.floor(nowIst / ONE_DAY_MS) * ONE_DAY_MS;
  let next2amIst = todayIstStart + 2 * ONE_HOUR_MS;
  if (next2amIst <= nowIst) next2amIst += ONE_DAY_MS;
  return next2amIst - nowIst;
}

function scheduleDaily2amIst(handler) {
  const fire = async () => {
    try { await handler(); }
    catch (err) { console.error('[rollup] 2am handler failed:', err.message); }
  };
  const delay = msUntilNext2amIst();
  const mins  = Math.round(delay / 60000);
  console.log(`[rollup] next 02:00 IST refresh in ${mins} min (${Math.round(mins/60)} h)`);
  setTimeout(() => {
    fire();
    setInterval(fire, 24 * ONE_HOUR_MS);
  }, delay);
}

module.exports = {
  refreshRange,
  refreshLastYear,
  refreshAll,
  aggregateTime,
  aggregateByCustomer,
  getRollupStats,
  scheduleDaily2amIst,
  // exported for tests
  dayIstFromMs,
  startOfIstDayUtcMs,
};
