import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { scenario, T1 } from '../acceptance/scenario.js';
import { createArtifactClient } from '../../src/publish/artifact-client.js';

const FAKE = path.resolve('tests/fixtures/fake-artifact-claude.js');
const snap = async (c) => (await c.get('/v1/snapshot')).json();
const publish = (c, payload) => c.post('/v1/requests', { id: randomUUID(), kind: 'publish', target_id: null, expected_revision: null, payload });

test('the first publish to a destination waits for confirmation; once confirmed it publishes, and a new destination asks again', async () => {
  const s = scenario({ withServer: true });
  s.config.publish = [{ name: 'rollup', kind: 'markdown', title: 'Team roll-up' }];
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1', { title: 'Retry flake' });
    const c = await s.client();
    assert.equal((await publish(c, { publisher: 'rollup' })).status, 202);
    await s.settle();
    let view = await snap(c);
    let p = view.publishers.find((x) => x.name === 'rollup');
    assert.deepEqual([p.label, p.confirmed, p.last_outcome], ['Note', false, 'needs-confirmation']);
    const file = path.join(s.storePath, 'rollups', 'rollup.md');
    assert.ok(!fs.existsSync(file), 'nothing is written before confirmation');
    await publish(c, { publisher: 'rollup', confirm: true });
    await s.settle();
    assert.match(fs.readFileSync(file, 'utf8'), /\| PROJ-1 \| Retry flake \|/);
    view = await snap(c);
    p = view.publishers.find((x) => x.name === 'rollup');
    assert.deepEqual([p.confirmed, p.last_outcome, p.destination_label], [true, 'ok', 'rollup.md']);
    assert.ok(!JSON.stringify(view.publishers).includes(s.storePath), 'no local paths in the snapshot');
    await publish(c, { publisher: 'rollup' });
    await s.settle();
    assert.equal((await snap(c)).publishers[0].runs[0].outcome, 'ok', 'a confirmed destination needs no new confirmation');
    s.w.config = { ...s.w.config, publish: [{ name: 'rollup', kind: 'markdown', path: 'elsewhere/rollup.md' }] };
    await publish(c, { publisher: 'rollup' });
    await s.settle();
    assert.equal((await snap(c)).publishers[0].last_outcome, 'needs-confirmation');
    assert.equal((await publish(c, { publisher: 'nope' })).status, 400);
  } finally { await s.stop(); }
});

test('a publisher with on = ["reconcile"] publishes after each reconciliation; an artifact publisher stores its URL', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'st-pubjob-'));
  const store = path.join(dir, 'remote.json');
  const artifactClientFor = () => createArtifactClient({ claudePath: process.execPath, claudeArgs: [FAKE], spawnEnv: { FAKE_ARTIFACT_STORE: store }, workRoot: path.join(dir, 'runs') });
  const s = scenario({ withServer: true, jobOpts: { artifactClientFor } });
  s.config.publish = [{ name: 'team', kind: 'artifact', title: 'Team tracker', on: ['reconcile'], executor: 'cli' }];
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1');
    const c = await s.client();
    await publish(c, { publisher: 'team', confirm: true });
    await s.settle();
    let p = (await snap(c)).publishers[0];
    assert.equal(p.last_outcome, 'ok', p.last_error);
    assert.match(p.url, /^https:\/\/claude\.ai\/artifact\/fake-/);
    assert.equal(p.label, 'Live');
    s.ticket('ffffffff-0000-4000-8000-000000000002', 'PROJ-2');
    await c.post('/v1/requests', { id: randomUUID(), kind: 'refresh', target_id: null, expected_revision: null, payload: {} });
    await s.settle();
    await s.settle();
    p = (await snap(c)).publishers[0];
    assert.equal(p.runs[0].trigger, 'after-reconcile');
    assert.ok(JSON.parse(fs.readFileSync(store, 'utf8')).docs['tickets/PROJ-2'], 'the new ticket reached the artifact');
  } finally { await s.stop(); }
});
