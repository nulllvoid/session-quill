import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireLock, lockEndpoint } from '../../src/worker/lock.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const MACHINE = '22222222-2222-4222-8222-222222222222';

test('lockEndpoint derives from owner and store ids, never a hostname', () => {
  const env = { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'st-lock-')) };
  const a = lockEndpoint(STORE, MACHINE, env);
  const b = lockEndpoint(STORE, MACHINE, env);
  const c = lockEndpoint(STORE, '33333333-3333-4333-8333-333333333333', env);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.includes(os.hostname()), false);
});

test('a second worker on the same store refuses ownership; release lets a new one in', async () => {
  const env = { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'st-lock-')) };
  const first = await acquireLock(STORE, MACHINE, env);
  await assert.rejects(() => acquireLock(STORE, MACHINE, env), (e) => e.code === 'lock-held');
  await first.release();
  const second = await acquireLock(STORE, MACHINE, env);
  assert.ok(second.endpoint);
  await second.release();
});

test('isLocked reports a live owner', async () => {
  const env = { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'st-lock-')) };
  const { isLocked } = await import('../../src/worker/lock.js');
  assert.equal(await isLocked(STORE, MACHINE, env), false);
  const lock = await acquireLock(STORE, MACHINE, env);
  assert.equal(await isLocked(STORE, MACHINE, env), true);
  await lock.release();
  assert.equal(await isLocked(STORE, MACHINE, env), false);
});
