'use strict';

const crypto = require('crypto');

// Stateless, HMAC-signed agent tokens so the relay needs no database:
// a token encodes { uid, aid, iat } and is verified by signature. This means
// paired agents keep working across cloud restarts (important on hosts with
// ephemeral disk / frequent redeploys like Render's free tier).

function secret() {
  return process.env.RELAY_SECRET || process.env.SESSION_SECRET || 'insecure-dev-relay-secret';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  // Constant-time compare.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

// Issues an agent token bound to a user.
function issueAgentToken(uid) {
  const aid = crypto.randomBytes(6).toString('hex');
  // iat is informational only; tokens do not expire (agent is long-lived).
  return sign({ uid, aid, iat: Math.floor(Date.now() / 1000) });
}

// ---------------------------------------------------------------------------
// Pairing codes: short-lived, single-use, in-memory. Losing these on a restart
// is harmless — the user just generates a new one. Already-paired agents keep
// their signed token and are unaffected.
// ---------------------------------------------------------------------------
const pairing = new Map(); // code -> { uid, expires }
const PAIR_TTL_MS = 10 * 60 * 1000;

function newPairingCode(uid) {
  // Human-friendly: 8 chars, no ambiguous 0/O/1/I.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
  pairing.set(formatted, { uid, expires: Date.now() + PAIR_TTL_MS });
  return { code: formatted, expiresInMs: PAIR_TTL_MS };
}

function redeemPairingCode(code) {
  const entry = pairing.get(code);
  if (!entry) return null;
  pairing.delete(code); // single-use
  if (Date.now() > entry.expires) return null;
  return entry.uid;
}

// Periodic cleanup of expired codes.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pairing) {
    if (now > entry.expires) pairing.delete(code);
  }
}, 60 * 1000).unref();

module.exports = { issueAgentToken, verifyAgentToken: verify, newPairingCode, redeemPairingCode };
