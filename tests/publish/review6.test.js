// Regression tests for the step 6 review findings (ADR 0010).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { planRowWrites, beginArtifactPublish, continueArtifactPublish } from '../../src/publish/artifact.js';
import { consentId } from '../../src/publish/config.js';
import { createArtifactClient, liveExecutors } from '../../src/publish/artifact-client.js';
import { renderPublishDialog } from '../../ui/views/dialogs.js';
import { scenario, T1 } from '../acceptance/scenario.js';
import { snapshot } from '../ui/fixtures.js';

const FAKE = path.resolve('tests/fixtures/fake-artifact-claude.js');
const pub = (over = {}) => ({ name: 'team', kind: 'artifact', title: 'T', fields: ['key', 'status', 'next'], projects: null, include_links: false, url: null, executor: 'cli', ...over });

test('review C1/I11: consent covers the destination and what is sent; a new URL or a wider scope needs a new confirmation', () => {
  const base = consentId(pub());
  assert.equal(consentId(pub()), base);
  assert.notEqual(consentId(pub({ url: 'https://claude.ai/artifact/other' })), base);
  assert.notEqual(consentId(pub({ fields: ['key', 'status', 'next', 'blocker'] })), base);
  assert.notEqual(consentId(pub({ include_links: true })), base);
  assert.notEqual(consentId(pub({ projects: ['a'] })), base);
  assert.match(base, /^[0-9a-f]{16}$/, 'a fingerprint, never a local path');
});

test('review I2/I5/I8: results must match the plan, the artifact URL must be a claude.ai link, and a created URL survives a later failure', () => {
  const rows = [{ key: 'K-1', status: 'todo', next: '', _ticket: { id: 't1', revision: 1 } }];
  const create = beginArtifactPublish(pub(), rows, { now: '2026-10-03T10:00:00Z' });
  assert.throws(() => continueArtifactPublish(create.context, { url: 'javascript:alert(1)', steps: create.plan.steps.map((s) => ({ op: s.op, ok: true, url: 'javascript:alert(1)' })) }, os.tmpdir()), /not a claude\.ai artifact link/);
  assert.throws(() => continueArtifactPublish(create.context, { url: 'https://claude.ai/artifact/abc', steps: [] }, os.tmpdir()), /does not match the plan/);
  try {
    continueArtifactPublish(create.context, { url: 'https://claude.ai/artifact/abc', steps: [{ op: 'publish', ok: true, url: 'https://claude.ai/artifact/abc' }, { op: 'batch', ok: false, error: 'quota' }] }, os.tmpdir());
    assert.fail('should throw');
  } catch (err) {
    assert.match(err.message, /artifact batch failed: quota/);
    assert.equal(err.url, 'https://claude.ai/artifact/abc', 'the new artifact is not orphaned');
  }
});

