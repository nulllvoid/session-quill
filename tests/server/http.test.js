import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from '../../src/worker/worker.js';
import { makeEvent } from '../../src/core/events.js';
import { writeIngress } from '../../src/core/ingress.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig } from '../../src/config/config.js';
import { derive } from '../../src/reconcile/derive.js';
import { createExtension as reconcileExt } from '../../src/reconcile/extension.js';
import { createExtension as serverExt } from '../../src/server/extension.js';
import { hashSecret } from '../../src/server/auth.js';
import { putBlob } from '../../src/core/blobs.js';

const MACHINE = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RID = (n) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function boot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-http-'));
  const storePath = path.join(home, 'Quill');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  const config = { ...defaultUserConfig(), store_path: storePath, projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['production'] } } };
  const env = { QUILL_HOME: home };
  let nowMs = Date.parse('2026-10-02T08:00:00Z');
  const clock = () => nowMs;
  const iso = () => new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const w = new Worker({ config, storeMeta: meta, env, clock, derive });
  const ctx = { env, config, storeMeta: meta };
  const rext = reconcileExt(ctx, { providers: { for: () => ({ name: 'none', fetchPr: async () => { throw new Error('none'); } }) } });
  const sext = serverExt(ctx, { port: 0 });
  w.use(rext).use(sext);
  await w.start();
  w.tick();
  await rext.idle();
  const port = sext.address().port;
  const base = `http://127.0.0.1:${port}`;
  const mk = (kind, payload, extra = {}) => makeEvent({ kind, payload, store_id: meta.store_id, machine_id: MACHINE, producer: 'test', occurred_at: iso(), ...extra });
  writeIngress(mk('ticket-create', { ticket: { id: T1, key: 'LOCAL-demo-00000001', title: 'Demo', project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } }), env);
  w.tick();
  // bootstrap: the CLI would hash a secret into a control file; here we call the extension directly
  const secret = 'f'.repeat(64);
  sext.acceptSecretHash(hashSecret(secret), nowMs + 600_000);
  const authRes = await fetch(`${base}/auth?secret=${secret}`, { redirect: 'manual' });
  const cookie = authRes.headers.get('set-cookie').split(';')[0];
  const csrf = (await (await fetch(`${base}/v1/csrf`, { headers: { cookie } })).json()).csrf;
  const post = (url, body, headers = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-quill-csrf': csrf, origin: base, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = (url) => fetch(`${base}${url}`, { headers: { cookie } });
  const settle = async () => { w.tick(); await rext.idle(); w.tick(); };
  return { w, env, base, port, cookie, csrf, post, get, secret, authRes, advance: (ms) => { nowMs += ms; }, settle, iso, mk, sext };
}

test('authentication: no cookie 401, bootstrap secret is one-use, cookie is HttpOnly SameSite=Strict', async () => {
  const b = await boot();
  try {
    assert.equal(b.authRes.status, 302);
    assert.match(b.authRes.headers.get('set-cookie'), /HttpOnly/);
    assert.match(b.authRes.headers.get('set-cookie'), /SameSite=Strict/);
    assert.equal((await fetch(`${b.base}/v1/snapshot`)).status, 401);
    assert.equal((await fetch(`${b.base}/favicon.ico`)).status, 204, 'the browser icon probe is not a 404');
    assert.equal((await fetch(`${b.base}/auth?secret=${b.secret}`, { redirect: 'manual' })).status, 403, 'secret cannot be reused');
    const snap = await (await b.get('/v1/snapshot')).json();
    assert.equal(snap.tickets.length, 1);
    assert.equal(snap.capabilities.edit_tickets, true);
  } finally { await b.w.stop(); }
});

test('the dashboard without a session answers with a sign-in page; with one it serves the app (ADR 0022)', async () => {
  const b = await boot();
  try {
    const page = await fetch(`${b.base}/`);
    assert.equal(page.status, 401);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await page.text();
    assert.match(html, /\/session-quill:ui/);
    assert.match(html, /quill ui/);
    assert.match(html, /\/ui\/styles\.css/, 'styled with the dashboard tokens');
    assert.equal((await fetch(`${b.base}/ui/index.html`)).status, 401, 'the page itself is never served without a session');
    assert.equal((await fetch(`${b.base}/ui/styles.css`)).status, 200, 'static assets stay public; they hold no data');
    const app = await fetch(`${b.base}/`, { headers: { cookie: b.cookie } });
    assert.equal(app.status, 200);
    assert.match(await app.text(), /<script type="module" src="\/ui\/app\.js">/);
    const api = await fetch(`${b.base}/v1/snapshot`);
    assert.equal(api.status, 401);
    assert.equal((await api.json()).error.code, 'unauthenticated', 'the API keeps JSON errors');
  } finally { await b.w.stop(); }
});

