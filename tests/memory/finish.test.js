import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootWorker, makeRepo, until, T1, FAKE_CLAUDE } from '../handoff/helpers.js';
import { memoryPaths } from '../../src/memory/paths.js';
import { Worker } from '../../src/worker/worker.js';
import { derive } from '../../src/reconcile/derive.js';
import { createExtension as handoffExt } from '../../src/handoff/extension.js';
import { journalPath } from '../../src/lib/paths.js';

// Best effort: a git process can still hold the repository on Windows (scripts/test-run.mjs removes the rest).
function cleanup(...dirs) { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* left for the temp root */ } } }

const RID = (n) => `77777777-0000-4000-8000-${String(n).padStart(12, '0')}`;
const readOnly = { mode: 'analyse', note: 'look', permissions: { read_source: true, edit_source: false, commit: false, push_branch: false, open_draft_pr: false }, branch: null };
const fix = { mode: 'attempt-fix', note: 'fix it', permissions: { read_source: true, edit_source: true, commit: false, push_branch: false, open_draft_pr: false }, branch: null };

const RESULT = {
  summary: 'Looked at the module.',
  next_action: 'Read src.js',
  blocker: null,
  children: [],
  attempts: [{ route: 'repo code', tool: 'Read', target: 'src.js', outcome: 'worked', reason: 'found the constant', evidence: 'src.js:1' }],
  learnings: [
    { scope: 'repo', section: 'Conventions', key: null, kind: 'fact', text: 'Constants are exported from src.js', evidence: ['src.js:1'], derived_from: 'repo-file' },
    { scope: 'repo', section: 'Environments', key: null, kind: 'fact', text: 'Kibana index is logs-demo', evidence: ['kibana query'], derived_from: 'tool-output' },
    { scope: 'task', section: '', key: null, kind: 'pitfall', text: 'The ticket is about the constant a', evidence: ['src.js:1'], derived_from: 'repo-file' },
  ],
};

async function run(b, rid, payload) {
  const t = b.ticket(T1, 'LOCAL-a-00000001');
  b.request(rid, { target_id: T1, expected_revision: t.revision, payload });
  b.w.tick();
  const hid = b.w.state.requests.get(rid).result.handoff_id;
  // Filing finishes after the run's terminal state is recorded (the cited files are read asynchronously).
  const h = await until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return ['done', 'failed', 'timed-out', 'cancelled'].includes(x.state) && !b.hext.runningIds().has(hid) && x.memory_filing ? x : null; }, { timeoutMs: 20_000 });
  b.w.tick();
  return b.w.state.handoffs.get(h.id);
}

test('a done run files its learnings by provenance, records the summary and Run notes, and the worker writes the projections', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, fakeEnv: { FAKE_CLAUDE_RESULT: JSON.stringify(RESULT) }, runtimeAvailable: true });
  try {
    const h = await run(b, RID(1), readOnly);
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    const entries = [...b.w.state.memory.entries.values()];
    const byText = (t) => entries.find((e) => e.text === t);
    assert.equal(byText('Constants are exported from src.js').trust, 'sourced', 'checked against the checkout before it was removed');
    assert.equal(byText('Constants are exported from src.js').section, 'conventions');
    assert.equal(byText('Kibana index is logs-demo').trust, 'quarantined');
    assert.equal(byText('The ticket is about the constant a').scope, 'task');
    assert.equal(byText('The ticket is about the constant a').ticket_id, T1);
    assert.equal(h.memory_filing.filed, 3);
    assert.equal(byText('Claude Code 2.1.296 is installed').trust, 'verified', 'the init inventory is a worker-observed fact');
    assert.equal(h.memory_filing.quarantined, 1);
    const notes = b.w.state.tickets.get(T1).run_notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].run_id, h.id);
    assert.equal(notes[0].attempts[0].route, 'repo code');
    assert.deepEqual(notes[0].lessons.map((l) => l.text), ['The ticket is about the constant a']);

    const p = memoryPaths(b.home);
    assert.match(fs.readFileSync(p.repo('demo'), 'utf8'), /Constants are exported from src\.js/);
    assert.match(fs.readFileSync(p.quarantine, 'utf8'), /Kibana index is logs-demo/);
    assert.match(fs.readFileSync(p.repoDocs('demo'), 'utf8'), /README\.md/);
    // Memory and Run notes stay local: nothing under the store (vault notes) carries them.
    const inStore = [];
    const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, n.name); if (n.isDirectory()) walk(f); else inStore.push(fs.readFileSync(f, 'utf8')); } };
    b.w.flushNotes();
    walk(b.storePath);
    assert.equal(inStore.some((t) => /Constants are exported|Kibana index|constant a/.test(t)), false);

    // A second run that learns the same fact confirms it instead of filing it again.
    const before = byText('Constants are exported from src.js').confirmations;
    const h2 = await run(b, RID(2), readOnly);
    assert.equal(h2.state, 'done');
    assert.equal(b.w.state.memory.entries.get(byText('Constants are exported from src.js').id).confirmations, before + 1);
    assert.equal(b.w.state.tickets.get(T1).run_notes.length, 2);
  } finally { await b.w.stop(); cleanup(repo.dir, b.home); }
});

