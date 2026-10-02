import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrackerClient } from '../../src/tracker/client.js';
import { buildRuntimeIdentity } from '../../src/config/runtime.js';
import { createStoreMeta } from '../../src/config/store.js';
import { normalizeSchedules } from '../../src/schedule/config.js';
import { createJobs } from '../../src/schedule/jobs.js';
import { scenario, T1 } from '../acceptance/scenario.js';

const JIRA = { system: 'jira', domain: 'https://example.atlassian.net', url_template: '{domain}/browse/{key}', repo: '' };
function recorder(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = typeof responses === 'function' ? responses(url, init) : responses;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  return { calls, fetchImpl };
}

test('the Jira client reads one issue from the configured site with a bearer or basic token, and never writes', async () => {
  const r = recorder({ status: 200, body: { fields: { summary: 'Retry flake', status: { name: 'In Review' }, assignee: { displayName: 'Sam Lee' }, fixVersions: [{ name: '1.4' }] } } });
  const c = createTrackerClient({ tracker: JIRA, settings: { token_env: 'JIRA_TOKEN', username_env: 'JIRA_EMAIL' }, env: { JIRA_TOKEN: 'tok', JIRA_EMAIL: 'me@example.com' }, fetchImpl: r.fetchImpl });
  assert.deepEqual(await c.fetchIssue('PROJ-7'), { title: 'Retry flake', status: 'In Review', assignee: 'Sam Lee', fix_versions: ['1.4'] });
  assert.equal(r.calls[0].url, 'https://example.atlassian.net/rest/api/2/issue/PROJ-7?fields=summary,status,assignee,fixVersions');
  assert.equal(r.calls[0].init.method ?? 'GET', 'GET');
  assert.equal(r.calls[0].init.headers.authorization, `Basic ${Buffer.from('me@example.com:tok').toString('base64')}`);
  assert.equal(r.calls[0].init.redirect, 'error');
  const bearer = recorder({ status: 200, body: { fields: { summary: 's', status: { name: 'Done' } } } });
  await createTrackerClient({ tracker: JIRA, settings: { token_env: 'JIRA_TOKEN' }, env: { JIRA_TOKEN: 'pat' }, fetchImpl: bearer.fetchImpl }).fetchIssue('PROJ-8');
  assert.equal(bearer.calls[0].init.headers.authorization, 'Bearer pat');
});

test('tracker errors name the variable, never the token; a missing issue is "not found"; odd keys are refused before any request', async () => {
  const none = recorder({ status: 200 });
  await assert.rejects(createTrackerClient({ tracker: JIRA, settings: { token_env: 'JIRA_TOKEN' }, env: {}, fetchImpl: none.fetchImpl }).fetchIssue('PROJ-1'), /set JIRA_TOKEN/);
  assert.equal(none.calls.length, 0);
  const denied = recorder({ status: 401 });
  await assert.rejects(createTrackerClient({ tracker: JIRA, settings: { token_env: 'JIRA_TOKEN' }, env: { JIRA_TOKEN: 'hunter2' }, fetchImpl: denied.fetchImpl }).fetchIssue('PROJ-1'), (e) => /HTTP 401 \(check JIRA_TOKEN\)/.test(e.message) && !e.message.includes('hunter2'));
  const missing = recorder({ status: 404 });
  await assert.rejects(createTrackerClient({ tracker: JIRA, settings: { token_env: 'JIRA_TOKEN' }, env: { JIRA_TOKEN: 't' }, fetchImpl: missing.fetchImpl }).fetchIssue('PROJ-404'), (e) => e.code === 'not-found');
  const odd = recorder({ status: 200 });
  await assert.rejects(createTrackerClient({ tracker: JIRA, settings: { token_env: 'JIRA_TOKEN' }, env: { JIRA_TOKEN: 't' }, fetchImpl: odd.fetchImpl }).fetchIssue('../../admin'), /not a tracker key/);
  assert.equal(odd.calls.length, 0);
  await assert.rejects(createTrackerClient({ tracker: { ...JIRA, domain: '' }, settings: {}, env: {}, fetchImpl: odd.fetchImpl }).fetchIssue('PROJ-1'), /tracker\.domain/);
});

