// ADR 0018: tracker write-back is opt-in, previewed, confirmed per ticket and journaled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrackerClient, writeSettings, targetStatus } from '../../src/tracker/client.js';
import { push } from '../../src/cli/commands/tracker.js';
import { loadContext } from '../../src/cli/context.js';
import { saveUserConfig, resolveTracker } from '../../src/config/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { projectionsDir } from '../../src/lib/paths.js';
import { makeHome, startWorker, cli, DESC } from '../cli/helpers.js';

const JIRA = { system: 'jira', domain: 'https://example.atlassian.net', url_template: '{domain}/browse/{key}', repo: '' };
const GH = { system: 'github', domain: 'https://github.com', repo: 'acme/app', url_template: '{domain}/{repo}/issues/{number}' };
const LINEAR = { system: 'linear', domain: 'https://linear.app/acme' };

function fake(route) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const r = route(url, init, calls) ?? { status: 404 };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { calls, fetchImpl };
}
const writes = (calls) => calls.filter((c) => c.method !== 'GET' && !(c.body && c.body.query && !c.body.query.startsWith('mutation')));

test('Jira: move through the transition that leads to the target, then comment', async () => {
  const f = fake((url, init) => {
    if (url.endsWith('/transitions') && init.method === 'GET') return { status: 200, body: { transitions: [{ id: '21', to: { name: 'In Progress' } }, { id: '31', to: { name: 'Done' } }] } };
    if (url.endsWith('/transitions') && init.method === 'POST') return { status: 204 };
    if (url.endsWith('/comment')) return { status: 201, body: { id: '1' } };
    return null;
  });
  const c = createTrackerClient({ tracker: JIRA, settings: { token_env: 'T' }, env: { T: 'tok' }, fetchImpl: f.fetchImpl });
  assert.deepEqual(await c.setStatus('PROJ-7', 'done'), { status: 'Done' });
  await c.addComment('PROJ-7', 'Shipped in 0.6.1');
  assert.deepEqual(writes(f.calls).map((x) => [x.method, x.url, x.body]), [
    ['POST', 'https://example.atlassian.net/rest/api/2/issue/PROJ-7/transitions', { transition: { id: '31' } }],
    ['POST', 'https://example.atlassian.net/rest/api/2/issue/PROJ-7/comment', { body: 'Shipped in 0.6.1' }],
  ]);
  await assert.rejects(c.setStatus('PROJ-7', 'Archived'), (e) => e.code === 'transition-unavailable' && /available: In Progress, Done/.test(e.message));
});

test('GitHub: close or reopen the configured repository issue and comment on it', async () => {
  const f = fake((url, init) => (init.method === 'PATCH' || url.endsWith('/comments') ? { status: 200, body: {} } : null));
  const c = createTrackerClient({ tracker: GH, settings: { token_env: 'T' }, env: { T: 'tok' }, fetchImpl: f.fetchImpl });
  await c.setStatus('GH-42', 'closed');
  await c.addComment('GH-42', 'Fixed');
  assert.deepEqual(writes(f.calls).map((x) => [x.method, x.url, x.body]), [
    ['PATCH', 'https://api.github.com/repos/acme/app/issues/42', { state: 'closed' }],
    ['POST', 'https://api.github.com/repos/acme/app/issues/42/comments', { body: 'Fixed' }],
  ]);
});

test('Linear: pick the team workflow state by name and update the issue', async () => {
  const f = fake((url, init) => {
    const q = JSON.parse(init.body).query;
    if (q.startsWith('query States')) return { status: 200, body: { data: { issue: { id: 'uuid-1', team: { states: { nodes: [{ id: 's-todo', name: 'Todo' }, { id: 's-done', name: 'Done' }] } } } } } };
    if (q.startsWith('mutation Move')) return { status: 200, body: { data: { issueUpdate: { success: true } } } };
    return null;
  });
  const c = createTrackerClient({ tracker: LINEAR, settings: {}, env: { LINEAR_API_KEY: 'k' }, fetchImpl: f.fetchImpl });
  await c.setStatus('ENG-12', 'Done');
  const move = f.calls.find((x) => x.body.query.startsWith('mutation Move'));
  assert.deepEqual(move.body.variables, { id: 'uuid-1', state: 's-done' });
});

