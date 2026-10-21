// Measures hook and status-line latency as the host sees it: a fresh `node` process per call,
// stdin JSON in, decision out. Prints p50/p95/p99/max for a bare `node` start, each hook event the
// plugin runs per tool call or session, the status-line script, and the in-process hook logic
// (`runHook`, no process start-up), which is what ADR 0034's KPI bounds.
//
//   node scripts/bench-hooks.mjs [--calls 200] [--entry bin/quill.js] [--json] [--baseline <checkout>]
//
// `--entry bin/quill.js` adds the full CLI entry (`quill hook <Event>`) for comparison. `--json`
// prints one JSON object instead of the table (fields: node, platform, calls, cases[] with
// name, p50_ms, p95_ms, p99_ms, max_ms). `--baseline <checkout>` measures every process case of
// another checkout too, alternating call by call with this one so machine load hits both alike;
// its cases carry the suffix " (baseline)".
//
// Uses a throwaway QUILL_HOME with an initialized store, a bound session and a stand-in worker
// (a child process holding the store lock and writing heartbeats, as the worker does), so
// SessionStart takes its normal "worker ready" path and the status line prints a dashboard link.
// Nothing touches ~/.claude/quill or a real worker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeRuntimeIdentity, writeBindingSnapshot } from '../src/hooks/binding-snapshot.js';
import { createStoreMeta, writeStoreMeta } from '../src/config/store.js';
import { defaultUserConfig, saveUserConfig } from '../src/config/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };
const CALLS = Number(flag('calls', 200));
const JSON_OUT = args.includes('--json');
const extraEntry = args.includes('--entry') ? flag('entry') : null;
const baseRoot = args.includes('--baseline') ? path.resolve(flag('baseline')) : null;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-bench-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-bench-repo-'));
const env = { ...process.env, QUILL_HOME: home };
delete env.QUILL_HANDOFF_ID;
delete env.QUILL_HANDOFF_GUARD;
const MACHINE = '22222222-2222-4222-8222-222222222222';
const storePath = path.join(home, 'Quill');
fs.mkdirSync(storePath, { recursive: true });
const meta = { ...createStoreMeta({ store_name: 'Bench', owner_machine_id: MACHINE, timezone: 'UTC' }), store_id: '33333333-3333-4333-8333-333333333333' };
writeStoreMeta(storePath, meta);
fs.writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ machine_id: MACHINE, machine_name: 'bench' }));
saveUserConfig({ ...defaultUserConfig(), store_path: storePath, default_project: 'demo', projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main' } } }, { QUILL_HOME: home });
writeRuntimeIdentity({ store_id: meta.store_id, machine_id: MACHINE, store_path: storePath, gate_enabled: true, gate_mode: 'nudge', approval_phrases_enabled: false, allow_tools: [], tracker: null, default_project_id: 'demo', repos: [{ repo_id: 'demo', path: repo, project_id: 'demo', gate_mode: 'nudge', tracker: null }] }, { QUILL_HOME: home });
writeBindingSnapshot('bench', { ticket_id: '00000001-0000-4000-8000-000000000000', ticket_key: 'DEV-1', ticket_title: 'Bench', binding_revision: 1, gate_enabled: true, has_title: true, ticket_has_description: true }, { QUILL_HOME: home });

// The stand-in worker: owns the store lock (the named pipe / socket) and refreshes the heartbeat
// and dashboard endpoint, so readiness checks and the status line see a healthy worker.
const holderSrc = `
import { acquireLock } from ${JSON.stringify(pathToFileURL(path.join(root, 'src/worker/lock.js')).href)};
import { writeHeartbeat } from ${JSON.stringify(pathToFileURL(path.join(root, 'src/hooks/binding-snapshot.js')).href)};
import fs from 'node:fs';
import path from 'node:path';
await acquireLock(${JSON.stringify(meta.store_id)}, ${JSON.stringify(MACHINE)});
fs.writeFileSync(path.join(process.env.QUILL_HOME, 'state', 'ui-endpoint.json'), JSON.stringify({ host: '127.0.0.1', port: 47999, pid: process.pid, started_at: new Date().toISOString() }));
const beat = () => writeHeartbeat({ at: new Date().toISOString(), pid: process.pid });
beat();
setInterval(beat, 1000);
process.stdout.write('ready\\n');
`;
const holder = spawn(process.execPath, ['--input-type=module', '-e', holderSrc], { env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  holder.stdout.once('data', resolve);
  holder.once('exit', (code) => reject(new Error(`stand-in worker exited ${code}`)));
});

function stats(name, times) {
  times.sort((a, b) => a - b);
  const pick = (q) => Number(times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(1));
  return { name, p50_ms: pick(0.5), p95_ms: pick(0.95), p99_ms: pick(0.99), max_ms: Number(times[times.length - 1].toFixed(1)) };
}

// `argv(base)` builds the command line for a checkout root; with --baseline both roots alternate.
function measure(name, argv, input, expect) {
  const roots = baseRoot ? [root, baseRoot] : [root];
  const times = roots.map(() => []);
  for (let i = 0; i < CALLS; i += 1) {
    roots.forEach((base, j) => {
      const started = process.hrtime.bigint();
      const r = spawnSync(process.execPath, argv(base), { input: typeof input === 'function' ? input(i) : input, env, cwd: repo, encoding: 'utf8' });
      times[j].push(Number(process.hrtime.bigint() - started) / 1e6);
      if (r.status !== 0) throw new Error(`${name}: exit ${r.status}: ${r.stderr}`);
      if (expect && i === 0 && !expect(r)) throw new Error(`${name}: unexpected output ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`);
    });
  }
  for (let j = 0; j < roots.length; j += 1) cases.push(stats(j === 0 ? name : `${name} (baseline)`, times[j]));
}

const toolCall = (i) => JSON.stringify({ session_id: 'bench', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, `f${i}.js`) }, tool_use_id: `t${i}`, tool_response: { success: true } });
const sessionStart = JSON.stringify({ session_id: 'bench', cwd: repo, source: 'startup' });
const statusInput = JSON.stringify({ session_id: 'bench', cwd: repo });
const hookBin = (base) => path.join(base, 'bin/quill-hook.js');

