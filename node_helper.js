const NodeHelper = require("node_helper");
const https = require("https");
const fs = require("fs");
const path = require("path");

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
			this.fetchData(payload.orgId, key, payload.sessionKey);
		}
	},

	fetchData: async function (orgId, sessionKey, fallbackKey) {
		try {
			const url = `https://claude.ai/api/organizations/${orgId}/usage`;
			const { data, refreshedKey } = await this.apiGet(url, sessionKey);

			if (refreshedKey && refreshedKey !== sessionKey) {
				this.activeSessionKey = refreshedKey;
				this.saveKey(refreshedKey);
			}

			this.sendSocketNotification("ANTHROPIC_USAGE_DATA", data);
		} catch (err) {
			if (this.activeSessionKey && this.activeSessionKey !== fallbackKey) {
				console.warn("MMM-AnthropicUsage: saved key failed, retrying with config key");
				this.activeSessionKey = null;
				return this.fetchData(orgId, fallbackKey, fallbackKey);
			}
			console.error("MMM-AnthropicUsage:", err.message);
			this.sendSocketNotification("ANTHROPIC_USAGE_ERROR", err.message || "Fetch failed");
		}
	},

	apiGet: function (url, sessionKey) {
		return new Promise((resolve, reject) => {
			const u = new URL(url);
			const options = {
				hostname: u.hostname,
				path: u.pathname + u.search,
				method: "GET",
				headers: {
					"Cookie": `sessionKey=${sessionKey}`,
					"Content-Type": "application/json",
					"anthropic-client-platform": "web_claude_ai",
					"User-Agent": "Mozilla/5.0 (compatible; MagicMirror)",
				},
			};

			const req = https.request(options, (res) => {
				let body = "";
				res.on("data", chunk => body += chunk);
				res.on("end", () => {
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
						reject(new Error("Failed to parse response"));
					}
				});
			});

			req.setTimeout(10000, () => {
				req.destroy(new Error("Request timed out"));
			});
			req.on("error", reject);
			req.end();
		});
	},
});
