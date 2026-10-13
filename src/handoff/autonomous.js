// An autonomous run's setup (ADR 0026), kept out of the worker extension: the runtime version
// probe, the scope resolver, and the per-run preparation (run dir with an empty context snapshot
// dir, the child environment with every credential location redirected (Task 9), the frozen grant
// the guard reads on every call, and the run settings that wire the guard in). A full-access run
// gets the same guard in observe mode, which never refuses and records what enforce mode would
// have refused; `prodEffects` turns that ledger into the run's `prod_effects`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { TrackerError } from '../lib/errors.js';
import { handoffRunDir } from '../lib/paths.js';
import { MINUTE } from '../lib/time.js';
import { buildChildEnv, CRED_SYSTEMS } from './cred-env.js';
import { writeGrant } from './grant.js';
import { writeRunSettings } from './run-settings.js';
import { MCP_SERVERS_FILE } from './mcp-sources.js';
import { loadScopeCatalog, resolveScopes, scopeReferences } from './scopes.js';
import { credentialSettings } from '../config/credentials.js';
import { mcpSettings } from '../config/mcp-policy.js';

export const VERSION_CACHE_MS = 10 * MINUTE;
// At most this many observed writes are kept on a full-access run's record.
export const MAX_PROD_EFFECTS = 200;

// The worker's scope resolver: a run's requested scopes against the catalog of the current config
// (spec §4.3). A scope that no longer resolves fails the run at dispatch. `env` locates the
// install key the grant's fingerprints need.
export function catalogScopes(names, config, env = process.env) {
  return names.length ? resolveScopes(names, loadScopeCatalog(config, { env })) : [];
}

/**
 * `claude --version` for the autonomous runtime gate. The returned function resolves to the first
 * output line, or null when it cannot be read; a good answer is cached for 10 minutes so a batch
 * does not start one probe per run.
 */
export function createVersionProbe({ claudePath = 'claude', claudeArgs = [], spawnEnv = {}, now = Date.now } = {}) {
  let cache = null; // { at, value }
  return function probeVersion() {
    const at = now();
    if (cache && at - cache.at < VERSION_CACHE_MS) return Promise.resolve(cache.value);
    return new Promise((resolve) => {
      try {
        execFile(claudePath, [...claudeArgs, '--version'], { timeout: 15_000, windowsHide: true, env: { ...process.env, ...spawnEnv } }, (err, stdout) => {
          const value = err ? null : String(stdout ?? '').trim().split(/\r?\n/)[0] || null;
          if (value) cache = { at, value };
          resolve(value);
        });
      } catch { resolve(null); }
    });
  };
}

// The run's frozen grant (spec §4.1, §4.2): what the guard reads on every call. Scopes carry name,
// target, matchers and fingerprint only; a scope's credentials never enter the grant.
function grantFor({ access, permissions, scopes, cwd, runDir, contextDir, checkout, repoCfg, config, envOf, credentialSystems }) {
  const { mcpPolicy, trustedMcpServers } = mcpSettings(config);
  const temps = [...new Set([envOf('TEMP'), envOf('TMP'), envOf('TMPDIR'), os.tmpdir()].filter((t) => typeof t === 'string' && path.isAbsolute(t)))];
  const home = envOf('USERPROFILE') ?? envOf('HOME') ?? os.homedir();
  const claudeDir = envOf('CLAUDE_CONFIG_DIR') ?? path.join(home, '.claude');
  const editable = !!(permissions.edit_source || permissions.edit_files || permissions.delete_files);
  return {
    access,
    permissions,
    scopes: scopes.map((x) => ({ name: x.name, ...(x.target ? { target: x.target } : {}), matchers: x.matchers ?? {}, fingerprint: x.fingerprint ?? null })),
    actionPins: [],
    // Spec §4.2: the checkout or sandbox, the run dir and its context snapshot, temp, and Claude's
    // plugin and skill directories; the checkout is writable only with an edit permission.
    readableRoots: [...new Set([cwd, runDir, ...(contextDir ? [contextDir] : []), ...temps, path.join(claudeDir, 'plugins'), path.join(claudeDir, 'skills')])],
    writableRoots: [...new Set([runDir, ...temps, ...(editable ? [cwd] : [])])],
    // R13: the checkout's Claude and MCP configuration and git's own files never change in a run.
    protectedPaths: checkout ? [path.join(checkout, '.mcp.json'), path.join(checkout, '.claude'), path.join(checkout, '.git')] : [],
    mcpPolicy,
    trustedMcpServers,
    trackerHosts: [],
    defaultBranch: repoCfg ? repoCfg.default_branch ?? null : null,
    ...(credentialSystems ? { credentialSystems } : {}),
  };
}

const lookup = (vars) => (name) => { const k = Object.keys(vars).find((x) => (process.platform === 'win32' ? x.toUpperCase() === name : x === name)); return k === undefined ? undefined : vars[k]; };
const grantedPermissions = (permissions) => Object.keys(permissions).filter((k) => permissions[k] === true).join(',');

/**
 * Prepares one autonomous run and returns what spawnAgent needs plus the credential report.
 * @param {{ storeEnv: object, config: object, handoff: object, cwd: string, checkout: string|null,
 *   repoCfg: object|null, scopes: object[], env: object }} opts  storeEnv: the worker's env (locates
 *   the run dir); env: the run's own variables (QUILL_HANDOFF_ID, …), merged over process.env;
 *   scopes: resolveScopes() entries.
 * Throws `scope-credentials-missing` when a granted scope whose commands need credentials of their
 * own got none (for example an `env:NAME` reference that is not set when the run starts).
 */
