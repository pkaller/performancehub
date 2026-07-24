'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');

const { configurePassport, registerAuthRoutes, ensureAuth } = require('./auth');
const { scanNetwork } = require('./scanner');
const devices = require('./devices');

const PORT = parseInt(process.env.PORT || '3000', 10);
const app = express();

app.set('trust proxy', 1);
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // set true only behind HTTPS
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

configurePassport();
app.use(passport.initialize());
app.use(passport.session());

registerAuthRoutes(app);

// --- Static assets ---------------------------------------------------------
const publicDir = path.join(__dirname, '..', 'public');

// Gate the dashboard (index.html) behind auth; everything else in /public is public.
app.get('/', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.sendFile(path.join(publicDir, 'index.html'));
  }
  return res.redirect('/login.html');
});
app.use(express.static(publicDir, { index: false }));

// --- In-memory scan cache --------------------------------------------------
let lastScan = null;
let scanning = false;
let scanProgress = null;

// --- API -------------------------------------------------------------------

app.get('/api/config', ensureAuth, (req, res) => {
  res.json({ castAvailable: devices.castAvailable() });
});

app.get('/api/scan', ensureAuth, (req, res) => {
  res.json({
    scanning,
    progress: scanProgress,
    result: lastScan,
  });
});

app.post('/api/scan', ensureAuth, async (req, res) => {
  if (scanning) {
    return res.status(409).json({ error: 'scan-in-progress', progress: scanProgress });
  }
  scanning = true;
  scanProgress = { phase: 'starting', done: 0, total: 0 };

  // Run in the background; client polls GET /api/scan.
  scanNetwork({ onProgress: (p) => (scanProgress = p) })
    .then((result) => {
      lastScan = result;
    })
    .catch((err) => {
      lastScan = { error: err.message, scannedAt: new Date().toISOString(), devices: [] };
    })
    .finally(() => {
      scanning = false;
    });

  res.status(202).json({ started: true });
});

function findDevice(ip) {
  if (!lastScan || !lastScan.devices) return null;
  return lastScan.devices.find((d) => d.ip === ip) || null;
}

// --- Device actions --------------------------------------------------------

// Cast volume: body { step: 0.1 } or { level: 0.5 } or { muted: true }
app.post('/api/devices/:ip/volume', ensureAuth, async (req, res) => {
  const ip = req.params.ip;
  try {
    let result;
    if (typeof req.body.muted === 'boolean') {
      result = await devices.setCastMuted(ip, req.body.muted);
    } else if (typeof req.body.level === 'number') {
      result = await devices.setCastVolume(ip, req.body.level);
    } else if (typeof req.body.step === 'number') {
      result = await devices.stepCastVolume(ip, req.body.step);
    } else {
      return res.status(400).json({ error: 'Provide one of: step, level, muted' });
    }
    res.json({ ok: true, volume: result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/devices/:ip/volume', ensureAuth, async (req, res) => {
  try {
    const volume = await devices.getCastVolume(req.params.ip);
    res.json({ ok: true, volume });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Camera snapshot: query ?username=&password=&path=&port=
app.get('/api/devices/:ip/snapshot', ensureAuth, async (req, res) => {
  const ip = req.params.ip;
  const rtspUrl = devices.buildRtspUrl({
    ip,
    username: req.query.username,
    password: req.query.password,
    path: req.query.path,
    port: req.query.port ? parseInt(req.query.port, 10) : undefined,
  });
  try {
    await devices.streamSnapshot(rtspUrl, res);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

// Returns a device's inferred RTSP URL (without embedding secrets in HTML).
app.get('/api/devices/:ip/rtsp', ensureAuth, (req, res) => {
  const ip = req.params.ip;
  res.json({
    url: devices.buildRtspUrl({
      ip,
      username: req.query.username,
      password: req.query.password,
      path: req.query.path,
      port: req.query.port ? parseInt(req.query.port, 10) : undefined,
    }),
  });
});

app.listen(PORT, () => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  console.log(`\nPerformanceHub running at ${baseUrl}`);
  console.log(`Open that URL in your browser and sign in with Google.\n`);
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.log('⚠  Google OAuth is not configured yet — see README.md / .env.example\n');
  }
});
