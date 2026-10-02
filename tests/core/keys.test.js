import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateKey, slugify, validateParent, safeKeyFileName } from '../../src/core/keys.js';
import { newState, createTicket } from './helpers.js';

test('slugify lowercases, collapses punctuation and caps at 40 chars', () => {
  assert.equal(slugify('Preserve Session  Checkpoints!'), 'preserve-session-checkpoints');
  assert.equal(slugify('a'.repeat(60)).length, 40);
  assert.equal(slugify('   '), 'ticket');
});

test('allocateKey produces distinct keys for identical titles', () => {
  const state = newState();
  const a = allocateKey(state, { prefix: 'LOCAL', title: 'Same title' });
  state.keyIndex.set(a, 'x');
  const b = allocateKey(state, { prefix: 'LOCAL', title: 'Same title' });
  assert.match(a, /^LOCAL-same-title-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test('child keys use the parent key plus a serialized counter', () => {
  const state = newState();
  createTicket(state, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', key: 'LOCAL-parent-abcd1234' });
  const c1 = allocateKey(state, { prefix: 'LOCAL', title: 'child one', parent_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.equal(c1, 'LOCAL-parent-abcd1234.1');
  state.keyIndex.set(c1, 'c1');
  state.counters.childByParent.set('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1);
  const c2 = allocateKey(state, { prefix: 'LOCAL', title: 'child two', parent_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.equal(c2, 'LOCAL-parent-abcd1234.2');
});

test('validateParent rejects self, missing, and cycles', () => {
  const state = newState();
  createTicket(state, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', key: 'LOCAL-a-00000001' });
  createTicket(state, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', key: 'LOCAL-b-00000002', parent_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.throws(() => validateParent(state, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), (e) => e.code === 'parent-invalid');
  assert.throws(() => validateParent(state, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), (e) => e.code === 'parent-invalid');
  assert.throws(() => validateParent(state, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'), (e) => e.code === 'parent-invalid');
  assert.doesNotThrow(() => validateParent(state, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  assert.doesNotThrow(() => validateParent(state, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null));
});

test('safeKeyFileName rejects traversal and keeps keys inside the store', () => {
  assert.equal(safeKeyFileName('LOCAL-a-00000001.2'), 'LOCAL-a-00000001.2');
  assert.throws(() => safeKeyFileName('../etc/passwd'), (e) => e.code === 'key-invalid');
  assert.throws(() => safeKeyFileName('a/b'), (e) => e.code === 'key-invalid');
  assert.throws(() => safeKeyFileName('..'), (e) => e.code === 'key-invalid');
});
