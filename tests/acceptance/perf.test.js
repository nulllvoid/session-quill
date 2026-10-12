// A19 (scaled): hook p95 with a populated store, and proof the hook path never scans the journal.
// Set QUILL_PERF_FULL=1 to run the full 10,000 tickets / 100,000 events profile; the default keeps
// CI fast with 2,000 tickets / 20,000 events. Results are printed for ACCEPTANCE-RESULTS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scenario, MACHINE } from './scenario.js';
import { makeEvent } from '../../src/core/events.js';
import { journalPath } from '../../src/lib/paths.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyCall } from '../../src/gate/prod-classify.js';
import { decide } from '../../src/gate/run-guard.js';
import { writeGrant } from '../../src/handoff/grant.js';

const FULL = process.env.QUILL_PERF_FULL === '1';
const TICKETS = FULL ? 10_000 : 2_000;
const EVENTS = FULL ? 100_000 : 20_000;
const HOOK_CALLS = 1_000;

function seedJournal(s) {
  const lines = [];
  let seq = 0;
  const push = (ev) => { seq += 1; lines.push(JSON.stringify({ ...ev, sequence: seq, ingested_at: ev.occurred_at })); };
  const tid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const at = (i) => new Date(Date.parse('2026-09-01T00:00:00Z') + i * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (let i = 0; i < TICKETS; i += 1) {
    push(makeEvent({ kind: 'ticket-create', payload: { ticket: { id: tid(i), key: `LOCAL-perf-${i}-${i.toString(16).padStart(8, '0')}`, title: `Perf ticket ${i}`, project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: i % 10 === 0 ? null : tid(i - (i % 10)), repo_id: 'demo', due: null, jira: null } }, store_id: s.meta.store_id, machine_id: MACHINE, producer: 'perf', occurred_at: at(i) }));
  }
  const sessions = 200;
  for (let k = 0; k < sessions; k += 1) {
    push(makeEvent({ kind: 'session-start', payload: { source: 'startup' }, store_id: s.meta.store_id, machine_id: MACHINE, producer: 'perf', session_id: `perf-${k}`, occurred_at: at(TICKETS + k) }));
    push(makeEvent({ kind: 'bind', payload: { ticket_id: tid(k * 7 % TICKETS), project_id: 'demo' }, store_id: s.meta.store_id, machine_id: MACHINE, producer: 'perf', session_id: `perf-${k}`, occurred_at: at(TICKETS + k) }));
  }
  let i = 0;
  while (lines.length < EVENTS) {
    const sess = `perf-${i % sessions}`;
    const call = `c${i}`;
    push(makeEvent({ kind: 'pre-tool', payload: { tool_name: 'Edit' }, store_id: s.meta.store_id, machine_id: MACHINE, producer: 'perf', session_id: sess, tool_call_id: call, occurred_at: at(TICKETS + sessions + i), source_identity: `pre:${sess}:${call}` }));
    push(makeEvent({ kind: 'post-tool', payload: { tool_name: 'Edit', write_paths: [`src/f${i % 50}.js`], repo_id: 'demo', success: true }, store_id: s.meta.store_id, machine_id: MACHINE, producer: 'perf', session_id: sess, tool_call_id: call, occurred_at: at(TICKETS + sessions + i), source_identity: `post:${sess}:${call}` }));
    i += 1;
  }
  fs.mkdirSync(path.dirname(journalPath(s.env)), { recursive: true });
  fs.writeFileSync(journalPath(s.env), lines.join('\n') + '\n');
  return lines.length;
}

test(`A19 (scaled ${TICKETS} tickets / ${EVENTS} events): replay completes, hook p95 <= 200 ms, and the hook path never reads the journal`, async () => {
  const s = scenario();
  const total = seedJournal(s);
  const t0 = process.hrtime.bigint();
  await s.start();
  const replayMs = Number(process.hrtime.bigint() - t0) / 1e6;
  try {
    assert.equal(s.w.state.tickets.size, TICKETS);
    assert.ok(s.w.journal.lastSequence >= total);
    s.hookIdentity();
    const session = 'perf-3';
    const journalFile = path.resolve(journalPath(s.env));
    const reads = [];
    const origRead = fs.readFileSync;
    const origOpen = fs.openSync;
    fs.readFileSync = function spyRead(p, ...rest) { if (typeof p === 'string' && path.resolve(p) === journalFile) reads.push('read'); return origRead.call(fs, p, ...rest); };
    fs.openSync = function spyOpen(p, ...rest) { if (typeof p === 'string' && path.resolve(p) === journalFile) reads.push('open'); return origOpen.call(fs, p, ...rest); };
    const durations = [];
    try {
      for (let i = 0; i < HOOK_CALLS; i += 1) {
        const started = process.hrtime.bigint();
        const r = s.hook('PreToolUse', { session_id: session, tool_name: 'Edit', tool_input: { file_path: `C:/repo/src/x${i}.js` }, tool_use_id: `perf-${i}` });
        durations.push(Number(process.hrtime.bigint() - started) / 1e6);
        assert.equal(r.stdout, '', 'bound perf session passes through');
      }
    } finally {
      fs.readFileSync = origRead;
      fs.openSync = origOpen;
    }
    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(durations.length * 0.5)];
    const p95 = durations[Math.floor(durations.length * 0.95)];
    const max = durations[durations.length - 1];
    const t1 = process.hrtime.bigint();
    const ingested = s.w.ingestOnce();
    const ingestMs = Number(process.hrtime.bigint() - t1) / 1e6;
    const t2 = process.hrtime.bigint();
    s.w.publishGeneration();
    const publishMs = Number(process.hrtime.bigint() - t2) / 1e6;
    console.log(`A19 scaled: platform=${process.platform} node=${process.versions.node} tickets=${TICKETS} events=${total} replay=${replayMs.toFixed(0)}ms hook p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms ingest(${ingested})=${ingestMs.toFixed(0)}ms publish=${publishMs.toFixed(0)}ms journalReadsDuringHooks=${reads.length}`);
    assert.equal(reads.length, 0, 'hook path never scans events.jsonl');
    assert.ok(p95 <= 200, `hook p95 ${p95.toFixed(1)} ms exceeds 200 ms`);
    assert.equal(ingested, HOOK_CALLS);
  } finally {
    await s.stop({ flush: false });
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ autonomous-run guard latency
// Spec §4.1: decide() < 5 ms p95 in-process, the whole guard hook p95 <= 200 ms. Strict targets
// run only in the serial perf job (QUILL_PERF_FULL=1, rulings R14/R16); the main suite, which runs
// test files in parallel on every OS, asserts loose regression ceilings with the same measurement.
// Each measurement is the best p95 of up to three passes, so one stalled pass is not a regression.
const IN_PROCESS_P95 = FULL ? 5 : 25;
const SPAWN_P95 = FULL ? 200 : 1000;

// Stops early once a pass meets `met`.
function bestP95(n, met, once) {
  let best = Infinity;
  for (let pass = 0; pass < 3 && !met(best); pass += 1) {
    const times = [];
    for (let i = 0; i < n; i += 1) times.push(once(i));
    times.sort((a, b) => a - b);
    best = Math.min(best, times[Math.floor(times.length * 0.95)]);
  }
  return best;
}
const timed = (fn) => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };

const fixtureRows = JSON.parse(fs.readFileSync(new URL('../fixtures/prod-classify.json', import.meta.url), 'utf8')).filter((r) => r.tool !== 'SomeFutureTool');

function guardRun() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'quill-guard-perf-')));
  const qh = path.join(root, 'quill');
  const runDir = path.join(qh, 'handoffs', 'runs', 'perf1');
  const checkout = path.join(qh, 'handoffs', 'worktrees', 'perf1');
  const tmp = path.join(root, 'tmp');
  for (const d of [runDir, path.join(checkout, 'src'), path.join(checkout, '.git'), tmp, path.join(root, 'home')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(checkout, 'src', 'app.js'), 'x\n');
  fs.writeFileSync(path.join(checkout, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
  const grant = {
    access: 'autonomous', permissions: { read_source: true, edit_source: true, commit: true }, actionPins: [],
    scopes: [{ name: 'k8s.write', target: 'stg', matchers: { bash: ['kubectl *'], mcp: [], hosts: [] }, fingerprint: 'f' }],
    readableRoots: [checkout, runDir, tmp], writableRoots: [checkout, runDir, tmp], protectedPaths: [],
    mcpPolicy: { read: [], write: {} }, trustedMcpServers: [], trackerHosts: [], defaultBranch: 'main',
  };
  const vars = { USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home'), TEMP: tmp, TMP: tmp, TMPDIR: tmp, QUILL_HOME: qh, QUILL_HANDOFF_ID: 'perf1', QUILL_HANDOFF_GUARD: 'enforce' };
  return { root, runDir, checkout, grant, vars };
}

test(`guard latency: classifier and decide p95 < ${IN_PROCESS_P95} ms over 1,000 mixed calls`, () => {
  const r = guardRun();
  try {
    const ctx = { cwd: r.checkout, home: r.vars.HOME, env: r.vars, currentBranch: 'feat/x', defaultBranch: 'main', mcpPolicy: { read: [], write: {} } };
    const quick = (p95) => p95 < IN_PROCESS_P95;
    const classifyP95 = bestP95(1000, quick, (i) => {
      const row = fixtureRows[i % fixtureRows.length];
      return timed(() => classifyCall({ tool_name: row.tool, tool_input: row.input }, { ...ctx, ...(row.ctx ?? {}) }));
    });
    const calls = [
      { tool_name: 'Read', tool_input: { file_path: path.join(r.checkout, 'src', 'app.js') } },
      { tool_name: 'Edit', tool_input: { file_path: path.join(r.checkout, 'src', 'app.js'), old_string: 'x', new_string: 'y' } },
      { tool_name: 'Write', tool_input: { file_path: path.join(r.root, 'outside.txt'), content: 'x' } },
      { tool_name: 'Grep', tool_input: { pattern: 'x', path: path.join(r.checkout, 'src') } },
      { tool_name: 'Glob', tool_input: { pattern: 'src/**/*.js' } },
      { tool_name: 'mcp__claude_ai_Atlassian__getJiraIssue', tool_input: { issueIdOrKey: 'X-1' } },
      ...fixtureRows.filter((row) => /^(Bash|PowerShell)$/.test(row.tool)).slice(0, 60).map((row) => ({ tool_name: row.tool, tool_input: row.input })),
    ];
    const env = { cwd: r.checkout, vars: r.vars, currentBranch: 'feat/x', defaultBranch: 'main' };
    const decideP95 = bestP95(1000, quick, (i) => timed(() => decide(calls[i % calls.length], r.grant, env)));
    console.log(`guard in-process (${FULL ? 'strict' : 'loose'}): classify p95=${classifyP95.toFixed(3)}ms decide p95=${decideP95.toFixed(3)}ms over 1,000 calls`);
    assert.ok(classifyP95 < IN_PROCESS_P95, `classifier p95 ${classifyP95.toFixed(3)} ms`);
    assert.ok(decideP95 < IN_PROCESS_P95, `decide p95 ${decideP95.toFixed(3)} ms`);
  } finally {
    fs.rmSync(r.root, { recursive: true, force: true });
  }
});

test(`guard latency: bin/quill-guard.js process p95 <= ${SPAWN_P95} ms over 50 spawns`, () => {
  const guardBin = fileURLToPath(new URL('../../bin/quill-guard.js', import.meta.url));
  const r = guardRun();
  try {
    const { sha256 } = writeGrant(r.runDir, r.grant);
    const env = { ...process.env, ...r.vars, QUILL_HANDOFF_GRANT_SHA256: sha256 };
    delete env.NODE_ENV;
    const inputs = [
      { tool_name: 'Read', tool_input: { file_path: path.join(r.checkout, 'src', 'app.js') } },
      { tool_name: 'Bash', tool_input: { command: 'git commit -m wip && git status' } },
      { tool_name: 'Bash', tool_input: { command: 'kubectl --context prod delete pod x' } },
    ].map((c) => JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', cwd: r.checkout, ...c }));
    const p95 = bestP95(50, (v) => v <= SPAWN_P95, (i) => {
      let out;
      const ms = timed(() => { out = spawnSync(process.execPath, [guardBin], { input: inputs[i % inputs.length], env, encoding: 'utf8' }); });
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /"permissionDecision":"(allow|deny)"/);
      return ms;
    });
    console.log(`guard process (${FULL ? 'strict' : 'loose'}): p95=${p95.toFixed(1)}ms over 50 spawns on ${process.platform}`);
    assert.ok(p95 <= SPAWN_P95, `guard process p95 ${p95.toFixed(1)} ms`);
  } finally {
    fs.rmSync(r.root, { recursive: true, force: true });
  }
});
