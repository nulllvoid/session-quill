// The write-scope catalog of autonomous runs (spec §4.3, ADR 0026): the built-ins of
// src/config/scopes.js merged with the owner's `[scopes]` tables, and the one resolver that every
// path uses: request validation (dashboard and CLI), the request applying in the worker, and
// dispatch. A resolved scope feeds two places and keeps them apart: the grant gets its name,
// target, matchers and fingerprint (never credentials), buildChildEnv gets its name and env.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { TrackerError } from '../lib/errors.js';
import { quillHome } from '../lib/paths.js';
import { canonicalJson, LEASE_MINUTES } from './grant.js';
import { BUILTIN_SCOPES, scopeSettings, SCOPE_NAME_RE } from '../config/scopes.js';
import { BUILTIN_COMMANDS } from '../gate/scope-commands.js';
import { SCOPE_SYSTEMS, credentialSystemOf } from './cred-env.js';

const GENERIC_TARGET = '^[A-Za-z0-9](?:[A-Za-z0-9._@-]{0,126}[A-Za-z0-9_])?$';
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const sorted = (v) => [...new Set(strings(v))].sort();
const stringMap = (v) => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([, x]) => typeof x === 'string'));
const show = (s) => JSON.stringify(String(s).slice(0, 140));

// The per-install key that literal credential values are fingerprinted under (I1): 32 random bytes,
// hex, in `<quillHome>/scope-fingerprint.key`, owner-only, created on first use, never exported.
export const SCOPE_KEY_FILE = 'scope-fingerprint.key';

/**
 * The "Valid for" minutes of a critical approval (ADR 0031): null for the whole run (undefined or
 * null), else one of LEASE_MINUTES exactly; anything else throws `invalid-ttl`.
 */
export function leaseMinutes(value) {
  if (value === undefined || value === null) return null;
  if (!LEASE_MINUTES.includes(value)) throw new TrackerError('invalid-ttl', `ttl_minutes must be one of ${LEASE_MINUTES.join(', ')} (minutes), or left out for the whole run`);
  return value;
}
const KEY_RE = /^[0-9a-f]{64}$/;

// The file appears only complete: the key is written to a temporary file in the same directory and
// hard-linked into place (a concurrent creator's link wins and is read). A file that is not a key
// (empty or cut short by a crash) is replaced, never trusted. An existing key that others can read
// is made owner-only, or refused when that fails (I1-a, I1-b).
export function scopeKey(env = process.env) {
  const file = path.join(quillHome(env), SCOPE_KEY_FILE);
  const unavailable = (why) => new TrackerError('scope-key-unavailable', `the scope fingerprint key ${file} ${why}; scopes with literal credential values cannot be granted until it is fixed`);
  const ownerOnly = () => {
    if (process.platform === 'win32') return;
    let mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077) { try { fs.chmodSync(file, 0o600); } catch { /* checked below */ } mode = fs.statSync(file).mode & 0o777; }
    if (mode & 0o077) throw unavailable('is readable by others and could not be made owner-only');
  };
  const read = () => {
    let text;
    try { text = fs.readFileSync(file, 'utf8').trim(); } catch (err) { if (err.code === 'ENOENT') return null; throw unavailable(`cannot be read (${err.code ?? err.message})`); }
    if (!KEY_RE.test(text)) return undefined;
    ownerOnly();
    return text;
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const got = read();
    if (typeof got === 'string') return got;
    if (got === undefined) { try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw unavailable(`is not a key and cannot be replaced (${err.code ?? err.message})`); } }
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch { /* modes unsupported */ }
      try { fs.linkSync(tmp, file); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    } catch (err) {
      throw unavailable(`cannot be created (${err.code ?? err.message})`);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    }
  }
  throw unavailable('keeps changing while it is read');
}

// What a credential value contributes to a fingerprint: an `env:NAME` reference as written, a
// literal (a path, a profile name) only as its HMAC under the install key, so a fingerprint copied
// into a grant or a proposal never lets anyone guess the literal offline.
function valueMark(v, keyOf) {
  if (v.startsWith('env:')) return v;
  const key = keyOf ? keyOf() : null;
  if (!key) throw new TrackerError('scope-key-unavailable', 'a scope with a literal credential value needs the install key to be fingerprinted');
  return `hmac:${createHmac('sha256', key).update(v, 'utf8').digest('hex')}`;
}
const markedEnv = (env, keyOf) => Object.fromEntries(Object.entries(stringMap(env)).map(([k, v]) => [k, valueMark(v, keyOf)]));

