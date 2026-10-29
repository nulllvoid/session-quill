import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { putBlob, getBlob } from '../../src/core/blobs.js';
import { capturePlanContext, planReview, validatePlanExecution, validatePlanDispatch, reviseRunPlan } from '../../src/handoff/plans.js';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-plan-')); t.after(() => fs.rmSync(home,{recursive:true,force:true}));
  const env = { QUILL_HOME: home };
  const ticket = { id:'t',revision:1,summary:'Goal: X',status:'todo',next_action:'Fix',repo_id:null };
  const state = { tickets:new Map([['t',ticket]]),handoffs:new Map(),lastSequence:12 };
  const run = { id:'h',ticket_id:'t',intent:'plan',state:'done',plan_ref:putBlob('The plan',env).hash,plan_revision:1,repo_id:null,plan_context:capturePlanContext(state,ticket,{env}) };
  state.handoffs.set(run.id,run);
  return { env,ticket,state,run };
}
test('plan semantic baseline ignores lifecycle revision/timestamps but detects child and evidence changes', t => {
  const f=fixture(t); const a=planReview(f.state,f.ticket,f.run,{env:f.env});
  f.ticket.revision++; f.ticket.updated_at='later'; f.state.lastSequence++;
  assert.equal(planReview(f.state,f.ticket,f.run,{env:f.env}).context_changed,false);
  f.ticket.next_action='Different scope';
  assert.equal(planReview(f.state,f.ticket,f.run,{env:f.env}).context_changed,true);
  assert.notEqual(planReview(f.state,f.ticket,f.run,{env:f.env}).reviewed_context_fingerprint,a.reviewed_context_fingerprint);
});
test('plan execution binds exact revision and immutable context; later source edit does not retarget dispatch', t => {
  const f=fixture(t), opts={env:f.env};
  const review=planReview(f.state,f.ticket,f.run,opts);
  const fields=validatePlanExecution(f.state,f.ticket,{intent:'auto',...review},opts);
  Object.assign(f.run,reviseRunPlan(f.state,f.ticket,{handoff_id:'h',expected_plan_revision:1,text:'Revised'},opts));
  assert.equal(f.run.plan_revision,2); assert.equal(getBlob(fields.source_plan_ref,f.env),'The plan');
  assert.doesNotThrow(()=>validatePlanDispatch(f.state,f.ticket,fields,opts));
  assert.throws(()=>validatePlanExecution(f.state,f.ticket,{intent:'auto',...review},opts),{code:'plan-revision-conflict'});
  f.ticket.blocker='New blocker';
  assert.throws(()=>validatePlanDispatch(f.state,f.ticket,fields,opts),{code:'plan-context-changed'});
});
test('plan ownership, missing blobs, stale edits and reviewed context are validated', t => {
  const f=fixture(t), opts={env:f.env};
  assert.throws(()=>reviseRunPlan(f.state,f.ticket,{handoff_id:'h',expected_plan_revision:2,text:'x'},opts),{code:'plan-revision-conflict'});
  assert.throws(()=>reviseRunPlan(f.state,f.ticket,{handoff_id:'h',expected_plan_revision:1,text:'x'.repeat(20001)},opts),{code:'plan-text-invalid'});
  const review=planReview(f.state,f.ticket,f.run,opts);
  f.ticket.status='blocked';
  assert.throws(()=>validatePlanExecution(f.state,f.ticket,{intent:'auto',...review},opts),{code:'plan-context-changed'});
  assert.throws(()=>planReview(f.state,{id:'other'},f.run,opts),{code:'plan-unknown'});
});

test('review compares current git base, while accepted execution pins the reviewed commit after HEAD moves', async t => {
  const { makeRepo,git }=await import('./helpers.js');
  const { planBaseCommit }=await import('../../src/handoff/plans.js');
  const f=fixture(t), repo=makeRepo(); t.after(()=>fs.rmSync(repo.dir,{recursive:true,force:true}));
  const cfg={id:'repo',canonical_path:repo.dir}; f.ticket.repo_id='repo'; f.run.repo_id='repo';
  f.run.plan_context=capturePlanContext(f.state,f.ticket,{env:f.env,baseCommit:repo.head});
  const review=planReview(f.state,f.ticket,f.run,{env:f.env,repo:cfg});
  const accepted=validatePlanExecution(f.state,f.ticket,{intent:'auto',...review},{env:f.env,repo:cfg});
  git(repo.dir,'commit','--allow-empty','-qm','new HEAD');
  assert.notEqual(planBaseCommit(f.ticket,cfg),repo.head);
  const current=planReview(f.state,f.ticket,f.run,{env:f.env,repo:cfg});
  assert.equal(current.base_changed,true); assert.equal(current.context_changed,false);
  assert.equal(accepted.reviewed_base_commit,repo.head);
  assert.doesNotThrow(()=>validatePlanDispatch(f.state,f.ticket,accepted,{env:f.env}));
  assert.throws(()=>validatePlanExecution(f.state,f.ticket,{intent:'auto',...review},{env:f.env,repo:cfg}),{code:'plan-context-changed'});
});

test('nested required changes invalidate review; independent tasks and observation timestamps do not',t=>{
  const f=fixture(t),opts={env:f.env};
  const child={id:'child',parent_id:'t',blocks_parent:true,status:'done'};
  const nested={id:'nested',parent_id:'child',blocks_parent:true,status:'done'};
  f.state.tickets.set('child',child); f.state.tickets.set('nested',nested);
  f.ticket.prs=[{id:'pr',state:'open',head_sha:'abc',observed_at:'before'}];
  f.run.plan_context=capturePlanContext(f.state,f.ticket,opts);
  f.ticket.prs[0].observed_at='after';
  f.state.tickets.set('independent',{id:'independent',parent_id:'t',blocks_parent:false,status:'todo'});
  assert.equal(planReview(f.state,f.ticket,f.run,opts).context_changed,false);
  nested.status='todo';
  assert.equal(planReview(f.state,f.ticket,f.run,opts).context_changed,true);
});
