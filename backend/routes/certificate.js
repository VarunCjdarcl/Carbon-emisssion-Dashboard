const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const router = express.Router();

const db = require('../services/db');
const { resolvePreset, presetLabel } = require('../services/dateRange');
const { generateCertificatePdf, generateCertificateHtml, LOGO_PATH } = require('../services/certificate');
const { sendCertificateEmail } = require('../services/mailer');

// In-memory audit log of certificate dispatches
const auditLog = [];

async function buildCertificatePayload({ code, preset, from, till }) {
  const range = resolvePreset(preset, { from, till });
  // Single indexed aggregate query — no row materialization.
  const t = db.getCustomerTotals(code, range.from, range.till);
  return {
    customerName: t.customerName,
    customerEmail: t.customerEmail,
    periodLabel: presetLabel(preset),
    fromDateLabel: new Date(range.from).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
    toDateLabel: new Date(range.till).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
    totalEmission: t.totalEmission,
    totalAversionRail: t.totalAversionRail,
    methodUsed: 'Road & Rail',
    range,
    shipmentCount: t.shipmentCount,
  };
}

// GET /api/certificate/customer/:code.pdf?preset=&from=&till=
router.get('/customer/:code.pdf', async (req, res, next) => {
  try {
    const { code } = req.params;
    const { preset = 'thisMonth', from, till } = req.query;
    const payload = await buildCertificatePayload({ code, preset, from, till });
    const filename = `${payload.customerName.replace(/[^a-zA-Z0-9]+/g, '_')}_Certificate_${payload.periodLabel.replace(/\s+/g, '')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    generateCertificatePdf(payload, res);
  } catch (err) {
    next(err);
  }
});

// POST /api/certificate/send
// body: { customerCode, preset, from, till, to, cc, subject, body }
// The certificate is embedded as inline HTML in the email body — no PDF
// attachment.  The user-typed `body` becomes a plaintext preamble above the
// rendered certificate.
router.post('/send', express.json(), async (req, res, next) => {
  try {
    const { customerCode, preset = 'thisMonth', from, till, to, cc, subject, body } = req.body || {};
    if (!customerCode) return res.status(400).json({ error: 'customerCode required' });
    if (!to) return res.status(400).json({ error: 'To address required' });
    if (!subject) return res.status(400).json({ error: 'Subject required' });
    if (!body) return res.status(400).json({ error: 'Body required' });

    const payload = await buildCertificatePayload({ code: customerCode, preset, from, till });

    const escape = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
    const preamble = escape(body).replace(/\n/g, '<br>');
    const certHtml = generateCertificateHtml(payload);
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#222;font-size:14px;line-height:1.5">
${preamble}
</div>
${certHtml}`;

    let info, error;
    try {
      info = await sendCertificateEmail({
        to,
        cc: cc ? cc.split(',').map(s => s.trim()).filter(Boolean) : undefined,
        subject,
        body, // plaintext fallback for clients that don't render HTML
        html,
        inlineImages: [{ path: LOGO_PATH, cid: 'cjdarcl-logo', filename: 'logo.webp' }],
      });
    } catch (e) {
      error = e;
    }

    const entry = {
      at: new Date().toISOString(),
      customerCode,
      customerName: payload.customerName,
      to,
      cc: cc || '',
      period: payload.periodLabel,
      shipmentCount: payload.shipmentCount,
      totalEmission: payload.totalEmission,
      success: !error,
      messageId: info?.messageId,
      demo: !!info?.demo,
      error: error ? String(error.message || error) : undefined,
    };
    auditLog.unshift(entry);
    if (auditLog.length > 200) auditLog.length = 200;

    if (error) return res.status(502).json({ ok: false, error: entry.error });
    res.json({ ok: true, ...entry });
  } catch (err) {
    next(err);
  }
});

router.get('/audit', (req, res) => {
  res.json({ entries: auditLog.slice(0, 100) });
});

module.exports = router;
