// A19 (scaled): hook p95 with a populated store, and proof the hook path never scans the journal.
// Set TRACKER_PERF_FULL=1 to run the full 10,000 tickets / 100,000 events profile; the default keeps
// CI fast with 2,000 tickets / 20,000 events. Results are printed for ACCEPTANCE-RESULTS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scenario, MACHINE } from './scenario.js';
import { makeEvent } from '../../src/core/events.js';
import { journalPath } from '../../src/lib/paths.js';

const FULL = process.env.TRACKER_PERF_FULL === '1';
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
