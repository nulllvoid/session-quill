// Memory (spec §6.4, ADR 0027): what runs have learned and the owner's notes, by Repo, Machine and
// Quarantine, with trust in words, where each entry came from, and the owner's actions (Approve,
// Edit, Pin, Retire). Owner-only: the data comes from the owner endpoint, never from a snapshot, so a
// static export has no Memory view and no memory text. Every entry text is agent output and escaped.
import { esc, attr, icon, timeEl, emptyState, normalizeSnapshot, requestFeedback, trustChip, repoName } from '../components.js';

export const MEMORY_TABS = ['repo', 'machine', 'quarantine'];
export const MEMORY_TAB_LABELS = { repo: 'Repo', machine: 'Machine', quarantine: 'Quarantine' };
const MEMORY_IN_FLIGHT = new Set(['sending', 'pending', 'applying']);
const SECTION_LABELS = { build: 'Build & test', conventions: 'Conventions', docs: 'Docs & runbooks', environments: 'Environments & deploy', procedures: 'Procedures', pitfalls: 'Pitfalls', tools: 'Tools', connectors: 'Connectors & MCP', how: 'How', where: 'Where' };

const MEMORY_EMPTY = {
  repo: ['No repository memory', 'What runs learn about a repository (build and test, conventions, environments, pitfalls) appears here once a run on it finishes.'],
  machine: ['No machine memory', 'What runs learn about this machine (tools, connectors, where things live) appears here.'],
  quarantine: ['Nothing awaiting approval', 'Learnings held for you appear here: anything cited from tool output or external text, anything from a page-proposed run, and text that reads like instructions.'],
};

const inTab = (e, tab) => (tab === 'quarantine' ? e.trust === 'quarantined' : e.trust !== 'quarantined' && e.scope === tab);

// The repositories with repo entries outside quarantine, in snapshot order then by id.
export function memoryRepos(memory, snapshot) {
  const ids = [...new Set((memory ? memory.entries : []).filter((e) => inTab(e, 'repo')).map((e) => e.repo_id))];
  const order = (snapshot.repos ?? []).map((r) => r.id);
  return ids.sort((a, b) => ((order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9)) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The entries one tab shows: its scope (Repo: one repository), matching the search text. */
export function memoryTabEntries(memory, tab, { q = '', repo = null } = {}) {
  const needle = String(q ?? '').trim().toLowerCase();
  return (memory ? memory.entries : []).filter((e) => inTab(e, tab) && (tab !== 'repo' || !repo || e.repo_id === repo) && (!needle || `${e.text} ${e.key ?? ''} ${e.section ?? ''}`.toLowerCase().includes(needle)));
}

export const MEMORY_BUSY_MESSAGE = 'A change to this entry is still being applied';

// Requests for one entry, oldest first: by created_at, and a request still being sent (no
// created_at yet) after every recorded one; ties keep the order they were given in.
function entryRequests(entryId, requests) {
  const list = [...requests].map((r, i) => ({ r, i })).filter(({ r }) => typeof r.kind === 'string' && r.kind.startsWith('memory-') && r.target_id === entryId);
  const key = ({ r }) => (typeof r.created_at === 'string' ? r.created_at : '￿');
  return list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.i - b.i)).map(({ r }) => r);
}

/** Whether a change to this entry is being sent, waiting out its undo window or applying. */
export function memoryEntryBusy(entryId, requests) {
  return entryRequests(entryId, requests).some((r) => MEMORY_IN_FLIGHT.has(r.state));
}

/** The request an entry shows: its newest in-flight one, else its newest conflict or failure
 * unless a later change to the entry applied (an old conflict says nothing about the entry now). */
export function memoryRequestFor(entryId, requests) {
  const list = entryRequests(entryId, requests);
  const inFlight = list.filter((r) => MEMORY_IN_FLIGHT.has(r.state));
  if (inFlight.length) return inFlight.at(-1);
  const last = list.filter((r) => r.state === 'applied' || r.state === 'conflict' || r.state === 'failed').at(-1);
  return last && last.state !== 'applied' ? last : null;
}

/** Edit state for an entry: the text the form opens with (a kept draft, else the entry's text). The
 * markup carries only this, never what is typed afterwards, so a poll does not rebuild the field. */
export function openMemoryEdit(entry, drafts = {}) {
  return { id: entry.id, text: typeof drafts[entry.id] === 'string' ? drafts[entry.id] : entry.text };
}

