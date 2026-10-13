import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, ev, resetSeq } from './helpers.js';
import { EVENT_KINDS, makeEvent, validateEvent } from '../../src/core/events.js';
import { applyEvent } from '../../src/core/reducer.js';
import { memoryFor, quarantined, conflicts, memoryStaleness } from '../../src/core/memory.js';
import { buildSnapshot } from '../../src/worker/projections.js';

const T0 = '2026-10-02T08:00:00Z';
const T1 = '2026-10-03T09:30:00Z';
const T2 = '2026-10-04T10:00:00Z';

function entry(over = {}) {
  return { id: 'm1', scope: 'repo', repo_id: 'demo', section: 'build', key: 'test-cmd', kind: 'fact', text: 'npm test runs the suite', evidence: ['package.json:10'], derived_from: 'repo-file', trust: 'sourced', run_id: 'r1', created_at: T0, last_confirmed_at: T0, confirmations: 0, state: 'active', revision: 1, ...over };
}

const mem = (state, op, e, at = T0, extra = {}) => ev(state, 'memory-tx', { op, entry: e, ...extra }, { occurred_at: at });
const get = (state, id) => state.memory.entries.get(id);

test('memory-tx is a registered, valid event kind', () => {
  assert.ok(EVENT_KINDS.includes('memory-tx'));
  const e = makeEvent({ kind: 'memory-tx', payload: { op: 'filed', entry: entry() }, store_id: 's', machine_id: 'm', occurred_at: T0 });
  assert.doesNotThrow(() => validateEvent(e));
});

test('filed puts the entry in state.memory with revision 1', () => {
  const s = newState();
  const r = mem(s, 'filed', entry());
  assert.equal(r.rejected, undefined);
  const e = get(s, 'm1');
  assert.equal(e.text, 'npm test runs the suite');
  assert.equal(e.trust, 'sourced');
  assert.equal(e.state, 'active');
  assert.equal(e.revision, 1);
  assert.deepEqual(e.evidence, ['package.json:10']);
  assert.equal(s.memory.problems.length, 0);
});

test('filed does not alias the payload and a second filed of the same id is ignored with a problem', () => {
  const s = newState();
  const payloadEntry = entry();
  mem(s, 'filed', payloadEntry);
  payloadEntry.text = 'mutated after the fact';
  assert.equal(get(s, 'm1').text, 'npm test runs the suite');
  const r = mem(s, 'filed', entry({ text: 'other' }), T1);
  assert.equal(r.rejected, 'memory-entry-exists');
  assert.equal(get(s, 'm1').text, 'npm test runs the suite');
  assert.equal(s.memory.problems.length, 1);
});

test('confirmed increments confirmations, updates last_confirmed_at and bumps the revision', () => {
  const s = newState();
  mem(s, 'filed', entry());
  mem(s, 'confirmed', { id: 'm1' }, T1);
  const e = get(s, 'm1');
  assert.equal(e.confirmations, 1);
  assert.equal(e.last_confirmed_at, T1);
  assert.equal(e.revision, 2);
  mem(s, 'confirmed', { id: 'm1' }, T2);
  assert.equal(get(s, 'm1').confirmations, 2);
  assert.equal(get(s, 'm1').last_confirmed_at, T2);
});

test('superseded retires the old entry and names its replacement (replacement filed first)', () => {
  const s = newState();
  mem(s, 'filed', entry());
  mem(s, 'filed', entry({ id: 'm2', text: 'npm run test:all runs the suite', trust: 'verified' }), T1);
  mem(s, 'superseded', { id: 'm1' }, T1, { superseded_by: 'm2' });
  assert.equal(get(s, 'm1').superseded_by, 'm2');
  assert.equal(get(s, 'm1').state, 'retired');
  assert.equal(get(s, 'm2').state, 'active');
  assert.deepEqual(memoryFor(s, { repo_id: 'demo' }).map((e) => e.id), ['m2']);
});

test('superseded carrying the replacement files it in the same op; superseded before the replacement is filed also works', () => {
  const a = newState();
  mem(a, 'filed', entry());
  mem(a, 'superseded', { id: 'm1' }, T1, { superseded_by: 'm2', replacement: entry({ id: 'm2', text: 'new', trust: 'verified' }) });
  assert.equal(get(a, 'm2').text, 'new');
  assert.equal(get(a, 'm1').superseded_by, 'm2');

  const b = newState();
  mem(b, 'filed', entry());
  mem(b, 'superseded', { id: 'm1' }, T1, { superseded_by: 'm2' });
  mem(b, 'filed', entry({ id: 'm2', text: 'new', trust: 'verified' }), T1);
  assert.equal(get(b, 'm1').superseded_by, 'm2');
  assert.equal(get(b, 'm1').state, 'retired');
  assert.equal(get(b, 'm2').text, 'new');
  assert.equal(b.memory.problems.length, 0);
});

