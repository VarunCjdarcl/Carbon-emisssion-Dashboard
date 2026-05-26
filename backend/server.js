// require('dotenv').config();
require('dotenv').config({
  path: require('path').resolve("../.env")
});
const path = require('path');
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const morgan = require('morgan');

const emissionsRouter = require('./routes/emissions');
const reportsRouter = require('./routes/reports');
const certificateRouter = require('./routes/certificate');

const app = express();
const PORT = Number(process.env.PORT || 4101);

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim();
const IS_PROD = (process.env.NODE_ENV || '').toLowerCase() === 'production';

app.set('trust proxy', 1);
app.use(compression());
app.use(cors(PUBLIC_BASE_URL && IS_PROD
  ? { origin: PUBLIC_BASE_URL, credentials: false }
  : {}));
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

app.use('/api/emissions', emissionsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/certificate', certificateRouter);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    demo: (process.env.DEMO_MODE || 'true').toLowerCase() === 'true',
    baseUrl: PUBLIC_BASE_URL || null,
    time: new Date().toISOString(),
  });
});

app.get('/api/rollup/status', (req, res) => {
  const rollup = require('./services/rollup');
  res.json(rollup.getRollupStats());
});

app.get('/api/etl/status', (req, res) => {
  const store = require('./services/shipmentStore');
  const stats = store.getEtlStatus();
  res.json({
    enabled: store.isEtlEnabled(),
    shipments: stats.total,
    oldestShipment: stats.oldest ? new Date(stats.oldest).toISOString() : null,
    newestShipment: stats.newest ? new Date(stats.newest).toISOString() : null,
    syncedFrom: stats.syncedFrom ? new Date(stats.syncedFrom).toISOString() : null,
    syncedTill: stats.syncedTill ? new Date(stats.syncedTill).toISOString() : null,
    lastSyncAt: stats.lastSyncAt ? new Date(stats.lastSyncAt).toISOString() : null,
    dbPath: stats.dbPath,
  });
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  const shown = PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  console.log(`Carbon Emission Dashboard listening on ${shown} (bind 0.0.0.0:${PORT})`);
  console.log(`Demo mode: ${(process.env.DEMO_MODE || 'true')}`);
  // Start the ETL worker.  In live mode this kicks off either an initial
  // backfill (empty DB) or an incremental catch-up (existing DB), and then
  // schedules periodic incremental + full-refresh syncs.  All dashboard reads
  // go through shipmentStore, which prefers SQLite and falls back to TMS only
  // when the DB hasn't covered the requested range yet.
  const etl = require('./services/etl');
  etl.start();

  // Rollup table: dashboard charts read pre-aggregated daily sums (sub-100ms
  // even for a 1-year window).  Rebuild it on startup so we never serve from a
  // stale cache, then refresh nightly at 02:00 IST after the ETL has pulled
  // the latest data.
  const rollup = require('./services/rollup');
  setTimeout(() => {
    try { rollup.refreshAll(); }
    catch (err) { console.error('[rollup] initial build failed:', err.message); }
  }, 2000); // give ETL a head-start so its first chunk lands first

  rollup.scheduleDaily2amIst(async () => {
    console.log('[rollup] 02:00 IST refresh — running ETL full refresh then rebuilding rollup');
    try { await etl.syncFullRefresh(); }
    catch (err) { console.warn('[rollup] 02:00 ETL full refresh failed:', err.message); }
    try { rollup.refreshLastYear(); }
    catch (err) { console.error('[rollup] 02:00 rollup refresh failed:', err.message); }
  });
});
