// Owner authentication for the loopback dashboard (TRD §Local dashboard and request transport).
// One-use CLI-generated secrets (accepted by hash, so the raw secret never touches disk) are
// exchanged for an HttpOnly SameSite cookie; mutations also need a CSRF token bound to it.
import { createHash, createHmac, randomBytes } from 'node:crypto';

export const COOKIE_NAME = 'st_owner';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function hashSecret(secret) {
  return createHash('sha256').update(String(secret)).digest('hex');
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function hostOf(value) {
  if (!value) return null;
  const m = /^(\[[0-9a-fA-F:]+\]|[^:]+)(?::(\d+))?$/.exec(String(value).trim());
  if (!m) return null;
  return { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : null };
}

export function createAuth({ clock = Date.now } = {}) {
  const pendingSecrets = new Map(); // hash -> expires_at (ms)
  const tokens = new Set();
  const csrfKey = randomBytes(32);

  return {
    acceptSecretHash(hash, expiresAtMs) {
      pendingSecrets.set(hash, expiresAtMs);
    },
    exchangeSecret(secret) {
      const hash = hashSecret(secret ?? '');
      const expires = pendingSecrets.get(hash);
      if (expires === undefined) return null;
      pendingSecrets.delete(hash);
      if (clock() > expires) return null;
      const token = randomBytes(32).toString('hex');
      tokens.add(token);
      return token;
    },
    verifyToken(token) {
      return typeof token === 'string' && tokens.has(token);
    },
    tokenFromRequest(req) {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[COOKIE_NAME];
      return this.verifyToken(token) ? token : null;
    },
    cookieHeader(token) {
      return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
    },
    csrfFor(token) {
      return createHmac('sha256', csrfKey).update(String(token)).digest('hex');
    },
    verifyCsrf(token, provided) {
      return typeof provided === 'string' && provided.length === 64 && this.csrfFor(token) === provided;
    },
    checkOrigin(req, port) {
      const host = hostOf(req.headers.host);
      if (!host || !LOOPBACK_HOSTS.has(host.host)) return { ok: false, reason: 'host must be loopback' };
      if (host.port !== null && port && host.port !== port) return { ok: false, reason: 'host port mismatch' };
      const origin = req.headers.origin;
      if (origin !== undefined) {
        let parsed;
        try { parsed = new URL(origin); } catch { return { ok: false, reason: 'origin malformed' }; }
        const oh = hostOf(parsed.host);
        if (parsed.protocol !== 'http:' || !oh || !LOOPBACK_HOSTS.has(oh.host)) return { ok: false, reason: 'cross-origin request rejected' };
        if (oh.port !== null && port && oh.port !== port) return { ok: false, reason: 'origin port mismatch' };
      }
      return { ok: true };
    },
    revokeAll() {
      tokens.clear();
      pendingSecrets.clear();
    },
  };
}
