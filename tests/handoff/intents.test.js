import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntentPayload } from '../../src/handoff/intents.js';
import { validateHandoffRequest } from '../../src/handoff/permissions.js';
import { createRecipeCatalog } from '../../src/agents/recipes.js';

const recipes = createRecipeCatalog({ env: { QUILL_HOME: '/nonexistent-quill-test' } });
function checked(payload, repo = null) {
  const p = resolveIntentPayload(payload, { repo, recipes });
  return validateHandoffRequest(p, { repo, recipe: recipes.builtin(p.recipe.name) });
}
test('intents resolve builtin contracts and source-free analysis without changing legacy requests', () => {
  for (const intent of ['read-only', 'plan']) {
    const p = checked({ intent, instructions: 'Investigate\nthis' });
    assert.equal(p.mode, 'analyse'); assert.equal(p.access, 'autonomous');
    assert.equal(p.permissions.read_source, false); assert.equal(p.legacy, false);
    assert.equal(p.instructions, 'Investigate\nthis');
  }
  const p = checked({ intent: 'auto' }, { id: 'repo' });
  assert.equal(p.mode, 'attempt-fix'); assert.equal(p.permissions.edit_source, true);
  assert.equal(p.permissions.commit, false); assert.equal(p.access, 'autonomous');
  assert.equal(checked({ intent: 'full' }, { id: 'repo' }).access, 'full');
  const legacy = { mode: 'analyse', note: 'old' };
  assert.deepEqual(resolveIntentPayload(legacy, { recipes }), legacy);
});
test('intent rejects forged templates, grants, limits and implicit full access', () => {
  for (const p of [
    { intent: 'plan', access: 'full' }, { intent: 'read-only', permissions: { edit_source: true } },
    { intent: 'plan', scopes: ['jira.write'] }, { intent: 'plan', recipe: { name: 'plan', source: 'repo' } },
    { intent: 'auto', recipe: 'analyse' }, { intent: 'auto', mode: 'analyse' },
    { intent: 'read-only', instructions: 'a'.repeat(4001) }, { intent: 'read-only', instructions: {} },
    { intent: 'surprise' }, { intent: '__proto__' }, { intent: 'plan', recipe: {name:'plan',source:'builtin',hash:'0'.repeat(64)} },
  ]) assert.throws(() => checked(p, { id: 'repo' }));
  assert.throws(() => checked({ intent: 'auto' }), { code: 'repo-required' });
  assert.throws(() => checked({ intent: 'auto', permissions: { push_branch: true } }, { id: 'repo' }), { code: 'permission-dependency' });
});
test('builtin intent cannot be shadowed by repository catalog resolution', () => {
  const p = resolveIntentPayload({ intent: 'plan' }, { recipes: { builtin: recipes.builtin, get() { throw Error('shadow read'); } } });
  assert.equal(p.recipe.source, 'builtin'); assert.equal(p.recipe.name, 'plan');
});

