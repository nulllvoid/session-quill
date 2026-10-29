import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRunAgentDialog, intentPayload } from '../../ui/views/run-dialog.js';
import { snapshot } from './fixtures.js';
test('general composer has four modes, read-only default and reachable close/cancel', () => {
 const s=snapshot(), h=renderRunAgentDialog(s.tickets[0],s);
 for(const mode of ['read-only','plan','auto','full']) assert.match(h,new RegExp(`name="intent" value="${mode}"`));
 assert.match(h,/value="read-only" checked/); assert.doesNotMatch(h,/value="full" checked/);
 assert.match(h,/aria-label="Close Run agent"/); assert.match(h,/data-action="close-dialog">Cancel/);
 assert.match(h,/name="instructions"[\s\S]*maxlength="4000"/);
});
test('intent submission defaults to no publishing and does not remember full access', () => {
 const f=new FormData(); f.set('intent','auto'); f.set('instructions','Fix only the test');
 assert.deepEqual(intentPayload(f), {intent:'auto',instructions:'Fix only the test',permissions:{commit:false,push_branch:false,open_draft_pr:false}});
 f.set('intent','read-only'); f.set('commit','on'); assert.equal(intentPayload(f).permissions.commit,false);
});
test('source-free read-only and Plan remain available; Auto preflight explains missing repository', () => {
 const s=snapshot({repos:[]}), t={...s.tickets[0],repo_id:null};
 const h=renderRunAgentDialog(t,s); assert.match(h,/Read only/); assert.match(h,/Plan/); assert.match(h,/Auto needs a local repository/);
});
test('plan execution requires an exact revision and explicit review, with owner edits separate', async () => {
 const { renderPlanReview }=await import('../../ui/views/plan-review.js');
 const h=renderPlanReview({source_plan_run_id:'r',source_plan_revision:3,source_plan_ref:'a'.repeat(64),reviewed_base_commit:'b'.repeat(40),context_changed:true,current_context:{title:'new'},original_context:{title:'old'}},'<danger>',snapshot().tickets[0]);
 assert.match(h,/Plan revision 3/); assert.match(h,/name="reviewed" required/); assert.match(h,/data-form="revise-plan"/); assert.match(h,/data-form="execute-plan"/); assert.match(h,/&lt;danger&gt;/); assert.match(h,/context.*changed/i); assert.doesNotMatch(h,/value="full" checked/);
});
test('publishing includes an explicit destination branch; non-publishing requests omit it', () => {
 const fd=new FormData(); fd.set('intent','auto'); fd.set('commit','on'); fd.set('push_branch','on'); fd.set('branch',' feat/reviewed-fix ');
 assert.equal(intentPayload(fd).branch,'feat/reviewed-fix'); fd.delete('push_branch'); assert.equal(intentPayload(fd).branch,undefined);
});
test('changed plan review displays actual manifests rather than their metadata references', async () => {
 const {renderPlanReview}=await import('../../ui/views/plan-review.js'); const h=renderPlanReview({source_plan_revision:1,context_changed:true,current_context:{manifest_ref:'current-ref'},original_context:{manifest_ref:'old-ref'},current_manifest:{goal:'current goal',children:['new child']},original_manifest:{goal:'old goal',children:['old child']}},'plan',snapshot().tickets[0]);
 assert.match(h,/current goal/); assert.match(h,/new child/); assert.match(h,/old goal/); assert.doesNotMatch(h,/current-ref/);
});
test('PR delivery uses the projection provider capability and respects explicit false', () => {
 const base=snapshot(); const repo={...base.repos[0],provider_configured:true}; delete repo.provider;
 assert.match(renderRunAgentDialog(base.tickets[0],{...base,repos:[repo]}),/data-has-provider="true"/);
 assert.match(renderRunAgentDialog(base.tickets[0],{...base,repos:[{...repo,provider_configured:false,provider:'github'}]}),/data-has-provider="false"/);
});
