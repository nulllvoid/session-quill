// Phase 1 — persistence, attribution and recovery (ACCEPTANCE.md A08–A14, A16–A18, A20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scenario, T1, T2, RID, until } from './scenario.js';
import { Journal } from '../../src/core/journal.js';
import { journalPath, projectionsDir } from '../../src/lib/paths.js';
import { listIngress } from '../../src/core/ingress.js';
import { getBlob } from '../../src/core/blobs.js';
import { parseNote, writeNote } from '../../src/worker/notes.js';
import { acquireLock } from '../../src/worker/lock.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { main } from '../../src/cli/main.js';
import { replayToStaging } from '../../src/cli/commands/sync.js';

const cli = async (argv, env) => { let out = ''; let err = ''; const code = await main(argv, { env, stdout: (x) => { out += x; }, stderr: (x) => { err += x; }, stdin: async () => '' }); return { code, out, err }; };

test('A08 parallel sessions on one ticket and on different tickets lose nothing; a rebind while a tool is in flight keeps the result on the original ticket', async () => {
  const s = await scenario().start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    s.ticket(T2, 'LOCAL-b-00000002');
    s.bind('p1', T1);
    s.bind('p2', T1);
    s.bind('p3', T2);
    for (const [sess, i] of [['p1', 1], ['p2', 2], ['p3', 3], ['p1', 4], ['p2', 5]]) {
      s.ingest('pre-tool', { tool_name: 'Edit' }, { session_id: sess, tool_call_id: `c${i}`, source_identity: `pre:${sess}:c${i}` });
      s.ingest('post-tool', { tool_name: 'Edit', write_paths: [`f${i}.js`], repo_id: 'demo', success: true }, { session_id: sess, tool_call_id: `c${i}`, source_identity: `post:${sess}:c${i}` });
    }
    s.w.tick();
    assert.equal(s.w.state.tickets.get(T1).files_touched_count, 4);
    assert.equal(s.w.state.tickets.get(T2).files_touched_count, 1);
    s.ingest('pre-tool', { tool_name: 'Write' }, { session_id: 'p3', tool_call_id: 'inflight', source_identity: 'pre:p3:inflight' });
    s.w.tick();
    s.ingest('bind', { ticket_id: T1, project_id: 'demo' }, { session_id: 'p3' });
    s.w.tick();
    s.ingest('post-tool', { tool_name: 'Write', write_paths: ['late.js'], repo_id: 'demo', success: true }, { session_id: 'p3', tool_call_id: 'inflight', source_identity: 'post:p3:inflight' });
    s.w.tick();
    assert.equal(s.w.state.tickets.get(T2).files_touched_count, 2, 'in-flight result lands on the ticket bound before execution');
    assert.equal(s.w.state.tickets.get(T1).files_touched_count, 4);
  } finally { await s.stop(); }
});

test('A09 forced termination at each stage preserves every acknowledged event and only complete generations are published', async () => {
  const s = await scenario().start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    // Stage 1: ingress flushed, worker dies before ingesting
    s.ingest('ticket-update', { ticket_id: T1, fields: { next_action: 'stage-1' }, source: 'manual' });
    await s.stop({ flush: false });
    assert.equal(listIngress(s.env).length, 1, 'ingress retained');
    await s.start();
    assert.equal(s.w.state.tickets.get(T1).next_action, 'stage-1', 'drained on restart');
    // Stage 2: journal appended, notes not flushed
    s.ingest('ticket-update', { ticket_id: T1, fields: { next_action: 'stage-2' }, source: 'manual' });
    s.w.ingestOnce();
    await s.stop({ flush: false });
    await s.start();
    assert.equal(s.w.state.tickets.get(T1).next_action, 'stage-2');
    // Stage 3: a half-written generation directory without a manifest update is never served
    const manifest = JSON.parse(fs.readFileSync(path.join(projectionsDir(s.env), 'MANIFEST.json'), 'utf8'));
    fs.mkdirSync(path.join(projectionsDir(s.env), 'gen-99999999'), { recursive: true });
    fs.writeFileSync(path.join(projectionsDir(s.env), 'gen-99999999', 'snapshot.json'), '{"partial":');
    await s.stop({ flush: false });
    await s.start();
    const after = JSON.parse(fs.readFileSync(path.join(projectionsDir(s.env), 'MANIFEST.json'), 'utf8'));
    assert.notEqual(after.path, 'gen-99999999');
    const snap = JSON.parse(fs.readFileSync(path.join(projectionsDir(s.env), after.path, 'snapshot.json'), 'utf8'));
    assert.equal(snap.generation_id, after.generation_id);
    void manifest;
  } finally { await s.stop(); }
});