test('a run that does not finish done files none of the learnings of the agent, but files what the worker observed and keeps its attempts in the Run notes', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, fakeEnv: { FAKE_CLAUDE_RESULT: JSON.stringify(RESULT), FAKE_CLAUDE_EDIT: 'src.js' }, runtimeAvailable: true, repoExtra: { test_command: `"${process.execPath}" -e "process.exit(1)"` } });
  try {
    const h = await run(b, RID(3), fix);
    assert.equal(h.state, 'failed');
    const entries = [...b.w.state.memory.entries.values()];
    assert.equal(entries.some((e) => e.derived_from !== 'worker'), false, 'no agent learning is filed');
    const gate = entries.find((e) => e.key && e.key.startsWith('test:'));
    assert.equal(gate.trust, 'verified');
    assert.match(gate.text, /^Worker test gate: .* failed \(exit 1\)$/);
    assert.equal(entries.find((e) => e.key === 'tool:claude-code').text, 'Claude Code 2.1.296 is installed');
    assert.equal(h.memory_filing.filed, 0);
    assert.equal(h.memory_filing.worker.filed, entries.length);
    const notes = b.w.state.tickets.get(T1).run_notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].attempts.length >= 1, true);
    assert.deepEqual(notes[0].lessons, []);
  } finally { await b.w.stop(); cleanup(repo.dir, b.home); }
});

// Fix round 3: a filing lost between the terminal state and the memory events (a stop or crash
// during the asynchronous cite read) is redone at the next start, exactly once.
const isFiling = (e) => e.kind === 'memory-tx' || (e.kind === 'handoff-tx' && e.payload && (e.payload.run_notes || (e.payload.update && e.payload.update.memory_filing)));

async function startAt(b, iso) {
  const w = new Worker({ config: b.config, storeMeta: b.meta, env: b.env, clock: () => Date.parse(iso), derive });
  w.use(handoffExt({ env: b.env, config: b.config, storeMeta: b.meta }, { claudePath: process.execPath, claudeArgs: [FAKE_CLAUDE], runtimeAvailable: true, maxConcurrent: 4 }));
  await w.start();
  return w;
}

test('a run whose memory filing never reached the journal is filed at the next start, once', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, fakeEnv: { FAKE_CLAUDE_RESULT: JSON.stringify(RESULT) }, runtimeAvailable: true });
  let w2 = null;
  let w3 = null;
  try {
    const h = await run(b, RID(4), readOnly);
    assert.equal(h.state, 'done');
    await b.w.stop();
    // Drop every filing event from the journal, as if the worker had stopped before they landed.
    const file = journalPath(b.env);
    const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !isFiling(e));
    fs.writeFileSync(file, kept.map((e, i) => JSON.stringify({ ...e, sequence: i + 1 })).join('\n') + '\n');

    w2 = await startAt(b, '2026-10-02T09:00:00Z');
    const again = w2.state.handoffs.get(h.id);
    assert.ok(again.memory_filing, 'filed again at start');
    assert.equal(again.memory_filing.filed, 3);
    const entries = [...w2.state.memory.entries.values()];
    assert.equal(entries.find((e) => e.text === 'Constants are exported from src.js').trust, 'sourced', 'read at the base commit from the registered repository, the checkout being gone');
    assert.equal(w2.state.tickets.get(T1).run_notes.length, 1);
    await w2.stop();
    w2 = null;
    const count = () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter(isFiling).length;
    const before = count();
    // A further start finds nothing to do and journals nothing twice.
    w3 = await startAt(b, '2026-10-02T09:30:00Z');
    await w3.stop();
    w3 = null;
    assert.equal(count(), before);
  } finally {
    for (const w of [w2, w3]) if (w) await w.stop();
    cleanup(repo.dir, b.home);
  }
});

test('a stop waits for a run that is still filing its memory', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, fakeEnv: { FAKE_CLAUDE_RESULT: JSON.stringify(RESULT) }, runtimeAvailable: true });
  try {
    const t0 = b.ticket(T1, 'LOCAL-a-00000001');
    b.request(RID(5), { target_id: T1, expected_revision: t0.revision, payload: readOnly });
    b.w.tick();
    const hid = b.w.state.requests.get(RID(5)).result.handoff_id;
    // Stop as soon as the run is terminal, without waiting for its filing.
    await until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return ['done', 'failed'].includes(x.state) ? x : null; }, { timeoutMs: 20_000, stepMs: 5 });
    await b.w.stop();
    const lines = fs.readFileSync(journalPath(b.env), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(lines.some((e) => e.kind === 'handoff-tx' && e.payload.handoff_id === hid && e.payload.update && e.payload.update.memory_filing), 'the filing reached the journal before the stop finished');
  } finally { cleanup(repo.dir, b.home); }
});
