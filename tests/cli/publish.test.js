import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from '../../src/worker/worker.js';
import { createExtension as schedulerExt } from '../../src/reconcile/extension.js';
import { saveUserConfig } from '../../src/config/config.js';
import { makeHome, cli } from './helpers.js';

const T1 = 'dddddddd-0000-4000-8000-000000000001';

test('quill publish lists publishers, refuses an unconfirmed destination until --confirm, then publishes', async () => {
  const fx = makeHome();
  fx.config.publish = [{ name: 'rollup', kind: 'markdown', title: 'Roll-up' }];
  saveUserConfig(fx.config, fx.env);
  const w = new Worker({ config: fx.config, storeMeta: fx.meta, env: fx.env });
  const ext = schedulerExt({ env: fx.env, config: fx.config }, { providers: { for: () => ({ name: 'github', fetchPr: async () => { throw new Error('offline'); } }) } });
  w.use(ext);
  await w.start();
  w.emit('ticket-create', { ticket: { id: T1, key: 'PROJ-1', title: 'Retry flake', project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } });
  w.publishGeneration();
  const timer = setInterval(() => { try { w.tick(); } catch (err) { console.error(err); } }, 20);
  try {
    const list = await cli(['publish', 'list'], fx.env);
    assert.equal(list.code, 0, list.err);
    assert.match(list.out, /rollup\s+Note\s+rollup\.md\s+not confirmed/);
    const first = await cli(['publish', 'rollup'], fx.env);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /rollup \(note\): waiting for confirmation/);
    assert.match(first.out, /quill publish rollup --confirm/);
    const file = path.join(fx.storePath, 'rollups', 'rollup.md');
    assert.ok(!fs.existsSync(file));
    const second = await cli(['publish', 'rollup', '--confirm'], fx.env);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /rollup \(note\): 1 ticket written to rollup\.md/);
    assert.match(fs.readFileSync(file, 'utf8'), /PROJ-1/);
    const unknown = await cli(['publish', 'nope'], fx.env);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.err, /no publisher named nope/);
  } finally { clearInterval(timer); await w.stop(); }
});
