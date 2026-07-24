'use strict';

const { spawn } = require('child_process');

// Lazily load the optional Cast client so the app runs even if it isn't installed.
let CastClient = null;
function getCastClient() {
  if (CastClient === null) {
    try {
      CastClient = require('castv2-client').Client;
    } catch (_) {
      CastClient = false;
    }
  }
  return CastClient;
}

// ---------------------------------------------------------------------------
// Google Cast volume / status
// ---------------------------------------------------------------------------

function withCast(host, fn) {
  return new Promise((resolve, reject) => {
    const Client = getCastClient();
    if (!Client) {
      return reject(
        new Error(
          'Cast control needs the optional "castv2-client" package. Run: npm install castv2-client'
        )
      );
    }
    const client = new Client();
    const cleanup = () => {
      try {
        client.close();
      } catch (_) {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out talking to Cast device at ${host}`));
    }, 6000);

    client.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    client.connect(host, () => {
      fn(client, (err, result) => {
        clearTimeout(timer);
        cleanup();
        if (err) reject(err);
        else resolve(result);
      });
    });
  });
}

function getCastVolume(host) {
  return withCast(host, (client, done) => {
    client.getVolume((err, volume) => done(err, volume));
  });
}

function setCastVolume(host, level) {
  const clamped = Math.max(0, Math.min(1, level));
  return withCast(host, (client, done) => {
    client.setVolume({ level: clamped }, (err, volume) => done(err, volume));
  });
}

function setCastMuted(host, muted) {
  return withCast(host, (client, done) => {
    client.setVolume({ muted: !!muted }, (err, volume) => done(err, volume));
  });
}

// step is a signed delta, e.g. +0.1 or -0.1
async function stepCastVolume(host, step) {
  const current = await getCastVolume(host);
  const level = (current && typeof current.level === 'number' ? current.level : 0.5) + step;
  return setCastVolume(host, level);
}

// ---------------------------------------------------------------------------
// Camera video feed (RTSP snapshot via ffmpeg, if available)
// ---------------------------------------------------------------------------

// Builds a best-effort RTSP URL for a camera. Many cameras require credentials
// and a vendor-specific path, so we let the caller pass them in.
function buildRtspUrl({ ip, username, password, path, port }) {
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : '';
  const p = path || '/'; // e.g. /Streaming/Channels/101 (Hikvision), /cam/realmonitor (Dahua)
  const rp = port || 554;
  return `rtsp://${auth}${ip}:${rp}${p.startsWith('/') ? '' : '/'}${p}`;
}

// Grabs a single JPEG frame from an RTSP stream and returns it as a Buffer.
// Requires ffmpeg on PATH. Rejects with a helpful message otherwise.
function captureSnapshot(rtspUrl) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-frames:v', '1',
      '-q:v', '3',
      '-f', 'image2',
      'pipe:1',
    ]);

    const chunks = [];
    let stderr = '';
    let done = false;
    const finish = (err, buf) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(buf);
    };

    ff.on('error', (err) => {
      if (err.code === 'ENOENT') {
        finish(new Error('ffmpeg is not installed on the agent machine. Install ffmpeg to view camera snapshots.'));
      } else {
        finish(err);
      }
    });
    ff.stderr.on('data', (d) => (stderr += d.toString()));
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (buf.length > 0) return finish(null, buf);
      finish(new Error(`ffmpeg produced no image (code ${code}). ${stderr.split('\n').slice(-3).join(' ').trim()}`));
    });

    const timer = setTimeout(() => {
      try {
        ff.kill('SIGKILL');
      } catch (_) {}
      finish(new Error('Snapshot timed out (camera unreachable or wrong credentials/path).'));
    }, 15000);
    timer.unref();
  });
}

module.exports = {
  getCastVolume,
  setCastVolume,
  setCastMuted,
  stepCastVolume,
  buildRtspUrl,
  captureSnapshot,
  castAvailable: () => !!getCastClient(),
};
