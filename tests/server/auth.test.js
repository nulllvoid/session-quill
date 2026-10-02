import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, parseCookies, hashSecret } from '../../src/server/auth.js';

const NOW = Date.parse('2026-10-02T08:00:00Z');

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
  assert.equal(ok({ host: 'tracker.example.com:4321' }).ok, false);
  assert.equal(ok({ host: '127.0.0.1:9999' }).ok, false);
  assert.equal(ok({}).ok, false);
});
