// The team hub's data folder (ADR 0044): access tokens, the cookie-signing secret and one sanitized
// snapshot per member store. Plain files, written atomically, so a backup is a copy of the folder.
//
//   <dir>/hub.json                         { schema_version, created_at }
//   <dir>/tokens.json                      { schema_version, tokens: [{ id, name, role, hash, created_at }] }
//   <dir>/secret.key                       32 random bytes, hex; signs browser sessions
//   <dir>/boards/<name>/<store_id>/info.json, snapshot.json
//
// A token is shown once, when it is created. Only its sha256 is stored; the tokens are 32 random
// bytes, so a plain hash is enough.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ensureDir, readJsonIfExists, writeFileAtomic, writeJsonAtomic, listFiles } from '../lib/atomic-fs.js';
import { TrackerError } from '../lib/errors.js';

export const ROLES = Object.freeze(['member', 'viewer']);
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const STORE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const TOKEN_RE = /^qh_[mv]_[A-Za-z0-9_-]{43}$/;
const MAX_TOKENS = 500;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const tokensPath = (dir) => path.join(dir, 'tokens.json');

export function initHub(dir, { now }) {
  ensureDir(dir);
  if (!readJsonIfExists(path.join(dir, 'hub.json'))) writeJsonAtomic(path.join(dir, 'hub.json'), { schema_version: 1, created_at: now });
  hubSecret(dir);
  return dir;
}

export function hubSecret(dir) {
  const file = path.join(dir, 'secret.key');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const secret = randomBytes(32);
  ensureDir(dir);
  writeFileAtomic(file, `${secret.toString('hex')}\n`);
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on this file system */ }
  return secret;
}

function loadTokens(dir) {
  const data = readJsonIfExists(tokensPath(dir));
  const list = data && Array.isArray(data.tokens) ? data.tokens : [];
  return list.filter((t) => t && typeof t.id === 'string' && typeof t.hash === 'string' && NAME_RE.test(t.name) && ROLES.includes(t.role));
}

function saveTokens(dir, tokens) {
  writeJsonAtomic(tokensPath(dir), { schema_version: 1, tokens });
  try { fs.chmodSync(tokensPath(dir), 0o600); } catch { /* not supported on this file system */ }
}

export function addToken(dir, { name, role = 'member', now }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new TrackerError('hub-name', 'a token name is 1 to 40 lowercase letters, digits and dashes, starting with a letter or digit');
  if (!ROLES.includes(role)) throw new TrackerError('hub-role', `role must be one of ${ROLES.join(', ')}`);
  const tokens = loadTokens(dir);
  if (tokens.some((t) => t.name === name)) throw new TrackerError('hub-name-taken', `a token named "${name}" already exists; revoke it first or pick another name`);
  if (tokens.length >= MAX_TOKENS) throw new TrackerError('hub-token-limit', `the hub holds at most ${MAX_TOKENS} tokens`);
  const token = `qh_${role === 'member' ? 'm' : 'v'}_${randomBytes(32).toString('base64url')}`;
  const record = { id: randomBytes(6).toString('hex'), name, role, hash: sha256(token), created_at: now };
  saveTokens(dir, [...tokens, record]);
  return { token, id: record.id, name, role };
}

export function listTokens(dir) {
  return loadTokens(dir).map(({ id, name, role, created_at }) => ({ id, name, role, created_at }));
}

export function revokeToken(dir, name) {
  const tokens = loadTokens(dir);
  const rest = tokens.filter((t) => t.name !== name && t.id !== name);
  if (rest.length === tokens.length) return null;
  saveTokens(dir, rest);
  const gone = tokens.find((t) => t.name === name || t.id === name);
  return { id: gone.id, name: gone.name, role: gone.role };
}

/** The token record a presented token belongs to, or null. Every stored hash is compared. */
export function findToken(dir, presented) {
  if (typeof presented !== 'string' || !TOKEN_RE.test(presented)) return null;
  const hash = Buffer.from(sha256(presented), 'hex');
  let found = null;
  for (const t of loadTokens(dir)) {
    const stored = Buffer.from(t.hash, 'hex');
    if (stored.length === hash.length && timingSafeEqual(stored, hash)) found = t;
  }
  return found ? { id: found.id, name: found.name, role: found.role } : null;
}

export function tokenById(dir, id) {
  const t = loadTokens(dir).find((x) => x.id === id);
  return t ? { id: t.id, name: t.name, role: t.role } : null;
}

function boardDir(dir, name, storeId) {
  if (!NAME_RE.test(name) || !STORE_ID_RE.test(storeId)) throw new TrackerError('hub-board', 'invalid board name');
  return path.join(dir, 'boards', name, storeId);
}

// snapshot.json first, info.json last: a reader that sees the info knows the snapshot is complete.
export function saveBoard(dir, name, storeId, snapshot, info) {
  const target = boardDir(dir, name, storeId);
  ensureDir(target);
  writeFileAtomic(path.join(target, 'snapshot.json'), JSON.stringify(snapshot));
  writeJsonAtomic(path.join(target, 'info.json'), info);
  return info;
}

export function readBoard(dir, name, storeId) {
  let target;
  try { target = boardDir(dir, name, storeId); } catch { return null; }
  const info = readJsonIfExists(path.join(target, 'info.json'));
  if (!info) return null;
  const snapshot = readJsonIfExists(path.join(target, 'snapshot.json'));
  return snapshot ? { info, snapshot } : null;
}

export function listBoards(dir) {
  const root = path.join(dir, 'boards');
  const out = [];
  for (const name of listFiles(root, (n) => NAME_RE.test(n))) {
    for (const storeId of listFiles(path.join(root, name), (n) => STORE_ID_RE.test(n))) {
      let info = null;
      try { info = readJsonIfExists(path.join(root, name, storeId, 'info.json')); } catch { /* a torn file is skipped */ }
      if (info) out.push({ name, store_id: storeId, info });
    }
  }
  return out;
}

export function removeBoard(dir, name, storeId) {
  let target;
  try { target = boardDir(dir, name, storeId); } catch { return false; }
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

export function removeBoardsOf(dir, name) {
  if (!NAME_RE.test(name)) return 0;
  const target = path.join(dir, 'boards', name);
  const n = listFiles(target, (x) => STORE_ID_RE.test(x)).length;
  fs.rmSync(target, { recursive: true, force: true });
  return n;
}