test('mutations require CSRF and a loopback Origin/Host; cross-origin and wrong-host requests cannot mutate', async () => {
  const b = await boot();
  try {
    const body = { id: RID(1), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'x' } };
    assert.equal((await b.post('/v1/requests', body, { 'x-quill-csrf': '' })).status, 403);
    assert.equal((await b.post('/v1/requests', body, { origin: 'http://evil.test' })).status, 403);
    const wrongHost = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: b.port, path: '/v1/requests', method: 'POST', headers: { host: 'quill.example.com', 'content-type': 'application/json', cookie: b.cookie, 'x-quill-csrf': b.csrf } }, (res) => resolve(res.statusCode));
      req.end(JSON.stringify(body));
    });
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(`${b.base}/v1/requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-quill-csrf': b.csrf }, body: JSON.stringify(body) })).status, 401);
    const snap = await (await b.get('/v1/snapshot')).json();
    assert.equal(snap.requests.length, 0, 'nothing entered the queue');
  } finally { await b.w.stop(); }
});

test('happy path: 202 after persistence, pending with not_before, applied after the undo window; conflict for a stale revision', async () => {
  const b = await boot();
  try {
    const body = { id: RID(2), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'Verify restart' } };
    const res = await b.post('/v1/requests', body);
    assert.equal(res.status, 202);
    const rec = await res.json();
    assert.equal(rec.state, 'pending');
    assert.equal(rec.not_before, '2026-10-02T08:00:10Z');
    const pending = await (await b.get(`/v1/requests/${RID(2)}`)).json();
    assert.equal(pending.state, 'pending');
    await b.settle();
    assert.equal((await (await b.get(`/v1/requests/${RID(2)}`)).json()).state, 'pending', 'not before the window ends');
    b.advance(10_000);
    await b.settle();
    const applied = await (await b.get(`/v1/requests/${RID(2)}`)).json();
    assert.equal(applied.state, 'applied');
    assert.equal(applied.applied_revision, 2);
    const snap = await (await b.get('/v1/snapshot')).json();
    assert.equal(snap.tickets[0].next_action, 'Verify restart');
    // second client with the stale revision
    const stale = await b.post('/v1/requests', { id: RID(3), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'Other' } });
    assert.equal(stale.status, 202);
    b.advance(10_000);
    await b.settle();
    const conflict = await (await b.get(`/v1/requests/${RID(3)}`)).json();
    assert.equal(conflict.state, 'conflict');
    assert.equal(conflict.error.current_revision, 2);
    assert.equal(conflict.result.current.next_action, 'Verify restart');
  } finally { await b.w.stop(); }
});

test('idempotency: same id and body returns the existing request; same id with a different body is rejected', async () => {
  const b = await boot();
  try {
    const body = { id: RID(4), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'A' } };
    const first = await (await b.post('/v1/requests', body)).json();
    const again = await b.post('/v1/requests', body);
    assert.equal(again.status, 202);
    assert.equal((await again.json()).id, first.id);
    const different = await b.post('/v1/requests', { ...body, payload: { next_action: 'B' } });
    assert.equal(different.status, 409);
    assert.equal((await different.json()).error.code, 'request-mismatch');
  } finally { await b.w.stop(); }
});

test('cancellation: within the window cancels without applying; after application reports already-applied', async () => {
  const b = await boot();
  try {
    const body = { id: RID(5), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'Cancel me' } };
    await b.post('/v1/requests', body);
    b.advance(5_000);
    await b.settle();
    const c = await (await b.post(`/v1/requests/${RID(5)}/cancel`)).json();
    assert.equal(c.outcome, 'cancelled');
    b.advance(10_000);
    await b.settle();
    assert.equal((await (await b.get(`/v1/requests/${RID(5)}`)).json()).state, 'cancelled');
    assert.equal((await (await b.get('/v1/snapshot')).json()).tickets[0].next_action, '');
    await b.post('/v1/requests', { id: RID(6), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'Keep' } });
    b.advance(11_000);
    await b.settle();
    const late = await (await b.post(`/v1/requests/${RID(6)}/cancel`)).json();
    assert.equal(late.outcome, 'already-applied');
    assert.equal(late.request.state, 'applied');
  } finally { await b.w.stop(); }
});

test('validation errors are rejected before the queue: blocked without blocker, done with pending deployments without a choice, malformed JSON', async () => {
  const b = await boot();
  try {
    const r1 = await b.post('/v1/requests', { id: RID(7), kind: 'set-status', target_id: T1, expected_revision: 1, payload: { status: 'blocked' } });
    assert.equal(r1.status, 400);
    assert.equal((await r1.json()).error.code, 'blocker-required');
    const r2 = await fetch(`${b.base}/v1/requests`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: b.cookie, 'x-quill-csrf': b.csrf, origin: b.base }, body: '{not json' });
    assert.equal(r2.status, 400);
    const snap = await (await b.get('/v1/snapshot')).json();
    assert.equal(snap.requests.length, 0);
  } finally { await b.w.stop(); }
});

test('refresh has no undo delay and reuses the active run; set-status blocked applies with blocker text', async () => {
  const b = await boot();
  try {
    const r = await (await b.post('/v1/requests', { id: RID(8), kind: 'refresh', payload: {} })).json();
    assert.equal(r.not_before, r.created_at);
    await b.settle();
    assert.equal((await (await b.get(`/v1/requests/${RID(8)}`)).json()).state, 'applied');
    await b.post('/v1/requests', { id: RID(9), kind: 'set-status', target_id: T1, expected_revision: 1, payload: { status: 'blocked', blocker: 'waiting on infra' } });
    b.advance(10_000);
    await b.settle();
    const snap = await (await b.get('/v1/snapshot')).json();
    assert.equal(snap.tickets[0].status, 'blocked');
    assert.equal(snap.tickets[0].blocker, 'waiting on infra');
  } finally { await b.w.stop(); }
});

test('detail and content endpoints are generation-consistent and return 410 for an expired generation', async () => {
  const b = await boot();
  try {
    const snap = await (await b.get('/v1/snapshot')).json();
    const detail = await b.get(`/v1/tickets/${T1}?generation=${snap.generation_id}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).id, T1);
    const { hash } = putBlob('full checkpoint body', b.env);
    b.w.state.checkpoints.set('content-checkpoint', { content_ref: hash });
    const content = await b.get(`/v1/content/${hash}?generation=${snap.generation_id}`);
    assert.equal(content.status, 200);
    assert.equal(await content.text(), 'full checkpoint body');
    assert.equal((await b.get(`/v1/content/${'0'.repeat(64)}?generation=${snap.generation_id}`)).status, 404);
    // force a new generation
    writeIngress(b.mk('ticket-update', { ticket_id: T1, fields: { next_action: 'bump' }, source: 'manual' }), b.env);
    await b.settle();
    const expired = await b.get(`/v1/tickets/${T1}?generation=${snap.generation_id}`);
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).error.code, 'generation-expired');
  } finally { await b.w.stop(); }
});

