import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {saveUpdateSchedule,updateScheduleInfo} from '../../src/updates/schedule.js';import {normalizeSchedules} from '../../src/schedule/config.js';import {parseToml} from '../../src/config/toml.js';import {configPath} from '../../src/lib/paths.js';
test('Daily scheduling requires opt-in and preserves unrelated TOML through guarded atomic write',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'quill-update-config-'));const env={QUILL_HOME:home};const file=configPath(env);fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,'# owner comment\ncustom = "untouched"\n\n[[schedule]]\nname = "other"\njob = "reconcile"\nevery = "2h"\n');
 const worker={env,state:{meta:{timezone:'America/New_York'}},config:{schedule:[{name:'other',job:'reconcile',every:'2h'}]}};
 try {
  const before=updateScheduleInfo(worker);assert.equal(before.enabled,false);assert.equal(before.configured,false);
  const after=await saveUpdateSchedule(worker,{enabled:true,time:'18:00',expected_fingerprint:before.fingerprint});
  const config=parseToml(fs.readFileSync(file,'utf8'));assert.equal(config.custom,'untouched');assert.equal(config.schedule[0].name,'other');assert.equal(config.schedule[1].cron,'0 18 * * 0,1,2,3,4,5,6');assert.equal(after.timezone,'America/New_York');
  await assert.rejects(()=>saveUpdateSchedule(worker,{enabled:false,expected_fingerprint:before.fingerprint}),e=>e.code==='config-conflict');
  assert.equal(normalizeSchedules(config).schedules.find(s=>s.job==='daily-update').synthesis,false);
  assert.equal(normalizeSchedules({schedule:[{name:'daily-update',job:'daily-update',cron:'0 18 * * *'}]}).schedules[0].enabled,false);
 } finally {fs.rmSync(home,{recursive:true,force:true});}
});
