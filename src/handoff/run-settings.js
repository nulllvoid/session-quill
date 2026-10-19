// The per-run Claude Code settings file (spec §4.1). The worker passes `--settings
// <runDir>/run-settings.json` to an autonomous run's `claude` process; the file wires
// bin/quill-guard.js in as a PreToolUse hook for every tool family the guard decides, and blocks
// the call when the hook fails or times out. A full-access run gets the same hook in observe mode,
// which does not block on a failure. It does not depend on the session-quill plugin.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrackerError } from '../lib/errors.js';
import { ensureDir, tempPathFor, renameAtomic } from '../lib/atomic-fs.js';

export const RUN_SETTINGS_FILE = 'run-settings.json';
export const GUARD_MATCHER = 'Bash|PowerShell|Monitor|mcp__.*|WebFetch|WebSearch|Read|Glob|Grep|Edit|Write|MultiEdit|NotebookEdit|Task|Agent';
export const GUARD_TIMEOUT_S = 10;
// This install's guard entry point.
export const GUARD_BIN = fileURLToPath(new URL('../../bin/quill-guard.js', import.meta.url));

// Line breaks and NUL cannot pass through to an argv unchanged; $ is refused too, because the host
// may expand ${VAR} in hook commands and arguments (the plugin's own hooks rely on that).
const UNSAFE = /[$\r\n\0]/;

const invalid = (message) => new TrackerError('run-settings-invalid', message);

// The host runs the executable with its arguments directly, without a shell (ruling R21): the
// form of the session-quill plugin's own hooks/hooks.json, verified on claude 2.1.296 for this
// file too (task 8 fix round 1). Nothing is quoted or rewritten, so spaces and backslashes in a
// path reach the process as they are.
function hookCommand({ command, args } = {}) {
  if (!Array.isArray(args) || !args.length) throw invalid('the guard command needs the guard script as its argument');
  for (const p of [command, ...args]) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw invalid('the guard command and its arguments must be absolute paths');
    if (UNSAFE.test(p)) throw invalid('a guard command path holds a character the hook cannot pass through unchanged');
  }
  return { command, args: [...args] };
}

/**
 * Writes `<runDir>/run-settings.json`, readable by the owner only where the OS has file modes,
 * replacing an earlier one atomically.
 * @param {string} runDir  the run's directory (handoffRunDir)
 * @param {{ guardCommand?: { command: string, args: string[] }, permissions?: { deny?: string[] }, observe?: boolean }} opts
 *   guardCommand: the node binary and the guard script, absolute (default: this node and this
 *   install's bin/quill-guard.js); permissions.deny: deny rules the caller adds (default none).
 *   No allow rules are written: every P0 hook-allow probe passed, so no family needs a fallback.
 *   observe: a full-access run's observer. Its hook has no `onFailure: "block"`, because a
 *   full-access call is never refused, not even when the observer fails.
 * @returns {string} the settings file path
 */
export function writeRunSettings(runDir, { guardCommand = { command: process.execPath, args: [GUARD_BIN] }, permissions = {}, observe = false } = {}) {
  const deny = permissions && permissions.deny !== undefined ? permissions.deny : [];
  if (!Array.isArray(deny) || !deny.every((r) => typeof r === 'string' && r.trim())) throw invalid('permissions.deny must be a list of rule strings');
  const settings = {
    permissions: { allow: [], deny: [...deny] },
    hooks: {
      PreToolUse: [{ matcher: GUARD_MATCHER, hooks: [{ type: 'command', ...hookCommand(guardCommand), timeout: GUARD_TIMEOUT_S, ...(observe ? {} : { onFailure: 'block' }) }] }],
    },
  };
  const dest = path.join(runDir, RUN_SETTINGS_FILE);
  ensureDir(runDir);
  const tmp = tempPathFor(dest);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(settings, null, 2)}\n`);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  fs.closeSync(fd);
  renameAtomic(tmp, dest);
  return dest;
}
