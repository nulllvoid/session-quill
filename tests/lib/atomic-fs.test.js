import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeFileAtomic, writeJsonAtomic, readJsonIfExists, renameAtomic } from '../../src/lib/atomic-fs.js';

test('writeFileAtomic replaces existing content and leaves no temp files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const p = path.join(dir, 'a.txt');
  writeFileAtomic(p, 'one');
  writeFileAtomic(p, 'two');
  assert.equal(fs.readFileSync(p, 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(dir), ['a.txt']);
});

test('writeJsonAtomic + readJsonIfExists round trip; missing returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  writeJsonAtomic(path.join(dir, 'x.json'), { a: 1 });
  assert.deepEqual(readJsonIfExists(path.join(dir, 'x.json')), { a: 1 });
  assert.equal(readJsonIfExists(path.join(dir, 'missing.json')), null);
});

test('renameAtomic retries a transient EPERM and never truncates the destination', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const from = path.join(dir, 'from.txt');
  const to = path.join(dir, 'to.txt');
  fs.writeFileSync(from, 'new');
  fs.writeFileSync(to, 'old');
  let calls = 0;
  const rename = (a, b) => { calls++; if (calls < 3) { const e = new Error('busy'); e.code = 'EPERM'; throw e; } fs.renameSync(a, b); };
  renameAtomic(from, to, { rename, delayMs: 1 });
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(to, 'utf8'), 'new');
});

test('renameAtomic gives up after retries, removes temp, destination intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const from = path.join(dir, 'from.txt');
  const to = path.join(dir, 'to.txt');
  fs.writeFileSync(from, 'new');
  fs.writeFileSync(to, 'old');
  const rename = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
  assert.throws(() => renameAtomic(from, to, { rename, delayMs: 1, maxAttempts: 3 }), /EBUSY|busy/);
  assert.equal(fs.readFileSync(to, 'utf8'), 'old');
  assert.equal(fs.existsSync(from), false);
});
