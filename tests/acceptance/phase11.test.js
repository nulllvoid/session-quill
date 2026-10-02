// Phase 11 — tracker sync and two-way artifacts (ADR 0011). Each test is named after its
// ACCEPTANCE.md scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { scenario, T1 } from './scenario.js';
import { createArtifactClient } from '../../src/publish/artifact-client.js';
import { submitRequest } from '../../src/server/requests.js';

const FAKE = path.resolve('tests/fixtures/fake-artifact-claude.js');
const JIRA = { system: 'jira', domain: 'https://example.atlassian.net', prefixes: ['PROJ'], sync_token_env: 'JIRA_TOKEN' };
const external = (key) => ({ system: 'jira', key, url: `https://example.atlassian.net/browse/${key}`, validation: 'pending', validated_at: null, error: null });
const createLinked = (s, id, key) => s.ingest('ticket-create', { ticket: { id, key, title: `Local ${key}`, project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null, external: external(key) } });

test('A65 page edits come back as revision-checked requests and comments as ticket timeline entries; a stale edit loses to the ticket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-2way-'));
  const store = path.join(dir, 'remote.json');
  const artifactClientFor = () => createArtifactClient({ claudePath: process.execPath, claudeArgs: [FAKE], spawnEnv: { FAKE_ARTIFACT_STORE: store }, workRoot: path.join(dir, 'runs') });
  const s = scenario({ withServer: true, jobOpts: { artifactClientFor } });
  s.config.publish = [{ name: 'team', kind: 'artifact', executor: 'cli', two_way: true, fields: ['key', 'title', 'status', 'next'] }];
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1', { title: 'Retry flake' });
    s.ticket('aaaaaaaa-3333-4333-8333-000000000002', 'PROJ-2', { title: 'Second' });
    const c = await s.client();
    const publish = () => c.post('/v1/requests', { id: randomUUID(), kind: 'publish', target_id: null, expected_revision: null, payload: { publisher: 'team', confirm: true } });
    await publish();
    await s.settle();
    const remote = JSON.parse(fs.readFileSync(store, 'utf8'));
    assert.match(remote.page, /claude\.use\("user"\)/);
    assert.deepEqual(remote.capabilities.user, {});
    const edit = (id, data) => { remote.docs[`tickets/${id}`].data = { ...remote.docs[`tickets/${id}`].data, ...data }; remote.docs[`tickets/${id}`].version += 1; };
    edit('PROJ-1', { status: 'review', _edits: { status: { by: 'u_editor', at: '2026-10-02T08:30:00Z' } } });
    edit('PROJ-2', { next: 'Page says: call the vendor', _edits: { next: { by: 'u_editor', at: '2026-10-02T08:31:00Z' } } });
    remote.threads = [{ thread_id: 'th1', anchor: 'PROJ-1 Retry flake', comments: [{ comment_id: 'c1', author: 'u_viewer', text: 'Is this live on prod yet?', at: '2026-10-02T08:40:00Z' }] }];
    fs.writeFileSync(store, JSON.stringify(remote));
    s.ingest('ticket-update', { ticket_id: 'aaaaaaaa-3333-4333-8333-000000000002', fields: { priority: 'P1' }, source: 'manual' });
    s.w.tick();
    await publish();
    await s.settle();
    const reqs = [...s.w.state.requests.values()].filter((r) => r.actor_id === 'artifact:team');
    assert.deepEqual(reqs.map((r) => r.kind).sort(), ['set-next-action', 'set-status']);
    s.advance(11_000);
    await s.settle();
    assert.equal(s.w.state.tickets.get(T1).status, 'review', 'the page edit applied');
    const p2 = s.w.state.tickets.get('aaaaaaaa-3333-4333-8333-000000000002');
    assert.equal(p2.next_action, '', 'the ticket changed after publishing, so the page edit conflicted');
    assert.equal(reqs.find((r) => r.kind === 'set-next-action').state === 'conflict' || s.w.state.requests.get(reqs.find((r) => r.kind === 'set-next-action').id).state === 'conflict', true);
    const comment = s.w.state.tickets.get(T1).timeline.find((e) => e.kind === 'comment');
    assert.match(comment.text, /Is this live on prod yet\?/);
    await publish();
    await s.settle();
    const after = JSON.parse(fs.readFileSync(store, 'utf8'));
    assert.equal(after.docs['tickets/PROJ-2'].data.next, '', 'the ticket value replaces the conflicted page edit');
    assert.equal(after.docs['tickets/PROJ-1'].data.status, 'review');
    assert.equal(s.w.state.tickets.get(T1).timeline.filter((e) => e.kind === 'comment').length, 1, 'a comment is added once');
  } finally { await s.stop(); }
});