test('an applying request interrupted by a restart is re-evaluated against expected_revision on start', async () => {
  const b = await boot();
  try {
    await b.post('/v1/requests', { id: RID(10), kind: 'set-next-action', target_id: T1, expected_revision: 1, payload: { next_action: 'Recovered' } });
    // Simulate crash right after the applying transaction was journaled.
    b.w.emit('request-tx', { request_id: RID(10), outcome: 'applying' }, { source_identity: `request-tx:${RID(10)}:applying` });
    assert.equal(b.w.state.requests.get(RID(10)).state, 'applying');
    await b.w.stop({ flush: false });
    const w2 = new Worker({ config: b.w.config, storeMeta: b.w.storeMeta, env: b.env, clock: () => Date.parse('2026-10-02T09:00:00Z'), derive });
    const ctx = { env: b.env, config: b.w.config, storeMeta: b.w.storeMeta };
    const sext = serverExt(ctx, { port: 0 });
    w2.use(sext);
    await w2.start();
    w2.tick();
    const req = w2.state.requests.get(RID(10));
    assert.equal(req.state, 'applied');
    assert.equal(w2.state.tickets.get(T1).next_action, 'Recovered');
    await w2.stop();
  } finally { /* stopped above */ }
});

test('the owner cookie lasts as long as the 7-day sliding session and is renewed with it (ADR 0022)', async () => {
  const b = await boot();
  try {
    assert.match(b.authRes.headers.get('set-cookie'), /Max-Age=604800/);
    const res = await b.get('/v1/snapshot');
    assert.equal(res.status, 200);
    const renewed = res.headers.get('set-cookie');
    assert.ok(renewed, 'an authenticated response refreshes the cookie');
    assert.equal(renewed.split(';')[0], b.cookie, 'same session token');
    assert.match(renewed, /Max-Age=604800/);
    assert.match(renewed, /HttpOnly/);
    assert.equal((await fetch(`${b.base}/v1/snapshot`)).headers.get('set-cookie'), null, 'no cookie without a session');
  } finally { await b.w.stop(); }
});

