import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHub, sanitized, ticket, NOW } from './helpers.js';
import { addToken, listEdits } from '../../src/hub/store.js';
import { hubSettings, requestFromHubEdit, collectEdits, pushSnapshot } from '../../src/hub/client.js';
import { createHub } from '../../src/hub/server.js';
import { makeHome, startWorker, cli, DESC } from '../cli/helpers.js';
import { latestSnapshot, loadContext } from '../../src/cli/context.js';
import { toIso } from '../../src/lib/time.js';
import { applyDueRequests } from '../../src/server/requests.js';
import { writeIngress } from '../../src/core/ingress.js';
import { makeEvent } from '../../src/core/events.js';

const STORE = 'store-aaaa-1111';
const T1 = ticket(1).id;
const board = (extra = {}) => ({ schema_version: 1, store_id: STORE, machine_name: 'laptop', accepts_edits: true, snapshot: sanitized({ tickets: [ticket(1, { revision: 4 }), ticket(2, { status: 'done' })] }), ...extra });
const post = (h, cookie, url, fields, headers = {}) => fetch(`${h.base}${url}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: h.base, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) });
const page = async (h, cookie, url) => { const r = await fetch(`${h.base}${url}`, { headers: { Cookie: cookie } }); return { status: r.status, html: await r.text() }; };

test('a member proposes one change; it queues with the copy\'s revision and the member\'s name, and blocks a second', async () => {
  const h = await startHub();
  try {
    const bob = addToken(h.dir, { name: 'bob', role: 'member', now: NOW });
    await h.put(h.member.token, board());
    const { cookie } = await h.signIn(bob.token);
    const url = `/b/alice/${STORE}/t/${T1}`;
    const before = await page(h, cookie, url);
    assert.equal(before.status, 200);
    assert.match(before.html, /Propose a change/);
    assert.match(before.html, /Send status to alice's machine/);
    assert.match(before.html, /Send next action to alice's machine/);
    assert.match(before.html, /Now: Active\. Choose a new status/);
    assert.match(before.html, /Changes proposed on this hub \(0\)/);
    const res = await post(h, cookie, url, { field: 'status', value: 'review' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `${url}?sent=1`);
    assert.deepEqual(listEdits(h.dir, 'alice', STORE).map((e) => [e.field, e.value, e.expected_revision, e.by, e.delivered_at]), [['status', 'review', 4, 'bob', null]]);
    const after = await page(h, cookie, `${url}?sent=1`);
    assert.match(after.html, /Your change is queued for alice's machine\. Queued is not applied/);
    assert.match(after.html, /Waiting for alice&#39;s machine to collect it/);
    assert.match(after.html, /Changes proposed on this hub \(1\)/);
    assert.match(after.html, /still on its way to alice&#39;s machine/);
    assert.doesNotMatch(after.html, /<form class="hub-form"/, 'no form while a change is on its way');
    const second = await post(h, cookie, url, { field: 'next_action', value: 'Ask Dana to review' });
    assert.equal(second.status, 403);
    assert.equal(listEdits(h.dir, 'alice', STORE).length, 1);
    // A newer copy of the ticket from its owner opens the form again.
    await h.put(h.member.token, board({ snapshot: sanitized({ tickets: [ticket(1, { revision: 5, status: 'review' })] }) }));
    assert.match((await page(h, cookie, url)).html, /<form class="hub-form"/);
    assert.equal((await post(h, cookie, url, { field: 'next_action', value: 'Ask Dana to review' })).status, 303);
    assert.deepEqual(listEdits(h.dir, 'alice', STORE).map((e) => [e.field, e.expected_revision]), [['status', 4], ['next_action', 5]]);
  } finally { await h.close(); }
});

test('who cannot propose: viewers, boards that did not opt in, done tickets, other sites', async () => {
  const h = await startHub();
  try {
    const bob = addToken(h.dir, { name: 'bob', role: 'member', now: NOW });
    await h.put(h.member.token, board());
    const url = `/b/alice/${STORE}/t/${T1}`;
    const viewer = await h.signIn(h.viewer.token);
    assert.match((await page(h, viewer.cookie, url)).html, /A viewer token cannot propose changes/);
    assert.equal((await post(h, viewer.cookie, url, { field: 'status', value: 'review' })).status, 403);
    const member = await h.signIn(bob.token);
    assert.equal((await post(h, member.cookie, url, { field: 'status', value: 'review' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(h, member.cookie, `/b/alice/${STORE}/t/${ticket(2).id}`, { field: 'status', value: 'todo' })).status, 403, 'a done ticket takes no proposals');
    assert.equal((await fetch(`${h.base}${url}`, { method: 'POST', redirect: 'manual', body: 'field=status&value=review' })).status, 401, 'no session');
    assert.equal((await post(h, member.cookie, url, { field: 'status', value: 'blocked' })).status, 400, 'not an offered status');
    assert.equal((await post(h, member.cookie, url, { field: 'status', value: 'active' })).status, 400, 'already that status');
    assert.equal((await post(h, member.cookie, url, { field: 'priority', value: 'P0' })).status, 400, 'not an editable field');
    assert.equal((await post(h, member.cookie, url, { field: 'next_action', value: 'x'.repeat(2001) })).status, 400);
    const same = await post(h, member.cookie, url, { field: 'next_action', value: 'Do step 1' });
    assert.equal(same.status, 400);
    assert.match(await same.text(), /Nothing to send/);
    assert.equal((await page(h, member.cookie, `/b/alice/${STORE}/t/unknown-ticket`)).status, 404);
    await h.put(h.member.token, board({ accepts_edits: false }));
    assert.match((await page(h, member.cookie, url)).html, /does not accept changes from the hub/);
    assert.equal((await post(h, member.cookie, url, { field: 'status', value: 'review' })).status, 403);
    assert.deepEqual(listEdits(h.dir, 'alice', STORE), [], 'nothing was queued by any refused attempt');
  } finally { await h.close(); }
});

test('only the board\'s own token collects its edits, each once; the page then says what the next push shows', async () => {
  const h = await startHub();
  try {
    const bob = addToken(h.dir, { name: 'bob', role: 'member', now: NOW });
    await h.put(h.member.token, board());
    const { cookie } = await h.signIn(bob.token);
    const url = `/b/alice/${STORE}/t/${T1}`;
    await post(h, cookie, url, { field: 'status', value: 'review' });
    const get = (token) => fetch(`${h.base}/v1/edits?store_id=${STORE}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.deepEqual((await (await get(bob.token)).json()).edits, [], "bob's token sees nothing of alice's board");
    assert.equal((await get(h.viewer.token)).status, 403);
    const mine = (await (await get(h.member.token)).json()).edits;
    assert.deepEqual(mine.map((e) => [e.ticket_id, e.field, e.value, e.expected_revision, e.by]), [[T1, 'status', 'review', 4, 'bob']]);
    const ack = (token, ids) => fetch(`${h.base}/v1/edits/ack`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ store_id: STORE, ids }) });
    assert.equal((await (await ack(bob.token, [mine[0].id])).json()).collected, 0, 'bob cannot mark it collected');
    assert.equal((await (await ack(h.member.token, [mine[0].id])).json()).collected, 1);
    assert.deepEqual((await (await get(h.member.token)).json()).edits, []);
    assert.match((await page(h, cookie, url)).html, /Collected just now; not visible in a push yet/);
    h.advance(120_000);
    await h.put(h.member.token, board({ snapshot: sanitized({ tickets: [ticket(1, { revision: 5, status: 'review' })] }) }));
    assert.match((await page(h, cookie, url)).html, /Collected 2 min ago; the board now shows this value/);
    await h.put(h.member.token, board({ snapshot: sanitized({ tickets: [ticket(1, { revision: 6, status: 'blocked' })] }) }));
    assert.match((await page(h, cookie, url)).html, /the ticket has changed since and does not show this value/);
  } finally { await h.close(); }
});