function sourceRun(e, snapshot, now, tz) {
  if (!e.run_id) return e.trust === 'owner' ? 'Your note' : null;
  const run = (snapshot.handoffs ?? []).find((h) => h.id === e.run_id);
  const label = `run ${e.run_id.slice(0, 8)}`;
  return `From ${run ? `<button type="button" class="link" data-action="open-run" data-run="${attr(run.id)}">${esc(label)}</button>${run.finished_at ? ` ${timeEl(run.finished_at, now, tz)}` : ''}` : esc(label)}`;
}

function editForm(e, editing) {
  const field = `memory-edit-text-${e.id}`;
  return `<form class="memory-edit" data-form="memory-edit" data-entry="${attr(e.id)}" data-revision="${attr(e.revision)}"><label for="${attr(field)}">Owner wording</label><textarea id="${attr(field)}" name="text" rows="3" maxlength="2000" required data-memory-draft="${attr(e.id)}" aria-describedby="${attr(`${field}-help`)}">${esc(editing.text)}</textarea><p class="small muted" id="${attr(`${field}-help`)}">Saved as your entry: it keeps this id, becomes Owner and never goes stale.</p><div class="memory-actions"><button type="submit" class="btn small primary">Save</button> <button type="button" class="btn small ghost" data-action="memory-edit-cancel" data-entry="${attr(e.id)}">Cancel</button></div></form>`;
}

function entryItem(e, snapshot, { now, tz, pending, editing, canAct }) {
  const req = memoryRequestFor(e.id, pending);
  const busy = memoryEntryBusy(e.id, pending);
  const isEditing = !!(editing && editing.id === e.id);
  const textId = `memory-text-${e.id}`;
  const chips = [trustChip(e.trust)];
  if (e.pinned) chips.push(`<span class="chip small" data-pinned="true">${icon('check')}Pinned</span>`);
  // ADR 0032: an entry whose cited source changed says so; one unconfirmed for 90 days is plain stale.
  if (e.staleness === 'stale') chips.push(e.stale_reason === 'anchor-changed' ? `<span class="chip stale small" data-stale="anchor-changed" title="The file this entry cites changed since it was recorded. A run that confirms it again, or your edit, brings it back.">${icon('clock')}Source changed · not delivered to runs</span>` : `<span class="chip stale small">${icon('clock')}Stale · not delivered to runs</span>`);
  if (e.conflict_key) chips.push(`<span class="chip warning small" data-conflict="true">${icon('alert')}Conflict on key ${esc(e.conflict_key)}</span>`);
  const section = SECTION_LABELS[e.section] ?? (e.section || null);
  const meta = [];
  const source = sourceRun(e, snapshot, now, tz);
  if (source) meta.push(`<span>${source}</span>`);
  if (e.last_confirmed_at) meta.push(`<span>Last confirmed ${timeEl(e.last_confirmed_at, now, tz)}</span>`);
  meta.push(`<span>Confirmed ${esc(e.confirmations ?? 0)}×</span>`);
  if (e.scope === 'repo' && e.trust === 'quarantined') meta.push(`<span>Repo ${esc(repoName(snapshot, e.repo_id) ?? e.repo_id)}</span>`);
  if (e.scope === 'task') meta.push('<span>Task note</span>');
  const held = e.trust === 'quarantined' ? `<p class="memory-held small" data-level="warning">${icon('alert')}Held: ${esc(e.quarantine_reason || 'awaiting your approval')}</p>` : '';
  const dis = busy ? ' disabled' : '';
  const actions = !canAct || isEditing ? '' : `<div class="memory-actions">${e.trust === 'quarantined' ? `<button type="button" class="btn small primary" data-action="memory-approve" data-entry="${attr(e.id)}" data-revision="${attr(e.revision)}" aria-describedby="${attr(textId)}"${dis}>Approve</button> ` : ''}<button type="button" class="btn small" data-action="memory-edit" data-entry="${attr(e.id)}" aria-describedby="${attr(textId)}"${dis}>Edit</button> ${e.trust === 'quarantined' ? '' : `<button type="button" class="btn small ghost" data-action="memory-pin" data-entry="${attr(e.id)}" data-pinned="${e.pinned ? 'false' : 'true'}" data-revision="${attr(e.revision)}" aria-describedby="${attr(textId)}"${dis}>${e.pinned ? 'Unpin' : 'Pin'}</button> `}<button type="button" class="btn small ghost" data-action="memory-retire" data-entry="${attr(e.id)}" data-revision="${attr(e.revision)}" aria-describedby="${attr(textId)}"${dis}>Retire</button></div>`;
  return `<li class="memory-entry" data-entry="${attr(e.id)}" data-trust="${attr(e.trust)}"><div class="memory-head">${chips.join(' ')}${section ? ` <span class="small muted">${esc(section)}</span>` : ''}</div><p class="memory-text" id="${attr(textId)}" tabindex="-1">${esc(e.text)}</p>${held}<p class="memory-meta small muted">${meta.join(' · ')}</p>${isEditing && canAct ? editForm(e, editing) : actions}${req ? requestFeedback(req, { now }) : ''}</li>`;
}