export function prepareAutonomous({ storeEnv, config, handoff: h, cwd, checkout, repoCfg, scopes, env }) {
  const runDir = handoffRunDir(storeEnv, h.id);
  fs.mkdirSync(runDir, { recursive: true });
  const contextDir = path.join(runDir, 'context');
  fs.rmSync(contextDir, { recursive: true, force: true });
  fs.mkdirSync(contextDir, { recursive: true });
  const permissions = h.permissions ?? {};
  const { readonly, keepEnv, apiBilling } = credentialSettings(config);
  // C2: every variable a scope takes through env:NAME leaves the run; granted scopes set their
  // values only under their own variable names.
  const built = buildChildEnv({ baseEnv: { ...process.env, ...env }, access: 'autonomous', permissions, scopes, readonly, keepEnv, apiBilling, runDir, platform: process.platform, stripNames: scopeReferences(config) });
  for (const s of scopes) {
    if (s.credentials !== 'required' || (s.systems ?? []).some((sys) => built.report[sys] === 'scope' || built.report[sys] === 'owner')) continue;
    const why = (built.report.scope_errors ?? []).filter((e) => e.startsWith(`${s.name}:`)).map((e) => e.slice(s.name.length + 1).trim());
    throw new TrackerError('scope-credentials-missing', `scope ${s.target ? `${s.name}:${s.target}` : s.name} got no credentials when the run started${why.length ? ` (${why.join('; ')})` : ''}; check [scopes."${s.name}"] in config.toml and the variables it references`);
  }
  // Systems whose credentials are not an empty stub (read-only, scope or the owner's): a prod
  // CLI read on any other is refused with the onboarding hint (spec §3).
  const credentialSystems = CRED_SYSTEMS.filter((sys) => built.report[sys] && built.report[sys] !== 'stub');
  const grant = grantFor({ access: 'autonomous', permissions, scopes, cwd, runDir, contextDir, checkout, repoCfg, config, envOf: lookup(built.env), credentialSystems });
  const { sha256 } = writeGrant(runDir, grant);
  const settingsPath = writeRunSettings(runDir);
  const childEnv = {
    ...built.env,
    QUILL_HANDOFF_ACCESS: 'autonomous',
    QUILL_HANDOFF_PERMISSIONS: grantedPermissions(permissions),
    QUILL_HANDOFF_SCOPES: scopes.map((x) => (x.target ? `${x.name}:${x.target}` : x.name)).join(','),
    QUILL_HANDOFF_GUARD: 'enforce',
    QUILL_HANDOFF_GRANT_SHA256: sha256,
    // Runs never write into the owner's Claude Code memory (spec §6.3, P0 disableAutoMemory).
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
  return { childEnv, settingsPath, addDirs: [contextDir], permissionPrompts: 'none', mcpServersPath: path.join(runDir, MCP_SERVERS_FILE), report: built.report };
}

/**
 * Prepares a full-access run's observer (spec §3 `full` row, §7, R7): the same guard in observe
 * mode, with a grant of access `full`. It never refuses a call, a failing hook never blocks one,
 * and the owner's environment is left as it is; the guard only records each call in the ledger
 * with what enforce mode would have decided. Returns the variables to add to the run's env and the
 * extras for spawnAgent.
 */
export function prepareObserve({ storeEnv, config, handoff: h, cwd, checkout, repoCfg, env }) {
  const runDir = handoffRunDir(storeEnv, h.id);
  fs.mkdirSync(runDir, { recursive: true });
  const permissions = h.permissions ?? {};
  const grant = grantFor({ access: 'full', permissions, scopes: [], cwd, runDir, contextDir: null, checkout, repoCfg, config, envOf: lookup({ ...process.env, ...env }), credentialSystems: null });
  const { sha256 } = writeGrant(runDir, grant);
  const settingsPath = writeRunSettings(runDir, { observe: true });
  const vars = {
    QUILL_HANDOFF_ACCESS: 'full',
    QUILL_HANDOFF_PERMISSIONS: grantedPermissions(permissions),
    QUILL_HANDOFF_SCOPES: '',
    QUILL_HANDOFF_GUARD: 'observe',
    QUILL_HANDOFF_GRANT_SHA256: sha256,
  };
  return { vars, settingsPath, mcpServersPath: path.join(runDir, MCP_SERVERS_FILE) };
}

/**
 * A full-access run's production and external writes, from the guard lines of its ledger (observe
 * mode, spec §7): calls the guard allowed that enforce mode would have refused as a critical change
 * or write. Git (a per-run permission) and Quill's own commands are not prod effects. Each entry
 * holds only the scope, the target, the tool name and the time; the redacted call text stays in
 * the local ledger.
 * @returns {{ scope: string, target: string|null, tool: string|null, t: string|null }[]}
 */
export function prodEffects(lines = []) {
  const out = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l || typeof l !== 'object' || l.kind !== 'guard' || l.critical !== true || l.decision !== 'allow' || l.enforce_decision === 'allow') continue;
    const scope = typeof l.scope === 'string' && l.scope ? l.scope : null;
    if (!scope || scope.startsWith('git.') || scope === 'privileged') continue;
    out.push({ scope, target: typeof l.target === 'string' && l.target ? l.target : null, tool: typeof l.tool_name === 'string' ? l.tool_name : null, t: typeof l.ts === 'string' ? l.ts : null });
    if (out.length >= MAX_PROD_EFFECTS) break;
  }
  return out;
}