/**
 * SHA-256 (hex) of a scope table in canonical form (I1): label, matchers (de-duplicated, sorted),
 * target, env keys with each value as its `env:NAME` reference or the HMAC of its literal (`key`:
 * the install key, or a function returning it, read only when a literal is present). It changes
 * when what the scope allows, its label or the credentials it switches to change (Review Focus 4
 * compares it on approval), never with the order things were written in.
 * @param {{ name?, label?, target?, mcp?, bash?, hosts?, commands?, env?, targets?, takes_target? }} table
 * @param {{ key?: string|(() => string) }} [opts]
 */
export function scopeFingerprint(table = {}, { key = null } = {}) {
  const t = table && typeof table === 'object' ? table : {};
  const keyOf = typeof key === 'function' ? key : key ? () => key : null;
  const norm = { mcp: sorted(t.mcp), bash: sorted(t.bash), hosts: sorted(t.hosts), env: markedEnv(t.env, keyOf) };
  if (t.commands && typeof t.commands === 'object') norm.commands = canonicalCommands(t.commands);
  if (typeof t.name === 'string') norm.name = t.name;
  if (typeof t.label === 'string') norm.label = t.label;
  if (t.target !== undefined && t.target !== null) norm.target = String(t.target);
  if (typeof t.takes_target === 'boolean') norm.takes_target = t.takes_target;
  if (t.targets && typeof t.targets === 'object') norm.targets = Object.fromEntries(Object.entries(t.targets).map(([k, v]) => [k, { env: markedEnv(v && v.env, keyOf) }]));
  return createHash('sha256').update(canonicalJson(norm)).digest('hex');
}

// A fingerprint computed on first read: validation never needs one, so only dispatch (the grant)
// and approval read the install key.
function lazyFingerprint(obj, compute) {
  let value;
  Object.defineProperty(obj, 'fingerprint', { enumerable: true, configurable: true, get() { value ??= compute(); return value; } });
  return obj;
}

// Tool lists with their order-free parts sorted, for the fingerprint.
function canonicalCommands(commands) {
  return Object.fromEntries(Object.entries(commands).map(([bin, spec]) => [bin, { ...spec, verbs: sorted(spec && spec.verbs), ...(spec && Array.isArray(spec.requires) ? { requires: sorted(spec.requires) } : {}) }]));
}

/**
 * Every variable the owner's `[scopes]` tables take through `env:NAME` (C2, C2-a), read from the raw
 * config, so tables the catalog drops (an owner scope without MCP patterns, targets of a scope that
 * takes none, invalid entries) count too: the worker removes all of them from every autonomous
 * run's environment, and sets a granted scope's values only under the scope's own variable names.
 */
export function scopeReferences(config = {}) {
  const out = new Set();
  const walk = (v, depth) => {
    if (depth > 8 || v === null || typeof v !== 'object') return;
    for (const x of Array.isArray(v) ? v : Object.values(v)) {
      if (typeof x === 'string') { const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(x.trim()); if (m) out.add(m[1]); } else walk(x, depth + 1);
    }
  };
  walk(config && config.scopes, 0);
  return [...out];
}

/**
 * The catalog: built-ins merged with the owner's tables (`label`/`permits` override, a matcher list
 * the owner names replaces the built-in one, env tables add credentials). An owner scope with no
 * matchers is left out: it could never cover a call.
 * @returns {Record<string, { name, builtin, label, permits, mcp: string[], bash: string[], hosts: string[],
 *   env: Record<string,string>, targets: Record<string,{ env }>, takesTarget: boolean, targetLabel,
 *   targetPattern, credentials: 'required'|'optional'|'none', systems: string[], uses, hint, fingerprint }>}
 *   `fingerprint` is computed when first read; a literal credential value then needs the install
 *   key (`opts.key`, else scopeKey(opts.env)).
 */
export function loadScopeCatalog(config = {}, { env = process.env, key = null } = {}) {
  const { tables } = scopeSettings(config);
  const out = {};
  let cachedKey = key;
  const keyOf = () => (cachedKey ??= scopeKey(env));
  const names = [...Object.keys(BUILTIN_SCOPES), ...Object.keys(tables).filter((n) => !Object.hasOwn(BUILTIN_SCOPES, n)).sort()];
  for (const name of names) {
    const b = Object.hasOwn(BUILTIN_SCOPES, name) ? BUILTIN_SCOPES[name] : null;
    const o = Object.hasOwn(tables, name) ? tables[name] : {};
    const mcp = [...(o.mcp ?? b?.mcp ?? [])];
    const bash = [...(o.bash ?? b?.bash ?? [])];
    const hosts = [...(o.hosts ?? b?.hosts ?? [])];
    if (!b && !(mcp.length || bash.length || hosts.length)) continue;
    const takesTarget = b ? !!b.target : o.takes_target === true;
    const env = { ...(o.env ?? {}) };
    // R25: the built-in tool lists, with what the owner added (owner scopes have none).
    const commands = {};
    if (b && Object.hasOwn(BUILTIN_COMMANDS, name)) {
      for (const [bin, spec] of Object.entries(BUILTIN_COMMANDS[name])) {
        const ext = o.commands && Object.hasOwn(o.commands, bin) ? o.commands[bin] : null;
        commands[bin] = ext ? { ...spec, verbs: [...new Set([...spec.verbs, ...ext.verbs])], options: { ...spec.options, ...Object.fromEntries(ext.flags.map((x) => [x, 'flag'])), ...Object.fromEntries(ext.values.map((x) => [x, 'value'])) } } : spec;
      }
    }
    const targets = takesTarget ? { ...(o.targets ?? {}) } : {};
    const label = o.label ?? b?.label ?? name;
    out[name] = lazyFingerprint({
      name,
      builtin: !!b,
      label,
      permits: o.permits ?? b?.permits ?? 'Writes that match the patterns in your config.toml.',
      mcp, bash, hosts, commands, env, targets,
      takesTarget,
      targetLabel: takesTarget ? b?.target?.label ?? 'Target' : null,
      targetPattern: takesTarget ? b?.target?.pattern ?? GENERIC_TARGET : null,
      credentials: b?.credentials ?? 'optional',
      systems: [...(SCOPE_SYSTEMS[name] ?? [])],
      uses: b?.uses ?? null,
      hint: b?.hint ?? 'env',
    }, () => scopeFingerprint({ name, label, mcp, bash, hosts, commands, env, targets, takes_target: takesTarget }, { key: keyOf }));
    Object.defineProperty(out[name], 'keyOf', { value: keyOf, enumerable: false });
  }
  return out;
}

const tableName = (name, target) => `[scopes."${name}"${target === null ? '' : `.targets.${BARE_KEY.test(target) ? target : `"${target}"`}`}]`;
const hasOwnCredentials = (env, systems) => Object.keys(env).some((k) => systems.includes(credentialSystemOf(k)));

/**
 * Resolves requested scopes (`name` or `name:target`) against the catalog, or throws:
 * `unknown-scope:<name>` (not in the catalog, or a git pseudo-scope: ruling R2),
 * `invalid-scope-target:<name>` (a target where none is taken, none where one is needed, or one
 * that is not a plain token of the scope's kind), `scope-credentials-missing:<name>[:<target>]`
 * (a scope whose CLI cannot write without its own credentials and has none configured), and
 * `scope-conflict:<name>` (two targets of one scope with different credentials). The error code is
 * the part before the first colon.
 * @returns {{ name, target: string|null, matchers: { mcp, bash, hosts }, fingerprint, env, credentials, systems }[]}
 *   `matchers` with `{target}` filled in; `fingerprint` of exactly what this grant holds; `env` the
 *   scope's credentials with the target's own table over them (values may be `env:NAME`).
 */