test('write settings come from the user config only, with defaults per system', () => {
  assert.deepEqual(writeSettings(undefined), { enabled: false, status_map: {} });
  assert.equal(writeSettings({ write_back: 'yes' }).enabled, false, 'only a real boolean true enables it');
  const s = writeSettings({ write_back: true, status_map: { review: 'Code Review', bad: 7 } });
  assert.deepEqual(s, { enabled: true, status_map: { review: 'Code Review' } });
  assert.equal(targetStatus('jira', 'review', s), 'Code Review');
  assert.equal(targetStatus('jira', 'done', s), 'Done');
  assert.equal(targetStatus('github', 'done', s), 'closed');
  assert.equal(targetStatus('jira', 'blocked', s), null, 'no default for blocked: the owner names the target');
  assert.equal(resolveTracker({ tracker: { ...JIRA, write_back: true } }, null).write_back, undefined, 'the binding tracker never carries write_back');
});

async function linkedTicket(fx, { writeBack = true } = {}) {
  fx.config.tracker = { ...JIRA, prefixes: ['PROJ'], ...(writeBack ? { write_back: true } : {}) };
  saveUserConfig(fx.config, fx.env);
  const w = await startWorker(fx);
  const a = await cli(['ticket', 'create', '--description', DESC, 'Ship retry fix', '--session', 'sess-T'], fx.env);
  const key = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(a.out)[1];
  await cli(['ticket', 'relink', key, '--external', 'PROJ-7', '--session', 'sess-T'], fx.env);
  await cli(['ticket', 'set', 'PROJ-7', '--status', 'done'], fx.env);
  w.worker.tick();
  return w;
}

function io() {
  let out = '';
  return { io: { println: (s = '') => { out += `${s}\n`; }, json: (o) => { out += JSON.stringify(o); }, out: (s) => { out += s; }, error: () => {} }, get out() { return out; } };
}

const jiraRoute = (url, init) => {
  if (url.includes('/issue/PROJ-7?')) return { status: 200, body: { fields: { summary: 'Retry', status: { name: 'In Progress' } } } };
  if (url.endsWith('/transitions') && init.method === 'GET') return { status: 200, body: { transitions: [{ id: '31', to: { name: 'Done' } }] } };
  if (url.endsWith('/transitions')) return { status: 204 };
  return null;
};

test('tracker push previews by default, sends only with --confirm, and journals the push', async () => {
  const fx = makeHome();
  const w = await linkedTicket(fx);
  try {
    const ctx = loadContext({ ...fx.env, JIRA_TOKEN: 'tok' });
    const f = fake(jiraRoute);
    const preview = io();
    assert.equal(await push(ctx, preview.io, ['PROJ-7'], {}, { fetchImpl: f.fetchImpl }), 0);
    assert.match(preview.out, /Preview: nothing has been sent to jira/);
    assert.match(preview.out, /now "In Progress"; ticket PROJ-7 is done/);
    assert.match(preview.out, /would move it to "Done"/);
    assert.deepEqual(writes(f.calls), [], 'a preview sends no write');
    const sent = io();
    assert.equal(await push(ctx, sent.io, ['PROJ-7'], { confirm: true }, { fetchImpl: f.fetchImpl }), 0);
    assert.match(sent.out, /Sent to jira PROJ-7: status "In Progress" → "Done"/);
    assert.equal(writes(f.calls).length, 1);
    w.worker.tick();
    const t = [...w.worker.state.tickets.values()].find((x) => x.key === 'PROJ-7');
    assert.match(t.timeline.at(-1).text, /Pushed status In Progress → Done to jira PROJ-7/);
    assert.equal(t.external.remote.status, 'Done');
  } finally {
    await w.stop();
  }
});

