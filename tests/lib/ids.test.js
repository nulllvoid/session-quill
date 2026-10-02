import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuid, shortId, contentHash, isUuid } from '../../src/lib/ids.js';

test('uuid is v4 and shortId is 8 hex', () => {
  assert.equal(isUuid(uuid()), true);
  assert.match(shortId(), /^[0-9a-f]{8}$/);
  assert.notEqual(shortId(), shortId());
});

test('contentHash is sha256 hex and stable', () => {
  assert.equal(contentHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
