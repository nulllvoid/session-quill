import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootWorker, makeRepo, until, T1 } from '../handoff/helpers.js';
import { memoryPaths } from '../../src/memory/paths.js';

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
  const h = await until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return ['done', 'failed', 'timed-out', 'cancelled'].includes(x.state) && !b.hext.runningIds().has(hid) ? x : null; }, { timeoutMs: 20_000 });
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

test('a run that does not finish done files nothing but keeps what it attempted in the Run notes', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, fakeEnv: { FAKE_CLAUDE_RESULT: JSON.stringify(RESULT), FAKE_CLAUDE_EDIT: 'src.js' }, runtimeAvailable: true, repoExtra: { test_command: `"${process.execPath}" -e "process.exit(1)"` } });
  try {
    const h = await run(b, RID(3), fix);
    assert.equal(h.state, 'failed');
    assert.equal(b.w.state.memory.entries.size, 0);
    assert.equal(h.memory_filing, undefined);
    const notes = b.w.state.tickets.get(T1).run_notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].attempts.length >= 1, true);
    assert.deepEqual(notes[0].lessons, []);
  } finally { await b.w.stop(); cleanup(repo.dir, b.home); }
});