test('superseded needs a different replacement id and a known entry', () => {
  const s = newState();
  mem(s, 'filed', entry());
  assert.equal(mem(s, 'superseded', { id: 'm1' }, T1).rejected, 'memory-supersede-invalid');
  assert.equal(mem(s, 'superseded', { id: 'm1' }, T1, { superseded_by: 'm1' }).rejected, 'memory-supersede-invalid');
  assert.equal(mem(s, 'superseded', { id: 'nope' }, T1, { superseded_by: 'm2' }).rejected, 'memory-entry-unknown');
  assert.equal(get(s, 'm1').state, 'active');
});

test('approved moves a quarantined entry to owner trust; approving anything else is a problem', () => {
  const s = newState();
  mem(s, 'filed', entry({ id: 'q1', trust: 'quarantined', derived_from: 'tool-output' }));
  assert.deepEqual(quarantined(s).map((e) => e.id), ['q1']);
  assert.deepEqual(memoryFor(s, { repo_id: 'demo' }), []);
  mem(s, 'approved', { id: 'q1' }, T1);
  assert.equal(get(s, 'q1').trust, 'owner');
  assert.deepEqual(quarantined(s), []);
  assert.deepEqual(memoryFor(s, { repo_id: 'demo' }).map((e) => e.id), ['q1']);
  assert.equal(mem(s, 'approved', { id: 'q1' }, T2).rejected, 'memory-not-quarantined');
});

test('retired, pinned, unpinned and edited change the entry and bump the revision', () => {
  const s = newState();
  mem(s, 'filed', entry());
  mem(s, 'pinned', { id: 'm1' }, T1);
  assert.equal(get(s, 'm1').pinned, true);
  mem(s, 'unpinned', { id: 'm1' }, T1);
  assert.equal(get(s, 'm1').pinned, false);
  mem(s, 'edited', { id: 'm1', text: 'Run npm test, never npm run lint' }, T1);
  assert.equal(get(s, 'm1').text, 'Run npm test, never npm run lint');
  assert.equal(get(s, 'm1').trust, 'owner');
  assert.equal(get(s, 'm1').revision, 4);
  mem(s, 'retired', { id: 'm1' }, T2);
  assert.equal(get(s, 'm1').state, 'retired');
  assert.equal(get(s, 'm1').revision, 5);
  assert.deepEqual(memoryFor(s, { repo_id: 'demo' }), []);
  // Retiring twice is a no-op, not a problem.
  mem(s, 'retired', { id: 'm1' }, T2);
  assert.equal(get(s, 'm1').revision, 5);
  assert.equal(s.memory.problems.length, 0);
});

test('owner-note creates an owner entry (whatever trust it names) and updates an existing one', () => {
  const s = newState();
  mem(s, 'owner-note', entry({ id: 'o1', trust: 'observed', text: 'Never push to main' }));
  assert.equal(get(s, 'o1').trust, 'owner');
  mem(s, 'owner-note', entry({ id: 'o1', text: 'Never push to main or release/*' }), T1);
  assert.equal(get(s, 'o1').text, 'Never push to main or release/*');
  assert.equal(get(s, 'o1').revision, 2);
});

test('ops carrying expected_revision are ignored with a problem on mismatch and applied on match', () => {
  const s = newState();
  mem(s, 'filed', entry());
  const bad = mem(s, 'pinned', { id: 'm1' }, T1, { expected_revision: 7 });
  assert.equal(bad.rejected, 'revision-conflict');
  assert.equal(get(s, 'm1').pinned, false);
  assert.equal(get(s, 'm1').revision, 1);
  assert.equal(s.memory.problems.at(-1).code, 'revision-conflict');
  mem(s, 'pinned', { id: 'm1' }, T1, { expected_revision: 1 });
  assert.equal(get(s, 'm1').pinned, true);
  assert.equal(get(s, 'm1').revision, 2);
});

test('an unknown op is ignored with a recorded problem and nothing throws', () => {
  const s = newState();
  mem(s, 'filed', entry());
  const before = JSON.stringify([...s.memory.entries]);
  const r = mem(s, 'teleport', { id: 'm1' }, T1);
  assert.equal(r.rejected, 'memory-op-unknown');
  assert.equal(JSON.stringify([...s.memory.entries]), before);
  assert.deepEqual(s.memory.problems.map((p) => [p.op, p.code, p.entry_id]), [['teleport', 'memory-op-unknown', 'm1']]);
  assert.equal(ev(s, 'memory-tx', {}, { occurred_at: T1 }).rejected, 'memory-op-unknown');
  assert.equal(ev(s, 'memory-tx', { op: 'filed' }, { occurred_at: T1 }).rejected, 'memory-entry-invalid');
});

