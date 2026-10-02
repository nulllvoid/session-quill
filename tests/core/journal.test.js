import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Journal } from '../../src/core/journal.js';
import { makeEvent } from '../../src/core/events.js';

const base = { store_id: '11111111-1111-4111-8111-111111111111', machine_id: '22222222-2222-4222-8222-222222222222', producer: 'test' };
const ev = (n) => makeEvent({ ...base, kind: 'bind', payload: { n }, occurred_at: '2026-10-02T08:00:00Z' });
const tmpJournal = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-j-')), 'events.jsonl');

test('append assigns monotonically increasing sequences and persists them', () => {
  const file = tmpJournal();
  const j = new Journal(file);
  assert.deepEqual(j.open(), { lastSequence: 0, quarantined: false, corrupt: false });
  const a = j.append(ev(1));
  const b = j.append(ev(2));
  assert.equal(a.sequence, 1);
  assert.equal(b.sequence, 2);
  assert.ok(a.ingested_at);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).sequence, 2);
  j.close();
});

test('reopening resumes at the last sequence and read() yields all events in order', () => {
  const file = tmpJournal();
  const j = new Journal(file);
  j.open();
  j.append(ev(1));
  j.append(ev(2));
  j.close();
  const k = new Journal(file);
  assert.equal(k.open().lastSequence, 2);
  const c = k.append(ev(3));
  assert.equal(c.sequence, 3);
  assert.deepEqual([...k.read()].map((e) => e.sequence), [1, 2, 3]);
  assert.deepEqual([...k.readTail(2)].map((e) => e.sequence), [3]);
  k.close();
});

test('a torn final line is quarantined and the journal stays usable', () => {
  const file = tmpJournal();
  const j = new Journal(file);
  j.open();
  j.append(ev(1));
  j.close();
  fs.appendFileSync(file, '{"partial');
  const k = new Journal(file);
  const info = k.open();
  assert.equal(info.quarantined, true);
  assert.equal(info.corrupt, false);
  assert.equal(info.lastSequence, 1);
  assert.equal(k.append(ev(2)).sequence, 2);
  assert.deepEqual([...k.read()].map((e) => e.sequence), [1, 2]);
  const dir = path.dirname(file);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('events.jsonl.quarantine-')));
  k.close();
});

test('a malformed middle line marks the journal corrupt and append is refused', () => {
  const file = tmpJournal();
  const j = new Journal(file);
  j.open();
  j.append(ev(1));
  j.append(ev(2));
  j.close();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[0] = '{"broken';
  fs.writeFileSync(file, lines.join('\n'));
  const k = new Journal(file);
  const info = k.open();
  assert.equal(info.corrupt, true);
  assert.throws(() => k.append(ev(3)), (e) => e.code === 'journal-corrupt');
});

test('hasEvent and hasSource track journaled identities for duplicate suppression', () => {
  const file = tmpJournal();
  const j = new Journal(file);
  j.open();
  const e1 = ev(1);
  j.append(e1);
  assert.equal(j.hasEvent(e1.event_id), true);
  assert.equal(j.hasSource(e1.source_identity), true);
  assert.equal(j.hasEvent('nope'), false);
  j.close();
});
