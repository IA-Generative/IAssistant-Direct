// tests/setup.js — Chrome Extension API mocks for Jest/jsdom

const storageData = {};

const chromeMock = {
  runtime: {
    getManifest: jest.fn(() => ({
      version: '1.2.1',
      manifest_version: 3,
      name: 'IAssistant-Direct (by Mirai)'
    })),
    getURL: jest.fn((path) => `chrome-extension://mock-extension-id/${path || ''}`),
    sendMessage: jest.fn((msg, cb) => { if (cb) cb({}); return Promise.resolve({}); }),
    onInstalled: {
      addListener: jest.fn()
    },
    onMessage: {
      addListener: jest.fn()
    },
    lastError: null
  },

  storage: {
    local: {
      get: jest.fn((keys, cb) => {
        if (typeof keys === 'string') {
          const result = {};
          result[keys] = storageData[keys] || undefined;
          if (cb) cb(result);
          return Promise.resolve(result);
        }
        if (Array.isArray(keys)) {
          const result = {};
          keys.forEach(k => { result[k] = storageData[k] || undefined; });
          if (cb) cb(result);
          return Promise.resolve(result);
        }
        // Object with defaults
        const result = {};
        for (const [k, def] of Object.entries(keys || {})) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        if (cb) cb(result);
        return Promise.resolve(result);
      }),
      set: jest.fn((items, cb) => {
        Object.assign(storageData, items);
        if (cb) cb();
        return Promise.resolve();
      }),
      remove: jest.fn((keys, cb) => {
        const toRemove = Array.isArray(keys) ? keys : [keys];
        toRemove.forEach(k => delete storageData[k]);
        if (cb) cb();
        return Promise.resolve();
      })
    }
  },

  alarms: {
    create: jest.fn(),
    onAlarm: {
      addListener: jest.fn()
    }
  },

  notifications: {
    create: jest.fn()
  },

  tabs: {
    query: jest.fn(() => Promise.resolve([])),
    create: jest.fn(() => Promise.resolve({})),
    update: jest.fn(() => Promise.resolve({}))
  },

  identity: {
    getRedirectURL: jest.fn((path) => `https://mock-redirect.test/${path || ''}`),
    launchWebAuthFlow: jest.fn(() => Promise.resolve('https://mock-redirect.test/?code=mock-code'))
  }
};

// Expose globally
global.chrome = chromeMock;
global.navigator = global.navigator || {};

// Helper: reset storage between tests
global.__resetChromeStorage = () => {
  Object.keys(storageData).forEach(k => delete storageData[k]);
};

// Helper: seed storage for tests
global.__seedChromeStorage = (data) => {
  Object.assign(storageData, data);
};

// Helper: read storage
global.__getChromeStorage = () => ({ ...storageData });

// Mock fetch globally
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({})
  })
);

// Web Crypto — vraie implémentation (Node) pour PBKDF2/AES-GCM utilisés par
// TokenStore (token chiffré au repos) et SHA-256, avec un randomUUID déterministe.
// subtle est un shim délégant : auth.test.js peut surcharger subtle.digest sans
// impacter importKey/deriveKey/encrypt/decrypt (réels, requis par TokenStore).
// TextEncoder/TextDecoder requis par crypto.js. On les implémente via Buffer en
// produisant des Uint8Array du realm jsdom (jsdom 20 isole son propre realm ;
// utiliser ceux de node:util casserait les `expect.any(Uint8Array)`).
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = class { encode(s) { return Uint8Array.from(Buffer.from(String(s), 'utf8')); } };
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = class { decode(a) { return Buffer.from(a || []).toString('utf8'); } };
}

const { webcrypto } = require('node:crypto');
const _realSubtle = webcrypto.subtle;
const _subtleShim = {
  importKey: (...a) => _realSubtle.importKey(...a),
  deriveKey: (...a) => _realSubtle.deriveKey(...a),
  encrypt: (...a) => _realSubtle.encrypt(...a),
  decrypt: (...a) => _realSubtle.decrypt(...a),
  digest: (...a) => _realSubtle.digest(...a),
};
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  writable: true,
  value: {
    subtle: _subtleShim,
    getRandomValues: (arr) => webcrypto.getRandomValues(arr),
    randomUUID: jest.fn(() => 'mock-uuid-1234-5678-abcd'),
  },
});
