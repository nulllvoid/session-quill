// An autonomous run's setup (ADR 0026), kept out of the worker extension: the runtime version
// probe, the default scope resolver, and the per-run preparation (run dir with an empty context
// snapshot dir, the child environment with every credential location redirected (Task 9), the
// frozen grant the guard reads on every call, and the run settings that wire the guard in).
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
import { credentialSettings } from '../config/credentials.js';
import { mcpSettings } from '../config/mcp-policy.js';

export const VERSION_CACHE_MS = 10 * MINUTE;

// Until the scope catalog exists (Task 11), no write scope resolves: a run that names one fails at
// dispatch instead of running without the grant it asked for.
export function noScopeCatalog(names) {
  if (names.length) throw new TrackerError('scope-unknown', `no scope catalog resolves ${names.join(', ')}; queue the run again without write scopes`);
  return [];
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

/**
 * Prepares one autonomous run and returns what spawnAgent needs plus the credential report.
 * @param {{ storeEnv: object, config: object, handoff: object, cwd: string, checkout: string|null,
 *   repoCfg: object|null, scopes: object[], env: object }} opts  storeEnv: the worker's env (locates
 *   the run dir); env: the run's own variables (QUILL_HANDOFF_ID, …), merged over process.env.
 */
export function prepareAutonomous({ storeEnv, config, handoff: h, cwd, checkout, repoCfg, scopes, env }) {
  const runDir = handoffRunDir(storeEnv, h.id);
  fs.mkdirSync(runDir, { recursive: true });
  const contextDir = path.join(runDir, 'context');
  fs.rmSync(contextDir, { recursive: true, force: true });
  fs.mkdirSync(contextDir, { recursive: true });
  const permissions = h.permissions ?? {};
  const { readonly, keepEnv, apiBilling } = credentialSettings(config);
  const { mcpPolicy, trustedMcpServers } = mcpSettings(config);
  const built = buildChildEnv({ baseEnv: { ...process.env, ...env }, access: 'autonomous', permissions, scopes, readonly, keepEnv, apiBilling, runDir, platform: process.platform });
  const win = process.platform === 'win32';
  const envOf = (name) => { const k = Object.keys(built.env).find((x) => (win ? x.toUpperCase() === name : x === name)); return k === undefined ? undefined : built.env[k]; };
  const temps = [...new Set([envOf('TEMP'), envOf('TMP'), envOf('TMPDIR'), os.tmpdir()].filter((t) => typeof t === 'string' && path.isAbsolute(t)))];
  const home = envOf('USERPROFILE') ?? envOf('HOME') ?? os.homedir();
  const claudeDir = envOf('CLAUDE_CONFIG_DIR') ?? path.join(home, '.claude');
  const editable = !!(permissions.edit_source || permissions.edit_files || permissions.delete_files);
  const grant = {
    access: 'autonomous',
    permissions,
    scopes: scopes.map((x) => ({ name: x.name, ...(x.target ? { target: x.target } : {}), matchers: x.matchers ?? {}, fingerprint: x.fingerprint ?? null })),
    actionPins: [],
    // Spec §4.2: the checkout or sandbox, the run dir and its context snapshot, temp, and Claude's
    // plugin and skill directories; the checkout is writable only with an edit permission.
    readableRoots: [...new Set([cwd, runDir, contextDir, ...temps, path.join(claudeDir, 'plugins'), path.join(claudeDir, 'skills')])],
    writableRoots: [...new Set([runDir, ...temps, ...(editable ? [cwd] : [])])],
    // R13: the checkout's Claude and MCP configuration and git's own files never change in a run.
    protectedPaths: checkout ? [path.join(checkout, '.mcp.json'), path.join(checkout, '.claude'), path.join(checkout, '.git')] : [],
    mcpPolicy,
    trustedMcpServers,
    trackerHosts: [],
    defaultBranch: repoCfg ? repoCfg.default_branch ?? null : null,
    // Systems whose credentials are not an empty stub (read-only, scope or the owner's): a prod
    // CLI read on any other is refused with the onboarding hint (spec §3).
    credentialSystems: CRED_SYSTEMS.filter((sys) => built.report[sys] && built.report[sys] !== 'stub'),
  };
  const { sha256 } = writeGrant(runDir, grant);
  const settingsPath = writeRunSettings(runDir);
  const childEnv = {
    ...built.env,
    QUILL_HANDOFF_ACCESS: 'autonomous',
    QUILL_HANDOFF_PERMISSIONS: Object.keys(permissions).filter((k) => permissions[k] === true).join(','),
    QUILL_HANDOFF_SCOPES: scopes.map((x) => (x.target ? `${x.name}:${x.target}` : x.name)).join(','),
    QUILL_HANDOFF_GUARD: 'enforce',
    QUILL_HANDOFF_GRANT_SHA256: sha256,
    // Runs never write into the owner's Claude Code memory (spec §6.3, P0 disableAutoMemory).
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
  return { childEnv, settingsPath, addDirs: [contextDir], permissionPrompts: 'none', mcpServersPath: path.join(runDir, MCP_SERVERS_FILE), report: built.report };
}
