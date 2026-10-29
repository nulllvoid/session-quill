import test from 'node:test';
import assert from 'node:assert/strict';
import { assessClosure, closureContext, reconciliationItems } from '../../src/core/closure.js';
import * as work from '../../src/core/work.js';

const nowIso = '2026-10-30T00:00:00Z';
const ticket = (id, extra = {}) => ({ id, key: id, title: id, status: 'todo', priority: 'P2', prs: [], deployments: [], timeline: [], ...extra });
const state = (tickets, runs = []) => ({ tickets: new Map(tickets.map(t => [t.id, t])), handoffs: new Map(runs.map(h => [h.id, h])), reconcileChecks: new Map(), runProposals: new Map() });

test('Work counts required outcomes separately from independent and unknown relationships', () => {
  const children = Array.from({ length: 6 }, (_, i) => ticket(`c${i}`, { parent_id: 'p', blocks_parent: true, status: i < 4 ? 'done' : i === 4 ? 'blocked' : 'todo' }));
  const s = state([ticket('p', { completion_mode: 'children' }), ...children, ticket('optional', { parent_id: 'p', blocks_parent: false }), ticket('legacy', { parent_id: 'p' })]);
  const r = work.buildWorkRollups(s, { nowIso }).get('p');
  assert.deepEqual([r.required_total, r.completed, r.remaining, r.independent, r.unclassified], [6, 4, 2, 1, 1]);
  assert.equal(r.pending_descendants, 2);
  assert.equal(r.closure_state, 'needs-review');
});

test('a reopened required grandchild invalidates completed counts and closure through required ancestors', () => {
  const root = ticket('r', { completion_mode: 'children', completion_policy_seq: 2 });
  const parent = ticket('p', { parent_id: 'r', blocks_parent: true, status: 'done', closed_sequence: 3 });
  const leaf = ticket('c', { parent_id: 'p', blocks_parent: true, status: 'active' });
  const s = state([root, parent, leaf]);
  assert.equal(assessClosure(root, closureContext(s, nowIso)).closable, false);
  const rows = work.buildWorkRollups(s, { nowIso });
  assert.equal(rows.get('r').completed, 0);
  assert.equal(rows.get('r').remaining, 1);
  assert.equal(rows.get('p').closure_state, 'needs-review');
  assert.equal(parent.status, 'done');
  assert.ok(reconciliationItems(s, nowIso).some(x => x.ticket_id === 'p' && x.kind === 'closure-conflict'));
  leaf.blocks_parent = false;
  assert.equal(work.buildWorkRollups(s, { nowIso }).get('r').completed, 1);
});

test('resolved without delivery is remaining, but optional work never blocks required completion', () => {
  const s = state([ticket('p', { completion_mode: 'children' }), ticket('a', { parent_id: 'p', blocks_parent: true, status: 'done', resolution: { kind: 'abandoned' } }), ticket('b', { parent_id: 'p', blocks_parent: false, status: 'active' })]);
  const r = work.buildWorkRollups(s, { nowIso }).get('p');
  assert.deepEqual([r.completed, r.remaining, r.resolved_without_delivery], [0, 1, 1]);
  s.tickets.get('a').resolution.kind = 'completed';
  assert.equal(work.buildWorkRollups(s, { nowIso }).get('p').closure_state, 'ready');
});

test('Work preserves pending deployment reasons and empty child counts', () => {
  const s = state([ticket('p', { status: 'review', prs: [{ id: 'pr', state: 'merged', observed_at: nowIso }], deployments: [{ pr_id: 'pr', state: 'pending' }] })]);
  const r = work.buildWorkRollups(s, { nowIso }).get('p');
  assert.equal(r.required_total, 0);
  assert.equal(r.closure_state, 'not-ready');
  assert.ok(r.reasons.some(x => /deployment/i.test(x.text)));
});

test('Work handles deep hierarchies, cycles and missing parents without mutation', () => {
  const list = Array.from({ length: 1500 }, (_, i) => ticket(String(i), { parent_id: i ? String(i - 1) : null, blocks_parent: i ? true : null }));
  list.push(ticket('cycle-a', { parent_id: 'cycle-b', blocks_parent: true }), ticket('cycle-b', { parent_id: 'cycle-a', blocks_parent: true }), ticket('orphan', { parent_id: 'missing', blocks_parent: true }));
  const s = state(list), before = JSON.stringify(list);
  const rows = work.buildWorkRollups(s, { nowIso });
  assert.equal(rows.get('0').pending_descendants, 1499);
  assert.equal(rows.get('cycle-a').closure_state, 'needs-review');
  assert.equal(rows.get('orphan').closure_state, 'needs-review');
  assert.equal(JSON.stringify(list), before);
});

test('contradictory live evidence on done required children blocks parent completion',()=>{
 for(const extra of [{deployments:[{state:'pending'}]},{runs:[{id:'h',ticket_id:'c',state:'running'}]},{runs:[{id:'h',ticket_id:'c',state:'failed',uncertain_effects:['unknown write']}]}]) {
  const root=ticket('p',{completion_mode:'children'}), child=ticket('c',{parent_id:'p',blocks_parent:true,status:'done',deployments:extra.deployments??[]});
  const s=state([root,child],extra.runs??[]), rows=work.buildWorkRollups(s,{nowIso});
  assert.equal(rows.get('p').completed,0);assert.equal(rows.get('c').closure_state,'needs-review');assert.equal(assessClosure(root,closureContext(s,nowIso)).closable,false);assert.equal(child.status,'done');
 }
});

test('resolved run failures cannot keep completed work in attention forever',()=>{
 const t=ticket('p'), failed={id:'old',ticket_id:'p',intent:'auto',state:'failed',requested_at:'2026-10-01T00:00:00Z',finished_at:'2026-10-01T00:01:00Z'}, next={id:'new',ticket_id:'p',state:'running',requested_at:'2026-10-29T00:00:00Z',retry_of:'old'};
 const s=state([t],[failed,next]);
 assert.equal(work.buildWorkRollups(s,{nowIso}).get('p').attention_count,1);
 next.state='done'; assert.equal(work.buildWorkRollups(s,{nowIso}).get('p').attention_count,0);
 next.state='cancelled'; assert.equal(work.buildWorkRollups(s,{nowIso}).get('p').attention_count,1);
 s.handoffs.set('final',{id:'final',ticket_id:'p',state:'done',requested_at:'2026-10-29T01:00:00Z'}); assert.equal(work.buildWorkRollups(s,{nowIso}).get('p').attention_count,0);
 t.status='done'; assert.equal(work.buildWorkRollups(s,{nowIso}).get('p').attention_count,0);
 t.status='todo';delete failed.intent; assert.equal(work.buildWorkRollups(s,{nowIso}).get('p').attention_count,0);
});

test('owner snapshot exposes delivery availability without repository credentials',async()=>{
 const {newState,createTicket}=await import('./helpers.js');const {buildSnapshot}=await import('../../src/worker/projections.js');
 const s=newState();createTicket(s);s.meta.repos.demo.provider={type:'github',token:'private-provider-value'};
 const snap=buildSnapshot(s,{generation_id:'test',generated_at:nowIso});
 assert.equal(snap.repos[0].provider_configured,true);assert.doesNotMatch(JSON.stringify(snap),/private-provider-value/);
 delete s.meta.repos.demo.provider;assert.equal(buildSnapshot(s,{generation_id:'test2',generated_at:nowIso}).repos[0].provider_configured,false);
});