test('A10 redelivered tool events, approvals and mutation requests have exactly one effect', async () => {
  const s = await scenario({ withServer: true }).start();
  try {
    const t = s.ticket(T1, 'LOCAL-a-00000001');
    s.bind('d1', T1);
    const pre = s.mk('pre-tool', { tool_name: 'Edit' }, { session_id: 'd1', tool_call_id: 'dup', source_identity: 'pre:d1:dup' });
    const post = s.mk('post-tool', { tool_name: 'Edit', write_paths: ['dup.js'], repo_id: 'demo', success: true }, { session_id: 'd1', tool_call_id: 'dup', source_identity: 'post:d1:dup' });
    const { writeIngress } = await import('../../src/core/ingress.js');
    writeIngress(pre, s.env); writeIngress(post, s.env); s.w.tick();
    writeIngress(pre, s.env); writeIngress(post, s.env); s.w.tick();
    writeIngress({ ...post, event_id: '99999999-9999-4999-8999-999999999999' }, s.env); s.w.tick();
    const tk = s.w.state.tickets.get(T1);
    assert.equal(tk.files_touched_count, 1);
    assert.equal(tk.timeline.filter((e) => e.kind === 'write').length, 1);
    s.ingest('stop', { content_ref: 'a'.repeat(64), preview: 'p', length: 1, complete: true }, { session_id: 'd1' });
    s.w.tick();
    const cp = [...s.w.state.checkpoints.values()][0];
    for (let i = 0; i < 3; i += 1) s.ingest('approve', { checkpoint_id: cp.id, ticket_id: T1, provenance: 'explicit' }, { session_id: 'd1', source_identity: `approve:${cp.id}:${T1}` });
    s.w.tick();
    assert.equal(tk.plans.length, 1);
    const c = await s.client();
    const body = { id: RID(3), kind: 'set-next-action', target_id: T1, expected_revision: tk.revision, payload: { next_action: 'once' } };
    const a = await (await c.post('/v1/requests', body)).json();
    const b = await (await c.post('/v1/requests', body)).json();
    assert.equal(a.id, b.id);
    s.advance(10_000); await s.settle();
    assert.equal([...s.w.state.requests.values()].length, 1);
    assert.equal(s.w.state.tickets.get(T1).revision, 6, 'create, bind, one write, one checkpoint, one approval and one edit: six revisions despite redelivery');
  } finally { await s.stop(); }
});

test('A11 a single event materializes within 30 s and continuous events cannot extend the first deadline', async () => {
  const s = await scenario().start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    s.w.flushNotes();
    const note = s.notePath('LOCAL-a-00000001');
    s.ingest('ticket-update', { ticket_id: T1, fields: { next_action: 'first' }, source: 'manual' });
    s.w.tick();
    for (let i = 1; i <= 5; i += 1) { s.advance(5_000); s.ingest('ticket-update', { ticket_id: T1, fields: { next_action: `more-${i}` }, source: 'manual' }); s.w.tick(); }
    assert.equal(parseNote(fs.readFileSync(note, 'utf8')).frontmatter.next_action, '', 'not yet (25 s elapsed)');
    s.advance(5_000);
    s.w.tick();
    assert.equal(parseNote(fs.readFileSync(note, 'utf8')).frontmatter.next_action, 'more-5', 'materialized at the 30 s deadline from the first event');
  } finally { await s.stop(); }
});

