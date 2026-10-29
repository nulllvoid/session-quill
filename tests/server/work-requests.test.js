import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newState, createTicket, ev } from '../core/helpers.js';
import { validateRequestBody, evaluateRequest } from '../../src/server/requests.js';
const now = '2026-10-30T00:00:00Z';
function request(state, ticket, kind, payload) { return validateRequestBody({ id: randomUUID(), kind, target_id: ticket.id, expected_revision: ticket.revision, payload }, state, now); }
function apply(state, req) { ev(state, 'request', req, { producer: 'worker' }); const answer = evaluateRequest({state, now:()=>now}, req); ev(state, 'request-tx', {request_id:req.id,...answer}, {producer:'worker'}); return answer; }
test('priority edit is validated, delayed and revision checked', () => {
 const state=newState(), ticket=createTicket(state);
 assert.throws(()=>request(state,ticket,'set-priority',{priority:'urgent'}));
 const req=request(state,ticket,'set-priority',{priority:'P0'});
 assert.equal(req.not_before,'2026-10-30T00:00:10Z');
 ticket.revision++; assert.equal(apply(state,req).outcome,'conflict'); assert.equal(ticket.priority,'P2');
 assert.equal(apply(state,request(state,ticket,'set-priority',{priority:'P1'})).outcome,'applied'); assert.equal(ticket.priority,'P1');
});
test('subtask creation is idempotent and inherits privacy and repository',()=>{
 const state=newState(), parent=createTicket(state); parent.local_only=true;
 const req=request(state,parent,'create-subtask',{title:'Verify the fix',description:'Goal: Verify the completed fix\nContext: Parent task\nDone when:\n- Tests pass',blocks_parent:true});
 assert.equal(apply(state,req).outcome,'applied');
 const child=[...state.tickets.values()].find(t=>t.parent_id===parent.id);
 assert.equal(child.blocks_parent,true); assert.equal(child.local_only,true); assert.equal(child.repo_id,parent.repo_id); assert.ok(parent.revision>req.expected_revision);
 apply(state,req); assert.equal(state.tickets.size,2);
});
test('reparent checks both parent revisions, prevents cycles, and changes all revisions atomically',()=>{
 const state=newState(), parent=createTicket(state), other=createTicket(state,{id:randomUUID(),key:'LOCAL-other-1'}), child=createTicket(state,{id:randomUUID(),key:'LOCAL-child-1',parent_id:parent.id});
 const payload={parent_id:other.id,blocks_parent:false,old_parent_revision:parent.revision,new_parent_revision:other.revision};
 const req=request(state,child,'set-parent',payload); other.revision++;
 assert.equal(apply(state,req).outcome,'conflict'); assert.equal(child.parent_id,parent.id);
 const old=parent.revision, next=other.revision;
 assert.equal(apply(state,request(state,child,'set-parent',{...payload,new_parent_revision:next})).outcome,'applied');
 assert.equal(child.parent_id,other.id); assert.equal(child.blocks_parent,false); assert.ok(parent.revision>old); assert.ok(other.revision>next);
 assert.throws(()=>request(state,other,'set-parent',{parent_id:child.id,blocks_parent:true,old_parent_revision:null,new_parent_revision:child.revision}),/cycle/);
 assert.equal(apply(state,request(state,child,'set-parent',{parent_id:null,blocks_parent:null,old_parent_revision:other.revision,new_parent_revision:null})).outcome,'applied'); assert.equal(child.parent_id,null);
});
test('unlinking required work makes parent ready but does not close it on this or a later unrelated edit',()=>{
 const state=newState(), parent=createTicket(state), done=createTicket(state,{id:randomUUID(),key:'LOCAL-done-1',parent_id:parent.id}), open=createTicket(state,{id:randomUUID(),key:'LOCAL-open-1',parent_id:parent.id});
 parent.completion_mode='children'; parent.completion_policy_seq=1; done.status='done'; done.closed_sequence=2; done.blocks_parent=true; open.blocks_parent=true;
 assert.equal(apply(state,request(state,open,'set-parent',{parent_id:null,blocks_parent:null,old_parent_revision:parent.revision,new_parent_revision:null})).outcome,'applied');
 assert.equal(parent.status,'todo');
 apply(state,request(state,parent,'set-priority',{priority:'P1'})); assert.equal(parent.status,'todo');
 assert.equal(apply(state,request(state,parent,'set-status',{status:'done',reconcile_close:true})).outcome,'applied'); assert.equal(parent.status,'done');
});
test('Daily artifact request bookkeeping never closes otherwise ready parent tasks',()=>{
 for(const kind of ['generate-update','edit-update','cancel-update','set-update-schedule']) {
  const state=newState(),parent=createTicket(state),child=createTicket(state,{id:randomUUID(),key:'LOCAL-child-1',parent_id:parent.id});
  parent.completion_mode='children';parent.completion_policy_seq=1;child.blocks_parent=true;child.status='done';child.closed_sequence=2;
  const id=randomUUID();ev(state,'request',{id,kind,payload:{},created_at:now},{producer:'worker'});
  for(const outcome of ['applying','applied']) {ev(state,'request-tx',{request_id:id,outcome},{producer:'worker'});assert.equal(parent.status,'todo',`${kind}/${outcome} is not task completion authority`);}
 }
});
