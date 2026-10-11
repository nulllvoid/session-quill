// `quill approve --run` and `quill dismiss --run` (ADR 0025): the owner's terminal way to resolve a
// run proposed from a shared page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from '../../src/worker/worker.js';
import { applyDueRequests } from '../../src/server/requests.js';
import { makeHome, cli } from './helpers.js';

const T1 = 'eeeeeeee-0000-4000-8000-000000000001';
const P1 = '44444444-0000-4000-8000-0000000000c1';
const P2 = '55555555-0000-4000-8000-0000000000c2';
const proposal = (id, recipe) => ({
  id, ticket_id: T1, publisher: 'team', editor: 'u_editor', edited_at: '2026-10-11T09:00:00Z', recipe: { name: recipe, source: 'builtin', hash: null }, mode: 'analyse',
  access: 'standard', read_only: true, expected_revision: 1, permissions: { read_source: false },
});

test('quill approve --run lists open proposals, approves one by id prefix, and dismiss --run dismisses another', async () => {
  const fx = makeHome();
  const w = new Worker({ config: fx.config, storeMeta: fx.meta, env: fx.env });
  await w.start();
  w.emit('ticket-create', { ticket: { id: T1, key: 'PROJ-1', title: 'Retry flake', project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: null, due: null, jira: null } });
  w.emit('run-proposal', proposal(P1, 'analyse'), { source_identity: `run-proposal:${P1}` });
  w.emit('run-proposal', proposal(P2, 'standup'), { source_identity: `run-proposal:${P2}` });
  w.publishGeneration();
  // Requests apply on the server extension's tick; this worker has none, so apply them here.
  const timer = setInterval(() => { try { w.tick(); applyDueRequests(w, '9999-12-31T00:00:00Z'); w.publishGeneration(); } catch (err) { console.error(err); } }, 20);
  try {
    const list = await cli(['approve', '--run'], fx.env);
    assert.equal(list.code, 0, list.err);
    assert.match(list.out, /44444444 +PROJ-1 +analyse +standard +u_editor +team/);
    assert.match(list.out, /55555555 +PROJ-1 +standup/);
    const ok = await cli(['approve', '--run', '4444'], fx.env);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /Approved the proposed analyse run on PROJ-1; run [0-9a-f]{8} is queued/);
    assert.equal(w.state.runProposals.get(P1).state, 'approved');
    assert.equal(w.state.runProposals.get(P1).resolved_by, 'cli');
    const busy = await cli(['approve', '--run', '5555'], fx.env);
    assert.notEqual(busy.code, 0);
    assert.match(busy.err, /PROJ-1 already has a queued run/);
    const gone = await cli(['dismiss', '--run', '5555'], fx.env);
    assert.equal(gone.code, 0, gone.err);
    assert.match(gone.out, /Dismissed the proposed standup run on PROJ-1/);
    assert.equal(w.state.runProposals.get(P2).state, 'dismissed');
    const unknown = await cli(['approve', '--run', 'ffff'], fx.env);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.err, /no open proposed run/);
    const none = await cli(['approve', '--run'], fx.env);
    assert.match(none.out, /No proposed runs/);
  } finally { clearInterval(timer); await w.stop(); }
});
