import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWindow, buildEvidenceBundle, normalizeScope, cursorKey } from '../../src/updates/evidence.js';
import { renderUpdate, validateNarrative } from '../../src/updates/generate.js';
const state = () => ({meta:{timezone:'UTC'},lastSequence:10,tickets:new Map(),handoffs:new Map(),sessions:new Map(),memory:{entries:new Map()},providerHealth:[]});
const ticket = (id, fields={}) => ({id,key:id,title:id,status:'active',created_at:'2026-09-01T00:00:00.000Z',timeline:[],...fields});
test('calendar days and rolling hours have different DST bounds',()=>{
 const now='2026-11-02T12:00:00.000Z';
 const yesterday=resolveWindow({window_kind:'yesterday'}, {now,timezone:'America/New_York'});
 assert.equal(yesterday.window_start,'2026-11-01T04:00:00.000Z'); assert.equal(yesterday.window_end,'2026-11-02T05:00:00.000Z');
 const rolling=resolveWindow({window_kind:'last-24-hours'},{now,timezone:'America/New_York'});
 assert.equal(Date.parse(rolling.window_end)-Date.parse(rolling.window_start),86400000);
});
test('seven-week context, dedupe, carryover, late evidence and no self-summary',()=>{
 const s=state(); s.tickets.set('p',ticket('p',{summary:'Goal: migration\nDone when: verified'}));
 s.tickets.set('c',ticket('c',{parent_id:'p',timeline:[
 {id:'a',event_id:'a',at:'2026-10-28T21:00:00.000Z',kind:'commit',text:'Commit abcdef1234: change'},
 {id:'b',event_id:'b',at:'2026-10-28T21:00:00.000Z',kind:'commit',text:'Commit abcdef1234: change'},
 {id:'late',event_id:'late',at:'2026-10-01T12:00:00.000Z',kind:'status',text:'Status set to review'},
 ]}));
 const bundle=buildEvidenceBundle(s,{window:resolveWindow({window_kind:'today'},{now:'2026-10-29T18:00:00.000Z',timezone:'UTC',scheduled:true,cursor:{through_at:'2026-10-28T18:00:00.000Z',source_sequence:5,evidence_ids:[]}}),eventSequences:new Map([['a',4],['b',5],['late',9]])});
 assert.equal(bundle.facts.filter(f=>f.kind==='commit').length,1); assert.equal(bundle.facts.find(f=>f.kind==='commit').section,'carryover');
 assert.equal(bundle.facts.find(f=>f.source_ref==='late').section,'late'); assert.equal(bundle.groups[0].observed_since,'2026-09-01T00:00:00.000Z');
 assert.match(renderUpdate(bundle),/Newly recorded earlier work/); assert.match(renderUpdate(bundle),/Unreported work/);
});
test('sharing rebuilds eligible facts without private names, paths, memory or hidden counts',()=>{
 const s=state(); s.tickets.set('p',ticket('p',{title:'Public',next_action:'Inspect /Users/private/secret'})); s.tickets.set('secret',ticket('secret',{parent_id:'p',local_only:true,title:'Secret project'}));
 s.memory.entries.set('m',{id:'m',scope:'task',scope_id:'p',trust:'owner',state:'active',text:'Secret memory'});
 const b=buildEvidenceBundle(s,{window:resolveWindow({}, {now:'2026-10-29T18:00:00.000Z',timezone:'UTC'}),share:true});
 const out=renderUpdate(b); assert.doesNotMatch(out,/Secret|\/Users|secret|2 required/); assert.match(out,/shared tasks only/);
});
test('narrative cannot invent claims with valid citations',()=>{
 const b={facts:[{id:'e1',text:'Run failed',trust:'worker',kind:'run'}]};
 assert.throws(()=>validateNarrative({claims:[{evidence_ids:['e1'],text:'Everything delivered'}]},b),/unsupported/);
 assert.throws(()=>validateNarrative({claims:[{evidence_ids:['fake'],text:'Run failed'}]},b),/unknown/);
 assert.deepEqual(validateNarrative({claims:[{evidence_ids:['e1'],text:'Run failed'}]},b),['Run failed [e1]']);
});
test('scope identity is stable and rejects ambiguous input',()=>{
 assert.equal(cursorKey(normalizeScope({repo_ids:['b','a','b']}),'UTC'),cursorKey(normalizeScope({repo_ids:['a','b']}),'UTC'));
 assert.throws(()=>normalizeScope({repo_ids:'all'}));
});

