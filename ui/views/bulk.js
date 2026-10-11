// Bulk selection UI (ADR 0023): the Select toggle, the per-card checkbox, the bulk action bar, the
// bulk run form and its per-ticket results, the bulk status dialog and batch progress strips.
import { esc, attr, icon, keyEl, countLabel, normalizeSnapshot, accessFieldset, STATUS_LABELS, ticketById } from '../components.js';
import { bulkEntries, bulkOutcome, batchProgress } from '../lib/bulk.js';
import { runSummary } from './agents.js';

export function canSelect(snapshot) {
  const caps = snapshot.capabilities ?? {};
  return !!(caps.handoff || caps.edit_tickets);
}

export function renderSelectToggle({ selecting = false, count = 0 } = {}) {
  return `<div class="view-toolbar"><button type="button" class="btn small" data-action="toggle-select" aria-pressed="${selecting ? 'true' : 'false'}">${icon('check')}${selecting ? `Done selecting${count ? ` (${esc(count)})` : ''}` : 'Select'}</button>${selecting ? '<span class="muted small">x toggles the focused card · Shift-click selects a range · Esc clears</span>' : ''}</div>`;
}

// The checkbox sits beside the card, never inside its role="button" article.
export function selectableCard(cardHtml, ticket, { checked = false } = {}) {
  return `<div class="card-pick"><input type="checkbox" class="card-check" data-check="${attr(ticket.id)}" aria-label="${attr(`Select ${ticket.key} ${ticket.title}`)}"${checked ? ' checked' : ''}>${cardHtml}</div>`;
}

// Which buttons the bar holds. While it stays the same, the shell updates the counts in place, so
// focus stays on the button the owner is on and the entrance animation does not replay.
export function bulkBarShape({ count = 0, undo = 0 } = {}) {
  return `${count ? 'actions' : 'none'}-${undo ? 'undo' : 'no-undo'}`;
}

// A labelled group, not a toolbar: a toolbar promises arrow-key roving focus, and these few
// buttons are reached with Tab like any other.
export function renderBulkActionBar({ count = 0, undo = 0 } = {}) {
  const actions = count ? `<button type="button" class="btn small" data-action="bulk-handoff" data-mode="analyse">${icon('analysis')}Analyze</button>
  <button type="button" class="btn small" data-action="bulk-handoff" data-mode="attempt-fix">${icon('play')}Attempt fix</button>
  <button type="button" class="btn small" data-action="bulk-status">Change status</button>
  <button type="button" class="btn small ghost" data-action="bulk-clear">Clear</button>` : '';
  // One label span: the button is a flex row with a gap, which would otherwise space out "Undo all (", the count and ")".
  const undoBtn = undo ? `<button type="button" class="btn small" data-action="bulk-undo-all">${icon('undo')}<span class="bulk-undo-label">Undo all (<span class="bulk-undo-count">${esc(undo)}</span>)</span></button>` : '';
  return `<div class="bulk-bar" role="group" aria-label="Bulk actions" data-shape="${bulkBarShape({ count, undo })}">${count ? `<span class="bulk-count">${esc(count)} selected</span>` : ''}${actions}${undoBtn}</div>`;
}

const ENTRY_LABELS = { ready: 'Ready', running: 'Already running', 'no-repo': 'No repo', 'not-eligible': 'Not eligible' };

function entryRow(e) {
  const t = e.ticket;
  const label = e.state === 'ready' && e.waits ? 'Waits for repo' : ENTRY_LABELS[e.state];
  const hint = e.state === 'ready' && e.notesOnly ? ' <span class="muted small">(notes only: no repository)</span>' : e.state === 'not-eligible' ? ` <span class="muted small">(${esc(STATUS_LABELS[t.status] ?? t.status)})</span>` : '';
  return `<li class="bulk-entry" data-state="${attr(e.state)}">${keyEl(t.key)} <span class="bulk-entry-title">${esc(t.title)}</span> <span class="chip small" data-entry="${attr(e.waits ? 'waits' : e.state)}">${esc(label)}</span>${hint}</li>`;
}

