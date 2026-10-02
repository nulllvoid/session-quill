import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeEvent, validateEvent, EVENT_KINDS } from '../../src/core/events.js';
import { writeIngress, listIngress, removeIngress } from '../../src/core/ingress.js';
import { putBlob, getBlob } from '../../src/core/blobs.js';

function env() {
  return { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'st-home-')) };
}

const base = { store_id: '11111111-1111-4111-8111-111111111111', machine_id: '22222222-2222-4222-8222-222222222222', producer: 'test' };

test('makeEvent builds a schema 1 envelope and validateEvent accepts it', () => {
  const ev = makeEvent({ ...base, kind: 'bind', payload: { ticket_id: 'x' }, session_id: 's1', occurred_at: '2026-10-02T08:00:00Z' });
  assert.equal(ev.schema_version, 1);
  assert.match(ev.event_id, /^[0-9a-f-]{36}$/);
  assert.equal(ev.sequence, null);
  assert.equal(ev.ingested_at, null);
  assert.equal(ev.source_identity, `bind:${ev.event_id}`);
  assert.doesNotThrow(() => validateEvent(ev));
  assert.ok(EVENT_KINDS.includes('post-tool'));
});

test('validateEvent rejects unknown kinds and newer schema versions', () => {
  const ev = makeEvent({ ...base, kind: 'bind', payload: {}, occurred_at: '2026-10-02T08:00:00Z' });
  assert.throws(() => validateEvent({ ...ev, kind: 'teleport' }), (e) => e.code === 'event-invalid');
  assert.throws(() => validateEvent({ ...ev, schema_version: 2 }), (e) => e.code === 'event-invalid');
  assert.throws(() => validateEvent({ ...ev, occurred_at: '2026-10-02 08:00' }), (e) => e.code === 'event-invalid');
});

test('writeIngress persists <event_id>.json atomically and listIngress orders by occurred_at', () => {
  const e = env();
  const b = makeEvent({ ...base, kind: 'bind', payload: {}, occurred_at: '2026-10-02T08:00:02Z' });
  const a = makeEvent({ ...base, kind: 'bind', payload: {}, occurred_at: '2026-10-02T08:00:01Z' });
  writeIngress(b, e);
  writeIngress(a, e);
  const files = fs.readdirSync(path.join(e.QUILL_HOME, 'ingress'));
  assert.deepEqual(files.sort(), [`${a.event_id}.json`, `${b.event_id}.json`].sort());
  const listed = listIngress(e);
  assert.deepEqual(listed.map((x) => x.event.event_id), [a.event_id, b.event_id]);
  removeIngress(a.event_id, e);
  assert.equal(listIngress(e).length, 1);
});

test('writeIngress fails loudly when the ingress directory is unusable', () => {
  const e = env();
  fs.writeFileSync(path.join(e.QUILL_HOME, 'ingress'), 'not a dir');
  const ev = makeEvent({ ...base, kind: 'bind', payload: {}, occurred_at: '2026-10-02T08:00:01Z' });
  assert.throws(() => writeIngress(ev, e), (err) => err.code === 'ingress-failed');
});

test('listIngress ignores temp files and malformed files are reported, not thrown', () => {
  const e = env();
  const dir = path.join(e.QUILL_HOME, 'ingress');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.x.json.123.tmp'), '{');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  const listed = listIngress(e);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].error, 'malformed');
});

test('putBlob stores by content hash before events reference it and getBlob reads it back', () => {
  const e = env();
  const { hash } = putBlob('full checkpoint text', e);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(getBlob(hash, e), 'full checkpoint text');
  assert.equal(getBlob('0'.repeat(64), e), null);
  assert.deepEqual(putBlob('full checkpoint text', e).hash, hash);
});
