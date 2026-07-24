'use strict';

const { WebSocketServer } = require('ws');
const url = require('url');
const tokens = require('./tokens');

// Per-user connection registry.
//   browsers: uid -> Set<ws>
//   agents:   uid -> Set<ws>  (ws.agentMeta holds name/platform)
const browsers = new Map();
const agents = new Map();

function addTo(map, uid, ws) {
  if (!map.has(uid)) map.set(uid, new Set());
  map.get(uid).add(ws);
}
function removeFrom(map, uid, ws) {
  const set = map.get(uid);
  if (set) {
    set.delete(ws);
    if (set.size === 0) map.delete(uid);
  }
}
function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(map, uid, obj) {
  const set = map.get(uid);
  if (!set) return;
  for (const ws of set) send(ws, obj);
}

function agentListFor(uid) {
  const set = agents.get(uid);
  if (!set) return [];
  return [...set].map((ws) => ws.agentMeta || { name: 'agent' });
}

function notifyBrowsersOfAgents(uid) {
  broadcast(browsers, uid, { t: 'agents', list: agentListFor(uid) });
}

function setup({ server, sessionMiddleware }) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);

    if (pathname === '/agent') {
      // Agent auth: existing signed token, or a one-time pairing code.
      let uid = null;
      if (query.token) {
        const payload = tokens.verifyAgentToken(query.token);
        if (payload) uid = payload.uid;
      } else if (query.code) {
        uid = tokens.redeemPairingCode(String(query.code).toUpperCase());
      }
      if (!uid) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.role = 'agent';
        ws.uid = uid;
        ws.agentMeta = {
          name: (query.name && String(query.name).slice(0, 60)) || 'Local agent',
          platform: (query.platform && String(query.platform).slice(0, 20)) || 'unknown',
        };
        // If it paired via code, mint a durable token so it need not re-pair.
        if (query.code) {
          send(ws, { t: 'paired', token: tokens.issueAgentToken(uid) });
        }
        onAgentConnected(ws);
      });
      return;
    }

    if (pathname === '/ws') {
      // Browser auth: reuse the express session.
      sessionMiddleware(req, {}, () => {
        const sessUser = req.session && req.session.passport && req.session.passport.user;
        if (!sessUser) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.role = 'browser';
          ws.uid = sessUser.id;
          onBrowserConnected(ws);
        });
      });
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  return wss;
}

function onAgentConnected(ws) {
  addTo(agents, ws.uid, ws);
  notifyBrowsersOfAgents(ws.uid);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    // Agent → browsers (scan progress/results, action results).
    if (['scan-progress', 'scan-result', 'action-result', 'agent-info'].includes(msg.t)) {
      broadcast(browsers, ws.uid, msg);
    }
  });

  ws.on('close', () => {
    removeFrom(agents, ws.uid, ws);
    notifyBrowsersOfAgents(ws.uid);
  });
  ws.on('error', () => {});

  // Heartbeat.
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
}

function onBrowserConnected(ws) {
  addTo(browsers, ws.uid, ws);
  // Tell this browser which agents are currently online.
  send(ws, { t: 'agents', list: agentListFor(ws.uid) });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    // Browser → agents (scan requests, device actions).
    if (['scan', 'action'].includes(msg.t)) {
      const set = agents.get(ws.uid);
      if (!set || set.size === 0) {
        send(ws, { t: 'error', message: 'No local agent is connected. Install and run the agent.' });
        return;
      }
      broadcast(agents, ws.uid, msg);
    }
  });

  ws.on('close', () => removeFrom(browsers, ws.uid, ws));
  ws.on('error', () => {});
}

// Keep-alive: drop dead agent sockets so the dashboard reflects reality.
function startHeartbeat(wss) {
  const interval = setInterval(() => {
    for (const set of agents.values()) {
      for (const ws of set) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch (_) {}
      }
    }
  }, 30000);
  interval.unref();
  wss.on('close', () => clearInterval(interval));
}

module.exports = { setup, startHeartbeat };