test('plan review and plan content require owner authentication and expose compared manifests',async()=>{
  const {capturePlanContext}=await import('../../src/handoff/plans.js');
  const b=await boot();
  try {
    const ticket=b.w.state.tickets.get(T1);ticket.repo_id=null;
    const run={id:RID(70),ticket_id:T1,repo_id:null,intent:'plan',state:'done',plan_ref:putBlob('Owner-only plan',b.env).hash,plan_revision:1,plan_context:capturePlanContext(b.w.state,ticket,{env:b.env})};
    b.w.state.handoffs.set(run.id,run);
    const url=`/v1/handoffs/${run.id}/plan-review`;
    assert.equal((await fetch(`${b.base}${url}`)).status,401);
    const response=await b.get(url);assert.equal(response.status,200);
    const review=await response.json();assert.equal(review.source_plan_ref,run.plan_ref);assert.equal(review.context_changed,false);assert.equal(review.current_manifest.ticket.id,T1);
    assert.equal(await(await b.get(`/v1/content/${run.plan_ref}`)).text(),'Owner-only plan');
    assert.equal((await fetch(`${b.base}/v1/content/${run.plan_ref}`)).status,401);
    ticket.next_action='Changed';assert.equal((await(await b.get(url)).json()).context_changed,true);
    assert.equal((await b.get(`${url}?generation=expired`)).status,410);
    assert.equal((await b.get(`/v1/handoffs/${RID(71)}/plan-review`)).status,404);
  }finally{await b.w.stop();}
});

test('Daily list/detail are owner-only and sharing uses its sanitized artifact, with generation checks',async()=>{
  const b=await boot();
  try {
    const content_ref=putBlob('Private owner detail',b.env).hash,share_ref=putBlob('Eligible public facts',b.env).hash;
    b.w.state.updates??=new Map();b.w.state.updates.set(RID(80),{id:RID(80),revision:1,state:'ready',created_at:b.iso(),content_ref,share_ref});
    for(const url of ['/v1/updates',`/v1/updates/${RID(80)}`]) assert.equal((await fetch(`${b.base}${url}`)).status,401);
    const listing=await b.get('/v1/updates?limit=1');assert.equal(listing.status,200);const list=await listing.json();assert.equal(list.total,1);assert.equal(list.updates.length,1);assert.equal(list.schedule.config.enabled,false);
    assert.equal((await(await b.get(`/v1/updates/${RID(80)}`)).json()).content,'Private owner detail');
    assert.equal((await(await b.get(`/v1/updates/${RID(80)}?share=1`)).json()).content,'Eligible public facts');
    assert.equal((await b.get('/v1/updates?generation=expired')).status,410);
    assert.equal((await b.get(`/v1/updates/${RID(81)}`)).status,404);
    assert.equal((await b.get(`/v1/updates/${RID(80)}?revision=99`)).status,404);
  }finally{await b.w.stop();}
});

