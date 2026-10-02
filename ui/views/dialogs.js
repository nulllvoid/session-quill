import { esc, attr, keyEl, STATUS_LABELS, icon, normalizeTicket, normalizeSnapshot, countLabel } from '../components.js';

// Inbox dialog (ADR 0006): attach to an open ticket, or create a ticket from its tracker key.
export function renderAttachDialog(session, rawSnapshot, { mode = 'attach' } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const w = session.unbound_work ?? { revision: 0, files: [], commits: [] };
  const example = snapshot.meta.key_example ?? 'PROJ-123';
  const what = `${countLabel((w.files ?? []).length, 'file')}${(w.commits ?? []).length ? `, ${countLabel(w.commits.length, 'commit')}` : ''}`;
  const candidates = snapshot.tickets.filter((t) => t.status !== 'done').sort((a, b) => (a.last_activity < b.last_activity ? 1 : -1)).slice(0, 200);
  const bound = !!session.current_ticket_id;
  return `<form class="dialog-form" data-form="attach" data-session="${attr(session.id)}" data-revision="${attr(w.revision)}" data-mode="${attr(mode)}">
<h2 id="dialog-title">${icon('link')}${mode === 'create' ? 'Create a ticket from its key' : 'Attach unlinked work'}</h2>
<p class="muted small">${esc(what)} from session ${esc(session.title || session.host_session_id)}.</p>
${mode === 'create'
    ? `<label class="label" for="attach-key">Ticket key</label><input id="attach-key" name="key" required pattern="[A-Za-z][A-Za-z0-9_]*-[0-9]+" placeholder="${attr(example)}" autocomplete="off">
<label class="label" for="attach-title">Title (optional)</label><input id="attach-title" name="title" maxlength="200" placeholder="${attr(session.title || '')}">`
    : `<label class="label" for="attach-key">Ticket</label><input id="attach-key" name="key" required list="attach-tickets" placeholder="Key or title" autocomplete="off"><datalist id="attach-tickets">${candidates.map((t) => `<option value="${attr(t.key)}">${esc(t.title)}</option>`).join('')}</datalist>
<p class="small muted">Pick an open ticket, or type a new key such as ${esc(example)} to create it.</p>`}
<label class="check"><input type="checkbox" name="bind" ${bound ? 'disabled' : 'checked'}> Also link this session's later work${bound ? ' (already linked to another ticket)' : ''}</label>
<p class="small muted">Applies after a 10-second undo window. Nothing is posted to your tracker.</p>
<div class="dialog-actions"><button type="submit" class="btn primary">${mode === 'create' ? 'Create and attach' : 'Attach'}</button><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div>
</form>`;
}

export function renderLinkExternalDialog(rawTicket, rawSnapshot) {
  const ticket = normalizeTicket(rawTicket);
  const snapshot = normalizeSnapshot(rawSnapshot);
  return `<form class="dialog-form" data-form="link-external" data-ticket="${attr(ticket.id)}" data-revision="${attr(ticket.revision)}">
<h2 id="dialog-title">${icon('link')}Link ${keyEl(ticket.key)} to a tracker ticket</h2>
<label class="label" for="link-key">Ticket key</label><input id="link-key" name="key" required pattern="[A-Za-z][A-Za-z0-9_]*-[0-9]+" placeholder="${attr(snapshot.meta.key_example ?? 'PROJ-123')}" autocomplete="off">
<label class="label" for="link-url">Link (optional)</label><input id="link-url" name="url" type="url" pattern="https://.*" placeholder="Built from your tracker settings when empty">
<p class="small muted">The current key stays as an alias. Applies after a 10-second undo window.</p>
<div class="dialog-actions"><button type="submit" class="btn primary">Link</button><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div>
</form>`;
}

export function renderStatusDialog(rawTicket, status) {
  const ticket = normalizeTicket(rawTicket);
  const outstanding = ticket.deployments.filter((d) => d.state === 'pending');
  const needsBlocker = status === 'blocked';
  const needsChoice = status === 'done' && outstanding.length > 0;
  return `<form class="dialog-form" data-form="status" data-ticket="${attr(ticket.id)}" data-revision="${attr(ticket.revision)}" data-status="${attr(status)}">
<h2 id="dialog-title">Set ${keyEl(ticket.key)} to ${esc(STATUS_LABELS[status] ?? status)}</h2>
${needsBlocker ? `<label class="label" for="blocker-text">Blocker (required)</label><textarea id="blocker-text" name="blocker" rows="2" required maxlength="500" placeholder="What is blocking this work?"></textarea>` : ''}
${needsChoice ? `<fieldset><legend>${icon('alert')}${esc(outstanding.length)} deployment obligation${outstanding.length === 1 ? '' : 's'} outstanding — choose one</legend>
  <label><input type="radio" name="deployment_choice" value="record" required> Record deployment evidence for each</label>
  <label><input type="radio" name="deployment_choice" value="waive" required> Waive each with a reason</label>
  <label><input type="radio" name="deployment_choice" value="leave" required> Leave outstanding (ticket stays listed under Deployments)</label>
  <div class="obligations">${outstanding.map((d, i) => `<div class="obligation" data-pr="${attr(d.pr_id)}" data-environment="${attr(d.environment)}"><strong>${esc(d.environment)}</strong> <span class="muted small">PR ${esc(d.pr_id.slice(0, 8))}</span>
    <label class="indent">Deployed at <input type="datetime-local" name="deployed_at_${i}"></label>
    <label class="indent">Evidence <input type="text" name="evidence_${i}" maxlength="500" placeholder="release tag, link, note"></label>
    <label class="indent">Waiver reason <input type="text" name="waiver_${i}" maxlength="500"></label></div>`).join('')}</div>
</fieldset>` : ''}
<div class="dialog-actions"><button type="submit" class="btn primary">Apply</button><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div>
</form>`;
}

