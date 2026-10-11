import { esc, attr, keyEl, sessionChip, timeEl, ticketById, pager, icon, emptyState, countLabel, normalizeSnapshot, hasUnlinkedWork, filterSessions } from '../components.js';

export const SESSIONS_PAGE_SIZE = 50;

export function renderSessions(rawSnapshot, filters, { now, page = 0, selected = null }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const tz = snapshot.meta.timezone;
  const sessions = [...filterSessions(snapshot, filters)];
  const order = { live: 0, idle: 1, extinct: 2, ended: 3 };
  sessions.sort((a, b) => (order[a.state] - order[b.state]) || (a.last_event_at < b.last_event_at ? 1 : -1));
  if (!sessions.length) return `<section class="view view-sessions" aria-labelledby="tab-sessions">${emptyState('No sessions recorded', 'Sessions appear when a Claude Code session with the plugin loaded starts. Live means recent activity, not a running process.')}</section>`;
  const pages = Math.ceil(sessions.length / SESSIONS_PAGE_SIZE);
  const machines = [...new Set(snapshot.sessions.map((s) => s.machine_name))];
  const multiMachine = machines.length > 1;
  const rows = sessions.slice(page * SESSIONS_PAGE_SIZE, (page + 1) * SESSIONS_PAGE_SIZE).map((s) => {
    const current = s.current_ticket_id ? ticketById(snapshot, s.current_ticket_id) : null;
    const history = s.bindings.filter((b) => b.ticket_id && b.ticket_id !== s.current_ticket_id).map((b) => ticketById(snapshot, b.ticket_id)).filter(Boolean);
    const flags = [];
    if (s.unpromoted) flags.push(`<span class="chip warning" title="A complete checkpoint has not been approved or dismissed">${icon('alert')}Unpromoted checkpoint</span>`);
    if (hasUnlinkedWork(s)) flags.push(`<span class="chip warning" title="Changed files or committed without a ticket; see Pick next">${icon('inbox')}Unlinked work · ${esc(countLabel((s.unbound_work.files ?? []).length, 'file'))}</span>`);
    if (s.gate_enabled === false) flags.push(`<span class="chip critical">${icon('alert')}Gate off</span>`);
    if (s.capture_health && s.capture_health.status !== 'ok') flags.push(`<span class="chip warning">${icon('alert')}Capture ${esc(s.capture_health.status)}${s.capture_health.reason ? `: ${esc(s.capture_health.reason)}` : ''}</span>`);
    // Lead with what the session was about; the host ID is a short, hoverable reference.
    return `<tr data-session="${attr(s.id)}">
  <td><div class="session-title">${s.title ? esc(s.title) : '<span class="muted">Untitled session</span>'}</div><div class="small muted"><span class="session-id" title="${attr(s.host_session_id)}">${esc(String(s.host_session_id ?? '').slice(0, 8))}</span>${s.agent_id ? ` · agent ${esc(s.agent_id)}` : ''}${multiMachine ? ` · ${esc(s.machine_name)}` : ''}</div></td>
  <td>${sessionChip(s.state)}</td>
  <td>${current ? `<button type="button" class="link" data-open="${attr(current.id)}">${keyEl(current.key)}</button>` : '<span class="muted">Unbound</span>'}${history.length ? `<div class="small muted">Earlier: ${history.map((h) => `<button type="button" class="link" data-open="${attr(h.id)}">${esc(h.key)}</button>`).join(', ')}</div>` : ''}<details class="session-metadata"><summary class="small muted">Session details</summary><div class="small muted">Binding revision ${esc(s.current_binding_revision)}<br>${esc(s.host_session_id)}</div></details></td>
  <td>${timeEl(s.started_at, now, tz)}</td>
  <td>${esc(s.successful_write_count)} <span class="small muted">/ ${esc(s.change_coverage)}</span></td>
  <td class="preview">${s.last_checkpoint_preview ? `<span title="${attr(s.last_checkpoint_preview.slice(0, 300))}">${esc(s.last_checkpoint_preview.slice(0, 180))}${s.last_checkpoint_preview.length > 180 ? '…' : ''}</span>${current ? `<button type="button" class="link small" data-open="${attr(current.id)}" data-section="activity">View checkpoints</button>` : ''}` : '<span class="muted" aria-label="none">-</span>'}${current?.next_action ? `<p class="small"><strong>Next</strong> ${esc(current.next_action)}</p>` : ''}</td>
  <td>${flags.join(' ') || '<span class="muted" aria-label="none">-</span>'}</td>
</tr>`;
  }).join('');
  return `<section class="view view-sessions" aria-labelledby="tab-sessions">
<p class="section-count">${esc(countLabel(sessions.length, 'session'))}${multiMachine ? ` · <label>Machine <select data-filter="machine"><option value="">All</option>${machines.map((m) => `<option value="${attr(m)}" ${filters.machine === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>` : ''}</p>
<div class="table-wrap"><table class="sessions"><thead><tr><th scope="col">Session</th><th scope="col">State</th><th scope="col">Ticket</th><th scope="col">Started</th><th scope="col">Writes / coverage</th><th scope="col">Checkpoint</th><th scope="col">Indicators</th></tr></thead><tbody>${rows}</tbody></table></div>
${pager(page, pages, { prefix: 'sessions' })}
</section>`;
}
