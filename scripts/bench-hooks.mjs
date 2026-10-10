// Measures hook latency as the host sees it: a fresh `node` process per call, stdin JSON in,
// decision out. Prints p50/p95/max for a bare `node` start and for each hook entry point.
//
//   node scripts/bench-hooks.mjs [--calls 100] [--entry bin/quill.js]
//
// Uses a throwaway QUILL_HOME with a bound session; nothing touches ~/.claude/quill.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeRuntimeIdentity, writeBindingSnapshot } from '../src/hooks/binding-snapshot.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };
const CALLS = Number(flag('calls', 100));
const entries = args.includes('--entry') ? [flag('entry')] : ['bin/quill.js', 'bin/quill-hook.js'].filter((e) => fs.existsSync(path.join(root, e)));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-bench-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-bench-repo-'));
const env = { ...process.env, QUILL_HOME: home };
const STORE = '33333333-3333-4333-8333-333333333333';
writeRuntimeIdentity({ store_id: STORE, machine_id: '22222222-2222-4222-8222-222222222222', store_path: path.join(home, 'Quill'), gate_enabled: true, gate_mode: 'nudge', approval_phrases_enabled: false, allow_tools: [], tracker: null, default_project_id: 'demo', repos: [{ repo_id: 'demo', path: repo, project_id: 'demo', gate_mode: 'nudge', tracker: null }] }, { QUILL_HOME: home });
writeBindingSnapshot('bench', { ticket_id: '00000001-0000-4000-8000-000000000000', ticket_key: 'DEV-1', ticket_title: 'Bench', binding_revision: 1, gate_enabled: true, has_title: true, ticket_has_description: true }, { QUILL_HOME: home });

function measure(argv, input) {
  const times = [];
  for (let i = 0; i < CALLS; i += 1) {
    const started = process.hrtime.bigint();
    const r = spawnSync(process.execPath, argv, { input, env, cwd: repo, encoding: 'utf8' });
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
  }
  times.sort((a, b) => a - b);
  const pick = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(0);
  return `p50 ${pick(0.5)} ms  p95 ${pick(0.95)} ms  max ${times[times.length - 1].toFixed(0)} ms`;
}

const toolCall = (i) => JSON.stringify({ session_id: 'bench', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, `f${i}.js`) }, tool_use_id: `t${i}`, tool_response: { success: true } });

console.log(`node ${process.version} on ${process.platform}, ${CALLS} calls each`);
console.log(`bare node start          ${measure(['-e', ''], '')}`);
for (const entry of entries) {
  const bin = path.join(root, entry);
  console.log(`${entry.padEnd(18)} Pre   ${measure([bin, 'hook', 'PreToolUse'], toolCall(1))}`);
  console.log(`${entry.padEnd(18)} Post  ${measure([bin, 'hook', 'PostToolUse'], toolCall(2))}`);
}
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });
