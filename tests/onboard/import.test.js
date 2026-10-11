import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrackerClient } from '../../src/tracker/client.js';
import { createJobs } from '../../src/schedule/jobs.js';
import { planImport, githubPrefix } from '../../src/onboard/import.js';
import { scenario, T1 } from '../acceptance/scenario.js';

const JIRA = { system: 'jira', domain: 'https://example.atlassian.net', url_template: '{domain}/browse/{key}', repo: '', prefixes: ['PROJ'] };
const GITHUB = { system: 'github', domain: 'https://github.com', url_template: '{domain}/{repo}/issues/{number}', repo: 'acme/web-app', prefixes: [] };

function recorder(route) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = route(url, init) ?? { status: 404 };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  return { calls, fetchImpl };
}

const jiraIssue = (key, summary, extra = {}) => ({ key, fields: { summary, status: { name: 'To Do' }, assignee: { displayName: 'Me' }, fixVersions: [], components: [{ name: 'Payments' }], project: { key: key.split('-')[0] }, ...extra } });

test('the Jira client lists open assigned issues, falling back to /search on sites without /search/jql', async () => {
  const cloud = recorder((url) => (url.includes('/search/jql?') ? { status: 200, body: { issues: [jiraIssue('PROJ-1', 'One'), { key: '../bad' }] } } : null));
  const c = createTrackerClient({ tracker: JIRA, settings: { token_env: 'JIRA_TOKEN' }, env: { JIRA_TOKEN: 't' }, fetchImpl: cloud.fetchImpl });
  const issues = await c.searchAssigned({ limit: 10 });
  assert.deepEqual(issues, [{ key: 'PROJ-1', url: 'https://example.atlassian.net/browse/PROJ-1', title: 'One', status: 'To Do', assignee: 'Me', fix_versions: [], project: 'PROJ', components: ['Payments'] }]);
  assert.match(decodeURIComponent(cloud.calls[0].url), /jql=assignee = currentUser\(\) AND statusCategory != Done/);
  assert.equal(cloud.calls[0].init.method, 'GET');
  const dc = recorder((url) => (url.includes('/rest/api/2/search?') ? { status: 200, body: { issues: [jiraIssue('PROJ-2', 'Two')] } } : null));
  const issues2 = await createTrackerClient({ tracker: JIRA, settings: { token_env: 'JIRA_TOKEN' }, env: { JIRA_TOKEN: 't' }, fetchImpl: dc.fetchImpl }).searchAssigned();
  assert.deepEqual(issues2.map((i) => i.key), ['PROJ-2']);
  assert.equal(dc.calls.length, 2);
});

test('the GitHub client searches open issues assigned to @me in the configured repository, skipping pull requests', async () => {
  const gh = recorder(() => ({ status: 200, body: { items: [{ number: 12, title: 'Bug', state: 'open', assignee: { login: 'me' } }, { number: 13, title: 'PR', state: 'open', pull_request: {} }] } }));
  const c = createTrackerClient({ tracker: GITHUB, settings: { token_env: 'GH' }, env: { GH: 'g' }, fetchImpl: gh.fetchImpl });
  const issues = await c.searchAssigned();
  assert.deepEqual(issues, [{ number: 12, url: 'https://github.com/acme/web-app/issues/12', title: 'Bug', status: 'open', assignee: 'me', fix_versions: [], repo: 'acme/web-app' }]);
  assert.match(gh.calls[0].url, /^https:\/\/api\.github\.com\/search\/issues\?q=/);
  assert.equal(decodeURIComponent(new URL(gh.calls[0].url).searchParams.get('q')), 'repo:acme/web-app is:issue is:open assignee:@me');
  await assert.rejects(createTrackerClient({ tracker: { system: 'linear', domain: 'https://linear.app/x' }, settings: {}, env: { LINEAR_API_KEY: 'k' }, fetchImpl: gh.fetchImpl }).searchAssigned(), (e) => e.code === 'import-unsupported');
});

test('import plans skip issues a ticket already points at, report keys held by other tickets, and name GitHub issues with a prefix', () => {
  assert.equal(githubPrefix(GITHUB), 'WEBAPP');
  assert.match(`${githubPrefix(GITHUB)}-7`, /^[A-Z][A-Z0-9]+-\d+$/);
  assert.equal(githubPrefix({ ...GITHUB, prefixes: ['APP'] }), 'APP');
  assert.equal(githubPrefix({ ...GITHUB, repo: 'acme/123' }), 'GH');
  assert.equal(githubPrefix({ ...GITHUB, repo: 'acme/x' }), 'GH');
  const jira = (key) => ({ system: 'jira', key, url: `https://example.atlassian.net/browse/${key}` });
  const tickets = [{ key: 'PROJ-1', aliases: [], external: jira('PROJ-1') }, { key: 'LOCAL-1', aliases: ['proj-2'], external: jira('PROJ-2') }, { key: 'PROJ-4', aliases: [], external: null }];
  const plan = planImport([{ key: 'PROJ-1', title: 'a' }, { key: 'proj-2', title: 'b' }, { key: 'PROJ-3', title: '  spaced\n title ' }, { key: 'PROJ-3', title: 'dup' }, { key: 'PROJ-4', title: 'held' }], { tracker: JIRA, tickets, storeId: 's', projectId: 'demo', now: '2026-10-11T00:00:00Z' });
  assert.deepEqual(plan.existing, ['PROJ-1', 'PROJ-2']);
  assert.deepEqual(plan.collisions, [{ key: 'PROJ-4', ticket_key: 'PROJ-4' }]);
  assert.deepEqual(plan.create.map((t) => [t.key, t.title, t.repo_id, t.external.validation, t.jira.key]), [['PROJ-3', 'spaced title', null, 'valid', 'PROJ-3']]);
  const gh = planImport([{ number: 7, title: 'x', url: 'https://github.com/acme/web-app/issues/7' }], { tracker: GITHUB, tickets: [], storeId: 's', projectId: 'demo', now: 'n' });
  assert.deepEqual([gh.create[0].key, gh.create[0].jira, gh.create[0].external.url], ['WEBAPP-7', null, 'https://github.com/acme/web-app/issues/7']);
  // WEBAPP-7 already names issue 7 of another repository: a collision, not "already imported".
  const other = [{ key: 'WEBAPP-7', aliases: [], external: { system: 'github', key: 'WEBAPP-7', url: 'https://github.com/acme/other/issues/7' } }];
  const clash = planImport([{ number: 7, title: 'x', url: 'https://github.com/acme/web-app/issues/7' }], { tracker: GITHUB, tickets: other, storeId: 's', projectId: 'demo', now: 'n' });
  assert.deepEqual([clash.create, clash.existing, clash.collisions], [[], [], [{ key: 'WEBAPP-7', ticket_key: 'WEBAPP-7' }]]);
  const same = [{ key: 'LOCAL-9', aliases: [], external: { system: 'github', key: 'APP-7', url: 'https://github.com/Acme/Web-App/issues/7/' } }];
  const known = planImport([{ number: 7, title: 'x', url: 'https://github.com/acme/web-app/issues/7' }], { tracker: GITHUB, tickets: same, storeId: 's', projectId: 'demo', now: 'n' });
  assert.deepEqual([known.create, known.existing], [[], ['WEBAPP-7']], 'a ticket pointing at the same issue under another key counts as imported');
});

test('tracker-sync imports assigned issues as tickets once when import_assigned is on, and never otherwise', async () => {
  const r = recorder((url) => {
    if (url.includes('/search/jql?')) return { status: 200, body: { issues: [jiraIssue('PROJ-1', 'Already here'), jiraIssue('PROJ-5', 'Imported issue')] } };
    if (/\/issue\/PROJ-\d+\?fields=summary/.test(url)) return { status: 200, body: { fields: { summary: 'Remote', status: { name: 'To Do' } } } };
    return null;
  });
  const s = scenario({ jobOpts: { trackerFetch: r.fetchImpl } });
  s.config.tracker = { ...JIRA, sync_token_env: 'JIRA_TOKEN' };
  s.env.JIRA_TOKEN = 'tok';
  await s.start();
  try {
    s.ingest('ticket-create', { ticket: { id: T1, key: 'PROJ-1', title: 'Local', project_id: 'demo', category: 'feature', priority: 'P2', repo_id: 'demo', external: { system: 'jira', key: 'PROJ-1', url: 'https://example.atlassian.net/browse/PROJ-1', validation: 'pending', validated_at: null, error: null } } });
    s.w.tick();
    const jobs = createJobs({ providers: null, trackerFetch: r.fetchImpl });
    await jobs['tracker-sync'](s.w, { settings: { limit: 100 } });
    assert.equal(r.calls.filter((c) => c.url.includes('/search')).length, 0, 'import is opt-in');

    s.w.config.tracker = { ...s.w.config.tracker, import_assigned: true };
    const out = await jobs['tracker-sync'](s.w, { settings: { limit: 100 } });
    assert.match(out.summary, /^imported 1 assigned issue \(PROJ-5\); checked 1 tracker key/);
    const created = [...s.w.state.tickets.values()].find((t) => t.key === 'PROJ-5');
    assert.deepEqual([created.title, created.project_id, created.repo_id, created.status, created.external.system, created.external.validation, created.external.url], ['Imported issue', 'demo', null, 'todo', 'jira', 'valid', 'https://example.atlassian.net/browse/PROJ-5']);
    assert.match(created.timeline[0].text, /imported from jira/);
    assert.equal(s.w.state.tickets.get(T1).title, 'Local', 'an existing ticket is left alone');
    assert.equal(r.calls.filter((c) => c.url.includes('/issue/PROJ-5?fields=summary')).length, 0, 'a ticket imported in this run is not fetched again');

    const again = await jobs['tracker-sync'](s.w, { settings: { limit: 100 } });
    assert.match(again.summary, /^imported 0 assigned issues; checked 2 tracker keys/);
    assert.equal([...s.w.state.tickets.values()].filter((t) => t.key === 'PROJ-5').length, 1);
    assert.equal(s.w.state.handoffs.size, 0, 'importing never runs an agent');
  } finally { await s.stop(); }
});

test('tracker-sync reports an assigned issue whose key another ticket holds, and imports nothing over it', async () => {
  const r = recorder((url) => (url.includes('/search/jql?') ? { status: 200, body: { issues: [jiraIssue('PROJ-6', 'Remote six')] } } : null));
  const s = scenario({ jobOpts: { trackerFetch: r.fetchImpl } });
  s.config.tracker = { ...JIRA, sync_token_env: 'JIRA_TOKEN', import_assigned: true };
  s.env.JIRA_TOKEN = 'tok';
  await s.start();
  try {
    s.ticket(T1, 'PROJ-6', { title: 'Local six, no tracker link' });
    const out = await createJobs({ providers: null, trackerFetch: r.fetchImpl })['tracker-sync'](s.w, { settings: { limit: 100 } });
    assert.match(out.summary, /^imported 0 assigned issues, 1 key collision \(PROJ-6\);/);
    assert.equal(s.w.state.tickets.size, 1);
    assert.equal(s.w.state.tickets.get(T1).title, 'Local six, no tracker link');
  } finally { await s.stop(); }
});
