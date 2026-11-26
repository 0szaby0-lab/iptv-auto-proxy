# IPTV Proxy & Xtream Codes Manager

Xtream Codes proxy and credential manager for IPTV services (including iptvload.org). Proxies playlist (`get.php`), EPG (`xmltv.php`), and stream chunks so you use a single permanent username/password in your IPTV player (TiviMate, Smarters Pro, OTT Navigator, etc.).

## Features

- **Permanent Xtream Codes Endpoint**: Use one fixed username/password (`PROXY_USER` / `PROXY_PASS`) in your player. The proxy handles routing to upstream servers.
- **Web Control Panel (`/update`)**: Responsive web dashboard to inspect active credentials, paste new IPTV trials/accounts, and save instantly.
- **EPG Caching with Gzip**: Automated local caching and gzip streaming for lightning-fast TV guide loading.
- **Auto-Registration Toggle (`AUTO_REGISTER`)**: Background automated registration cycle is paused by default (`false`) to prevent datacenter IP blocking (Cloudflare Turnstile & 429 rate limits). Can be re-enabled whenever needed via environment variable or the web dashboard.

---

## Deploy on Render.com

1. Push or fork this repo to GitHub.
2. Go to [render.com](https://render.com) → **New** → **Web Service**.
3. Connect your repository.
4. Set Environment Variables:
   - `PROXY_USER` — your custom proxy username (e.g. `szaby`)
   - `PROXY_PASS` — your custom proxy password (e.g. `2002`)
   - `AUTO_REGISTER` — `false` (default: auto-cycle paused) or `true` (automated 22h cycle)
5. Deploy (Render builds the Docker container automatically).

---

## IPTV Player Setup

In your IPTV player (TiviMate, IPTV Smarters Pro, OTT Navigator, etc.):

| Field | Value |
|---|---|
| **Type** | Xtream Codes API |
| **Server URL** | `https://your-service.onrender.com` |
| **Username** | your `PROXY_USER` value (e.g. `szaby`) |
| **Password** | your `PROXY_PASS` value (e.g. `2002`) |

---

## Service Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/update` | `GET` | Web dashboard to view and update active IPTV credentials |
| `/update` | `POST` | Update active credentials via form submit or JSON (`username`, `password`, `servers`) |
| `/status` | `GET` | System health, active trial details, EPG cache status, cycle status (JSON) |
| `/logs` | `GET` | Live runtime console logs |
| `/trigger` | `GET` | Manually run a single background registration attempt |
| `/get.php` | `GET` | M3U / M3U_PLUS playlist proxy |
| `/xmltv.php` | `GET` | XMLTV EPG data proxy (supports gzip) |
| `/player_api.php`| `GET/POST` | Full Xtream Codes authentication, categories, and streams API |
| `/live/*`, `/movie/*`, `/series/*` | `GET` | Direct stream chunk proxy |

---

## Manual Credential Update

To set or renew your upstream IPTV credentials:
1. Open `https://your-service.onrender.com/update` in your browser.
2. Enter the new **Username** and **Password**.
3. Click **Fiókadatok Mentése**.

Or via curl / API:
```bash
curl -X POST "https://your-service.onrender.com/update" \
  -H "Content-Type: application/json" \
  -d '{"username":"e1234567","password":"mypassword","servers":["http://iptvload.org:8080"]}'
```

---

## Keep-Alive on Render Free Tier

Render free tier instances sleep after 15 minutes of inactivity. Use a free monitoring service like [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com) to ping `https://your-service.onrender.com/status` every 10–14 minutes.
