// State checkpoint (ADR 0030): the reduced state at a journal position, so worker start hydrates it
// and replays only the journal tail. It is local generated state, written only by the worker; a
// checkpoint is a cache of the journal, never a source of truth. Anything that does not match (format,
// reducer or package version, the configuration the reducer reads, a parse error) makes it null, and
// the caller replays the whole journal. Journal.open checks that its offset still ends at its event.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../lib/paths.js';
import { writeFileAtomic, readTextIfExists } from '../lib/atomic-fs.js';
import { REDUCER_VERSION } from './reducer.js';

export const CHECKPOINT_FORMAT = 1;
export const checkpointPath = (env) => path.join(stateDir(env), 'state.checkpoint.json');

let cachedPackageVersion = null;
export function packageVersion() {
  if (cachedPackageVersion === null) {
    cachedPackageVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  }
  return cachedPackageVersion;
}

// A hash of the reducer's source: src/core/reducer.js and every module it imports, followed through
// relative imports. REDUCER_VERSION is the deliberate signal; this catches a reducer change that
// forgot to bump it, as happens between releases in a git checkout (npm link). It is computed once
// per process; a file that cannot be read makes the fingerprint 'unavailable' rather than failing.
const IMPORT_RE = /^\s*(?:import|export)\b[^'"\n]*?['"](\.{1,2}\/[^'"]+)['"]/gm;
let cachedCodeFingerprint = null;
export function reducerCodeFingerprint() {
  if (cachedCodeFingerprint !== null) return cachedCodeFingerprint;
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const seen = new Set();
    const queue = [fileURLToPath(new URL('./reducer.js', import.meta.url))];
    const hash = createHash('sha256');
    while (queue.length) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      const text = fs.readFileSync(file, 'utf8');
      hash.update(`${path.relative(root, file).split(path.sep).join('/')}\n${text}\n`);
      for (const m of text.matchAll(IMPORT_RE)) queue.push(path.resolve(path.dirname(file), m[1]));
    }
    cachedCodeFingerprint = hash.digest('hex');
  } catch {
    cachedCodeFingerprint = 'unavailable';
  }
  return cachedCodeFingerprint;
}

// The meta fields reducers read (store and machine ids, the machine name new sessions record,
// approval phrases, project names and repository config). A change to any of them means a full
// replay would reduce old events differently, so the checkpoint no longer stands for the journal.
const REDUCER_META = ['store_id', 'machine_id', 'machine_name', 'approval_phrases_enabled', 'projects', 'repos'];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function metaFingerprint(meta) {
  const picked = {};
  for (const k of REDUCER_META) picked[k] = meta ? meta[k] ?? null : null;
  return createHash('sha256').update(canonical(picked)).digest('hex');
}

// ------------------------------------------------------------------ encoding
// JSON with tags for what JSON cannot hold: {"$m": [[k, v]…]} Map, {"$s": […]} Set, {"$u": 1}
// undefined, {"$n": "NaN"} non-finite numbers and -0, {"$o": [[k, v]…]} a plain object whose keys
// would read as a tag (a "$" prefix) or as a prototype ("__proto__"), and {"$r": n} the n-th object
// or array already encoded (pre-order), so records the state reaches twice (a session by key and by
// id) stay one object after hydration. Anything else (Date, class instances) is refused.

const needsWrap = (keys) => keys.some((k) => k.charCodeAt(0) === 36 || k === '__proto__');

export function encodeState(value) {
  const seen = new Map();
  const enc = (v) => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (Number.isFinite(v) && !Object.is(v, -0)) return v;
      return { $n: Object.is(v, -0) ? '-0' : String(v) };
    }
    if (v === undefined) return { $u: 1 };
    if (typeof v !== 'object') throw new TypeError(`unsupported ${typeof v} in state`);
    const ref = seen.get(v);
    if (ref !== undefined) return { $r: ref };
    seen.set(v, seen.size);
    if (Array.isArray(v)) {
      const out = new Array(v.length);
      for (let i = 0; i < v.length; i += 1) out[i] = enc(v[i]);
      return out;
    }
    if (v instanceof Map) {
      const out = [];
      for (const [k, x] of v) out.push([enc(k), enc(x)]);
      return { $m: out };
    }
    if (v instanceof Set) {
      const out = [];
      for (const x of v) out.push(enc(x));
      return { $s: out };
    }
    if (Object.getPrototypeOf(v) !== Object.prototype) throw new TypeError(`unsupported ${v.constructor ? v.constructor.name : 'object'} in state`);
    const keys = Object.keys(v);
    if (needsWrap(keys)) return { $o: keys.map((k) => [k, enc(v[k])]) };
    const out = {};
    for (const k of keys) out[k] = enc(v[k]);
    return out;
  };
  return enc(value);
}

