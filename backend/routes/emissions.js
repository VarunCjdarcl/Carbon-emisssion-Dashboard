const express = require('express');
const router = express.Router();

const tms = require('../services/tmsClient');
const { resolvePreset, presetLabel } = require('../services/dateRange');
const { aggregateByTime, aggregateByCustomer } = require('../services/aggregator');

// GET /api/emissions/time?preset=thisMonth&from=&till=
router.get('/time', async (req, res, next) => {
  try {
    const { preset = 'thisMonth', from, till } = req.query;
    const range = resolvePreset(preset, { from, till });
    const shipments = await tms.getShipmentsInRange(range);
    const agg = aggregateByTime(shipments, { ...range, preset });

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
    const { preset = 'thisMonth', from, till, customer } = req.query;
    const range = resolvePreset(preset, { from, till });
    const shipments = await tms.getShipmentsInRange(range);
    const agg = aggregateByCustomer(shipments, { customerCode: customer });
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

// GET /api/customers — full list for the searchable dropdown
router.get('/customer-list', async (req, res, next) => {
  try {
    // Ensure the listCache has data for the default landing view, otherwise
    // listCustomers() returns [] on first page load (it derives from cache).
    const range = resolvePreset('thisMonth');
    await tms.getShipmentsInRange(range);
    const list = tms.listCustomers();
    res.json({ customers: list });
  } catch (err) {
    next(err);
  }
});

// GET /api/emissions/customer/:code/shipments?preset=&from=&till=
router.get('/customer/:code/shipments', async (req, res, next) => {
  try {
    const { code } = req.params;
    const { preset = 'thisMonth', from, till } = req.query;
    const range = resolvePreset(preset, { from, till });
    const shipments = await tms.getShipmentsInRange(range);
    const filtered = shipments
      .filter(s => s.customerCode === code)
      .sort((a, b) => b.completionTime - a.completionTime);

    res.json({
      preset,
      presetLabel: presetLabel(preset),
      range,
      customerCode: code,
      customerName: filtered[0]?.customerName || code,
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
