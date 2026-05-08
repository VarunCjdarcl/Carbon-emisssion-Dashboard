const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// CJ Darcl brand palette
const NAVY = '#1a2b5f';
const GREEN = '#2a9d54';
const MUTED = '#555555';
const BORDER = '#dde1e8';

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'assets', 'logo.webp');

function generateCertificatePdf(payload, stream) {
  const {
    customerName,
    periodLabel,
    fromDateLabel,
    toDateLabel,
    totalEmission,
    totalAversionRail,
    methodUsed = 'Road & Rail',
    issuedDate = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
  } = payload;

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(stream);

  // Header band
  doc.rect(0, 0, doc.page.width, 90).fill('#ffffff');
  // Try logo, but PDFKit can't read .webp — render a text mark instead
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(22).text('CJ Darcl', 50, 40);
  doc.fillColor(MUTED).font('Helvetica').fontSize(10).text('Logistics', 50, 66);

  doc.fillColor(MUTED).font('Helvetica').fontSize(9)
     .text(`Issued: ${issuedDate}`, 0, 50, { align: 'right', width: doc.page.width - 50 });

  // Divider
  doc.moveTo(50, 100).lineTo(doc.page.width - 50, 100).strokeColor(BORDER).lineWidth(1).stroke();

  // Title
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20)
     .text('Total Logistics Emissions Accounted by CJ Darcl', 50, 130, {
       align: 'center', width: doc.page.width - 100,
     });

  // Big number
  doc.moveDown(1.2);
  doc.fillColor(GREEN).font('Helvetica-BoldOblique').fontSize(28)
     .text(`${formatNum(totalEmission)} kg CO2e`, { align: 'center' });

  // "Emission on Behalf of <NAME>" — center-align the line manually because
  // PDFKit's `align: 'center'` + `continued: true` positions both spans at the
  // same X and they overlap into garbled text.
  doc.moveDown(0.5);
  const prefix = 'Emission on Behalf of ';
  const nameUpper = (customerName || '').toUpperCase();
  doc.font('Helvetica').fontSize(12);
  const wPrefix = doc.widthOfString(prefix);
  doc.font('Helvetica-Bold').fontSize(12);
  const wName = doc.widthOfString(nameUpper);
  const startX = (doc.page.width - wPrefix - wName) / 2;
  const lineY = doc.y;
  doc.fillColor('#000').font('Helvetica').text(prefix, startX, lineY, { lineBreak: false });
  doc.font('Helvetica-Bold').text(nameUpper, startX + wPrefix, lineY, { lineBreak: false });
  doc.text(' ', 50, lineY + 16); // restore Y cursor below the line

  // Details block
  doc.moveDown(2);
  const yStart = doc.y;
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(11)
     .text(`Start Date: `, 50, yStart, { continued: true })
     .font('Helvetica').text(fromDateLabel);
  doc.font('Helvetica-Bold')
     .text(`End Date: `, 50, doc.y, { continued: true })
     .font('Helvetica').text(toDateLabel);

  doc.font('Helvetica-Bold').fontSize(11)
     .text('Method Used: ', 350, yStart, { continued: true })
     .font('Helvetica').fillColor('#c0392b').text(methodUsed);

  doc.fillColor('#000').moveDown(1.5);
  doc.font('Helvetica-Bold').fontSize(11)
     .text('Emission Averted By Rail: ', 50, doc.y, { continued: true })
     .font('Helvetica').text(`${formatNum(totalAversionRail)} kg CO2e`);

  // Disclaimer
  doc.moveDown(3);
  doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8)
     .text(
       'Disclaimer: Calculation methodology and reporting of logistics GHG emission is accredited ' +
       'by GLEC (Global Logistics Emission Council) Framework 3.2 released by Smart Freight Centre and based on ' +
       'ISO 14083 Principles. The shipper is enabled to track shipment level emission from the vehicle. ' +
       'Precision of the result and reported emission are subject to the accuracy of input materials at the ' +
       'time of display and circulation.',
       50, doc.y,
       { align: 'justify', width: doc.page.width - 100 }
     );

  // Footer
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9)
     .text('CJ Darcl Logistics Limited', 50, doc.page.height - 70, {
       align: 'center', width: doc.page.width - 100,
     });
  doc.fillColor(MUTED).font('Helvetica').fontSize(8)
     .text(`Period: ${periodLabel}`, { align: 'center', width: doc.page.width - 100 });

  doc.end();
}

function formatNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '0.00';
  return Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// Inline-email-safe HTML rendering of the certificate. Uses tables (not flex)
// so it renders consistently in Gmail/Outlook/Apple Mail. The `cid:cjdarcl-logo`
// reference is fulfilled by attaching the logo with `cid: 'cjdarcl-logo'` on
// the nodemailer side — see routes/certificate.js.
function generateCertificateHtml(payload) {
  const {
    customerName,
    fromDateLabel,
    toDateLabel,
    totalEmission,
    totalAversionRail,
    methodUsed = 'Road & Rail',
    issuedDate = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
  } = payload;
  const name = escapeHtml((customerName || '').toUpperCase());
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
       style="max-width:640px;margin:24px auto;background:#ffffff;border:1px solid #e3e6ed;border-radius:8px;
              font-family:Arial,Helvetica,sans-serif;color:#1a2b5f">
  <tr>
    <td style="padding:24px 32px 0 32px">
      <table role="presentation" width="100%"><tr>
        <td style="font-size:11px;color:#777;font-style:italic">Issued: ${escapeHtml(issuedDate)}</td>
        <td align="right"><img src="cid:cjdarcl-logo" alt="CJ Darcl" width="120" style="display:block;border:0;outline:none;text-decoration:none"></td>
      </tr></table>
    </td>
  </tr>
  <tr><td style="padding:0 32px"><hr style="border:0;border-top:1px solid #dde1e8;margin:18px 0 8px 0"></td></tr>
  <tr>
    <td align="center" style="padding:8px 32px">
      <h1 style="margin:8px 0;font-size:20px;color:#1a2b5f;font-weight:700">
        Total Logistics Emissions Accounted by CJ Darcl
      </h1>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:6px 32px">
      <div style="color:#2a9d54;font-size:30px;font-weight:700;font-style:italic">
        ${formatNum(totalEmission)} kg CO<sub>2</sub>e
      </div>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:6px 32px 24px 32px;color:#222;font-size:14px">
      Emission on Behalf of <strong>${name}</strong>
    </td>
  </tr>
  <tr>
    <td style="padding:0 32px">
      <table role="presentation" width="100%" style="font-size:13px;color:#222">
        <tr>
          <td style="vertical-align:top">
            <strong>Start Date:</strong> ${escapeHtml(fromDateLabel)}<br>
            <strong>End Date:</strong> ${escapeHtml(toDateLabel)}
          </td>
          <td align="right" style="vertical-align:top">
            <strong>Method Used:</strong> <span style="color:#c0392b">${escapeHtml(methodUsed)}</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:18px 32px 0 32px;font-size:13px;color:#222">
      <strong>Emission Averted By Rail:</strong> ${formatNum(totalAversionRail)} kg CO<sub>2</sub>e
    </td>
  </tr>
  <tr>
    <td style="padding:24px 32px 28px 32px;font-size:11px;color:#666;font-style:italic;line-height:1.5">
      <strong style="color:#444">Disclaimer:</strong> Calculation methodology and reporting of logistics GHG
      emission is accredited by GLEC (Global Logistics Emission Council) Framework 3.2 released by Smart
      Freight Centre and based on ISO 14083 Principles. The shipper is enabled to track shipment level
      emission from the vehicle. Precision of the result and reported emission are subject to the accuracy
      of input materials at the time of display and circulation.
    </td>
  </tr>
</table>`;
}

module.exports = { generateCertificatePdf, generateCertificateHtml, LOGO_PATH };
