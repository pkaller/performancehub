'use strict';

const ASSETS = [
  { key: 'win', label: 'Windows', arch: 'x64', file: 'performancehub-agent-win-x64.exe', icon: '🪟' },
  { key: 'macos-arm', label: 'macOS (Apple Silicon)', arch: 'arm64', file: 'performancehub-agent-macos-arm64', icon: '🍎' },
  { key: 'macos-x64', label: 'macOS (Intel)', arch: 'x64', file: 'performancehub-agent-macos-x64', icon: '🍎' },
  { key: 'linux', label: 'Linux', arch: 'x64', file: 'performancehub-agent-linux-x64', icon: '🐧' },
];

function detectOs() {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const ua = navigator.userAgent;
  if (/Win/i.test(p) || /Windows/i.test(ua)) return 'win';
  if (/Mac/i.test(p) || /Mac OS X/i.test(ua)) {
    // Best-effort Apple Silicon guess.
    return /arm|apple/i.test(ua) ? 'macos-arm' : 'macos-x64';
  }
  if (/Linux/i.test(p) || /Linux/i.test(ua)) return 'linux';
  return 'linux';
}

async function init() {
  let repo = 'pkaller/performancehub';
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (cfg.repo) repo = cfg.repo;
  } catch (_) {}

  const releaseBase = `https://github.com/${repo}/releases/latest/download`;
  document.getElementById('repo-link').href = `https://github.com/${repo}/tree/main/agent`;

  const detected = detectOs();
  const primary = ASSETS.find((a) => a.key === detected) || ASSETS[0];

  const primaryEl = document.getElementById('primary-download');
  primaryEl.innerHTML = `
    <a class="btn btn-primary btn-lg" href="${releaseBase}/${primary.file}" download>
      ${primary.icon} Download for ${primary.label}
    </a>
    <div class="hint">Detected your OS automatically. Other builds below.</div>`;

  const grid = document.getElementById('download-grid');
  grid.innerHTML = ASSETS.map(
    (a) => `
    <a class="download-card${a.key === primary.key ? ' active' : ''}" href="${releaseBase}/${a.file}" download>
      <span class="dl-icon">${a.icon}</span>
      <span class="dl-label">${a.label}</span>
      <span class="dl-arch">${a.arch}</span>
    </a>`
  ).join('');

  // Tailor the run command to the OS and this site's URL.
  const cmd = document.getElementById('run-cmd');
  const origin = location.origin;
  if (primary.key === 'win') {
    cmd.textContent = `${primary.file} --server ${origin} --pair XXXX-XXXX`;
  } else {
    cmd.textContent = `chmod +x ${primary.file} && ./${primary.file} --server ${origin} --pair XXXX-XXXX`;
  }
}

init();