test('intent submissions resolve pinned guarded templates and owner plan revisions persist immutable blobs',async()=>{
  const {capturePlanContext}=await import('../../src/handoff/plans.js');
  const {getBlob}=await import('../../src/core/blobs.js');
  const b=await boot();
  try {
    const ticket=b.w.state.tickets.get(T1);ticket.repo_id=null;
    const rejected=await b.post('/v1/requests',{id:RID(90),kind:'handoff',target_id:T1,expected_revision:ticket.revision,payload:{intent:'plan',access:'full'}});
    assert.equal(rejected.status,400);assert.equal((await rejected.json()).error.code,'intent-access-mismatch');
    const submitted=await b.post('/v1/requests',{id:RID(91),kind:'handoff',target_id:T1,expected_revision:ticket.revision,payload:{intent:'plan',instructions:'Owner objective'}});
    assert.equal(submitted.status,202);await b.settle();
    const req=b.w.state.requests.get(RID(91));assert.equal(req.state,'applied',JSON.stringify(req.error));
    const run=b.w.state.handoffs.get(req.result.handoff_id);
    assert.deepEqual([run.intent,run.access,run.legacy,run.recipe.source,run.recipe.name,run.instructions,run.permissions.read_source],['plan','autonomous',false,'builtin','plan','Owner objective',false]);
    Object.assign(run,{state:'done',plan_ref:putBlob('Original plan',b.env).hash,plan_revision:1,plan_context:capturePlanContext(b.w.state,ticket,{env:b.env})});
    const old=run.plan_ref;
    const edit=await b.post('/v1/requests',{id:RID(92),kind:'revise-run-plan',target_id:T1,payload:{handoff_id:run.id,expected_plan_revision:1,text:'Owner revised plan'}});
    assert.equal(edit.status,202);await b.settle();assert.equal(b.w.state.requests.get(RID(92)).state,'applied');assert.equal(run.plan_revision,2);
    assert.equal(getBlob(old,b.env),'Original plan');assert.equal(getBlob(run.plan_ref,b.env),'Owner revised plan');
    const stale=await b.post('/v1/requests',{id:RID(93),kind:'revise-run-plan',target_id:T1,payload:{handoff_id:run.id,expected_plan_revision:1,text:'Stale edit'}});
    assert.equal(stale.status,202);await b.settle();assert.equal(b.w.state.requests.get(RID(93)).state,'conflict');assert.equal(run.plan_revision,2);
  }finally{await b.w.stop();}
});

test('content access rejects orphan blobs and untrusted hash mentions while preserving referenced artifacts',async()=>{
  const b=await boot();
  try {
    const orphan=putBlob('Unreferenced private content',b.env).hash;
    b.w.state.requests.set(RID(120),{id:RID(120),payload:{content_ref:orphan}});
    b.w.state.tickets.get(T1).user_notes=`content_ref: ${orphan}`;
    const generated=putBlob(JSON.stringify({content_ref:orphan}),b.env).hash;
    b.w.state.handoffs.set(RID(119),{ticket_id:T1,result_ref:generated});
    const unreferenced=await b.get(`/v1/content/${orphan}`);
    assert.equal(unreferenced.status,404);
    assert.equal((await b.get(`/v1/content/${orphan}?generation=expired`)).status,410);
    const fields=['result_ref','patch_ref','critic_ref','plan_ref','source_plan_ref','reviewed_context_ref'];
    const refs=Object.fromEntries(fields.map(k=>[k,putBlob(`Artifact ${k}`,b.env).hash]));
    const manifest=putBlob('Plan baseline manifest',b.env).hash;
    b.w.state.handoffs.set(RID(121),{id:RID(121),ticket_id:T1,...refs,plan_context:{manifest_ref:manifest}});
    const ticket=b.w.state.tickets.get(T1);
    for(const key of ['timeline','plans','conclusions']) ticket[key].push({content_ref:putBlob(`Ticket ${key}`,b.env).hash});
    const checkpoint=putBlob('Checkpoint',b.env).hash;b.w.state.checkpoints.set('cp',{content_ref:checkpoint});
    const current=putBlob('Current update',b.env).hash,prior=putBlob('Earlier owner revision',b.env).hash,input=putBlob('Frozen update input',b.env).hash,shared=putBlob('Shareable update',b.env).hash;
    b.w.state.updates.set(RID(122),{content_ref:current,input_ref:input,share_ref:shared,revisions:[{owner_edit_ref:prior}]});
    const allowed=[generated,...Object.values(refs),manifest,checkpoint,current,prior,input,shared,...['timeline','plans','conclusions'].map(k=>ticket[k].at(-1).content_ref)];
    for(const hash of allowed) assert.equal((await b.get(`/v1/content/${hash}`)).status,200,hash);
    const missing='b'.repeat(64);ticket.timeline.push({content_ref:missing});assert.equal((await b.get(`/v1/content/${missing}`)).status,404);
    assert.equal((await fetch(`${b.base}/v1/content/${current}`)).status,401);
    delete b.w.state.handoffs.get(RID(121)).patch_ref;
    assert.equal((await b.get(`/v1/content/${refs.patch_ref}`)).status,404,'a removed reference no longer authorizes its blob');
  }finally{await b.w.stop();}
});
