import test from 'node:test';
import assert from 'node:assert/strict';
import {handleUpdateTx} from '../../src/core/reduce/updates.js';
const state=()=>({updates:new Map(),updateCursors:new Map()});
const emit=(s,p)=>handleUpdateTx(s,{payload:p,occurred_at:'2026-10-30T18:00:00.000Z'});
const update=(id='a',end='2026-10-30T18:00:00.000Z')=>({id,input_ref:'input',source_sequence:10,window_end:end,cursor_key:'key',contributes:true,coverage:{state:'complete'}});
const finish=(id='a',end='2026-10-30T18:00:00.000Z',status='ready')=>({op:'finish',update_id:id,state:status,content_ref:'content',cursor:{through_at:end,source_sequence:10,evidence_ids:['ev']}});
test('ready and cursor commit together; partial, failure, duplicates and older output never move cursor',()=>{
 const s=state();emit(s,{op:'create',update:update()});emit(s,finish());assert.equal(s.updateCursors.get('key').update_id,'a');
 emit(s,{op:'create',update:update('older','2026-10-29T18:00:00.000Z')});emit(s,finish('older','2026-10-29T18:00:00.000Z'));assert.equal(s.updateCursors.get('key').update_id,'a');
 emit(s,{op:'create',update:update('partial','2026-10-31T18:00:00.000Z')});emit(s,finish('partial','2026-10-31T18:00:00.000Z','partial'));assert.equal(s.updateCursors.get('key').update_id,'a');
 assert.deepEqual(emit(s,finish()),{duplicate:true});
});
test('owner edits preserve the original and prior annotations; conflicts reject',()=>{
 const s=state();emit(s,{op:'create',update:update()});emit(s,finish());
 emit(s,{op:'edit',update_id:'a',expected_revision:1,content_ref:'edit1'});emit(s,{op:'edit',update_id:'a',expected_revision:2,content_ref:'edit2'});
 assert.equal(s.updates.get('a').content_ref,'content');assert.equal(s.updates.get('a').revisions[1].owner_edit_ref,'edit1');
 assert.equal(emit(s,{op:'edit',update_id:'a',expected_revision:1,content_ref:'bad'}).rejected,'revision-conflict');
});
