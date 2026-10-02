import { esc, attr, keyEl, statusChip, categoryChip, priorityMark, timeEl, handoffChip, repoName, ticketById, staleAgeLabel, icon, STATUS_LABELS, STATUS_ORDER, normalizeSnapshot, normalizeTicket, requestFeedback, ticketKey, externalChip } from '../components.js';
import { renderAgentsSection } from './agents.js';
import { environmentLine } from './deployments.js';

const TRACKER_NAMES = { jira: 'Jira', linear: 'Linear', github: 'GitHub', custom: 'Tracker' };

// What tracker-sync last read for the ticket's tracker key (ADR 0011); display only.
function trackerRemote(t, { now, tz }) {
  const ext = t.external;
  if (!ext) return '';
  const name = TRACKER_NAMES[ext.system] ?? 'the tracker';
  if (ext.validation === 'not-found') return `<p class="small warning-text tracker-remote">${icon('alert')}${esc(ext.key)} was not found in ${esc(name)}. Check the key, or link the ticket to the right one.</p>`;
  const r = ext.remote;
  if (!r) return '';
  const parts = [r.status, r.assignee, r.fix_versions && r.fix_versions.length ? `fix ${r.fix_versions.join(', ')}` : null].filter(Boolean).map((x) => esc(x));
  return `<p class="small tracker-remote"><span class="label">${esc(name)}</span> ${parts.join(' · ')}${r.title && r.title !== t.title ? ` <span class="muted">(“${esc(r.title)}”)</span>` : ''} <span class="muted">read ${timeEl(r.fetched_at, now, tz)}</span></p>`;
}

function timelineItem(e, { now, tz, generation }) {
  const kindLabel = { bind: 'Bound', write: 'Write', tool: 'Tool', commit: 'Commit', pr: 'PR', plan: 'Plan', conclusion: 'Conclusion', handoff: 'Handoff', comment: 'Comment', status: 'Status', deployment: 'Deployment', 'capture-error': 'Capture error' }[e.kind] ?? e.kind;
  return `<li class="timeline-item" data-kind="${attr(e.kind)}"><span class="tl-kind">${esc(kindLabel)}</span> ${timeEl(e.at, now, tz)} <span class="tl-text">${esc(e.text)}</span>${e.coverage !== 'complete' ? ` <span class="chip warning small" title="Change coverage">${esc(e.coverage)}</span>` : ''}${e.content_ref ? ` <button type="button" class="link small" data-action="load-content" data-hash="${attr(e.content_ref)}" data-generation="${attr(generation)}">Full text</button>` : ''}</li>`;
}

export function renderDetail(rawTicket, rawSnapshot, { now, pending = [], content = {}, loadedTicket = null }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const ticket = normalizeTicket(rawTicket);
  const caps = snapshot.capabilities ?? {};
  const tz = snapshot.meta.timezone;
  const t = loadedTicket && loadedTicket.id === ticket.id ? normalizeTicket(loadedTicket) : ticket;
  const parent = t.parent_id ? ticketById(snapshot, t.parent_id) : null;
  const children = (t.children_ids ?? []).map((id) => ticketById(snapshot, id)).filter(Boolean);
  const sessions = snapshot.sessions.filter((s) => (s.ticket_ids ?? []).includes(t.id));
  const checkpoints = snapshot.checkpoints.filter((c) => c.ticket_id === t.id).sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1));
  const mine = pending.filter((r) => r.target_id === t.id);
  const readOnly = !caps.edit_tickets;
  const outstanding = t.deployments.filter((d) => d.state === 'pending');
  const timeline = [...(t.timeline ?? [])].sort((a, b) => (a.at < b.at ? 1 : -1));
  const total = t.timeline_total ?? timeline.length;

  const editNext = readOnly ? '' : `<form class="inline-edit" data-form="next-action" data-ticket="${attr(t.id)}" data-revision="${attr(t.revision)}">
      <textarea id="next-action-${attr(t.id)}" name="next_action" rows="2" maxlength="2000" aria-label="Edit next action" placeholder="What should happen next? Enter submits, Shift+Enter for a new line, Escape cancels">${esc(t.next_action)}</textarea>
      <div class="inline-actions"><button type="submit" class="btn small">Save</button><span class="small muted">Confirmed value stays until the worker applies the change.</span></div>
    </form>`;
  const statusControls = readOnly ? '' : `<div class="status-controls"><label class="label" for="status-select-${attr(t.id)}">Change status</label> <select id="status-select-${attr(t.id)}" data-action="status-select" data-ticket="${attr(t.id)}" data-revision="${attr(t.revision)}">${STATUS_ORDER.map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${esc(STATUS_LABELS[s])}</option>`).join('')}</select>${caps.handoff && t.status !== 'done' && t.status !== 'blocked' ? ` <button type="button" class="btn small" data-action="handoff" data-ticket="${attr(t.id)}">${icon('play')}Handoff</button>` : ''}</div>`;

  return `<article class="detail" data-ticket="${attr(t.id)}" aria-labelledby="detail-title">
