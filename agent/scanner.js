'use strict';

const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const { vendorForMac } = require('./oui');

let Bonjour = null;
try {
  Bonjour = require('bonjour-service').Bonjour;
} catch (_) {
  // mDNS discovery is optional; scanning still works without it.
}

const PLATFORM = os.platform(); // 'linux' | 'darwin' | 'win32'

// Ports we probe to infer what a device is and what we can do with it.
const PROBE_PORTS = [
  { port: 22, name: 'ssh' },
  { port: 80, name: 'http' },
  { port: 443, name: 'https' },
  { port: 554, name: 'rtsp' }, // IP cameras
  { port: 631, name: 'ipp' }, // printers
  { port: 8009, name: 'googlecast' }, // Chromecast / Google speakers
  { port: 8080, name: 'http-alt' },
  { port: 32400, name: 'plex' },
];

// ---------------------------------------------------------------------------
// Subnet detection
// ---------------------------------------------------------------------------

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + (parseInt(oct, 10) & 255), 0) >>> 0;
}
function intToIp(int) {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}
function prefixToMask(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}
function maskToPrefix(mask) {
  let bits = 0;
  let m = ipToInt(mask);
  while (m & 0x80000000) {
    bits++;
    m = (m << 1) >>> 0;
  }
  return bits;
}

// Returns { cidr, network, prefix, hosts: [ip, ...] } for the LAN to scan.
function resolveTargetNetwork() {
  const override = (process.env.SCAN_CIDR || '').trim();
  let baseIp;
  let prefix;

  if (override && override.includes('/')) {
    const [ip, p] = override.split('/');
    baseIp = ip.trim();
    prefix = parseInt(p, 10);
  } else {
    const iface = pickPrimaryInterface();
    if (!iface) return null;
    baseIp = iface.address;
    prefix = maskToPrefix(iface.netmask);
  }

  // Guard against scanning an enormous range. Clamp anything wider than /16.
  if (prefix < 16) prefix = 24;

  const mask = prefixToMask(prefix);
  const network = (ipToInt(baseIp) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  const hosts = [];
  for (let addr = network + 1; addr < broadcast; addr++) {
    hosts.push(intToIp(addr));
  }
  return { cidr: `${intToIp(network)}/${prefix}`, network: intToIp(network), prefix, hosts };
}

function pickPrimaryInterface() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        candidates.push({ name, address: a.address, netmask: a.netmask });
      }
    }
  }
  // Prefer common LAN ranges.
  candidates.sort((x, y) => rankIface(y) - rankIface(x));
  return candidates[0] || null;
}
function rankIface(i) {
  if (i.address.startsWith('192.168.')) return 3;
  if (i.address.startsWith('10.')) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(i.address)) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Ping sweep (populates the OS ARP cache and confirms who is alive)
// ---------------------------------------------------------------------------

function pingHost(ip) {
  return new Promise((resolve) => {
    let cmd, args;
    if (PLATFORM === 'win32') {
      cmd = 'ping';
      args = ['-n', '1', '-w', '1000', ip];
    } else if (PLATFORM === 'darwin') {
      cmd = 'ping';
      args = ['-c', '1', '-t', '1', ip];
    } else {
      cmd = 'ping';
      args = ['-c', '1', '-W', '1', ip];
    }
    execFile(cmd, args, { timeout: 2500 }, (err) => resolve(!err));
  });
}

async function runInPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let index = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// ARP table parsing (IP -> MAC)
// ---------------------------------------------------------------------------

function readArpTable() {
  return new Promise((resolve) => {
    const args = PLATFORM === 'win32' ? ['-a'] : ['-a', '-n'];
    execFile('arp', args, { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve({});
      resolve(parseArp(stdout));
    });
  });
}

