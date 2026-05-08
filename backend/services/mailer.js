const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  if (!host) {
    // No SMTP configured: return a stub that never fails so the certificate
    // dispatch UI can be exercised end-to-end in demo mode.
    transporter = {
      sendMail: async (opts) => {
        return {
          messageId: `demo-${Date.now()}@local`,
          accepted: [].concat(opts.to || []),
          rejected: [],
          envelope: { from: opts.from, to: opts.to },
          response: '250 OK (demo)',
          demo: true,
        };
      },
    };
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transporter;
}

async function sendCertificateEmail({ to, cc, subject, body, html, attachment, inlineImages }) {
  const t = getTransporter();
  const attachments = [];
  if (attachment) attachments.push(attachment);
  if (Array.isArray(inlineImages)) {
    for (const img of inlineImages) {
      attachments.push({ ...img, cid: img.cid }); // `cid` makes it inline
    }
  }
  const info = await t.sendMail({
    from: process.env.MAIL_FROM || 'CJ Darcl Sustainability <noreply@cjdarcl.com>',
    to,
    cc,
    subject,
    text: body,
    html,
    attachments: attachments.length ? attachments : undefined,
  });
  return info;
}

module.exports = { sendCertificateEmail };
