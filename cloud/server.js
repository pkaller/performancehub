'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const passport = require('passport');

const { configurePassport, registerAuthRoutes, ensureAuth } = require('./auth');
const tokens = require('./tokens');
const relay = require('./relay');

const PORT = parseInt(process.env.PORT || '3000', 10);
const REPO = process.env.GITHUB_REPO || 'pkaller/performancehub';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true', // set true behind HTTPS (e.g. on Render)
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});
app.use(sessionMiddleware);

configurePassport();
app.use(passport.initialize());
app.use(passport.session());

registerAuthRoutes(app);

const publicDir = path.join(__dirname, 'public');

// The dashboard requires login; everything else (landing, login, downloads) is public.
app.get('/app.html', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.sendFile(path.join(publicDir, 'app.html'));
  }
  res.redirect('/login.html');
});
app.use(express.static(publicDir, { index: 'index.html' }));

// --- Pairing API -----------------------------------------------------------

// Browser (logged in) asks for a fresh pairing code to type into the agent.
app.post('/api/pair/new', ensureAuth, (req, res) => {
  const { code, expiresInMs } = tokens.newPairingCode(req.user.id);
  res.json({ code, expiresInMs });
});

// Exposes the repo slug so the download page can link to the right releases.
app.get('/api/config', (req, res) => {
  res.json({ repo: REPO, relayUrl: publicWsUrl(req) });
});

function publicWsUrl(req) {
  const base = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return base.replace(/^http/, 'ws');
}

// --- Start -----------------------------------------------------------------

const server = http.createServer(app);
const wss = relay.setup({ server, sessionMiddleware });
relay.startHeartbeat(wss);

server.listen(PORT, () => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  console.log(`\nPerformanceHub cloud running at ${baseUrl}`);
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.log('⚠  Google OAuth not configured — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET\n');
  }
});
