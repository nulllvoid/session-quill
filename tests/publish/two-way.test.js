import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planRowWrites, matchComments } from '../../src/publish/artifact.js';
import { renderArtifactPage } from '../../src/publish/artifact-page.js';


test('with two-way on, an edit made on the page becomes an edit to apply, is acknowledged, and is never reported as a kept conflict', () => {
  const local = { 'PROJ-1': { key: 'PROJ-1', status: 'active', next: 'Write tests', _ticket: { id: 't1', revision: 4 } } };
  const last = { 'PROJ-1': { key: 'PROJ-1', status: 'active', next: 'Write tests' } };
  const remote = { 'PROJ-1': { version: 3, data: { key: 'PROJ-1', status: 'review', next: 'Write tests', _quill: { in_scope: true, revision: 4 }, _edits: { status: { by: 'u_abc', at: '2026-10-03T09:00:00Z' } } } } };
  const { writes, conflicts, edits, published } = planRowWrites({ local, last, remote, now: '2026-10-03T10:00:00Z', editable: ['status', 'next'] });
  assert.deepEqual(edits, [{ ticket_id: 't1', key: 'PROJ-1', field: 'status', value: 'review', expected_revision: 4, by: 'u_abc' }]);
  assert.deepEqual(conflicts, []);
  assert.equal(writes.length, 0, 'the page keeps the edit until the request applies');
  assert.equal(published['PROJ-1'].status, 'review', 'acknowledged: the next publish writes the ticket value over it if the request did not apply');
  const rows = planRowWrites({ local, last, remote, now: 'x' });
  assert.equal(rows.edits.length, 0, 'without two-way, page edits are kept but not applied');
  assert.equal(rows.conflicts.length, 0);
});

test('comments map to the published ticket whose key they name, once each', () => {
  const threads = [
    { thread_id: 'th1', anchor: 'PROJ-1 Retry flake', comments: [{ comment_id: 'c1', author: 'u_a', text: 'Is this on prod?', at: '2026-10-03T09:00:00Z' }, { comment_id: 'c2', author: 'u_b', text: 'Not yet', at: '2026-10-03T09:05:00Z' }] },
    { thread_id: 'th2', anchor: '', comments: [{ comment_id: 'c3', author: 'u_a', text: 'General question about the page', at: '2026-10-03T09:10:00Z' }, { comment_id: 'c4', author: 'u_a', text: 'Also PROJ-2 looks stuck', at: '2026-10-03T09:11:00Z' }] },
  ];
  const keys = new Map([['PROJ-1', 't1'], ['PROJ-2', 't2']]);
  const { matched, unmatched } = matchComments(threads, keys, new Set(['c2']));
  assert.deepEqual(matched.map((m) => [m.comment_id, m.ticket_id]), [['c1', 't1'], ['c4', 't2']]);
  assert.deepEqual(unmatched, ['c3']);
});

test('a two-way page offers editors status and next-action controls; a one-way page has none', () => {
  const two = renderArtifactPage({ title: 'T', fields: ['key', 'status', 'next'], twoWay: true });
  assert.match(two, /claude\.use\("user"\)/);
  assert.match(two, /canEdit\(\)/);
  assert.match(two, /node\('select'\)/);
  assert.match(two, /_edits/);
  const one = renderArtifactPage({ title: 'T', fields: ['key', 'status', 'next'] });
  assert.doesNotMatch(one, /claude\.use\("user"\)|node\('select'\)|_edits/);
});

test('a two-way publish keeps each row\'s published revision current, so editors\' changes check against what they saw', () => {
  const local = { 'PROJ-1': { key: 'PROJ-1', status: 'active', _ticket: { id: 't1', revision: 7 } } };
  const last = { 'PROJ-1': { key: 'PROJ-1', status: 'active' } };
  const stale = { 'PROJ-1': { version: 2, data: { key: 'PROJ-1', status: 'active', _quill: { in_scope: true, revision: 5 } } } };
  const missing = { 'PROJ-1': { version: 2, data: { key: 'PROJ-1', status: 'active', _quill: { in_scope: true } } } };
  for (const remote of [stale, missing]) {
    const { writes } = planRowWrites({ local, last, remote, now: 'n', editable: ['status'] });
    assert.deepEqual(writes, [{ op: 'update', collection: 'tickets', doc_id: 'PROJ-1', if_version: 2, data: { _quill: { in_scope: true, published_at: 'n', revision: 7 } } }]);
  }
  assert.equal(planRowWrites({ local, last, remote: stale, now: 'n' }).writes.length, 0, 'one-way rows are not rewritten for a revision change');
});
