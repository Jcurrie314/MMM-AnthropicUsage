# MMM-AnthropicUsage

A [MagicMirror²](https://github.com/MichMich/MagicMirror) module that displays your [Claude.ai](https://claude.ai) Pro plan usage — current session, weekly limits, and extra credit spend — with animated progress bars.

![screenshot placeholder](screenshot.png)

## Features

- **Session usage** — current 5-hour rolling window utilization and time until reset
- **Weekly usage** — 7-day rolling window utilization and time until reset
- **Extra credits** — spend vs. monthly limit (shown only when enabled on your account)
- **Two fetch modes** — direct HTTPS (simple) or Chrome DevTools Protocol (bypasses Cloudflare)
- **Configurable colors** — bar, track, warn, and over-limit colors all customizable

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/Jcurrie314/MMM-AnthropicUsage
```

No npm dependencies — uses only Node.js built-ins.

## Getting your credentials

You need two values from your browser while logged into claude.ai:

**`orgId`** — your organization ID  
**`sessionKey`** — your session cookie

1. Open [claude.ai](https://claude.ai) and log in
2. Open DevTools → Network tab
3. Navigate to **Settings → Usage** (or any page that loads)
4. Find a request to `claude.ai/api/organizations/...` and copy the org ID from the URL
5. In the request headers, find the `Cookie` header and copy the value of `sessionKey=...`

## Configuration

Add to your `config/config.js`:

```javascript
{
    module: "MMM-AnthropicUsage",
    position: "bottom_left",
    header: "Claude",
    config: {
        sessionKey: "YOUR_SESSION_KEY",
        orgId: "YOUR_ORG_ID",
    }
}
```

### All options

| Option | Default | Description |
|--------|---------|-------------|
| `sessionKey` | `null` | **Required.** Your claude.ai session cookie value |
| `orgId` | `null` | **Required.** Your claude.ai organization ID |
| `updateInterval` | `120` | Seconds between data refreshes |
| `initialLoadDelay` | `0` | Seconds to wait before first fetch |
| `animationSpeed` | `0` | DOM update animation speed in ms |
| `fontSize` | `"small"` | Font size: `x-small`, `small`, `medium`, `large`, `x-large` |
| `showExtra` | `false` | Show the extra credits row (for accounts with usage-based billing enabled) |
| `barColor` | `"#4a90e2"` | Progress bar fill color |
| `trackColor` | `"#1a2a3a"` | Progress bar track (background) color |
| `warnColor` | `"#e2a94a"` | Bar color when usage ≥ 80% |
| `overColor` | `"#cc3318"` | Bar color when usage = 100% |
| `cdpPort` | `null` | CDP port for Cloudflare bypass — see below |

## Cloudflare bypass (CDP mode)

Cloudflare blocks plain Node.js HTTPS requests to `claude.ai` on some systems (common on Raspberry Pi) due to TLS fingerprinting. If you see errors like `Blocked by Cloudflare or session expired (HTTP 403)`, enable CDP mode.

CDP mode routes the API fetch through your **already-running Chromium browser** via [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/). The real browser's TLS fingerprint passes Cloudflare where a Node.js request would be blocked. A hidden background tab is opened for the fetch and closed immediately — the MagicMirror display tab is not affected.

### Requirements for CDP mode

- **Node.js 22+** (built-in global `WebSocket`, stable since v22.4.0)
- **Chromium launched with** `--remote-debugging-port=9222`

### Setup

**1. Add the debugging port to your Chromium launch command:**

```bash
chromium-browser \
  --kiosk \
  --remote-debugging-port=9222 \
  http://localhost:8080
```

If you use a startup script (e.g. in `~/.config/lxsession/LXDE-pi/autostart`), add the flag there.

**2. Enable CDP mode in your config:**

```javascript
{
    module: "MMM-AnthropicUsage",
    position: "bottom_left",
    header: "Claude",
    config: {
        sessionKey: "YOUR_SESSION_KEY",
        orgId: "YOUR_ORG_ID",
        cdpPort: 9222,
    }
}
```

That's it. The module will now route all fetches through Chromium.

### Electron users

If you run MagicMirror with Electron (the default), you can expose a CDP port by adding `--remote-debugging-port=9222` to `electronOptions` in your `config.js`:

```javascript
var config = {
    electronOptions: {
        webPreferences: {
            additionalArguments: ["--remote-debugging-port=9222"],
        },
    },
    // ... rest of config
};
```

Then set `cdpPort: 9222` in the module config.

## How it works

The module calls the internal claude.ai usage API (`/api/organizations/{orgId}/usage`) using your session cookie for authentication.

- **Direct mode** (default): Node.js makes a standard HTTPS request with the session cookie in the `Cookie` header. Simple, but may be blocked by Cloudflare on some systems.
- **CDP mode** (`cdpPort` set): The module connects to the running Chromium/Electron instance via WebSocket, creates a hidden background tab, sets the session cookie, navigates to the API URL, and reads the raw HTTP response body. No screen flicker — the MagicMirror tab stays focused.

## License

MIT