<header class="detail-head">
  <div class="detail-nav"><button type="button" class="btn icon-only" data-action="close-detail" aria-label="Close detail (Escape)">${icon('x')}</button><span class="detail-nav-keys" tabindex="0" data-action="detail-nav" aria-label="Record navigation: use Left and Right arrows while focused">${icon('chevron')}</span></div>
  <div class="detail-keys">${ticketKey(t)}${(t.aliases ?? []).map((a) => ` <span class="muted small">alias ${esc(a)}</span>`).join('')}${externalChip(t)}${!readOnly && !t.external && !t.jira ? ` <button type="button" class="btn small ghost" data-action="link-external" data-ticket="${attr(t.id)}">${icon('link')}Link to external…</button>` : ''}</div>
  <h2 id="detail-title">${esc(t.title)}</h2>
  ${trackerRemote(t, { now, tz })}
  <div class="detail-chips">${statusChip(t.status, { stale: t.stale, staleAge: staleAgeLabel(t, now) })} ${categoryChip(t.category)} ${priorityMark(t.priority)} <span class="muted small">${esc(t.project_name)}${repoName(snapshot, t.repo_id) ? ` · ${esc(repoName(snapshot, t.repo_id))}` : ''}</span>${readOnly ? ' <span class="chip" data-readonly="true">Read-only snapshot</span>' : ''}</div>
  ${t.validation_issues && t.validation_issues.length ? `<p class="issues">${icon('alert')}Validation: ${t.validation_issues.map((i) => `<code>${esc(i)}</code>`).join(' ')}</p>` : ''}
