#!/usr/bin/env node
'use strict';

// PerformanceHub local agent.
//
// Runs on a machine on your LAN. Connects OUTBOUND to your PerformanceHub cloud
// site over a WebSocket, pairs to your account with a one-time code, then serves
// scan + device-control requests relayed from your browser. Nothing listens for
// inbound connections, so there are no ports to open on your router.

const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const { scanNetwork } = require('./scanner');
const devices = require('./devices');

// ---------------------------------------------------------------------------
// Config (server URL + saved pairing token) persisted in the user's home dir.
// ---------------------------------------------------------------------------
const CONFIG_DIR = path.join(os.homedir(), '.performancehub');
const CONFIG_FILE = path.join(CONFIG_DIR, 'agent.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('Could not save config:', e.message);
  }
}

// ---------------------------------------------------------------------------
// CLI args:  --pair CODE   --server https://your-site   --name "Living room PC"
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pair') out.pair = argv[++i];
    else if (a === '--server') out.server = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function toWsBase(server) {
  if (!server) return null;
  return server.replace(/\/+$/, '').replace(/^http/i, (m) => (m.toLowerCase() === 'https' ? 'wss' : 'ws'));
}

function printHelp() {
  console.log(`
PerformanceHub agent

First time (pair with your account):
  performancehub-agent --server https://YOUR-SITE --pair XXXX-XXXX

After pairing, just run:
  performancehub-agent

Options:
  --server URL   Your PerformanceHub website (e.g. https://performancehub.onrender.com)
  --pair CODE    One-time pairing code from the dashboard ("Pair a new agent")
  --name NAME    Friendly name shown in the dashboard (default: this machine's hostname)
`);
}

// ---------------------------------------------------------------------------
// Connection with auto-reconnect + backoff.
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv);
if (args.help) {
  printHelp();
  process.exit(0);
}

const config = loadConfig();
if (args.server) config.server = args.server;
if (args.name) config.name = args.name;

const server = config.server;
const agentName = config.name || os.hostname();
const wsBase = toWsBase(server);

if (!wsBase) {
  console.error('No server configured. Run with:  --server https://your-site --pair XXXX-XXXX');
  printHelp();
  process.exit(1);
}
if (!args.pair && !config.token) {
  console.error('This agent is not paired yet. Run with:  --pair XXXX-XXXX  (get a code from the dashboard)');
  process.exit(1);
}

let reconnectDelay = 1000;
const MAX_DELAY = 30000;
let usePairCode = args.pair || null;

function connect() {
  const params = new URLSearchParams({ name: agentName, platform: os.platform() });
  if (usePairCode) params.set('code', usePairCode.toUpperCase());
  else params.set('token', config.token);

  const urlStr = `${wsBase}/agent?${params.toString()}`;
  const ws = new WebSocket(urlStr);

  ws.on('open', () => {
    reconnectDelay = 1000;
    console.log(`Connected to ${server} as "${agentName}".`);
    if (usePairCode) console.log('Pairing…');
  });

  ws.on('message', (data) => handleMessage(ws, data));

  ws.on('close', (code) => {
    if (code === 1008 || code === 4401) {
      console.error('Authentication rejected. Re-pair with a fresh code from the dashboard.');
    }
    scheduleReconnect();
  });

  ws.on('unexpected-response', (_req, res) => {
    if (res.statusCode === 401) {
      console.error(
        usePairCode
          ? 'Pairing code was invalid or expired. Get a new one from the dashboard.'
          : 'Saved pairing was rejected. Re-pair with:  --pair XXXX-XXXX'
      );
      if (!usePairCode) {
        // Stored token is dead; clear it so the next run prompts for a code.
        delete config.token;
        saveConfig(config);
      }
      process.exit(1);
    }
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('Connection error:', err.message);
  });
}

function scheduleReconnect() {
  console.log(`Reconnecting in ${Math.round(reconnectDelay / 1000)}s…`);
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------
async function handleMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (_) {
    return;
  }

  if (msg.t === 'paired' && msg.token) {
    // Persist durable token; stop using the one-time code.
    config.token = msg.token;
    saveConfig(config);
    usePairCode = null;
    console.log('Paired successfully. This agent will reconnect automatically from now on.');
    return;
  }

  if (msg.t === 'scan') {
    try {
      const result = await scanNetwork({
        onProgress: (p) => send(ws, { t: 'scan-progress', ...p }),
      });
      send(ws, { t: 'scan-result', ...result });
    } catch (e) {
      send(ws, { t: 'scan-result', error: e.message, devices: [], scannedAt: new Date().toISOString() });
    }
    return;
  }

  if (msg.t === 'action') {
    const { id, action, ip, payload = {} } = msg;
    try {
      const data = await runAction(action, ip, payload);
      send(ws, { t: 'action-result', id, ok: true, data });
    } catch (e) {
      send(ws, { t: 'action-result', id, ok: false, error: e.message });
    }
    return;
  }
}

async function runAction(action, ip, payload) {
  switch (action) {
    case 'get-volume': {
      const volume = await devices.getCastVolume(ip);
      return { volume };
    }
    case 'volume': {
      let volume;
      if (typeof payload.muted === 'boolean') volume = await devices.setCastMuted(ip, payload.muted);
      else if (typeof payload.level === 'number') volume = await devices.setCastVolume(ip, payload.level);
      else if (typeof payload.step === 'number') volume = await devices.stepCastVolume(ip, payload.step);
      else throw new Error('volume action needs step, level, or muted');
      return { volume };
    }
    case 'snapshot': {
      const rtspUrl = devices.buildRtspUrl({
        ip,
        username: payload.username,
        password: payload.password,
        path: payload.path,
        port: payload.port ? parseInt(payload.port, 10) : undefined,
      });
      const buf = await devices.captureSnapshot(rtspUrl);
      return { jpegBase64: buf.toString('base64') };
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

console.log(`PerformanceHub agent starting (server: ${server})`);
connect();
