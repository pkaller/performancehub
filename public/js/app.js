'use strict';

const state = {
  castAvailable: false,
  polling: null,
  devices: [],
  currentCamera: null,
  camLiveTimer: null,
};

// ---------- helpers ----------
async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('unauthenticated');
  }
  return res;
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3500);
}

function iconFor(device) {
  const t = device.type || '';
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
  const me = await (await api('/api/me')).json();
  if (!me.authenticated) {
    location.href = '/login.html';
    return;
  }
  renderUser(me.user);

  const config = await (await api('/api/config')).json();
  state.castAvailable = config.castAvailable;

  document.getElementById('scan-btn').addEventListener('click', startScan);
  document.getElementById('logout').addEventListener('click', logout);
  wireCameraModal();

  // Load any existing scan.
  const existing = await (await api('/api/scan')).json();
  if (existing.result) renderScan(existing.result);
  if (existing.scanning) beginPolling();
}

function renderUser(user) {
  const el = document.getElementById('user');
  el.innerHTML = '';
  if (user.photo) {
    const img = document.createElement('img');
    img.src = user.photo;
    img.alt = '';
    el.appendChild(img);
  }
  const span = document.createElement('span');
  span.textContent = user.name || user.email;
  el.appendChild(span);
}

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  location.href = '/login.html';
}

// ---------- scanning ----------
async function startScan() {
  const btn = document.getElementById('scan-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  try {
    const res = await api('/api/scan', { method: 'POST' });
    if (res.status === 409) {
      toast('A scan is already running.');
    }
    beginPolling();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Scan network';
  }
}

function beginPolling() {
  document.getElementById('progress').hidden = false;
  clearInterval(state.polling);
  state.polling = setInterval(pollScan, 800);
  pollScan();
}

async function pollScan() {
  const data = await (await api('/api/scan')).json();
  updateProgress(data.progress, data.scanning);
  if (!data.scanning) {
    clearInterval(state.polling);
    document.getElementById('progress').hidden = true;
    const btn = document.getElementById('scan-btn');
    btn.disabled = false;
    btn.textContent = 'Scan network';
    if (data.result) renderScan(data.result);
  }
}

function updateProgress(p, scanning) {
  if (!p) return;
  const fill = document.getElementById('progress-fill');
  const text = document.getElementById('progress-text');
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  fill.style.width = pct + '%';
  const phase = p.phase === 'ping' ? 'Pinging hosts' : p.phase === 'probe' ? 'Probing devices' : 'Starting';
  text.textContent = `${phase} — ${p.done}/${p.total} (${p.cidr || ''})`;
}

function renderScan(result) {
  const meta = document.getElementById('scan-meta');
  if (result.error) {
    toast('Scan error: ' + result.error, true);
    meta.textContent = '';
    return;
  }
  state.devices = result.devices || [];
  meta.textContent = `${state.devices.length} devices · ${result.cidr} · ${new Date(
    result.scannedAt
  ).toLocaleTimeString()}`;

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
    ${d.hostname ? `<span title="hostname">${esc(d.hostname)}</span>` : ''}`;
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

  if (caps.includes('cast-volume')) {
    wrap.appendChild(volumeControl(d));
  }
  if (caps.includes('video-feed')) {
    wrap.appendChild(button('📹 Video feed', () => openCamera(d)));
  }
  if (caps.includes('open-web')) {
    const proto = d.openPorts.some((p) => p.name === 'https') ? 'https' : 'http';
    const port = d.openPorts.find((p) => p.name === 'http-alt') ? ':8080' : '';
    wrap.appendChild(
      button('🌐 Open web UI', () => window.open(`${proto}://${d.ip}${port}`, '_blank'))
    );
  }
  if (caps.includes('ssh-info')) {
    wrap.appendChild(button('🖥️ SSH', () => copyText(`ssh ${d.ip}`, 'SSH command copied')));
  }
  if (caps.includes('printer-info')) {
    wrap.appendChild(button('🖨️ Printer admin', () => window.open(`http://${d.ip}:631`, '_blank')));
  }
  if (caps.includes('airplay-info')) {
    wrap.appendChild(button('🎵 AirPlay', () => toast('AirPlay device — control from macOS/iOS.')));
  }
  return wrap;
}