const cases = [];
cases.push(stats('bare node start', (() => { const t = []; for (let i = 0; i < CALLS; i += 1) { const s0 = process.hrtime.bigint(); spawnSync(process.execPath, ['-e', ''], { env, cwd: repo }); t.push(Number(process.hrtime.bigint() - s0) / 1e6); } return t; })()));
measure('quill-hook PreToolUse', (b) => [hookBin(b), 'PreToolUse'], toolCall);
measure('quill-hook PostToolUse', (b) => [hookBin(b), 'PostToolUse'], toolCall);
measure('quill-hook SessionStart', (b) => [hookBin(b), 'SessionStart'], sessionStart, (r) => r.stdout.includes('DEV-1') && r.stderr === '');
// The stand-in worker must have counted as ready: a launch attempt would start a real worker.
if (fs.existsSync(path.join(home, 'run', 'worker-start-attempt.json'))) throw new Error('SessionStart tried to launch a worker; the stand-in was not seen as ready');
measure('statusline', (b) => [path.join(b, 'scripts/statusline.js')], statusInput, (r) => r.stdout.startsWith('⌁ DEV-1 Bench') && r.stdout.includes('http://127.0.0.1:47999/'));
if (extraEntry) {
  measure(`${extraEntry} hook PreToolUse`, (b) => [path.join(b, extraEntry), 'hook', 'PreToolUse'], toolCall);
  measure(`${extraEntry} hook PostToolUse`, (b) => [path.join(b, extraEntry), 'hook', 'PostToolUse'], toolCall);
}

// In-process hook logic: what Quill itself adds once Node and the modules are loaded.
const { runHook } = await import('../src/hooks/adapter.js');
for (const event of ['PreToolUse', 'PostToolUse']) {
  const times = [];
  for (let i = 0; i < CALLS; i += 1) {
    const input = JSON.parse(toolCall(10_000 + i));
    const started = process.hrtime.bigint();
    runHook(event, input, { env });
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  cases.push(stats(`in-process runHook ${event}`, times));
}

holder.kill();
await new Promise((resolve) => { if (holder.exitCode !== null) resolve(); else holder.once('exit', resolve); });
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });

if (JSON_OUT) {
  console.log(JSON.stringify({ node: process.version, platform: process.platform, calls: CALLS, cases }, null, 2));
} else {
  console.log(`node ${process.version} on ${process.platform}, ${CALLS} calls each`);
  for (const c of cases) console.log(`${c.name.padEnd(36)} p50 ${String(c.p50_ms).padStart(6)} ms  p95 ${String(c.p95_ms).padStart(6)} ms  p99 ${String(c.p99_ms).padStart(6)} ms  max ${String(c.max_ms).padStart(6)} ms`);
}
