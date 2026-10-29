// Frozen, deterministic source facts. Generated updates are never inputs to this projection.
import { redactText } from '../export/sanitize.js';
import { createHash } from 'node:crypto';
import { localDate } from '../today/feed.js';
import { zonedToUtc } from '../schedule/cron.js';
import { TrackerError } from '../lib/errors.js';
import { conflicts as memoryConflicts, memoryStaleness } from '../core/memory.js';
import { requiredCompleted } from '../core/hierarchy.js';
import { assessClosure, closureContext } from '../core/closure.js';
const DAY = 86400000;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = message => new TrackerError('request-invalid', message);
export function normalizeScope(scope = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw invalid('scope must be an object');
  const list = name => {
    const xs = scope[name] ?? [];
    if (!Array.isArray(xs) || xs.length > 100 || xs.some(x => typeof x !== 'string' || !x || x.length > 200)) throw invalid(`${name} must be a list of identifiers`);
    return [...new Set(xs)].sort();
  };
  return { project_ids: list('project_ids'), repo_ids: list('repo_ids') };
}
export const cursorKey = (scope, timezone) => fingerprint({scope:normalizeScope(scope),timezone});
function midnight(date, timezone) {
  const [y,m,d] = date.split('-').map(Number);
  // A few zones skip midnight; the first existing minute still starts that local day.
  for(let minute=0;minute<1440;minute++) { const ms=zonedToUtc(y,m,d,Math.floor(minute/60),minute%60,timezone); if(ms!==null) return new Date(ms).toISOString(); }
  throw invalid('the requested calendar day does not exist in this timezone');
}
export function resolveWindow(options = {}, { now, timezone = 'UTC', cursor = null, scheduled = false } = {}) {
  const instant = new Date(now).toISOString();
  try { new Intl.DateTimeFormat('en',{timeZone:timezone}).format(new Date(instant)); } catch { throw invalid('invalid timezone'); }
  if(cursor) cursor={...cursor,through_at:new Date(cursor.through_at).toISOString()};
  const kind = options.window_kind ?? 'last-24-hours';
  const date = localDate(instant,timezone);
  const today = midnight(date,timezone);
  let start, end = instant;
  if(kind==='today') start=today;
  else if(kind==='yesterday') { start=midnight(new Date(Date.parse(`${date}T00:00:00Z`)-DAY).toISOString().slice(0,10),timezone); end=today; }
  else if(kind==='last-24-hours') start=new Date(Date.parse(instant)-DAY).toISOString();
  else if(kind==='since-last') start=cursor?.through_at ?? new Date(Date.parse(instant)-DAY).toISOString();
  else if(kind==='custom') { start=options.window_start; end=options.window_end; }
  else throw invalid('unknown update window');
  if(!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || (Date.parse(start)>Date.parse(end)||(kind==='custom'&&Date.parse(start)===Date.parse(end))) || Date.parse(end)>Date.parse(instant)) throw invalid('window needs valid increasing bounds no later than now');
  start=new Date(start).toISOString(); end=new Date(end).toISOString();
  const contributes = (scheduled || kind==='since-last') && !options.regenerate_id && !options.retry_id;
  const bootstrap = !cursor && contributes;
  const carryStart = scheduled ? cursor?.through_at ?? new Date(Math.min(Date.parse(start),Date.parse(end)-DAY)).toISOString() : start;
  return {window_kind:kind,window_start:start,window_end:end,timezone,contributes,bootstrap,carryover_start:carryStart < start ? carryStart : null,cursor:cursor ? structuredClone(cursor) : null};
}
const publicText = value => redactText(String(value ?? '')).replace(/(?:https?:\/\/|file:\/\/|(?:[A-Za-z]:)?[\\/]Users[\\/]|[\\/]home[\\/]|[\\/]tmp[\\/]|~[\\/])\S+/gi,'[private location omitted]').replace(/(^|[\s(])(?:[A-Za-z]:)?\/[A-Za-z0-9._-]+(?:\/[^\s)]*)?/g,'$1[private location omitted]');
const textOf = value => typeof value === 'string' ? value : value?.reason ?? value?.text ?? '';
const scopesTicket = (t, scope) => (!scope.project_ids.length || scope.project_ids.includes(t.project_id)) && (!scope.repo_ids.length || scope.repo_ids.includes(t.repo_id));
function rootPath(t, tickets) { const path=[], seen=new Set(); let cur=t; while(cur && !seen.has(cur.id)) { seen.add(cur.id); path.unshift(cur.id); cur=tickets.get(cur.parent_id); } return path; }
const kinds=new Set(['commit','pr','deployment','status','plan','conclusion','handoff','write','comment','scope','blocker']);
function commitIdentityIndex(tickets,events) {
  const prefixes=new Map();
  const add=(repo,sha)=>{
    if(typeof sha!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) return;
    sha=sha.toLowerCase();
    for(let length=7;length<sha.length;length++) {
      const key=`${repo ?? ''}:${sha.slice(0,length)}`;
      if(!prefixes.has(key)) prefixes.set(key,sha);
      else if(prefixes.get(key)!==sha) prefixes.set(key,null);
    }
  };
  for(const event of events.values()) add(event.payload?.repo_id ?? tickets.get(event.ticket_id)?.repo_id,event.payload?.commit?.sha);
  for(const t of tickets.values()) for(const e of t.timeline??[]) if(e.kind==='commit') {
    const raw=events.get(e.event_id)?.payload;
    add(e.commit_repo_id ?? raw?.repo_id ?? t.repo_id,e.commit_sha ?? raw?.commit?.sha);
  }
  return (repo,sha)=>{
    sha=sha.toLowerCase();
    if(sha.length===40||sha.length===64) return sha;
    const key=`${repo ?? ''}:${sha}`;
    return prefixes.has(key)?prefixes.get(key):sha;
  };
}
function sourceIdentity(e,t,events,resolveCommit) {
  const raw=events.get(e.event_id)?.payload;
  const sha=e.commit_sha ?? raw?.commit?.sha ?? (/\bCommit ([a-f0-9]{7,64})\b/i.exec(e.text ?? '')?.[1]);
  if(e.kind==='commit' && sha) {
    const repo=e.commit_repo_id ?? raw?.repo_id ?? t.repo_id ?? '';
    const canonical=resolveCommit(repo,sha);
    // An ambiguous legacy abbreviation is separate evidence until its full identity is available.
    return canonical===null ? `commit-unresolved:${repo}:${sha}:${e.event_id??e.id}` : `commit:${repo}:${canonical}`;
  }
  if(e.kind==='pr') { const url=(e.text ?? '').match(/https?:\/\/\S+/)?.[0]; if(url) return `pr:${url}:${raw?.state ?? e.text}`; }
  return `${e.event_id ?? e.id}:${e.kind}:${e.kind==='status' ? t.id : e.id}`;
}
export function buildEvidenceBundle(state, { window, scope = {}, eventSequences = new Map(), events = new Map(), share = false, hasContent = () => true, maxFacts = 10000 } = {}) {
  scope=normalizeScope(scope);
  const source_sequence=state.lastSequence ?? 0;
  const eligible=new Map([...state.tickets].filter(([,t])=>!(share && t.local_only===true)));
  const selected=new Map([...eligible].filter(([,t])=>scopesTicket(t,scope)));
  const facts=[], seen=new Set(), groups=new Map(), omissions=[];
  const resolveCommit=commitIdentityIndex(eligible,events);
  const contributed=new Set((window.cursor?.evidence_ids ?? []).map(id=>{
    const match=/^commit:(.*):([a-f0-9]{7,64})$/i.exec(id);
    const canonical=match?resolveCommit(match[1],match[2]):null;
    return canonical ? `commit:${match[1]}:${canonical}` : id;
  }));
  const ctx=closureContext(share ? {...state,tickets:eligible,handoffs:new Map([...(state.handoffs??[])].filter(([,h])=>eligible.has(h.ticket_id)))} : state,window.window_end);
  const privateNames=share ? [...state.tickets.values()].filter(t=>t.local_only).flatMap(t=>[t.title,t.key,t.id]).filter(x=>typeof x==='string'&&x.length>2) : [];
  const clean=value=>{let text=share ? publicText(value) : String(value ?? '');if(share) for(const name of privateNames) text=text.split(name).join('[omitted]');return text;};
  function groupFor(t) {
    const path=rootPath(t,eligible); const root=eligible.get(path[0]) ?? t;
    if(!groups.has(root.id)) {
      const closure=share ? null : assessClosure(root,ctx);
      groups.set(root.id,{id:root.id,key:root.key,title:clean(root.title),goal:clean(root.summary),observed_since:root.created_at,source_ref:`ticket:${root.id}:${root.revision??0}`,status:root.status,blocker:clean(textOf(root.blocker)) || 'Blocker state unknown',next_action:clean(root.next_action) || 'No next action recorded',closure_state:!share&&ctx.conflicts.has(root.id) ? 'needs-review' : closure?.closable ? 'ready' : root.status==='done' ? 'recorded-completion' : 'not-ready',remaining:[],context:[],fact_ids:[]});
    }
    return {group:groups.get(root.id),path};
  }
  function add(t, item) {
    if(!Number.isFinite(Date.parse(item.at))) return;
    item.at=new Date(item.at).toISOString();
    if(seen.has(item.source_id)) return;
    const {group,path}=groupFor(t);
    const seq=item.sequence ?? 0;
    if(seq>source_sequence) return;
    let section='context';
    if(item.at>=window.window_start && item.at<window.window_end) section=contributed.has(item.source_id)?'context':'changes';
    else if(window.carryover_start && item.at>=window.carryover_start && item.at<window.window_start && !contributed.has(item.source_id)) section='carryover';
    else if(window.cursor && seq>window.cursor.source_sequence && item.at<window.window_start && !contributed.has(item.source_id)) section='late';
    if(item.at>=window.window_end) return;
    seen.add(item.source_id);
    const fact={...item,id:`e-${fingerprint(item.source_id).slice(0,20)}`,ticket_id:t.id,ticket_key:t.key,ancestor_path:path,group_id:group.id,section,text:clean(item.text)};
    facts.push(fact); group.fact_ids.push(fact.id);
  }
  for(const t of selected.values()) {
    if(Date.parse(t.created_at)>Date.parse(window.window_end)) continue;
    const {group}=groupFor(t);
    if(t.id!==group.id && rootPath(t,eligible).slice(1).every(id=>eligible.get(id)?.blocks_parent===true) && !requiredCompleted(t,ctx.conflicts)) group.remaining.push({ticket_id:t.id,key:t.key,title:clean(t.title),status:t.status});
    for(const e of t.timeline ?? []) {
      if(!kinds.has(e.kind) || !e.at || (share && e.local_only)) continue;
      const event=events.get(e.event_id);
      if(event?.kind==='update-tx' || (event?.kind==='request-tx' && event.payload?.mutation?.type==='update')) continue;
      const source_id=sourceIdentity(e,t,events,resolveCommit);
      if(source_id.startsWith('commit-unresolved:')) omissions.push({kind:'commit-identity-ambiguous',source_id});
      const trust=['pr','deployment'].includes(e.kind) && event?.kind==='reconcile' ? 'provider' : ['handoff','conclusion'].includes(e.kind) ? 'agent-reported' : 'recorded';
      add(t,{source_id,source_ref:e.event_id ?? e.id,at:e.at,kind:e.kind,text:e.text,trust,sequence:eventSequences.get(e.event_id) ?? event?.sequence ?? 0,content_ref:share?null:e.content_ref ?? null});
    }
    // Current state is context; it is never treated as a new verified delivery.
    group.context.push({ticket_id:t.id,text:clean(`${t.key}: ${t.status}${t.resolution ? ` (${t.resolution.kind})` : ''}`),source_ref:`ticket:${t.id}:${t.revision ?? 0}`});
  }
  for(const event of events.values()) {
    const mutation=event.kind==='request-tx' ? event.payload?.mutation : null;
    const fields=mutation?.type==='ticket-fields' ? mutation.fields : event.kind==='ticket-update' ? event.payload?.fields ?? event.payload : null;
    const t=selected.get(mutation?.ticket_id ?? event.ticket_id ?? event.payload?.ticket_id);
    if(!t||!fields) continue;
    for(const [field,label] of [['blocker','Blocker recorded'],['next_action','Next action recorded'],['parent_id','Scope relationship changed'],['user_notes','Owner note']]) {
      if(!Object.hasOwn(fields,field) || (share&&field==='user_notes')) continue;
      add(t,{source_id:`${event.event_id}:${field}`,source_ref:event.event_id,kind:field==='parent_id'?'scope':field==='blocker'?'blocker':'comment',at:event.occurred_at,sequence:event.sequence,text:`${label}: ${textOf(fields[field]) || (field==='parent_id'?'unlinked':'cleared')}`,trust:'owner-stated'});
    }
  }
  const runSequences=new Map();
  for(const event of events.values()) if(event.kind==='handoff-tx'&&event.payload?.update?.state) runSequences.set(`${event.payload.handoff_id}:${event.payload.update.state}`,event.sequence);
  for(const h of state.handoffs?.values() ?? []) {
    const t=selected.get(h.ticket_id); if(!t || !h.finished_at || Date.parse(h.finished_at)>=Date.parse(window.window_end)) continue;
    const gate=h.test_gate;
    add(t,{source_id:`run:${h.id}:${h.state}`,source_ref:`run:${h.id}`,kind:'run',at:h.finished_at,sequence:h.finished_sequence ?? runSequences.get(`${h.id}:${h.state}`) ?? 0,text:`Run ${h.state}; outcome ${h.fix_outcome ?? 'unknown'}${gate ? `; tests ${gate.status} (worker)` : '; tests not verified'}`,trust:'worker'});
  }
  const conflictingMemory=new Set(!share && state.memory?.entries ? memoryConflicts(state).flatMap(g=>g.entries.map(e=>e.id)) : []);
  if(!share) for(const m of state.memory?.entries?.values() ?? []) {
    if(m.trust==='quarantined' || memoryStaleness(m,Date.parse(window.window_end))==='retired' || m.scope!=='task') continue;
    const t=selected.get(m.scope_id ?? m.ticket_id); if(!t) continue;
    const {group}=groupFor(t);
    group.context.push({ticket_id:t.id,text:`${memoryStaleness(m,Date.parse(window.window_end))==='stale'||conflictingMemory.has(m.id) ? 'Uncertain memory' : 'Memory context'}: ${m.text ?? m.statement ?? ''}`,source_ref:`memory:${m.id}:${m.revision}`,trust:m.trust});
  }
  if(!share) {
    const cutoff=Date.parse(window.carryover_start??window.window_start),end=Date.parse(window.window_end);
    for(const session of state.sessions?.values() ?? []) {
      const inScope=!(session.ticket_ids?.length)||session.ticket_ids.some(id=>selected.has(id));
      const relevant=!session.last_event_at||Date.parse(session.last_event_at)>=cutoff;
      if(inScope&&relevant&&((session.change_coverage&&session.change_coverage!=='complete')||['error','partial','degraded'].includes(session.capture_health?.status))) omissions.push({kind:'capture-gap',source_id:session.id,reason:session.capture_health?.reason??session.change_coverage});
    }
    const staleMs=(state.meta.sync_interval_hours??2)*2*3600000;
    for(const p of state.providerHealth ?? []) if(p.error||!p.last_success_at||end-Date.parse(p.last_success_at)>staleMs) omissions.push({kind:'provider-stale',source_id:p.provider,observed_at:p.last_success_at??null,reason:p.error??'provider observation is unavailable or stale'});
    for(const t of selected.values()) for(const pr of t.prs??[]) if(pr.error||!pr.observed_at||end-Date.parse(pr.observed_at)>staleMs) omissions.push({kind:'provider-stale',source_id:pr.id??pr.url,observed_at:pr.observed_at??null,reason:pr.error??'PR observation is unavailable or stale'});
    for(const health of state.healthErrors??[]) if(['capture','capture-error','ingress-invalid','journal-corrupt'].includes(health.kind)) omissions.push({kind:'capture-gap',source_id:health.kind,reason:health.error});
  }
  // Spend the source budget on the requested delta before filling it with recent continuity.
  const sectionRank={changes:0,carryover:1,late:2,context:3};
  facts.sort((a,b)=>sectionRank[a.section]-sectionRank[b.section]||b.at.localeCompare(a.at)||a.id.localeCompare(b.id));
  for(const omitted of facts.splice(Math.max(0,maxFacts))) omissions.push({kind:'budget',source_id:omitted.source_id});
  const included=new Set(facts.map(f=>f.id));
  for(const group of groups.values()) group.fact_ids=group.fact_ids.filter(id=>included.has(id)).sort();
  for(const fact of facts) if(fact.content_ref&&!hasContent(fact.content_ref)) omissions.push({kind:'missing-content',source_id:fact.source_id});
  const changedGroups=new Set(facts.filter(f=>f.section!=='context').map(f=>f.group_id));
  const visibleGroups=[...groups.values()].filter(g=>g.status!=='done' || g.closure_state==='needs-review' || changedGroups.has(g.id));
  facts.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id)); visibleGroups.sort((a,b)=>String(a.key).localeCompare(String(b.key)));
  return {schema_version:1,scope,window,source_sequence,share,coverage:{state:omissions.length?'partial':'complete',omitted_count:omissions.length,omissions},facts,groups:visibleGroups};
}