test('review I4: a read that reports documents without saving them, or a missing read, fails instead of rewriting every row', () => {
  const rows = [{ key: 'K-1', status: 'todo', next: '', _ticket: { id: 't1', revision: 1 } }];
  const sync = beginArtifactPublish(pub({ url: 'https://claude.ai/artifact/abc' }), rows, { prior: { url: 'https://claude.ai/artifact/abc', page_hash: 'x', rows: {} }, now: 'n' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-r6-'));
  const steps = sync.plan.steps.map((s) => (s.op === 'read' ? { op: 'read', collection: s.collection, ok: true, complete: true, documents: s.collection === 'tickets' ? [{ doc_id: 'K-1', version: 3 }] : [] } : { op: s.op, ok: true, url: 'https://claude.ai/artifact/abc' }));
  assert.throws(() => continueArtifactPublish(sync.context, { url: 'https://claude.ai/artifact/abc', steps }, dir), /K-1 was reported but not saved/);
});

test('review I9/I10: rows Quill did not create are left alone, fields dropped from a publisher are removed, and rows leaving scope are blanked', () => {
  const local = { 'K-1': { key: 'K-1', status: 'todo', _ticket: { id: 't1', revision: 1 } } };
  const last = { 'K-1': { key: 'K-1', status: 'todo', next: 'old plan' }, 'K-2': { key: 'K-2', status: 'done', next: 'x' } };
  const remote = {
    'K-1': { version: 2, data: { key: 'K-1', status: 'todo', next: 'old plan', _quill: { in_scope: true, revision: 1 } } },
    'K-2': { version: 4, data: { key: 'K-2', status: 'done', next: 'x', _quill: { in_scope: true } } },
    'K-9': { version: 1, data: { key: 'K-9', status: 'hand made' } },
  };
  const { writes, foreign } = planRowWrites({ local: { ...local, 'K-9': { key: 'K-9', status: 'todo', _ticket: { id: 't9', revision: 1 } } }, last, remote, now: 'n' });
  const by = Object.fromEntries(writes.map((w) => [w.doc_id, w]));
  assert.deepEqual(by['K-1'].data.next, { __delete__: true }, 'a field no longer published is removed');
  assert.deepEqual([by['K-2'].data.status, by['K-2'].data.next, by['K-2'].data.key], [{ __delete__: true }, { __delete__: true }, undefined], 'out of scope: only the key and the marker remain');
  assert.equal(by['K-2'].data._quill.in_scope, false);
  assert.ok(!by['K-9'], 'a row Quill did not create is never written');
  assert.deepEqual(foreign, ['K-9']);
});

test('review I12: batch steps name one data file per document, so the executor passes them on without reading ticket data', () => {
  const rows = [{ key: 'K-1', status: 'todo', next: 'secret plan', _ticket: { id: 't1', revision: 1 } }];
  const create = beginArtifactPublish(pub(), rows, { now: 'n' });
  const batch = create.plan.steps.find((s) => s.op === 'batch');
  assert.ok(Array.isArray(batch.writes) && batch.writes.every((w) => w.file && !('data' in w)));
  assert.doesNotMatch(JSON.stringify(create.plan), /secret plan/);
  assert.match(create.files[batch.writes[0].file], /secret plan/);
});

test('review I3: the dialog shows the configured artifact URL, and links only claude.ai artifacts', () => {
  const s = snapshot();
  s.publishers = [{ name: 'team', kind: 'artifact', label: 'Live', executor: 'cli', title: 't', fields: ['key'], projects: null, destination_label: 'https://claude.ai/artifact/B', url: 'https://claude.ai/artifact/B', last_url: 'https://claude.ai/artifact/A', confirmed: false, runs: [] }, { name: 'bad', kind: 'artifact', label: 'Live', executor: 'cli', title: 'b', fields: ['key'], projects: null, destination_label: 'javascript:alert(1)', url: 'javascript:alert(1)', confirmed: true, runs: [] }];
  const html = renderPublishDialog(s, { now: '2026-10-02T12:00:00Z', pending: [] });
  assert.match(html, /href="https:\/\/claude\.ai\/artifact\/B"/);
  assert.match(html, /last published to https:\/\/claude\.ai\/artifact\/A/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test('review C1/I6/I13 end to end: --plan refuses a destination changed since confirmation, a second --plan while one is pending, and a result from another run; live executors are tracked', async () => {
  assert.equal(typeof liveExecutors, 'function');
  const s = scenario({ withServer: true });
  const { saveUserConfig } = await import('../../src/config/config.js');
  s.config.publish = [{ name: 'team', kind: 'artifact', fields: ['key', 'status'] }];
  saveUserConfig(s.config, s.env);
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1');
    const c = await s.client();
    await c.post('/v1/requests', { id: randomUUID(), kind: 'publish', target_id: null, expected_revision: null, payload: { publisher: 'team', confirm: true } });
    await s.settle();
    s.w.publishGeneration();
    const { main } = await import('../../src/cli/main.js');
    const cli = async (argv) => { let out = ''; let err = ''; const code = await main(argv, { env: s.env, stdout: (x) => { out += x; }, stderr: (x) => { err += x; }, stdin: async () => '' }); return { code, out, err }; };
    s.config.publish = [{ name: 'team', kind: 'artifact', fields: ['key', 'status'], url: 'https://claude.ai/artifact/someone-else' }];
    saveUserConfig(s.config, s.env);
    const changed = await cli(['publish', 'team', '--plan']);
    assert.notEqual(changed.code, 0);
    assert.match(changed.err, /--confirm/);
    s.config.publish = [{ name: 'team', kind: 'artifact', fields: ['key', 'status'] }];
    saveUserConfig(s.config, s.env);
    const first = await cli(['publish', 'team', '--plan']);
    assert.equal(first.code, 0, first.err);
    const second = await cli(['publish', 'team', '--plan']);
    assert.notEqual(second.code, 0);
    assert.match(second.err, /already in progress.*--restart/);
    const stray = path.join(s.home, 'stray-result.json');
    fs.writeFileSync(stray, JSON.stringify({ url: null, steps: [] }));
    const wrong = await cli(['publish', 'team', '--result', stray]);
    assert.notEqual(wrong.code, 0);
    assert.match(wrong.err, /not the result file of the publish in progress/);
  } finally { await s.stop(); }
});
