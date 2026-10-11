import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createJobs } from '../../src/schedule/jobs.js';
import { buildSnapshot } from '../../src/worker/projections.js';
import { scenario } from '../acceptance/scenario.js';
import { makeHome, startWorker, cli, DESC } from '../cli/helpers.js';

const JIRA = { system: 'jira', domain: 'https://example.atlassian.net', url_template: '{domain}/browse/{key}', repo: '', prefixes: ['PROJ'], sync_token_env: 'JIRA_TOKEN' };
const id = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;

function routes(table) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    const hit = Object.entries(table).find(([k]) => url.includes(k));
    const r = hit ? hit[1] : { status: 404 };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  return { calls, fetchImpl };
}

function gitRepo(dir, origin) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['-C', dir, 'init', '-q'], { windowsHide: true });
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', origin], { windowsHide: true });
  return dir;
}

test('tracker-sync links mapped tickets, marks a linked-but-missing repository Needs clone, and skips no-code tickets', async () => {
  const issue = (summary) => ({ status: 200, body: { fields: { summary, status: { name: 'To Do' } } } });
  const r = routes({
    'PROJ-3?fields=summary': issue('Payments bug'), 'PROJ-3?fields=project,components': { status: 200, body: { fields: { project: { key: 'PROJ' }, components: [{ name: 'Payments' }] } } }, 'PROJ-3/remotelink': { status: 200, body: [] },
    'PROJ-4?fields=summary': issue('API work'), 'PROJ-4?fields=project,components': { status: 200, body: { fields: { project: { key: 'PROJ' }, components: [] } } }, 'PROJ-4/remotelink': { status: 200, body: [{ object: { url: 'https://github.com/acme/api/pull/1', title: 'PR' } }] },
    'PROJ-5?fields=summary': issue('Write the memo'),
  });
  const s = scenario({ jobOpts: { trackerFetch: r.fetchImpl } });
  const payments = gitRepo(path.join(s.home, 'work', 'payments'), 'git@github.com:acme/payments.git');
  s.config.repos.payments = { project_id: 'demo', display_name: 'payments', canonical_path: payments, default_branch: 'main' };
  s.config.tracker = { ...JIRA, auto_clone_dir: path.join(s.home, 'clones'), repo_map: { 'PROJ/Payments': 'payments' } };
  s.env.JIRA_TOKEN = 'tok';
  await s.start();
  try {
    const mk = (n, key, extra = {}) => s.ingest('ticket-create', { ticket: { id: id(n), key, title: key, project_id: 'demo', category: 'feature', priority: 'P2', repo_id: null, external: { system: 'jira', key, url: `https://example.atlassian.net/browse/${key}`, validation: 'pending', validated_at: null, error: null }, ...extra } });
    mk(3, 'PROJ-3'); mk(4, 'PROJ-4'); mk(5, 'PROJ-5');
    s.w.tick();
    s.ingest('ticket-update', { ticket_id: id(5), fields: { no_code: true } });
    s.w.tick();
    const jobs = createJobs({ providers: null, trackerFetch: r.fetchImpl });
    const out = await jobs['tracker-sync'](s.w, { settings: { limit: 100 } });
    assert.match(out.summary, /checked 3 tracker keys: 3 found; repositories: 1 linked, 1 needs a clone$/);
    const t3 = s.w.state.tickets.get(id(3));
    const t4 = s.w.state.tickets.get(id(4));
    const t5 = s.w.state.tickets.get(id(5));
    assert.equal(t3.repo_id, 'payments');
    assert.deepEqual([t3.repo_resolution.state, t3.repo_resolution.rule, t3.repo_resolution.via], ['linked', 'repo_map', 'PROJ/Payments']);
    assert.equal(t4.repo_id, null);
    assert.deepEqual([t4.repo_resolution.state, t4.repo_resolution.remote], ['needs-clone', 'https://github.com/acme/api.git']);
    assert.match(t4.timeline.at(-1).text, /Repository https:\/\/github.com\/acme\/api.git needs a clone \(linked from the issue\)/);
    assert.equal(t5.repo_resolution, undefined);
    assert.ok(t5.tags.includes('quill/no-code'));
    assert.equal(r.calls.filter((c) => c.url.includes('PROJ-5?fields=project')).length, 0, 'a no-code ticket is never resolved');
    assert.ok(r.calls.every((c) => c.method === 'GET'));
    const snap = buildSnapshot(s.w.state, { generation_id: 'g', generated_at: s.iso() });
    const state = (n) => snap.tickets.find((t) => t.id === id(n)).repo_state;
    assert.deepEqual([state(3), state(4), state(5)], [null, 'needs-clone', 'no-code']);

    const before = t4.timeline.length;
    await jobs['tracker-sync'](s.w, { settings: { limit: 100 } });
    assert.equal(s.w.state.tickets.get(id(4)).timeline.length, before, 'an unchanged resolution adds no timeline entry');

    gitRepo(path.join(s.home, 'clones', 'api'), 'git@github.com:acme/api.git');
    await jobs['tracker-sync'](s.w, { settings: { limit: 100 } });
    const again = s.w.state.tickets.get(id(4)).repo_resolution;
    assert.deepEqual([again.state, again.rule, path.resolve(again.existing_path)], ['needs-clone', 'scan', path.resolve(s.home, 'clones', 'api')]);
    assert.equal(s.w.state.handoffs.size, 0, 'resolution never runs an agent');
  } finally { await s.stop(); }
});

