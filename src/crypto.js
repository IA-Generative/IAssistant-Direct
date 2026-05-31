// crypto.js - Web Crypto helpers (PBKDF2 + AES-GCM)
const CRYPTO = {
  async deriveKeyFromPassword(password, salt, iterations = 200000) {
    if (typeof password !== 'string' || password.length === 0)
      throw new Error('Password must be a non-empty string.');
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  async encryptJSON(obj, password) {
    if (typeof obj !== 'object' || obj === null)
      throw new Error('encryptJSON: input must be a valid object.');
    if (typeof password !== 'string' || password.length === 0)
      throw new Error('encryptJSON: password must be a non-empty string.');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await this.deriveKeyFromPassword(password, salt);
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return {
      iv: Array.from(iv),
      salt: Array.from(salt),
      ciphertext: Array.from(new Uint8Array(cipher))
    };
  },

  async decryptJSON(packet, password) {
    try {
      if (!packet || !packet.iv || !packet.salt || !packet.ciphertext) {
        console.warn('[MirAI Crypto] decryptJSON: packet format is invalid.', packet);
        return null;
      }
      if (typeof password !== 'string' || password.length === 0) {
        console.warn('[MirAI Crypto] decryptJSON: password must be a non-empty string.');
        return null;
      }
      const iv = new Uint8Array(packet.iv);
      const salt = new Uint8Array(packet.salt);
      const cipher = new Uint8Array(packet.ciphertext).buffer;
      const key = await this.deriveKeyFromPassword(password, salt);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
      return JSON.parse(new TextDecoder().decode(new Uint8Array(plain)));
    } catch (e) {
      console.error('[MirAI Crypto] Erreur dans decryptJSON:', e);
      return null;
    }
  },

  async encrypt(data, password) {
    return this.encryptJSON(data, password);
  },

  async decrypt(data, password) {
    try {
      if (!data) {
        console.warn('[MirAI Crypto] decrypt() appelé avec data vide.');
        return null;
      }
      const result = await this.decryptJSON(data, password);
      if (!result) {
        console.warn('[MirAI Crypto] decrypt() a renvoyé null (données invalides ou mot de passe incorrect).');
      }
      return result;
    } catch (e) {
      console.error('[MirAI Crypto] Erreur dans decrypt():', e);
      return null;
    }
  }

};

// ──────────────────────────────────────────────────────────────────────────
// TokenStore — stockage CHIFFRÉ du token SSO (miraiToken) au repos.
//
// Le token (offline token Keycloak, durée ~6 mois) ne doit pas rester en clair
// dans chrome.storage.local. On le chiffre en AES-GCM via CRYPTO, avec une clé
// dérivée d'un secret aléatoire 256 bits propre à l'appareil (miraiTokenKey),
// généré une fois et stocké localement. Limite assumée : la clé vit sur le
// poste — ceci protège contre la sync/inspection/logs, pas contre un accès
// complet au poste.
//
// Utilisé par auth.js (popup/options), background.js (service worker) et
// recording.js. Accès stockage via l'API brute (chrome/browser) pour être
// indépendant de compat.js et fonctionner aussi en service worker.
// ──────────────────────────────────────────────────────────────────────────
const _TOKEN_KEY = 'miraiToken';
const _TOKEN_SECRET_KEY = 'miraiTokenKey';
const _tokenStorage = () =>
  ((typeof browser !== 'undefined') ? browser : chrome).storage.local;

const TokenStore = {
  async _getOrCreateSecret() {
    const store = _tokenStorage();
    const got = await store.get({ [_TOKEN_SECRET_KEY]: null });
    let secret = got[_TOKEN_SECRET_KEY];
    if (!secret) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      secret = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
      await store.set({ [_TOKEN_SECRET_KEY]: secret });
    }
    return secret;
  },

  /** Retourne le token déchiffré {access_token, refresh_token, expires_in} ou null. */
  async getToken() {
    const got = await _tokenStorage().get({ [_TOKEN_KEY]: null });
    const raw = got[_TOKEN_KEY];
    if (!raw) return null;
    // Paquet chiffré ?
    if (raw.iv && raw.salt && raw.ciphertext) {
      const secret = await this._getOrCreateSecret();
      return await CRYPTO.decryptJSON(raw, secret);
    }
    // Ancien token en clair → migration transparente vers le format chiffré.
    if (raw.access_token) {
      try { await this.storeToken(raw); } catch (e) {
        console.warn('[MirAI TokenStore] Migration chiffrée échouée:', e?.message);
      }
      return raw;
    }
    return null;
  },

  /** Chiffre puis stocke le token. */
  async storeToken(tokenData) {
    const secret = await this._getOrCreateSecret();
    const packet = await CRYPTO.encryptJSON(tokenData, secret);
    await _tokenStorage().set({ [_TOKEN_KEY]: packet });
  },

  /** Supprime le token (révocation locale). Conserve le secret de chiffrement. */
  async clearToken() {
    await _tokenStorage().remove(_TOKEN_KEY);
  }
};

// Exposition globale — sur globalThis pour couvrir window (popup/options) ET
// self (service worker background.js).
if (typeof globalThis !== 'undefined') {
  globalThis.encrypt = CRYPTO.encrypt.bind(CRYPTO);
  globalThis.decrypt = CRYPTO.decrypt.bind(CRYPTO);
  globalThis.CRYPTO = CRYPTO;
  globalThis.TokenStore = TokenStore;
  console.info('[MirAI Crypto] Fonctions globales exposées (encrypt/decrypt/TokenStore).');
}