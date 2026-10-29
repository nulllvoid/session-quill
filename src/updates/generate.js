// Narrative output is a source selection/order, never a free-form factual authority.
export function validateNarrative(output,bundle) {
  if(!output || !Array.isArray(output.claims) || output.claims.length>100) throw new Error('invalid narrative claims');
  const facts=new Map(bundle.facts.map(f=>[f.id,f]));
  return output.claims.map(c=>{
    if(!Array.isArray(c.evidence_ids) || c.evidence_ids.length!==1 || !facts.has(c.evidence_ids[0])) throw new Error('unknown narrative evidence');
    const f=facts.get(c.evidence_ids[0]);
    if(c.text!==f.text) throw new Error('unsupported narrative claim');
    return `${f.text} [${f.id}]`;
  });
}
const safe=value=>String(value ?? '').replace(/[<>]/g,c=>c==='<'?'&lt;':'&gt;').replace(/\[/g,'\\[').replace(/\]/g,'\\]');
export function renderUpdate(bundle,{narrative=null,narrativeError=null}={}) {
  const {window:w}=bundle;
  const lines=['# Daily update',``,`${w.window_kind} · ${w.timezone} · ${w.window_start} — ${w.window_end}`,`Coverage: ${bundle.coverage.state}${bundle.share?' · shared tasks only; closure counts unavailable':''}`,`Format: ${narrative?'evidence-selected narrative':'deterministic structured draft'}`];
  if(w.bootstrap) lines.push('First continuity update: preceding 24-hour bootstrap.');
  if(narrativeError) lines.push(`Narrative unavailable: ${safe(narrativeError)}. Structured facts retained.`);
  if(bundle.coverage.omitted_count) lines.push(`Partial evidence: ${bundle.coverage.omitted_count} missing, stale or budget-limited source(s).`);
  if(narrative?.length) lines.push('',...narrative.map(x=>`- ${safe(x)}`));
  for(const g of bundle.groups) {
    lines.push('',`## ${safe(g.key)} · ${safe(g.title)}`,`Completion: ${safe(g.closure_state)} [${safe(g.source_ref)}]`,`Goal: ${safe(g.goal)||'No objective recorded'} [${safe(g.source_ref)}]`,`Observed since: ${g.observed_since ?? 'unknown'} [${safe(g.source_ref)}]`,`Blocked: ${safe(g.blocker)} [${safe(g.source_ref)}]`,`Next: ${safe(g.next_action)} [${safe(g.source_ref)}]`);
    for(const [section,title] of [['changes','Changed in this window'],['carryover','Unreported work since the previous update'],['late','Newly recorded earlier work']]) {
      const facts=bundle.facts.filter(f=>f.group_id===g.id&&f.section===section);
      if(!facts.length) { if(section==='changes') lines.push('',`${title}: No recorded progress.`); continue; }
      lines.push('',`### ${title}`,...facts.map(f=>`- ${safe(f.text)} · ${safe(f.ticket_key)} · ${f.at} · ${f.trust} [${f.id}]`));
    }
    lines.push('',`Required work remaining${bundle.share?' (shared tasks only)':''}:`,...(g.remaining.length?g.remaining.map(t=>`- ${safe(t.key)} ${safe(t.title)} · ${t.status}`):['- No open required work recorded; this is not a closure decision.']));
    lines.push('','<details><summary>Earlier milestones and continuity</summary>','',...g.context.map(c=>`- ${safe(c.text)} [${safe(c.source_ref)}]`),...bundle.facts.filter(f=>f.group_id===g.id&&f.section==='context').map(f=>`- ${safe(f.text)} · ${f.at} · ${f.trust} [${f.id}]`),'','</details>');
  }
  if(!bundle.groups.length) lines.push('','No recorded progress in this scope.');
  return lines.join('\n')+'\n';
}