function setOwn(obj, key, value) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  else obj[key] = value;
}

export function decodeState(tree) {
  const refs = [];
  const pairs = (x) => {
    if (!Array.isArray(x)) throw new TypeError('malformed tagged value');
    return x;
  };
  const dec = (x) => {
    if (x === null || typeof x !== 'object') return x;
    if (Array.isArray(x)) {
      const out = [];
      refs.push(out);
      for (const item of x) out.push(dec(item));
      return out;
    }
    const keys = Object.keys(x);
    if (keys.length === 1 && keys[0].charCodeAt(0) === 36) {
      const tag = keys[0];
      const body = x[tag];
      switch (tag) {
        case '$r':
          if (!Number.isInteger(body) || body < 0 || body >= refs.length) throw new TypeError('malformed reference');
          return refs[body];
        case '$u': return undefined;
        case '$n': {
          if (!['-0', 'NaN', 'Infinity', '-Infinity'].includes(body)) throw new TypeError('malformed number');
          return Number(body);
        }
        case '$m': {
          const m = new Map();
          refs.push(m);
          for (const pair of pairs(body)) m.set(dec(pairs(pair)[0]), dec(pair[1]));
          return m;
        }
        case '$s': {
          const s = new Set();
          refs.push(s);
          for (const item of pairs(body)) s.add(dec(item));
          return s;
        }
        case '$o': {
          const o = {};
          refs.push(o);
          for (const pair of pairs(body)) setOwn(o, String(pairs(pair)[0]), dec(pair[1]));
          return o;
        }
        default: throw new TypeError(`unknown tag ${tag}`);
      }
    }
    const o = {};
    refs.push(o);
    for (const k of keys) o[k] = dec(x[k]);
    return o;
  };
  return dec(tree);
}

// ------------------------------------------------------------------ file

// Only the worker calls this (ADR 0001: only the worker writes generated state). state.meta is left
// out: configuration is always taken fresh when a checkpoint is hydrated.
export function writeCheckpoint(state, { sequence, byteOffset, lastEventId, env = process.env, reducerVersion = REDUCER_VERSION, packageVersion: pkg = packageVersion(), codeFingerprint = reducerCodeFingerprint() }) {
  const { meta, ...rest } = state;
  const body = {
    format: CHECKPOINT_FORMAT, reducer_version: reducerVersion, package_version: pkg, code_fingerprint: codeFingerprint, meta_fingerprint: metaFingerprint(meta),
    sequence, byte_offset: byteOffset, last_event_id: lastEventId, state: encodeState(rest),
  };
  writeFileAtomic(checkpointPath(env), JSON.stringify(body));
}

// { state, sequence, byteOffset, lastEventId } or null. state has no meta: the caller sets the
// meta it built from current configuration. onIgnore(reason) hears why an existing file was not used.
export function readCheckpoint({ env = process.env, reducerVersion = REDUCER_VERSION, packageVersion: pkg = packageVersion(), codeFingerprint = reducerCodeFingerprint(), meta = null, onIgnore = () => {} } = {}) {
  const ignore = (reason) => { onIgnore(reason); return null; };
  let text;
  try {
    text = readTextIfExists(checkpointPath(env));
  } catch (err) {
    return ignore(`unreadable (${err.code ?? err.message})`);
  }
  if (text === null) return null;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return ignore('not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ignore('not valid JSON');
  if (body.format !== CHECKPOINT_FORMAT) return ignore(`format ${String(body.format)}, this version reads ${CHECKPOINT_FORMAT}`);
  if (body.reducer_version !== reducerVersion) return ignore(`written by reducer version ${String(body.reducer_version)}, this is ${reducerVersion}`);
  if (body.package_version !== pkg) return ignore(`written by package version ${String(body.package_version)}, this is ${pkg}`);
  if (body.code_fingerprint !== codeFingerprint) return ignore('the reducer code changed since it was written');
  if (meta && body.meta_fingerprint !== metaFingerprint(meta)) return ignore('the store configuration the reducer reads (projects, repositories, machine) changed since it was written');
  if (!Number.isInteger(body.sequence) || body.sequence < 1 || !Number.isInteger(body.byte_offset) || body.byte_offset < 1 || typeof body.last_event_id !== 'string' || !body.last_event_id) {
    return ignore('malformed journal position');
  }
  let state;
  try {
    state = decodeState(body.state);
  } catch (err) {
    return ignore(`malformed state (${err.message})`);
  }
  if (!state || typeof state !== 'object' || !(state.tickets instanceof Map) || !(state.appliedEvents instanceof Set) || !(state.appliedSources instanceof Set)) {
    return ignore('malformed state');
  }
  return { state, sequence: body.sequence, byteOffset: body.byte_offset, lastEventId: body.last_event_id };
}
