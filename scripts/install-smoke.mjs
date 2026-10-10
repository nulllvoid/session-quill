// First-run smoke test: what a new user's first session goes through, timed end to end, on a
// throwaway home and a fresh Git repository. It runs the real CLI in child processes:
//
//   1. quill start          (private setup, repository registration, worker launch)
//   2. a SessionStart hook  (what Claude Code sends when the session opens)
//   3. quill ticket work    (Claude's first task, bound to the session)
//   4. an Edit tool call    (PreToolUse + PostToolUse through the plugin's hook entry)
//   5. quill status         (the binding and the captured write are visible)
//   6. quill ui --no-open   (the dashboard link is issued)
//
//   node scripts/install-smoke.mjs [--keep]
//
// Prints each step's duration and exits non-zero on the first failure. Nothing touches
// ~/.claude; the worker it starts is stopped at the end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-smoke-'));
const repo = path.join(base, 'sample-app');
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', repo], { stdio: 'ignore', windowsHide: true });
const env = { ...process.env, QUILL_HOME: path.join(base, 'home') };
const SESSION = 'smoke-session-0001';
const DESC = '**Goal:** Prove a first session is tracked end to end.\n\n**Context:** install-smoke.mjs on a throwaway home.\n\n**Done when:**\n- quill status shows the binding';

const steps = [];
function step(name, argv, { input = '', bin = 'bin/quill.js', expect = null } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, bin), ...argv], { cwd: repo, env, input, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const ms = Date.now() - started;
  const ok = r.status === 0 && (!expect || expect.test(r.stdout));
  steps.push({ name, ms, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(ms).padStart(6)} ms  ${name}`);
  if (!ok) {
    console.log(r.stdout.trim());
    console.log(r.stderr.trim());
    throw new Error(`step failed: ${name}`);
  }
  return r.stdout;
}

const hook = (event, payload) => JSON.stringify({ session_id: SESSION, cwd: repo, hook_event_name: event, ...payload });
let failed = false;
try {
  step('quill start', ['start', '--session', SESSION], { expect: /captured/ });
  step('SessionStart hook', ['SessionStart'], { bin: 'bin/quill-hook.js', input: hook('SessionStart', { source: 'startup' }), expect: /Session Quill session/ });
  const work = step('ticket work (first task)', ['ticket', 'work', 'Try Session Quill', '--description', DESC, '--session', SESSION], { expect: /Working on/ });
  const key = /Working on (\S+)/.exec(work)[1];
  const file = path.join(repo, 'hello.txt');
  step('PreToolUse Write', ['PreToolUse'], { bin: 'bin/quill-hook.js', input: hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: file, content: 'hi' }, tool_use_id: 'toolu_smoke_1' }) });
  fs.writeFileSync(file, 'hi');
  step('PostToolUse Write', ['PostToolUse'], { bin: 'bin/quill-hook.js', input: hook('PostToolUse', { tool_name: 'Write', tool_input: { file_path: file, content: 'hi' }, tool_response: { success: true }, tool_use_id: 'toolu_smoke_1' }) });
  step('quill status', ['status', '--session', SESSION], { expect: new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  step('quill ui --no-open', ['ui', '--no-open'], { expect: /auth\?secret=/ });
} catch (err) {
  failed = true;
  console.log(err.message);
} finally {
  spawnSync(process.execPath, [path.join(root, 'bin/quill.js'), 'worker', 'stop'], { cwd: repo, env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (!keep) fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else console.log(`kept ${base}`);
}
const total = steps.reduce((n, s) => n + s.ms, 0);
console.log(`${failed ? 'FAILED' : 'passed'}: ${steps.filter((s) => s.ok).length}/${steps.length} steps in ${total} ms (node ${process.version}, ${process.platform})`);
process.exitCode = failed ? 1 : 0;