test('malformed entries are ignored with a problem instead of throwing', () => {
  const s = newState();
  for (const bad of [
    entry({ id: '' }), entry({ text: '' }), entry({ scope: 'galaxy' }), entry({ trust: 'trusted' }), entry({ state: 'gone' }),
    entry({ scope: 'repo', repo_id: undefined }), entry({ scope: 'task', ticket_id: undefined }), null, 'text', [],
  ]) {
    assert.equal(mem(s, 'filed', bad).rejected, 'memory-entry-invalid');
  }
  assert.equal(s.memory.entries.size, 0);
  assert.equal(s.memory.problems.length, 10);
  // Acting on a missing entry or without an id is a problem too.
  assert.equal(mem(s, 'confirmed', { id: 'nope' }).rejected, 'memory-entry-unknown');
  assert.equal(mem(s, 'confirmed', {}).rejected, 'memory-entry-invalid');
  assert.equal(mem(s, 'edited', undefined).rejected, 'memory-entry-invalid');
});

test('problems are bounded', () => {
  const s = newState();
  for (let i = 0; i < 130; i += 1) mem(s, 'bogus', { id: `x${i}` }, T0);
  assert.equal(s.memory.problems.length, 100);
  assert.equal(s.memory.problems.at(-1).entry_id, 'x129');
});

test('replaying the same events twice yields deep-equal state', () => {
  const build = () => {
    resetSeq();
    const s = newState();
    mem(s, 'filed', entry());
    mem(s, 'filed', entry({ id: 'q1', trust: 'quarantined', key: undefined }), T1);
    mem(s, 'confirmed', { id: 'm1' }, T1);
    mem(s, 'filed', entry({ id: 'm2', text: 'x', trust: 'verified' }), T1);
    mem(s, 'superseded', { id: 'm1' }, T2, { superseded_by: 'm2' });
    mem(s, 'approved', { id: 'q1' }, T2);
    mem(s, 'pinned', { id: 'q1' }, T2);
    mem(s, 'teleport', { id: 'q1' }, T2);
    return s;
  };
  // Event ids are fresh per build, so compare entries and problem codes.
  const shape = (s) => ({ entries: s.memory.entries, problems: s.memory.problems.map(({ event_id, ...p }) => p) });
  assert.deepEqual(shape(build()), shape(build()));

  // The same journal applied to two fresh states, event objects shared.
  const events = [];
  const record = (op, e, at, extra) => events.push(makeEvent({ kind: 'memory-tx', payload: { op, entry: e, ...extra }, store_id: 's', machine_id: 'm', occurred_at: at }));
  record('filed', entry(), T0); record('confirmed', { id: 'm1' }, T1); record('retired', { id: 'm1' }, T2); record('bogus', {}, T2);
  const a = newState(); const b = newState();
  events.forEach((e, i) => { const x = { ...e, sequence: i + 1 }; applyEvent(a, x); applyEvent(b, x); });
  assert.deepEqual(a.memory, b.memory);
  // Re-applying an event is a duplicate with no further effect.
  assert.equal(applyEvent(a, { ...events[1], sequence: 2 }).duplicate, true);
  assert.equal(get(a, 'm1').confirmations, 1);
});

test('memory-tx from a producer other than the worker does not count as capture activity', () => {
  const s = newState();
  mem(s, 'owner-note', entry({ id: 'o1' }));
  assert.equal(s.lastCaptureAt, null);
});

