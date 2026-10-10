// Owner authentication for the loopback dashboard (TRD §Local dashboard and request transport).
// One-use CLI-generated secrets (accepted by hash, so the raw secret never touches disk) are
// exchanged for an HttpOnly SameSite cookie; mutations also need a CSRF token bound to it.
// Sessions are kept as hashes with a sliding expiry, so a worker restart keeps the browser
// signed in without a plain token ever reaching the disk (ADR 0022).
import fs from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readJsonIfExists, writeJsonAtomic } from '../lib/atomic-fs.js';

export const COOKIE_NAME = 'st_owner';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A renewal is written only when it moves the stored expiry by more than this, so ordinary
// polling does not rewrite the file on every request.
const PERSIST_STEP_MS = 60 * 60 * 1000;

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

export function createAuth({ clock = Date.now, sessionsPath = null, revokePath = null } = {}) {
  const pendingSecrets = new Map(); // hash -> expires_at (ms)
  const sessions = new Map(); // token hash -> { expires: ms, stored: ms }

  // `quill ui --revoke` drops a marker and deletes the stored hashes without waiting for the
  // worker's next tick. Until the worker consumes the marker, nothing verifies and nothing held
  // in memory can be written back, so a revoked session never comes back.
  function revokePending() {
    if (!revokePath || !fs.existsSync(revokePath)) return false;
    sessions.clear();
    pendingSecrets.clear();
    return true;
  }

  function save() {
    if (!sessionsPath || revokePending()) return;
    const list = [...sessions].map(([hash, s]) => ({ hash, expires_at: new Date(s.expires).toISOString() }));
    try { writeJsonAtomic(sessionsPath, { version: 1, sessions: list }); } catch { /* sessions still work in memory */ }
    for (const s of sessions.values()) s.stored = s.expires;
  }

  function load() {
    if (!sessionsPath) return;
    const rec = readJsonIfExists(sessionsPath);
    let pruned = false;
    for (const item of Array.isArray(rec && rec.sessions) ? rec.sessions : []) {
      const expires = Date.parse(item && item.expires_at);
      if (typeof item.hash !== 'string' || !/^[0-9a-f]{64}$/.test(item.hash) || !(expires > clock())) { pruned = true; continue; }
      sessions.set(item.hash, { expires, stored: expires });
    }
    if (pruned) save();
  }
  load();

  return {
    acceptSecretHash(hash, expiresAtMs) {
      pendingSecrets.set(hash, expiresAtMs);
    },
    exchangeSecret(secret) {
      if (revokePending()) return null;
      const hash = hashSecret(secret ?? '');
      const expires = pendingSecrets.get(hash);
      if (expires === undefined) return null;
      pendingSecrets.delete(hash);
      if (clock() > expires) return null;
      const token = randomBytes(32).toString('hex');
      sessions.set(hashSecret(token), { expires: clock() + SESSION_TTL_MS, stored: 0 });
      save();
      return token;
    },
    verifyToken(token) {
      if (typeof token !== 'string' || !token || revokePending()) return false;
      const hash = hashSecret(token);
      const s = sessions.get(hash);
      if (!s) return false;
      const now = clock();
      if (now > s.expires) { sessions.delete(hash); save(); return false; }
      s.expires = now + SESSION_TTL_MS;
      if (s.expires - s.stored > PERSIST_STEP_MS) save();
      return true;
    },
    tokenFromRequest(req) {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[COOKIE_NAME];
      return this.verifyToken(token) ? token : null;
    },
    // Max-Age matches the sliding session, and the server re-sends the cookie on authenticated
    // responses, so the browser keeps it for 7 days from its last use, as the session does.
    cookieHeader(token) {
      return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
    },
    // Keyed by the session token itself, so an open page's CSRF token stays valid across a
    // worker restart; it is as unguessable as the HttpOnly cookie it is bound to.
    csrfFor(token) {
      return createHmac('sha256', String(token)).update('quill-csrf-v1').digest('hex');
    },
    verifyCsrf(token, provided) {
      if (typeof provided !== 'string') return false;
      const expected = Buffer.from(this.csrfFor(token), 'utf8');
      const given = Buffer.from(provided, 'utf8');
      // timingSafeEqual needs equal lengths; the length of a CSRF token is no secret.
      return given.length === expected.length && timingSafeEqual(given, expected);
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
      sessions.clear();
      pendingSecrets.clear();
      if (sessionsPath) { try { writeJsonAtomic(sessionsPath, { version: 1, sessions: [] }); } catch { /* nothing left to keep */ } }
    },
  };
}
