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

// Grabs a single JPEG frame from an RTSP stream and pipes it to `res`.
// Requires ffmpeg on PATH. Returns true if it started, throws otherwise.
function streamSnapshot(rtspUrl, res) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-frames:v', '1',
      '-q:v', '3',
      '-f', 'image2',
      'pipe:1',
    ]);

    let started = false;
    let stderr = '';

    ff.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('ffmpeg is not installed. Install ffmpeg to view camera snapshots.'));
      } else {
        reject(err);
      }
    });

    ff.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    ff.stdout.once('data', () => {
      if (!started) {
        started = true;
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store');
      }
    });

    ff.stdout.pipe(res);

    ff.on('close', (code) => {
      if (!started && code !== 0) {
        reject(new Error(`ffmpeg failed (code ${code}). ${stderr.split('\n').slice(-4).join(' ')}`));
      } else {
        resolve(true);
      }
    });

    // Safety timeout.
    setTimeout(() => {
      try {
        ff.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
    }, 15000);
  });
}

module.exports = {
  getCastVolume,
  setCastVolume,
  setCastMuted,
  stepCastVolume,
  buildRtspUrl,
  streamSnapshot,
  castAvailable: () => !!getCastClient(),
};