test('A12 worker down with writable disk keeps capturing with a visible backlog; unusable disk gives no false receipt and does not block', async () => {
  const s = scenario();
  s.hookIdentity();
  const r1 = s.hook('Stop', { session_id: 'down-1', last_assistant_message: 'captured while down' });
  assert.equal(r1.persisted, true);
  const status = await cli(['status', '--json'], s.env);
  assert.equal(JSON.parse(status.out).backlog, 1);
  assert.equal(JSON.parse(status.out).worker.healthy, false);
  await s.start();
  assert.equal(listIngress(s.env).length, 0, 'restart drains the backlog');
  assert.equal(s.w.state.checkpoints.size, 1);
  await s.stop();
  fs.rmSync(path.join(s.home, 'ingress'), { recursive: true, force: true });
  fs.writeFileSync(path.join(s.home, 'ingress'), 'not a directory');
  const r2 = s.hook('Stop', { session_id: 'down-1', last_assistant_message: 'lost' });
  assert.equal(r2.exitCode, 0, 'non-gate hook never blocks the session');
  assert.equal(r2.persisted, false, 'no false receipt');
  assert.match(r2.stderr, /capture gap/);
});

test('A13 worker/binding unavailable denies covered writes; gate off allows with a visible record; gate on restores enforcement', async () => {
  const s = await scenario().start();
  try {
    s.hookIdentity();
    s.ticket(T1, 'LOCAL-a-00000001');
    s.bind('g1', T1);
    s.advance(60_000); // heartbeat on disk is now stale relative to the hook clock
    const stale = s.hook('PreToolUse', { session_id: 'g1', tool_name: 'Edit', tool_input: { file_path: 'C:/repo/a.js' }, tool_use_id: 'g-1' });
    assert.match(stale.stdout, /worker unavailable/);
    s.w.heartbeat(true);
    s.ingest('gate-off', {}, { session_id: 'g1' });
    s.ingest('bind', { ticket_id: null, project_id: 'demo' }, { session_id: 'g1' });
    s.w.tick();
    const off = s.hook('PreToolUse', { session_id: 'g1', tool_name: 'Edit', tool_input: { file_path: 'C:/repo/a.js' }, tool_use_id: 'g-2' });
    assert.equal(off.stdout, '', 'gate off: unbound write allowed');
    assert.equal(s.w.state.tickets.get(T1).timeline.some((e) => /gate off/.test(e.text)), true, 'audited');
    s.ingest('gate-on', {}, { session_id: 'g1' });
    s.w.tick();
    const on = s.hook('PreToolUse', { session_id: 'g1', tool_name: 'Edit', tool_input: { file_path: 'C:/repo/a.js' }, tool_use_id: 'g-3' });
    assert.match(on.stdout, /"deny"/);
  } finally { await s.stop(); }
});

test('A14 checkpoints longer than 1,500 characters stay fully retrievable and replayable; duplicate approval is idempotent; incomplete checkpoints cannot be promoted', async () => {
  const s = await scenario().start();
  try {
    s.hookIdentity();
    s.ticket(T1, 'LOCAL-a-00000001');
    s.bind('cp1', T1);
    const long = 'L'.repeat(4000);
    s.hook('Stop', { session_id: 'cp1', last_assistant_message: long });
    s.w.tick();
    const cp = [...s.w.state.checkpoints.values()][0];
    assert.equal(cp.preview.length, 1500);
    assert.equal(getBlob(cp.content_ref, s.env), long);
    const a1 = await s.ticking(() => cli(['approve', '--session', 'cp1'], s.env));
    assert.equal(a1.code, 0, a1.err);
    const a2 = await s.ticking(() => cli(['approve', '--session', 'cp1'], s.env));
    assert.match(a2.out, /already approved/);
    assert.equal(s.w.state.tickets.get(T1).plans.length, 1);
    s.hook('Stop', { session_id: 'cp1' });
    s.w.tick();
    const incomplete = [...s.w.state.checkpoints.values()].find((c) => !c.complete);
    assert.ok(incomplete);
    const a3 = await s.ticking(() => cli(['approve', '--session', 'cp1', '--checkpoint', incomplete.id], s.env));
    assert.notEqual(a3.code, 0);
    assert.match(a3.err, /unknown, incomplete/);
    await s.stop({ flush: false });
    await s.start();
    assert.equal(getBlob([...s.w.state.checkpoints.values()].find((c) => c.complete).content_ref, s.env), long, 'replay keeps the full checkpoint');
  } finally { await s.stop(); }
});

