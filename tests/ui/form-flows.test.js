import test from 'node:test';
import assert from 'node:assert/strict';
import {renderDeploymentDialog, renderStatusDialog} from '../../ui/views/dialogs.js';
import {snapshot} from './fixtures.js';
import {syncDeploymentSelection,syncStatusDeploymentChoice} from '../../ui/lib/forms.js';
import {reviewCases} from './review-cases.mjs';
test('unselected obligations are excluded from native validation; selected single obligation remains required',()=>{
 const t=snapshot().tickets[5];
 const multiple={...t,deployments:[...t.deployments,{...t.deployments[0],id:'second',environment:'staging'}]};
 for(const mode of ['record','waive']) {
  const h=renderDeploymentDialog(multiple,{mode});
  assert.equal((h.match(/class="obligation-fields" disabled/g)||[]).length,2);
  assert.doesNotMatch(renderDeploymentDialog(t,{mode}),/class="obligation-fields" disabled/);
 }
 const fields={disabled:true}; const input={checked:true,matches:()=>true,closest:()=>({querySelector:()=>fields})};
 syncDeploymentSelection(input);assert.equal(fields.disabled,false);
 input.checked=false;syncDeploymentSelection(input);assert.equal(fields.disabled,true);
});
test('status deployment choice exposes and validates only the selected evidence mode',()=>{
 const fields=['record','waive'].map(value=>({dataset:{deploymentFields:value},disabled:true,hidden:true}));
 const input={name:'deployment_choice',value:'record',closest:()=>({querySelectorAll:()=>fields})};
 syncStatusDeploymentChoice(input);assert.deepEqual(fields.map(f=>f.disabled),[false,true]);
 input.value='waive';syncStatusDeploymentChoice(input);assert.deepEqual(fields.map(f=>f.hidden),[true,false]);
 input.value='leave';syncStatusDeploymentChoice(input);assert.ok(fields.every(f=>f.disabled&&f.hidden));
 assert.match(renderStatusDialog(snapshot().tickets[5],'done'),/data-deployment-fields="record" disabled hidden/);
});
test('every review fixture renders without missing titles or accidental undefined content',()=>{
 const cases=reviewCases(); assert.ok(cases.length>=120);assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
 for(const c of cases){assert.ok(c.html.length>20,c.id);if(c.kind==='dialog')assert.match(c.html,/id="dialog-title"/,c.id);assert.doesNotMatch(c.html,/>undefined</,c.id);}
});
test('review fixtures exercise populated evidence and distinct recovery controls',()=>{
 const cases=Object.fromEntries(reviewCases().map(c=>[c.id,c.html]));
 assert.match(cases['ticket-loaded-description'],/Recover interrupted sessions/);
 assert.doesNotMatch(cases['ticket-loaded-description'],/Missing description/);
 assert.match(cases['publish-session'],/Copy<\/button>/);
 assert.match(cases['memory-request-failed'],/data-action="retry-request"/);
 assert.match(cases['memory-request-conflict'],/revision 3/);
 for(const heading of ['Plan','Attempts','Verification','Critical changes','Learnings filed','Tools used','Environment']) assert.ok(cases['run-record-populated'].includes('<h3>'+heading),heading);
 assert.match(cases['run-test-failed'],/Expected: complete journal entry/);
 assert.match(cases['session-attach'],/name="bind" checked/);
 assert.match(cases['session-bound'],/name="bind" disabled/);
});
