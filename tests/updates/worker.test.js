import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {Worker} from '../../src/worker/worker.js';import {createStoreMeta,writeStoreMeta} from '../../src/config/store.js';import {defaultUserConfig,saveUserConfig} from '../../src/config/config.js';import {createUpdatesExtension,updateDetail} from '../../src/updates/extension.js';import {submitRequest} from '../../src/server/requests.js';import {getBlob} from '../../src/core/blobs.js';import {buildWorker} from '../../src/cli/commands/worker.js';
function fixture(){const home=fs.mkdtempSync(path.join(os.tmpdir(),'quill-update-worker-')),env={QUILL_HOME:home},machine=randomUUID(),store_path=path.join(home,'store');fs.mkdirSync(store_path);const storeMeta=createStoreMeta({store_name:'Test',owner_machine_id:machine,timezone:'UTC'});writeStoreMeta(store_path,storeMeta);fs.writeFileSync(path.join(home,'machine.json'),JSON.stringify({machine_id:machine,machine_name:'test'}));const config={...defaultUserConfig(),store_path,schedule:[],projects:{demo:{name:'Demo'}},repos:{}};saveUserConfig(config,env);let now=Date.parse('2026-10-29T10:00:00Z');return {home,env,config,storeMeta,machineId:machine,clock:()=>now,set:s=>{now=Date.parse(s);}};}
async function boot(f){const w=new Worker({...f});const ext=createUpdatesExtension(f);w.use(ext);await w.start();return {w,ext};}
test('real request freezes acceptance, journal replay/checkpoint retain drafts and cursor, historical report cannot move it',async()=>{
 const f=fixture();let {w,ext}=await boot(f);try {
  const id=randomUUID();w.emit('ticket-create',{ticket:{id,key:'TEST-1',title:'Original title',project_id:'demo',summary:'Goal: ship\nContext: test\nDone when: complete'}});
  f.set('2026-10-30T18:00:00Z');const req=submitRequest(w,{id:randomUUID(),kind:'generate-update',payload:{window_kind:'since-last'}}).request;
  f.set('2026-10-30T18:01:00Z');w.emit('ticket-update',{ticket_id:id,fields:{title:'Later changed title'}},{ticket_id:id});w.tick();await ext.idle();
  const saved=w.state.requests.get(req.id);assert.equal(saved.state,'applied',JSON.stringify(saved.error));const u=w.state.updates.get(saved.result.update_id);assert.equal(u.state,'ready');assert.match(updateDetail(w.state,u.id,{env:f.env}).content,/Original title/);assert.doesNotMatch(updateDetail(w.state,u.id,{env:f.env}).content,/Later changed title/);
  const cursor=structuredClone([...w.state.updateCursors.values()][0]);assert.equal(cursor.through_at,'2026-10-30T18:00:00.000Z');
  w.writeStateCheckpoint();await w.stop();({w,ext}=await boot(f));assert.equal(w.state.updates.get(u.id).input_ref,u.input_ref);assert.deepEqual([...w.state.updateCursors.values()][0],cursor);
  const historical=submitRequest(w,{id:randomUUID(),kind:'generate-update',payload:{window_kind:'custom',window_start:'2026-10-29T00:00:00Z',window_end:'2026-10-30T00:00:00Z'}}).request;w.tick();await ext.idle();assert.equal(w.state.requests.get(historical.id).state,'applied');assert.deepEqual([...w.state.updateCursors.values()][0],cursor);
  const frozen=JSON.parse(getBlob(u.input_ref,f.env));assert.equal(frozen.bundle.source_sequence,req.sequence);
 }finally{await w.stop();fs.rmSync(f.home,{recursive:true,force:true});}
});
test('production worker attaches Daily updates before the scheduler and no schedules enable by default',async()=>{
 const f=fixture();try {const w=await buildWorker(f);assert.equal(w.extensions[0].name,'updates');assert.equal(f.config.schedule.length,0);}finally{fs.rmSync(f.home,{recursive:true,force:true});}
});
