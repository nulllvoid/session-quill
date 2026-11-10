import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptSnapshot, MAX_TICKETS } from '../../src/hub/accept.js';
import { rawSnapshot, sanitized, ticket } from './helpers.js';

const refused = (fn, re) => assert.throws(fn, (err) => err.code === 'hub-snapshot' && re.test(err.message));

test('a sanitized snapshot is stored as it was sent', () => {
  const s = sanitized();
  const out = acceptSnapshot(structuredClone(s));
  assert.deepEqual(out.tickets, s.tickets);
  assert.deepEqual(out.meta, s.meta);
  assert.equal(out.generation_id, 'gen-00000007');
  assert.deepEqual(acceptSnapshot(structuredClone(out)), out, 'accepting twice changes nothing');
});

test('an unsanitized snapshot, or one with checkpoint text, is refused', () => {
  refused(() => acceptSnapshot(rawSnapshot()), /not a sanitized snapshot/);
  refused(() => acceptSnapshot(null), /JSON object/);
  refused(() => acceptSnapshot([]), /JSON object/);
  refused(() => acceptSnapshot(sanitized({}, { includeCheckpoints: true })), /checkpoint text/);
  const s = sanitized();
  refused(() => acceptSnapshot({ ...s, tickets: 'x' }), /tickets must be a list/);
  refused(() => acceptSnapshot({ ...s, tickets: [{ title: 'no id' }] }), /needs an id/);
  refused(() => acceptSnapshot({ ...s, tickets: [{ ...s.tickets[0], local_only: true }] }), /local-only/);
  refused(() => acceptSnapshot({ ...s, tickets: Array.from({ length: MAX_TICKETS + 1 }, (_, i) => ({ id: `t${i}` })) }), /at most/);
  refused(() => acceptSnapshot({ ...s, generation_id: '' }), /generation id/);
  refused(() => acceptSnapshot({ ...s, meta: { ...s.meta, exported_at: 'yesterday' } }), /export time/);
});

test('whatever a client claims, the stored copy is read-only and carries no owner data', () => {
  const s = sanitized();
  const out = acceptSnapshot({
    ...s,
    capabilities: { read: true, edit_tickets: true, handoff: true, refresh: true, cancel_requests: true, export: true },
    requests: [{ id: 'r' }], unresolved: [{ id: 'u' }], checkpoints: [{ id: 'c', preview: 'the plan' }],
    run_proposals: [{ id: 'p' }], today: { days: [] }, extra_key: 'x',
    tickets: [{ ...s.tickets[0], run_notes: [{ text: 'owner only' }], critical_spec: { action: 'kubectl delete' }, user_notes: 'mine' }],
    handoffs: [{ id: 'h1', ticket_id: s.tickets[0].id, state: 'done', result_summary: 'agent words', result_sources: ['a.js'], result_confidence: 'high', result_ref: 'blob:1', suggestions: [{ id: 's' }] }],
    sessions: [{ id: 'sess', state: 'live', last_checkpoint_preview: 'agent words' }],
    meta: { ...s.meta, owner_machine_id: 'machine-9', autonomy: { level: 'full' }, onboarding: { step: 1 } },
  });
  assert.deepEqual(out.capabilities, { read: true, edit_tickets: false, handoff: false, refresh: false, cancel_requests: false, export: false });
  assert.deepEqual([out.requests, out.unresolved, out.checkpoints], [[], [], []]);
  for (const k of ['run_proposals', 'today', 'extra_key']) assert.equal(k in out, false, `${k} is not stored`);
  for (const k of ['run_notes', 'critical_spec', 'user_notes']) assert.equal(k in out.tickets[0], false);
  assert.deepEqual(out.handoffs, [{ id: 'h1', ticket_id: s.tickets[0].id, state: 'done', suggestions: [] }]);
  assert.deepEqual(out.sessions, [{ id: 'sess', state: 'live' }]);
  assert.equal(out.meta.owner_machine_id, null);
  assert.equal(out.meta.autonomy, null);
  assert.equal(out.export.include_checkpoints, false);
});

test('paths and secrets a modified client left in are redacted again on the hub', () => {
  const s = sanitized({ tickets: [ticket(1)] });
  s.tickets[0].next_action = 'Edit /Users/alice/secret-project/app.js then use ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  s.tickets[0].blocker = 'see C:\\Users\\alice\\notes.txt';
  s.tickets[0].title = 'password=hunter2hunter2 in the config';
  const out = acceptSnapshot(s);
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /\/Users\/alice|C:\\\\Users|ghp_abcdefghijklmnopqrstuvwxyz0123456789|hunter2hunter2/);
  assert.match(out.tickets[0].next_action, /\[path redacted\].*\[secret redacted\]/);
  assert.equal(out.tickets[0].id, s.tickets[0].id, 'identifiers are kept');
});

test('prototype keys and absurd nesting never reach the stored copy', () => {
  const s = JSON.parse(JSON.stringify(sanitized()).replace('"store_name":"Quill"', '"store_name":"Quill","__proto__":{"polluted":true},"constructor":{"x":1}'));
  const out = acceptSnapshot(s);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(out.meta, '__proto__'), false);
  assert.equal(Object.hasOwn(out.meta, 'constructor'), false);
  let deep = 'x';
  for (let i = 0; i < 60; i += 1) deep = { d: deep };
  refused(() => acceptSnapshot({ ...sanitized(), repos: [deep] }), /nests deeper/);
});
