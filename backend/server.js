require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '.env'),
});
const path = require('path');
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const morgan = require('morgan');
const https = require('https');
const fs = require('fs');

const emissionsRouter = require('./routes/emissions');
const reportsRouter = require('./routes/reports');
const certificateRouter = require('./routes/certificate');
const { router: authRouter, requireAuth } = require('./routes/auth');

const app = express();
const PORT = Number(process.env.PORT || 4101);

// Minimal cookie parser — avoids adding a new dependency. Populates req.cookies.
function parseCookies(req, _res, next) {
  const header = req.headers.cookie || '';
  const jar = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) jar[k] = decodeURIComponent(v);
  });
  req.cookies = jar;
  next();
}

// res.cookie shim so auth.js can call res.cookie / res.clearCookie without
// adding cookie-parser as a dependency.
function cookieHelpers(_req, res, next) {
  res.cookie = function (name, value, opts = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    if (opts.path) parts.push(`Path=${opts.path}`);
    if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
    return res;
  };
  res.clearCookie = function (name, opts = {}) {
    return res.cookie(name, '', { ...opts, maxAge: 0 });
  };
  next();
}

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim();
const IS_PROD = (process.env.NODE_ENV || '').toLowerCase() === 'production';

app.set('trust proxy', 1);
app.use(compression());
app.use(cors(PUBLIC_BASE_URL && IS_PROD
  ? { origin: PUBLIC_BASE_URL, credentials: false }
  : {}));
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(parseCookies);
app.use(cookieHelpers);

app.use('/api/auth', authRouter);
app.use('/api/emissions', requireAuth, emissionsRouter);
app.use('/api/reports', requireAuth, reportsRouter);
app.use('/api/certificate', requireAuth, certificateRouter);

app.get('/api/health', (req, res) => {
  // Expose the newest shipment timestamp so the frontend can widen its default
  // preset when the synced dataset is behind "today" (e.g. local dev with no
  // TMS reachability, or a paused ETL). Cheap query — hits an indexed MAX().
  let latestDataAt = null;
  try {
    const stats = require('./services/shipmentStore').getEtlStatus();
    if (stats && stats.newest) latestDataAt = new Date(stats.newest).toISOString();
  } catch (_) { /* stats optional — never fail health */ }
  res.json({
    ok: true,
    demo: (process.env.DEMO_MODE || 'false').toLowerCase() === 'true',
    baseUrl: PUBLIC_BASE_URL || null,
    time: new Date().toISOString(),
    latestDataAt,
  });
});

app.get('/api/rollup/status', (req, res) => {
  const rollup = require('./services/rollup');
  res.json(rollup.getRollupStats());
});

// Force a full rollup rebuild across every day of shipments in the DB.
// Needed after a schema change (e.g. the rail_emission column added in
// e447133) so historic rollup rows pick up the new derivation. Auth-gated
// because it's a couple-second table scan.
app.post('/api/rollup/rebuild', requireAuth, (req, res) => {
  const rollup = require('./services/rollup');
  const t0 = Date.now();
  try {
    const rows = rollup.refreshAll();
    res.json({ ok: true, rows, elapsedMs: Date.now() - t0 });
  } catch (err) {
    console.error('[rollup/rebuild] failed:', err && err.stack || err);
    res.status(500).json({ ok: false, error: String(err && err.message || err), elapsedMs: Date.now() - t0 });
  }
});

// Hard-refresh: re-fetch the last N days from TMS and upsert. Overwrites any
// stale rows whose customField values changed upstream after the initial
// backfill (e.g. a corrected carbonEmissionValue). Runs in the background so
// the HTTP request returns immediately — poll /api/etl/hard-refresh/status
// or watch pm2 logs for `[etl] backfill chunk` lines.
let hardRefreshState = null;
app.post('/api/etl/hard-refresh', requireAuth, (req, res) => {
  if (hardRefreshState && hardRefreshState.phase !== 'done' && hardRefreshState.phase !== 'failed') {
    return res.status(409).json({ ok: false, error: 'a hard-refresh is already running', state: hardRefreshState });
  }
  const days = Math.max(1, Math.min(Number(req.query.days) || 365, 730));
  hardRefreshState = { startedAt: Date.now(), days, phase: 'backfilling', shipments: 0 };
  res.json({ ok: true, message: `hard-refresh started for last ${days} days — poll /api/etl/hard-refresh/status`, state: hardRefreshState });

  (async () => {
    const etl = require('./services/etl');
    const rollup = require('./services/rollup');
    try {
      const count = await etl.backfill(days);
      hardRefreshState.shipments = count;
      hardRefreshState.phase = 'rebuilding rollup';
      const rows = rollup.refreshAll();
      hardRefreshState.rollupRows = rows;
      hardRefreshState.phase = 'done';
      hardRefreshState.finishedAt = Date.now();
      console.log(`[hard-refresh] done in ${((hardRefreshState.finishedAt - hardRefreshState.startedAt) / 1000).toFixed(1)}s — ${count} shipments, ${rows} rollup rows`);
    } catch (err) {
      console.error('[hard-refresh] failed:', err && err.stack || err);
      hardRefreshState.error = String(err && err.message || err);
      hardRefreshState.phase = 'failed';
      hardRefreshState.finishedAt = Date.now();
    }
  })();
});