test('A16 authored text survives update and replay byte-for-byte; edited generated blocks conflict; explicit import creates events; journal-only rebuild reports missing authored files', async () => {
  const s = await scenario().start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    s.w.flushNotes();
    const note = s.notePath('LOCAL-a-00000001');
    const authored = '\r\nMy summary with trailing spaces   \r\n\r\n';
    fs.writeFileSync(note, fs.readFileSync(note, 'utf8').replace('## Summary\n\n', `## Summary\n${authored}`));
    s.ingest('ticket-update', { ticket_id: T1, fields: { next_action: 'bump' }, source: 'manual' });
    s.w.tick(); s.w.flushNotes();
    assert.equal(parseNote(fs.readFileSync(note, 'utf8')).authored.summary, authored);
    const staging = path.join(s.home, 'staging');
    const summary = replayToStaging(s.ctx, staging);
    assert.equal(parseNote(fs.readFileSync(path.join(staging, 'tickets', 'LOCAL-a-00000001.md'), 'utf8')).authored.summary, authored, 'replay recovers authored text from the live store');
    assert.equal(summary.authoredMissing, 0);
    fs.unlinkSync(note);
    const summary2 = replayToStaging(s.ctx, path.join(s.home, 'staging2'));
    assert.equal(summary2.authoredMissing, 1, 'journal alone does not claim to recover authored text');
    s.w.markStaleNotesDirty();
    s.w.flushNotes();
    const text = fs.readFileSync(note, 'utf8');
    fs.writeFileSync(note, text.replace('· status · Created (manual)', '· status · Created (HACKED)'));
    s.ingest('ticket-update', { ticket_id: T1, fields: { next_action: 'again' }, source: 'manual' });
    s.w.tick(); s.w.flushNotes();
    assert.ok(s.w.state.tickets.get(T1).validation_issues.some((i) => i.startsWith('generated-block-edited')));
    assert.match(fs.readFileSync(note, 'utf8'), /HACKED/, 'original file kept on conflict');
    const r = await cli(['note', 'restore', 'LOCAL-a-00000001'], s.env);
    assert.equal(r.code, 0, r.err);
    s.w.tick();
    assert.equal(/HACKED/.test(fs.readFileSync(note, 'utf8')), false, 'explicit restore rewrites generated blocks');
    const imp = fs.readFileSync(note, 'utf8').replace('priority: P2', 'priority: P0');
    fs.writeFileSync(note, imp);
    const im = await s.ticking(() => cli(['import', note], s.env));
    assert.equal(im.code, 0, im.err);
    s.w.tick();
    assert.equal(s.w.state.tickets.get(T1).priority, 'P0');
    const j = new Journal(journalPath(s.env)); j.open();
    assert.ok([...j.read()].some((e) => e.kind === 'import'), 'import created a journal event');
    j.close();
  } finally { await s.stop(); }
});

test('A17 duplicate slugs and child allocations yield distinct keys; relink preserves ids/history/aliases; collision, traversal, self-parent and cycles are rejected; Jira offline stays pending and bindable', async () => {
  const s = await scenario().start();
  const run = (argv) => s.ticking(() => cli(argv, s.env));
  try {
    const a = await run(['ticket', 'create', 'Same title', '--session', 'k1']);
    const b = await run(['ticket', 'create', 'Same title', '--session', 'k1']);
    const ka = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(a.out)[1];
    const kb = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(b.out)[1];
    assert.notEqual(ka, kb);
    const c1 = await run(['ticket', 'create', 'Child', '--parent', ka, '--session', 'k1']);
    const c2 = await run(['ticket', 'create', 'Child', '--parent', ka, '--session', 'k1']);
    assert.match(c1.out, new RegExp(`${ka}\\.1`));
    assert.match(c2.out, new RegExp(`${ka}\\.2`));
    const idBefore = s.w.state.keyIndex.get(ka);
    const rl = await run(['ticket', 'relink', ka, '--jira', 'PMLA-7', '--session', 'k1']);
    assert.equal(rl.code, 0, rl.err);
    const t = s.w.state.tickets.get(idBefore);
    assert.equal(t.key, 'PMLA-7');
    assert.deepEqual(t.aliases, [ka]);
    assert.equal(t.jira.validation, 'pending');
    assert.ok(t.timeline.length >= 2, 'history preserved');
    const bindAlias = await run(['ticket', 'bind', ka, '--session', 'k2']);
    assert.equal(bindAlias.code, 0, 'old key remains a usable alias');
    const collide = await run(['ticket', 'relink', kb, '--jira', 'PMLA-7', '--session', 'k1']);
    assert.match(collide.err, /collision/);
    const trav = await run(['ticket', 'bind', '../x', '--session', 'k1']);
    assert.match(trav.err, /invalid ticket key/);
    const childId = s.w.state.keyIndex.get(`${ka}.1`);
    s.ingest('ticket-update', { ticket_id: idBefore, fields: { parent_id: childId }, source: 'manual' });
    s.w.tick();
    assert.equal(s.w.state.tickets.get(idBefore).parent_id, null, 'cycle rejected');
    s.ingest('ticket-update', { ticket_id: idBefore, fields: { parent_id: idBefore }, source: 'manual' });
    s.w.tick();
    assert.equal(s.w.state.tickets.get(idBefore).parent_id, null, 'self-parent rejected');
  } finally { await s.stop(); }
});

