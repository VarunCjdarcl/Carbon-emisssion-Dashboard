const express = require('express');
const ExcelJS = require('exceljs');
const router = express.Router();

const tms = require('../services/tmsClient');
const { resolvePreset, presetLabel } = require('../services/dateRange');

// GET /api/reports/customer/:code.xlsx?preset=&from=&till=
router.get('/customer/:code.xlsx', async (req, res, next) => {
  try {
    const { code } = req.params;
    const { preset = 'thisMonth', from, till } = req.query;
    const range = resolvePreset(preset, { from, till });
    const shipments = await tms.getShipmentsInRange(range);
    const filtered = shipments.filter(s => s.customerCode === code);
    const customerName = (filtered[0]?.customerName || code).replace(/[^a-zA-Z0-9]+/g, '_');

    const wb = new ExcelJS.Workbook();
    wb.creator = 'CJ Darcl Logistics';
    wb.created = new Date();
    const ws = wb.addWorksheet('Shipments');

    ws.columns = [
      { header: 'Shipment No.', key: 'shipmentNo', width: 18 },
      { header: 'Consignment Number', key: 'consignmentNumber', width: 26 },
      { header: 'Vehicle Type', key: 'vehicleType', width: 22 },
      { header: 'Source', key: 'source', width: 16 },
      { header: 'Destination', key: 'destination', width: 16 },
      { header: 'Transportation Mode', key: 'transportationMode', width: 18 },
      { header: 'carbonEmissionValue (kg CO₂e)', key: 'carbonEmissionValue', width: 18 },
      { header: 'TotalDistance (km)', key: 'totalDistance', width: 16 },
      { header: 'fuelUsed (L)', key: 'fuelUsed', width: 14 },
      { header: 'aversionValue_lng', key: 'aversionValue_lng', width: 16 },
      { header: 'aversionValue_electric', key: 'aversionValue_electric', width: 18 },
      { header: 'aversionValue_hydrogen', key: 'aversionValue_hydrogen', width: 18 },
      { header: 'aversionValue_rail', key: 'aversionValue_rail', width: 16 },
    ];

    // Header style — CJ Darcl navy
    ws.getRow(1).eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2B5F' } };
      c.alignment = { vertical: 'middle', horizontal: 'left' };
    });

    for (const s of filtered) {
      ws.addRow({
        shipmentNo: s.shipmentNo,
        consignmentNumber: s.consignmentNumber,
        vehicleType: s.vehicleType,
        source: s.source,
        destination: s.destination,
        transportationMode: s.transportationMode,
        carbonEmissionValue: s.carbonEmissionValue ?? '',
        totalDistance: s.totalDistance ?? '',
        fuelUsed: s.fuelUsed ?? '',
        aversionValue_lng: s.aversionValue_lng ?? '',
        aversionValue_electric: s.aversionValue_electric ?? '',
        aversionValue_hydrogen: s.aversionValue_hydrogen ?? '',
        aversionValue_rail: s.aversionValue_rail ?? '',
      });
    }

    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const period = presetLabel(preset).replace(/\s+/g, '');
    const filename = `${customerName}_EmissionReport_${period}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