test('a token limited to some boards sees only those, everywhere', async () => {
  const h = await startHub();
  try {
    const bob = addToken(h.dir, { name: 'bob', role: 'member', now: NOW });
    const limited = addToken(h.dir, { name: 'client', role: 'viewer', boards: ['bob'], now: NOW });
    const solo = addToken(h.dir, { name: 'carol', role: 'member', boards: ['carol'], now: NOW });
    assert.throws(() => addToken(h.dir, { name: 'x', boards: ['../etc'], now: NOW }), /member names/);
    await h.put(h.member.token, board());
    await h.put(bob.token, { ...board(), store_id: 'bob-store', snapshot: sanitized({ tickets: [ticket(7)] }) });
    await h.put(solo.token, { ...board(), store_id: 'carol-store', snapshot: sanitized({ tickets: [ticket(8)] }) });
    const team = async (token) => (await (await fetch(`${h.base}/v1/team`, { headers: { Authorization: `Bearer ${token}` } })).json());
    assert.deepEqual((await team(limited.token)).boards.map((b) => b.member), ['bob']);
    assert.deepEqual((await team(limited.token)).open.map((t) => t.key), ['PROJ-7']);
    assert.deepEqual((await team(solo.token)).boards.map((b) => b.member), ['carol'], 'a member always reads its own board');
    assert.deepEqual((await team(h.viewer.token)).boards.map((b) => b.member), ['alice', 'bob', 'carol']);
    const { cookie } = await h.signIn(limited.token);
    const overview = await page(h, cookie, '/');
    assert.match(overview.html, /Signed in as <strong>client<\/strong> \(viewer, 1 board\)/);
    assert.doesNotMatch(overview.html, /PROJ-1\b|alice/);
    assert.equal((await page(h, cookie, `/b/alice/${STORE}/`)).status, 404);
    assert.equal((await page(h, cookie, `/b/alice/${STORE}/frame`)).status, 404);
    assert.equal((await page(h, cookie, `/b/alice/${STORE}/t/${T1}`)).status, 404);
    assert.equal((await page(h, cookie, '/b/bob/bob-store/')).status, 200);
  } finally { await h.close(); }
});

