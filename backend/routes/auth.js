const express = require('express');
const crypto = require('crypto');

const router = express.Router();

const USERS = [
  {
    email: 'varun2.sharma@cjdarcl.com',
    password: 'Varun@Carbon2026',
    name: 'Varun Sharma',
  },
  {
    email: 'beauty.pandey@cjdarcl.com',
    password: 'Beauty@Emission2026',
    name: 'Beauty Pandey',
  },
  {
    email: 'vaishnavi.singh@cjdarcl.com',
    password: 'Vaishnavi@Green2026',
    name: 'Vaishnavi Singh',
  },
  {
    email: 'harshit.kumar@cjdarcl.com',
    password: 'Harshit@Fleet2026',
    name: 'Harshit Kumar',
  },
  {
    email: 'prem.singh@cjdarcl.com',
    password: 'Prem@Logistics2026',
    name: 'Prem Singh',
  },
];

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map(); // token -> { email, name, expiresAt }

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function findUser(email, password) {
  const norm = String(email || '').trim().toLowerCase();
  return USERS.find(u => u.email.toLowerCase() === norm && u.password === password);
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return s;
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.auth_token;
  const s = getSession(token);
  if (!s) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { email: s.email, name: s.name };
  next();
}

router.post('/login', express.json(), (req, res) => {
  const { email, password } = req.body || {};
  const user = findUser(email, password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const token = newToken();
  sessions.set(token, {
    email: user.email,
    name: user.name,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  res.cookie('auth_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ ok: true, user: { email: user.email, name: user.name } });
});

router.post('/logout', (req, res) => {
  const token = req.cookies && req.cookies.auth_token;
  if (token) sessions.delete(token);
  res.clearCookie('auth_token', { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies && req.cookies.auth_token;
  const s = getSession(token);
  if (!s) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ email: s.email, name: s.name });
});

module.exports = { router, requireAuth, peekSession: getSession };
