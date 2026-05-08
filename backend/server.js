require('dotenv').config();
const path = require('path');
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const morgan = require('morgan');

const emissionsRouter = require('./routes/emissions');
const reportsRouter = require('./routes/reports');
const certificateRouter = require('./routes/certificate');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(compression());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

app.use('/api/emissions', emissionsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/certificate', certificateRouter);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    demo: (process.env.DEMO_MODE || 'true').toLowerCase() === 'true',
    time: new Date().toISOString(),
  });
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Carbon Emission Dashboard listening on http://localhost:${PORT}`);
  console.log(`Demo mode: ${(process.env.DEMO_MODE || 'true')}`);

  // Pre-warm common ranges so the dashboard's first page load hits a hot
  // cache, and refresh them periodically so the cache never goes cold while
  // the server is alive.  Pre-warms run in PARALLEL — TMS handles 3 in-flight
  // queries fine, and parallel cuts startup warm time roughly in half.
  // Fire-and-forget; we don't block server readiness on it.
  if ((process.env.DEMO_MODE || 'true').toLowerCase() !== 'true') {
    const tms = require('./services/tmsClient');
    const { resolvePreset } = require('./services/dateRange');
    const PRESETS = ['thisMonth', 'last30', 'previousMonth', 'last2months'];

    async function warmOne(preset) {
      const t0 = Date.now();
      try {
        const items = await tms.getShipmentsInRange(resolvePreset(preset));
        console.log(`[warm] ${preset} cached ${items.length} shipments in ${Date.now() - t0}ms`);
      } catch (err) {
        console.warn(`[warm] ${preset} failed`, err.message || err);
      }
    }
    async function warmAll() {
      // Warm 2 presets at a time — at concurrency=4 per slice × 2 slices
      // (road+rail) × 2 presets = ~16 concurrent TMS calls peak.  More than
      // that and TMS starts 504-ing.
      const PRESET_PARALLELISM = 2;
      for (let i = 0; i < PRESETS.length; i += PRESET_PARALLELISM) {
        await Promise.all(PRESETS.slice(i, i + PRESET_PARALLELISM).map(warmOne));
      }
    }

    warmAll();
    // Refresh every 25 min — comfortably under the 30-min cache TTL so warm
    // ranges never cool off.
    setInterval(warmAll, 25 * 60 * 1000);
  }
});
