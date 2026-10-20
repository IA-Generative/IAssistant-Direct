// tests/dm-telemetry.test.js

beforeEach(() => {
  __resetChromeStorage();
  jest.clearAllMocks();
  jest.useFakeTimers();
  delete window.DMTelemetry;

  const fs = require('fs');
  const code = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'dm', 'telemetry.js'), 'utf8');
  eval(code);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('DMTelemetry', () => {

  describe('init()', () => {
    test('active la telemetrie si telemetryEnabled=true', () => {
      window.DMTelemetry.init({ telemetryEnabled: true, telemetryEndpoint: 'https://otel.test/v1/traces' });
      expect(window.DMTelemetry._enabled).toBe(true);
      expect(window.DMTelemetry._endpoint).toBe('https://otel.test/v1/traces');
    });

    test('desactive la telemetrie si telemetryEnabled=false', () => {
      window.DMTelemetry.init({ telemetryEnabled: false });
      expect(window.DMTelemetry._enabled).toBe(false);
    });

    test('ne plante pas si config est null', () => {
      expect(() => window.DMTelemetry.init(null)).not.toThrow();
      expect(window.DMTelemetry._enabled).toBe(false);
    });
  });

  describe('sendSpan()', () => {
    test('ajoute un span au buffer', () => {
      window.DMTelemetry.init({ telemetryEnabled: true });
      window.DMTelemetry.sendSpan('login.success', { method: 'pkce' });

      expect(window.DMTelemetry._buffer).toHaveLength(1);
      expect(window.DMTelemetry._buffer[0].name).toBe('login.success');
      expect(window.DMTelemetry._buffer[0].attributes.method).toBe('pkce');
      expect(window.DMTelemetry._buffer[0].attributes['plugin.slug']).toBe('iassistant-direct-browser');
    });

    test('n\'ajoute rien si telemetrie desactivee', () => {
      window.DMTelemetry.init({ telemetryEnabled: false });
      window.DMTelemetry.sendSpan('some.event', {});

      expect(window.DMTelemetry._buffer).toHaveLength(0);
    });

    test('inclut la version du plugin et le type de plateforme', () => {
      window.DMTelemetry.init({ telemetryEnabled: true });
      window.DMTelemetry.sendSpan('recording.start', { meeting_id: '42' });

      const span = window.DMTelemetry._buffer[0];
      expect(span.attributes['plugin.version']).toBe('1.2.1');
      expect(span.attributes['platform.type']).toBe('chrome');
    });

    test('auto-flush apres 5 spans', () => {
      window.DMTelemetry.init({
        telemetryEnabled: true,
        telemetryEndpoint: 'https://otel.test/v1/traces'
      });

      const flushSpy = jest.spyOn(window.DMTelemetry, 'flush');

      for (let i = 0; i < 5; i++) {
        window.DMTelemetry.sendSpan(`event.${i}`, {});
      }

      expect(flushSpy).toHaveBeenCalled();
      flushSpy.mockRestore();
    });
  });

  describe('flush()', () => {
    test('envoie les spans au endpoint en OTLP JSON', async () => {
      window.DMTelemetry.init({
        telemetryEnabled: true,
        telemetryEndpoint: 'https://otel.test/v1/traces',
        telemetryKey: 'test-token-xyz'
      });

      // Ajouter des spans sans declencher l'auto-flush
      window.DMTelemetry._buffer.push(
        { name: 'test.span', timestamp: new Date().toISOString(), attributes: { 'plugin.version': '1.2.1' } }
      );

      global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });

      await window.DMTelemetry.flush();

      expect(global.fetch).toHaveBeenCalledWith(
        'https://otel.test/v1/traces',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token-xyz'
          })
        })
      );

      // Buffer vide apres flush
      expect(window.DMTelemetry._buffer).toHaveLength(0);
    });

    test('ne fait rien si buffer vide', async () => {
      window.DMTelemetry.init({ telemetryEnabled: true, telemetryEndpoint: 'https://otel.test' });

      await window.DMTelemetry.flush();

      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('remet les spans dans le buffer si le flush echoue', async () => {
      window.DMTelemetry.init({
        telemetryEnabled: true,
        telemetryEndpoint: 'https://otel.test/v1/traces'
      });

      window.DMTelemetry._buffer.push(
        { name: 'retry.span', timestamp: new Date().toISOString(), attributes: { 'plugin.version': '1.2.1' } }
      );

      global.fetch.mockResolvedValueOnce({ ok: false, status: 503 });

      await window.DMTelemetry.flush();

      expect(window.DMTelemetry._buffer).toHaveLength(1);
      expect(window.DMTelemetry._buffer[0].name).toBe('retry.span');
    });

    test('remet les spans si erreur reseau', async () => {
      window.DMTelemetry.init({
        telemetryEnabled: true,
        telemetryEndpoint: 'https://otel.test/v1/traces'
      });

      window.DMTelemetry._buffer.push(
        { name: 'net.error', timestamp: new Date().toISOString(), attributes: { 'plugin.version': '1.2.1' } }
      );

      global.fetch.mockRejectedValueOnce(new Error('Network failure'));

      await window.DMTelemetry.flush();

      expect(window.DMTelemetry._buffer.length).toBeGreaterThan(0);
    });

    test('cap le buffer a 50 elements max en cas d\'echecs repetes', async () => {
      window.DMTelemetry.init({
        telemetryEnabled: true,
        telemetryEndpoint: 'https://otel.test/v1/traces'
      });

      // Remplir le buffer avec 60 spans
      for (let i = 0; i < 60; i++) {
        window.DMTelemetry._buffer.push(
          { name: `overflow.${i}`, timestamp: new Date().toISOString(), attributes: { 'plugin.version': '1.2.1' } }
        );
      }

      global.fetch.mockRejectedValueOnce(new Error('Fail'));

      await window.DMTelemetry.flush();

      expect(window.DMTelemetry._buffer.length).toBeLessThanOrEqual(50);
    });

    test('utilise X-Client-UUID en fallback si pas de token', async () => {
      __seedChromeStorage({ dmClientUUID: 'fallback-uuid-123' });

      window.DMTelemetry.init({
        telemetryEnabled: true,
        telemetryEndpoint: 'https://otel.test/v1/traces'
        // pas de telemetryKey
      });

      window.DMTelemetry._buffer.push(
        { name: 'uuid.test', timestamp: new Date().toISOString(), attributes: { 'plugin.version': '1.2.1' } }
      );

      global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });

      await window.DMTelemetry.flush();

      const callHeaders = global.fetch.mock.calls[0][1].headers;
      expect(callHeaders['X-Client-UUID']).toBe('fallback-uuid-123');
      expect(callHeaders['Authorization']).toBeUndefined();
    });

    test('discard les spans si pas d\'endpoint', async () => {
      window.DMTelemetry.init({ telemetryEnabled: true }); // pas d'endpoint

      window.DMTelemetry._buffer.push(
        { name: 'no.endpoint', timestamp: new Date().toISOString(), attributes: {} }
      );

      await window.DMTelemetry.flush();

      expect(global.fetch).not.toHaveBeenCalled();
      expect(window.DMTelemetry._buffer).toHaveLength(0);
    });
  });

  describe('refreshToken()', () => {
    test('met a jour le token depuis DM', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ token: 'new-token-xyz' })
      });

      await window.DMTelemetry.refreshToken('https://dm.test', 'iassistant-direct-browser', 'int');

      expect(window.DMTelemetry._token).toBe('new-token-xyz');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://dm.test/telemetry/token?device=iassistant-direct-browser&profile=int'
      );
    });

    test('ne plante pas si le refresh echoue', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Timeout'));

      await expect(
        window.DMTelemetry.refreshToken('https://dm.test')
      ).resolves.not.toThrow();
    });
  });
});