test('tracker push is refused, before any request, while config.toml leaves write_back off', async () => {
  const fx = makeHome();
  const w = await linkedTicket(fx, { writeBack: false });
  try {
    const ctx = loadContext({ ...fx.env, JIRA_TOKEN: 'tok' });
    const f = fake(jiraRoute);
    await assert.rejects(push(ctx, io().io, ['PROJ-7'], { confirm: true }, { fetchImpl: f.fetchImpl }), (e) => e.code === 'write-back-off');
    assert.equal(f.calls.length, 0);
  } finally {
    await w.stop();
  }
});

test('tracker push refuses a local-only ticket before any request, and never sends run notes or the critical spec', async () => {
  const fx = makeHome();
  const w = await linkedTicket(fx);
  const SENT = 'SENTINEL-7f3a';
  try {
    const ctx = loadContext({ ...fx.env, JIRA_TOKEN: 'tok' });
    const t = [...w.worker.state.tickets.values()].find((x) => x.key === 'PROJ-7');
    t.run_notes = [SENT];
    t.critical_spec = { rule: SENT };
    const ok = fake((u, init) => (u.endsWith('/comment') ? { status: 201, body: {} } : jiraRoute(u, init)));
    assert.equal(await push(ctx, io().io, ['PROJ-7'], { confirm: true, comment: 'Shipped' }, { fetchImpl: ok.fetchImpl }), 0);
    assert.ok(writes(ok.calls).length >= 1);
    assert.equal(JSON.stringify(ok.calls).includes(SENT), false, 'no request carries run notes or the critical spec');
    // The CLI reads the projections, so mark the ticket local-only where it looks.
    const dir = projectionsDir(fx.env);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
    for (const f of [path.join(dir, manifest.path, 'snapshot.json'), path.join(dir, 'tickets', `${t.id}.json`)]) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const x of j.tickets ?? [j]) if (x.id === t.id) x.local_only = true;
      fs.writeFileSync(f, JSON.stringify(j));
    }
    const blocked = fake((u, init) => (u.endsWith('/comment') ? { status: 201, body: {} } : jiraRoute(u, init)));
    await assert.rejects(push(ctx, io().io, ['PROJ-7'], { confirm: true, comment: 'Shipped' }, { fetchImpl: blocked.fetchImpl }), (e) => e.code === 'local-only' && /local-only/.test(e.message));
    assert.equal(blocked.calls.length, 0, 'refused before any request');
  } finally {
    await w.stop();
  }
});

test('tracker push redacts a comment before the preview and before it is sent (ADR 0029)', async () => {
  const fx = makeHome();
  const w = await linkedTicket(fx);
  try {
    const ctx = loadContext({ ...fx.env, JIRA_TOKEN: 'tok' });
    const token = `${'gh' + 'p_'}${'aB3'.repeat(12)}`;
    const comment = `token ${token}`;
    const f = fake((u, init) => (u.endsWith('/comment') ? { status: 201, body: {} } : jiraRoute(u, init)));
    const preview = io();
    assert.equal(await push(ctx, preview.io, ['PROJ-7'], { comment }, { fetchImpl: f.fetchImpl }), 0);
    assert.match(preview.out, /would add a comment: token \[secret redacted\]/);
    const json = io();
    assert.equal(await push(ctx, json.io, ['PROJ-7'], { comment, json: true }, { fetchImpl: f.fetchImpl }), 0);
    assert.equal(JSON.parse(json.out).comment, 'token [secret redacted]');
    assert.equal(await push(ctx, io().io, ['PROJ-7'], { comment, confirm: true }, { fetchImpl: f.fetchImpl }), 0);
    const sent = writes(f.calls).find((c) => c.url.endsWith('/comment'));
    assert.deepEqual(sent.body, { body: 'token [secret redacted]' });
    assert.equal(JSON.stringify(f.calls).includes(token), false, 'no request carries the token');
  } finally {
    await w.stop();
  }
});
