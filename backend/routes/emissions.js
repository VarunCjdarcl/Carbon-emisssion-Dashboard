const express = require('express');
const router = express.Router();

const db = require('../services/db');
const store = require('../services/shipmentStore');
const rollup = require('../services/rollup');
const { resolvePreset, presetLabel } = require('../services/dateRange');

// GET /api/emissions/time?preset=thisMonth&from=&till=&customer=
router.get('/time', async (req, res, next) => {
  try {
    const { preset = 'thisMonth', from, till, customer } = req.query;
    const range = resolvePreset(preset, { from, till });
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
    const { preset = 'thisMonth', from, till, customer } = req.query;
    const range = resolvePreset(preset, { from, till });
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

// GET /api/customers — full list for the searchable dropdown
router.get('/customer-list', async (req, res, next) => {
  try {
    const list = store.listCustomers();
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
    // Indexed query on (customer_code, completion_time) — no full-table scan.
    const filtered = db.getShipmentsByCustomerInRange(code, range.from, range.till);

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