export function renderDeploymentDialog(rawTicket, { mode = 'record', deploymentId = null } = {}) {
  const ticket = normalizeTicket(rawTicket);
  const items = ticket.deployments.filter((d) => d.state === 'pending' && (!deploymentId || d.id === deploymentId));
  return `<form class="dialog-form" data-form="deployment" data-ticket="${attr(ticket.id)}" data-revision="${attr(ticket.revision)}">
<h2 id="dialog-title">${icon('rocket')}${mode === 'waive' ? 'Waive' : 'Record'} deployment — ${keyEl(ticket.key)}</h2>
<p class="muted small">Select each PR/environment obligation and provide ${mode === 'waive' ? 'a waiver reason' : 'a timestamp and evidence'}. Rows stay visible until the worker confirms.</p>
<div class="obligations">${items.map((d, i) => `<div class="obligation"><label><input type="checkbox" name="select_${i}" value="${attr(d.id)}" data-pr="${attr(d.pr_id)}" data-environment="${attr(d.environment)}" ${items.length === 1 ? 'checked' : ''}> <strong>${esc(d.environment)}</strong> <span class="muted small">PR ${esc(d.pr_id.slice(0, 8))}, merged ${esc(d.merged_at)}</span></label>
  ${mode === 'waive' ? `<label class="indent">Reason (required) <input type="text" name="waiver_${i}" maxlength="500" required></label>` : `<label class="indent">Deployed at <input type="datetime-local" name="deployed_at_${i}" required></label><label class="indent">Evidence <input type="text" name="evidence_${i}" maxlength="500" placeholder="release tag, link, note"></label>`}
</div>`).join('')}</div>
<div class="dialog-actions"><button type="submit" class="btn primary">${mode === 'waive' ? 'Waive selected' : 'Mark deployed'}</button><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div>
</form>`;
}

export function renderExportDialog(snapshot, preview) {
  const projects = [...new Map(snapshot.tickets.map((t) => [t.project_id, t.project_name])).entries()];
  const fields = ['key', 'title', 'status', 'category', 'priority', 'next_action', 'blocker', 'due', 'last_activity', 'stale', 'tags', 'prs', 'deployments', 'files_touched_count', 'plans_count', 'children_ids', 'summary'];
  const defaults = new Set(['key', 'title', 'status', 'category', 'priority', 'next_action', 'blocker', 'due', 'last_activity', 'stale', 'prs', 'deployments', 'children_ids']);
  return `<form class="dialog-form export-form" data-form="export">
<h2 id="dialog-title">${icon('download')}Export read-only snapshot</h2>
<p class="muted small">Creates a standalone HTML copy with an export time. It will not update, cannot be revoked after you share it, and is saved locally — nothing is uploaded or messaged.</p>
<fieldset><legend>Projects</legend>${projects.map(([id, name]) => `<label><input type="checkbox" name="project" value="${attr(id)}" checked> ${esc(name ?? id)}</label>`).join('')}</fieldset>
<fieldset><legend>Fields</legend><div class="field-grid">${fields.map((f) => `<label><input type="checkbox" name="field" value="${f}" ${defaults.has(f) ? 'checked' : ''}> ${esc(f)}</label>`).join('')}</div></fieldset>
<fieldset><legend>Sensitive content (excluded by default)</legend>
  <label><input type="checkbox" name="include_checkpoints"> Include checkpoint previews</label>
  <label><input type="checkbox" name="include_links"> Include PR and Jira links</label>
</fieldset>
<div class="export-preview" aria-live="polite">${preview ? `<h3>Preview</h3><p>${esc(preview.ticket_count)} ticket(s) · fields: ${preview.fields.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p><p class="small muted">Excluded: ${preview.excluded.map((x) => esc(x)).join(', ')}</p>` : '<p class="muted small">Choose options, then Preview to see exactly what is included.</p>'}</div>
<div class="dialog-actions"><button type="button" class="btn" data-action="export-preview">Preview</button><button type="submit" class="btn primary" ${preview ? '' : 'disabled'}>Save snapshot</button><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div>
</form>`;
}

export function renderHelpDialog() {
  const rows = [['/', 'Focus search'], ['1 – 5', 'Switch view'], ['Enter / Space', 'Open the focused card'], ['h', 'Handoff on a focused eligible card'], ['Escape', 'Close detail or dialog, restore focus'], ['Left / Right', 'Previous / next record while the detail navigation control is focused'], ['?', 'This help']];
  return `<div class="dialog-form"><h2 id="dialog-title">Keyboard shortcuts</h2><table class="shortcuts">${rows.map(([k, d]) => `<tr><th scope="row"><kbd>${esc(k)}</kbd></th><td>${esc(d)}</td></tr>`).join('')}</table><p class="muted small">Shortcuts never run inside inputs or while a dialog owns focus.</p><div class="dialog-actions"><button type="button" class="btn primary" data-action="close-dialog">Close</button></div></div>`;
}
