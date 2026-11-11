import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startHub, sanitized, ticket, NOW } from './helpers.js';
import { revokeToken, addToken, findToken, listTokens } from '../../src/hub/store.js';

const STORE = 'store-aaaa-1111';
const payload = (opts, exportOpts) => ({ schema_version: 1, store_id: STORE, machine_name: 'laptop', snapshot: sanitized(opts, exportOpts) });

test('healthz answers without a token and gives no data', async () => {
  const h = await startHub();
  try {
    const res = await fetch(`${h.base}/healthz`);
    assert.deepEqual(await res.json(), { ok: true, service: 'quill-hub', api: 1 });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally { await h.close(); }
});

test('tokens are stored only as hashes, and names are unique slugs', async () => {
  const h = await startHub();
  try {
    const file = fs.readFileSync(path.join(h.dir, 'tokens.json'), 'utf8');
    assert.equal(file.includes(h.member.token), false);
    assert.match(h.member.token, /^qh_m_/);
    assert.match(h.viewer.token, /^qh_v_/);
    assert.deepEqual(findToken(h.dir, h.member.token), { id: h.member.id, name: 'alice', role: 'member', boards: null });
    assert.equal(findToken(h.dir, `${h.member.token.slice(0, -1)}x`), null);
    assert.equal(findToken(h.dir, 'not a token'), null);
    assert.throws(() => addToken(h.dir, { name: 'alice', now: NOW }), /already exists/);
    assert.throws(() => addToken(h.dir, { name: '../etc', now: NOW }), /lowercase letters/);
    assert.throws(() => addToken(h.dir, { name: 'bob', role: 'admin', now: NOW }), /role must be/);
    assert.deepEqual(listTokens(h.dir).map((t) => Object.keys(t).sort()), [['boards', 'created_at', 'id', 'name', 'role'], ['boards', 'created_at', 'id', 'name', 'role']]);
  } finally { await h.close(); }
});

test('a member pushes a board; viewers and strangers cannot', async () => {
  const h = await startHub();
  try {
    const none = await fetch(`${h.base}/v1/snapshot`, { method: 'PUT', body: '{}' });
    assert.equal(none.status, 401);
    const bad = await h.put('qh_m_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', payload());
    assert.equal(bad.status, 401);
    const viewer = await h.put(h.viewer.token, payload());
    assert.equal(viewer.status, 403);
    assert.equal((await viewer.json()).error.code, 'hub-role');
    const ok = await h.put(h.member.token, payload());
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, member: 'alice', store_id: STORE, pushed_at: NOW, ticket_count: 2 });
    const stored = JSON.parse(fs.readFileSync(path.join(h.dir, 'boards', 'alice', STORE, 'snapshot.json'), 'utf8'));
    assert.equal(stored.capabilities.edit_tickets, false);
    assert.equal(stored.tickets.length, 2);
  } finally { await h.close(); }
});

test('a push that is not a sanitized snapshot is rejected with the reason and nothing is stored', async () => {
  const h = await startHub({ maxBody: 64 * 1024 });
  try {
    const cases = [
      ['not json', 400, 'bad-json'],
      [{ store_id: '../../etc', snapshot: sanitized() }, 400, 'bad-request'],
      [{ store_id: STORE, snapshot: { tickets: [] } }, 422, 'hub-snapshot'],
      [payload({}, { includeCheckpoints: true }), 422, 'hub-snapshot'],
      [payload({ tickets: Array.from({ length: 400 }, (_, i) => ticket(i % 9, { id: `t-${i}`, title: 'x'.repeat(300) })) }), 413, 'body-too-large'],
    ];
    for (const [body, status, code] of cases) {
      const res = await h.put(h.member.token, body);
      assert.equal(res.status, status, JSON.stringify(body).slice(0, 60));
      assert.equal((await res.json()).error.code, code);
    }
    assert.equal(fs.existsSync(path.join(h.dir, 'boards')), false);
  } finally { await h.close(); }
});

test('one member cannot write or delete another member\'s board', async () => {
  const h = await startHub();
  try {
    const bob = addToken(h.dir, { name: 'bob', role: 'member', now: NOW });
    await h.put(h.member.token, payload());
    await h.put(bob.token, payload({ tickets: [ticket(5)] }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'boards', 'alice', STORE, 'snapshot.json'), 'utf8')).tickets.length, 2, "alice's copy is untouched");
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'boards', 'bob', STORE, 'snapshot.json'), 'utf8')).tickets.length, 1);
    const del = await fetch(`${h.base}/v1/snapshot/${STORE}`, { method: 'DELETE', headers: { Authorization: `Bearer ${bob.token}` } });
    assert.equal(del.status, 200);
    assert.equal(fs.existsSync(path.join(h.dir, 'boards', 'alice', STORE, 'info.json')), true);
    assert.equal(fs.existsSync(path.join(h.dir, 'boards', 'bob', STORE)), false);
    const viewerDel = await fetch(`${h.base}/v1/snapshot/${STORE}`, { method: 'DELETE', headers: { Authorization: `Bearer ${h.viewer.token}` } });
    assert.equal(viewerDel.status, 403);
  } finally { await h.close(); }
});

