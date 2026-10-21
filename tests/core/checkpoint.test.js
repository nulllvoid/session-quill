// State checkpoint (ADR 0030): hydrating at any journal position and replaying the tail must give
// exactly the state a full replay gives, and a checkpoint that no longer matches is ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeEvent } from '../../src/core/events.js';
import { createState } from '../../src/core/state.js';
import { applyEvent, REDUCER_VERSION } from '../../src/core/reducer.js';
import { Journal } from '../../src/core/journal.js';
import { journalPath } from '../../src/lib/paths.js';
import { writeCheckpoint, readCheckpoint, checkpointPath, encodeState, decodeState, packageVersion, metaFingerprint, reducerCodeFingerprint } from '../../src/core/checkpoint.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const MACHINE = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const H1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const R1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REF = 'f'.repeat(64);

const META = {
  store_id: STORE, machine_id: MACHINE, machine_name: 'test', store_name: 'Quill', timezone: 'UTC', key_prefix: 'LOCAL', stale_days: 5,
  approval_phrases_enabled: true,
  projects: { demo: { name: 'Demo', repo_id: 'demo' } },
  repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['staging', 'production'] } },
};

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ckpt-'));
  return { dir, env: { QUILL_HOME: dir } };
}

// A journal touching every part of state the reducer keeps: tickets and children, sessions and
// subagents, tool calls (a post-tool result that arrives before its pre-tool, so it waits in
// deferredResults across a cut, and one that is never matched), stop checkpoints and approval,
// requests and their transactions, a handoff and its result child, memory, reconcile with a PR,
// and a duplicate delivery.
function script() {
  let n = 0;
  const at = () => new Date(Date.parse('2026-10-02T08:00:00Z') + (n += 1) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mk = (kind, payload, extra = {}) => makeEvent({ kind, payload, store_id: STORE, machine_id: MACHINE, producer: extra.producer ?? 'test', occurred_at: at(), ...extra });
  const ticket = (id, key, parent_id = null) => ({ id, key, title: `Ticket ${key}`, project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id, repo_id: 'demo', due: null, jira: null });
  const s1 = { session_id: 'host-1' };
  const events = [
    mk('ticket-create', { ticket: ticket(T1, 'LOCAL-demo-00000001') }),
    mk('ticket-create', { ticket: ticket(T2, 'LOCAL-demo-00000002', T1) }),
    mk('session-start', { source: 'startup', cwd: 'C:/repo' }, s1),
    mk('bind', { ticket_id: T1, project_id: 'demo' }, s1),
    mk('prompt', { title_candidate: 'Fix the checkout flow' }, s1),
    mk('pre-tool', { tool_name: 'Edit' }, { ...s1, tool_call_id: 'c1', source_identity: 'pre:host-1:c1' }),
    mk('post-tool', { tool_name: 'Edit', write_paths: ['src/a.js'], repo_id: 'demo', success: true }, { ...s1, tool_call_id: 'c1', source_identity: 'post:host-1:c1' }),
    // Result before its call: deferred until the pre-tool below.
    mk('post-tool', { tool_name: 'Write', write_paths: ['src/b.js'], repo_id: 'demo', success: true }, { ...s1, tool_call_id: 'c2', source_identity: 'post:host-1:c2' }),
    mk('subagent-start', { parent_session_id: 'host-1', agent_type: 'explore' }, { ...s1, agent_id: 'sub-1' }),
    mk('ticket-update', { ticket_id: T1, fields: { status: 'active', next_action: 'Write the test' }, source: 'manual' }),
    mk('stop', { complete: true, content_ref: REF, preview: 'Done the first part', conclusions: ['The flow fails on retry'], usage: { input: 10, output: 5 } }, s1),
    mk('prompt', { approval_candidate: true }, s1),
    mk('pre-tool', { tool_name: 'Write' }, { ...s1, tool_call_id: 'c2', source_identity: 'pre:host-1:c2' }),
    mk('request', { id: R1, kind: 'handoff', target_id: T1, expected_revision: null, payload: {}, created_at: at(), not_before: at(), actor_id: 'owner' }, { source_identity: `request:${R1}` }),
    mk('request-tx', { request_id: R1, outcome: 'applying' }, { producer: 'worker' }),
    mk('request-tx', { request_id: R1, outcome: 'applied', mutation: { type: 'handoff-create', handoff: { id: H1, ticket_id: T1, mode: 'analyse', state: 'queued', permissions: { read_source: true }, created_at: at(), revision: 1 } } }, { producer: 'worker' }),
    mk('handoff-tx', { handoff_id: H1, update: { state: 'running', started_at: at() } }, { producer: 'worker' }),
    mk('handoff-tx', { handoff_id: H1, update: { state: 'done', finished_at: at(), suggestions: [{ type: 'next-action', text: 'Ship it' }] }, result_items: [{ type: 'child', key: 'LOCAL-demo-00000003', title: 'Follow-up' }] }, { producer: 'worker' }),
    mk('memory-tx', { op: 'filed', entry: { id: 'm1', scope: 'repo', repo_id: 'demo', section: 'build', key: 'test-cmd', kind: 'fact', text: 'npm test runs the suite', evidence: ['package.json:10'], derived_from: 'repo-file', trust: 'sourced', run_id: H1, state: 'active' } }, { producer: 'worker' }),
    mk('memory-tx', { op: 'confirmed', entry: { id: 'm1' } }, { producer: 'worker' }),
    mk('reconcile', { last_sync: at(), provider_health: [{ provider: 'github', ok: true }], pr_updates: [{ ticket_id: T1, link: true, url: 'https://github.com/o/r/pull/7', head_branch: 'feat/x', state: 'merged', merged_at: at(), provider: 'github' }] }, { producer: 'worker' }),
    // Never matched (and after the reconcile that would sweep it): still deferred at the end.
    mk('post-tool', { tool_name: 'Edit', write_paths: ['src/c.js'], repo_id: 'demo', success: true }, { ...s1, tool_call_id: 'c9', source_identity: 'post:host-1:c9' }),
    mk('subagent-stop', { complete: false }, { ...s1, agent_id: 'sub-1' }),
    mk('ticket-update', { ticket_id: T2, fields: { next_action: 'Review' }, source: 'manual' }),
  ];
  // The same delivery twice (same source identity, a new event id) has one effect.
  const dup = mk('ticket-update', { ticket_id: T2, fields: { next_action: 'Twice' }, source: 'manual' }, { source_identity: 'dup:1' });
  events.push(dup, { ...dup, event_id: '99999999-9999-4999-8999-999999999999' });
  events.push(mk('session-end', { reason: 'other' }, s1));
  return events.map((e, i) => ({ ...e, sequence: i + 1, ingested_at: e.occurred_at }));
}

function writeJournal(env, events) {
  const file = journalPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = events.map((e) => `${JSON.stringify(e)}\n`);
  fs.writeFileSync(file, lines.join(''));
  // Byte offset just past event i (1-based), as the worker's journal tracks it.
  const offsets = [0];
  for (const l of lines) offsets.push(offsets[offsets.length - 1] + Buffer.byteLength(l));
  return { file, offsets };
}

function replay(events) {
  const state = createState(META);
  for (const e of events) applyEvent(state, structuredClone(e));
  return state;
}

test('hydrating at every cut point and replaying the tail deep-equals a full replay', () => {
  const { env } = home();
  const events = script();
  const { offsets } = writeJournal(env, events);
  const full = replay(events);
  // The script exercises what it claims to.
  assert.equal(full.deferredResults.size, 1, 'one result is still waiting for its call');
  assert.equal(full.handoffs.get(H1).state, 'done');
  assert.ok(full.memory.entries.has('m1'));
  assert.equal(full.tickets.size, 3);
  assert.ok(full.tickets.get(T1).prs.length === 1);
  const mid = Math.floor(events.length / 2);
  const cuts = [...new Set([1, mid, events.length - 1, ...events.map((_, i) => i + 1).slice(0, -1)])];
  for (const n of cuts) {
    const partial = replay(events.slice(0, n));
    writeCheckpoint(partial, { sequence: n, byteOffset: offsets[n], lastEventId: events[n - 1].event_id, env });
    const cp = readCheckpoint({ env, meta: createState(META).meta });
    assert.ok(cp, `checkpoint at ${n} is accepted`);
    assert.equal(cp.sequence, n);
    const j = new Journal(journalPath(env));
    const info = j.open({ resume: { byteOffset: cp.byteOffset, sequence: cp.sequence, lastEventId: cp.lastEventId, eventIds: cp.state.appliedEvents, sourceIds: cp.state.appliedSources } });
    assert.equal(info.resumed, true, `journal resumes at ${n}`);
    assert.equal(info.lastSequence, events.length);
    const state = { ...cp.state, meta: createState(META).meta };
    for (const e of j.read({ fromByte: cp.byteOffset })) applyEvent(state, e);
    j.close();
    assert.deepStrictEqual(state, full, `hydrate at ${n} + tail == full replay`);
    // Shared records stay shared: a session reached by key and by id is one object.
    for (const [key, s] of state.sessions) assert.equal(state.sessionsById.get(s.id), s, `session ${key} is one object after hydration`);
  }
});

test('the encoding keeps Maps, Sets, shared and cyclic references, undefined, odd numbers and $-keys', () => {
  const shared = { id: 'x', list: [1, 2] };
  const cyclic = { name: 'c' };
  cyclic.self = cyclic;
  const value = {
    m: new Map([['a', shared], [1, new Set(['s', shared])]]),
    again: shared,
    list: shared.list,
    cyclic,
    u: undefined,
    arr: [undefined, null, -0, NaN, Infinity, -Infinity, 1.5],
    dollar: { $r: 1, $m: 'not a tag', plain: true },
    proto: JSON.parse('{"__proto__": {"polluted": true}}'),
    empty: {},
  };
  const back = decodeState(JSON.parse(JSON.stringify(encodeState(value))));
  assert.deepStrictEqual(back, value);
  assert.equal(back.m.get('a'), back.again);
  assert.equal(back.list, back.again.list);
  assert.equal(back.cyclic.self, back.cyclic);
  assert.ok(Object.is(back.arr[2], -0));
  assert.ok(Object.hasOwn(back, 'u'));
  assert.equal(Object.getPrototypeOf(back.proto), Object.prototype, 'a __proto__ key stays an own property');
  assert.equal(({}).polluted, undefined);
  assert.throws(() => encodeState({ when: new Date() }), /unsupported/);
});

test('the checkpoint file carries versions and positions but never the meta', () => {
  const { env } = home();
  const events = script();
  const state = replay(events);
  writeCheckpoint(state, { sequence: events.length, byteOffset: 1234, lastEventId: events[events.length - 1].event_id, env });
  const raw = JSON.parse(fs.readFileSync(checkpointPath(env), 'utf8'));
  assert.equal(raw.format, 1);
  assert.equal(raw.reducer_version, REDUCER_VERSION);
  assert.equal(raw.package_version, packageVersion());
  assert.equal(raw.sequence, events.length);
  assert.equal(raw.byte_offset, 1234);
  assert.equal(raw.last_event_id, events[events.length - 1].event_id);
  assert.equal(raw.meta_fingerprint, metaFingerprint(state.meta));
  assert.equal(raw.code_fingerprint, reducerCodeFingerprint());
  assert.equal(Object.hasOwn(raw.state, 'meta'), false);
  assert.equal(JSON.stringify(raw).includes('Demo'), true, 'ticket data is there');
  assert.equal(fs.readdirSync(path.dirname(checkpointPath(env))).filter((f) => f.endsWith('.tmp')).length, 0, 'written atomically');
});

test('a checkpoint that does not match is ignored with a reason', () => {
  const { env } = home();
  const events = script();
  const state = replay(events);
  const meta = createState(META).meta;
  const pos = { sequence: events.length, byteOffset: 100, lastEventId: events[events.length - 1].event_id, env };
  const reasons = [];
  const read = (opts = {}) => readCheckpoint({ env, meta, onIgnore: (r) => reasons.push(r), ...opts });

  assert.equal(read(), null, 'no file');
  assert.deepEqual(reasons, [], 'a missing checkpoint is not a problem');

  writeCheckpoint(state, { ...pos, reducerVersion: REDUCER_VERSION - 1 });
  assert.equal(read(), null);
  assert.match(reasons.pop(), /reducer version/);

  writeCheckpoint(state, { ...pos, packageVersion: '0.0.1' });
  assert.equal(read(), null);
  assert.match(reasons.pop(), /package version 0\.0\.1/);

  // A reducer change that forgot to bump REDUCER_VERSION (same package version in a git checkout).
  writeCheckpoint(state, { ...pos, codeFingerprint: 'older-reducer-source' });
  assert.equal(read(), null);
  assert.match(reasons.pop(), /reducer code changed/);
  assert.match(reducerCodeFingerprint(), /^[0-9a-f]{64}$/);

  writeCheckpoint(state, pos);
  assert.ok(read(), 'a matching checkpoint is used');
  assert.equal(read({ meta: { ...meta, repos: {} } }), null, 'configuration the reducer reads changed');
  assert.match(reasons.pop(), /configuration/);
  assert.ok(read({ meta: { ...meta, stale_days: 9, sync_interval_hours: 4 } }), 'settings the reducer never reads do not matter');

  fs.writeFileSync(checkpointPath(env), '{"format": 1, "state": {');
  assert.equal(read(), null);
  assert.match(reasons.pop(), /not valid JSON/);

  const good = JSON.parse((writeCheckpoint(state, pos), fs.readFileSync(checkpointPath(env), 'utf8')));
  fs.writeFileSync(checkpointPath(env), JSON.stringify({ ...good, format: 2 }));
  assert.equal(read(), null);
  assert.match(reasons.pop(), /format/);

  fs.writeFileSync(checkpointPath(env), JSON.stringify({ ...good, byte_offset: -1 }));
  assert.equal(read(), null);
  assert.match(reasons.pop(), /position/);

  fs.writeFileSync(checkpointPath(env), JSON.stringify({ ...good, state: { tickets: { $q: 1 } } }));
  assert.equal(read(), null);
  assert.match(reasons.pop(), /state/);
});

test('a journal that no longer matches the checkpoint offset is read in full', () => {
  const { env } = home();
  const events = script();
  const { file, offsets } = writeJournal(env, events);
  const n = 10;
  const resume = { byteOffset: offsets[n], sequence: n, lastEventId: events[n - 1].event_id, eventIds: new Set(), sourceIds: new Set() };
  const openWith = (r) => { const j = new Journal(file); const info = j.open({ resume: r }); j.close(); return { info, j }; };

  const ok = openWith(resume);
  assert.equal(ok.info.resumed, true);
  assert.equal(ok.info.lastSequence, events.length);
  assert.equal(ok.j.hasEvent(events[n].event_id), true, 'tail ids are tracked');

  const otherId = openWith({ ...resume, lastEventId: events[n].event_id });
  assert.equal(otherId.info.resumed, false);
  assert.match(otherId.info.resume_ignored, /truncated or edited/);
  assert.equal(otherId.info.lastSequence, events.length, 'the full read still opens the journal');
  assert.equal(otherId.j.hasEvent(events[0].event_id), true, 'a full read tracks every id');

  const shifted = openWith({ ...resume, byteOffset: offsets[n] - 1 });
  assert.equal(shifted.info.resumed, false);
  assert.match(shifted.info.resume_ignored, /line/);

  fs.writeFileSync(file, events.slice(0, n - 2).map((e) => `${JSON.stringify(e)}\n`).join(''));
  const shorter = openWith(resume);
  assert.equal(shorter.info.resumed, false);
  assert.match(shorter.info.resume_ignored, /shorter/);
  assert.equal(shorter.info.lastSequence, n - 2);

  // Rewritten with different events of the same sizes at the same place: the id no longer matches.
  const edited = events.map((e) => ({ ...e }));
  edited[n - 1] = { ...edited[n - 1], event_id: edited[n - 1].event_id.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) };
  fs.writeFileSync(file, edited.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const swapped = openWith(resume);
  assert.equal(swapped.info.resumed, false);
  assert.match(swapped.info.resume_ignored, /truncated or edited/);
});

test('a torn line after the checkpoint offset falls back to the full open, which quarantines it', () => {
  const { env } = home();
  const events = script();
  const { file, offsets } = writeJournal(env, events);
  fs.appendFileSync(file, '{"partial');
  const n = 5;
  const j = new Journal(file);
  const info = j.open({ resume: { byteOffset: offsets[n], sequence: n, lastEventId: events[n - 1].event_id, eventIds: new Set(), sourceIds: new Set() } });
  j.close();
  assert.equal(info.resumed, false);
  assert.equal(info.quarantined, true);
  assert.equal(info.lastSequence, events.length);
  assert.match(info.resume_ignored, /after the checkpoint/);
});

test('Journal tracks the byte offset and last event id it would checkpoint at', () => {
  const { env } = home();
  const file = journalPath(env);
  const j = new Journal(file);
  j.open();
  assert.deepEqual(j.position(), { sequence: 0, byteOffset: 0, lastEventId: null });
  const a = j.append(makeEvent({ kind: 'bind', payload: { n: 'é' }, store_id: STORE, machine_id: MACHINE, occurred_at: '2026-10-02T08:00:00Z' }));
  assert.deepEqual(j.position(), { sequence: 1, byteOffset: fs.statSync(file).size, lastEventId: a.event_id });
  j.close();
  const k = new Journal(file);
  k.open();
  assert.deepEqual(k.position(), { sequence: 1, byteOffset: fs.statSync(file).size, lastEventId: a.event_id });
  k.close();
});

test('state keys match createState: a checkpoint round-trips a fresh state', () => {
  const state = createState(META);
  const { meta, ...rest } = state;
  assert.deepStrictEqual({ meta, ...decodeState(JSON.parse(JSON.stringify(encodeState(rest)))) }, state);
});
