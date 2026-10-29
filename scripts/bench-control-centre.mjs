// Deterministic in-memory projection benchmark; no model, provider or live store access.
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { newState, createTicket } from '../tests/core/helpers.js';
import { buildSnapshot } from '../src/worker/projections.js';
import { buildEvidenceBundle, resolveWindow } from '../src/updates/evidence.js';
const state=newState(), now='2026-10-30T00:00:00Z';
const id=n=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
for(let i=0;i<2000;i++) {
 const t=createTicket(state,{id:id(i),key:`LOCAL-perf-${i}`,title:`Work item ${i}`,parent_id:i>0&&i<=1000?id(0):i>1001&&i<=1051?id(i-1):null});
 t.blocks_parent=t.parent_id?true:null;
 t.timeline=Array.from({length:10},(_,j)=>({id:`${i}:${j}`,event_id:`e:${i}:${j}`,kind:'write',at:'2026-10-29T12:00:00Z',text:`Updated component ${j}`}));
}
state.lastSequence=20000;
const window=resolveWindow({window_kind:'last-24-hours'},{now,timezone:'UTC'});
function bench(name,fn) { const samples=[];for(let i=0;i<35;i++){const start=performance.now();fn();if(i>=5)samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);return {name,samples:samples.length,p50_ms:+samples[15].toFixed(2),p95_ms:+samples[28].toFixed(2),max_ms:+samples.at(-1).toFixed(2)}; }
console.log(JSON.stringify({hardware:{cpu:os.cpus()[0].model,platform:os.platform(),arch:os.arch(),node:process.version},fixture:{tickets:2000,timeline_events:20000,wide_children:1000,chain_levels:50},results:[bench('owner snapshot',()=>buildSnapshot(state,{generation_id:'bench',generated_at:now})),bench('daily evidence',()=>buildEvidenceBundle(state,{window,maxFacts:25000}))]},null,2));
