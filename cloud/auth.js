'use strict';

const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');

function parseAllowedEmails() {
  return (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isEmailAllowed(email) {
  const allowed = parseAllowedEmails();
  if (allowed.length === 0) return true;
  return allowed.includes(String(email || '').toLowerCase());
}

function configurePassport() {
  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  // Strip any trailing slash so we never build "...com//auth/google/callback".
  const baseUrl = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

  if (!clientID || !clientSecret) {
    console.warn('[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set — login will not work.');
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: clientID || 'missing',
        clientSecret: clientSecret || 'missing',
        callbackURL: `${baseUrl}/auth/google/callback`,
      },
      (accessToken, refreshToken, profile, done) => {
        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
        if (!isEmailAllowed(email)) return done(null, false, { message: 'not-allowed' });
        done(null, {
          id: profile.id,
          name: profile.displayName,
          email,
          photo: profile.photos && profile.photos[0] ? profile.photos[0].value : null,
        });
      }
    )
  );

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));
}

function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

function registerAuthRoutes(app) {
  app.get(
    '/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })
  );

  app.get('/auth/google/callback', (req, res, next) => {
    passport.authenticate('google', (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        const reason = info && info.message === 'not-allowed' ? 'not-allowed' : 'failed';
        return res.redirect(`/login.html?error=${reason}`);
      }
      req.logIn(user, (e) => (e ? next(e) : res.redirect('/app.html')));
    })(req, res, next);
  });

  app.post('/auth/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session = null; // cookie-session: clearing the cookie ends the session
      res.json({ ok: true });
    });
  });

  app.get('/api/me', (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return res.json({ authenticated: true, user: req.user });
    }
    res.json({ authenticated: false });
  });
}

module.exports = { configurePassport, registerAuthRoutes, ensureAuth, isEmailAllowed };
