import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeGrant, readGrant, canonicalJson } from '../../src/handoff/grant.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-grant-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
const runDir = () => path.join(base, 'runs', `r${(n += 1)}`);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const GRANT = {
  access: 'autonomous',
  permissions: { read_source: true, edit_source: true, commit: false },
  scopes: [{ name: 'k8s.write', target: 'stg', matchers: { bash: ['kubectl *'], mcp: [], hosts: [] }, fingerprint: 'f1' }],
  actionPins: [{ scope: 'argo.sync', pin: 'argocd app sync pay-stg' }],
  readableRoots: ['/w/checkout', '/q/runs/r1'],
  writableRoots: ['/q/runs/r1'],
  protectedPaths: ['/q'],
  mcpPolicy: { read: [], write: {} },
  trustedMcpServers: ['team_docs'],
  trackerHosts: ['example.atlassian.net'],
};

test('canonicalJson sorts keys at every level and keeps array order', () => {
  assert.equal(canonicalJson({ b: [2, 1, { z: 1, y: 2 }], a: { y: 1, x: 2 }, u: undefined }), '{"a":{"x":2,"y":1},"b":[2,1,{"y":2,"z":1}]}');
});

test('writeGrant writes canonical JSON into the run dir and returns the hash of the file', () => {
  const dir = runDir();
  const { path: file, sha256 } = writeGrant(dir, GRANT);
  assert.equal(file, path.join(dir, 'grant.json'));
  const bytes = fs.readFileSync(file);
  assert.equal(sha256, sha(bytes));
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(bytes.toString('utf8'), `${canonicalJson(GRANT)}\n`);
  assert.deepEqual(fs.readdirSync(dir), ['grant.json'], 'no temp file is left behind');
});

test('key order does not change the hash', () => {
  const reordered = Object.fromEntries(Object.entries(GRANT).reverse());
  reordered.permissions = { commit: false, edit_source: true, read_source: true };
  assert.equal(writeGrant(runDir(), reordered).sha256, writeGrant(runDir(), GRANT).sha256);
});

test('readGrant returns the frozen grant when the hash matches', () => {
  const { path: file, sha256 } = writeGrant(runDir(), GRANT);
  const got = readGrant(file, sha256);
  assert.deepEqual(got, GRANT);
  assert.ok(Object.isFrozen(got) && Object.isFrozen(got.scopes[0].matchers), 'deeply frozen');
  assert.deepEqual(readGrant(file, sha256.toUpperCase()), GRANT, 'hex case does not matter');
});

test('readGrant refuses a grant whose file changed after it was written', () => {
  const { path: file, sha256 } = writeGrant(runDir(), GRANT);
  const widened = fs.readFileSync(file, 'utf8').replace('"permissions":{"commit":false', '"permissions":{"commit":true');
  fs.writeFileSync(file, widened);
  assert.throws(() => readGrant(file, sha256), { code: 'grant-tampered' });
});

test('readGrant refuses a wrong, missing or malformed expected hash', () => {
  const { path: file } = writeGrant(runDir(), GRANT);
  assert.throws(() => readGrant(file, sha('something else')), { code: 'grant-tampered' });
  assert.throws(() => readGrant(file, undefined), { code: 'grant-tampered' });
  assert.throws(() => readGrant(file, ''), { code: 'grant-tampered' });
  assert.throws(() => readGrant(file, 'not-a-hash'), { code: 'grant-tampered' });
});

test('readGrant reports a missing grant file', () => {
  assert.throws(() => readGrant(path.join(runDir(), 'grant.json'), sha('x')), { code: 'grant-missing' });
});

test('readGrant refuses a matching hash over content that is not a grant object', () => {
  const dir = runDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'grant.json');
  for (const text of ['[1,2]', 'null', '{"access":']) {
    fs.writeFileSync(file, text);
    assert.throws(() => readGrant(file, sha(Buffer.from(text))), { code: 'grant-invalid' }, text);
  }
});

test('writeGrant refuses anything but a plain object', () => {
  for (const bad of [null, undefined, [], 'grant', 3]) assert.throws(() => writeGrant(runDir(), bad), { code: 'grant-invalid' });
});

test('the grant file is owner-only where the OS supports modes', { skip: process.platform === 'win32' && 'Windows has no POSIX file modes' }, () => {
  const { path: file } = writeGrant(runDir(), GRANT);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