test('memoryFor returns machine + this repo + this ticket entries, active and non-quarantined, in a stable order', () => {
  const s = newState();
  mem(s, 'filed', entry({ id: 'a-machine', scope: 'machine', repo_id: undefined, section: 'tools', key: undefined, trust: 'verified', text: 'node 22' }));
  mem(s, 'filed', entry({ id: 'b-obs', key: undefined, trust: 'observed', text: 'observed', last_confirmed_at: T2 }));
  mem(s, 'filed', entry({ id: 'c-src', key: undefined, trust: 'sourced', text: 'sourced', last_confirmed_at: T0 }));
  mem(s, 'filed', entry({ id: 'd-ver', key: undefined, trust: 'verified', text: 'verified', last_confirmed_at: T0 }));
  mem(s, 'filed', entry({ id: 'e-owner', key: undefined, trust: 'owner', text: 'owner', last_confirmed_at: T0 }));
  mem(s, 'filed', entry({ id: 'f-pinned', key: undefined, trust: 'observed', pinned: true, text: 'pinned', last_confirmed_at: T0 }));
  mem(s, 'filed', entry({ id: 'g-ver-new', key: undefined, trust: 'verified', text: 'verified newer', last_confirmed_at: T2 }));
  mem(s, 'filed', entry({ id: 'h-ver-conf', key: undefined, trust: 'verified', text: 'verified confirmed', last_confirmed_at: T0, confirmations: 4 }));
  mem(s, 'filed', entry({ id: 'i-other-repo', repo_id: 'other', key: undefined, text: 'other repo' }));
  mem(s, 'filed', entry({ id: 'j-task', scope: 'task', repo_id: undefined, ticket_id: 'tk1', section: 'notes', key: undefined, text: 'task note' }));
  mem(s, 'filed', entry({ id: 'k-other-task', scope: 'task', repo_id: undefined, ticket_id: 'tk2', key: undefined, text: 'other task' }));
  mem(s, 'filed', entry({ id: 'l-quar', trust: 'quarantined', key: undefined, text: 'quarantined' }));
  mem(s, 'filed', entry({ id: 'm-stale', state: 'stale', key: undefined, text: 'stale' }));
  mem(s, 'filed', entry({ id: 'n-retired', state: 'retired', key: undefined, text: 'retired' }));
  const ids = memoryFor(s, { repo_id: 'demo', ticket_id: 'tk1' }).map((e) => e.id);
  assert.deepEqual(ids, ['a-machine', 'e-owner', 'f-pinned', 'g-ver-new', 'h-ver-conf', 'd-ver', 'c-src', 'b-obs', 'j-task']);
  assert.deepEqual(memoryFor(s, {}).map((e) => e.id), ['a-machine']);
  assert.deepEqual(memoryFor(s, { repo_id: 'demo' }).map((e) => e.id).includes('j-task'), false);
});

test('conflicts lists same scope+key entries with different text; memoryFor keeps only the higher-trust one', () => {
  const s = newState();
  mem(s, 'filed', entry({ id: 'c1', text: 'run npm test', trust: 'observed' }));
  mem(s, 'filed', entry({ id: 'c2', text: 'run yarn test', trust: 'sourced' }));
  mem(s, 'filed', entry({ id: 'same', key: 'lint-cmd', text: 'npm run lint' }));
  mem(s, 'filed', entry({ id: 'same2', key: 'lint-cmd', text: ' NPM run   lint ' }));
  mem(s, 'filed', entry({ id: 'other-repo', repo_id: 'other', text: 'run pnpm test', trust: 'verified' }));
  mem(s, 'filed', entry({ id: 'quar', text: 'run bun test', trust: 'quarantined' }));
  mem(s, 'filed', entry({ id: 'gone', text: 'run make test', state: 'retired' }));
  const found = conflicts(s);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].scope, found[0].repo_id, found[0].key], ['repo', 'demo', 'test-cmd']);
  assert.deepEqual(found[0].entries.map((e) => e.id), ['c2', 'c1']);
  const inlined = memoryFor(s, { repo_id: 'demo' }).map((e) => e.id);
  assert.ok(inlined.includes('c2'));
  assert.ok(!inlined.includes('c1'));
  assert.ok(inlined.includes('same') && inlined.includes('same2'));
  // Superseding the loser (or retiring either) clears the conflict.
  mem(s, 'retired', { id: 'c2' }, T1);
  assert.deepEqual(conflicts(s), []);
  assert.ok(memoryFor(s, { repo_id: 'demo' }).some((e) => e.id === 'c1'));
});

test('memoryStaleness: 90 days stale, 180 days retired, confirmation resets the age', () => {
  const day = 86_400_000;
  const at = Date.parse(T0);
  const e = entry();
  assert.equal(memoryStaleness(e, at + 89 * day), 'active');
  assert.equal(memoryStaleness(e, at + 90 * day), 'stale');
  assert.equal(memoryStaleness(e, at + 179 * day), 'stale');
  assert.equal(memoryStaleness(e, at + 180 * day), 'retired');
  assert.equal(memoryStaleness({ ...e, last_confirmed_at: '2026-12-01T00:00:00Z' }, Date.parse('2027-01-15T00:00:00Z')), 'active');
  assert.equal(memoryStaleness({ ...e, state: 'retired' }, at), 'retired');
  assert.equal(memoryStaleness({ ...e, superseded_by: 'm2' }, at), 'retired');
  assert.equal(memoryStaleness({ ...e, state: 'stale' }, at), 'stale');
  assert.equal(memoryStaleness({ ...e, last_confirmed_at: 'garbage', created_at: T0 }, at + 100 * day), 'stale');
  assert.equal(memoryStaleness({ ...e, last_confirmed_at: 'garbage', created_at: 'garbage' }, at), 'active');
});

test('memory never reaches the snapshot', () => {
  const s = newState();
  mem(s, 'filed', entry({ text: 'MEMORY-SENTINEL-7731' }));
  const snap = buildSnapshot(s, { generation_id: 'g1', generated_at: T1 });
  assert.ok(!JSON.stringify(snap).includes('MEMORY-SENTINEL-7731'));
  assert.ok(!('memory' in snap));
});