</header>
${mine.length ? `<section class="detail-requests" aria-label="Pending edits">${mine.map((r) => requestFeedback(r, { now })).join('')}</section>` : ''}
<section class="detail-section"><h3>Summary</h3>${t.summary ? `<p class="prewrap">${esc(t.summary)}</p>` : '<p class="muted small">No summary. Add one in the note\'s Summary section; it is preserved byte-for-byte.</p>'}</section>
<section class="detail-section"><h3>Next action</h3>${t.next_action ? `<p class="prewrap confirmed-value">${esc(t.next_action)}</p>` : '<p class="muted small">None set.</p>'}${editNext}</section>
<section class="detail-section"><h3>Status</h3><p>${statusChip(t.status, { stale: t.stale, staleAge: staleAgeLabel(t, now) })} <span class="muted small">source: ${esc(t.status_source)}</span></p>${t.blocker ? `<p class="card-blocker">${icon('alert')}<span class="label">Blocker</span> ${esc(t.blocker)}</p>` : ''}${t.due ? `<p>${icon('clock')}Due ${esc(t.due)}</p>` : ''}${statusControls}</section>
<section class="detail-section"><h3>Timeline <span class="count">${esc(total)}</span></h3>${timeline.length ? `<ul class="timeline">${timeline.map((e) => timelineItem(e, { now, tz, generation: snapshot.generation_id })).join('')}</ul>${total > timeline.length ? `<button type="button" class="btn small" data-action="load-ticket" data-ticket="${attr(t.id)}" data-generation="${attr(snapshot.generation_id)}">Load all ${esc(total)} entries</button>` : ''}` : '<p class="muted small">No events yet.</p>'}</section>
<section class="detail-section"><h3>Approved plans <span class="count">${esc(t.plans_count)}</span></h3>${t.plans.length ? t.plans.map((p) => `<details class="plan"><summary>${timeEl(p.approved_at, now, tz, { absolute: true })} · ${esc(p.provenance)}</summary><pre class="preview">${esc(p.preview)}</pre>${p.content_ref ? `<button type="button" class="link small" data-action="load-content" data-hash="${attr(p.content_ref)}" data-generation="${attr(snapshot.generation_id)}">Full plan</button>${content[p.content_ref] ? `<pre class="full">${esc(content[p.content_ref])}</pre>` : ''}` : ''}</details>`).join('') : '<p class="muted small">No approved plans. Approve the latest checkpoint with <code>/session-quill:approve</code>.</p>'}</section>
<section class="detail-section"><h3>Conclusions and checkpoints <span class="count">${esc(checkpoints.length)}</span></h3>${checkpoints.length ? `<ul class="checkpoints">${checkpoints.map((c) => `<li>${timeEl(c.recorded_at, now, tz)} ${c.complete ? `<span class="preview-inline">${esc(c.preview.slice(0, 240))}${c.preview.length > 240 ? '…' : ''}</span> <button type="button" class="link small" data-action="load-content" data-hash="${attr(c.content_ref)}" data-generation="${attr(snapshot.generation_id)}">Full checkpoint</button>${content[c.content_ref] ? `<pre class="full">${esc(content[c.content_ref])}</pre>` : ''}` : `<span class="chip warning">${icon('alert')}Capture incomplete</span> <span class="muted small">full content unavailable</span>`}${c.approved_at ? ` <span class="chip good small">Approved</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">No checkpoints captured for this ticket.</p>'}${t.conclusions.length ? `<ul class="conclusions">${t.conclusions.map((c) => `<li>${esc(c.preview)}</li>`).join('')}</ul>` : ''}</section>
<section class="detail-section"><h3>Files touched <span class="count">${esc(t.files_touched_count)}</span></h3>${t.files_touched.length ? `<ul class="files">${t.files_touched.slice(0, 50).map((f) => `<li><code>${esc(f.relative_path)}</code> <span class="muted small">${esc(f.repo_id ?? '')}</span></li>`).join('')}</ul>${t.files_touched.length > 50 ? `<p class="muted small">and ${esc(t.files_touched.length - 50)} more</p>` : ''}` : '<p class="muted small">No verified file changes. Shell and MCP writes are recorded as tool activity with unknown coverage.</p>'}</section>
<section class="detail-section"><h3>PRs and deployments</h3>${environmentLine(t, { now, tz })}${t.prs.length ? `<ul class="prs">${t.prs.map((p) => `<li><a href="${attr(p.url)}" rel="noopener noreferrer" target="_blank">${esc(p.url)}</a> <span class="chip" data-pr="${attr(p.state)}">${esc(p.state)}</span>${p.merged_at ? ` merged ${timeEl(p.merged_at, now, tz)}` : ''}${p.error ? ` <span class="small critical">${esc(p.error)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">No PR evidence.</p>'}${t.deployments.length ? `<ul class="deployments-list">${t.deployments.map((d) => `<li><strong>${esc(d.environment)}</strong>: ${esc(d.state)}${d.deployed_at ? ` ${timeEl(d.deployed_at, now, tz)}` : ''}${d.waiver_reason ? ` (waived: ${esc(d.waiver_reason)})` : ''}${d.evidence ? ` <span class="muted small">${esc(d.evidence)}</span>` : ''}</li>`).join('')}</ul>${!readOnly && outstanding.length ? `<button type="button" class="btn small" data-action="record-deployment" data-ticket="${attr(t.id)}">${icon('rocket')}Record deployment…</button>` : ''}` : ''}</section>
<section class="detail-section"><h3>Follow-ups</h3>${parent ? `<p>Parent: <button type="button" class="link" data-open="${attr(parent.id)}">${keyEl(parent.key)} ${esc(parent.title)}</button></p>` : ''}${children.length ? `<ul class="children">${children.map((c) => `<li><button type="button" class="link" data-open="${attr(c.id)}">${keyEl(c.key)} ${esc(c.title)}</button> ${statusChip(c.status)}</li>`).join('')}</ul><p class="muted small">${esc(t.children_done_count)} of ${esc(children.length)} children done</p>` : '<p class="muted small">No children.</p>'}</section>
${renderAgentsSection(t, snapshot, { now, pending })}
<section class="detail-section"><h3>Sessions <span class="count">${esc(sessions.length)}</span></h3>${sessions.length ? `<ul class="session-list">${sessions.map((s) => `<li>${esc(s.host_session_id)} · ${esc(s.state)} · ${esc(s.machine_name)}</li>`).join('')}</ul>` : '<p class="muted small">No sessions.</p>'}</section>
<footer class="detail-foot muted small">Revision ${esc(t.revision)} · updated ${timeEl(t.updated_at, now, tz, { absolute: true })} · created ${timeEl(t.created_at, now, tz, { absolute: true })}</footer>
</article>`;
}
