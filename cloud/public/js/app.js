'use strict';

const state = {
  ws: null,
  connected: false,
  agents: [],
  devices: [],
  pending: new Map(), // action id -> {resolve, reject, timer}
  seq: 0,
  pairPoll: null,
  currentCamera: null,
  camLiveTimer: null,
  repo: 'pkaller/performancehub',
  asset: null, // detected binary filename for this OS
};

// Agent binaries (must match the release asset names + download page).
const ASSETS = [
  { key: 'win', label: 'Windows', file: 'performancehub-agent-win-x64.exe', icon: '🪟' },
  { key: 'macos-arm', label: 'macOS (Apple Silicon)', file: 'performancehub-agent-macos-arm64', icon: '🍎' },
  { key: 'macos-x64', label: 'macOS (Intel)', file: 'performancehub-agent-macos-x64', icon: '🍎' },
  { key: 'linux', label: 'Linux', file: 'performancehub-agent-linux-x64', icon: '🐧' },
];
function detectOs() {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const ua = navigator.userAgent;
  if (/Win/i.test(p) || /Windows/i.test(ua)) return 'win';
  if (/Mac/i.test(p) || /Mac OS X/i.test(ua)) return /arm|apple/i.test(ua) ? 'macos-arm' : 'macos-x64';
  return 'linux';
}

// ---------- helpers ----------
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 4000);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function iconFor(d) {
  const t = d.type || '';
  if (/camera/i.test(t)) return '📷';
  if (/cast|speaker/i.test(t)) return '🔊';
  if (/airplay/i.test(t)) return '🎵';
  if (/printer/i.test(t)) return '🖨️';
  if (/plex|media/i.test(t)) return '🎬';
  if (/server|ssh/i.test(t)) return '🖥️';
  if (/web/i.test(t)) return '🌐';
  return '📦';
}

// ---------- bootstrap ----------
async function init() {
  const me = await (await fetch('/api/me')).json();
  if (!me.authenticated) {
    location.href = '/login.html';
    return;
  }
  renderUser(me.user);
  await setupDownloads();
  document.getElementById('scan-btn').addEventListener('click', startScan);
  document.getElementById('logout').addEventListener('click', logout);
  document.getElementById('pair-btn').addEventListener('click', requestPairCode);
  wireCameraModal();
  connectWs();
}

// Render OS-aware download buttons into the pairing banner (post-login flow).
async function setupDownloads() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (cfg.repo) state.repo = cfg.repo;
  } catch (_) {}

  const base = `https://github.com/${state.repo}/releases/latest/download`;
  const detected = detectOs();
  const primary = ASSETS.find((a) => a.key === detected) || ASSETS[0];
  state.asset = primary.file;

  const others = ASSETS.filter((a) => a.key !== primary.key);
  const box = document.getElementById('pair-downloads');
  if (!box) return;
  box.innerHTML = `
    <a class="btn btn-primary dl-btn" href="${base}/${primary.file}" download>
      ${primary.icon} Download for ${primary.label}
    </a>
    <div class="dl-others">
      ${others.map((a) => `<a href="${base}/${a.file}" download>${a.icon} ${a.label}</a>`).join('')}
    </div>`;
}

function renderUser(user) {
  const el = document.getElementById('user');
  el.innerHTML = '';
  if (user.photo) {
    const img = document.createElement('img');
    img.src = user.photo;
    el.appendChild(img);
  }
  const span = document.createElement('span');
  span.textContent = user.name || user.email;
  el.appendChild(span);
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  location.href = '/login.html';
}

// ---------- websocket ----------
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
  };
  ws.onclose = () => {
    state.connected = false;
    setTimeout(connectWs, 2000); // auto-reconnect
  };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    handleMessage(msg);
  };
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  toast('Not connected to the server yet.', true);
  return false;
}

function handleMessage(msg) {
  switch (msg.t) {
    case 'agents':
      onAgents(msg.list || []);
      break;
    case 'scan-progress':
      updateProgress(msg);
      break;
    case 'scan-result':
      onScanResult(msg);
      break;
    case 'action-result': {
      const p = state.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        state.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || 'Action failed'));
      }
      break;
    }
    case 'error':
      toast(msg.message || 'Error', true);
      resetScanButton();
      break;
  }
}

function sendAction(action, ip, payload) {
  return new Promise((resolve, reject) => {
    const id = 'a' + ++state.seq;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error('Timed out waiting for the agent.'));
    }, 20000);
    state.pending.set(id, { resolve, reject, timer });
    if (!wsSend({ t: 'action', id, action, ip, payload })) {
      clearTimeout(timer);
      state.pending.delete(id);
      reject(new Error('Not connected.'));
    }
  });
}

