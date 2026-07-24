# PerformanceHub

A **real, hosted website** where you sign in with Google and see & control every
device on your home network — from anywhere. The website offers a **downloadable
local agent** (prebuilt binary, no Node.js needed) that runs on your LAN, does
the scanning, and relays to your browser over a secure outbound connection.

```
Your browser (anywhere) ──HTTPS/WSS──►  Cloud website (Render)  ◄──WSS── Local agent (your LAN) ──► your devices
                            Google login        relay                   scan · volume · cameras
```

Why an agent? A website can't reach inside your home network — browsers and
cloud servers have no route to your LAN. The agent runs where your devices are
and **dials out** to the site, so there are no router ports to open.

## Repo layout

```
cloud/    The hosted website: Google OAuth, landing/download/dashboard pages,
          and the WebSocket relay that connects browsers to agents. Deploys to Render.
agent/    The local agent: LAN scanner (ping/ARP/mDNS/port-probe), Google Cast
          volume control, RTSP camera snapshots. Built into standalone binaries.
.github/workflows/release-agent.yml
          CI that builds agent binaries (Win/macOS/Linux) and attaches them to
          GitHub Releases — the website's Download page links straight to them.
render.yaml
          One-click-ish Render Blueprint for the cloud site.
```

## Deploy the website (Render)

1. **Google OAuth credentials** — at
   [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
   create an **OAuth client ID → Web application**. You'll add the redirect URI
   after you know your Render URL (step 3).
2. **Render** — [dashboard.render.com](https://dashboard.render.com) → **New →
   Blueprint** → connect this repo. Render reads `render.yaml` and creates the
   service.
3. Note your URL (e.g. `https://performancehub.onrender.com`), then set the
   remaining env vars in the Render dashboard:
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `ALLOWED_EMAILS` — comma-separated Google accounts allowed to sign in.
     **Set this**; it's what stops strangers from controlling your LAN.
   - `BASE_URL` — your full Render URL.
4. Back in Google Console, add the redirect URI:
   `https://YOUR-APP.onrender.com/auth/google/callback`
5. Redeploy. Your site is live.

> Free-tier note: Render free services sleep after idle. First load takes ~30s
> to wake, and the agent auto-reconnects when it does. Paid tier removes this.

## Publish agent binaries

Tag a release — CI builds Windows/macOS(x64+arm64)/Linux binaries with
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) and attaches them:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

The site's **Download** page auto-detects the visitor's OS and links to
`releases/latest` assets. (You can also trigger the workflow manually from the
Actions tab.)

## Use it

1. Open your site → **Sign in with Google**.
2. Dashboard shows "No agent" → click **Pair a new agent** → you get a code like
   `K7PM-Q2XW` (valid 10 min, single use).
3. On a machine on your home network, run the downloaded binary:
   ```bash
   ./performancehub-agent --server https://YOUR-APP.onrender.com --pair K7PM-Q2XW
   ```
4. The agent pairs, stores a durable token in `~/.performancehub/agent.json`,
   and from then on just run it with no arguments (or install it as a
   service/startup item). The dashboard flips to **agent online**.
5. Click **Scan network** — devices appear with live progress, and each shows
   the actions it supports.

## Actions per device

| Action | Shown for | Notes |
| --- | --- | --- |
| Volume slider / up / down / mute | Google Cast speakers, Chromecasts, Google/Nest speakers | works out of the box |
| Video feed (snapshot + auto-refresh live view) | IP cameras (RTSP / known camera vendors) | needs `ffmpeg` on the agent machine + camera credentials |
| Open web UI | anything serving HTTP/HTTPS | opens the device's own page |
| SSH | hosts with port 22 | copies an ssh command |
| Printer admin | IPP printers | opens the printer's admin page |

Actions are capability-gated: a device only shows what the scan proved it
supports.

## Security model

- **Login**: Google OAuth; only `ALLOWED_EMAILS` accounts get in (enforced
  server-side).
- **Pairing**: one-time, short-lived codes bind an agent to *your* account; the
  agent then holds an HMAC-signed token. Tokens are stateless, so the relay
  needs no database and survives redeploys.
- **Isolation**: the relay routes messages strictly within one user's account —
  your browser can only ever reach *your* agents.
- **No inbound exposure**: the agent only dials out (WSS). No port forwarding,
  no holes in your firewall.
- **Camera credentials** are sent per-request from your browser through the
  relay to the agent and are not stored anywhere.

## Local development

```bash
# Terminal 1 — the cloud site
cd cloud && npm install
cp ../.env.example .env   # fill in Google credentials; BASE_URL=http://localhost:3000
npm start

# Terminal 2 — the agent (from source; binaries are for end users)
cd agent && npm install
node agent.js --server http://localhost:3000 --pair CODE-FROM-DASHBOARD
```

## Troubleshooting

- **"redirect_uri_mismatch"** — the URI in Google Console must exactly match
  `BASE_URL` + `/auth/google/callback`.
- **Agent says pairing code invalid** — codes expire in 10 min and are single
  use; generate a fresh one.
- **Scan finds little** — the agent machine may need elevated privileges for
  ping/ARP on some OSes; sleeping devices don't respond. Set `SCAN_CIDR`
  (env var on the agent) to force a range.
- **macOS blocks the binary** — System Settings → Privacy & Security → *Open
  anyway* (binaries are unsigned).
- **Windows SmartScreen** — "More info → Run anyway".