test('the owner sets and clears quill/no-code through ticket-update, while other quill/ tags stay reserved', async () => {
  const s = scenario();
  await s.start();
  try {
    s.ticket(id(1), 'LOCAL-1');
    s.ingest('ticket-update', { ticket_id: id(1), fields: { tags: ['quill/no-code', 'quill/status/done', 'quill/stale', 'docs'] } });
    s.w.tick();
    let t = s.w.state.tickets.get(id(1));
    assert.deepEqual(t.tags.filter((x) => !x.startsWith('quill/status/') && !x.startsWith('quill/cat/')), ['quill/no-code', 'docs']);
    assert.equal(t.status, 'todo');
    s.ingest('ticket-update', { ticket_id: id(1), fields: { no_code: false } });
    s.w.tick();
    t = s.w.state.tickets.get(id(1));
    assert.ok(!t.tags.includes('quill/no-code'));
    assert.match(t.timeline.at(-1).text, /No longer marked as needing no code/);
    s.ingest('ticket-update', { ticket_id: id(1), fields: { no_code: true } });
    s.w.tick();
    assert.ok(s.w.state.tickets.get(id(1)).tags.includes('quill/no-code'));
  } finally { await s.stop(); }
});

test('quill ticket set --no-code yes|no marks a ticket as needing no repository, and the snapshot says No code', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const a = await cli(['ticket', 'create', '--description', DESC, 'Write the memo', '--session', 'sess-N'], fx.env);
    const key = /((?:DEV|FEAT|FIX|RES)-[0-9]+)/.exec(a.out)[1];
    const on = await cli(['ticket', 'set', key, '--no-code', 'yes'], fx.env);
    assert.equal(on.code, 0, on.err);
    assert.match(on.out, /no_code=true/);
    const t = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out).find((x) => x.key === key);
    assert.ok(t.tags.includes('quill/no-code'));
    assert.equal(t.repo_state, 'no-code');
    const bad = await cli(['ticket', 'set', key, '--no-code', 'maybe'], fx.env);
    assert.notEqual(bad.code, 0);
    assert.equal((await cli(['ticket', 'set', key, '--no-code', 'no'], fx.env)).code, 0);
    const t2 = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out).find((x) => x.key === key);
    assert.ok(!t2.tags.includes('quill/no-code'));
  } finally { await w.stop(); }
});
