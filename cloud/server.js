'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cookieSession = require('cookie-session');
const passport = require('passport');

const { configurePassport, registerAuthRoutes, ensureAuth } = require('./auth');
const tokens = require('./tokens');
const relay = require('./relay');

const PORT = parseInt(process.env.PORT || '3000', 10);
const REPO = process.env.GITHUB_REPO || 'pkaller/performancehub';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// Stateless, cookie-backed sessions: the (signed) session lives in the user's
// cookie, not in server memory — so logins survive server restarts and Render
// free-tier cold starts. No session store to lose on redeploy.
const sessionMiddleware = cookieSession({
  name: 'ph_sess',
  keys: [process.env.SESSION_SECRET || 'insecure-dev-secret-change-me'],
  maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.COOKIE_SECURE === 'true', // true behind HTTPS (Render)
});
app.use(sessionMiddleware);

// Passport 0.6+ calls req.session.regenerate/save on login; cookie-session
// has neither, so provide no-op shims (the cookie is the whole session).
app.use((req, res, next) => {
  if (req.session && typeof req.session.regenerate !== 'function') {
    req.session.regenerate = (cb) => cb && cb();
  }
  if (req.session && typeof req.session.save !== 'function') {
    req.session.save = (cb) => cb && cb();
  }
  next();
});

configurePassport();
app.use(passport.initialize());
app.use(passport.session());

registerAuthRoutes(app);

const publicDir = path.join(__dirname, 'public');

// The dashboard requires login; everything else (landing, login, downloads) is public.
// Pages that require login: the dashboard and the agent download page.
// (Downloading the agent is part of the post-login connect flow.)
function requireLogin(file) {
  return (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return res.sendFile(path.join(publicDir, file));
    }
    res.redirect('/login.html');
  };
}
app.get('/app.html', requireLogin('app.html'));
app.get('/download.html', requireLogin('download.html'));
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
