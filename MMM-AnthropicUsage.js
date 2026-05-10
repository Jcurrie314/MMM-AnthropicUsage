/* global Module, Log */

Module.register("MMM-AnthropicUsage", {

	defaults: {
		sessionKey: null,
		orgId: null,
		updateInterval: 120,      // seconds between refreshes
		initialLoadDelay: 0,      // seconds before first fetch
		animationSpeed: 0,        // ms for DOM update animation
		fontSize: "small",        // x-small | small | medium | large | x-large
		barColor: "#4a90e2",      // progress bar fill color
		trackColor: "#1a2a3a",    // progress bar track color
		warnColor: "#e2a94a",     // bar color at >= 80%
		overColor: "#cc3318",     // bar color at 100%
		showExtra: false,         // show extra credits row (Pro accounts with usage-based billing)
		cdpPort: null,            // set to 9222 to route fetches through Chromium via CDP (fixes Cloudflare blocks)
	},

	requiresVersion: "2.2.1",

	start: function () {
		var self = this;
		self.loaded = false;
		self.usageData = null;
		self.errorMessage = null;

		if (!self.config.sessionKey || !self.config.orgId) {
			Log.error("MMM-AnthropicUsage: sessionKey and orgId are required.");
			return;
		}

		setTimeout(function () {
			self.getData();
			setInterval(function () { self.getData(); }, self.config.updateInterval * 1000);
		}, self.config.initialLoadDelay * 1000);
	},

	getData: function () {
		this.sendSocketNotification("GET_ANTHROPIC_USAGE", {
			sessionKey: this.config.sessionKey,
			orgId: this.config.orgId,
			cdpPort: this.config.cdpPort || null,
		});
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "ANTHROPIC_USAGE_DATA") {
			this.usageData = payload;
			this.errorMessage = null;
			this.loaded = true;
			this.updateDom(this.config.animationSpeed);
		} else if (notification === "ANTHROPIC_USAGE_ERROR") {
			this.errorMessage = payload;
			this.loaded = true;
			this.updateDom(this.config.animationSpeed);
		}
	},

	getStyles: function () {
		return ["MMM-AnthropicUsage.css"];
	},

	timeUntil: function (isoString) {
		if (!isoString) return "";
		var diff = new Date(isoString) - Date.now();
		if (diff <= 0) return "soon";
		var totalMin = Math.floor(diff / 60000);
		var h = Math.floor(totalMin / 60);
		var m = totalMin % 60;
		if (h >= 48) return Math.floor(h / 24) + "d " + (h % 24) + "h";
		if (h > 0)   return h + "h " + m + "m";
		return m + "m";
	},

	makeRow: function (label, pct, rightText) {
		var cfg = this.config;
		var clamped = Math.min(Math.max(pct, 1), 100);
		var barColor = pct >= 100 ? cfg.overColor : pct >= 80 ? cfg.warnColor : cfg.barColor;

		// Row 1: label (left) + time remaining (right)
		var tr1 = document.createElement("tr");

		var labelTd = document.createElement("td");
		labelTd.className = "label-cell secondary-text";
		labelTd.innerText = label;
		tr1.appendChild(labelTd);

		var rightTd = document.createElement("td");
		rightTd.className = "right-cell secondary-text";
		rightTd.innerText = rightText;
		tr1.appendChild(rightTd);

		// Row 2: full-width progress bar
		var tr2 = document.createElement("tr");

		var barTd = document.createElement("td");
		barTd.className = "progressBarCell";
		barTd.colSpan = 2;

		var track = document.createElement("div");
		track.className = "progressBarTrack";
		track.style.backgroundColor = cfg.trackColor;

		var bar = document.createElement("div");
		bar.className = "progressBar";
		bar.style.width = clamped.toFixed(1) + "%";
		bar.style.backgroundColor = barColor;

		track.appendChild(bar);
		barTd.appendChild(track);
		tr2.appendChild(barTd);

		return [tr1, tr2];
	},

	getDom: function () {
		var self = this;
		var wrapper = document.createElement("div");
		wrapper.className = self.config.fontSize;

		if (!self.config.sessionKey || !self.config.orgId) {
			wrapper.innerHTML = '<span class="dimmed">sessionKey and orgId required.</span>';
			return wrapper;
		}

		if (!self.loaded) {
			wrapper.innerHTML = '<span class="loading">Loading&hellip;</span>';
			return wrapper;
		}

		if (self.errorMessage) {
			var err = document.createElement("div");
			err.className = "loading";
			err.innerText = self.errorMessage;
			wrapper.appendChild(err);
			return wrapper;
		}

		var d = self.usageData;
		var table = document.createElement("table");
		table.className = "usage-table";

		if (d.five_hour) {
			var sp = d.five_hour.utilization || 0;
			self.makeRow("Session", sp, sp + "%  \u00b7  " + self.timeUntil(d.five_hour.resets_at))
				.forEach(function (r) { table.appendChild(r); });
		}

		if (d.seven_day) {
			var wp = d.seven_day.utilization || 0;
			self.makeRow("Weekly", wp, wp + "%  \u00b7  " + self.timeUntil(d.seven_day.resets_at))
				.forEach(function (r) { table.appendChild(r); });
		}

		if (self.config.showExtra && d.extra_usage && d.extra_usage.is_enabled) {
			var eu = d.extra_usage;
			var ep = Math.round(eu.used_credits / eu.monthly_limit * 100);
			var spent = "$" + (eu.used_credits / 100).toFixed(2);
			var limit = "$" + (eu.monthly_limit / 100).toFixed(2);
			self.makeRow("Extra", ep, spent + " / " + limit)
				.forEach(function (r) { table.appendChild(r); });
		}

		wrapper.appendChild(table);
		return wrapper;
	},
});
