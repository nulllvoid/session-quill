// Phase 12 — remote runs become proposals (ADR 0025). Each test is named after its ACCEPTANCE.md
// scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { scenario, T1 } from './scenario.js';
import { createArtifactClient } from '../../src/publish/artifact-client.js';

const FAKE = path.resolve('tests/fixtures/fake-artifact-claude.js');

async function twoWay(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-runprop-'));
  const store = path.join(dir, 'remote.json');
  const artifactClientFor = () => createArtifactClient({ claudePath: process.execPath, claudeArgs: [FAKE], spawnEnv: { FAKE_ARTIFACT_STORE: store }, workRoot: path.join(dir, 'runs') });
  const s = scenario({ withServer: true, jobOpts: { artifactClientFor } });
  s.config.publish = [{ name: 'team', kind: 'artifact', executor: 'cli', two_way: true, run_agent: true, fields: ['key', 'title', 'status', 'next'], ...extra }];
  await s.start();
  s.ticket(T1, 'PROJ-1', { title: 'Retry flake' });
  const c = await s.client();
  const publish = async () => { await c.post('/v1/requests', { id: randomUUID(), kind: 'publish', target_id: null, expected_revision: null, payload: { publisher: 'team', confirm: true } }); await s.settle(); };
  const pick = (recipe, by, at) => {
    const remote = JSON.parse(fs.readFileSync(store, 'utf8'));
    const doc = remote.docs['tickets/PROJ-1'];
    doc.data = { ...doc.data, run: recipe, _edits: { ...(doc.data._edits ?? {}), run: { by, at } } };
    doc.version += 1;
    fs.writeFileSync(store, JSON.stringify(remote));
  };
  const remote = () => JSON.parse(fs.readFileSync(store, 'utf8'));
  return { s, c, publish, pick, remote };
}

test('A69 a Run agent pick on a two-way page appears as one proposal after two publishes, and nothing runs until the owner approves', async () => {
  const { s, c, publish, pick, remote } = await twoWay();
  try {
    await publish();
    const page = remote();
    assert.match(page.page, /const RUN_RECIPES = \["analyse","analyse-followups","deploy-check","standup","workspace-setup"\]/, 'read-only recipes only');
    assert.equal(page.docs['tickets/PROJ-1'].data.run, '');
    pick('analyse', 'u_editor', '2026-10-02T08:30:00Z');
    await publish();
    await publish();
    const proposals = [...s.w.state.runProposals.values()];
    assert.equal(proposals.length, 1, 'two publishes, one proposal');
    assert.equal(proposals[0].editor, 'u_editor');
    assert.equal(proposals[0].recipe.name, 'analyse');
    assert.equal(proposals[0].access, 'standard');
    assert.equal(s.w.state.handoffs.size, 0, 'nothing runs until Approve');
    assert.equal(remote().docs['tickets/PROJ-1'].data.run, '', 'the page select is cleared once the pick is brought back');
    s.advance(60_000);
    await s.settle();
    assert.equal(s.w.state.handoffs.size, 0, 'no undo window or timer queues it either');
    const snap = await (await c.get('/v1/snapshot')).json();
    assert.equal(snap.run_proposals.filter((p) => p.state === 'proposed').length, 1);
    const res = await c.post('/v1/requests', { id: randomUUID(), kind: 'approve-run', target_id: T1, expected_revision: null, payload: { proposal_id: proposals[0].id } });
    assert.equal(res.status, 202);
    await s.settle();
    const [h] = [...s.w.state.handoffs.values()];
    assert.equal(h.state, 'queued');
    assert.equal(h.proposal_id, proposals[0].id);
    assert.equal(s.w.state.runProposals.get(proposals[0].id).state, 'approved');
  } finally { await s.stop(); }
});

test('A70 a pick the page does not offer makes no proposal, and with no auto-run an allowlist-style config still queues nothing', async () => {
  const { s, publish, pick } = await twoWay({ run_recipes: ['attempt-fix'], auto_run_editors: ['u_lead'], auto_run_recipes: ['analyse'] });
  try {
    await publish();
    pick('file-task', 'u_lead', '2026-10-02T08:30:00Z');
    await publish();
    assert.equal(s.w.state.runProposals.size, 0, 'a recipe the page does not offer makes no proposal');
    pick('attempt-fix', 'u_lead', '2026-10-02T08:31:00Z');
    await publish();
    const fix = [...s.w.state.runProposals.values()].find((p) => p.recipe.name === 'attempt-fix');
    assert.equal(fix.state, 'proposed');
    assert.equal(fix.permissions.push_branch, false);
    pick('analyse', 'u_lead', '2026-10-02T08:32:00Z');
    await publish();
    s.advance(60_000);
    await s.settle();
    const analyse = [...s.w.state.runProposals.values()].find((p) => p.recipe.name === 'analyse');
    assert.equal(analyse.state, 'proposed', 'every proposal waits for the owner');
    assert.equal(s.w.state.handoffs.size, 0);
  } finally { await s.stop(); }
});
