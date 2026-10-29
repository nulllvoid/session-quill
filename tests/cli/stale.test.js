import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupSuggestions } from '../../src/core/cleanup.js';
import { makeHome, startWorker, cli, DESC } from './helpers.js';

const NOW = '2026-10-11T12:00:00Z';
const T = (n, o = {}) => ({ id: `t${n}`, key: `DEV-${n}`, title: `Ticket ${n}`, status: 'active', parent_id: null, prs: [], deployments: [], last_activity: '2026-10-10T12:00:00Z', revision: 1, ...o });
const pr = (state) => ({ id: `pr-${state}`, state, observed_at: NOW });

test('cleanup: shipped work, finished parents and idle tickets; open work and done tickets are left alone', () => {
  const s = cleanupSuggestions([
    T(1, { prs: [pr('merged')], deployments: [{ pr_id: 'pr-merged', state: 'deployed' }] }),
    T(2, { prs: [pr('merged')], deployments: [{ pr_id: 'pr-merged', state: 'pending' }] }),
    T(3, { prs: [pr('merged'), pr('open')] }),
    T(4, { prs: [pr('closed')] }),
    T(5),
    T(6, { parent_id: 't5', status: 'done' }),
    T(7, { last_activity: '2026-10-01T12:00:00Z' }),
    T(8, { status: 'blocked', last_activity: '2026-09-01T12:00:00Z' }),
    T(9, { status: 'done', prs: [pr('merged')] }),
    T(10, { prs: [pr('merged')], deployments: [{ pr_id: 'pr-merged', state: 'deployed' }, { pr_id: 'pr-merged', state: 'waived' }] }),
  ], { nowIso: NOW, complete: true, handoffs: [] });
  assert.deepEqual(s.map((x) => [x.key, x.kind]), [['DEV-1', 'shipped'], ['DEV-10', 'shipped'], ['DEV-5', 'children-done'], ['DEV-8', 'idle'], ['DEV-7', 'idle']]);
  assert.equal(s.find((x) => x.key === 'DEV-5').closable, false, 'legacy parent needs an explicit relationship');
  assert.equal(s.find((x) => x.key === 'DEV-7').idle_days, 10);
  assert.equal(s.find((x) => x.key === 'DEV-7').closable, false);
  assert.match(s[0].reason, /its PR is merged and nothing is waiting for deployment/);
});

test('ticket stale reviews legacy parents; explicit grouping and required children close the loop', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const parent = await cli(['ticket', 'create', '--description', DESC, 'Parent work', '--session', 'sess-S'], fx.env);
    const pkey = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(parent.out)[1];
    await cli(['ticket', 'create', '--description', DESC, 'Child one', '--parent', pkey, '--session', 'sess-S'], fx.env);
    const done = await cli(['ticket', 'set', `${pkey}.1`, '--status', 'done'], fx.env);
    assert.equal(done.code, 0, done.err);
    w.worker.tick();
    const listed = await cli(['ticket', 'stale'], fx.env);
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, new RegExp(`${pkey} .*Parent work`));
    assert.match(listed.out, /Choose whether legacy children are required or independent/);
    const json = JSON.parse((await cli(['ticket', 'stale', '--json'], fx.env)).out);
    assert.deepEqual(json.map((x) => x.kind), ['children-done']);
    const applied = await cli(['ticket', 'stale', '--apply'], fx.env);
    assert.equal(applied.code, 0, applied.err);
    assert.match(applied.out, /Nothing to close/);
    assert.equal((await cli(['ticket', 'set', pkey, '--completion', 'children'], fx.env)).code, 0);
    assert.equal((await cli(['ticket', 'set', `${pkey}.1`, '--blocks-parent', 'yes'], fx.env)).code, 0);
    w.worker.tick();
    assert.match((await cli(['ticket', 'stale'], fx.env)).out, /Nothing to clean up/);
    const rows = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out);
    assert.equal(rows.find((t) => t.key === pkey).status, 'done');
  } finally {
    await w.stop();
  }
});

test('ticket-update with an out-of-date expected_revision is refused', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const created = await cli(['ticket', 'create', '--description', DESC, 'Moving target', '--session', 'sess-R'], fx.env);
    const key = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(created.out)[1];
    const ticket = [...w.worker.state.tickets.values()].find((t) => t.key === key);
    const { cliEvent, submitAndWait, loadContext } = await import('../../src/cli/context.js');
    const ctx = loadContext(fx.env);
    const stale = cliEvent(ctx, { kind: 'ticket-update', payload: { ticket_id: ticket.id, fields: { status: 'done' }, source: 'manual', expected_revision: ticket.revision - 1 }, session: null, ticket_id: ticket.id });
    assert.equal((await submitAndWait(ctx, stale)).rejected, 'revision-conflict');
    const fresh = cliEvent(ctx, { kind: 'ticket-update', payload: { ticket_id: ticket.id, fields: { status: 'review' }, source: 'manual', expected_revision: ticket.revision }, session: null, ticket_id: ticket.id });
    assert.ok(!(await submitAndWait(ctx, fresh)).rejected, 'the current revision applies');
  } finally {
    await w.stop();
  }
});