test('A18 a second worker on the same store refuses ownership; a copy on another machine cannot become a writer without explicit transfer', async () => {
  const s = await scenario().start();
  try {
    await assert.rejects(() => acquireLock(s.meta.store_id, s.meta.owner_machine_id, s.env), (e) => e.code === 'lock-held');
  } finally { await s.stop(); }
  // read-only copy: store owned by another machine
  const copy = scenario();
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: '99999999-9999-4999-8999-999999999999', timezone: 'UTC' });
  writeStoreMeta(copy.storePath, meta);
  const doctor = await cli(['doctor'], copy.env);
  assert.match(doctor.out, /ownership: another machine/);
  assert.match(doctor.out, /read-only/);
  const start = await cli(['worker', 'start', '--timeout', '200'], copy.env);
  assert.notEqual(start.code, 0);
  assert.match(start.err, /does not own the store/);
});

test('A20 a torn journal tail recovers from retained ingress; mid-log corruption stops recovery visibly; a failed tool with partial changes is partial, not a verified write', async () => {
  const s = await scenario().start();
  try {
    s.ticket(T1, 'LOCAL-a-00000001');
    s.bind('f1', T1);
    s.ingest('pre-tool', { tool_name: 'Bash' }, { session_id: 'f1', tool_call_id: 'fail1', source_identity: 'pre:f1:fail1' });
    s.ingest('tool-failure', { tool_name: 'Bash', error: 'exit 1', write_paths: ['maybe.js'] }, { session_id: 'f1', tool_call_id: 'fail1', source_identity: 'fail:f1:fail1' });
    s.w.tick();
    const t = s.w.state.tickets.get(T1);
    assert.equal(t.files_touched_count, 0);
    assert.equal(t.timeline.at(-1).coverage, 'partial');
    assert.equal([...s.w.state.sessions.values()].find((x) => x.host_session_id === 'f1').change_coverage, 'partial');
    // torn tail: the last appended event is redelivered from ingress
    s.ingest('ticket-update', { ticket_id: T1, fields: { next_action: 'torn' }, source: 'manual' }, { source_identity: 'torn-source' });
    await s.stop({ flush: false });
    const file = journalPath(s.env);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    fs.writeFileSync(file, lines.join('\n') + '\n' + '{"torn":"tail' );
    const { writeIngress } = await import('../../src/core/ingress.js');
    writeIngress({ ...last, sequence: null, ingested_at: null }, s.env);
    await s.start();
    assert.equal(s.w.journalInfo.quarantined, true);
    assert.equal(s.w.state.tickets.get(T1).next_action, 'torn');
    assert.equal(s.w.state.tickets.get(T1).timeline.filter((e) => e.kind === 'status' && /Status set/.test(e.text)).length, 0);
    await s.stop({ flush: false });
    const lines2 = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    lines2[1] = '{"broken';
    fs.writeFileSync(file, lines2.join('\n') + '\n');
    await assert.rejects(() => s.start(), (e) => e.code === 'journal-corrupt');
    const doctor = await cli(['doctor'], s.env);
    assert.match(doctor.out, /journal: mid-log corruption/);
  } finally { try { await s.stop(); } catch { /* not started */ } }
});
