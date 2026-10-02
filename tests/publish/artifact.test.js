import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planRowWrites, publishArtifact, docId } from '../../src/publish/artifact.js';
import { renderArtifactPage } from '../../src/publish/artifact-page.js';
import { createArtifactClient } from '../../src/publish/artifact-client.js';

const FAKE = path.resolve('tests/fixtures/fake-artifact-claude.js');

test('row planning creates missing rows, writes only fields nobody else changed, keeps editors\' values and pins every write', () => {
  const local = { 'PROJ-1': { key: 'PROJ-1', status: 'review', next: 'Ship it' }, 'PROJ-2': { key: 'PROJ-2', status: 'active', next: 'Start' } };
  const last = { 'PROJ-1': { key: 'PROJ-1', status: 'active', next: 'Write tests' }, 'PROJ-3': { key: 'PROJ-3', status: 'todo', next: '' } };
  const remote = {
    'PROJ-1': { version: 7, data: { key: 'PROJ-1', status: 'active', next: 'Edited by Sam', _quill: { in_scope: true } } },
    'PROJ-3': { version: 2, data: { key: 'PROJ-3', status: 'todo', next: '', _quill: { in_scope: true } } },
    'OTHER-9': { version: 1, data: { key: 'OTHER-9', note: 'a row someone added by hand' } },
  };
  const { writes, conflicts, published } = planRowWrites({ local, last, remote, now: '2026-10-03T10:00:00Z' });
  const byId = Object.fromEntries(writes.map((w) => [w.doc_id, w]));
  assert.deepEqual(byId['PROJ-1'], { op: 'update', collection: 'tickets', doc_id: 'PROJ-1', if_version: 7, data: { status: 'review', _quill: { in_scope: true, published_at: '2026-10-03T10:00:00Z' } } });
  assert.deepEqual(byId['PROJ-2'], { op: 'set', collection: 'tickets', doc_id: 'PROJ-2', data: { key: 'PROJ-2', status: 'active', next: 'Start', _quill: { in_scope: true, published_at: '2026-10-03T10:00:00Z' } } });
  assert.deepEqual(byId['PROJ-3'], { op: 'update', collection: 'tickets', doc_id: 'PROJ-3', if_version: 2, data: { status: { __delete__: true }, next: { __delete__: true }, _quill: { in_scope: false, published_at: '2026-10-03T10:00:00Z' } } }, 'out of scope: blanked to its key and marker, never deleted');
  assert.ok(!byId['OTHER-9'], 'rows Quill did not create are left alone');
  assert.deepEqual(conflicts, [{ key: 'PROJ-1', field: 'next', kept: 'Edited by Sam' }]);
  assert.deepEqual(published['PROJ-1'], { key: 'PROJ-1', status: 'review', next: 'Write tests' }, 'a kept edit is not recorded as published');
  assert.equal(docId('LOCAL-a b/c'), 'LOCAL-a_b_c');
});

test('the artifact page renders rows from the shared db with text nodes, follows the page contract and degrades without the viewer', () => {
  const html = renderArtifactPage({ title: 'Team <tracker>', fields: ['key', 'title', 'status', 'next'] });
  assert.match(html, /<title>Team &lt;tracker&gt;<\/title>/);
  assert.match(html, /claude\.use\("db"\)/);
  assert.doesNotMatch(html, /window\.claude\.db|innerHTML\s*=\s*[^'"`]/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.match(html, /textContent/);
  assert.doesNotMatch(html, /<script[^>]+src=/, 'no external scripts');
});

test('the executor runs a plan through the agent runtime: create publishes the page and writes rows; a later sync reads, then writes pinned updates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-art-'));
  const store = path.join(dir, 'remote.json');
  const client = createArtifactClient({ claudePath: process.execPath, claudeArgs: [FAKE], spawnEnv: { FAKE_ARTIFACT_STORE: store }, workRoot: path.join(dir, 'runs') });
  const publisher = { name: 'team', kind: 'artifact', title: 'Team', fields: ['key', 'status', 'next'], url: null };
  const rows = [{ key: 'PROJ-1', status: 'active', next: 'Go' }, { key: 'PROJ-2', status: 'todo', next: '' }];
  const first = await publishArtifact(publisher, rows, { client, prior: null, now: '2026-10-03T10:00:00Z' });
  assert.match(first.url, /^https:\/\/claude\.ai\/artifact\//);
  assert.equal(first.summary, 'published 2 rows to a new artifact');
  let remote = JSON.parse(fs.readFileSync(store, 'utf8'));
  assert.equal(remote.docs['tickets/PROJ-1'].data.next, 'Go');
  assert.deepEqual(remote.capabilities.db.rules[0], { path: '', read: 'interact', write: 'admin' });
  remote.docs['tickets/PROJ-1'].data.next = 'Edited on the page';
  remote.docs['tickets/PROJ-1'].version += 1;
  fs.writeFileSync(store, JSON.stringify(remote));
  const second = await publishArtifact({ ...publisher, url: first.url }, [{ key: 'PROJ-1', status: 'review', next: 'Go now' }], { client, prior: first.state, now: '2026-10-03T11:00:00Z' });
  assert.equal(second.summary, 'updated 1 row, 1 out of scope (1 field edited on the page kept)');
  remote = JSON.parse(fs.readFileSync(store, 'utf8'));
  assert.deepEqual([remote.docs['tickets/PROJ-1'].data.status, remote.docs['tickets/PROJ-1'].data.next], ['review', 'Edited on the page']);
  assert.equal(remote.docs['tickets/PROJ-2'].data._quill.in_scope, false);
  assert.equal(remote.publishes, 1, 'the page is not republished when it has not changed');
});

test('an executor failure is reported with its reason, and a runtime that is missing fails with a clear message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-art-'));
  const failing = createArtifactClient({ claudePath: process.execPath, claudeArgs: [FAKE], spawnEnv: { FAKE_ARTIFACT_STORE: path.join(dir, 'r.json'), FAKE_ARTIFACT_FAIL: 'publish' }, workRoot: dir });
  await assert.rejects(publishArtifact({ name: 't', kind: 'artifact', title: 'T', fields: ['key'], url: null }, [{ key: 'K-1' }], { client: failing, prior: null, now: '2026-10-03T10:00:00Z' }), /artifact publish failed: the Artifact tool is not available/);
  const missing = createArtifactClient({ claudePath: path.join(dir, 'no-such-claude'), workRoot: dir });
  await assert.rejects(publishArtifact({ name: 't', kind: 'artifact', title: 'T', fields: ['key'], url: null }, [{ key: 'K-1' }], { client: missing, prior: null, now: '2026-10-03T10:00:00Z' }), /Claude Code runtime/);
});