test('A66 a tracker-sync schedule records what the tracker says and validates keys, without editing tickets', async () => {
  const calls = [];
  const trackerFetch = async (url, init) => {
    calls.push({ url, init });
    const key = /issue\/([^?]+)/.exec(url)[1];
    const body = key === 'PROJ-1' ? { fields: { summary: 'Remote', status: { name: 'In Progress' }, assignee: { displayName: 'Sam' }, fixVersions: [] } } : {};
    return { ok: key === 'PROJ-1', status: key === 'PROJ-1' ? 200 : 404, text: async () => JSON.stringify(body) };
  };
  const s = scenario({ jobOpts: { trackerFetch } });
  s.config.tracker = JIRA;
  s.config.schedule = [{ name: 'sync', job: 'tracker-sync', every: '6h' }];
  s.env.JIRA_TOKEN = 'tok';
  await s.start();
  try {
    createLinked(s, T1, 'PROJ-1');
    createLinked(s, 'bbbbbbbb-4444-4444-8444-000000000002', 'PROJ-2');
    s.w.tick();
    const rev = s.w.state.tickets.get(T1).revision;
    submitRequest(s.w, { id: randomUUID(), kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: 'sync' } });
    await s.settle();
    const t = s.w.state.tickets.get(T1);
    assert.deepEqual([t.external.validation, t.external.remote.status, t.status, t.title, t.revision], ['valid', 'In Progress', 'todo', 'Local PROJ-1', rev]);
    assert.equal(s.w.state.tickets.get('bbbbbbbb-4444-4444-8444-000000000002').external.validation, 'not-found');
    assert.equal(s.w.state.schedules.get('sync').last_summary, 'checked 2 tracker keys: 1 found, 1 not found');
    assert.ok(calls.every((c) => (c.init.method ?? 'GET') === 'GET'), 'reads only');
  } finally { await s.stop(); }
});

test('A67 tracker tokens go only to the tracker host in user config; a repository cannot point them elsewhere, and errors never show them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-a67-'));
  fs.writeFileSync(path.join(dir, '.quill.toml'), '[tracker]\nsystem = "jira"\ndomain = "https://evil.example.com"\nsync_token_env = "OTHER_SECRET"\n');
  const hosts = [];
  const trackerFetch = async (url) => { hosts.push(new URL(url).host); return { ok: false, status: 401, text: async () => '{}' }; };
  const s = scenario({ jobOpts: { trackerFetch }, gateMode: 'nudge', repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', provider: 'github', canonical_path: dir } } });
  s.config.tracker = JIRA;
  s.config.schedule = [{ name: 'sync', job: 'tracker-sync', every: '6h' }];
  s.env.JIRA_TOKEN = 'hunter2';
  s.env.OTHER_SECRET = 'do-not-send';
  await s.start();
  try {
    createLinked(s, T1, 'PROJ-1');
    s.w.tick();
    submitRequest(s.w, { id: randomUUID(), kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: 'sync' } });
    await s.settle();
    assert.deepEqual([...new Set(hosts)], ['example.atlassian.net']);
    const rec = s.w.state.schedules.get('sync');
    assert.equal(rec.last_outcome, 'failed');
    assert.match(rec.last_error, /check JIRA_TOKEN/);
    assert.doesNotMatch(JSON.stringify([...s.w.state.tickets.values()]), /hunter2|do-not-send/);
  } finally { await s.stop(); }
});

test('A68 a one-way artifact never turns page edits into requests or reads comments; it keeps the edit and says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-a68-'));
  const store = path.join(dir, 'remote.json');
  const artifactClientFor = () => createArtifactClient({ claudePath: process.execPath, claudeArgs: [FAKE], spawnEnv: { FAKE_ARTIFACT_STORE: store }, workRoot: path.join(dir, 'runs') });
  const s = scenario({ withServer: true, jobOpts: { artifactClientFor } });
  s.config.publish = [{ name: 'team', kind: 'artifact', executor: 'cli', fields: ['key', 'status', 'next'] }];
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1');
    const c = await s.client();
    const publish = () => c.post('/v1/requests', { id: randomUUID(), kind: 'publish', target_id: null, expected_revision: null, payload: { publisher: 'team', confirm: true } });
    await publish();
    await s.settle();
    const remote = JSON.parse(fs.readFileSync(store, 'utf8'));
    assert.doesNotMatch(remote.page, /claude\.use\("user"\)/);
    remote.docs['tickets/PROJ-1'].data.status = 'done';
    remote.docs['tickets/PROJ-1'].version += 1;
    remote.threads = [{ thread_id: 'th', anchor: 'PROJ-1', comments: [{ comment_id: 'c1', author: 'u', text: 'PROJ-1 hi', at: 'now' }] }];
    fs.writeFileSync(store, JSON.stringify(remote));
    s.ingest('ticket-update', { ticket_id: T1, fields: { status: 'active' }, source: 'manual' });
    s.w.tick();
    await publish();
    await s.settle();
    assert.equal([...s.w.state.requests.values()].filter((r) => r.actor_id === 'artifact:team').length, 0);
    assert.equal(s.w.state.tickets.get(T1).timeline.filter((e) => e.kind === 'comment').length, 0);
    assert.match(s.w.state.publishers.get('team').last_summary, /1 field edited on the page kept/);
  } finally { await s.stop(); }
});
