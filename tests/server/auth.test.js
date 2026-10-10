import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAuth, parseCookies, hashSecret } from '../../src/server/auth.js';

const NOW = Date.parse('2026-10-02T08:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

test('a bootstrap secret is accepted by hash, exchanged once, then invalid', () => {
  const auth = createAuth({ clock: () => NOW });
  const secret = 'a'.repeat(64);
  auth.acceptSecretHash(hashSecret(secret), NOW + 600_000);
  const token = auth.exchangeSecret(secret);
  assert.ok(token);
  assert.equal(auth.exchangeSecret(secret), null, 'one use only');
  assert.equal(auth.verifyToken(token), true);
  assert.equal(auth.verifyToken('nope'), false);
});

test('expired secrets are rejected', () => {
  let now = NOW;
  const auth = createAuth({ clock: () => now });
  const secret = 'b'.repeat(64);
  auth.acceptSecretHash(hashSecret(secret), NOW + 1000);
  now = NOW + 2000;
  assert.equal(auth.exchangeSecret(secret), null);
});

test('csrf tokens are bound to the session token and verify', () => {
  const auth = createAuth({ clock: () => NOW });
  const secret = 'c'.repeat(64);
  auth.acceptSecretHash(hashSecret(secret), NOW + 600_000);
  const token = auth.exchangeSecret(secret);
  const csrf = auth.csrfFor(token);
  assert.equal(auth.verifyCsrf(token, csrf), true);
  assert.equal(auth.verifyCsrf(token, `${csrf}x`), false);
  assert.notEqual(auth.csrfFor('other'), csrf);
});

test('parseCookies and host/origin checks', () => {
  assert.deepEqual(parseCookies('a=1; st_owner=tok; b=2'), { a: '1', st_owner: 'tok', b: '2' });
  const auth = createAuth({ clock: () => NOW });
  const ok = (headers) => auth.checkOrigin({ headers }, 4321);
  assert.equal(ok({ host: '127.0.0.1:4321' }).ok, true);
  assert.equal(ok({ host: 'localhost:4321' }).ok, true);
  assert.equal(ok({ host: '[::1]:4321' }).ok, true);
  assert.equal(ok({ host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' }).ok, true);
  assert.equal(ok({ host: '127.0.0.1:4321', origin: 'http://localhost:4321' }).ok, true);
  assert.equal(ok({ host: '127.0.0.1:4321', origin: 'http://evil.test' }).ok, false);
  assert.equal(ok({ host: '127.0.0.1:4321', origin: 'null' }).ok, false);
  assert.equal(ok({ host: 'quill.example.com:4321' }).ok, false);
  assert.equal(ok({ host: '127.0.0.1:9999' }).ok, false);
  assert.equal(ok({}).ok, false);
});

function sessionsFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-auth-')), 'state', 'ui-sessions.json');
}

function signIn(auth, now, fill = 'd') {
  const secret = fill.repeat(64);
  auth.acceptSecretHash(hashSecret(secret), now + 600_000);
  return auth.exchangeSecret(secret);
}

test('a session survives an auth re-create from the same state dir; only its hash is on disk (ADR 0022)', () => {
  const file = sessionsFile();
  const auth = createAuth({ clock: () => NOW, sessionsPath: file });
  const token = signIn(auth, NOW);
  const csrf = auth.csrfFor(token);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes(token), false, 'the plain token never reaches the disk');
  assert.ok(text.includes(hashSecret(token)));
  const again = createAuth({ clock: () => NOW + 60_000, sessionsPath: file });
  assert.equal(again.verifyToken(token), true, 'a restarted worker keeps the browser signed in');
  assert.equal(again.verifyCsrf(token, csrf), true, 'an open page keeps its CSRF token across a restart');
});

test('sessions expire after 7 idle days, slide on use, and expired entries are pruned', () => {
  const file = sessionsFile();
  let now = NOW;
  const auth = createAuth({ clock: () => now, sessionsPath: file });
  const token = signIn(auth, NOW);
  const stale = signIn(auth, NOW, 'e');
  now = NOW + 6 * DAY;
  assert.equal(auth.verifyToken(token), true, 'used on day 6, renewed');
  now = NOW + 12 * DAY;
  const later = createAuth({ clock: () => now, sessionsPath: file });
  assert.equal(later.verifyToken(token), true, 'the renewal was persisted');
  assert.equal(later.verifyToken(stale), false, 'unused for 12 days');
  assert.equal(fs.readFileSync(file, 'utf8').includes(hashSecret(stale)), false, 'expired entries are pruned');
  now = NOW + 20 * DAY;
  assert.equal(later.verifyToken(token), false);
});

test('revokeAll clears persisted sessions and outstanding one-use secrets', () => {
  const file = sessionsFile();
  const auth = createAuth({ clock: () => NOW, sessionsPath: file });
  const token = signIn(auth, NOW);
  const pending = 'p'.repeat(64);
  auth.acceptSecretHash(hashSecret(pending), NOW + 600_000);
  auth.revokeAll();
  assert.equal(auth.verifyToken(token), false);
  assert.equal(auth.exchangeSecret(pending), null);
  assert.equal(createAuth({ clock: () => NOW, sessionsPath: file }).verifyToken(token), false);
});