test('a board opens under the hub\'s own bar, with the dashboard in a same-origin frame', async () => {
  const h = await startHub({ name: 'Pay <team>' });
  try {
    await h.put(h.member.token, board());
    const { cookie } = await h.signIn(h.viewer.token);
    const res = await fetch(`${h.base}/b/alice/${STORE}/`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.match(html, /<a href="\/">Pay &lt;team&gt;<\/a> \/ alice/);
    assert.match(html, /Read-only copy, pushed <time datetime="2026-11-10T12:00:00Z"/);
    assert.match(html, new RegExp(`<iframe class="hub-frame" src="/b/alice/${STORE}/frame" title="alice's board, read-only"></iframe>`));
    assert.doesNotMatch(html, /<script/i);
    assert.match(res.headers.get('content-security-policy'), /frame-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', 'the hub page itself cannot be framed');
    assert.equal((await fetch(`${h.base}/b/alice/${STORE}`, { redirect: 'manual', headers: { Cookie: cookie } })).status, 303);
  } finally { await h.close(); }
});

test('the worker turns only well-formed hub edits into requests, under the proposer\'s name', () => {
  const ok = { id: 'a1b2c3d4e5f60718', ticket_id: T1, field: 'status', value: 'review', expected_revision: 4, by: 'bob', at: NOW };
  const req = requestFromHubEdit(ok, { url: 'https://h.example', now: NOW });
  assert.equal(req.kind, 'set-status');
  assert.deepEqual(req.payload, { status: 'review' });
  assert.equal(req.actor_id, 'hub:bob');
  assert.equal(req.expected_revision, 4);
  assert.equal(req.not_before, '2026-11-10T12:00:10Z', 'the same 10-second undo window as a page edit');
  assert.equal(requestFromHubEdit(ok, { url: 'https://h.example', now: NOW }).id, req.id, 'collected twice, it is one request');
  assert.notEqual(requestFromHubEdit(ok, { url: 'https://other.example', now: NOW }).id, req.id);
  assert.equal(requestFromHubEdit({ ...ok, field: 'next_action', value: 'Ship it' }, { url: 'u', now: NOW }).kind, 'set-next-action');
  for (const bad of [
    { ...ok, field: 'priority', value: 'P0' }, { ...ok, value: 'blocked' }, { ...ok, value: 7 }, { ...ok, expected_revision: '4' }, { ...ok, expected_revision: -1 },
    { ...ok, by: 'owner' + ' x' }, { ...ok, by: 'Owner' }, { ...ok, id: '../x' }, { ...ok, ticket_id: '' }, { ...ok, field: 'next_action', value: 'x'.repeat(2001) }, null, 'x',
  ]) assert.equal(requestFromHubEdit(bad, { url: 'u', now: NOW }), null);
});

test('end to end: a proposal made on the hub changes the owner\'s ticket, and a stale one is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-hub-edit-'));
  const hub = createHub({ dir, name: 'E2E' });
  const address = await hub.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const alice = addToken(dir, { name: 'alice', role: 'member', now: NOW });
    const bob = addToken(dir, { name: 'bob', role: 'member', now: NOW });
    const env = { ...fx.env, QUILL_HUB_TOKEN: alice.token };
    await cli(['ticket', 'create', '--description', DESC, 'Shared work', '--session', 'sess-E'], env);
    w.worker.publishGeneration();
    const ctx = loadContext(env, { requireStore: true });
    const settings = hubSettings({ hub: { url: base, enabled: true, confirmed_url: base, accept_edits: true } }, env);
    const snap = latestSnapshot(ctx);
    const t = snap.tickets[0];
    await pushSnapshot(snap, settings, { now: toIso(Date.now()), storeId: fx.meta.store_id, env });

    const signIn = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: new URLSearchParams({ token: bob.token }) });
    const cookie = signIn.headers.get('set-cookie').split(';')[0];
    const url = `${base}/b/alice/${fx.meta.store_id}/t/${t.id}`;
    const propose = (fields) => fetch(url, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    assert.equal((await propose({ field: 'status', value: 'review' })).status, 303);

    // Journal the request as if collected 20 s ago, so the undo window has already passed.
    const past = toIso(Date.now() - 20_000);
    const logs = [];
    const collect = () => collectEdits(settings, { now: past, storeId: fx.meta.store_id, machineId: ctx.machineId, env, log: (m) => logs.push(m) });
    assert.deepEqual(await collect(), { collected: 1, refused: 0 });
    assert.match(logs.join('\n'), /hub:bob proposed set-status/);
    assert.deepEqual(await collect(), { collected: 0, refused: 0 }, 'nothing is collected twice');

    // The dashboard server applies due requests in a running worker; here the test does.
    const settle = async (id) => {
      for (let i = 0; i < 100; i += 1) {
        applyDueRequests(w.worker, toIso(Date.now()));
        const r = w.worker.state.requests.get(id);
        if (r && r.state !== 'pending' && r.state !== 'applying') return r;
        await new Promise((res) => setTimeout(res, 30));
      }
      return null;
    };
    const first = [...w.worker.state.requests.values()].find((r) => r.actor_id === 'hub:bob') ?? await (async () => { await new Promise((res) => setTimeout(res, 300)); return [...w.worker.state.requests.values()].find((r) => r.actor_id === 'hub:bob'); })();
    const done = await settle(first.id);
    assert.equal(done.state, 'applied');
    assert.equal(done.actor_id, 'hub:bob', "the owner's own request record names the proposer");
    assert.equal(w.worker.state.tickets.get(t.id).status, 'review');

    // The hub still holds the old copy. Its open edit blocks a second proposal there...
    assert.equal((await propose({ field: 'next_action', value: 'based on the old copy' })).status, 403);
    // ...and a request that reaches the worker with the old revision anyway is refused, not applied.
    const stale = requestFromHubEdit({ id: 'feedfacefeedface', ticket_id: t.id, field: 'next_action', value: 'based on the old copy', expected_revision: t.revision, by: 'bob', at: past }, { url: base, now: past });
    writeIngress(makeEvent({ kind: 'request', payload: stale, store_id: fx.meta.store_id, machine_id: ctx.machineId, producer: 'cli', session_id: null, agent_id: null, ticket_id: t.id, source_identity: `request:${stale.id}`, occurred_at: past }), env);
    for (let i = 0; i < 100 && !w.worker.state.requests.get(stale.id); i += 1) await new Promise((res) => setTimeout(res, 30));
    const refused = await settle(stale.id);
    assert.equal(refused.state, 'conflict');
    assert.match(refused.error.message, /expected/);
    assert.notEqual(w.worker.state.tickets.get(t.id).next_action, 'based on the old copy', 'a proposal based on an older revision does not overwrite newer work');
  } finally {
    await w.stop();
    await hub.close();
  }
});
