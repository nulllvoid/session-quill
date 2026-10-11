import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importNow } from '../../src/cli/commands/tracker.js';
import { bootstrapFromTracker } from '../../src/cli/commands/init.js';
import { loadContext } from '../../src/cli/context.js';
import { saveUserConfig, loadUserConfig } from '../../src/config/config.js';
import { makeHome, startWorker } from '../cli/helpers.js';

const JIRA = { system: 'jira', domain: 'https://example.atlassian.net', prefixes: ['PROJ'], sync_token_env: 'JIRA_TOKEN' };

function fake(issues) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    const body = url.includes('/search/jql?') ? { issues: issues.map(([key, summary]) => ({ key, fields: { summary, status: { name: 'To Do' }, project: { key: 'PROJ' } } })) } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}

function io() {
  let out = '';
  return { io: { println: (s = '') => { out += `${s}\n`; }, json: (o) => { out += JSON.stringify(o); }, error: () => {} }, get out() { return out; } };
}

test('quill tracker import creates tickets for new assigned issues through the worker, and only once', async () => {
  const fx = makeHome();
  fx.config.tracker = JIRA;
  saveUserConfig(fx.config, fx.env);
  const w = await startWorker(fx);
  try {
    const env = { ...fx.env, JIRA_TOKEN: 'tok' };
    const f = fake([['PROJ-4', 'Fix the login page'], ['PROJ-9', 'Rotate keys']]);
    const first = io();
    assert.equal(await importNow(loadContext(env), first.io, {}, { fetchImpl: f.fetchImpl }), 0);
    assert.match(first.out, /Imported 2 assigned issues from jira:\n {2}PROJ-4 {2}Fix the login page\n {2}PROJ-9 {2}Rotate keys/);
    assert.ok(f.calls.every((c) => c.method === 'GET'), 'import only reads the tracker');
    const keys = [...w.worker.state.tickets.values()].map((t) => t.key).sort();
    assert.deepEqual(keys, ['PROJ-4', 'PROJ-9']);
    const again = io();
    await importNow(loadContext(env), again.io, {}, { fetchImpl: f.fetchImpl });
    assert.match(again.out, /No new assigned issues on jira \(2 already tracked\)/);
    assert.equal(w.worker.state.tickets.size, 2);
  } finally { await w.stop(); }
});

test('init --bootstrap-from-tracker turns the import on, keeps the reconcile schedule, adds tracker-sync and imports once', async () => {
  const fx = makeHome();
  fx.config.tracker = JIRA;
  saveUserConfig(fx.config, fx.env);
  const out = io();
  const f = fake([['PROJ-2', 'Imported while the worker is off']]);
  await bootstrapFromTracker({ ...fx.env, JIRA_TOKEN: 'tok' }, out.io, {}, { fetchImpl: f.fetchImpl });
  const cfg = loadUserConfig(fx.env);
  assert.equal(cfg.tracker.import_assigned, true);
  assert.deepEqual(cfg.schedule.map((s) => [s.name, s.job, s.every]), [['reconcile', 'reconcile', '2h'], ['tracker-sync', 'tracker-sync', '6h']]);
  assert.match(out.out, /Imported 1 assigned issue from jira \(the worker is not running; they apply when it starts\)/);
  const w = await startWorker({ ...fx, config: cfg });
  try {
    w.worker.tick();
    assert.deepEqual([...w.worker.state.tickets.values()].map((t) => [t.key, t.repo_id]), [['PROJ-2', null]]);
  } finally { await w.stop(); }
  const second = io();
  await bootstrapFromTracker({ ...fx.env, JIRA_TOKEN: 'tok' }, second.io, {}, { fetchImpl: f.fetchImpl });
  assert.equal(loadUserConfig(fx.env).schedule.length, 2, 'a second bootstrap adds no second schedule');
});

test('init --bootstrap-from-tracker explains what is missing when no Jira or GitHub tracker is configured', async () => {
  const fx = makeHome();
  await assert.rejects(bootstrapFromTracker(fx.env, io().io, {}), (e) => e.code === 'tracker-unsupported' && /\[tracker\] table/.test(e.message));
  assert.equal(loadUserConfig(fx.env).tracker, undefined);
});