export function renderMemory(memory, rawSnapshot, { now, tab = null, repo = null, pending = [], editing = null, status = null, filters = {}, online = true } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const tz = snapshot.meta.timezone;
  if (!memory) {
    const body = status && status.error
      ? `<section class="empty" role="alert"><h2>Memory could not be loaded</h2><p>${esc(status.error)}</p><button type="button" class="btn small" data-action="memory-reload">${icon('refresh')}Retry</button></section>`
      : '<div class="skeleton" role="status" aria-label="Loading memory"><span></span><span></span><span></span></div>';
    return `<section class="view view-memory" aria-labelledby="tab-memory">${body}</section>`;
  }
  const current = MEMORY_TABS.includes(tab) ? tab : memory.entries.some((e) => e.trust === 'quarantined') && !memory.entries.some((e) => e.trust !== 'quarantined') ? 'quarantine' : 'repo';
  const repos = memoryRepos(memory, snapshot);
  const chosenRepo = repos.includes(repo) ? repo : repos.includes(filters.repo) ? filters.repo : repos[0] ?? null;
  const counts = Object.fromEntries(MEMORY_TABS.map((t) => [t, memoryTabEntries(memory, t).length]));
  const tablist = `<div class="run-tabs memory-tabs" role="tablist" aria-label="Memory">${MEMORY_TABS.map((t) => `<button type="button" role="tab" id="memory-tab-${t}" data-action="memory-tab" data-tab="${t}" aria-selected="${t === current}" aria-controls="memory-panel" tabindex="${t === current ? 0 : -1}">${esc(MEMORY_TAB_LABELS[t])} <span class="count">${esc(counts[t])}</span></button>`).join('')}</div>`;
  const selector = current === 'repo' && repos.length > 1
    ? `<p class="memory-repo"><label for="memory-repo">Repository</label> <select id="memory-repo" data-memory-repo>${repos.map((id) => `<option value="${attr(id)}"${id === chosenRepo ? ' selected' : ''}>${esc(repoName(snapshot, id) ?? id)}</option>`).join('')}</select></p>`
    : '';
  const shown = memoryTabEntries(memory, current, { q: filters.q, repo: current === 'repo' ? chosenRepo : null });
  const canAct = !!(snapshot.capabilities && snapshot.capabilities.edit_tickets) && online;
  const conflictsHere = current === 'quarantine' ? 0 : new Set(shown.filter((e) => e.conflict_key).map((e) => e.conflict_key)).size;
  const conflictNote = conflictsHere ? `<p class="memory-conflicts small" data-level="warning">${icon('alert')}${esc(conflictsHere)} conflict${conflictsHere === 1 ? '' : 's'} here: entries with the same key disagree. Runs get only the higher-ranked entry until you retire or edit the other.</p>` : '';
  let body;
  if (!memory.entries.length) body = emptyState('No memory yet', 'Runs file what they learn when they finish. Add your own notes with quill memory note; they are delivered first and never go stale.');
  else if (!shown.length && String(filters.q ?? '').trim() && counts[current]) body = emptyState('No entries match', `Nothing in ${MEMORY_TAB_LABELS[current]} matches the search. Clear the search to see every entry.`);
  else if (!shown.length) body = emptyState(MEMORY_EMPTY[current][0], MEMORY_EMPTY[current][1]);
  else body = `${conflictNote}<ul class="memory-list">${shown.map((e) => entryItem(e, snapshot, { now, tz, pending, editing, canAct })).join('')}</ul>`;
  return `<section class="view view-memory" aria-labelledby="tab-memory">${tablist}<div role="tabpanel" id="memory-panel" aria-labelledby="memory-tab-${current}">${selector}${body}</div></section>`;
}
