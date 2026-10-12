// The per-run Claude Code settings file (spec §4.1). The worker passes `--settings
// <runDir>/run-settings.json` to an autonomous run's `claude` process; the file wires
// bin/quill-guard.js in as a PreToolUse hook for every tool family the guard decides, and blocks
// the call when the hook fails or times out. It does not depend on the session-quill plugin.
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

// Characters that some shell would still expand or end inside double quotes (bash: " $ ` and
// newlines; cmd: % and "), so a path holding one cannot be quoted safely and is refused.
const UNQUOTABLE = /["$`%\r\n\0]/;

const invalid = (message) => new TrackerError('run-settings-invalid', message);

// The hook command as one string, the form P0 verified on claude 2.1.296 (`node "<script>"`, see
// scripts/probe-autonomous.mjs): every part is an absolute path in double quotes. Forward slashes
// work for node and for both shells, and leave no backslash for bash to read as an escape.
function commandLine({ command, args } = {}) {
  const parts = [command, ...(Array.isArray(args) ? args : [])];
  if (!Array.isArray(args) || !args.length) throw invalid('the guard command needs the guard script as its argument');
  for (const p of parts) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw invalid('the guard command and its arguments must be absolute paths');
    if (UNQUOTABLE.test(p)) throw invalid('a guard command path holds a character that cannot be quoted for every shell');
  }
  return parts.map((p) => `"${p.replaceAll('\\', '/')}"`).join(' ');
}

/**
 * Writes `<runDir>/run-settings.json`, readable by the owner only where the OS has file modes,
 * replacing an earlier one atomically.
 * @param {string} runDir  the run's directory (handoffRunDir)
 * @param {{ guardCommand?: { command: string, args: string[] }, permissions?: { deny?: string[] } }} opts
 *   guardCommand: the node binary and the guard script, absolute (default: this node and this
 *   install's bin/quill-guard.js); permissions.deny: deny rules the caller adds (default none).
 *   No allow rules are written: every P0 hook-allow probe passed, so no family needs a fallback.
 * @returns {string} the settings file path
 */
export function writeRunSettings(runDir, { guardCommand = { command: process.execPath, args: [GUARD_BIN] }, permissions = {} } = {}) {
  const deny = permissions && permissions.deny !== undefined ? permissions.deny : [];
  if (!Array.isArray(deny) || !deny.every((r) => typeof r === 'string' && r.trim())) throw invalid('permissions.deny must be a list of rule strings');
  const settings = {
    permissions: { allow: [], deny: [...deny] },
    hooks: {
      PreToolUse: [{ matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: commandLine(guardCommand), timeout: GUARD_TIMEOUT_S, onFailure: 'block' }] }],
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