export function resolveScopes(requested = [], catalog = {}) {
  const out = [];
  for (const spec of Array.isArray(requested) ? requested : [requested]) {
    const text = String(spec);
    const colon = text.indexOf(':');
    const name = colon < 0 ? text : text.slice(0, colon);
    const target = colon < 0 ? null : text.slice(colon + 1);
    if (typeof spec !== 'string' || !SCOPE_NAME_RE.test(name) || name.startsWith('git.') || !Object.hasOwn(catalog, name)) {
      throw new TrackerError('unknown-scope', `unknown-scope:${name.slice(0, 64)}: no write scope ${show(name)} is configured; see the Write scopes list in the Run dialog or [scopes] in config.toml${name.startsWith('git.') ? ' (commit, push and pull requests are per-run permissions, not scopes)' : ''}`);
    }
    const s = catalog[name];
    const kind = (s.targetLabel ?? 'target').toLowerCase();
    if (!s.takesTarget && target !== null) throw new TrackerError('invalid-scope-target', `invalid-scope-target:${name}: ${name} takes no target; grant it as ${name}`);
    if (s.takesTarget) {
      if (target === null || target === '') throw new TrackerError('invalid-scope-target', `invalid-scope-target:${name}: ${name} needs a ${kind}, as ${name}:<${kind}>`);
      if (target.includes('..') || target.includes('//') || !new RegExp(s.targetPattern).test(target)) throw new TrackerError('invalid-scope-target', `invalid-scope-target:${name}: ${show(target)} is not a plain ${kind} (letters, digits and . _ - only${name === 'argo.sync' || name === 'deploy' ? ', with / between parts' : ''}; no spaces, wildcards, quotes or ..)`);
    }
    const env = { ...s.env, ...(target !== null && Object.hasOwn(s.targets, target) ? s.targets[target].env : {}) };
    if (s.credentials === 'required' && !hasOwnCredentials(env, s.systems)) {
      throw new TrackerError('scope-credentials-missing', `scope-credentials-missing:${target === null ? name : `${name}:${target}`}: no credentials are configured for this scope${target === null ? '' : ` and ${kind} ${target}`}, and its commands cannot write without them — set ${tableName(name, target)} ${s.hint}${target === null ? '' : ` (or ${tableName(name, null)} ${s.hint} for every ${kind})`} in config.toml`);
    }
    const fill = (list) => list.flatMap((p) => (p.includes('{target}') ? (target === null ? [] : [p.split('{target}').join(target)]) : [p]));
    const matchers = { mcp: fill(s.mcp), bash: fill(s.bash), hosts: fill(s.hosts), commands: s.commands ?? {} };
    if (out.some((x) => x.name === name && x.target === target)) continue;
    const clash = out.find((x) => x.name === name && canonicalJson(x.env) !== canonicalJson(env));
    if (clash) throw new TrackerError('scope-conflict', `scope-conflict:${name}: ${clash.target ?? name} and ${target ?? name} switch to different credentials, so one run cannot hold both; queue a run per ${kind}`);
    out.push(lazyFingerprint({ name, target, matchers, env, credentials: s.credentials, systems: [...s.systems] }, () => scopeFingerprint({ name, label: s.label, target, ...matchers, env }, { key: s.keyOf ?? null })));
  }
  return out;
}

/** The validator handoff requests use (permissions.js `scopeCheck`): one catalog, one resolver. */
export function scopeValidator(config = {}, { env = process.env } = {}) {
  const catalog = loadScopeCatalog(config, { env });
  return (names) => resolveScopes(names, catalog);
}

/**
 * What the Run dialog lists (snapshot meta.autonomy.scopes; never exported): per scope its label,
 * what it permits, which credentials it switches to (variable and target names only, never a
 * value), whether it takes a target and which targets have their own credentials.
 */
export function catalogSummary(catalog = {}) {
  return Object.values(catalog).map((s) => {
    const scopeNames = Object.keys(s.env);
    const withEnv = Object.entries(s.targets).filter(([, t]) => Object.keys(t.env ?? {}).length);
    const names = [...new Set([...scopeNames, ...withEnv.flatMap(([, t]) => Object.keys(t.env))])];
    const ready = s.credentials !== 'required' || hasOwnCredentials(s.env, s.systems) || withEnv.some(([, t]) => hasOwnCredentials(t.env, s.systems));
    let switches;
    if (names.length) {
      const where = withEnv.length ? ` (configured for ${withEnv.map(([t]) => t).join(', ')}${scopeNames.length ? `, and for any other ${(s.targetLabel ?? 'target').toLowerCase()}` : ''})` : '';
      switches = `Switches to the scope's own ${names.join(', ')}${where}; everything else keeps its read-only credentials.`;
    } else if (s.credentials === 'none') switches = `No credentials change: it uses ${s.uses}.`;
    else if (s.credentials === 'required') switches = `No credentials configured: set ${tableName(s.name, null)} ${s.hint} (or per ${(s.targetLabel ?? 'target').toLowerCase()} under .targets) in config.toml; until then this scope is refused.`;
    else switches = `No credentials configured: it uses ${s.uses ?? 'what the command itself carries'}; command-line tools keep their read-only credentials.`;
    return { name: s.name, label: s.label, permits: s.permits, switches, takes_target: s.takesTarget, target_label: s.targetLabel, targets: Object.keys(s.targets), credentials: s.credentials, ready };
  });
}