// ---------- agent presence / pairing ----------
function onAgents(list) {
  state.agents = list;
  const online = list.length > 0;
  const statusEl = document.getElementById('agent-status');
  statusEl.textContent = online ? `${list.length} agent${list.length > 1 ? 's' : ''} online` : 'No agent';
  statusEl.className = 'agent-status ' + (online ? 'online' : 'offline');
  document.getElementById('scan-btn').disabled = !online;
  document.getElementById('pair-banner').hidden = online;
  document.getElementById('empty').hidden = !(online && state.devices.length === 0);

  if (online && state.pairPoll) {
    clearInterval(state.pairPoll);
    state.pairPoll = null;
    toast('Agent connected!');
  }
}

async function requestPairCode() {
  try {
    const res = await fetch('/api/pair/new', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    document.getElementById('pair-code').textContent = data.code;
    const file = state.asset || 'performancehub-agent';
    const runner = file.endsWith('.exe') ? file : `./${file}`;
    document.getElementById('pair-cmd').textContent =
      `${runner} --server ${location.origin} --pair ${data.code}`;
    document.getElementById('pair-code-box').hidden = false;
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- scanning ----------
function startScan() {
  const btn = document.getElementById('scan-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  document.getElementById('progress').hidden = false;
  document.getElementById('empty').hidden = true;
  wsSend({ t: 'scan' });
}
function resetScanButton() {
  const btn = document.getElementById('scan-btn');
  btn.disabled = state.agents.length === 0;
  btn.textContent = 'Scan network';
  document.getElementById('progress').hidden = true;
}
function updateProgress(p) {
  const fill = document.getElementById('progress-fill');
  const text = document.getElementById('progress-text');
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  fill.style.width = pct + '%';
  const phase = p.phase === 'ping' ? 'Pinging hosts' : p.phase === 'probe' ? 'Probing devices' : 'Starting';
  text.textContent = `${phase} — ${p.done}/${p.total} ${p.cidr || ''}`;
}
function onScanResult(result) {
  resetScanButton();
  if (result.error) {
    toast('Scan error: ' + result.error, true);
    return;
  }
  state.devices = result.devices || [];
  document.getElementById('scan-meta').textContent =
    `${state.devices.length} devices · ${result.cidr} · ${new Date(result.scannedAt).toLocaleTimeString()}`;
  document.getElementById('empty').hidden = state.devices.length > 0;
  const grid = document.getElementById('devices');
  grid.innerHTML = '';
  state.devices.forEach((d) => grid.appendChild(deviceCard(d)));
}

// ---------- device cards ----------
function deviceCard(d) {
  const card = document.createElement('div');
  card.className = 'device-card';

  const head = document.createElement('div');
  head.className = 'device-head';
  head.innerHTML = `
    <div class="device-icon">${iconFor(d)}</div>
    <div class="device-title">
      <div class="device-name" title="${esc(d.name)}">${esc(d.name)}</div>
      <div class="device-type">${esc(d.type)}</div>
    </div>`;
  card.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'device-meta';
  meta.innerHTML = `
    <span>IP <code>${esc(d.ip)}</code></span>
    ${d.mac ? `<span>MAC <code>${esc(d.mac)}</code></span>` : ''}
    ${d.vendor ? `<span>${esc(d.vendor)}</span>` : ''}
    ${d.hostname ? `<span>${esc(d.hostname)}</span>` : ''}`;
  card.appendChild(meta);

  if (d.openPorts && d.openPorts.length) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    d.openPorts.forEach((p) => {
      const c = document.createElement('span');
      c.className = 'chip port';
      c.textContent = `${p.name}:${p.port}`;
      chips.appendChild(c);
    });
    card.appendChild(chips);
  }

  const actions = buildActions(d);
  if (actions) card.appendChild(actions);
  return card;
}

function buildActions(d) {
  const caps = d.capabilities || [];
  if (!caps.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'actions';

  if (caps.includes('cast-volume')) wrap.appendChild(volumeControl(d));
  if (caps.includes('video-feed')) wrap.appendChild(button('📹 Video feed', () => openCamera(d)));
  if (caps.includes('open-web')) {
    const proto = d.openPorts.some((p) => p.name === 'https') ? 'https' : 'http';
    const port = d.openPorts.find((p) => p.name === 'http-alt') ? ':8080' : '';
    wrap.appendChild(button('🌐 Open web UI', () => window.open(`${proto}://${d.ip}${port}`, '_blank')));
  }
  if (caps.includes('ssh-info')) wrap.appendChild(button('🖥️ SSH', () => copyText(`ssh ${d.ip}`, 'SSH command copied')));
  if (caps.includes('printer-info')) wrap.appendChild(button('🖨️ Printer admin', () => window.open(`http://${d.ip}:631`, '_blank')));
  if (caps.includes('airplay-info')) wrap.appendChild(button('🎵 AirPlay', () => toast('AirPlay device — control from macOS/iOS.')));
  return wrap;
}

function volumeControl(d) {
  const box = document.createElement('div');
  box.className = 'vol-control';
  const label = document.createElement('span');
  label.className = 'vol-label';
  label.textContent = '—';

  const down = button('🔉', () => act(sendAction('volume', d.ip, { step: -0.1 }), label), 'btn-sm');
  const up = button('🔊', () => act(sendAction('volume', d.ip, { step: 0.1 }), label), 'btn-sm');
  const mute = button('🔇', () => act(sendAction('volume', d.ip, { muted: true }), label, 'Muted'), 'btn-sm');

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.value = '50';
  slider.addEventListener('change', () => act(sendAction('volume', d.ip, { level: slider.value / 100 }), label));

  box.append(down, slider, up, mute, label);

  // Lazy-load current volume.
  sendAction('get-volume', d.ip, {})
    .then((data) => {
      if (data && data.volume && typeof data.volume.level === 'number') {
        slider.value = Math.round(data.volume.level * 100);
        label.textContent = slider.value + '%';
      }
    })
    .catch(() => {});
  return box;

  function act(promise, labelEl, okMsg) {
    promise
      .then((data) => {
        if (data && data.volume && typeof data.volume.level === 'number') {
          if (labelEl) labelEl.textContent = Math.round(data.volume.level * 100) + '%';
          slider.value = Math.round(data.volume.level * 100);
        }
        if (okMsg) toast(okMsg);
      })
      .catch((e) => toast(e.message, true));
  }
}

// ---------- camera modal ----------
function wireCameraModal() {
  const modal = document.getElementById('camera-modal');
  modal.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeCamera));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeCamera();
  });
  document.getElementById('cam-connect').addEventListener('click', connectCamera);
  document.getElementById('cam-live').addEventListener('change', (e) => (e.target.checked ? startLive() : stopLive()));
}
function openCamera(d) {
  state.currentCamera = d;
  document.getElementById('camera-title').textContent = `Video feed — ${d.name}`;
  document.getElementById('cam-status').textContent = 'Not connected';
  document.getElementById('cam-img').removeAttribute('src');
  document.getElementById('cam-live').checked = false;
  const path = document.getElementById('cam-path');
  if (/hikvision/i.test(d.vendor || '')) path.value = '/Streaming/Channels/101';
  else if (/dahua|amcrest/i.test(d.vendor || '')) path.value = '/cam/realmonitor?channel=1&subtype=0';
  document.getElementById('camera-modal').hidden = false;
}
function closeCamera() {
  stopLive();
  document.getElementById('camera-modal').hidden = true;
  state.currentCamera = null;
}
function connectCamera() {
  const d = state.currentCamera;
  const status = document.getElementById('cam-status');
  const img = document.getElementById('cam-img');
  status.textContent = 'Connecting…';
  sendAction('snapshot', d.ip, {
    username: document.getElementById('cam-user').value,
    password: document.getElementById('cam-pass').value,
    path: document.getElementById('cam-path').value,
    port: document.getElementById('cam-port').value,
  })
    .then((data) => {
      if (data && data.jpegBase64) {
        img.src = `data:image/jpeg;base64,${data.jpegBase64}`;
        status.textContent = '';
      } else {
        status.textContent = 'No image returned.';
      }
    })
    .catch((e) => (status.textContent = e.message));
}
function startLive() {
  stopLive();
  connectCamera();
  state.camLiveTimer = setInterval(connectCamera, 2500);
}
function stopLive() {
  clearInterval(state.camLiveTimer);
  state.camLiveTimer = null;
}

// ---------- utils ----------
function button(text, onClick, extraClass = '') {
  const b = document.createElement('button');
  b.className = 'btn btn-sm ' + extraClass;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
function copyText(text, msg) {
  navigator.clipboard?.writeText(text).then(() => toast(msg || 'Copied'));
}

init();