test('empty midnight and equal continuity cutoff are valid; timestamp precision preserves half-open bounds',()=>{
 const window=resolveWindow({window_kind:'today'},{now:'2026-10-30T00:00:00Z',timezone:'UTC'});assert.equal(window.window_start,window.window_end);
 const empty=resolveWindow({window_kind:'since-last'},{now:'2026-10-30T00:00:00Z',timezone:'UTC',cursor:{through_at:'2026-10-30T00:00:00Z',source_sequence:0}});assert.equal(empty.window_start,empty.window_end);
 const s=state();s.tickets.set('p',ticket('p',{timeline:[{id:'at',event_id:'at',at:'2026-10-30T12:00:00Z',kind:'status',text:'At cutoff'}]}));
 const b=buildEvidenceBundle(s,{window:resolveWindow({window_kind:'custom',window_start:'2026-10-29T00:00:00Z',window_end:'2026-10-30T12:00:00.000Z'},{now:'2026-10-30T18:00:00Z'})});assert.equal(b.facts.length,0);
});

test('done required conflicts remain visible in the same canonical closure state as Work',()=>{
 const s=state();s.tickets.set('p',ticket('p',{status:'done'}));s.tickets.set('c',ticket('c',{parent_id:'p',blocks_parent:true,status:'done'}));s.tickets.set('g',ticket('g',{parent_id:'c',blocks_parent:true,status:'active'}));
 const b=buildEvidenceBundle(s,{window:resolveWindow({}, {now:'2026-10-30T18:00:00Z'})});assert.equal(b.groups[0].closure_state,'needs-review');assert.deepEqual(b.groups[0].remaining.map(t=>t.ticket_id),['c','g']);
});
test('actual provider health, capture gaps, and conflicting/aged memory retain explicit uncertainty',()=>{
 const s=state();s.tickets.set('p',ticket('p'));s.providerHealth=[{provider:'github',last_success_at:'2026-10-01T00:00:00Z',error:'offline'}];s.sessions.set('s',{id:'s',ticket_ids:['p'],last_event_at:'2026-10-30T12:00:00Z',change_coverage:'unknown',capture_health:{status:'degraded',reason:'missing'}});
 for(const [id,text] of [['a','one'],['b','two']])s.memory.entries.set(id,{id,scope:'task',ticket_id:'p',key:'decision',text,state:'active',trust:'sourced',created_at:'2026-01-01T00:00:00Z',last_confirmed_at:'2026-10-20T00:00:00Z'});
 s.memory.entries.set('q',{id:'q',scope:'task',ticket_id:'p',text:'Secret instruction',state:'active',trust:'quarantined'});
 const b=buildEvidenceBundle(s,{window:resolveWindow({}, {now:'2026-10-30T18:00:00Z'})});assert.equal(b.coverage.state,'partial');assert.ok(b.coverage.omissions.some(x=>x.kind==='provider-stale'));assert.ok(b.coverage.omissions.some(x=>x.kind==='capture-gap'));assert.equal(b.groups[0].context.filter(c=>c.text.startsWith('Uncertain memory')).length,2);assert.doesNotMatch(renderUpdate(b),/Secret instruction/);
});

test('shared completion cannot reveal conflicts caused only by omitted private descendants',()=>{
 const s=state();s.tickets.set('p',ticket('p',{title:'Public',status:'active'}));s.tickets.set('c',ticket('c',{title:'Public completed child',parent_id:'p',blocks_parent:true,status:'done'}));s.tickets.set('secret',ticket('secret',{title:'Private child',parent_id:'c',blocks_parent:true,status:'active',local_only:true}));
 const b=buildEvidenceBundle(s,{share:true,window:resolveWindow({}, {now:'2026-10-30T18:00:00Z'})});assert.deepEqual(b.groups[0].remaining,[]);assert.doesNotMatch(renderUpdate(b),/Private child|needs-review/);
});