test('GitHub and Linear clients read issues from their fixed API hosts', async () => {
  const gh = recorder({ status: 200, body: { title: 'Bug', state: 'open', assignee: { login: 'octo' }, milestone: { title: 'v2' } } });
  const github = createTrackerClient({ tracker: { system: 'github', domain: 'https://github.com', repo: 'acme/app' }, settings: { token_env: 'GH_TOKEN' }, env: { GH_TOKEN: 'g' }, fetchImpl: gh.fetchImpl });
  assert.deepEqual(await github.fetchIssue('APP-12'), { title: 'Bug', status: 'open', assignee: 'octo', fix_versions: ['v2'] });
  assert.equal(gh.calls[0].url, 'https://api.github.com/repos/acme/app/issues/12');
  const ln = recorder({ status: 200, body: { data: { issue: { title: 'Linear issue', state: { name: 'Todo' }, assignee: { name: 'Kim' }, cycle: { name: 'Cycle 9' } } } } });
  const linear = createTrackerClient({ tracker: { system: 'linear', domain: 'https://linear.app/acme' }, settings: { token_env: 'LINEAR_KEY' }, env: { LINEAR_KEY: 'lin' }, fetchImpl: ln.fetchImpl });
  assert.deepEqual(await linear.fetchIssue('ENG-5'), { title: 'Linear issue', status: 'Todo', assignee: 'Kim', fix_versions: ['Cycle 9'] });
  assert.equal(ln.calls[0].url, 'https://api.linear.app/graphql');
  assert.match(ln.calls[0].init.body, /query/);
  assert.doesNotMatch(ln.calls[0].init.body, /mutation/);
  assert.equal(ln.calls[0].init.headers.authorization, 'lin');
});

test('sync settings in [tracker] never switch on key recognition, and a repository cannot set them', () => {
  const meta = createStoreMeta({ store_name: 'Q', owner_machine_id: '22222222-2222-4222-8222-222222222222', timezone: 'UTC' });
  const { identity } = buildRuntimeIdentity({ storeMeta: meta, config: { store_path: 'C:/Q', tracker: { sync_token_env: 'JIRA_TOKEN', environments: ['prod'] }, repos: {} } });
  assert.equal(identity.tracker, null);
  const { schedules, warnings } = normalizeSchedules({ schedule: [{ name: 'sync', job: 'tracker-sync', every: '6h' }, { name: 'big', job: 'tracker-sync', every: '1d', limit: 5000 }] }, { timeZone: 'UTC', now: Date.parse('2026-10-03T00:00:00Z') });
  assert.deepEqual(schedules.map((s) => [s.name, s.limit]), [['sync', 100]]);
  assert.match(warnings.join('\n'), /big.*limit must be a whole number from 1 to 500/);
});

test('the tracker-sync job records remote title, status, assignee and fix versions, validates keys, and leaves revisions and local status alone', async () => {
  const issues = { 'PROJ-1': { status: 200, body: { fields: { summary: 'Remote title', status: { name: 'In Review' }, assignee: { displayName: 'Sam' }, fixVersions: [{ name: '1.4' }] } } }, 'PROJ-2': { status: 404 } };
  const r = recorder((url) => issues[/issue\/([^?]+)/.exec(url)[1]]);
  const s = scenario({ jobOpts: { trackerFetch: r.fetchImpl } });
  s.config.tracker = { ...JIRA, prefixes: ['PROJ'], sync_token_env: 'JIRA_TOKEN' };
  s.env.JIRA_TOKEN = 'tok';
  await s.start();
  try {
    const mk = (id, key) => s.ingest('ticket-create', { ticket: { id, key, title: `Local ${key}`, project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null, external: { system: 'jira', key, url: `https://example.atlassian.net/browse/${key}`, validation: 'pending', validated_at: null, error: null } } });
    mk(T1, 'PROJ-1');
    mk('aaaaaaaa-2222-4222-8222-000000000002', 'PROJ-2');
    s.ticket('aaaaaaaa-2222-4222-8222-000000000003', 'LOCAL-x-00000003');
    s.w.tick();
    const before = s.w.state.tickets.get(T1).revision;
    const jobs = createJobs({ providers: null, trackerFetch: r.fetchImpl });
    const out = await jobs['tracker-sync'](s.w, { settings: { limit: 100 } });
    assert.equal(out.summary, 'checked 2 tracker keys: 1 found, 1 not found');
    const t1 = s.w.state.tickets.get(T1);
    assert.deepEqual([t1.external.validation, t1.external.remote.status, t1.external.remote.assignee, t1.external.remote.fix_versions], ['valid', 'In Review', 'Sam', ['1.4']]);
    assert.deepEqual([t1.title, t1.status, t1.revision], ['Local PROJ-1', 'todo', before], 'remote data never edits the ticket');
    assert.equal(s.w.state.tickets.get('aaaaaaaa-2222-4222-8222-000000000002').external.validation, 'not-found');
    assert.equal(r.calls.length, 2, 'local keys are not looked up');
  } finally { await s.stop(); }
});
