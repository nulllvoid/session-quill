// The frozen per-run grant (spec §4.1). At dispatch the worker writes `<runDir>/grant.json` and
// puts its SHA-256 in QUILL_HANDOFF_GRANT_SHA256 on the agent process; the guard reads it on every
// tool call and refuses it when the bytes no longer match, so editing the file fails closed.
//
// grant = { access, permissions, scopes: [{ name, target?, matchers: { mcp?, bash?, hosts? },
//   fingerprint }], actionPins: [{ scope, pin }], readableRoots, writableRoots, protectedPaths,
//   mcpPolicy, trustedMcpServers, trackerHosts, requireDryRun?, notAfter? }
// ADR 0031: `requireDryRun` (an approved critical run's pinned k8s/db writes need their dry-run
// twin first) and `notAfter` (the approval's lease end, an ISO time fixed at dispatch) are part of
// the hashed grant, so neither can be changed or dropped once the run started.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TrackerError } from '../lib/errors.js';
import { ensureDir, tempPathFor, renameAtomic } from '../lib/atomic-fs.js';

export const GRANT_FILE = 'grant.json';
// The "Valid for" choices of a critical approval, in minutes (ADR 0031). No choice: the whole run.
export const LEASE_MINUTES = Object.freeze([5, 15, 60]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// JSON with keys sorted at every level, so the same grant always has the same hash.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// Writes the grant atomically, readable by the owner only where the OS has file modes.
export function writeGrant(runDir, grant) {
  if (!isPlainObject(grant)) throw new TrackerError('grant-invalid', 'a grant must be a plain object');
  const text = `${canonicalJson(grant)}\n`;
  const dest = path.join(runDir, GRANT_FILE);
  ensureDir(runDir);
  const tmp = tempPathFor(dest);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  fs.closeSync(fd);
  renameAtomic(tmp, dest);
  return { path: dest, sha256: sha256(Buffer.from(text, 'utf8')) };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// Throws `grant-missing` when the file is absent, `grant-tampered` when its bytes do not hash to
// `expectedSha` (or no usable hash was given), and `grant-invalid` when they do but are not a
// grant object. The returned grant is deeply frozen.
export function readGrant(file, expectedSha) {
  if (typeof expectedSha !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedSha)) throw new TrackerError('grant-tampered', 'no valid grant hash to check the grant against');
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new TrackerError('grant-missing', `no grant file at ${file}`);
    throw err;
  }
  if (sha256(bytes) !== expectedSha.toLowerCase()) throw new TrackerError('grant-tampered', 'the grant file does not match the hash recorded at dispatch');
  let grant;
  try {
    grant = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new TrackerError('grant-invalid', 'the grant file is not JSON');
  }
  if (!isPlainObject(grant)) throw new TrackerError('grant-invalid', 'the grant file does not hold a grant object');
  return deepFreeze(grant);
}

/**
 * The lease end of a run dispatched at `startedAt` with `minutes` from LEASE_MINUTES, as an ISO
 * time; null when there is no lease (undefined or null). Anything else throws `invalid-ttl`.
 */
export function leaseNotAfter(startedAt, minutes) {
  if (minutes === undefined || minutes === null) return null;
  if (!LEASE_MINUTES.includes(minutes)) throw new TrackerError('invalid-ttl', `a critical approval is valid for the whole run or ${LEASE_MINUTES.join(', ')} minutes, not ${String(minutes).slice(0, 20)}`);
  const at = Date.parse(startedAt);
  if (!Number.isFinite(at)) throw new TrackerError('invalid-ttl', 'the run has no dispatch time to start its lease from');
  return new Date(at + minutes * 60_000).toISOString();
}
