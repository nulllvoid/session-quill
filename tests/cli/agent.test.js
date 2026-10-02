import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from '../../src/worker/worker.js';
import { createExtension as serverExt } from '../../src/server/extension.js';
import { createExtension as handoffExt } from '../../src/handoff/extension.js';
import { recordResult } from '../../src/handoff/results.js';
import { makeHome, cli } from './helpers.js';

const T1 = 'cccccccc-0000-4000-8000-000000000001';

async function start(fx) {
  const w = new Worker({ config: fx.config, storeMeta: fx.meta, env: fx.env });
  const ctx = { env: fx.env, config: fx.config, storeMeta: fx.meta };
  const hext = handoffExt(ctx, { runtimeAvailable: false });
  w.use(serverExt(ctx, { port: 0 }));
  w.use(hext);
  await w.start();
  hext.pause();
  w.emit('ticket-create', { ticket: { id: T1, key: 'PROJ-1', title: 'Roll out retries', project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } });
  w.publishGeneration();
  const timer = setInterval(() => { try { w.tick(); } catch (err) { console.error(err); } }, 20);
  return { w, stop: async () => { clearInterval(timer); await w.stop(); } };
}

test('quill agent list, show and run: recipes with their permissions; a run is queued within the recipe ceiling', async () => {
  const fx = makeHome();
  const { w, stop } = await start(fx);
  try {
    const list = await cli(['agent', 'list'], fx.env);
    assert.equal(list.code, 0, list.err);
    assert.match(list.out, /deploy-check\s+builtin\s+analyse\s+read_source\s+10 min/);
    assert.match(list.out, /standup\s+builtin\s+analyse\s+none\s+5 min/);
    const json = JSON.parse((await cli(['agent', 'list', '--json'], fx.env)).out);
    assert.ok(json.some((r) => r.name === 'attempt-fix' && r.permissions.edit_source === true));
    const show = await cli(['agent', 'show', 'deploy-check'], fx.env);
    assert.match(show.out, /Check the deployment state of \{\{ticket\.key\}\}/);
    assert.match(show.out, /outputs: summary, deploy_evidence, next_action/);
    const beyond = await cli(['agent', 'run', 'deploy-check', 'PROJ-1', '--commit'], fx.env);
    assert.notEqual(beyond.code, 0);
    assert.match(beyond.err, /does not allow commit/);
    const run = await cli(['agent', 'run', 'deploy-check', 'PROJ-1', '--note', 'check prod'], fx.env);
    assert.equal(run.code, 0, run.err);
    assert.match(run.out, /deploy-check queued for PROJ-1 \(permissions: read_source; capped at 10 min\)/);
    const h = [...w.state.handoffs.values()][0];
    assert.deepEqual([h.recipe.name, h.note, h.state], ['deploy-check', 'check prod', 'queued']);
    const unknown = await cli(['agent', 'run', 'nope', 'PROJ-1'], fx.env);
    assert.match(unknown.err, /no recipe named nope/);
  } finally { await stop(); }
});

test('quill agent suggestions, accept and dismiss resolve a recipe run\'s outputs', async () => {
  const fx = makeHome();
  const { w, stop } = await start(fx);
  try {
    const run = await cli(['agent', 'run', 'standup', 'PROJ-1'], fx.env);
    assert.equal(run.code, 0, run.err);
    const h = [...w.state.handoffs.values()][0];
    recordResult(w, h.id, { summary: 'did things', next_action: 'Ship the retry flag', blocker: 'waiting on review' });
    w.publishGeneration();
    const sug = await cli(['agent', 'suggestions', 'PROJ-1'], fx.env);
    assert.match(sug.out, new RegExp(`${h.id.slice(0, 8)} s1\\s+next-action\\s+Ship the retry flag`));
    assert.match(sug.out, /s2\s+blocker\s+waiting on review/);
    const ok = await cli(['agent', 'accept', h.id.slice(0, 8), 's1'], fx.env);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(w.state.tickets.get(T1).next_action, 'Ship the retry flag');
    const no = await cli(['agent', 'dismiss', h.id.slice(0, 8), 's2'], fx.env);
    assert.equal(no.code, 0, no.err);
    assert.equal(w.state.tickets.get(T1).status, 'todo');
    assert.deepEqual(w.state.handoffs.get(h.id).suggestions.map((s) => s.state), ['accepted', 'dismissed']);
  } finally { await stop(); }
});
