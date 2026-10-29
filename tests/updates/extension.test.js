import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createUpdatesExtension,updateDetail,validateUpdateRequest} from '../../src/updates/extension.js';
import {handleUpdateTx} from '../../src/core/reduce/updates.js';import {createState,newTicket} from '../../src/core/state.js';import {uuid} from '../../src/lib/ids.js';import {getBlob} from '../../src/core/blobs.js';
function fixture(synthesizer) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'quill-update-test-'));const env={QUILL_HOME:home};let now='2026-10-30T18:00:00.000Z';
 const state=createState({store_id:uuid(),machine_id:uuid(),timezone:'UTC'});state.updates=new Map();state.updateCursors=new Map();
 const t=newTicket(state,{id:uuid(),key:'TEST-1',title:'Seven-week task',created_at:'2026-09-01T00:00:00.000Z'});t.timeline=[{id:'event',event_id:'event',at:'2026-10-30T12:00:00.000Z',kind:'commit',text:'Commit abcdef1234: work'}];state.tickets.set(t.id,t);state.lastSequence=1;
 const worker={state,env,config:{schedule:[]},now:()=>now,markGenerationDirty(){},journal:{*read(){}},emit(kind,payload){const event={payload,occurred_at:now};if(kind==='update-tx') return {result:handleUpdateTx(state,event)};if(kind==='request-tx'){const r=state.requests.get(payload.request_id);if(['applied','failed','conflict','cancelled'].includes(r.state))return {result:{duplicate:true}};Object.assign(r,{state:payload.outcome,result:payload.result,error:payload.error});}return {result:{}};}};
 const ext=createUpdatesExtension({env,config:worker.config},{synthesizer});ext.onStart(worker);
 return {worker,ext,home,env,set:iso=>{now=iso;},request(kind,payload){const r={id:uuid(),kind,payload,producer:'worker',actor_id:'owner',state:'pending',created_at:now,sequence:state.lastSequence};state.requests.set(r.id,r);return r;},clean:()=>fs.rmSync(home,{recursive:true,force:true})};
}
test('durable deterministic generation, owner edits, regeneration preserve frozen input and revisions',async()=>{
 const f=fixture();try {
  const u=await f.worker.generateDailyUpdate({window_kind:'since-last'});assert.equal(u.state,'ready');assert.match(updateDetail(f.worker.state,u.id,{env:f.env}).content,/Seven-week task/);assert.equal(f.worker.state.updateCursors.size,1);
  const input=u.input_ref;const r=f.request('edit-update',{update_id:u.id,expected_revision:1,text:'Owner annotation'});f.ext.tick(f.worker);await f.ext.idle();assert.equal(r.state,'applied');
  await f.worker.generateDailyUpdate({regenerate_id:u.id});assert.equal(u.revision,3);assert.equal(u.input_ref,input);assert.equal(updateDetail(f.worker.state,u.id,{env:f.env,revision:2}).content,'Owner annotation');
  assert.equal(f.worker.state.updateCursors.size,1);assert.equal(u.contributes,false);
 } finally {f.clean();}
});
test('bad narrative and missing runtime retain deterministic facts',async()=>{
 const f=fixture(async()=>({claims:[{evidence_ids:['fake'],text:'Everything done'}]}));try {
  const u=await f.worker.generateDailyUpdate({synthesis:true});assert.equal(u.state,'ready');assert.match(u.narrative_error,/unknown/);assert.doesNotMatch(getBlob(u.content_ref,f.env),/Everything done/);
 } finally {f.clean();}
});
test('one active normalized request joins; cancellation is durable without a cursor',async()=>{
 let release;const f=fixture(()=>new Promise(r=>{release=r;}));try {
  const a=f.worker.generateDailyUpdate({window_kind:'since-last',synthesis:true});const b=f.worker.generateDailyUpdate({window_kind:'since-last',synthesis:true});
  assert.equal(f.worker.state.updates.size,1);const u=[...f.worker.state.updates.values()][0];const request=f.request('cancel-update',{update_id:u.id});f.ext.tick(f.worker);release({claims:[]});await Promise.all([a,b]);await f.ext.idle();assert.equal(u.state,'cancelled');assert.equal(f.worker.state.updateCursors.size,0);assert.equal(request.state,'applied');
 } finally {f.clean();}
});
test('interrupted frozen input retries, while forged ingress requests cannot generate',async()=>{
 const f=fixture();try {
  const u=await f.worker.generateDailyUpdate({});u.state='running';const ref=u.input_ref;
  f.ext.onStart(f.worker);assert.equal(u.state,'failed');await f.worker.generateDailyUpdate({retry_id:u.id});assert.equal(u.state,'ready');assert.equal(u.input_ref,ref);
  const r=f.request('generate-update',{});r.producer='cli';f.ext.tick(f.worker);assert.equal(r.state,'failed');assert.equal(r.error.code,'owner-required');
 } finally {f.clean();}
});
test('boundary validation rejects bad scopes and unsafe edit sizes',()=>{
 assert.throws(()=>validateUpdateRequest('generate-update',{scope:{repo_ids:42}}));assert.throws(()=>validateUpdateRequest('edit-update',{update_id:uuid(),expected_revision:1,text:'a'.repeat(100001)}));
});

test('generic cancellation also aborts an active regeneration request promptly',async()=>{
 let never=false;const f=fixture(async()=>never?new Promise(()=>{}):{claims:[]});try {
  const u=await f.worker.generateDailyUpdate({synthesis:true});never=true;
  const r=f.request('generate-update',{regenerate_id:u.id});f.ext.tick(f.worker);r.state='cancelled';f.ext.tick(f.worker);await f.ext.idle();assert.equal(u.state,'cancelled');assert.equal(r.state,'cancelled');
 }finally{f.clean();}
});
