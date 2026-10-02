import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBitbucketProvider, mapCloudPr, mapServerPr } from '../../src/reconcile/providers/bitbucket.js';
import { defaultProviders } from '../../src/reconcile/providers/index.js';

function recordingFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }; };
  return { calls, fetchImpl };
}

test('Cloud and Server PR JSON map to contract states and times', () => {
  assert.deepEqual(mapCloudPr({ state: 'OPEN', draft: true, created_on: '2026-09-30T08:00:00.716224+00:00', source: { branch: { name: 'feat/x' } }, destination: { branch: { name: 'main' } } }), { state: 'draft', opened_at: '2026-09-30T08:00:00Z', merged_at: null, base_branch: 'main', head_branch: 'feat/x' });
  assert.equal(mapCloudPr({ state: 'MERGED', updated_on: '2026-10-01T09:00:00+00:00' }).merged_at, '2026-10-01T09:00:00Z');
  assert.equal(mapCloudPr({ state: 'DECLINED' }).state, 'closed');
  assert.equal(mapCloudPr({ state: 'SUPERSEDED' }).state, 'closed');
  assert.deepEqual(mapServerPr({ state: 'MERGED', createdDate: Date.parse('2026-09-30T08:00:00Z'), closedDate: Date.parse('2026-10-01T10:30:00Z'), fromRef: { displayId: 'feat/y' }, toRef: { displayId: 'release' } }), { state: 'merged', opened_at: '2026-09-30T08:00:00Z', merged_at: '2026-10-01T10:30:00Z', base_branch: 'release', head_branch: 'feat/y' });
  assert.equal(mapServerPr({ state: 'OPEN' }).state, 'open');
});

test('Cloud polling calls the API with a bearer token, or basic auth with a username', async () => {
  const r = recordingFetch({ state: 'OPEN' });
  const p = createBitbucketProvider({ env: { BITBUCKET_TOKEN: 't0k' }, fetchImpl: r.fetchImpl });
  assert.equal((await p.fetchPr('https://bitbucket.org/acme/app/pull-requests/7')).state, 'open');
  assert.equal(r.calls[0].url, 'https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests/7');
  assert.equal(r.calls[0].init.headers.authorization, 'Bearer t0k');
  assert.equal(r.calls[0].init.redirect, 'error');
  const b = recordingFetch({ state: 'OPEN' });
  await createBitbucketProvider({ env: { BITBUCKET_TOKEN: 'pw', BB_USER: 'me' }, usernameEnv: 'BB_USER', fetchImpl: b.fetchImpl }).fetchPr('https://bitbucket.org/acme/app/pull-requests/7/overview');
  assert.equal(b.calls[0].init.headers.authorization, `Basic ${Buffer.from('me:pw').toString('base64')}`);
});

test('the token is sent only to the configured host: lookalikes, http and foreign servers are refused without a request', async () => {
  const r = recordingFetch({ state: 'OPEN' });
  const cloud = createBitbucketProvider({ env: { BITBUCKET_TOKEN: 'secret' }, fetchImpl: r.fetchImpl });
  for (const url of ['https://bitbucket.org.evil.example/acme/app/pull-requests/7', 'http://bitbucket.org/acme/app/pull-requests/7', 'https://evil.example/projects/PM/repos/app/pull-requests/1']) {
    await assert.rejects(cloud.fetchPr(url), (e) => e.code === 'provider-error' && !e.message.includes('secret'), url);
  }
  const server = createBitbucketProvider({ baseUrl: 'https://bitbucket.example.com', env: { BITBUCKET_TOKEN: 'secret' }, fetchImpl: r.fetchImpl });
  await assert.rejects(server.fetchPr('https://other.example.com/projects/PM/repos/app/pull-requests/1'), /configured for https:\/\/bitbucket\.example\.com/);
  await assert.rejects(server.fetchPr('https://bitbucket.org/acme/app/pull-requests/7'), /configured for https:\/\/bitbucket\.example\.com/);
  assert.equal(r.calls.length, 0);
  await assert.rejects(createBitbucketProvider({ baseUrl: 'http://bitbucket.example.com', env: {}, fetchImpl: r.fetchImpl }).fetchPr('http://bitbucket.example.com/projects/PM/repos/app/pull-requests/1'), /https/);
});

test('a missing token, an HTTP error or a timeout is a provider error that names the variable and never the token', async () => {
  const r = recordingFetch({});
  await assert.rejects(createBitbucketProvider({ env: {}, fetchImpl: r.fetchImpl }).fetchPr('https://bitbucket.org/acme/app/pull-requests/7'), /set BITBUCKET_TOKEN/);
  assert.equal(r.calls.length, 0);
  const denied = recordingFetch({}, { status: 401 });
  await assert.rejects(createBitbucketProvider({ env: { BB: 'hunter2' }, tokenEnv: 'BB', fetchImpl: denied.fetchImpl }).fetchPr('https://bitbucket.org/acme/app/pull-requests/7'), (e) => /HTTP 401 \(check BB\)/.test(e.message) && !e.message.includes('hunter2'));
  const slow = async (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
  await assert.rejects(createBitbucketProvider({ env: { BITBUCKET_TOKEN: 't' }, fetchImpl: slow, timeoutMs: 20 }).fetchPr('https://bitbucket.org/acme/app/pull-requests/7'), /timed out/);
});

test('Server/Data Center polling works against a loopback server, and defaultProviders picks Bitbucket for a repository', async () => {
  let seen = null;
  const srv = http.createServer((req, res) => { seen = { url: req.url, auth: req.headers.authorization }; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ state: 'MERGED', createdDate: 1, closedDate: Date.parse('2026-10-01T10:30:00Z'), fromRef: { displayId: 'f' }, toRef: { displayId: 'main' } })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const providers = defaultProviders({}, { BB_SERVER: 'srv-token' });
    const p = providers.for({ id: 'app', provider: 'bitbucket', provider_url: base, token_env: 'BB_SERVER' });
    assert.equal(p.name, 'bitbucket');
    const pr = await p.fetchPr(`${base}/projects/PM/repos/app/pull-requests/12`);
    assert.deepEqual([pr.state, pr.merged_at], ['merged', '2026-10-01T10:30:00Z']);
    assert.deepEqual(seen, { url: '/rest/api/1.0/projects/PM/repos/app/pull-requests/12', auth: 'Bearer srv-token' });
  } finally { srv.close(); }
});
