import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from '../../src/worker/worker.js';
import { createExtension as schedulerExt } from '../../src/reconcile/extension.js';
import { saveUserConfig } from '../../src/config/config.js';
import { makeHome, cli } from './helpers.js';

const FAKE = path.resolve('tests/fixtures/fake-artifact-claude.js');
const T1 = 'eeeeeeee-0000-4000-8000-000000000001';

// Plays the Claude Code session: executes plan.json in the run directory with the simulated store.
function executeAsSession(runDir, store) {
  const out = execFileSync(process.execPath, [FAKE], { cwd: runDir, env: { ...process.env, FAKE_ARTIFACT_STORE: store }, encoding: 'utf8' });
  const text = JSON.parse(out).result;
  const json = /```json\s*([\s\S]*?)```/.exec(text)[1];
  const file = path.join(runDir, 'result.json');
  fs.writeFileSync(file, json);
  return file;
}

test('an artifact publisher runs through a Claude Code session: --plan writes the plan, --result advances it, and the worker records the outcome', async () => {
  const fx = makeHome();
  const store = path.join(fx.home, 'remote.json');
  fx.config.publish = [{ name: 'team', kind: 'artifact', title: 'Team tracker', fields: ['key', 'title', 'status'] }];
  saveUserConfig(fx.config, fx.env);
  const w = new Worker({ config: fx.config, storeMeta: fx.meta, env: fx.env });
  const ext = schedulerExt({ env: fx.env, config: fx.config }, { providers: { for: () => ({ name: 'github', fetchPr: async () => { throw new Error('offline'); } }) } });
  w.use(ext);
  await w.start();
  w.emit('ticket-create', { ticket: { id: T1, key: 'PROJ-1', title: 'Retry flake', project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } });
  w.publishGeneration();
  const timer = setInterval(() => { try { w.tick(); } catch (err) { console.error(err); } }, 20);
  try {
    const unconfirmed = await cli(['publish', 'team'], fx.env);
    assert.match(unconfirmed.out, /quill publish team --confirm/);
    const refused = await cli(['publish', 'team', '--plan'], fx.env);
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /--confirm/);
    const confirmed = await cli(['publish', 'team', '--confirm'], fx.env);
    assert.match(confirmed.out, /team \(live\): run \/session-quill:publish team in a Claude Code session/);
    const plan = await cli(['publish', 'team', '--plan'], fx.env);
    assert.equal(plan.code, 0, plan.err);
    const runDir = /Run directory: (.+)/.exec(plan.out)[1].trim();
    assert.match(plan.out, /----- PLAN -----/);
    assert.match(plan.out, /"op": "publish"/);
    const done = await cli(['publish', 'team', '--result', executeAsSession(runDir, store)], fx.env);
    assert.equal(done.code, 0, done.err);
    assert.match(done.out, /team: published 1 row to a new artifact — https:\/\/claude\.ai\/artifact\/fake-/);
    const rec = await waitFor(() => w.state.publishers.get('team'));
    assert.deepEqual([rec.last_outcome, !!rec.url, rec.confirmed.length], ['ok', true, 1]);
    // A second publish needs two plans: read, then pinned writes.
    const read = await cli(['publish', 'team', '--plan'], fx.env);
    const dir2 = /Run directory: (.+)/.exec(read.out)[1].trim();
    const next = await cli(['publish', 'team', '--result', executeAsSession(dir2, store)], fx.env);
    assert.match(next.out, /Next plan/);
    const dir3 = /Run directory: (.+)/.exec(next.out)[1].trim();
    const final = await cli(['publish', 'team', '--result', executeAsSession(dir3, store)], fx.env);
    assert.match(final.out, /team: no row changes/);
  } finally { clearInterval(timer); await w.stop(); }
});

async function waitFor(fn) {
  for (let i = 0; i < 100; i += 1) { const v = fn(); if (v && v.last_outcome === 'ok') return v; await new Promise((r) => setTimeout(r, 50)); }
  return fn();
}
