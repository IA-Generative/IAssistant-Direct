// dm/telemetry.js — Device Management telemetry client (OTLP JSON)
// Loaded via <script> in popup.html

window.DMTelemetry = {
  _endpoint: null,
  _token: null,
  _slug: 'iassistant-direct-browser',
  _buffer: [],
  _flushTimer: null,
  _enabled: false,

  /**
   * Initialize telemetry from DM config.
   */
  init(config) {
    if (!config) return;
    this._enabled = config.telemetryEnabled !== false;
    this._endpoint = config.telemetryEndpoint || null;
    this._token = config.telemetryKey || null;

    if (!this._enabled) {
      console.info('[MirAI Telemetry] Telemetry disabled by config.');
      return;
    }

    // Auto-flush every 30 seconds
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = setInterval(() => this.flush(), 30000);

    console.info('[MirAI Telemetry] Initialized.',
      this._endpoint ? `Endpoint: ${this._endpoint}` : '(no endpoint — buffering only)');
  },

  /**
   * Record a telemetry span.
   * @param {string} name - Span name (e.g. "login.success", "recording.start")
   * @param {object} attributes - Key/value attributes
   */
  sendSpan(name, attributes) {
    if (!this._enabled) return;

    const span = {
      name: name,
      timestamp: new Date().toISOString(),
      attributes: Object.assign({
        'plugin.slug': this._slug,
        'plugin.version': (typeof chrome !== 'undefined' && chrome.runtime?.getManifest)
          ? chrome.runtime.getManifest().version : 'unknown',
        'platform.type': (typeof browser !== 'undefined') ? 'firefox' : 'chrome'
      }, attributes || {})
    };

    this._buffer.push(span);
    console.debug('[MirAI Telemetry] Span buffered:', name);

    // Auto-flush if buffer exceeds 5 spans
    if (this._buffer.length >= 5) {
      this.flush();
    }
  },

  /**
   * Flush buffered spans to the telemetry endpoint.
   */
  async flush() {
    if (!this._enabled || this._buffer.length === 0) return;
    if (!this._endpoint) {
      console.debug('[MirAI Telemetry] No endpoint configured, discarding', this._buffer.length, 'spans.');
      this._buffer = [];
      return;
    }

    const spans = this._buffer.splice(0);
    const payload = {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: this._slug } },
            { key: 'service.version', value: { stringValue: spans[0]?.attributes?.['plugin.version'] || 'unknown' } }
          ]
        },
        scopeSpans: [{
          spans: spans.map(s => ({
            name: s.name,
            startTimeUnixNano: String(new Date(s.timestamp).getTime() * 1000000),
            endTimeUnixNano: String(new Date(s.timestamp).getTime() * 1000000),
            attributes: Object.entries(s.attributes).map(([k, v]) => ({
              key: k,
              value: { stringValue: String(v) }
            }))
          }))
        }]
      }]
    };

    try {
      const headers = { 'Content-Type': 'application/json' };

      // Auth: prefer token, fallback to client UUID
      if (this._token) {
        headers['Authorization'] = `Bearer ${this._token}`;
      } else {
        try {
          const B = (typeof browser !== 'undefined') ? browser : chrome;
          const { dmClientUUID } = await B.storage.local.get('dmClientUUID');
          if (dmClientUUID) headers['X-Client-UUID'] = dmClientUUID;
        } catch (e) { /* ignore */ }
      }

      const resp = await fetch(this._endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        console.warn('[MirAI Telemetry] Flush failed:', resp.status);
        // Re-add spans to buffer for retry
        this._buffer = spans.concat(this._buffer);
      } else {
        console.info('[MirAI Telemetry] Flushed', spans.length, 'spans.');
      }
    } catch (err) {
      console.warn('[MirAI Telemetry] Flush error:', err.message);
      // Re-add spans for retry (cap at 50 to avoid unbounded growth)
      this._buffer = spans.concat(this._buffer).slice(0, 50);
    }
  },

  /**
   * Refresh telemetry token from DM.
   */
  async refreshToken(bootstrapUrl, slug, profile) {
    slug = slug || this._slug;
    profile = profile || 'int';
    try {
      const resp = await fetch(`${bootstrapUrl}/telemetry/token?device=${slug}&profile=${profile}`);
      if (resp.ok) {
        const data = await resp.json();
        this._token = data.token || data.access_token || null;
        console.info('[MirAI Telemetry] Token refreshed.');
      }
    } catch (err) {
      console.warn('[MirAI Telemetry] Token refresh failed:', err.message);
    }
  }
};