export function renderBulkHandoffForm(rawSnapshot, ids, { mode = 'analyse' } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const fix = mode === 'attempt-fix';
  const entries = bulkEntries(snapshot, ids, { mode });
  const ready = entries.filter((e) => e.state === 'ready');
  const limits = snapshot.meta.handoff_limits ?? { readonly: 2, fix: 1 };
  const cap = fix ? `At most ${esc(limits.fix)} fix run${limits.fix === 1 ? '' : 's'} at a time, and one per repository; the rest queue.` : `At most ${esc(limits.readonly)} read-only run${limits.readonly === 1 ? '' : 's'} at a time; the rest queue.`;
  const repos = [...new Set(ready.map((e) => e.ticket.repo_id).filter(Boolean))].map((id) => (snapshot.repos ?? []).find((r) => r.id === id)).filter(Boolean);
  const tests = fix ? `<ul class="small bulk-tests">${repos.map((r) => `<li>${esc(r.display_name)}: ${r.test_command ? `Tests: <code>${esc(r.test_command)}</code> (run by the worker after each fix)` : 'No test command: fixes are not test-verified'}</li>`).join('')}</ul>` : '';
  const modes = fix
    ? '<input type="hidden" name="mode" value="attempt-fix"><p class="small"><strong>Recipe:</strong> attempt-fix, each in its own isolated checkout.</p>'
    : `<fieldset><legend>Recipe</legend>
  <label><input type="radio" name="mode" value="analyse" checked> Analyse: summarize and recommend; no children</label>
  <label><input type="radio" name="mode" value="analyse-followups"> Analyse with follow-ups: may create child tickets and suggest a next action</label>
</fieldset>`;
  // The built-in recipe's defaults; the repository varies per ticket, so the test line stays generic.
  const builtin = (snapshot.recipes ?? []).find((r) => r.source === 'builtin' && r.mode === mode) ?? { legacy: true };
  const summary = runSummary(builtin, fix ? { read_source: true, edit_source: true } : { read_source: true }, null);
  return `<form class="handoff-form bulk-form" data-form="bulk-handoff" data-ids="${attr(ids.join(','))}">
<h2 id="dialog-title">${icon('play')}${fix ? 'Attempt fix' : 'Analyze'} for ${esc(countLabel(ids.length, 'ticket'))}</h2>
<ul class="bulk-entries">${entries.map(entryRow).join('')}</ul>
<p class="small"><strong>${esc(countLabel(ready.length, 'run'))}</strong> will be queued, one per ready ticket. ${cap}</p>
${modes}
${accessFieldset()}
${tests}
<label class="label" for="bulk-note">Note for every run <span class="muted">(max 280)</span></label>
<textarea id="bulk-note" name="note" maxlength="280" rows="2" placeholder="What should each agent focus on?"></textarea>
<p class="run-summary">${esc(summary)}</p>
${fix && ready.length ? `<label class="danger confirm-edit"><input type="checkbox" name="confirm_edit" required> <span>Allow ${esc(countLabel(ready.length, 'run'))} to edit source (edit_source), each in an isolated checkout. Nothing is committed or pushed.</span></label>` : ''}
<div class="dialog-actions"><button type="submit" class="btn primary"${ready.length ? '' : ' disabled'}>Queue ${esc(countLabel(ready.length, 'run'))}</button><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div>
</form>`;
}

