const NodeHelper = require("node_helper");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// CDP helper — lightweight HTTP GET for talking to the browser's debug endpoint
function cdpHttpGet(url) {
	return new Promise((resolve, reject) => {
		const req = http.get(url, (res) => {
			let body = "";
			res.on("data", d => body += d);
			res.on("end", () => resolve(body));
		});
		req.on("error", reject);
		req.setTimeout(5000, () => req.destroy(new Error("cdpHttpGet timeout")));
	});
}

module.exports = NodeHelper.create({

	start: function () {
		this.sessionKeyFile = path.join(__dirname, ".session.json");
		this.activeSessionKey = null;
		this.loadSavedKey();
	},

	loadSavedKey: function () {
		try {
			if (fs.existsSync(this.sessionKeyFile)) {
				const saved = JSON.parse(fs.readFileSync(this.sessionKeyFile, "utf8"));
				if (saved.sessionKey) {
					this.activeSessionKey = saved.sessionKey;
				}
			}
		} catch (e) { /* will fall back to config key */ }
	},

	saveKey: function (key) {
		try {
			fs.writeFileSync(this.sessionKeyFile, JSON.stringify({ sessionKey: key }), "utf8");
		} catch (e) {
			console.error("MMM-AnthropicUsage: could not save session key:", e.message);
		}
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "GET_ANTHROPIC_USAGE") {
			const key = this.activeSessionKey || payload.sessionKey;
			this.fetchData(payload.orgId, key, payload.sessionKey, payload.cdpPort);
		}
	},

	fetchData: async function (orgId, sessionKey, fallbackKey, cdpPort) {
		try {
			const apiUrl = `https://claude.ai/api/organizations/${orgId}/usage`;
			const { data, refreshedKey } = cdpPort
				? await this.apiGetViaCDP(apiUrl, sessionKey, cdpPort)
				: await this.apiGetDirect(apiUrl, sessionKey);

			if (refreshedKey && refreshedKey !== sessionKey) {
				this.activeSessionKey = refreshedKey;
				this.saveKey(refreshedKey);
			}

			this.sendSocketNotification("ANTHROPIC_USAGE_DATA", data);
		} catch (err) {
			if (this.activeSessionKey && this.activeSessionKey !== fallbackKey) {
				console.warn("MMM-AnthropicUsage: saved key failed, retrying with config key");
				this.activeSessionKey = null;
				return this.fetchData(orgId, fallbackKey, fallbackKey, cdpPort);
			}
			console.error("MMM-AnthropicUsage:", err.message);
			this.sendSocketNotification("ANTHROPIC_USAGE_ERROR", err.message || "Fetch failed");
		}
	},

	// ── Direct HTTPS mode ─────────────────────────────────────────────────────
	// Simple and works on most systems. May be blocked by Cloudflare on some
	// Raspberry Pi / Linux setups due to TLS fingerprinting. If you see 403
	// errors, switch to CDP mode (see README).
	apiGetDirect: function (apiUrl, sessionKey) {
		return new Promise((resolve, reject) => {
			const u = new URL(apiUrl);
			const options = {
				hostname: u.hostname,
				path: u.pathname + u.search,
				method: "GET",
				headers: {
					"Cookie": `sessionKey=${sessionKey}`,
					"Content-Type": "application/json",
					"anthropic-client-platform": "web_claude_ai",
					"User-Agent": "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
				},
			};

			const req = https.request(options, (res) => {
				let body = "";
				res.on("data", chunk => body += chunk);
				res.on("end", () => {
					const contentType = res.headers["content-type"] || "";
					if (res.statusCode === 403 || res.statusCode === 401 ||
						(!contentType.includes("json") && body.trim().startsWith("<"))) {
						reject(new Error(
							`Blocked by Cloudflare or session expired (HTTP ${res.statusCode}). ` +
							`Try setting cdpPort in config — see README.`
						));
						return;
					}
					try {
						const parsed = JSON.parse(body);
						if (res.statusCode >= 400) {
							reject(new Error(`HTTP ${res.statusCode}: ${parsed.error?.message || body}`));
							return;
						}
						let refreshedKey = null;
						const cookies = res.headers["set-cookie"] || [];
						for (const cookie of cookies) {
							const match = cookie.match(/^sessionKey=([^;]+)/);
							if (match) { refreshedKey = match[1]; break; }
						}
						resolve({ data: parsed, refreshedKey });
					} catch (e) {
						reject(new Error(`Failed to parse response (HTTP ${res.statusCode})`));
					}
				});
			});

			req.setTimeout(10000, () => req.destroy(new Error("Request timed out")));
			req.on("error", reject);
			req.end();
		});
	},

	// ── CDP mode ──────────────────────────────────────────────────────────────
	// Routes the fetch through the running Chromium/Electron browser via Chrome
	// DevTools Protocol. The real browser's TLS fingerprint passes Cloudflare
	// where a plain Node.js request would be blocked.
	//
	// Requirements:
	//   • Node.js 22+ (built-in global WebSocket)
	//   • Browser launched with --remote-debugging-port=<cdpPort>
	//     e.g. chromium-browser --remote-debugging-port=9222 ...
	//
	apiGetViaCDP: async function (apiUrl, sessionKey, cdpPort) {

		// Step 1: Get the browser-level WebSocket URL
		let versionData;
		try {
			versionData = JSON.parse(await cdpHttpGet(`http://localhost:${cdpPort}/json/version`));
		} catch (e) {
			throw new Error(
				`CDP: Chromium debugger not available on port ${cdpPort}. ` +
				`Add --remote-debugging-port=${cdpPort} to your browser launch flags.`
			);
		}
		const browserWsUrl = versionData.webSocketDebuggerUrl;
		if (!browserWsUrl) throw new Error("CDP: no webSocketDebuggerUrl in /json/version response");

		// Step 2: Connect browser WebSocket and create a background tab
		// background: true keeps the MagicMirror display tab in the foreground
		let targetId;
		{
			const ws = new WebSocket(browserWsUrl);
			let msgId = 1;
			const pending = new Map();

			await new Promise((res, rej) => {
				ws.addEventListener("open", res, { once: true });
				ws.addEventListener("error", () => rej(new Error("CDP: browser WebSocket connection failed")), { once: true });
			});

			ws.addEventListener("message", (ev) => {
				const msg = JSON.parse(ev.data);
				if (msg.id && pending.has(msg.id)) {
					const { resolve, reject } = pending.get(msg.id);
					pending.delete(msg.id);
					if (msg.error) reject(new Error(msg.error.message));
					else resolve(msg.result);
				}
			});

			const send = (method, params = {}) => new Promise((resolve, reject) => {
				const id = msgId++;
				pending.set(id, { resolve, reject });
				ws.send(JSON.stringify({ id, method, params }));
			});

			const result = await send("Target.createTarget", { url: "about:blank", background: true });
			targetId = result.targetId;
			ws.close();
		}

		// Step 3: Get the background tab's debugger WebSocket URL
		await new Promise(r => setTimeout(r, 400));
		const tabs = JSON.parse(await cdpHttpGet(`http://localhost:${cdpPort}/json`));
		const tab = tabs.find(t => t.id === targetId);
		if (!tab || !tab.webSocketDebuggerUrl) {
			cdpHttpGet(`http://localhost:${cdpPort}/json/close/${targetId}`).catch(() => {});
			throw new Error("CDP: could not find background tab debugger URL");
		}

		// Step 4: Connect to the tab and execute the fetch
		const tabWs = new WebSocket(tab.webSocketDebuggerUrl);
		let msgId = 1;
		const pending = new Map();
		const eventHandlers = new Map();

		await new Promise((res, rej) => {
			tabWs.addEventListener("open", res, { once: true });
			tabWs.addEventListener("error", () => rej(new Error("CDP: tab WebSocket connection failed")), { once: true });
		});

		tabWs.addEventListener("message", (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.id && pending.has(msg.id)) {
				const { resolve, reject } = pending.get(msg.id);
				pending.delete(msg.id);
				if (msg.error) reject(new Error(msg.error.message));
				else resolve(msg.result);
			}
			if (msg.method) {
				(eventHandlers.get(msg.method) || []).forEach(h => h(msg.params));
			}
		});

		const send = (method, params = {}) => new Promise((resolve, reject) => {
			const id = msgId++;
			pending.set(id, { resolve, reject });
			tabWs.send(JSON.stringify({ id, method, params }));
		});

		const on = (event, handler) => {
			if (!eventHandlers.has(event)) eventHandlers.set(event, []);
			eventHandlers.get(event).push(handler);
		};

		try {
			await send("Network.enable");
			await send("Page.enable");

			// Plant the session cookie so the browser sends it with the request
			await send("Network.setCookie", {
				name: "sessionKey",
				value: sessionKey,
				domain: ".claude.ai",
				path: "/",
				secure: true,
				httpOnly: false,
				sameSite: "Lax",
			});

			// Intercept the raw HTTP response body via network events.
			// This is more reliable than reading document.body.innerText because
			// it bypasses browser JSON viewer rendering.
			const bodyText = await new Promise((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("CDP: fetch timed out after 30s")), 30000
				);
				const requestMap = new Map(); // requestId → url

				on("Network.requestWillBeSent", (params) => {
					requestMap.set(params.requestId, params.request.url);
				});

				on("Network.loadingFinished", async (params) => {
					const reqUrl = requestMap.get(params.requestId) || "";
					if (!reqUrl.includes("/usage")) return;
					clearTimeout(timeout);
					try {
						const resp = await send("Network.getResponseBody", { requestId: params.requestId });
						const text = resp.base64Encoded
							? Buffer.from(resp.body, "base64").toString("utf8")
							: resp.body;
						resolve(text);
					} catch (e) {
						reject(e);
					}
				});

				on("Network.loadingFailed", (params) => {
					const reqUrl = requestMap.get(params.requestId) || "";
					if (!reqUrl.includes("/usage")) return;
					clearTimeout(timeout);
					reject(new Error(`CDP: network request failed: ${params.errorText}`));
				});

				// Listeners are registered before navigate so no events are missed
				send("Page.navigate", { url: apiUrl }).catch(reject);
			});

			const trimmed = bodyText.trim();
			if (!trimmed || trimmed.startsWith("<")) {
				throw new Error("Session expired or Cloudflare challenge — update sessionKey in config.js");
			}

			const parsed = JSON.parse(bodyText);
			if (parsed.error) {
				throw new Error(`API error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
			}

			return { data: parsed, refreshedKey: null };

		} finally {
			tabWs.close();
			// Close the background tab — fire and forget
			cdpHttpGet(`http://localhost:${cdpPort}/json/close/${targetId}`).catch(() => {});
		}
	},
});
