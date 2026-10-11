import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../ui/lib/api.js';

test('getContent returns text, null for 404, and throws typed errors for 410 and other failures', async () => {
  const original = globalThis.fetch;
  const api = createApi();
  const respond = (status, body = '') => { globalThis.fetch = async () => new Response(body, { status }); };
  try {
    respond(200, 'hello');
    assert.equal(await api.getContent('h', 'g'), 'hello');
    respond(404);
    assert.equal(await api.getContent('h', 'g'), null);
    respond(410);
    await assert.rejects(api.getContent('h', 'g'), { code: 'generation-expired' });
    respond(500);
    await assert.rejects(api.getContent('h', 'g'), { code: 'http-500', status: 500, message: 'the server returned 500' });
  } finally {
    globalThis.fetch = original;
  }
});