function volumeControl(d) {
  const box = document.createElement('div');
  box.className = 'vol-control';

  const down = button('🔉', () => stepVolume(d, -0.1, label), 'btn-sm');
  const up = button('🔊', () => stepVolume(d, 0.1, label), 'btn-sm');
  const mute = button('🔇', () => muteDevice(d), 'btn-sm');

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.value = '50';
  slider.addEventListener('change', () => setVolume(d, slider.value / 100, label));

  const label = document.createElement('span');
  label.className = 'vol-label';
  label.textContent = '—';

  if (!state.castAvailable) {
    [down, up, mute].forEach((b) => (b.disabled = true));
    slider.disabled = true;
    label.textContent = 'n/a';
    box.title = 'Install castv2-client on the server to enable volume control.';
  }

  box.append(down, slider, up, mute, label);
  // Fetch current volume lazily.
  if (state.castAvailable) fetchVolume(d, slider, label);
  return box;
}

async function fetchVolume(d, slider, label) {
  try {
    const res = await api(`/api/devices/${d.ip}/volume`);
    const data = await res.json();
    if (data.volume && typeof data.volume.level === 'number') {
      slider.value = Math.round(data.volume.level * 100);
      label.textContent = slider.value + '%';
    }
  } catch (_) {
    /* device may be asleep */
  }
}

async function setVolume(d, level, label) {
  try {
    const res = await api(`/api/devices/${d.ip}/volume`, {
      method: 'POST',
      body: JSON.stringify({ level }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (label && data.volume) label.textContent = Math.round(data.volume.level * 100) + '%';
    toast(`Volume set to ${Math.round(level * 100)}%`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function stepVolume(d, step, label) {
  try {
    const res = await api(`/api/devices/${d.ip}/volume`, {
      method: 'POST',
      body: JSON.stringify({ step }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (label && data.volume) label.textContent = Math.round(data.volume.level * 100) + '%';
  } catch (e) {
    toast(e.message, true);
  }
}

async function muteDevice(d) {
  try {
    const res = await api(`/api/devices/${d.ip}/volume`, {
      method: 'POST',
      body: JSON.stringify({ muted: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast('Muted');
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- camera modal ----------
function wireCameraModal() {
  const modal = document.getElementById('camera-modal');
  modal.querySelectorAll('[data-close-modal]').forEach((b) =>
    b.addEventListener('click', closeCamera)
  );
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeCamera();
  });
  document.getElementById('cam-connect').addEventListener('click', connectCamera);
  document.getElementById('cam-live').addEventListener('change', (e) => {
    if (e.target.checked) startLive();
    else stopLive();
  });
}

function openCamera(d) {
  state.currentCamera = d;
  document.getElementById('camera-title').textContent = `Video feed — ${d.name}`;
  document.getElementById('cam-status').textContent = 'Not connected';
  document.getElementById('cam-img').removeAttribute('src');
  document.getElementById('cam-live').checked = false;
  // Sensible default stream paths per known vendor.
  const path = document.getElementById('cam-path');
  if (/hikvision/i.test(d.vendor || '')) path.value = '/Streaming/Channels/101';
  else if (/dahua|amcrest/i.test(d.vendor || '')) path.value = '/cam/realmonitor?channel=1&subtype=0';
  else path.value = path.value || '';
  document.getElementById('camera-modal').hidden = false;
}

function closeCamera() {
  stopLive();
  document.getElementById('camera-modal').hidden = true;
  state.currentCamera = null;
}

function snapshotUrl() {
  const d = state.currentCamera;
  const params = new URLSearchParams({
    username: document.getElementById('cam-user').value,
    password: document.getElementById('cam-pass').value,
    path: document.getElementById('cam-path').value,
    port: document.getElementById('cam-port').value,
    _: Date.now(),
  });
  return `/api/devices/${d.ip}/snapshot?${params.toString()}`;
}

function connectCamera() {
  const img = document.getElementById('cam-img');
  const status = document.getElementById('cam-status');
  status.textContent = 'Connecting…';
  img.onload = () => (status.textContent = '');
  img.onerror = () => (status.textContent = 'Could not fetch snapshot (check credentials / ffmpeg).');
  img.src = snapshotUrl();
}

function startLive() {
  stopLive();
  connectCamera();
  state.camLiveTimer = setInterval(connectCamera, 2000);
}
function stopLive() {
  clearInterval(state.camLiveTimer);
  state.camLiveTimer = null;
}

// ---------- small utils ----------
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
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

init();