test('intent result application only proposes changes, including critical changes that legacy runs materialize', async t => {
  const { recordResult } = await import('../../src/handoff/results.js');
  const { reemitMissingCriticalProposals } = await import('../../src/handoff/critical-changes.js');
  const { getBlob } = await import('../../src/core/blobs.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'quill-intent-result-')); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const ticket={id:'t',key:'T-1',next_action:'Owner decision'};
  for (const intent of ['read-only','plan','auto','full']) {
    const h={id:'h',ticket_id:'t',intent,legacy:true,mode:'analyse',outputs:['next_action','blocker','description'],suggestions:[]};
    const events=[];
    const worker={env:{QUILL_HOME:home},state:{handoffs:new Map([['h',h]]),tickets:new Map([['t',ticket]])},now:()=> '2026-10-30T00:00:00Z',emit:(kind,payload)=>{events.push({kind,payload});Object.assign(h,payload.update);}};
    recordResult(worker,'h',{summary:'Investigated',next_action:'Agent decision',blocker:'Agent blocker',description:'Agent description',plan:['Inspect','Test'],critical_changes:[{title:'Deploy',scope:'k8s.write',action:'kubectl apply -f x'}]});
    assert.deepEqual(events[0].payload.result_items,[]);
    assert.equal(events.length,1); assert.equal(reemitMissingCriticalProposals(worker),0);
    assert.equal(h.suggestions.length,3);
    if (intent==='plan') { assert.equal(h.plan_revision,1); assert.match(getBlob(h.plan_ref,worker.env),/1\. Inspect/); }
  }
});

test('read-only and plan grants reject source writes, shell delivery and connector writes', async () => {
  const { run,call,bash,checkout }=await import('../gate/guard-fixture.js');
  for (const intent of ['read-only','plan']) {
    const checkedRequest=checked({intent},{id:'repo'});
    for (const request of [call('Write',{file_path:`${checkout}/src/a.js`,content:'x'}),bash('echo x > src/a.js'),bash('git commit -am x'),bash('git push origin feature'),call('mcp__github__create_issue',{title:'x'})]) {
      assert.equal(run(request,{grant:{permissions:checkedRequest.permissions,scopes:[]}}).decision,'deny',`${intent}: ${request.tool_name}`);
    }
  }
});

test('journal replay refuses legacy result_items for intent-based runs',async()=>{
  const {handleHandoffTx}=await import('../../src/core/reduce/requests.js');
  const ticket={id:'t',next_action:'Owner action',summary:'Owner summary'};
  const state={tickets:new Map([['t',ticket]]),handoffs:new Map([['h',{id:'h',ticket_id:'t',intent:'read-only',legacy:true,state:'running',base_next_action:'Owner action'}]])};
  handleHandoffTx(state,{payload:{handoff_id:'h',update:{result_ref:'abc'},result_items:[{type:'next-action',text:'Unexpected mutation'},{type:'child',id:'child',key:'T-2',title:'Unexpected child'}]},occurred_at:'2026-10-30T00:00:00Z'},{changed:new Set(),handoffsChanged:new Set()});
  assert.equal(ticket.next_action,'Owner action'); assert.equal(state.tickets.size,1);
});

test('intent lifecycle bookkeeping never closes ready tasks, while legacy run completion retains reconciliation',async()=>{
  const {newState,createTicket,ev}=await import('../core/helpers.js');
  const {randomUUID}=await import('node:crypto');
  const fixture=()=>{
    const state=newState(),parent=createTicket(state),child=createTicket(state,{id:randomUUID(),key:'C-1',parent_id:parent.id});
    parent.completion_mode='children';parent.completion_policy_seq=1;child.status='done';child.closed_sequence=2;child.blocks_parent=true;
    return {state,parent};
  };
  for(const intent of ['read-only','plan','auto','full',null]) {
    const {state,parent}=fixture();state.handoffs.set('h',{id:'h',ticket_id:parent.id,intent,state:'running'});
    ev(state,'handoff-tx',{handoff_id:'h',update:{state:'done'}},{producer:'worker'});
    assert.equal(parent.status,intent?'todo':'done',`${intent}: result bookkeeping`);
  }
  for(const type of ['handoff-create','handoff-cancel','run-plan-edit']) {
    const {state,parent}=fixture();const other=createTicket(state,{id:randomUUID(),key:'O-1'});
    const run={id:randomUUID(),ticket_id:other.id,intent:'plan',state:'queued',revision:1};state.handoffs.set(run.id,run);
    const req={id:randomUUID(),kind:type==='run-plan-edit'?'revise-run-plan':type==='handoff-cancel'?'handoff-cancel':'handoff',target_id:other.id,expected_revision:null,payload:{intent:'plan'},created_at:'2026-10-30T00:00:00Z',not_before:'2026-10-30T00:00:00Z',actor_id:'owner',body_hash:'x'};
    ev(state,'request',req,{producer:'worker'});
    const mutation=type==='handoff-create'?{type,handoff:{...run,id:randomUUID()}}:type==='handoff-cancel'?{type,handoff_id:run.id}:{type,handoff_id:run.id,fields:{plan_ref:'a'.repeat(64),plan_revision:2}};
    ev(state,'request-tx',{request_id:req.id,outcome:'applied',mutation},{producer:'worker'});
    assert.equal(parent.status,'todo',`${type}: unrelated ready task`);
  }
});
