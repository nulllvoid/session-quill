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

// `boards`: the member names whose boards this token may read; null means every board. A member
// always reads its own.
function cleanBoards(boards) {
  if (boards === null || boards === undefined) return null;
  if (!Array.isArray(boards) || !boards.length || boards.some((b) => typeof b !== 'string' || !NAME_RE.test(b))) throw new TrackerError('hub-boards', '--boards takes a comma-separated list of member names');
  return [...new Set(boards)].sort();
}

const publicToken = (t) => ({ id: t.id, name: t.name, role: t.role, boards: Array.isArray(t.boards) ? t.boards : null });

export function canSee(token, memberName) {
  return !!token && (token.boards === null || token.boards.includes(memberName) || (token.role === 'member' && token.name === memberName));
}

export function addToken(dir, { name, role = 'member', boards = null, now }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new TrackerError('hub-name', 'a token name is 1 to 40 lowercase letters, digits and dashes, starting with a letter or digit');
  if (!ROLES.includes(role)) throw new TrackerError('hub-role', `role must be one of ${ROLES.join(', ')}`);
  const tokens = loadTokens(dir);
  if (tokens.some((t) => t.name === name)) throw new TrackerError('hub-name-taken', `a token named "${name}" already exists; revoke it first or pick another name`);
  if (tokens.length >= MAX_TOKENS) throw new TrackerError('hub-token-limit', `the hub holds at most ${MAX_TOKENS} tokens`);
  const token = `qh_${role === 'member' ? 'm' : 'v'}_${randomBytes(32).toString('base64url')}`;
  const record = { id: randomBytes(6).toString('hex'), name, role, boards: cleanBoards(boards), hash: sha256(token), created_at: now };
  saveTokens(dir, [...tokens, record]);
  return { token, ...publicToken(record) };
}

export function listTokens(dir) {
  return loadTokens(dir).map((t) => ({ ...publicToken(t), created_at: t.created_at }));
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
  return found ? publicToken(found) : null;
}

export function tokenById(dir, id) {
  const t = loadTokens(dir).find((x) => x.id === id);
  return t ? publicToken(t) : null;
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

// Edits a teammate proposed on the hub (ADR 0045), waiting for the board owner's worker.
//   boards/<name>/<store_id>/edits.json   { schema_version, edits: [{ id, ticket_id, field, value,
//     expected_revision, by, at, delivered_at }] }
export const MAX_OPEN_EDITS = 200;
const EDIT_KEEP_MS = 7 * 86_400_000;
const editsPath = (dir, name, storeId) => path.join(boardDir(dir, name, storeId), 'edits.json');

export function listEdits(dir, name, storeId) {
  let data = null;
  try { data = readJsonIfExists(editsPath(dir, name, storeId)); } catch { return []; }
  return data && Array.isArray(data.edits) ? data.edits.filter((e) => e && typeof e.id === 'string') : [];
}

function saveEdits(dir, name, storeId, edits, nowMs) {
  // Delivered edits are kept a week for the record; undelivered ones lapse after a week too.
  const kept = edits.filter((e) => nowMs - Date.parse(e.delivered_at ?? e.at) < EDIT_KEEP_MS);
  writeJsonAtomic(editsPath(dir, name, storeId), { schema_version: 1, edits: kept });
  return kept;
}

/** Queue one edit. A newer undelivered edit of the same field of the same ticket replaces the older. */
export function queueEdit(dir, name, storeId, edit, nowMs) {
  const edits = listEdits(dir, name, storeId).filter((e) => e.delivered_at || e.ticket_id !== edit.ticket_id || e.field !== edit.field);
  if (edits.filter((e) => !e.delivered_at).length >= MAX_OPEN_EDITS) throw new TrackerError('hub-edit-limit', `this board already has ${MAX_OPEN_EDITS} edits waiting for its owner's machine`);
  const record = { id: randomBytes(8).toString('hex'), ...edit, delivered_at: null };
  saveEdits(dir, name, storeId, [...edits, record], nowMs);
  return record;
}

export function ackEdits(dir, name, storeId, ids, now) {
  const want = new Set(ids);
  let n = 0;
  const edits = listEdits(dir, name, storeId).map((e) => {
    if (!want.has(e.id) || e.delivered_at) return e;
    n += 1;
    return { ...e, delivered_at: now };
  });
  if (n) saveEdits(dir, name, storeId, edits, Date.parse(now));
  return n;
}