function parseArp(text) {
  const map = {};
  const ipRe = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;
  const macRe = /(([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2})/i;
  for (const line of text.split('\n')) {
    const ipMatch = line.match(ipRe);
    const macMatch = line.match(macRe);
    if (ipMatch && macMatch) {
      const mac = macMatch[1].toLowerCase().replace(/-/g, ':');
      const stripped = mac.replace(/[:0f]/g, '');
      // Skip all-zero and broadcast (all-f) entries.
      if (stripped !== '' ) {
        map[ipMatch[1]] = mac;
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Port probing
// ---------------------------------------------------------------------------

function probePort(ip, port, timeout = 900) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, ip);
  });
}

async function scanPorts(ip) {
  const open = [];
  await Promise.all(
    PROBE_PORTS.map(async (p) => {
      if (await probePort(ip, p.port)) open.push(p);
    })
  );
  return open;
}

// ---------------------------------------------------------------------------
// mDNS / Bonjour discovery (friendly names + service types)
// ---------------------------------------------------------------------------

function discoverMdns(seconds) {
  return new Promise((resolve) => {
    if (!Bonjour) return resolve({});
    const byIp = {};
    let bonjour;
    try {
      bonjour = new Bonjour();
    } catch (_) {
      return resolve({});
    }
    const types = ['googlecast', 'airplay', 'raop', 'spotify-connect', 'http', 'ipp', 'homekit'];
    const browsers = types.map((type) =>
      bonjour.find({ type }, (service) => {
        const addrs = (service.addresses || []).filter((a) => net.isIPv4(a));
        for (const ip of addrs) {
          if (!byIp[ip]) byIp[ip] = { names: new Set(), services: new Set() };
          if (service.name) byIp[ip].names.add(service.name);
          if (service.type) byIp[ip].services.add(service.type);
        }
      })
    );
    setTimeout(() => {
      try {
        browsers.forEach((b) => b && b.stop && b.stop());
        bonjour.destroy();
      } catch (_) {
        /* ignore */
      }
      const out = {};
      for (const [ip, v] of Object.entries(byIp)) {
        out[ip] = { names: [...v.names], services: [...v.services] };
      }
      resolve(out);
    }, Math.max(1000, seconds * 1000));
  });
}

// ---------------------------------------------------------------------------
// Capability inference
// ---------------------------------------------------------------------------

function inferDevice(device) {
  const portNames = new Set(device.openPorts.map((p) => p.name));
  const services = new Set(device.mdnsServices || []);
  const capabilities = [];

  const hasCast = portNames.has('googlecast') || services.has('googlecast');
  const hasRtsp = portNames.has('rtsp');
  const hasWeb = portNames.has('http') || portNames.has('https') || portNames.has('http-alt');
  const isCameraVendor = /hikvision|dahua|reolink|amcrest|wyze/i.test(device.vendor || '');
  const isAirplay = services.has('airplay') || services.has('raop');

  if (hasCast) {
    capabilities.push('cast-volume', 'cast-status', 'cast-mute');
  }
  if (hasRtsp || isCameraVendor) {
    capabilities.push('video-feed');
  }
  if (isAirplay && !hasCast) {
    capabilities.push('airplay-info');
  }
  if (hasWeb) {
    capabilities.push('open-web');
  }
  if (portNames.has('ssh')) {
    capabilities.push('ssh-info');
  }
  if (portNames.has('ipp')) {
    capabilities.push('printer-info');
  }

  // Human-friendly type guess.
  let type = 'Unknown device';
  if (hasCast) type = 'Cast / Speaker (Google)';
  else if (isAirplay) type = 'AirPlay device';
  else if (hasRtsp || isCameraVendor) type = 'IP Camera';
  else if (portNames.has('plex')) type = 'Plex media server';
  else if (portNames.has('ipp')) type = 'Printer';
  else if (portNames.has('ssh') && !hasWeb) type = 'Server / SSH host';
  else if (hasWeb) type = 'Web-enabled device';

  return { type, capabilities };
}

// ---------------------------------------------------------------------------
// Full scan
// ---------------------------------------------------------------------------

async function scanNetwork(options = {}) {
  const onProgress = options.onProgress || (() => {});
  const target = resolveTargetNetwork();
  if (!target) {
    throw new Error('Could not determine a local network to scan.');
  }

  const mdnsSeconds = parseInt(process.env.MDNS_SECONDS || '4', 10);

  onProgress({ phase: 'ping', total: target.hosts.length, done: 0, cidr: target.cidr });

  // Kick off mDNS discovery in parallel with the ping sweep.
  const mdnsPromise = discoverMdns(mdnsSeconds);

  let pinged = 0;
  const aliveFlags = await runInPool(
    target.hosts,
    async (ip) => {
      const alive = await pingHost(ip);
      pinged++;
      if (pinged % 16 === 0 || pinged === target.hosts.length) {
        onProgress({ phase: 'ping', total: target.hosts.length, done: pinged, cidr: target.cidr });
      }
      return alive;
    },
    64
  );

  const arp = await readArpTable();
  const mdns = await mdnsPromise;

  // A host counts as present if it replied to ping OR appears in ARP/mDNS.
  const present = new Set();
  target.hosts.forEach((ip, i) => {
    if (aliveFlags[i]) present.add(ip);
  });
  Object.keys(arp).forEach((ip) => present.add(ip));
  Object.keys(mdns).forEach((ip) => present.add(ip));

  const ips = [...present].sort((a, b) => ipToInt(a) - ipToInt(b));
  onProgress({ phase: 'probe', total: ips.length, done: 0, cidr: target.cidr });

  let probed = 0;
  const devices = await runInPool(
    ips,
    async (ip) => {
      const [openPorts, hostname] = await Promise.all([scanPorts(ip), reverseDns(ip)]);
      const mac = arp[ip] || null;
      const vendor = vendorForMac(mac);
      const m = mdns[ip] || { names: [], services: [] };

      const base = {
        ip,
        mac,
        vendor,
        hostname,
        mdnsName: m.names[0] || null,
        mdnsNames: m.names,
        mdnsServices: m.services,
        openPorts,
      };
      const inferred = inferDevice(base);

      probed++;
      onProgress({ phase: 'probe', total: ips.length, done: probed, cidr: target.cidr });

      return {
        ...base,
        type: inferred.type,
        capabilities: inferred.capabilities,
        name:
          base.mdnsName ||
          base.hostname ||
          (vendor ? `${vendor} device` : `Device ${ip}`),
      };
    },
    32
  );

  return {
    cidr: target.cidr,
    scannedAt: new Date().toISOString(),
    count: devices.length,
    devices,
  };
}

async function reverseDns(ip) {
  try {
    const names = await dns.reverse(ip);
    return names && names[0] ? names[0] : null;
  } catch (_) {
    return null;
  }
}

module.exports = { scanNetwork, resolveTargetNetwork };