test('pages need a signed-in browser; sign-in sets an HttpOnly, SameSite=Strict cookie', async () => {
  const h = await startHub();
  try {
    await h.put(h.member.token, payload());
    for (const p of ['/', `/b/alice/${STORE}/`, `/b/alice/${STORE}/frame`]) {
      const res = await fetch(`${h.base}${p}`, { redirect: 'manual' });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/login');
    }
    const wrong = await h.signIn('qh_v_wrong');
    assert.equal(wrong.res.status, 401);
    assert.match(await wrong.res.text(), /not valid on this hub/);
    const { res, cookie } = await h.signIn(h.viewer.token);
    assert.equal(res.status, 303);
    assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=604800$/);
    const overview = await fetch(`${h.base}/`, { headers: { Cookie: cookie } });
    assert.equal(overview.status, 200);
    const html = await overview.text();
    assert.match(html, /Signed in as <strong>vera<\/strong> \(viewer\)/);
    assert.match(html, /Boards \(1\)/);
    assert.match(html, /Open work \(1\)/);
    assert.match(html, /PROJ-1/);
    assert.doesNotMatch(html, /<script/i, 'the overview carries no script');
    assert.match(overview.headers.get('content-security-policy'), /default-src 'none'/);
    assert.doesNotMatch(overview.headers.get('content-security-policy'), /script-src/);
    const forged = await fetch(`${h.base}/`, { redirect: 'manual', headers: { Cookie: `${cookie.slice(0, -2)}xx` } });
    assert.equal(forged.status, 303, 'a tampered cookie is not a session');
  } finally { await h.close(); }
});

test('sessions expire after 7 days and end when their token is revoked', async () => {
  const h = await startHub();
  try {
    const { cookie } = await h.signIn(h.viewer.token);
    const get = () => fetch(`${h.base}/`, { redirect: 'manual', headers: { Cookie: cookie } });
    assert.equal((await get()).status, 200);
    h.advance(7 * 86_400_000 + 1000);
    assert.equal((await get()).status, 303);
    const again = await h.signIn(h.viewer.token);
    assert.equal((await fetch(`${h.base}/`, { headers: { Cookie: again.cookie } })).status, 200);
    revokeToken(h.dir, 'vera');
    assert.equal((await fetch(`${h.base}/`, { redirect: 'manual', headers: { Cookie: again.cookie } })).status, 303);
    assert.equal((await fetch(`${h.base}/v1/team`, { headers: { Authorization: `Bearer ${h.viewer.token}` } })).status, 401);
  } finally { await h.close(); }
});