test('missing source blobs and bounded evidence never claim complete coverage',()=>{
 const s=state();s.tickets.set('p',ticket('p',{timeline:[{id:'a',event_id:'a',at:'2026-10-30T10:00:00Z',kind:'plan',text:'Approved plan',content_ref:'missing'},{id:'b',event_id:'b',at:'2026-10-30T11:00:00Z',kind:'status',text:'Review'}]}));
 const checked=[];const options={window:resolveWindow({}, {now:'2026-10-30T18:00:00Z'}),hasContent:ref=>{checked.push(ref);return false;}};
 const b=buildEvidenceBundle(s,{...options,maxFacts:1});assert.equal(b.coverage.state,'partial');assert.deepEqual(b.coverage.omissions.map(x=>x.kind),['budget']);assert.deepEqual(checked,[],'omitted history does not load source blobs');
 const full=buildEvidenceBundle(s,options);assert.equal(full.coverage.state,'partial');assert.deepEqual(full.coverage.omissions.map(x=>x.kind),['missing-content']);assert.deepEqual(checked,['missing']);
});
test('sharing removes Windows drive, UNC and internal URI locations',()=>{
 const s=state();s.tickets.set('p',ticket('p',{summary:String.raw`Config C:/Company/forward.txt and C:\Company\confidential.txt and \\internal-server\secret-share\document and quill://store/private`}));
 const options={window:resolveWindow({}, {now:'2026-10-30T18:00:00Z'})};
 assert.match(renderUpdate(buildEvidenceBundle(s,options)),/Company/);
 assert.doesNotMatch(renderUpdate(buildEvidenceBundle(s,{...options,share:true})),/Company|forward.txt|confidential|internal-server|secret-share|quill:\/\//);
});

test('direct full commit capture and legacy shortened attachment have one repository-scoped identity',()=>{
 const sha='abcdef1234'+'1'.repeat(30),s=state();
 const direct={id:'direct',event_id:'capture',at:'2026-10-30T10:00:00Z',kind:'commit',text:`Commit ${sha.slice(0,10)}: fix`};
 const attached={id:'attached',event_id:'attach',at:'2026-10-30T12:00:00Z',kind:'commit',text:`Commit ${sha.slice(0,10)}: fix (attached)`};
 // Attachment comes first in traversal: normalization must not depend on ticket iteration order.
 s.tickets.set('a',ticket('a',{repo_id:'repo',timeline:[attached]}));s.tickets.set('b',ticket('b',{repo_id:'repo',timeline:[direct]}));
 const events=new Map([['capture',{event_id:'capture',kind:'post-tool',ticket_id:'b',sequence:2,payload:{repo_id:'repo',commit:{sha}}}],['attach',{event_id:'attach',kind:'request-tx',sequence:8,payload:{mutation:{type:'unbound-attach',ticket_id:'a'}}}]]);
 const b=buildEvidenceBundle(s,{events,window:resolveWindow({}, {now:'2026-10-30T18:00:00Z'})});
 assert.deepEqual(b.facts.filter(f=>f.kind==='commit').map(f=>f.source_id),[`commit:repo:${sha}`]);
 const earlier=buildEvidenceBundle(s,{events,window:resolveWindow({window_kind:'custom',window_start:'2026-10-30T00:00:00Z',window_end:'2026-10-30T11:00:00Z'}, {now:'2026-10-30T18:00:00Z'})});
 assert.equal(earlier.facts.filter(f=>f.kind==='commit').length,1,'a later copy cannot hide the earlier in-window source');
 const later=buildEvidenceBundle(s,{events,window:resolveWindow({window_kind:'since-last'}, {now:'2026-10-30T18:00:00Z',cursor:{through_at:'2026-10-30T11:00:00Z',source_sequence:3,evidence_ids:[`commit:repo:${sha}`]}})});
 assert.equal(later.facts.filter(f=>f.kind==='commit'&&f.section!=='context').length,0,'a newly attached copy is not new or late progress');
 const legacyCursor=buildEvidenceBundle(s,{events,window:resolveWindow({window_kind:'since-last'}, {now:'2026-10-30T18:00:00Z',cursor:{through_at:'2026-10-30T11:00:00Z',source_sequence:3,evidence_ids:[`commit:repo:${sha.slice(0,10)}`]}})});
 assert.equal(legacyCursor.facts.filter(f=>f.kind==='commit'&&f.section!=='context').length,0,'unique old short cursor entries upgrade to the same canonical identity');
});
test('short commit resolution is repository-local and ambiguous prefixes never merge known distinct commits',()=>{
 const prefix='abcdef1234',first=prefix+'1'.repeat(30),second=prefix+'2'.repeat(30),s=state();
 const row=(id,sha,explicit=false)=>({id,event_id:id,at:'2026-10-30T12:00:00Z',kind:'commit',text:`Commit ${sha.slice(0,10)}: fix (attached)`,...(explicit?{commit_sha:sha}:{})});
 s.tickets.set('a',ticket('a',{repo_id:'repo',timeline:[row('one',first,true),row('two',second,true),row('legacy',prefix)]}));
 s.tickets.set('b',ticket('b',{repo_id:'other',timeline:[row('other',prefix)]}));
 const b=buildEvidenceBundle(s,{window:resolveWindow({}, {now:'2026-10-30T18:00:00Z'})});
 assert.ok(b.facts.some(f=>f.source_id===`commit:repo:${first}`));assert.ok(b.facts.some(f=>f.source_id===`commit:repo:${second}`));
 assert.ok(b.facts.some(f=>f.source_id===`commit:other:${prefix}`));assert.equal(b.facts.length,4);assert.equal(b.coverage.state,'partial');assert.ok(b.coverage.omissions.some(x=>x.kind==='commit-identity-ambiguous'));
});

test('capture reducer preserves full commit identity through direct and unbound attachment paths',async()=>{
 const {newState,createTicket,ev,bind,resetSeq}=await import('../core/helpers.js');resetSeq();const s=newState(),t=createTicket(s),sha='abcdef1234'+'1'.repeat(30);
 const capture=(session,call)=>{
  ev(s,'pre-tool',{tool_name:'Bash'},{session_id:session,tool_call_id:call});
  ev(s,'post-tool',{tool_name:'Bash',repo_id:'original-repo',commit:{sha},success:true},{session_id:session,tool_call_id:call});
 };
 bind(s,'bound',t.id);capture('bound','direct');ev(s,'session-start',{}, {session_id:'unbound'});capture('unbound','loose');
 const request='00000000-0000-4000-8000-000000000001';ev(s,'request',{id:request,kind:'attach-unbound',payload:{}});
 ev(s,'request-tx',{request_id:request,outcome:'applied',mutation:{type:'unbound-attach',session_id:s.sessions.get('unbound').id,ticket_id:t.id,bind:false}});
 const commits=t.timeline.filter(e=>e.kind==='commit');assert.equal(commits.length,2);assert.deepEqual(commits.map(e=>e.commit_sha),[sha,sha]);assert.deepEqual(commits.map(e=>e.commit_repo_id),['original-repo','original-repo']);
 const bundle=buildEvidenceBundle(s,{window:resolveWindow({window_kind:'custom',window_start:'2026-01-01T00:00:00Z',window_end:'2026-11-01T00:00:00Z'},{now:'2026-11-02T00:00:00Z'})});
 assert.equal(bundle.facts.filter(f=>f.kind==='commit').length,1,'identity survives checkpoint-only evidence with no events map');
});

test('evidence budget keeps new changes, carryover and late arrivals before recent historical context',()=>{
 const s=state();
 const row=(id,at)=>({id,event_id:id,kind:'status',at,text:id});
 const old=Array.from({length:6},(_,i)=>row(`old-${i+1}`,`2026-09-0${i+1}T12:00:00Z`));
 const timeline=[...old,row('late','2026-10-01T12:00:00Z'),row('carryover','2026-10-29T21:00:00Z'),row('current','2026-10-30T12:00:00Z')];
 s.tickets.set('p',ticket('p',{timeline}));
 const options={maxFacts:5,eventSequences:new Map([['late',9]]),window:resolveWindow({window_kind:'today'},{now:'2026-10-30T18:00:00Z',scheduled:true,cursor:{through_at:'2026-10-29T18:00:00Z',source_sequence:5,evidence_ids:[]}})};
 const b=buildEvidenceBundle(s,options);
 assert.deepEqual(b.facts.map(f=>f.source_ref),['old-5','old-6','late','carryover','current']);
 assert.deepEqual(b.facts.filter(f=>f.section!=='context').map(f=>f.section),['late','carryover','changes']);
 assert.equal(b.coverage.state,'partial');assert.equal(b.coverage.omitted_count,4);
 assert.deepEqual(new Set(b.groups[0].fact_ids),new Set(b.facts.map(f=>f.id)));
 assert.deepEqual(buildEvidenceBundle(s,{...options,maxFacts:1}).facts.map(f=>f.source_ref),['current']);
 s.tickets.get('p').timeline.reverse();
 assert.deepEqual(buildEvidenceBundle(s,options).facts,b.facts,'selection is independent of source traversal order');
});
