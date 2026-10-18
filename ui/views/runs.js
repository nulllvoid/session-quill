// Runs (spec §2): every agent run and proposed run, by what needs the owner, grouped by batch. Rows
// open the run detail; nothing here acts except batch cancel and proposal approve or dismiss. Needs
// you also lists quarantined learnings and memory conflicts, which open the Memory page (spec §6.4).
import { esc, attr, timeEl, handoffChip, ticketById, normalizeSnapshot, emptyState, proposalItem, shortKey, HANDOFF_LABELS, learningItem, memoryConflictItem } from '../components.js';
import { batchProgress } from '../lib/bulk.js';
import { runTabs, visibleRunTabs, defaultRunTab, groupRuns, runFacts, RUN_TAB_LABELS } from '../lib/runs.js';
import { testGateBadge, accessBadge } from './agents.js';

const EMPTY = {
  needs: ['Nothing needs you', 'Proposed runs, results with suggestions to decide on, recent failures, quarantined learnings and memory conflicts appear here.'],
  live: ['No runs queued or running', 'Start one with Run agent on a ticket, or select tickets on Board for a bulk run.'],
  failed: ['No failed runs', 'Failed, timed-out and cancelled runs appear here with what went wrong.'],
  all: ['No runs in the last 30 days', 'Agent runs and proposed runs appear here as they are requested.'],
};

export function runRow(snapshot, h, { now, tz, selected = false }) {
  const t = ticketById(snapshot, h.ticket_id);
  const name = h.recipe ? h.recipe.name : h.mode;
  const facts = runFacts(snapshot, h, now);
  const label = `${t ? t.key : 'Ticket not in view'}: ${name}, ${HANDOFF_LABELS[h.state] ?? h.state}${facts.length ? `, ${facts.join(', ')}` : ''}`;
  const ticket = t ? `<code class="key" title="${attr(t.key)}">${esc(shortKey(t.key))}</code> <span class="run-title">${esc(t.title)}</span>` : '<span class="muted">Ticket not in view</span>';
  return `<li class="run-row" data-state="${attr(h.state)}"><button type="button" class="run-open" data-action="open-run" data-run="${attr(h.id)}" aria-label="${attr(label)}" aria-pressed="${selected ? 'true' : 'false'}">${handoffChip({ ...h, error: null })}<span class="run-ticket">${ticket}</span><span class="run-recipe">${esc(name)}</span><span class="run-badges">${accessBadge(h)} ${testGateBadge(h.test_gate)}</span><span class="run-facts small muted">${esc(facts.join(' · '))}</span><span class="run-time small muted">${timeEl(h.requested_at, now, tz)}</span></button></li>`;
}

function proposalRow(snapshot, p, { now, pending }) {
  if (p.state !== 'expired') return proposalItem(p, snapshot, { now, pending, withTicket: true }).replace('<li class="proposal"', '<li class="proposal run-row" data-state="proposed"');
  const t = ticketById(snapshot, p.ticket_id);
  const why = !t ? 'ticket not found' : t.status === 'done' ? 'ticket is done' : 'older than 7 days';
  return `<li class="proposal run-row" data-proposal="${attr(p.id)}" data-state="expired"><strong>${esc(p.recipe.name)}</strong> <span class="muted small">${t ? esc(t.key) : ''} proposed ${timeEl(p.proposed_at, now, snapshot.meta.timezone)}</span> <span class="chip small">Expired · ${esc(why)}</span></li>`;
}

function batchGroup(snapshot, g, { now, tz, caps, selectedRun }) {
  const p = batchProgress(snapshot, g.id);
  const finished = p.done + p.failed + p.cancelled;
  const names = [...new Set(g.items.map((i) => (i.run.recipe ? i.run.recipe.name : i.run.mode)))];
  const parts = [p.done ? `${p.done} done` : null, p.running ? `${p.running} running` : null, p.queued ? `${p.queued} queued` : null, p.failed ? `${p.failed} failed` : null, p.cancelled ? `${p.cancelled} cancelled` : null].filter(Boolean);
  const cancel = caps.handoff && p.queued ? `<button type="button" class="btn small ghost" data-action="cancel-batch" data-batch="${attr(g.id)}">Cancel queued (${esc(p.queued)})</button>` : '';
  const pct = p.total ? Math.round((finished / p.total) * 100) : 0;
  return `<li class="run-batch" data-batch="${attr(g.id)}"><div class="run-batch-head"><span class="eyebrow">Batch ${esc(g.id.slice(0, 8))}</span><span class="small">${esc(names.length === 1 ? names[0] : 'mixed')} · ${esc(parts.join(' · '))}</span><div class="batch-bar" role="progressbar" aria-label="${attr(`Batch ${g.id.slice(0, 8)}: ${finished} of ${p.total} runs finished`)}" aria-valuemin="0" aria-valuenow="${finished}" aria-valuemax="${p.total}"><span style="width:${pct}%"></span></div>${cancel}</div><ul class="run-list">${g.items.map((i) => runRow(snapshot, i.run, { now, tz, selected: selectedRun === i.id })).join('')}</ul></li>`;
}

export function renderRuns(rawSnapshot, filters, { now, pending = [], tab = null, selectedRun = null, memory = null } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const tz = snapshot.meta.timezone;
  const caps = snapshot.capabilities ?? {};
  const tabs = runTabs(snapshot, filters, now, { memory });
  const names = visibleRunTabs(snapshot);
  const current = names.includes(tab) ? tab : defaultRunTab(tabs, names);
  const tablist = `<div class="run-tabs" role="tablist" aria-label="Run filters">${names.map((n) => `<button type="button" role="tab" id="run-tab-${n}" data-action="run-tab" data-tab="${n}" aria-selected="${n === current}" aria-controls="run-panel" tabindex="${n === current ? 0 : -1}">${esc(RUN_TAB_LABELS[n])}${n === 'all' ? '' : ` <span class="count">${esc(tabs[n].length)}</span>`}</button>`).join('')}</div>`;
  const entries = groupRuns(tabs[current]);
  const body = entries.length
    ? `<ul class="run-list">${entries.map((e) => (e.kind === 'batch' ? batchGroup(snapshot, e, { now, tz, caps, selectedRun }) : e.kind === 'proposal' ? proposalRow(snapshot, e.proposal, { now, pending }) : e.kind === 'learning' ? learningItem(e.entry, snapshot, { now }) : e.kind === 'memory-conflict' ? memoryConflictItem(e.conflict, snapshot) : runRow(snapshot, e.run, { now, tz, selected: selectedRun === e.id }))).join('')}</ul>`
    : emptyState(EMPTY[current][0], EMPTY[current][1]);
  return `<section class="view view-runs" aria-labelledby="tab-runs">${tablist}<div id="run-panel" role="tabpanel" aria-labelledby="run-tab-${current}">${body}</div></section>`;
}