test('cross-site form posts are refused; a browser on the hub\'s own page signs in', async () => {
  const h = await startHub({ secureCookies: true });
  try {
    const post = (headers) => fetch(`${h.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ token: h.viewer.token }) });
    assert.equal((await post({ Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site', Origin: h.base })).status, 403);
    // Chrome sends `Origin: null` with a no-referrer policy; Sec-Fetch-Site still says same-origin.
    const own = await post({ 'Sec-Fetch-Site': 'same-origin', Origin: 'null' });
    assert.equal(own.status, 303);
    assert.match(own.headers.get('set-cookie'), /; Secure$/, '--secure-cookies marks the cookie Secure');
    assert.equal((await fetch(`${h.base}/logout`, { method: 'POST', redirect: 'manual', headers: { Origin: 'https://evil.example' } })).status, 403);
    const out = await fetch(`${h.base}/logout`, { method: 'POST', redirect: 'manual', headers: { Origin: h.base } });
    assert.match(out.headers.get('set-cookie'), /quill_hub=; .*Max-Age=0/);
  } finally { await h.close(); }
});

test('ten failed attempts from one address lock it out for five minutes', async () => {
  const h = await startHub();
  try {
    for (let i = 0; i < 10; i += 1) assert.equal((await h.signIn('qh_v_wrong')).res.status, 401);
    const locked = await h.signIn(h.viewer.token);
    assert.equal(locked.res.status, 429);
    assert.equal(locked.res.headers.get('retry-after'), '300');
    assert.equal((await h.put(h.member.token, payload())).status, 429);
    h.advance(5 * 60_000 + 1000);
    assert.equal((await h.signIn(h.viewer.token)).res.status, 303);
  } finally { await h.close(); }
});

test('a board is rendered by the hub from JSON, under a policy that names its two scripts by hash', async () => {
  const h = await startHub();
  try {
    const evil = ticket(1, { title: '</script><script>alert(1)</script><img src=x onerror=alert(2)>', next_action: '"><script>alert(3)</script>' });
    await h.put(h.member.token, payload({ tickets: [evil] }));
    const { cookie } = await h.signIn(h.viewer.token);
    const res = await fetch(`${h.base}/b/alice/${STORE}/frame`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(scripts.length, 2, 'the snapshot and the dashboard bundle, nothing else');
    for (const s of scripts) assert.ok(csp.includes(`'sha256-${createHash('sha256').update(s).digest('base64')}'`));
    assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
    assert.match(html, /data-static="true"/);
    assert.doesNotMatch(html, /src="\/ui\//);
    const overview = await (await fetch(`${h.base}/`, { headers: { Cookie: cookie } })).text();
    assert.doesNotMatch(overview, /<script|<img/i, 'ticket text is escaped on the overview');
    assert.match(overview, /&lt;\/script&gt;/);
    assert.equal((await fetch(`${h.base}/b/alice/unknown-store/`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await fetch(`${h.base}/b/..%2F..%2Fetc/passwd/`, { headers: { Cookie: cookie } })).status, 404);
  } finally { await h.close(); }
});

test('the team view adds up every board: counts, open work and deployments owed', async () => {
  const h = await startHub();
  try {
    const bob = addToken(h.dir, { name: 'bob', role: 'member', now: NOW });
    await h.put(h.member.token, payload({
      tickets: [ticket(1, { status: 'deploy-pending', last_activity: '2026-11-09T10:00:00Z' }), ticket(2, { status: 'done' })],
      extra: { deployments_outstanding: [{ ticket_id: ticket(1).id, ticket_key: 'PROJ-1', environment: 'prod', merged_at: '2026-11-01T00:00:00Z', pr_url: 'https://example.com/pr/1' }] },
    }));
    h.advance(25 * 3_600_000);
    await h.put(bob.token, { schema_version: 1, store_id: 'bob-store', machine_name: 'desk', snapshot: sanitized({ tickets: [ticket(3, { status: 'blocked', blocker: 'waiting on review', stale: true })] }) });
    const res = await fetch(`${h.base}/v1/team`, { headers: { Authorization: `Bearer ${h.viewer.token}` } });
    const team = await res.json();
    assert.equal(team.hub, 'Test team');
    assert.deepEqual(team.boards.map((b) => [b.member, b.ticket_count, b.quiet, b.stale_ticket_count]), [['alice', 2, true, 0], ['bob', 1, false, 1]]);
    assert.deepEqual(team.totals, { todo: 0, active: 0, blocked: 1, review: 0, 'deploy-pending': 1, done: 1 });
    assert.deepEqual(team.open.map((t) => [t.member, t.key, t.status]), [['bob', 'PROJ-3', 'blocked'], ['alice', 'PROJ-1', 'deploy-pending']]);
    assert.deepEqual(team.deployments.map((d) => [d.member, d.ticket_key, d.environment]), [['alice', 'PROJ-1', 'prod']]);
    assert.equal(JSON.stringify(team).includes('example.com/pr/1'), false, 'links travel only with include_links');
    const { cookie } = await h.signIn(h.viewer.token);
    const html = await (await fetch(`${h.base}/`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /No push for over a day/);
    assert.match(html, /Deployments owed \(1\)/);
    assert.match(html, /<strong>Blocked:<\/strong> waiting on review/);
  } finally { await h.close(); }
});

test('an empty hub says what to do next, and unknown routes and methods are refused', async () => {
  const h = await startHub();
  try {
    const { cookie } = await h.signIn(h.viewer.token);
    const html = await (await fetch(`${h.base}/`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /No boards pushed yet/);
    assert.match(html, /quill hub join/);
    assert.equal((await fetch(`${h.base}/nope`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await fetch(`${h.base}/`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 405);
    assert.equal((await fetch(`${h.base}/ui/fonts/..%2F..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${h.base}/ui/fonts/Geist-Variable.woff2`)).status, 200);
    const css = await fetch(`${h.base}/assets/hub.css`);
    assert.match(await css.text(), /\/ui\/fonts\/Geist-Variable\.woff2/);
  } finally { await h.close(); }
});

test('a token holds at most ten boards; pushing to one it already has still works', async () => {
  const h = await startHub();
  try {
    for (let i = 0; i < 10; i += 1) assert.equal((await h.put(h.member.token, { ...payload(), store_id: `store-${i}` })).status, 200);
    const eleventh = await h.put(h.member.token, { ...payload(), store_id: 'store-10' });
    assert.equal(eleventh.status, 409);
    assert.equal((await eleventh.json()).error.code, 'hub-board-limit');
    assert.equal((await h.put(h.member.token, { ...payload(), store_id: 'store-3' })).status, 200);
  } finally { await h.close(); }
});

test('the overview follows pushes and removals without a restart', async () => {
  const h = await startHub();
  try {
    const team = async () => (await fetch(`${h.base}/v1/team`, { headers: { Authorization: `Bearer ${h.viewer.token}` } })).json();
    await h.put(h.member.token, payload());
    assert.equal((await team()).open_count, 1);
    h.advance(1000);
    await h.put(h.member.token, { ...payload({ tickets: [ticket(1), ticket(3), ticket(4)] }) });
    assert.equal((await team()).open_count, 3, 'a newer push replaces the cached board');
    await fetch(`${h.base}/v1/snapshot/${STORE}`, { method: 'DELETE', headers: { Authorization: `Bearer ${h.member.token}` } });
    assert.deepEqual((await team()).boards, []);
  } finally { await h.close(); }
});
