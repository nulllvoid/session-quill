import test from 'node:test'; import assert from 'node:assert/strict';
import { renderUpdates, updateScope } from '../../ui/views/updates.js';
import { snapshot } from './fixtures.js';
test('Daily defaults to workspace 24 hours and remains a local draft', () => { const h=renderUpdates(null,snapshot()); assert.match(h,/Last 24 hours/); assert.match(h,/Whole workspace/); assert.match(h,/Generate now/); assert.match(h,/local draft/i); assert.match(h,/18:00/); assert.doesNotMatch(h,/Send update/); });
test('sharing needs a separately regenerated preview and never copies private content', () => { const h=renderUpdates({updates:[{id:'u',state:'ready',window_kind:'today',revision:1}]},snapshot(),{selected:{id:'u',state:'ready',content:'Private secret',revision:1}}); assert.match(h,/Private secret/); assert.match(h,/Copy for sharing/); assert.doesNotMatch(h,/data-copy="Private secret/); });
test('scope is explicit and does not inherit global filters', () => { assert.deepEqual(updateScope('repo:demo'),{project_ids:[],repo_ids:['demo']}); assert.deepEqual(updateScope(''),{project_ids:[],repo_ids:[]}); });
test('static snapshots do not expose owner Daily content or controls', () => { const h=renderUpdates({updates:[{content:'secret'}]},snapshot({meta:{exported_at:'now'}})); assert.doesNotMatch(h,/secret|Generate now/); });
test('untrusted generated text renders safely with continuity collapsed', async () => {
 const {updateMarkup}=await import('../../ui/views/updates.js'); const h=updateMarkup('# Daily update\n## Parent\n- fact [event-1]\n<details><summary>Earlier milestones and continuity</summary>\n<script>bad()</script>\n</details>');
 assert.match(h,/data-disclosure="update-continuity-0"/); assert.doesNotMatch(h,/<details[^>]* open|<script>/); assert.match(h,/&lt;script&gt;/); assert.match(h,/<li>fact \[event-1\]<\/li>/);
});
test('history shows its full total and explicit older/newer page controls', () => {
 const h=renderUpdates({updates:[{id:'u',state:'ready'}],offset:50,limit:50,total:103},snapshot());
 assert.match(h,/Update history \(103\)/); assert.match(h,/data-offset="0">Newer updates/); assert.match(h,/data-offset="100">Older updates/);
});
test('Daily schedule exposes next run, latest scheduled result and explicit first-time setup', () => {
 const s=snapshot({schedules:[{name:'daily-update',last_outcome:'failed',last_finished_at:'2026-10-30T12:30:00Z',last_error:'Sources unavailable'}]});
 const h=renderUpdates({updates:[],schedule:{configured:true,enabled:true,next_run:'2026-10-31T12:30:00Z'}},s);
 assert.match(h,/Next run:.*2026-10-31T12:30:00Z/); assert.match(h,/Latest result:.*failed/); assert.match(h,/Sources unavailable/);
 const setup=renderUpdates({updates:[],schedule:{configured:false,enabled:false}},snapshot()); assert.match(setup,/data-action="configure-update-schedule"/); assert.match(setup,/Configure daily updates/); assert.doesNotMatch(setup,/name="enabled" checked/);
});
