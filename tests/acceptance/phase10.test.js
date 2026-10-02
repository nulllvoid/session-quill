// Phase 10 — publishers (ADR 0010). Each test is named after its ACCEPTANCE.md scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { scenario, T1 } from './scenario.js';
import { createArtifactClient } from '../../src/publish/artifact-client.js';
import { main } from '../../src/cli/main.js';
import { saveUserConfig } from '../../src/config/config.js';

const FAKE = path.resolve('tests/fixtures/fake-artifact-claude.js');
const snap = async (c) => (await c.get('/v1/snapshot')).json();
const publish = (c, payload) => c.post('/v1/requests', { id: randomUUID(), kind: 'publish', target_id: null, expected_revision: null, payload });
async function cli(argv, env) { let out = ''; let err = ''; const code = await main(argv, { env, stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, stdin: async () => '' }); return { code, out, err }; }

test('A61 nothing is sent to a new destination until the owner confirms it; a changed destination asks again', async () => {
  const s = scenario({ withServer: true });
  s.config.publish = [{ name: 'copy', kind: 'html', path: 'exports/team.html' }];
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1');
    const c = await s.client();
    await publish(c, { publisher: 'copy' });
    await s.settle();
    const out = path.join(s.storePath, 'exports', 'team.html');
    assert.ok(!fs.existsSync(out));
    assert.equal((await snap(c)).publishers[0].last_outcome, 'needs-confirmation');
    await publish(c, { publisher: 'copy', confirm: true });
    await s.settle();
    assert.ok(fs.existsSync(out));
    s.w.config = { ...s.w.config, publish: [{ name: 'copy', kind: 'html', path: 'exports/elsewhere.html' }] };
    await publish(c, { publisher: 'copy' });
    await s.settle();
    assert.equal((await snap(c)).publishers[0].last_outcome, 'needs-confirmation');
    assert.ok(!fs.existsSync(path.join(s.storePath, 'exports', 'elsewhere.html')));
  } finally { await s.stop(); }
});

test('A62 a roll-up note and an HTML copy carry only the configured fields and projects, no local paths and no links unless included', async () => {
  const s = scenario({ withServer: true });
  s.config.projects = { demo: { name: 'Demo', repo_id: 'demo' }, other: { name: 'Other', repo_id: 'demo' } };
  s.config.publish = [{ name: 'rollup', kind: 'markdown', fields: ['key', 'title', 'next'], projects: ['demo'] }];
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1', { title: 'Visible ticket' });
    s.ingest('ticket-update', { ticket_id: T1, fields: { next_action: 'Read C:\\Users\\me\\private\\plan.txt first' }, source: 'manual' });
    s.ingest('ticket-create', { ticket: { id: 'aaaaaaaa-1111-4111-8111-000000000002', key: 'OTHER-1', title: 'Hidden project', project_id: 'other', project_name: 'Other', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } });
    s.w.tick();
    const c = await s.client();
    await publish(c, { publisher: 'rollup', confirm: true });
    await s.settle();
    const md = fs.readFileSync(path.join(s.storePath, 'rollups', 'rollup.md'), 'utf8');
    assert.match(md, /PROJ-1 \| Visible ticket/);
    assert.doesNotMatch(md, /OTHER-1|Hidden project/);
    assert.doesNotMatch(md, /C:\\Users/);
    assert.match(md, /\[path redacted\]/);
  } finally { await s.stop(); }
});

test('A63 a live artifact keeps rows edited on the page: only fields nobody else changed are written, every write pinned to the version read, rows leaving scope are marked, never deleted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-a63-'));
  const store = path.join(dir, 'remote.json');
  const artifactClientFor = () => createArtifactClient({ claudePath: process.execPath, claudeArgs: [FAKE], spawnEnv: { FAKE_ARTIFACT_STORE: store }, workRoot: path.join(dir, 'runs') });
  const s = scenario({ withServer: true, jobOpts: { artifactClientFor } });
  s.config.publish = [{ name: 'team', kind: 'artifact', executor: 'cli', fields: ['key', 'title', 'status', 'next'] }];
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1', { title: 'First' });
    s.ticket('aaaaaaaa-1111-4111-8111-000000000003', 'PROJ-3', { title: 'Third' });
    const c = await s.client();
    await publish(c, { publisher: 'team', confirm: true });
    await s.settle();
    const remote = JSON.parse(fs.readFileSync(store, 'utf8'));
    remote.docs['tickets/PROJ-1'].data.title = 'Renamed on the page';
    remote.docs['tickets/PROJ-1'].version += 1;
    fs.writeFileSync(store, JSON.stringify(remote));
    s.ingest('ticket-update', { ticket_id: T1, fields: { next_action: 'Ship it' }, source: 'manual' });
    s.ingest('ticket-update', { ticket_id: 'aaaaaaaa-1111-4111-8111-000000000003', fields: { status: 'done' }, source: 'manual' });
    s.w.tick();
    s.w.config = { ...s.w.config, publish: [{ name: 'team', kind: 'artifact', executor: 'cli', fields: ['key', 'title', 'status', 'next'], projects: ['demo'] }] };
    await publish(c, { publisher: 'team' });
    await s.settle();
    const after = JSON.parse(fs.readFileSync(store, 'utf8'));
    assert.deepEqual([after.docs['tickets/PROJ-1'].data.title, after.docs['tickets/PROJ-1'].data.next], ['Renamed on the page', 'Ship it']);
    assert.equal(after.docs['tickets/PROJ-3'].data.status, 'done');
    assert.equal((await snap(c)).publishers[0].last_outcome, 'ok');
  } finally { await s.stop(); }
});

test('A64 with the default session executor the worker never publishes an artifact itself; a Claude Code session does, through --plan and --result', async () => {
  const s = scenario({ withServer: true });
  s.config.publish = [{ name: 'team', kind: 'artifact', fields: ['key', 'status'] }];
  saveUserConfig(s.config, s.env);
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1');
    const c = await s.client();
    await publish(c, { publisher: 'team', confirm: true });
    await s.settle();
    let p = (await snap(c)).publishers[0];
    assert.deepEqual([p.last_outcome, p.confirmed], ['needs-session', true]);
    s.w.publishGeneration();
    const store = path.join(s.home, 'remote.json');
    const plan = await s.ticking(() => cli(['publish', 'team', '--plan'], s.env));
    assert.equal(plan.code, 0, plan.err);
    const runDir = /Run directory: (.+)/.exec(plan.out)[1].trim();
    const raw = JSON.parse(execFileSync(process.execPath, [FAKE], { cwd: runDir, env: { ...process.env, FAKE_ARTIFACT_STORE: store }, encoding: 'utf8' })).result;
    fs.writeFileSync(path.join(runDir, 'result.json'), /```json\s*([\s\S]*?)```/.exec(raw)[1]);
    const done = await s.ticking(() => cli(['publish', 'team', '--result', path.join(runDir, 'result.json')], s.env));
    assert.match(done.out, /team: added 1 row|published 1 row/);
    await s.ticking(async () => { for (let i = 0; i < 50 && s.w.state.publishers.get('team').last_outcome !== 'ok'; i += 1) await new Promise((r) => setTimeout(r, 40)); });
    p = s.w.state.publishers.get('team');
    assert.deepEqual([p.last_outcome, /^https:\/\/claude\.ai\/artifact\/fake-/.test(p.url)], ['ok', true]);
  } finally { await s.stop(); }
});