app.get('/api/etl/hard-refresh/status', requireAuth, (req, res) => {
  res.json(hardRefreshState || { idle: true });
});

app.get('/api/etl/status', (req, res) => {
  const store = require('./services/shipmentStore');
  const stats = store.getEtlStatus();
  res.json({
    enabled: store.isEtlEnabled(),
    demoMode: (process.env.DEMO_MODE || 'false').toLowerCase() === 'true',
    tmsBaseUrl: process.env.TMS_BASE_URL || null,
    tmsTokenSet: !!process.env.TMS_AUTH_TOKEN,
    shipments: stats.total,
    oldestShipment: stats.oldest ? new Date(stats.oldest).toISOString() : null,
    newestShipment: stats.newest ? new Date(stats.newest).toISOString() : null,
    syncedFrom: stats.syncedFrom ? new Date(stats.syncedFrom).toISOString() : null,
    syncedTill: stats.syncedTill ? new Date(stats.syncedTill).toISOString() : null,
    lastSyncAt: stats.lastSyncAt ? new Date(stats.lastSyncAt).toISOString() : null,
    dbPath: stats.dbPath,
  });
});

// Force an incremental ETL run. Same operation the 15-min scheduler does —
// exposed so an operator can trigger a catch-up from the browser (or curl on
// the server) without SSHing to run pm2 commands. Auth-gated so random visitors
// can't hammer the TMS API.
app.post('/api/etl/sync', requireAuth, async (req, res) => {
  const etl = require('./services/etl');
  const t0 = Date.now();
  try {
    const count = await etl.syncIncremental();
    res.json({ ok: true, count, elapsedMs: Date.now() - t0 });
  } catch (err) {
    console.error('[etl/sync] failed:', err && err.stack || err);
    res.status(502).json({ ok: false, error: String(err && err.message || err), elapsedMs: Date.now() - t0 });
  }
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Gate the dashboard shell behind auth. Static assets (css/js/img) remain
// public so the login page can render, but hitting "/" or "/index.html"
// without a valid session bounces the user to /login.html.
const { peekSession } = require('./routes/auth');
app.use((req, res, next) => {
  const isShell = req.path === '/' || req.path === '/index.html';
  if (!isShell) return next();
  if (!peekSession(req.cookies && req.cookies.auth_token)) {
    return res.redirect('/login.html');
  }
  next();
});

app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  index: 'index.html',
  setHeaders: (res, filePath) => {
    // Never cache the HTML shell — it carries the versioned script URLs
    // (?v=N). If the browser cached index.html, it would keep loading stale
    // JS and the dashboard could open on an outdated default / empty state.
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const sslDir = path.join(__dirname, 'ssl');
const sslKeyPath = path.join(sslDir, 'private.key');
const sslCertPath = path.join(sslDir, '98c0c749062fefab.pem');
const sslCaPath = path.join(sslDir, 'gd_bundle-g2.crt');
const hasSsl = fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath) && fs.existsSync(sslCaPath);

const startServer = (cb) => {
  if (hasSsl) {
    const sslOptions = {
      key: fs.readFileSync(sslKeyPath),
      cert: fs.readFileSync(sslCertPath),
      ca: fs.readFileSync(sslCaPath),
    };
    return https.createServer(sslOptions, app).listen(PORT, cb);
  }
  console.warn('[ssl] cert files not found in backend/ssl — starting over plain HTTP (local/dev mode)');
  return app.listen(PORT, cb);
};

startServer(() => {
  const proto = hasSsl ? 'https' : 'http';
  const shown = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}:${PORT}` : `${proto}://localhost:${PORT}`;
  console.log(`Carbon Emission Dashboard listening on ${shown} (bind 0.0.0.0:${PORT})`);
  console.log(`Demo mode: ${(process.env.DEMO_MODE || 'false')}`);
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