// Per-ticket results of a bulk submit, live from each request's state.
export function renderBulkResults(rawSnapshot, { batchId = null, rows = [], requests = [] } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const byId = new Map((requests ?? []).map((r) => [r.id, r]));
  const items = rows.map((row) => {
    const t = ticketById(snapshot, row.ticketId);
    const req = row.requestId ? byId.get(row.requestId) : null;
    const outcome = row.requestId ? bulkOutcome(req) : { label: row.reason ?? 'Skipped', tone: 'neutral' };
    return `<li class="bulk-result" data-tone="${attr(outcome.tone)}">${t ? `${keyEl(t.key)} <span class="bulk-entry-title">${esc(t.title)}</span>` : esc(row.ticketId)} <span class="chip small ${attr(outcome.tone === 'neutral' ? '' : outcome.tone)}">${esc(outcome.label)}</span></li>`;
  }).join('');
  return `<div class="bulk-results"><h2 id="dialog-title">${icon('play')}Bulk run${batchId ? ` <span class="muted small">batch ${esc(batchId.slice(0, 8))}</span>` : ''}</h2>
<ul class="bulk-entries">${items}</ul>
<p class="muted small">Queued runs report on each ticket and in the progress strip. "Stale, refresh" means the ticket changed first: refresh and queue it again.</p>
<div class="dialog-actions"><button type="button" class="btn primary" data-action="close-dialog">Close</button></div></div>`;
}

const BULK_STATUSES = ['todo', 'active', 'review', 'deploy-pending', 'blocked', 'done'];

export function renderBulkStatusDialog(count) {
  return `<form class="dialog-form bulk-form" data-form="bulk-status">
<h2 id="dialog-title">Change status of ${esc(countLabel(count, 'ticket'))}</h2>
<fieldset><legend>New status</legend>${BULK_STATUSES.map((s, i) => `<label><input type="radio" name="status" value="${attr(s)}"${i === 1 ? ' checked' : ''}> ${esc(STATUS_LABELS[s])}</label>`).join('')}</fieldset>
<label class="label" for="bulk-blocker">Blocker <span class="muted">(required for Blocked)</span></label>
<textarea id="bulk-blocker" name="blocker" maxlength="500" rows="2"></textarea>
<p class="muted small">Each ticket gets its own change with a 10 second undo; Undo all reverts every change still waiting. Tickets already in the status, and Done for tickets with an outstanding deployment, are skipped.</p>
<div class="dialog-actions"><button type="submit" class="btn primary">Change status</button><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button></div>
</form>`;
}

// One strip per batch: how many runs finished, are running or still queue, with Cancel batch for
// the queued ones.
export function renderBatchStrips(rawSnapshot, batchIds, { canCancel = false } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const strips = batchIds.map((id) => {
    const p = batchProgress(snapshot, id);
    if (!p.total) return '';
    const finished = p.done + p.failed + p.cancelled;
    const parts = [p.done ? `${p.done} done` : null, p.failed ? `${p.failed} failed` : null, p.cancelled ? `${p.cancelled} cancelled` : null, p.running ? `${p.running} running` : null, p.queued ? `${p.queued} queued` : null].filter(Boolean);
    const action = canCancel && p.queued ? `<button type="button" class="btn small ghost" data-action="cancel-batch" data-batch="${attr(id)}">Cancel batch (${esc(p.queued)} queued)</button>` : !p.queued && !p.running ? `<button type="button" class="btn small ghost" data-action="dismiss-batch" data-batch="${attr(id)}">Dismiss</button>` : '';
    return `<div class="batch-strip" data-batch="${attr(id)}"><span class="eyebrow">Batch ${esc(id.slice(0, 8))}</span><div class="batch-bar" role="progressbar" aria-label="${attr(`Batch ${id.slice(0, 8)}: ${finished} of ${p.total} runs finished`)}" aria-valuemin="0" aria-valuenow="${finished}" aria-valuemax="${p.total}"><span style="width:${Math.round((finished / p.total) * 100)}%"></span></div><span class="small">${esc(parts.join(' · '))}</span><button type="button" class="link small" data-action="open-runs" data-tab="all">View in Runs</button>${action}</div>`;
  }).join('');
  return strips ? `<section class="batch-strips" aria-label="Bulk runs">${strips}</section>` : '';
}
