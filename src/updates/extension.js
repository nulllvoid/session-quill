import { deterministicId, isUuid } from '../lib/ids.js';
import { TrackerError } from '../lib/errors.js';
import { putBlob, getBlob, hasBlob } from '../core/blobs.js';
import { createState } from '../core/state.js';
import { applyEvent } from '../core/reducer.js';
import { normalizeScope, cursorKey, fingerprint, resolveWindow, buildEvidenceBundle } from './evidence.js';
import { renderUpdate, validateNarrative } from './generate.js';
import { normalizeUpdateSchedule, saveUpdateSchedule, updateScheduleInfo } from './schedule.js';
import { synthesizeUpdate } from './runtime.js';
export const UPDATE_KINDS=new Set(['generate-update','edit-update','cancel-update','set-update-schedule']);
const error=(code,message)=>new TrackerError(code,message);
const terminal=new Set(['ready','partial','failed','cancelled']);
export function validateUpdateRequest(kind,p={}, {state,now=null}={}) {
  if(!p || typeof p!=='object'||Array.isArray(p)) throw error('request-invalid','update payload must be an object');
  if(kind==='generate-update') {
    const out={window_kind:p.window_kind??'last-24-hours',scope:normalizeScope(p.scope),synthesis:p.synthesis===true};
    if(p.synthesis!==undefined&&typeof p.synthesis!=='boolean') throw error('request-invalid','synthesis must be true or false');
    if(!['today','yesterday','last-24-hours','since-last','custom'].includes(out.window_kind)) throw error('request-invalid','unknown update window');
    for(const key of ['retry_id','regenerate_id']) if(p[key]!==undefined) {if(!isUuid(p[key])||state&&!state.updates?.has(p[key])) throw error('update-unknown','unknown source update');out[key]=p[key];}
    if(out.retry_id&&out.regenerate_id) throw error('request-invalid','choose retry or regeneration');
    if(out.window_kind==='custom') {out.window_start=p.window_start;out.window_end=p.window_end;resolveWindow(out,{now:now??new Date().toISOString(),timezone:state?.meta.timezone??'UTC'});}
    for(const [field,registry] of [['repo_ids',state?.meta.repos],['project_ids',state?.meta.projects]]) for(const id of out.scope[field]) if(registry && !registry[id]) throw error('scope-unknown',`unknown ${field}: ${id}`);
    return out;
  }
  if(kind==='edit-update'||kind==='cancel-update') {
    if(!isUuid(p.update_id)||state&&!state.updates?.has(p.update_id)) throw error('update-unknown','unknown update');
    if(kind==='cancel-update') return {update_id:p.update_id};
    if(!Number.isInteger(p.expected_revision)||p.expected_revision<1) throw error('expected-revision-required','update edits need an expected revision');
    if(typeof p.text!=='string'||!p.text.trim()||p.text.length>100000) throw error('request-invalid','update text must contain 1 to 100000 characters');
    return {update_id:p.update_id,expected_revision:p.expected_revision,text:p.text};
  }
  if(kind==='set-update-schedule') {
    if(!/^[a-f0-9]{64}$/.test(p.expected_fingerprint??'')) throw error('request-invalid','schedule needs the current configuration fingerprint');
    return {...normalizeUpdateSchedule(p),expected_fingerprint:p.expected_fingerprint};
  }
  throw error('kind-invalid','unknown update request');
}
export function listUpdates(state,{offset=0,limit=50}={}) {
  offset=Math.max(0,Number(offset)||0);limit=Math.max(1,Math.min(100,Number(limit)||50));
  const all=[...(state.updates?.values()??[])].sort((a,b)=>b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id));
  return {updates:all.slice(offset,offset+limit).map(u=>{const {evidence_refs,revisions,...metadata}=u;return {...structuredClone(metadata),revision_count:(revisions?.length??0)+1};}),total:all.length,offset,limit};
}
export function updateDetail(state,id,{revision=null,env=process.env,share=false}={}) {
  const u=state.updates?.get(id);if(!u) throw error('update-unknown','update not found');
  let selected=u;if(revision!==null&&Number(revision)!==u.revision) {selected=u.revisions?.find(r=>r.revision===Number(revision));if(!selected) throw error('update-revision-unknown','update revision not found');}
  const ref=share?selected.share_ref??u.share_ref:selected.owner_edit_ref??selected.content_ref;
  const content=ref?getBlob(ref,env):null;
  return {...structuredClone(u),selected_revision:selected.revision,content,share_content:share?content:null,content_missing:!!ref&&content===null,...(ref&&content===null?{coverage:{state:'partial',omissions:[{kind:'missing-content'}],omitted_count:1}}:{})};
}
export function updateContentRefs(state) {
  const refs=new Set();for(const u of state.updates?.values()??[]) for(const revision of [u,...(u.revisions??[])]) for(const key of ['input_ref','content_ref','owner_edit_ref','share_ref']) if(revision[key]) refs.add(revision[key]);return refs;
}
export { updateScheduleInfo };
function frozenState(worker,sequence,end,{includeCutoff=false}={}) {
  const events=new Map(),eventSequences=new Map(); let reconstruct=sequence<worker.state.lastSequence || Date.parse(end)<Date.parse(worker.now());
  const state=reconstruct?createState(worker.state.meta):structuredClone(worker.state);
  if(worker.journal?.read) for(const ev of worker.journal.read()) {
    if(ev.sequence>sequence) break;
    events.set(ev.event_id,ev);eventSequences.set(ev.event_id,ev.sequence);
    if(reconstruct&&(Date.parse(ev.occurred_at)<Date.parse(end)||(includeCutoff&&Date.parse(ev.occurred_at)===Date.parse(end)))) applyEvent(state,ev);
  }
  else if(reconstruct) return {state:structuredClone(worker.state),events,eventSequences,missingHistory:true};
  state.lastSequence=sequence;
  return {state,events,eventSequences,missingHistory:false};
}
export function createUpdatesExtension(ctx, {synthesizer=synthesizeUpdate,claudePath='claude',claudeArgs=[]}={}) {
  let active=null,worker0=null;
  const tx=(worker,p)=>{const r=worker.emit('update-tx',p);if(r?.result?.rejected) throw error(r.result.rejected,'update transaction rejected');worker.markGenerationDirty?.();};
  const finishRequest=(worker,r,result,err=null)=>worker.emit('request-tx',{request_id:r.id,outcome:err?(err.code?.includes('conflict')?'conflict':'failed'):'applied',...(err?{error:{code:err.code??'update-failed',message:err.message,retryable:true,current_revision:null}}:{result})},{source_identity:`request-tx:${r.id}:update-result`});
  function createFrozen(worker,options,{request=null,slot=null}={}) {
    const id=deterministicId(`update:${slot??request?.id??fingerprint(options)}`);
    if(worker.state.updates.has(id)) return worker.state.updates.get(id);
    const timezone=worker.state.meta.timezone??'UTC',scope=normalizeScope(options.scope),key=cursorKey(scope,timezone);
    const now=request?.created_at??worker.now(),sequence=request?.sequence??worker.state.lastSequence;
    const accepted=sequence<worker.state.lastSequence ? frozenState(worker,sequence,now,{includeCutoff:true}) : null;
    const cursor=(accepted?.state??worker.state).updateCursors?.get(key)??null;
    const window=resolveWindow(options,{now,timezone,cursor,scheduled:!!slot});
    const input=accepted && window.window_end===now ? accepted : frozenState(worker,sequence,window.window_end,{includeCutoff:Date.parse(window.window_end)===Date.parse(now)});
    const bundle=buildEvidenceBundle(input.state,{...input,window,scope,hasContent:ref=>hasBlob(ref,worker.env)});
    const shared=buildEvidenceBundle(input.state,{...input,window,scope,share:true});
    if(input.missingHistory) {bundle.coverage={state:'partial',omitted_count:1,omissions:[{kind:'journal-unavailable'}]};}
    const input_ref=putBlob(JSON.stringify({bundle,shared}),worker.env).hash;
    const meta={id,scope,window_kind:window.window_kind,window_start:window.window_start,window_end:window.window_end,timezone,source_sequence:sequence,input_ref,input_fingerprint:fingerprint({bundle,shared}),evidence_refs:bundle.facts.map(f=>f.source_ref),coverage:bundle.coverage,contributes:window.contributes,cursor_key:key,carryover_start:window.carryover_start,bootstrap:window.bootstrap,trigger:slot?'schedule':'manual',slot_identity:slot,request_id:request?.id??null,synthesis:options.synthesis===true};
    tx(worker,{op:'create',update:meta});return worker.state.updates.get(id);
  }
  async function generate(worker,u,options={}) {
    tx(worker,{op:'attempt',update_id:u.id});
    const controller=new AbortController();let timer;const entry={id:u.id,controller,key:options.joinKey,requestIds:new Set(options.requestId?[options.requestId]:[]),promise:null};active=entry;
    const promise=(async()=>{
      try {
        const text=getBlob(u.input_ref,worker.env);if(text===null) throw error('input-missing','frozen update input is missing; start a new generation');
        const {bundle,shared}=JSON.parse(text);let narrative=null,narrative_error=null;
        if(u.synthesis&&bundle.facts.some(f=>f.section!=='context')) {
          const limits={max_budget_usd:options.max_budget_usd??0.25,timeout_seconds:options.timeout_seconds??120};
          const cancelled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(error('cancelled','generation interrupted')),{once:true}));
          const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort('timeout');reject(error('narrative-timeout','narrative exceeded its time limit'));},limits.timeout_seconds*1000);});
          try {narrative=validateNarrative(await Promise.race([synthesizer(bundle,{worker,signal:controller.signal,limits,updateId:u.id,claudePath,claudeArgs}),timeout,cancelled]),bundle);}
          catch(err) {narrative_error=err.message;}
          finally {clearTimeout(timer);}
        }
        if(controller.signal.aborted && controller.signal.reason!=='timeout') {if(!terminal.has(worker.state.updates.get(u.id).state)) tx(worker,{op:'finish',update_id:u.id,state:'cancelled',error:{code:'cancelled',message:'generation cancelled'}});return worker.state.updates.get(u.id);}
        const content_ref=putBlob(renderUpdate(bundle,{narrative,narrativeError:narrative_error}),worker.env).hash;
        const share_ref=putBlob(renderUpdate(shared),worker.env).hash;
        const cursor={through_at:u.window_end,source_sequence:u.source_sequence,evidence_ids:bundle.facts.filter(f=>f.section!=='context').map(f=>f.source_id)};
        tx(worker,{op:'finish',update_id:u.id,state:bundle.coverage.state==='complete'?'ready':'partial',content_ref,share_ref,coverage:bundle.coverage,narrative_error,cursor});
      } catch(err) {tx(worker,{op:'finish',update_id:u.id,state:'failed',error:{code:err.code??'generation-failed',message:err.message}});}
      finally {clearTimeout(timer);if(active===entry) active=null;}
      return worker.state.updates.get(u.id);
    })();entry.promise=promise;return promise;
  }
  async function run(worker,options,meta={}) {
    if(meta.request&&worker.state.requests.get(meta.request.id)?.state==='cancelled') throw error('cancelled','queued generation cancelled');
    const joinKey=fingerprint({scope:normalizeScope(options.scope),window_kind:options.window_kind??'last-24-hours',synthesis:options.synthesis===true,window_start:options.window_start,window_end:options.window_end,retry_id:options.retry_id,regenerate_id:options.regenerate_id});
    if(active) {if(active.key===joinKey&&!meta.slot) {if(meta.request) active.requestIds.add(meta.request.id);return active.promise;}await active.promise;return run(worker,options,meta);}
    let u;
    if(options.retry_id||options.regenerate_id) {
      u=worker.state.updates.get(options.retry_id??options.regenerate_id);if(!u) throw error('update-unknown','source update is missing');
      if(options.regenerate_id) {tx(worker,{op:'regenerate',update_id:u.id,expected_revision:u.revision});u=worker.state.updates.get(u.id);}
      else if(!['failed','cancelled','partial'].includes(u.state)) return u;
    } else u=createFrozen(worker,options,meta);
    if(['ready','partial'].includes(u.state)&&!options.retry_id) return u;
    return generate(worker,u,{...options,joinKey,requestId:meta.request?.id});
  }
  function process(worker,r) {
    if(r.producer!=='worker'||r.actor_id!=='owner') {finishRequest(worker,r,null,error('owner-required','Daily update requests require the authenticated owner'));return;}
    let p;try {p=validateUpdateRequest(r.kind,r.payload,{state:worker.state,now:worker.now()});}catch(err){finishRequest(worker,r,null,err);return;}
    worker.emit('request-tx',{request_id:r.id,outcome:'applying'},{source_identity:`request-tx:${r.id}:applying`});
    const operation=(async()=>{
      if(r.kind==='generate-update') {const u=await run(worker,p,{request:r});if(u.state==='failed') throw error(u.error?.code??'generation-failed',u.error?.message??'generation failed');return {update_id:u.id,revision:u.revision,state:u.state};}
      if(r.kind==='edit-update') {tx(worker,{op:'edit',update_id:p.update_id,expected_revision:p.expected_revision,content_ref:putBlob(p.text,worker.env).hash});return {update_id:p.update_id,revision:worker.state.updates.get(p.update_id).revision};}
      if(r.kind==='cancel-update') {if(active?.id===p.update_id) active.controller.abort('cancelled');tx(worker,{op:'finish',update_id:p.update_id,state:'cancelled',error:{code:'cancelled',message:'owner cancelled'}});return {update_id:p.update_id};}
      return {schedule:await saveUpdateSchedule(worker,p)};
    })();
    operation.then(result=>finishRequest(worker,r,result),err=>finishRequest(worker,r,null,err));return operation;
  }
  const pending=new Set();
  return {name:'updates',
    onStart(worker) {
      worker0=worker;worker.state.updates??=new Map();worker.state.updateCursors??=new Map();worker.generateDailyUpdate=(options,meta)=>run(worker,options,meta);worker.updateScheduleInfo=()=>updateScheduleInfo(worker);
      for(const u of worker.state.updates.values()) if(['queued','running'].includes(u.state)) tx(worker,{op:'finish',update_id:u.id,state:'failed',error:{code:'interrupted',message:'worker stopped during generation; retry uses the frozen evidence'}});
      for(const r of worker.state.requests.values()) if(UPDATE_KINDS.has(r.kind)&&r.state==='applying') {const u=[...worker.state.updates.values()].find(x=>x.request_id===r.id);if(u&&['ready','partial'].includes(u.state)) finishRequest(worker,r,{update_id:u.id,state:u.state});else finishRequest(worker,r,null,error('interrupted','worker stopped during this update request'));}
    },
    tick(worker) {
      if(active&&[...active.requestIds].some(id=>worker.state.requests.get(id)?.state==='cancelled')) active.controller.abort('cancelled');
      for(const r of worker.state.requests.values()) if(UPDATE_KINDS.has(r.kind)&&r.state==='pending'&&(r.not_before??worker.now())<=worker.now()) {const promise=process(worker,r);if(promise) {pending.add(promise);promise.finally(()=>pending.delete(promise)).catch(()=>{});}}
    },
    async idle(){while(pending.size||active) await Promise.allSettled([...pending,...(active?.promise?[active.promise]:[])]);},
    async onStop(){if(active){active.controller.abort('interrupted');tx(worker0,{op:'finish',update_id:active.id,state:'failed',error:{code:'interrupted',message:'worker stopped during generation'}});}},
  };
}
