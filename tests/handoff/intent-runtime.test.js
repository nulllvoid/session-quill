import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bootWorker, makeRepo, git, until, T1 } from './helpers.js';
import { resolveIntentPayload } from '../../src/handoff/intents.js';
import { validateHandoffRequest } from '../../src/handoff/permissions.js';
import { catalogFor } from '../../src/agents/recipes.js';
import { getBlob, putBlob } from '../../src/core/blobs.js';
import { capturePlanContext, planReview, validatePlanExecution } from '../../src/handoff/plans.js';

function queue(b,ticket,payload,extra={}) {
  const repo=ticket.repo_id ? {id:ticket.repo_id,...b.config.repos[ticket.repo_id]} : null;
  const recipes=catalogFor(b.w),p=resolveIntentPayload(payload,{repo,recipes}),recipe=recipes.builtin(p.recipe.name);
  const checked=validateHandoffRequest(p,{repo,recipe});
  const h={...checked,id:randomUUID(),ticket_id:ticket.id,repo_id:ticket.repo_id,recipe:p.recipe,state:'queued',requested_at:b.iso(),revision:1,outputs:recipe.outputs,suggestions:[],...extra};
  b.w.state.handoffs.set(h.id,h);
  return h;
}
const terminal=async(b,id)=>until(()=>{b.w.tick(); const h=b.w.state.handoffs.get(id); return ['done','failed','cancelled','timed-out'].includes(h?.state)?h:null;});

test('ticket-context Plan dispatch saves baseline and owner artifact without applying agent fields',async()=>{
  const b=await bootWorker({runtimeAvailable:true,withServer:false,fakeEnv:{FAKE_CLAUDE_RESULT:JSON.stringify({summary:'Objective: fix retry. Files: src.js. Assumptions: timer issue. Verification: node --test. Done when retry passes.',plan:['Inspect timer','Add regression and fix'],next_action:'Agent next',blocker:'Agent blocker'})}});
  try {
    const ticket=b.ticket(T1,'LOCAL-a-00000001',{repo_id:null,next_action:'Owner next'});
    const child=b.ticket(randomUUID(),'LOCAL-child-00000001',{repo_id:null,parent_id:ticket.id});
    ticket.completion_mode='children'; ticket.completion_policy_seq=1;
    child.blocks_parent=true; child.status='done'; child.closed_sequence=2;
    const h=queue(b,ticket,{intent:'plan',instructions:'Investigate retry without editing'});
    const done=await terminal(b,h.id);
    assert.equal(done.state,'done',JSON.stringify(done.error));
    assert.equal(ticket.status,'todo','Plan completion does not close its ready parent ticket');
    assert.equal(done.intent,'plan'); assert.equal(done.legacy,false);
    assert.equal(done.plan_revision,1); assert.equal(done.plan_context.base_commit,null);
    assert.match(getBlob(done.plan_ref,b.env),/Add regression and fix/);
    assert.equal(b.w.state.tickets.get(T1).next_action,'Owner next');
    assert.notEqual(b.w.state.tickets.get(T1).blocker,'Agent blocker');
    assert.equal(planReview(b.w.state,b.w.state.tickets.get(T1),done,{env:b.env}).context_changed,false,'run completion does not invalidate its own baseline');
  } finally {await b.w.stop();fs.rmSync(b.home,{recursive:true,force:true});}
});

test('reviewed plan uses immutable content and pinned checkout after source revision and HEAD move',async()=>{
  const repo=makeRepo(); const b=await bootWorker({repo,runtimeAvailable:true,withServer:false});
  try {
    const ticket=b.ticket(T1,'LOCAL-a-00000001');
    const source={id:randomUUID(),ticket_id:T1,repo_id:'demo',intent:'plan',state:'done',plan_ref:putBlob('Execute the original reviewed plan.',b.env).hash,plan_revision:1,plan_context:capturePlanContext(b.w.state,ticket,{env:b.env,baseCommit:repo.head})};
    b.w.state.handoffs.set(source.id,source);
    const opts={env:b.env,repo:{id:'demo',...b.config.repos.demo}};
    const review=planReview(b.w.state,ticket,source,opts);
    const frozen=validatePlanExecution(b.w.state,ticket,{intent:'auto',...review},opts);
    source.plan_ref=putBlob('Different scope never approved.',b.env).hash;source.plan_revision++;
    git(repo.dir,'commit','--allow-empty','-qm','HEAD advances');
    const h=queue(b,ticket,{intent:'auto',instructions:'Implement reviewed plan'},frozen);
    const done=await terminal(b,h.id);
    assert.equal(done.state,'done',JSON.stringify(done.error));
    assert.equal(done.base_commit,repo.head);assert.equal(getBlob(done.source_plan_ref,b.env),'Execute the original reviewed plan.');
    assert.notEqual(git(repo.dir,'rev-parse','HEAD'),done.base_commit);
  } finally {await b.w.stop();fs.rmSync(b.home,{recursive:true,force:true});fs.rmSync(repo.dir,{recursive:true,force:true});}
});

test('queued semantic changes fail before runtime starts',async()=>{
  const repo=makeRepo();const b=await bootWorker({repo,runtimeAvailable:true,withServer:false});
  try {
    const ticket=b.ticket(T1,'LOCAL-a-00000001');
    const source={id:randomUUID(),ticket_id:T1,repo_id:'demo',intent:'plan',state:'done',plan_ref:putBlob('Plan',b.env).hash,plan_revision:1,plan_context:capturePlanContext(b.w.state,ticket,{env:b.env,baseCommit:repo.head})};
    b.w.state.handoffs.set(source.id,source);
    const opts={env:b.env,repo:{id:'demo',...b.config.repos.demo}};
    const frozen=validatePlanExecution(b.w.state,ticket,{intent:'auto',...planReview(b.w.state,ticket,source,opts)},opts);
    const h=queue(b,ticket,{intent:'auto'},frozen);ticket.next_action='A materially different objective';
    const done=await terminal(b,h.id);
    assert.equal(done.state,'failed');assert.equal(done.error.code,'plan-context-changed');
    assert.equal(done.started_at,undefined);assert.equal(done.worktree_path,undefined);
  } finally {await b.w.stop();fs.rmSync(b.home,{recursive:true,force:true});fs.rmSync(repo.dir,{recursive:true,force:true});}
});
