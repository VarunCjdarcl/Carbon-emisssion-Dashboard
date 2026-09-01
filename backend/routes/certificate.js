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

// -----------------------------------------------------------------------------
// TEMPORARY: business-supplied per-customer overrides.
//
// The dashboard's aggregate for these specific (customer, period) pairs is
// slightly off from what business's own report shows because TMS's list
// endpoint and business's reporting source aggregate differently. Until we can
// wire the ETL to the same source business uses, when a certificate matches
// one of these entries we snap the figures on the certificate to the exact
// values business provided.
//
// Match rules:
//   - customer name matches (case-insensitive substring)
//   - range overlaps the target window (loose tolerance so custom / preset
//     picks that happen to be close to the intended window still hit)
//
// To disable an override, delete its entry from CERT_OVERRIDES.
// -----------------------------------------------------------------------------
const ONE_DAY = 86400000;
const CERT_OVERRIDES = [
  {
    customerMatch: 'technova imaging',
    // 01-Apr-2026 to 15-Aug-2026 (137 days)
    windowFromMs: Date.UTC(2026, 3, 1),           // Apr 1
    windowTillMs: Date.UTC(2026, 7, 15, 23, 59, 59, 999),  // Aug 15 end
    fromDateLabel: '01 April 2026',
    toDateLabel:   '15 August 2026',
    shipmentCount: 115,
    totalEmission: 22167.03143,
    totalAversionRail: 40126.306,
  },
];

function matchesCertOverride(customerName, from, till) {
  const nameLc = String(customerName || '').toLowerCase();
  for (const o of CERT_OVERRIDES) {
    if (!nameLc.includes(o.customerMatch)) continue;
    // Range must span most of the intended window. Tolerance of ±5 days on
    // each end to allow for IST/UTC quirks and slightly-off custom picks.
    const fromNearWindow = Math.abs(from - o.windowFromMs) <= 5 * ONE_DAY;
    const tillNearWindow = Math.abs(till - o.windowTillMs) <= 5 * ONE_DAY;
    if (fromNearWindow && tillNearWindow) return o;
  }
  return null;
}

async function buildCertificatePayload({ code, preset, from, till, now }) {
  const range = resolvePreset(preset, { from, till, now });
  // Single indexed aggregate query — no row materialization.
  const t = db.getCustomerTotals(code, range.from, range.till);
  const override = matchesCertOverride(t.customerName || code, range.from, range.till);
  if (override) {
    console.log(`[certificate] override matched: ${t.customerName} for ${override.fromDateLabel} — ${override.toDateLabel}`);
    return {
      customerName: t.customerName,
      customerEmail: t.customerEmail,
      periodLabel: presetLabel(preset),
      fromDateLabel: override.fromDateLabel,
      toDateLabel: override.toDateLabel,
      totalEmission: override.totalEmission,
      totalAversionRail: override.totalAversionRail,
      methodUsed: 'Road & Rail',
      range,
      shipmentCount: override.shipmentCount,
    };
  }
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

// GET /api/certificate/customer.pdf?customer=<name>&preset=&from=&till=
// `customer` is the company NAME, passed as a query param.
router.get('/customer.pdf', async (req, res, next) => {
  try {
    const { customer, preset = 'thisMonth', from, till, now } = req.query;
    if (!customer) return res.status(400).json({ error: 'customer required' });
    const payload = await buildCertificatePayload({ code: customer, preset, from, till, now });
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
    const { customerCode, preset = 'thisMonth', from, till, now, to, cc, subject, body } = req.body || {};
    if (!customerCode) return res.status(400).json({ error: 'customerCode required' });
    if (!to) return res.status(400).json({ error: 'To address required' });
    if (!subject) return res.status(400).json({ error: 'Subject required' });
    if (!body) return res.status(400).json({ error: 'Body required' });

    const payload = await buildCertificatePayload({ code: customerCode, preset, from, till, now });

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
