# PerformanceHub

A small self-hosted web app that logs you in with **Google**, **scans your local
network** for devices, lists them, and exposes **actions** per device — adjust
volume on Google Cast speakers, view an IP camera's video feed, open a device's
web UI, and more.

## How it works (and an important limitation)

A web page in a browser **cannot** scan your local network — browsers block raw
ping/ARP/port access for security, and a site hosted in the cloud has no route
into your home LAN anyway. So PerformanceHub ships as a **tiny local server** you
run on a machine that's on your network (your laptop, a Raspberry Pi, a NAS…).

- The **Node.js backend** does the scanning and talks to devices.
- The backend serves a **web UI** you open in a browser and sign into with Google.
- Because the backend is on your LAN, it can actually see and control your devices.

```
Browser (you)  ──Google login──►  PerformanceHub backend (on your LAN)  ──►  Devices
```

## Requirements

- **Node.js 18+**
- A **Google OAuth client** (free — steps below)
- Optional: **`castv2-client`** npm package for Google Cast volume control (`npm install castv2-client`)
- Optional: **`ffmpeg`** on your PATH for IP-camera snapshots

## Setup

### 1. Install

```bash
npm install
```

### 2. Create Google OAuth credentials

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. Create (or pick) a project → **Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Under **Authorized redirect URIs**, add:
   `http://localhost:3000/auth/google/callback`
5. Copy the **Client ID** and **Client secret**.

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from step 2.
- `ALLOWED_EMAILS` — comma-separated Google accounts allowed in. **Set this** —
  otherwise anyone with a Google account can reach the controls for your LAN.
- `SESSION_SECRET` — any long random string.
- `SCAN_CIDR` — optional; leave blank to auto-detect (e.g. `192.168.1.0/24`).

### 4. Run

```bash
npm start
```

Open <http://localhost:3000>, sign in with Google, and click **Scan network**.

## What the scanner finds

For each host it discovers via **ping sweep + ARP + reverse-DNS + mDNS/Bonjour +
port probing**, you get:

- IP, MAC, and a best-effort **vendor** (from the MAC prefix)
- Hostname / mDNS friendly name
- Open service ports (SSH, HTTP/S, RTSP, Google Cast, IPP, Plex…)
- An inferred **device type** and matching **actions**

## Actions & what they need

| Action | Shown for | Requires |
| --- | --- | --- |
| **Volume up/down/mute/slider** | Google Cast / Google speakers (port 8009 or `_googlecast._tcp`) | opt-in: `npm install castv2-client` |
| **Video feed** | IP cameras (RTSP port 554, or known camera vendor) | `ffmpeg` on PATH + camera credentials/stream path |
| **Open web UI** | Anything serving HTTP/HTTPS | — |
| **SSH** | Hosts with port 22 | copies an `ssh` command |
| **Printer admin** | IPP printers (port 631) | — |

Volume control targets **Google Cast** devices specifically — that's the natural
pairing with Google sign-in and works without any device-side setup. Camera feeds
work over standard **RTSP**; most cameras need a username/password and a
vendor-specific stream path (the UI pre-fills common ones for Hikvision/Dahua).

Actions are **capability-gated**: a device only shows the controls it actually
supports based on what the scan detected. A device that exposes no recognized
service simply lists its details with no action buttons.

## Security notes

- The dashboard and all `/api/*` routes require a signed-in, allow-listed Google
  account. The allow-list is enforced server-side in `server/auth.js`.
- Session cookies are `httpOnly` + `sameSite=lax`. If you expose this beyond
  `localhost`, put it behind HTTPS and set the cookie `secure` flag in
  `server/index.js`.
- Camera credentials are passed per-request and never stored on disk.
- Keep this on your trusted LAN. It is a personal tool, not a hardened
  multi-tenant service.

## Project layout

```
server/
  index.js     Express app, session, API routes
  auth.js      Google OAuth (passport) + allow-list + guards
  scanner.js   Ping sweep, ARP, reverse-DNS, mDNS, port probing, inference
  devices.js   Cast volume control + RTSP snapshot via ffmpeg
  oui.js       Offline MAC-prefix → vendor lookup
public/
  login.html   Google sign-in page
  index.html   Device dashboard
  js/app.js     Frontend logic
  css/styles.css
```

## Troubleshooting

- **"Scan finds nothing / few devices"** — some OSes need elevated privileges for
  `ping`/`arp`, and some devices ignore ping. Try running with more permissions,
  or set `SCAN_CIDR` explicitly. Devices asleep may not respond.
- **Volume control says it needs castv2-client** — run `npm install castv2-client`.
- **Camera snapshot fails** — install `ffmpeg`, and double-check the username,
  password, and stream path for your camera model.
- **Google login loops / "redirect_uri_mismatch"** — the redirect URI in Google
  Console must exactly match `BASE_URL` + `/auth/google/callback`.
