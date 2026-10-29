// Update transactions are worker-only and carry already persisted immutable blob references.
const terminal = new Set(['ready','partial','failed','cancelled']);
export function handleUpdateTx(state, ev, result = {}) {
  state.updates ??= new Map(); state.updateCursors ??= new Map();
  const p=ev.payload ?? {};
  if(p.op==='create') {
    if(state.updates.has(p.update?.id)) return {duplicate:true};
    if(!p.update?.id || !p.update.input_ref || !Number.isInteger(p.update.source_sequence)) return {rejected:'update-invalid'};
    state.updates.set(p.update.id,{...p.update,state:'queued',revision:1,revisions:[],attempts:[],created_at:ev.occurred_at,updated_at:ev.occurred_at});
  } else {
    const u=state.updates.get(p.update_id); if(!u) return {rejected:'update-unknown'};
    if(p.expected_revision!==undefined && p.expected_revision!==u.revision) return {rejected:'revision-conflict'};
    if(p.op==='regenerate') {
      if(!terminal.has(u.state)) return {rejected:'update-busy'};
      u.revisions.push({revision:u.revision,input_ref:u.input_ref,content_ref:u.content_ref,share_ref:u.share_ref,owner_edit_ref:u.owner_edit_ref??null,at:u.updated_at});
      u.supersedes_revision=u.revision; u.revision++; u.state='queued'; u.contributes=false; u.owner_edit_ref=null; u.owner_edited=false;
    } else if(p.op==='edit') {
      if(!terminal.has(u.state) || !p.content_ref) return {rejected:'update-not-ready'};
      u.revisions.push({revision:u.revision,input_ref:u.input_ref,content_ref:u.content_ref,share_ref:u.share_ref,owner_edit_ref:u.owner_edit_ref??null,at:u.updated_at});
      u.supersedes_revision=u.revision; u.owner_edit_ref=p.content_ref; u.owner_edited=true; u.revision++;
    } else if(p.op==='attempt') {
      if(!['queued','failed','cancelled','partial'].includes(u.state)) return {rejected:'update-not-retryable'};
      u.state='running'; u.error=null; u.attempts.push({number:u.attempts.length+1,started_at:ev.occurred_at});
    } else if(p.op==='finish') {
      if(!['running','queued'].includes(u.state)) return {duplicate:true};
      if(!terminal.has(p.state)) return {rejected:'update-state-invalid'};
      if(['ready','partial'].includes(p.state) && !p.content_ref) return {rejected:'update-content-required'};
      Object.assign(u,{state:p.state,content_ref:p.content_ref??u.content_ref??null,share_ref:p.share_ref??u.share_ref??null,coverage:p.coverage??u.coverage,error:p.error??null,narrative_error:p.narrative_error??null,generated_at:ev.occurred_at});
      const attempt=u.attempts.at(-1); if(attempt) Object.assign(attempt,{finished_at:ev.occurred_at,state:p.state});
      if(p.state==='ready' && u.contributes && u.coverage?.state==='complete' && p.cursor?.through_at===u.window_end && p.cursor.source_sequence===u.source_sequence && u.cursor_key) {
        const prior=state.updateCursors.get(u.cursor_key), next=p.cursor;
        if(!prior || next.through_at>prior.through_at || (next.through_at===prior.through_at && next.source_sequence>prior.source_sequence)) {
          state.updateCursors.set(u.cursor_key,{...next,update_id:u.id,evidence_ids:[...new Set([...(prior?.evidence_ids??[]),...(next.evidence_ids??[])])]});
        }
      }
    } else return {rejected:'update-op-invalid'};
    u.updated_at=ev.occurred_at;
  }
  result.updatesChanged ??= new Set(); result.updatesChanged.add(p.update_id ?? p.update.id);
  return {};
}
