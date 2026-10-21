// Dashboard shell: state, polling, routing, keyboard, dialogs and request feedback (UI-DESIGN.md).
import { esc, attr, icon, ticketById, STATUS_LABELS, normalizeSnapshot, EMPTY_FILTERS, filtersFromHash, NEEDS_CLONE_FILTER, scopeChoices, tracksSnapshotRequest } from './components.js';
import { renderHeader, renderSidebar, renderPageHeading, SHORTCUT_VIEWS, OWNER_ONLY_VIEWS, renderFilterBar, receiptLifetime } from './views/header.js';
import { renderMemory, MEMORY_TABS, memoryEntryBusy, openMemoryEdit, MEMORY_BUSY_MESSAGE } from './views/memory.js';
import { renderRuns } from './views/runs.js';
import { renderRunDetail, renderRunNotFound, parseRunRecord } from './views/run-detail.js';
import { renderPickNext } from './views/picknext.js';
import { renderBoard } from './views/board.js';
import { renderTree } from './views/tree.js';
import { renderSessions } from './views/sessions.js';
import { renderDeployments } from './views/deployments.js';
import { renderToday } from './views/today.js';
import { renderDetail, DETAIL_TABS } from './views/detail.js';
import { renderRunAgentDialog } from './views/run-dialog.js';
import { renderStatusDialog, renderDeploymentDialog, renderExportDialog, renderHelpDialog, renderAttachDialog, renderLinkExternalDialog, renderCloneDialog, renderSchedulesDialog, schedulesDialogKey, renderPublishDialog, publishDialogKey } from './views/dialogs.js';
import { createApi, uuidv4 } from './lib/api.js';
import { createDashboardMotion } from './lib/motion.js';
import { effectiveRecipes, runSummary } from './views/agents.js';
import { renderBulkActionBar, bulkBarShape, renderBulkHandoffForm, renderBulkResults, renderBulkStatusDialog, renderBatchStrips } from './views/bulk.js';
import { freshProposals, proposalNotice } from './lib/proposals.js';
import { toggleChecked, selectRange, selectionKey, bulkEntries, bulkRequests, bulkStatusRequests, pendingUndo, mergeUndo, batchDialogUpdate, withoutIds, pruneChecked, activeBatches } from './lib/bulk.js';

const VIEWS = ['picknext', 'board', 'tree', 'sessions', 'deployments', 'today', 'runs', 'memory'];
const POLL_VISIBLE_MS = 2000;
const POLL_HIDDEN_MS = 30000;

const appState = {
  moreOpen: false,
  snapshot: null,
  online: true,
  view: 'picknext',
  filters: { ...EMPTY_FILTERS },
  selected: null,
  runTab: null,
  // Needs you grouping (ADR 0039): 'attention' (default) or 'none' (one list); `group=` in the hash.
  runGroup: 'attention',
  selectedRun: null,
  detailTab: 'overview',
  detailExpanded: false,
  sidebarCollapsed: false,
  requests: new Map(),
  refresh: null,
  dialog: null,
  theme: null,
  boardToggled: new Set(),
  blockedExpanded: false,
  editingNext: null,
  boardPages: {},
  sessionsPage: 0,
  treeRoot: null,
  content: {},
  contentStatus: {},
  // Result blobs read as run records (run detail sections), by content hash: { status: 'loading' } | { data } | { error }.
  runRecords: {},
  // ADR 0040: a run's patch and critic notes, by content hash: { status: 'loading' } | { text } | { error }.
  runBlobs: {},
  // Diff files the owner opened or closed in run detail, by `<patch_ref>:<path>`.
  diffOpen: {},
  loadedTicket: null,
  lastFocus: null,
  error: null,
  receipt: null,
  endpoint: typeof location !== 'undefined' && location.host ? location.host : null,
  // Bulk selection (ADR 0023). `checked` is the bulk selection; `selected` stays the open ticket.
  selecting: false,
  checked: new Set(),
  checkAnchor: null,
  batches: [],
  bulkUndo: [],
  // Request id -> the submit still sending it, so Undo all can cancel it once it lands.
  sending: new Map(),
  // Ids of open proposed runs already seen (ADR 0025); null until the first poll.
  proposalsSeen: null,
  // Memory (spec §6.4): owner-only, fetched from its own endpoint, never part of a snapshot.
  memory: null,
  memoryStatus: null,
  memoryTab: null,
  memoryRepo: null,
  memoryEditing: null,
  memoryDrafts: {},
  // ADR 0031: the "Valid for" choice on each critical change item, by proposal id, kept across polls.
  leases: {},
  // Request ids whose conflict or failure the owner dismissed; syncRequests leaves them out.
  dismissedRequests: new Set(),
};

// A read-only snapshot (export) has no owner-only views, whatever its address says.
const staticPage = () => typeof window !== 'undefined' && !!window.__SNAPSHOT__;
const ownerView = (view) => !(OWNER_ONLY_VIEWS.has(view) && staticPage());

const BULK_VIEWS = new Set(['board', 'picknext']);

let receiptTimer = null;
function setReceipt(text, tone = 'neutral') {
  const receipt = { text, tone, at: nowIso() };
  appState.receipt = receipt;
  clearTimeout(receiptTimer);
  const ms = receiptLifetime(tone);
  if (ms) receiptTimer = setTimeout(() => { if (appState.receipt === receipt) { appState.receipt = null; render(); } }, ms);
}

let api;
let pollTimer = null;
let countdownTimer = null;
let motion;
let detailCloseVersion = 0;
let renderedView = null;
let renderedDetail = null;
const renderedMarkup = new WeakMap();

// Preserve DOM nodes (and focus, hover and active animations) on unchanged polls.
function setMarkup(element, html) {
  if (renderedMarkup.get(element) === html) return;
  element.innerHTML = html;
  renderedMarkup.set(element, html);
}

function $(sel) { return document.querySelector(sel); }
function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function announce(text) { const el = $('#live'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = text; }, 30); } }

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const view = params.get('view');
  if (VIEWS.includes(view) && ownerView(view)) appState.view = view;
  appState.filters = filtersFromHash(location.hash, appState.filters, VIEWS);
  appState.selected = params.get('ticket') || null;
  appState.treeRoot = params.get('root') || null;
  appState.runTab = params.get('tab') || null;
  appState.runGroup = params.get('group') === 'none' ? 'none' : 'attention';
  appState.selectedRun = appState.view === 'runs' ? params.get('run') || null : null;
  appState.memoryTab = appState.view === 'memory' && MEMORY_TABS.includes(params.get('mtab')) ? params.get('mtab') : null;
  appState.memoryRepo = appState.view === 'memory' ? params.get('mrepo') || null : null;
  const section = params.get('section');
  if (appState.selected && DETAIL_TABS.includes(section)) appState.detailTab = section;
}

// The drawer belongs to the view it was opened from: switching views closes it.
function setView(view) {
  if (view === appState.view || !ownerView(view)) return;
  appState.view = view;
  appState.treeRoot = null;
  appState.selected = null;
  appState.selectedRun = null;
  appState.runTab = null;
  appState.detailTab = 'overview';
  appState.detailExpanded = false;
  appState.editingNext = null;
  appState.loadedTicket = null;
  appState.memoryTab = null;
  appState.memoryRepo = null;
  appState.memoryEditing = null;
}

function writeHash() {
  const params = new URLSearchParams();
  params.set('view', appState.view);
  for (const [k, v] of Object.entries(appState.filters)) if (v && k !== 'stale') params.set(k, v);
  if (appState.filters.stale) params.set('stale', '1');
  if (appState.selected) params.set('ticket', appState.selected);
  if (appState.selected && appState.detailTab !== 'overview') params.set('section', appState.detailTab);
  if (appState.treeRoot) params.set('root', appState.treeRoot);
  if (appState.view === 'runs' && appState.runTab) params.set('tab', appState.runTab);
  if (appState.view === 'runs' && appState.runGroup === 'none') params.set('group', 'none');
  if (appState.view === 'runs' && appState.selectedRun) params.set('run', appState.selectedRun);
  if (appState.view === 'memory' && appState.memoryTab) params.set('mtab', appState.memoryTab);
  if (appState.view === 'memory' && appState.memoryRepo) params.set('mrepo', appState.memoryRepo);
  const next = `#${params.toString()}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

function layoutMode() {
  const w = window.innerWidth;
  if (w - (appState.sidebarCollapsed ? 72 : 224) >= 1100) return 'desktop';
  if (w >= 900) return 'medium';
  return 'narrow';
}

function applyTheme() {
  const stored = (() => { try { return localStorage.getItem('st-theme'); } catch { return null; } })();
  appState.theme = stored ?? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = appState.theme;
}

function render() {
  const s = appState.snapshot;
  const now = nowIso();
  const main = $('#main');
  if (!s) {
    setMarkup(main, !appState.online
      ? `<section class="empty" role="alert"><h1>Unable to load your workspace</h1><p>${esc(appState.error || 'The worker is unavailable. Start it with quill worker start; this page will retry automatically.')}</p></section>`
      : `<div class="skeleton" role="status" aria-label="Waiting for the first snapshot from the worker"><span></span><span></span><span></span></div>`);
    return;
  }
  document.body.dataset.sidebar = appState.sidebarCollapsed ? 'collapsed' : 'expanded';
  const disclosures = [...main.querySelectorAll('[data-disclosure][open]')].map((el) => el.dataset.disclosure);
  const scroll = main.scrollTop;
  const searchFocused = document.activeElement && document.activeElement.id === 'search';
  const searchPos = searchFocused ? document.activeElement.selectionStart : null;
  const workspaceOpen = $('#sidebar .workspace-details')?.open;
  setMarkup($('#sidebar'), renderSidebar(s, { view: appState.view, endpoint: appState.endpoint, online: appState.online, filters: appState.filters, collapsed: appState.sidebarCollapsed, now, moreOpen: appState.moreOpen, memory: appState.memory }));
  if (workspaceOpen) $('#sidebar .workspace-details').open = true;
  // Keep an open health popover (provider errors, worker) open across the header's per-minute re-render.
  const healthOpen = [...document.querySelectorAll('#header .health-pop')].flatMap((p, i) => (p.open ? [i] : []));
  setMarkup($('#header'), renderHeader(s, { now, online: appState.online, refresh: appState.refresh, theme: appState.theme, filters: appState.filters, view: appState.view, endpoint: appState.endpoint, receipt: appState.receipt }));
  { const pops = document.querySelectorAll('#header .health-pop'); for (const i of healthOpen) if (pops[i]) pops[i].open = true; }
  if (searchFocused) { const sInput = $('#search'); if (sInput) { sInput.focus(); if (searchPos !== null) sInput.setSelectionRange(searchPos, searchPos); } }
  const filterOpen = $('#filters .filter-pop')?.open;
  setMarkup($('#filters'), renderFilterBar(s, appState.filters));
  if (filterOpen) $('#filters .filter-pop').open = true;
  const pending = [...appState.requests.values()];
  const opts = { now, pending, selected: appState.selected, leases: appState.leases };
  let html = '';
  const bulk = { selecting: appState.selecting, checked: appState.checked };
  if (appState.view === 'picknext') html = renderPickNext(s, appState.filters, { ...opts, ...bulk, blockedExpanded: appState.blockedExpanded });
  else if (appState.view === 'board') html = renderBoard(s, appState.filters, { ...opts, ...bulk, layout: layoutMode() === 'desktop' ? 'columns' : 'list', toggled: appState.boardToggled, pages: appState.boardPages });
  else if (appState.view === 'tree') html = renderTree(s, appState.filters, { root: appState.treeRoot });
  else if (appState.view === 'sessions') html = renderSessions(s, appState.filters, { ...opts, page: appState.sessionsPage });
  else if (appState.view === 'deployments') html = renderDeployments(s, appState.filters, opts);
  else if (appState.view === 'today') html = renderToday(s, appState.filters, opts);
  else if (appState.view === 'runs') html = renderRuns(s, appState.filters, { ...opts, tab: appState.runTab, selectedRun: appState.selectedRun, memory: appState.memory, group: appState.runGroup });
  else if (appState.view === 'memory') html = renderMemory(appState.memory, s, { now, pending, tab: appState.memoryTab, repo: appState.memoryRepo, editing: appState.memoryEditing, status: appState.memoryStatus, filters: appState.filters, online: appState.online });
  if (BULK_VIEWS.has(appState.view)) html = renderBatchStrips(s, activeBatches(s, appState.batches), { canCancel: !!(s.capabilities && s.capabilities.handoff) }) + html;
  renderBulkBar(s);
  const active = document.activeElement;
  // While the owner types in a Memory edit, the page is not rebuilt at all (like the detail panel's
  // editing guard): the field keeps IME composition, undo history, caret and scroll.
  const typing = appState.view === 'memory' && appState.memoryEditing && active instanceof HTMLTextAreaElement && main.contains(active) && active.dataset.memoryDraft === appState.memoryEditing.id;
  // A focused element of the page with an id (the repository selector, a tab, an entry's text) keeps
  // focus, and a text field its caret, across a re-render.
  const keep = !typing && active && active !== main && main.contains(active) && active.id ? { id: active.id, start: active.tagName === 'TEXTAREA' ? active.selectionStart : null, end: active.tagName === 'TEXTAREA' ? active.selectionEnd : null } : null;
  if (!typing) setMarkup(main, (appState.error ? `<div class="banner critical" role="alert">${icon('alert')}${esc(appState.error)}</div>` : '') + renderPageHeading(appState.view, s) + html);
  // A rebuilt edit form opens with the text Edit was pressed on; put back what has been typed since.
  const field = appState.view === 'memory' && appState.memoryEditing ? main.querySelector(`textarea[data-memory-draft="${CSS.escape(appState.memoryEditing.id)}"]`) : null;
  const draft = field ? appState.memoryDrafts[appState.memoryEditing.id] : undefined;
  if (field && typeof draft === 'string' && field.value !== draft) field.value = draft;
  if (keep) { const el = document.getElementById(keep.id); if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); if (keep.start !== null && el.setSelectionRange) el.setSelectionRange(keep.start, keep.end); } }
  main.scrollTop = renderedView === appState.view ? scroll : 0;
  renderedView = appState.view;
  disclosures.forEach((id) => { const el = main.querySelector(`[data-disclosure="${CSS.escape(id)}"]`); if (el) el.open = true; });
  document.body.dataset.layout = layoutMode();
  renderDetailPanel(now, pending);
  renderDialog();
  motion?.update({
    view: appState.view,
    results: JSON.stringify([appState.filters, appState.sessionsPage, appState.boardPages, [...appState.boardToggled], appState.treeRoot]),
    detail: appState.selected,
    receipt: appState.receipt ? JSON.stringify(appState.receipt) : null,
  });
  writeHash();
}

// The bulk action bar shows on Board and Pick next while cards are checked or a bulk edit can
// still be undone.
function renderBulkBar(s) {
  const host = $('#bulk');
  if (!host) return;
  // Tickets the filters hide (or that left the snapshot) drop out of the selection (ADR 0023).
  const kept = pruneChecked(s, appState.checked, appState.filters);
  if (kept.size !== appState.checked.size) {
    const hidden = appState.checked.size - kept.size;
    appState.checked = kept;
    announce(`${hidden} hidden ticket${hidden === 1 ? '' : 's'} removed from the selection; ${kept.size} selected`);
  }
  const undo = pendingUndo(appState.requests, appState.bulkUndo).length;
  const show = BULK_VIEWS.has(appState.view) && (appState.checked.size > 0 || undo > 0);
  const counts = { count: appState.checked.size, undo };
  const bar = host.querySelector('.bulk-bar');
  // Same buttons as before: update the numbers in place, keeping focus and skipping the entrance.
  if (show && bar && bar.dataset.shape === bulkBarShape(counts)) {
    const c = bar.querySelector('.bulk-count');
    if (c) c.textContent = `${counts.count} selected`;
    const u = bar.querySelector('.bulk-undo-count');
    if (u) u.textContent = String(counts.undo);
  } else setMarkup(host, show ? renderBulkActionBar(counts) : '');
  document.body.dataset.bulk = show ? 'on' : 'off';
}

function setChecked(next, { anchor } = {}) {
  const before = appState.checked.size;
  appState.checked = next;
  if (anchor !== undefined) appState.checkAnchor = anchor;
  if (next.size) appState.selecting = true;
  if (next.size !== before) announce(next.size ? `${next.size} selected` : 'Selection cleared');
  render();
}

function visibleCheckIds() {
  return [...document.querySelectorAll('#main [data-check]')].map((el) => el.dataset.check);
}

// One request per ticket (ADR 0023): a bulk action is a fan-out of ordinary requests, not a
// transaction. Results are read back from each request as it settles.
async function submitBulkHandoff(form) {
  const fd = new FormData(form);
  const ids = String(form.dataset.ids ?? '').split(',').filter(Boolean);
  const mode = String(fd.get('mode') ?? 'analyse');
  if (mode === 'attempt-fix' && fd.get('confirm_edit') !== 'on') { appState.dialog = { ...appState.dialog, error: 'Confirm that these runs may edit source.' }; render(); return; }
  const entries = bulkEntries(appState.snapshot, ids, { mode });
  const batchId = uuidv4();
  const bodies = bulkRequests(entries, { mode, access: String(fd.get('access') || 'autonomous'), note: String(fd.get('note') ?? '').trim(), batchId });
  const rows = entries.map((e) => ({ ticketId: e.ticket.id, requestId: null, reason: e.state === 'running' ? 'Already running' : e.state === 'no-repo' ? 'No repo' : e.state === 'not-eligible' ? 'Not eligible' : null }));
  appState.batches = [...appState.batches, batchId];
  appState.dialog = { type: 'bulk-results', batchId, rows };
  render();
  for (const body of bodies) {
    const row = rows.find((r) => r.ticketId === body.target_id);
    row.requestId = uuidv4();
    // Only while the dialog still shows this batch: a closed dialog is not reopened.
    appState.dialog = batchDialogUpdate(appState.dialog, batchId, rows.map((r) => ({ ...r })));
    await submit({ ...body, id: row.requestId }, { announceText: `${mode} queued for ${appState.snapshot.tickets.find((t) => t.id === body.target_id)?.key ?? 'a ticket'}` });
  }
  announce(`${bodies.length} run${bodies.length === 1 ? '' : 's'} requested as one batch`);
  // Tickets checked while the batch was being sent stay checked.
  appState.checked = withoutIds(appState.checked, ids);
  render();
}

function submitBulkStatus(form) {
  const fd = new FormData(form);
  const status = String(fd.get('status') ?? '');
  const blocker = String(fd.get('blocker') ?? '').trim();
  if (status === 'blocked' && !blocker) { appState.dialog = { ...appState.dialog, error: 'Blocked needs a blocker.' }; render(); return; }
  const { bodies, skipped } = bulkStatusRequests(appState.snapshot, [...appState.checked], { status, blocker });
  closeDialog();
  const ids = [];
  for (const { original, ...body } of bodies) {
    const id = uuidv4();
    ids.push(id);
    const sent = submit({ ...body, id }, { original, announceText: `Status change queued; undo within 10 seconds` });
    appState.sending.set(id, sent);
    sent.finally(() => appState.sending.delete(id));
  }
  // Earlier bulk changes still inside their window stay in Undo all.
  appState.bulkUndo = mergeUndo(appState.requests, appState.bulkUndo, ids);
  announce(`${bodies.length} status change${bodies.length === 1 ? '' : 's'} queued; Undo all within 10 seconds${skipped.length ? `; ${skipped.length} skipped` : ''}`);
  if (skipped.length) setReceipt(`Skipped ${skipped.length}: ${skipped.map((x) => `${ticketById(appState.snapshot, x.ticketId)?.key ?? x.ticketId} (${x.reason})`).join(', ')}`, 'neutral');
  render();
}

function cancelBatch(batchId) {
  const s = appState.snapshot;
  const queued = (s.handoffs ?? []).filter((h) => h.batch_id === batchId && h.state === 'queued' && !h.cancel_requested);
  for (const h of queued) submit({ kind: 'handoff-cancel', target_id: h.ticket_id, expected_revision: ticketRevision(h.ticket_id), payload: { handoff_id: h.id } }, { announceText: 'Cancelling a queued run of the batch' });
  announce(`Cancelling ${queued.length} queued run${queued.length === 1 ? '' : 's'}`);
}

// Loads one content ref. A snapshot that moved on is polled and the load retried once with the new
// generation; any other failure stays visible with Retry.
async function loadContent(hash, generation, retried = false) {
  appState.contentStatus[hash] = 'loading';
  render();
  try {
    const text = await api.getContent(hash, generation);
    delete appState.contentStatus[hash];
    appState.content[hash] = text ?? '(content unavailable: capture incomplete)';
  } catch (err) {
    if (err.code === 'generation-expired' && !retried) { appState.contentStatus[hash] = 'reloading'; render(); await poll(); return loadContent(hash, appState.snapshot.generation_id, true); }
    appState.contentStatus[hash] = { error: err.message || 'the request failed' };
  }
  render();
}

// A run's record (its result blob) for the run detail's plan, attempts and checks: owner dashboard
// only, fetched once per content hash (content-addressed, so it never goes stale). Called while
// rendering, so it never renders synchronously itself.
function loadRunRecord(hash, generation, retried = false) {
  appState.runRecords[hash] = { status: 'loading' };
  api.getContent(hash, generation).then((text) => {
    const data = parseRunRecord(text);
    appState.runRecords[hash] = data ? { data } : { error: text === null ? 'the record is no longer stored' : 'the record could not be read' };
    render();
  }).catch(async (err) => {
    if (err.code === 'generation-expired' && !retried) { await poll(); return loadRunRecord(hash, appState.snapshot.generation_id, true); }
    appState.runRecords[hash] = { error: err.message || 'the request failed' };
    render();
  });
}

function runRecordFor(run, s) {
  const ref = run && run.result_ref;
  if (!ref || api.static || !(s.capabilities ?? {}).handoff) return {};
  if (!Object.hasOwn(appState.runRecords, ref)) loadRunRecord(ref, s.generation_id);
  const r = appState.runRecords[ref];
  return { record: r.data ?? null, recordStatus: r.status === 'loading' ? 'loading' : r.error ? { error: r.error } : null };
}

// A run's patch and critic notes (ADR 0040), owner dashboard only, fetched once per content hash
// like the run record; `text` null means the blob is no longer stored.
function loadRunBlob(hash, generation, retried = false) {
  appState.runBlobs[hash] = { status: 'loading' };
  api.getContent(hash, generation).then((text) => {
    appState.runBlobs[hash] = { text: typeof text === 'string' ? text : null };
    render();
  }).catch(async (err) => {
    if (err.code === 'generation-expired' && !retried) { await poll(); return loadRunBlob(hash, appState.snapshot.generation_id, true); }
    appState.runBlobs[hash] = { error: err.message || 'the request failed' };
    render();
  });
}

function runBlobsFor(run, s) {
  if (!run || api.static || !(s.capabilities ?? {}).handoff) return {};
  const refs = [run.patch_ref, ['clean', 'warnings'].includes(run.critic_status) ? run.critic_ref : null].filter((r) => typeof r === 'string' && /^[0-9a-f]{64}$/.test(r));
  const blobs = {};
  for (const ref of refs) {
    if (!Object.hasOwn(appState.runBlobs, ref)) loadRunBlob(ref, s.generation_id);
    blobs[ref] = appState.runBlobs[ref];
  }
  return { blobs, diffOpen: appState.diffOpen };
}

function renderDetailPanel(now, pending) {
  const panel = $('#detail');
  const s = appState.snapshot;
  const ticket = appState.selected ? ticketById(s, appState.selected) : null;
  const runId = !ticket && appState.view === 'runs' ? appState.selectedRun : null;
  const run = runId ? (s.handoffs ?? []).find((h) => h.id === runId) ?? null : null;
  const open = !!(ticket || runId);
  const mode = layoutMode();
  document.body.dataset.expandedTicket = appState.detailExpanded && ticket ? 'true' : 'false';
  panel.hidden = !open;
  document.body.dataset.detail = open ? 'open' : 'closed';
  if (!open) { $('#main').inert = false; for (const id of ['sidebar', 'header', 'filters', 'bulk']) $(`#${id}`).inert = false; setMarkup(panel, ''); panel.removeAttribute('aria-modal'); renderedDetail = null; return; }
  const modal = mode !== 'desktop';
  $('#main').inert = modal || (!!ticket && appState.detailExpanded);
  for (const id of ['sidebar', 'header', 'filters', 'bulk']) $(`#${id}`).inert = modal;
  panel.setAttribute('role', modal ? 'dialog' : 'complementary');
  panel.setAttribute('aria-label', ticket ? 'Ticket detail' : 'Run detail');
  if (modal) panel.setAttribute('aria-modal', 'true'); else panel.removeAttribute('aria-modal');
  const active = document.activeElement;
  const activeId = active && panel.contains(active) ? active.id || active.dataset.action : null;
  const selectionStart = active && panel.contains(active) && active.tagName === 'TEXTAREA' ? active.selectionStart : null;
  const editing = active && panel.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
  if (editing) return; // never clobber an in-progress edit on poll
  const key = ticket ? ticket.id : `run:${runId}`;
  const html = ticket
    ? renderDetail(ticket, s, { now, pending, content: appState.content, contentStatus: appState.contentStatus, loadedTicket: appState.loadedTicket, editingNext: appState.editingNext === ticket.id, tab: appState.detailTab, expanded: appState.detailExpanded, leases: appState.leases })
    : run ? renderRunDetail(run, s, { now, pending, content: appState.content, contentStatus: appState.contentStatus, memory: appState.memory, ...runRecordFor(run, s), ...runBlobsFor(run, s) }) : renderRunNotFound(runId);
  setMarkup(panel, html);
  // A different ticket or run starts at its title, not at the previous one's scroll offset.
  if (renderedDetail !== key) { panel.scrollTop = 0; renderedDetail = key; }
  if (activeId) { const el = panel.querySelector(`#${CSS.escape(activeId)}`) || panel.querySelector(`[data-action="${CSS.escape(activeId)}"]`); if (el) { el.focus(); if (selectionStart !== null && el.setSelectionRange) el.setSelectionRange(selectionStart, selectionStart); } }
}

function renderDialog() {
  const host = $('#dialog');
  const d = appState.dialog;
  if (!d) { if (host.open) host.close(); host.innerHTML = ''; return; }
  const s = appState.snapshot;
  let html = '';
  if (d.type === 'status') html = renderStatusDialog(ticketById(s, d.ticket), d.status);
  else if (d.type === 'deployment') html = renderDeploymentDialog(ticketById(s, d.ticket), { mode: d.mode, deploymentId: d.deploymentId });
  else if (d.type === 'export') html = renderExportDialog(s, d.preview);
  else if (d.type === 'help') html = renderHelpDialog();
  else if (d.type === 'attach') {
    const sess = (s.sessions ?? []).find((x) => x.id === d.session);
    if (!sess) { appState.dialog = null; return renderDialog(); }
    html = renderAttachDialog(sess, s, { mode: d.mode });
  } else if (d.type === 'link-external') html = renderLinkExternalDialog(ticketById(s, d.ticket), s);
  else if (d.type === 'repo-clone') {
    const t = ticketById(s, d.ticket);
    if (!t || t.repo_state !== 'needs-clone') { appState.dialog = null; return renderDialog(); }
    html = renderCloneDialog(t, s);
  }
  else if (d.type === 'run-agent') {
    const t = ticketById(s, d.ticket);
    if (!t) { appState.dialog = null; return renderDialog(); }
    html = renderRunAgentDialog(t, s, { recipe: d.recipe, retryOf: d.retryOf, note: d.note });
  } else if (d.type === 'bulk-handoff') html = renderBulkHandoffForm(s, d.ids, { mode: d.mode });
  else if (d.type === 'bulk-results') html = renderBulkResults(s, { batchId: d.batchId, rows: d.rows, requests: [...appState.requests.values()] });
  else if (d.type === 'bulk-status') html = renderBulkStatusDialog(appState.checked.size);
  else if (d.type === 'publishers') html = renderPublishDialog(s, { now: nowIso(), pending: [...appState.requests.values()] });
  else if (d.type === 'schedules') html = renderSchedulesDialog(s, { now: nowIso(), pending: [...appState.requests.values()] });
  // The Schedules panel follows live state: it re-renders only when what it shows changes, and keeps
  // focus and any open run history across that re-render.
  const bulkKey = d.type === 'bulk-results' ? d.rows.map((r) => (r.requestId ? appState.requests.get(r.requestId)?.state ?? '-' : '-')).join(',') : '';
  const key = d.type === 'schedules' ? `${JSON.stringify(d)}:${schedulesDialogKey(s, appState.requests.values())}` : d.type === 'publishers' ? `${JSON.stringify(d)}:${publishDialogKey(s, appState.requests.values())}` : `${JSON.stringify(d)}${bulkKey}`;
  if (host.dataset.key !== key) {
    const live = host.open && (d.type === 'schedules' || d.type === 'publishers') && host.dataset.key && host.dataset.key.startsWith(JSON.stringify(d));
    const active = live && host.contains(document.activeElement) ? document.activeElement : null;
    const focusRow = active && active.closest('[data-schedule]') ? active.closest('[data-schedule]').dataset.schedule : null;
    const focusAction = active ? (active.dataset.action ?? (active.tagName === 'SUMMARY' ? 'summary' : null)) : null;
    const openRuns = live ? [...host.querySelectorAll('details[data-schedule][open]')].map((el) => el.dataset.schedule) : [];
    host.innerHTML = `<div class="dialog-inner" role="document">${html}${d.error ? `<p class="critical small" role="alert">${esc(d.error)}</p>` : ''}</div>`;
    host.dataset.key = key;
    if (!host.open) host.showModal();
    for (const name of openRuns) { const el = host.querySelector(`details[data-schedule="${CSS.escape(name)}"]`); if (el) el.open = true; }
    const row = focusRow ? `[data-schedule="${CSS.escape(focusRow)}"]` : '';
    const sel = focusAction === 'summary' ? `details${row} > summary` : focusAction ? `${row ? `${row}[data-action="${CSS.escape(focusAction)}"], ${row} [data-action="${CSS.escape(focusAction)}"]` : `[data-action="${CSS.escape(focusAction)}"]`}` : null;
    const restored = sel ? [...host.querySelectorAll(sel)].find((el) => !el.disabled) : null;
    const target = restored ?? (active && focusRow ? host.querySelector(`details[data-schedule="${CSS.escape(focusRow)}"] > summary`) ?? host.querySelector('[data-action="close-dialog"]') : null)
      ?? host.querySelector('textarea, input:not([type=hidden]):not([disabled]), select, button:not([disabled])');
    if (target) target.focus();
  }
}

// Memory comes from the owner endpoint when the worker publishes a new generation (and on first
// load), never every poll; a load that crossed a generation change loads again.
let memoryLoad = null;
function loadMemory() {
  if (!api || api.static) return null;
  if (memoryLoad) return memoryLoad;
  const gen = appState.snapshot ? appState.snapshot.generation_id : null;
  memoryLoad = api.getMemory()
    .then((m) => { appState.memory = m && Array.isArray(m.entries) ? { entries: m.entries, conflicts: Array.isArray(m.conflicts) ? m.conflicts : [] } : { entries: [], conflicts: [] }; appState.memoryStatus = null; })
    .catch((err) => { appState.memoryStatus = { error: err.message || 'the request failed' }; })
    .finally(() => {
      memoryLoad = null;
      render();
      if (!appState.memoryStatus && appState.snapshot && appState.snapshot.generation_id !== gen) loadMemory();
    });
  return memoryLoad;
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    const snap = normalizeSnapshot(await api.getSnapshot());
    const changed = !appState.snapshot || snap.generation_id !== appState.snapshot.generation_id;
    appState.snapshot = snap;
    appState.online = true;
    appState.error = null;
    syncRequests(snap);
    // Content refs are content-addressed, so loaded text stays valid across generations.
    if (changed) { appState.contentStatus = Object.fromEntries(Object.entries(appState.contentStatus).filter(([, v]) => v === 'loading' || v === 'reloading')); appState.loadedTicket = null; }
    if (!api.static && (changed || (!appState.memory && !appState.memoryStatus))) loadMemory();
    render();
  } catch (err) {
    if (err.code === 'unauthenticated') { appState.error = err.message; appState.online = false; }
    else appState.online = false;
    render();
  }
  if (!api.static) pollTimer = setTimeout(poll, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
}

function syncRequests(snap) {
  // A run proposed from a shared page since the last poll (ADR 0025) is announced and receipted.
  const proposals = freshProposals(appState.proposalsSeen, snap);
  appState.proposalsSeen = proposals.seen;
  if (proposals.fresh.length) {
    const text = proposals.fresh.length === 1 ? proposalNotice(proposals.fresh[0]) : `${proposals.fresh.length} runs proposed from shared pages; approve or dismiss them in Runs`;
    announce(text);
    setReceipt(text, 'neutral');
  }
  for (const r of snap.requests ?? []) {
    const local = appState.requests.get(r.id);
    if (tracksSnapshotRequest(r, local, appState.dismissedRequests)) {
      const prev = local ? local.state : null;
      appState.requests.set(r.id, { ...local, ...r, original: local ? local.original : null });
      if (prev && prev !== r.state && ['applied', 'conflict', 'failed', 'cancelled'].includes(r.state)) {
        const label = r.kind.replace(/-/g, ' ');
        if (r.kind === 'memory-edit' && r.state === 'applied') delete appState.memoryDrafts[r.target_id];
        const text = `${label} ${r.state}${r.state === 'conflict' ? (r.kind.startsWith('memory-') ? ': the entry changed first' : ': the ticket changed first') : ''}${r.state === 'failed' && r.error ? `: ${r.error.message}` : ''}`;
        announce(text);
        setReceipt(`${text} (request ${r.id.slice(0, 8)}, ${r.updated_at ?? nowIso()})`, r.state === 'applied' ? 'good' : r.state === 'cancelled' ? 'neutral' : 'critical');
      }
    }
  }
  if (appState.refresh && appState.refresh.id) {
    const r = (snap.requests ?? []).find((x) => x.id === appState.refresh.id);
    if (r) {
      const prevState = appState.refresh.state;
      appState.refresh = { ...appState.refresh, ...r };
      if (r.state === 'applied' && prevState !== 'applied') setReceipt(`reconciliation run ${r.result && r.result.run_id ? r.result.run_id.slice(0, 8) : ''} completed; last sync ${snap.meta.last_sync ?? 'unknown'}`, 'good');
      if (r.state === 'failed' && prevState !== 'failed') setReceipt(`refresh failed${r.error ? `: ${r.error.message}` : ''}`, 'critical');
      if (r.state === 'applied') setTimeout(() => { if (appState.refresh && appState.refresh.id === r.id) { appState.refresh = null; render(); } }, 4000);
    }
  }
}

async function submit(body, { original = null, announceText } = {}) {
  if (!appState.online) { announce('Offline: nothing was queued.'); appState.error = 'Offline: the request was not sent and is not queued.'; render(); return null; }
  const id = body.id ?? uuidv4();
  const req = { ...body, id, state: 'sending', original, not_before: null };
  appState.requests.set(id, req);
  render();
  try {
    const rec = await api.submit({ ...body, id });
    appState.requests.set(id, { ...rec, original });
    announce(announceText ?? `${body.kind.replace(/-/g, ' ')} queued`);
    setReceipt(`${body.kind.replace(/-/g, ' ')} persisted as request ${id.slice(0, 8)} (${rec.state}${rec.not_before && rec.not_before !== rec.created_at ? `, applies at ${rec.not_before}` : ''})`, 'neutral');
  } catch (err) {
    appState.requests.set(id, { ...req, state: 'failed', error: { code: err.code, message: err.message, retryable: err.status !== 400 && err.status !== 409 } });
    if (err.status === 401 || !err.status) appState.online = false;
    announce(`Request failed: ${err.message}`);
    setReceipt(`request rejected before the queue: ${err.message}`, 'critical');
  }
  render();
  return id;
}

async function cancelRequest(id) {
  try {
    const out = await api.cancel(id);
    const local = appState.requests.get(id) ?? {};
    if (out.outcome === 'cancelled') { appState.requests.set(id, { ...local, ...out.request, state: 'cancelled' }); announce('Edit cancelled'); setTimeout(() => { appState.requests.delete(id); render(); }, 3000); }
    else if (out.outcome === 'already-applied') { appState.requests.set(id, { ...local, ...out.request, state: 'already-applied' }); announce('Too late to cancel: the edit was already applied'); }
    else if (out.outcome === 'applying') announce('The edit is being applied right now and can no longer be cancelled');
    else appState.requests.set(id, { ...local, ...out.request });
  } catch (err) {
    announce(`Cancel failed: ${err.message}`);
  }
  render();
}

function ticketRevision(id) {
  const t = ticketById(appState.snapshot, id);
  return t ? t.revision : null;
}

function memoryRevision(id) {
  const e = appState.memory ? appState.memory.entries.find((x) => x.id === id) : null;
  return e ? e.revision : null;
}

// One memory change (spec §6.4) against the revision the owner saw. While another change to the
// same entry is in flight it is refused, said out loud, and false is returned (the caller keeps an
// open edit form and its draft).
function submitMemory(kind, id, revision, payload, announceText) {
  if (memoryEntryBusy(id, [...appState.requests.values()])) { announce(MEMORY_BUSY_MESSAGE); setReceipt(MEMORY_BUSY_MESSAGE, 'neutral'); return false; }
  submit({ kind, target_id: id, expected_revision: Number.isInteger(revision) ? revision : memoryRevision(id), payload }, { announceText });
  // The entry's buttons are disabled while the change is in flight: keep focus on the entry itself.
  document.getElementById(`memory-text-${id}`)?.focus({ preventScroll: true });
  return true;
}

// Inbox requests are checked against the session's unlinked-work revision, not a ticket's.
function targetRevision(r) {
  if (typeof r.kind === 'string' && r.kind.startsWith('memory-')) return memoryRevision(r.target_id);
  if (r.kind === 'attach-unbound' || r.kind === 'dismiss-unbound') {
    const sess = (appState.snapshot.sessions ?? []).find((x) => x.id === r.target_id);
    return sess && sess.unbound_work ? sess.unbound_work.revision : null;
  }
  return ticketRevision(r.target_id);
}

function handleAction(el) {
  const a = el.dataset.action;
  const s = appState.snapshot;
  switch (a) {
    case 'refresh': {
      const id = uuidv4();
      appState.refresh = { id, state: 'sending' };
      render();
      api.submit({ id, kind: 'refresh', payload: {} }).then((rec) => { appState.refresh = { ...rec }; render(); }).catch((err) => { appState.refresh = { id, state: 'failed', error: { message: err.message } }; if (!err.status) appState.online = false; render(); });
      break;
    }
    case 'theme': {
      appState.theme = appState.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = appState.theme;
      try { localStorage.setItem('st-theme', appState.theme); } catch { /* ignore */ }
      render();
      break;
    }
    case 'help': appState.dialog = { type: 'help' }; render(); break;
    case 'export': appState.dialog = { type: 'export', preview: null }; render(); break;
    case 'close-detail': closeDetail(); break;
    case 'detail-prev': stepDetail(-1); break;
    case 'detail-next': stepDetail(1); break;
    case 'edit-next': {
      appState.editingNext = el.dataset.ticket;
      render();
      const ta = $(`#next-action-${CSS.escape(el.dataset.ticket)}`);
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      break;
    }
    case 'review-proposals': appState.filters = { ...EMPTY_FILTERS }; setView('runs'); appState.runTab = 'needs'; render(); break;
    case 'run-tab': appState.runTab = el.dataset.tab; render(); document.querySelector(`#run-tab-${CSS.escape(appState.runTab)}`)?.focus(); break;
    case 'run-group': appState.runGroup = el.dataset.group === 'none' ? 'none' : 'attention'; render(); document.querySelector('#main [data-action="run-group"]')?.focus(); break;
    case 'open-run': openRun(el.dataset.run, el); break;
    case 'close-run': closeRun(); break;
    case 'run-prev': stepRun(-1); break;
    case 'run-next': stepRun(1); break;
    case 'open-ticket-from-run': { const id = el.dataset.ticket; setView('board'); openDetail(id, null); break; }
    case 'open-runs': setView('runs'); appState.runTab = el.dataset.tab || null; render(); break;
    // From a run's critical change to where it is approved: the run closes, Needs you opens.
    case 'open-needs-you': setView('runs'); appState.selectedRun = null; appState.runTab = 'needs'; render(); $('#run-tab-needs')?.focus(); break;
    case 'open-memory': {
      setView('memory');
      appState.memoryTab = MEMORY_TABS.includes(el.dataset.tab) ? el.dataset.tab : null;
      appState.memoryRepo = el.dataset.repo || null;
      render();
      const target = el.dataset.entry ? $(`#main .memory-entry[data-entry="${CSS.escape(el.dataset.entry)}"]`) : null;
      if (target) target.scrollIntoView({ block: 'nearest' });
      $(`#memory-tab-${appState.memoryTab ?? 'repo'}`)?.focus();
      break;
    }
    case 'memory-tab': appState.memoryTab = el.dataset.tab; appState.memoryEditing = null; render(); document.querySelector(`#memory-tab-${CSS.escape(appState.memoryTab)}`)?.focus(); break;
    case 'memory-reload': appState.memoryStatus = null; render(); loadMemory(); break;
    case 'memory-approve': submitMemory('memory-approve', el.dataset.entry, Number(el.dataset.revision), {}, 'Approving the learning; later runs receive it as your entry'); break;
    case 'memory-pin': {
      const pinned = el.dataset.pinned === 'true';
      submitMemory('memory-pin', el.dataset.entry, Number(el.dataset.revision), { pinned }, pinned ? 'Pinning the entry; pinned entries are delivered first and never go stale' : 'Unpinning the entry');
      break;
    }
    case 'memory-retire': submitMemory('memory-forget', el.dataset.entry, Number(el.dataset.revision), {}, 'Retiring the entry; undo within 10 seconds'); break;
    case 'memory-edit': {
      const entry = appState.memory ? appState.memory.entries.find((x) => x.id === el.dataset.entry) : null;
      if (!entry) break;
      appState.memoryEditing = openMemoryEdit(entry, appState.memoryDrafts);
      render();
      const ta = $(`#main textarea[data-memory-draft="${CSS.escape(el.dataset.entry)}"]`);
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      break;
    }
    case 'memory-edit-cancel': {
      const id = el.dataset.entry;
      appState.memoryEditing = null;
      delete appState.memoryDrafts[id];
      render();
      $(`#main [data-action="memory-edit"][data-entry="${CSS.escape(id)}"]`)?.focus();
      break;
    }
    case 'toggle-more': appState.moreOpen = !appState.moreOpen; render(); break;
    case 'toggle-sidebar': appState.sidebarCollapsed = !appState.sidebarCollapsed; try { localStorage.setItem('st-sidebar-collapsed', String(appState.sidebarCollapsed)); } catch { /* storage may be unavailable */ } render(); document.querySelector('[data-action="toggle-sidebar"]')?.focus(); break;
    case 'expand-detail': appState.detailExpanded = !appState.detailExpanded; render(); break;
    case 'detail-tab':
      if (!DETAIL_TABS.includes(el.dataset.tab)) break;
      appState.detailTab = el.dataset.tab; render();
      document.querySelector(`#detail-tab-${appState.detailTab}`)?.focus(); break;
    case 'cancel-next': appState.editingNext = null; render(); break;
    case 'toggle-blocked': appState.blockedExpanded = !appState.blockedExpanded; render(); break;
    case 'close-dialog': closeDialog(); break;
    case 'handoff':
    case 'run-agent': appState.dialog = { type: 'run-agent', ticket: el.dataset.ticket, recipe: el.dataset.recipe ?? null, retryOf: el.dataset.retryOf ?? null, note: el.dataset.note ?? null }; render(); break;
    case 'run-agent-pick': appState.dialog = { ...appState.dialog, recipe: el.dataset.recipe }; render(); break;
    case 'run-agent-back': appState.dialog = { ...appState.dialog, recipe: null }; render(); break;
    case 'record-deployment': appState.dialog = { type: 'deployment', ticket: el.dataset.ticket, mode: 'record', deploymentId: el.dataset.deployment ?? null }; render(); break;
    case 'attach-unbound': appState.dialog = { type: 'attach', session: el.dataset.session, mode: el.dataset.mode === 'create' ? 'create' : 'attach' }; render(); break;
    case 'dismiss-unbound': submit({ kind: 'dismiss-unbound', target_id: el.dataset.session, expected_revision: Number(el.dataset.revision), payload: {} }, { announceText: 'Dismissal queued; undo within 10 seconds' }); break;
    case 'link-external': appState.dialog = { type: 'link-external', ticket: el.dataset.ticket }; render(); break;
    case 'clone-repo': appState.dialog = { type: 'repo-clone', ticket: el.dataset.ticket }; render(); break;
    case 'schedules': appState.dialog = { type: 'schedules' }; render(); break;
    case 'publishers': appState.dialog = { type: 'publishers' }; render(); break;
    case 'publish': {
      const confirm = el.dataset.confirm === 'true';
      submit({ kind: 'publish', target_id: null, expected_revision: null, payload: { publisher: el.dataset.publisher || null, confirm } }, { announceText: confirm ? `Confirmed; publishing ${el.dataset.publisher}` : `Publishing ${el.dataset.publisher}` });
      break;
    }
    case 'run-job': submit({ kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: el.dataset.schedule } }, { announceText: `Running ${el.dataset.schedule} now` }); break;
    case 'waive-deployment': appState.dialog = { type: 'deployment', ticket: el.dataset.ticket, mode: 'waive', deploymentId: el.dataset.deployment ?? null }; render(); break;
    case 'toggle-column': { const c = el.dataset.column; if (appState.boardToggled.has(c)) appState.boardToggled.delete(c); else appState.boardToggled.add(c); render(); break; }
    case 'column-page': appState.boardPages[el.dataset.column] = Number(el.dataset.page); render(); break;
    case 'toggle-stale': appState.filters.stale = !appState.filters.stale; render(); break;
    case 'sessions-page': appState.sessionsPage = Number(el.dataset.page); render(); break;
    case 'tree-root': appState.treeRoot = el.dataset.root || null; render(); break;
    case 'dismiss-receipt': appState.receipt = null; render(); break;
    case 'clear-filter': appState.filters[el.dataset.filter] = el.dataset.filter === 'stale' ? false : ''; render(); break;
    case 'clear-filters': appState.filters = { ...appState.filters, category: '', tag: '', repo: '', machine: '', stale: false, q: '' }; render(); break;
    case 'cancel-request': cancelRequest(el.dataset.request); break;
    // Dismissed stays dismissed: later polls do not bring the request's feedback back.
    case 'discard-request': appState.dismissedRequests.add(el.dataset.request); appState.requests.delete(el.dataset.request); render(); break;
    case 'retry-request':
    case 'resubmit-request': {
      const r = appState.requests.get(el.dataset.request);
      if (!r) break;
      appState.requests.delete(r.id);
      submit({ kind: r.kind, target_id: r.target_id, expected_revision: targetRevision(r), payload: r.payload, retry_of: r.id }, { announceText: 'Resubmitted against the current revision' });
      break;
    }
    case 'reverse-request': {
      const r = appState.requests.get(el.dataset.request);
      if (!r || !r.original) break;
      appState.requests.delete(r.id);
      submit({ kind: r.kind, target_id: r.target_id, expected_revision: targetRevision(r), payload: r.original }, { announceText: 'Reversal queued as a new revision-checked edit' });
      break;
    }
    // Run snapshots (ADR 0035): a ticket request with the 10 s undo; only the checkout changes.
    case 'restore-snapshot': submit({ kind: 'restore-snapshot', target_id: el.dataset.ticket, expected_revision: null, payload: { handoff_id: el.dataset.handoff, snapshot_id: el.dataset.snapshot } }, { announceText: 'Restore queued; undo within 10 seconds. Only the run checkout changes' }); break;
    case 'undo-file-effect': submit({ kind: 'undo-file-effect', target_id: el.dataset.ticket, expected_revision: null, payload: { handoff_id: el.dataset.handoff, effect_id: el.dataset.effect } }, { announceText: 'Undo queued; the file is restored within 10 seconds' }); break;
    case 'accept-suggestion':
    case 'dismiss-suggestion': {
      const accept = el.dataset.action === 'accept-suggestion';
      submit({ kind: el.dataset.action, target_id: el.dataset.ticket, expected_revision: accept ? ticketRevision(el.dataset.ticket) : null, payload: { handoff_id: el.dataset.handoff, suggestion_id: el.dataset.suggestion } }, { announceText: accept ? 'Accepting the suggestion; undo within 10 seconds' : 'Dismissing the suggestion; undo within 10 seconds' });
      break;
    }
    case 'approve-run': {
      // ADR 0031: a critical change's "Valid for" choice travels as ttl_minutes; Whole run sends none.
      const lease = el.closest('li') ? el.closest('li').querySelector('select[data-lease]') : null;
      const ttl = lease && lease.value ? Number(lease.value) : null;
      submit({ kind: 'approve-run', target_id: el.dataset.ticket, expected_revision: null, payload: { proposal_id: el.dataset.proposal, ...(ttl ? { ttl_minutes: ttl } : {}) } }, { announceText: ttl ? `Approving the critical change, valid for ${ttl === 60 ? '1 hour' : `${ttl} minutes`} from when the run starts; it is queued, not run yet` : 'Approving the proposed run; it is queued as an ordinary run' });
      break;
    }
    case 'dismiss-run': submit({ kind: 'dismiss-run', target_id: el.dataset.ticket, expected_revision: null, payload: { proposal_id: el.dataset.proposal } }, { announceText: 'Dismissing the proposed run; undo within 10 seconds' }); break;
    // Spec §5.4: a new run that continues the interrupted run's session, with the same access.
    case 'resume-run': submit({ kind: 'resume-run', target_id: el.dataset.ticket, expected_revision: null, payload: { handoff_id: el.dataset.handoff } }, { announceText: 'Resume requested; it is queued as a new run, not finished' }); break;
    case 'cancel-handoff': {
      const h = s.handoffs.find((x) => x.id === el.dataset.handoff);
      if (h) submit({ kind: 'handoff-cancel', target_id: h.ticket_id, expected_revision: ticketRevision(h.ticket_id), payload: { handoff_id: h.id } }, { announceText: 'Handoff cancellation requested' });
      break;
    }
    case 'toggle-select': {
      appState.selecting = !appState.selecting;
      if (!appState.selecting && appState.checked.size) { appState.checked = new Set(); announce('Selection cleared'); }
      render();
      break;
    }
    case 'bulk-clear': setChecked(new Set(), { anchor: null }); break;
    case 'bulk-handoff': appState.dialog = { type: 'bulk-handoff', mode: el.dataset.mode === 'attempt-fix' ? 'attempt-fix' : 'analyse', ids: [...appState.checked] }; render(); break;
    case 'bulk-status': appState.dialog = { type: 'bulk-status' }; render(); break;
    case 'bulk-undo-all': {
      const ids = pendingUndo(appState.requests, appState.bulkUndo);
      announce(`Undoing ${ids.length} change${ids.length === 1 ? '' : 's'}`);
      // A change still being sent is cancelled as soon as the server has it.
      for (const id of ids) Promise.resolve(appState.sending.get(id)).then(() => { if (appState.requests.get(id)?.state === 'pending') cancelRequest(id); });
      break;
    }
    case 'cancel-batch': cancelBatch(el.dataset.batch); break;
    case 'dismiss-batch': appState.batches = appState.batches.filter((b) => b !== el.dataset.batch); render(); break;
    case 'load-content': loadContent(el.dataset.hash, el.dataset.generation); break;
    case 'hide-content': delete appState.content[el.dataset.hash]; render(); break;
    case 'load-run-record': loadRunRecord(el.dataset.hash, appState.snapshot.generation_id); render(); break;
    case 'load-run-blob': loadRunBlob(el.dataset.hash, appState.snapshot.generation_id); render(); break;
    case 'load-ticket': {
      api.getTicket(el.dataset.ticket, el.dataset.generation).then((t) => { appState.loadedTicket = t; render(); }).catch((err) => { if (err.code === 'generation-expired') poll(); });
      break;
    }
    case 'export-preview': {
      const form = el.closest('form');
      const params = exportParams(form);
      api.exportPreview(params).then((preview) => { appState.dialog = { ...appState.dialog, preview, params }; render(); }).catch((err) => { appState.dialog = { ...appState.dialog, error: err.message }; render(); });
      break;
    }
    default: break;
  }
}

function exportParams(form) {
  const fd = new FormData(form);
  return { projects: fd.getAll('project').join(','), fields: fd.getAll('field').join(','), include_checkpoints: fd.get('include_checkpoints') ? '1' : '0', include_links: fd.get('include_links') ? '1' : '0' };
}

function openDetail(id, source) {
  detailCloseVersion++;
  motion?.cancelElement($('#detail'));
  appState.lastFocus = source ?? document.activeElement;
  appState.selected = id;
  appState.selectedRun = null;
  appState.detailTab = 'overview';
  appState.detailExpanded = false;
  appState.loadedTicket = null;
  appState.editingNext = null;
  render();
  const panel = $('#detail');
  const first = panel.querySelector('[data-action="close-detail"]');
  if (first && layoutMode() !== 'desktop') first.focus();
}

async function closeDetail() {
  const version = ++detailCloseVersion;
  const selected = appState.selected;
  await motion?.exit($('#detail'));
  if (version !== detailCloseVersion || appState.selected !== selected) return;
  appState.selected = null;
  appState.detailTab = 'overview';
  appState.detailExpanded = false;
  appState.editingNext = null;
  render();
  const source = appState.lastFocus && document.contains(appState.lastFocus) ? appState.lastFocus : $(`#main [data-ticket="${CSS.escape(selected ?? '')}"]`);
  source?.focus({ preventScroll: true });
}

function closeDialog() {
  const host = $('#dialog');
  appState.dialog = null;
  if (host.open) host.close();
  host.innerHTML = '';
  delete host.dataset.key;
  if (appState.lastFocus && document.contains(appState.lastFocus)) appState.lastFocus.focus();
}

function visibleTicketIds() {
  return [...new Set([...document.querySelectorAll('#main [data-ticket]')].map((el) => el.dataset.ticket))];
}

function stepDetail(delta) {
  const ids = visibleTicketIds();
  const next = ids[ids.indexOf(appState.selected) + delta];
  if (!next) return;
  appState.selected = next;
  appState.detailTab = 'overview';
  appState.detailExpanded = false;
  appState.loadedTicket = null;
  appState.editingNext = null;
  render();
}

function openRun(id, source) {
  appState.lastFocus = source ?? document.activeElement;
  if (appState.view !== 'runs') { setView('runs'); appState.runTab = 'all'; }
  appState.selected = null;
  appState.selectedRun = id;
  render();
  if (layoutMode() !== 'desktop') $('#detail [data-action="close-run"]')?.focus();
  else $(`#main [data-action="open-run"][data-run="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

function closeRun() {
  const id = appState.selectedRun;
  appState.selectedRun = null;
  render();
  const source = appState.lastFocus && document.contains(appState.lastFocus) ? appState.lastFocus : $(`#main [data-run="${CSS.escape(id ?? '')}"]`);
  source?.focus({ preventScroll: true });
}

function stepRun(delta) {
  const ids = [...document.querySelectorAll('#main [data-action="open-run"]')].map((el) => el.dataset.run);
  const at = ids.indexOf(appState.selectedRun);
  if (at === -1) return;
  const next = ids[at + delta];
  if (next) { appState.selectedRun = next; render(); }
}

function toLocalIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function handleSubmit(form) {
  const kind = form.dataset.form;
  const ticketId = form.dataset.ticket;
  const revision = Number(form.dataset.revision);
  const t = ticketId ? ticketById(appState.snapshot, ticketId) : null;
  const fd = new FormData(form);
  if (kind === 'next-action') {
    appState.editingNext = null;
    submit({ kind: 'set-next-action', target_id: ticketId, expected_revision: revision, payload: { next_action: String(fd.get('next_action') ?? '').trim() } }, { original: { next_action: t.next_action } });
  } else if (kind === 'status') {
    const status = form.dataset.status;
    const payload = { status };
    if (status === 'blocked') payload.blocker = String(fd.get('blocker') ?? '').trim();
    const choice = fd.get('deployment_choice');
    if (choice) {
      payload.deployment_choice = choice;
      if (choice !== 'leave') {
        payload.deployments = [...form.querySelectorAll('.obligation')].map((row, i) => {
          const item = { pr_id: row.dataset.pr, environment: row.dataset.environment };
          if (choice === 'waive') item.waiver_reason = String(fd.get(`waiver_${i}`) ?? '').trim();
          else { item.deployed_at = toLocalIso(fd.get(`deployed_at_${i}`)); item.evidence = String(fd.get(`evidence_${i}`) ?? '').trim() || null; item.evidence_kind = String(fd.get(`evidence_kind_${i}`) ?? 'manual'); }
          return item;
        });
      }
    }
    closeDialog();
    submit({ kind: 'set-status', target_id: ticketId, expected_revision: revision, payload }, { original: { status: t.status, blocker: t.blocker } });
  } else if (kind === 'deployment') {
    const items = [...form.querySelectorAll('.obligation')].map((row, i) => {
      const cb = row.querySelector('input[type=checkbox]');
      if (!cb || !cb.checked) return null;
      const item = { pr_id: cb.dataset.pr, environment: cb.dataset.environment };
      const waiver = fd.get(`waiver_${i}`);
      if (waiver !== null) item.waiver_reason = String(waiver).trim();
      else { item.deployed_at = toLocalIso(fd.get(`deployed_at_${i}`)); item.evidence = String(fd.get(`evidence_${i}`) ?? '').trim() || null; item.evidence_kind = String(fd.get(`evidence_kind_${i}`) ?? 'manual'); }
      return item;
    }).filter(Boolean);
    if (!items.length) { appState.dialog = { ...appState.dialog, error: 'Select at least one obligation.' }; render(); return; }
    closeDialog();
    submit({ kind: 'record-deployment', target_id: ticketId, expected_revision: revision, payload: { items } });
  } else if (kind === 'recipe-run') {
    // Disabled boxes are not submitted: permissions the recipe requires come from the form itself.
    const required = form.dataset.requiresEdit === 'true';
    const permissions = {};
    for (const k of ['read_source', 'edit_source', 'commit', 'push_branch', 'open_draft_pr', 'edit_files', 'delete_files']) permissions[k] = fd.get(k) === 'on';
    if (required) { permissions.read_source = true; permissions.edit_source = true; }
    // A files run has no access choice and is always standard (ADR 0015); every other form sends
    // its checked level, Autonomous unless the owner picked another.
    const payload = { recipe: form.dataset.recipe, note: String(fd.get('note') ?? '').trim(), permissions, access: fd.get('access') || 'standard', branch: String(fd.get('branch') ?? '').trim() || null };
    // Write scopes go only with Autonomous access (their boxes are disabled otherwise, spec §4.3).
    const scopes = payload.access === 'autonomous' ? scopeChoices(fd) : [];
    if (scopes.length) payload.scopes = scopes;
    closeDialog();
    submit({ kind: 'handoff', target_id: ticketId, expected_revision: revision, payload, retry_of: form.dataset.retryOf || null }, { announceText: `${form.dataset.recipe} run requested; its results arrive as suggestions on the ticket` });
  } else if (kind === 'attach') {
    const key = String(fd.get('key') ?? '').trim();
    const bind = fd.get('bind') === 'on';
    const match = form.dataset.mode === 'create' ? null : appState.snapshot.tickets.find((x) => x.key.toUpperCase() === key.toUpperCase() || (x.aliases ?? []).some((al) => al.toUpperCase() === key.toUpperCase()));
    const payload = match ? { ticket_id: match.id, bind } : { key, title: String(fd.get('title') ?? '').trim(), bind };
    closeDialog();
    submit({ kind: 'attach-unbound', target_id: form.dataset.session, expected_revision: revision, payload }, { announceText: match ? `Attaching to ${match.key}; undo within 10 seconds` : `Creating ${key} and attaching; undo within 10 seconds` });
  } else if (kind === 'link-external') {
    const key = String(fd.get('key') ?? '').trim();
    const url = String(fd.get('url') ?? '').trim();
    closeDialog();
    submit({ kind: 'link-external', target_id: ticketId, expected_revision: revision, payload: url ? { key, url } : { key } }, { announceText: `Linking to ${key}; undo within 10 seconds` });
  } else if (kind === 'repo-clone') {
    const url = form.dataset.url;
    closeDialog();
    submit({ kind: 'repo-clone', target_id: ticketId, expected_revision: revision, payload: { url } }, { announceText: `Cloning the repository for ${t ? t.key : 'the ticket'}` });
  } else if (kind === 'memory-edit') {
    const id = form.dataset.entry;
    const text = String(fd.get('text') ?? '').trim();
    if (!text) { announce('The wording cannot be empty'); return; }
    // The draft stays until the edit applies, so a conflict or failure loses nothing.
    appState.memoryDrafts[id] = text;
    // Refused while another change to the entry is in flight: the form stays open with the draft.
    if (memoryEntryBusy(id, [...appState.requests.values()])) { submitMemory('memory-edit', id, revision, { text }, ''); return; }
    appState.memoryEditing = null;
    submitMemory('memory-edit', id, revision, { text }, 'Saving your wording as an owner entry');
  } else if (kind === 'bulk-handoff') {
    submitBulkHandoff(form);
  } else if (kind === 'bulk-status') {
    submitBulkStatus(form);
  } else if (kind === 'export') {
    const d = appState.dialog;
    api.exportRun({ ...(d.params ?? exportParams(form)) }).then((res) => { announce(`Snapshot saved to ${res.path}`); appState.dialog = { ...d, saved: res.path, error: null }; closeDialog(); appState.error = null; alert(`Saved read-only snapshot to ${res.path}. Share the file yourself; it will not update.`); }).catch((err) => { appState.dialog = { ...d, error: err.message }; render(); });
  }
}

function onKey(e) {
  const target = e.target;
  const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
  const runTab = target?.closest('[role="tab"][data-action="run-tab"]');
  if (runTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const tabs = [...document.querySelectorAll('#main [data-action="run-tab"]')].map((b) => b.dataset.tab);
    const i = tabs.indexOf(runTab.dataset.tab);
    appState.runTab = tabs[e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    render(); document.querySelector(`#run-tab-${CSS.escape(appState.runTab)}`)?.focus(); return;
  }
  const memoryTab = target?.closest('[role="tab"][data-action="memory-tab"]');
  if (memoryTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const i = MEMORY_TABS.indexOf(memoryTab.dataset.tab);
    appState.memoryTab = MEMORY_TABS[e.key === 'Home' ? 0 : e.key === 'End' ? MEMORY_TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : MEMORY_TABS.length - 1)) % MEMORY_TABS.length];
    appState.memoryEditing = null;
    render(); document.querySelector(`#memory-tab-${appState.memoryTab}`)?.focus(); return;
  }
  const detailTab = target?.closest('[role="tab"][data-action="detail-tab"]');
  if (detailTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const tabs = DETAIL_TABS;
    const index = tabs.indexOf(appState.detailTab);
    appState.detailTab = tabs[e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    render(); document.querySelector(`#detail-tab-${appState.detailTab}`)?.focus(); return;
  }
  const dialogOpen = $('#dialog').open;
  if (e.key === 'Tab' && !dialogOpen && $('#detail').getAttribute('aria-modal') === 'true') {
    const focusable = [...$('#detail').querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')].filter((el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (first && (e.shiftKey && target === first || !e.shiftKey && target === last)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  }
  if (e.key === 'Escape') {
    if (appState.moreOpen) { e.preventDefault(); appState.moreOpen = false; render(); $('.nav-more')?.focus(); return; }
    if (dialogOpen) { e.preventDefault(); closeDialog(); return; }
    const pop = document.querySelector('.health-pop[open]');
    if (pop) { e.preventDefault(); pop.open = false; pop.querySelector('summary')?.focus(); return; }
    if (appState.selected && !inInput) { e.preventDefault(); closeDetail(); return; }
    if (appState.selectedRun && !inInput) { e.preventDefault(); closeRun(); return; }
    if (!dialogOpen && selectionKey('Escape', { checkedSize: appState.checked.size }) && (!inInput || target.dataset.check)) { e.preventDefault(); setChecked(new Set(), { anchor: null }); return; }
    if (inInput && target.form && target.form.dataset.form === 'memory-edit') { e.preventDefault(); const id = target.form.dataset.entry; appState.memoryEditing = null; render(); $(`#main [data-action="memory-edit"][data-entry="${CSS.escape(id)}"]`)?.focus(); return; }
    if (inInput && target.form && target.form.dataset.form === 'next-action') { target.value = ticketById(appState.snapshot, target.form.dataset.ticket).next_action; target.blur(); appState.editingNext = null; render(); return; }
  }
  if (inInput || dialogOpen) {
    if (e.key === 'Enter' && !e.shiftKey && target.tagName === 'TEXTAREA' && target.form && target.form.dataset.form === 'next-action') { e.preventDefault(); handleSubmit(target.form); }
    return;
  }
  if (e.key === '/') { e.preventDefault(); const s = $('#search'); if (s) s.focus(); return; }
  if (SHORTCUT_VIEWS[e.key] && ownerView(SHORTCUT_VIEWS[e.key])) { appState.moreOpen = false; setView(SHORTCUT_VIEWS[e.key]); render(); const tab = $(`#tab-${appState.view}`); if (tab) tab.focus(); return; }
  if (e.key === '?') { appState.lastFocus = document.activeElement; appState.dialog = { type: 'help' }; render(); return; }
  const card = target && target.closest ? target.closest('[data-ticket][role=button]') : null;
  if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(card.dataset.ticket, card); return; }
  const bulkKey = BULK_VIEWS.has(appState.view) && appState.snapshot && appState.snapshot.capabilities && (appState.snapshot.capabilities.handoff || appState.snapshot.capabilities.edit_tickets) ? selectionKey(e.key, { focusedId: card ? card.dataset.ticket : null, checkedSize: appState.checked.size, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey }) : null;
  if (bulkKey && bulkKey.type === 'toggle') {
    e.preventDefault();
    setChecked(toggleChecked(appState.checked, bulkKey.id), { anchor: bulkKey.id });
    $(`#main [data-ticket="${CSS.escape(bulkKey.id)}"][role=button]`)?.focus();
    return;
  }
  if (card && e.key === 'h' && card.querySelector('[data-action="handoff"]')) { e.preventDefault(); appState.lastFocus = card; appState.dialog = { type: 'run-agent', ticket: card.dataset.ticket, recipe: null, retryOf: null }; render(); return; }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && target && target.dataset && target.dataset.action === 'detail-nav' && appState.selected) {
    e.preventDefault();
    stepDetail(e.key === 'ArrowRight' ? 1 : -1);
    const nav = $('#detail [data-action="detail-nav"]');
    if (nav) nav.focus();
  }
}

function onClick(e) {
  for (const pop of document.querySelectorAll('.health-pop[open]')) if (!pop.contains(e.target)) pop.open = false;
  const copy = e.target.closest('[data-copy]');
  if (copy && navigator.clipboard) { navigator.clipboard.writeText(copy.dataset.copy).then(() => announce(`Copied ${copy.dataset.copyLabel ?? copy.dataset.copy}`)).catch(() => {}); e.stopPropagation(); return; }
  const check = e.target.closest('#main [data-check]');
  if (check) {
    const id = check.dataset.check;
    setChecked(e.shiftKey ? selectRange(appState.checked, visibleCheckIds(), appState.checkAnchor, id) : toggleChecked(appState.checked, id), { anchor: id });
    $(`#main [data-check="${CSS.escape(id)}"]`)?.focus();
    return;
  }
  const open = e.target.closest('[data-open]');
  if (open) { e.preventDefault(); openDetail(open.dataset.open, open); if (DETAIL_TABS.includes(open.dataset.section)) { appState.detailTab = open.dataset.section; render(); $(`#detail-tab-${open.dataset.section}`)?.focus(); } return; }
  const action = e.target.closest('[data-action]');
  if (action && action.dataset.action !== 'detail-nav') { e.preventDefault(); appState.lastFocus = appState.lastFocus ?? action; handleAction(action); return; }
  const tab = e.target.closest('[data-view]');
  if (tab) { appState.moreOpen = false; setView(tab.dataset.view); render(); return; }
  const card = e.target.closest('#main [data-ticket][role=button]');
  if (card && !e.target.closest('button, a, [data-copy]')) openDetail(card.dataset.ticket, card);
}

// A checked scope with no credentials configured blocks Queue and says why (review M4); other
// blockers rendered with the form (data-blocked) keep it disabled whatever the scopes are.
function scopeBlockers(form, scoped) {
  const submitBtn = form.querySelector('button[type="submit"]');
  const note = form.querySelector('[data-scope-blocked]');
  const blocking = scoped ? [...form.querySelectorAll('input[name="scope"][data-scope-blocker]')].filter((b) => b.checked).map((b) => b.dataset.scopeBlocker) : [];
  if (note) { note.textContent = blocking.join(' '); note.hidden = !blocking.length; }
  if (submitBtn && submitBtn.dataset.blocked !== 'true') {
    submitBtn.disabled = blocking.length > 0;
    if (blocking.length) submitBtn.title = blocking[0]; else submitBtn.removeAttribute('title');
  }
}

function onChange(e) {
  const el = e.target;
  if (el.dataset && el.dataset.lease !== undefined) { appState.leases[el.dataset.lease] = el.value; return; }
  if (el.dataset && el.dataset.memoryRepo !== undefined) { appState.memoryRepo = el.value || null; appState.memoryEditing = null; render(); $('#memory-repo')?.focus(); return; }
  if (el.dataset.filter) {
    appState.filters[el.dataset.filter] = el.type === 'checkbox' ? el.checked : el.value;
    appState.boardPages = {};
    appState.sessionsPage = 0;
    render();
    if (el.dataset.filter !== 'q') $(`#filters [data-filter="${CSS.escape(el.dataset.filter)}"]`)?.focus();
    if (el.dataset.filter === 'q') { const s = $('#search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
    return;
  }
  const runForm = el.closest && el.closest('form[data-form="recipe-run"]');
  if (runForm) {
    const t = ticketById(appState.snapshot, runForm.dataset.ticket);
    const recipe = t ? effectiveRecipes(appState.snapshot, t.repo_id).find((r) => r.name === runForm.dataset.recipe) : null;
    const repo = t ? (appState.snapshot.repos ?? []).find((r) => r.id === t.repo_id) ?? null : null;
    // Spec §5: Push needs Commit and a draft PR needs Push (and a PR provider); clearing a parent clears its dependants.
    const box = (n) => runForm.querySelector(`input[name="${n}"]`);
    const commit = box('commit'), push = box('push_branch'), pr = box('open_draft_pr');
    if (push) { push.disabled = !(commit && commit.checked); if (push.disabled) push.checked = false; }
    if (pr) { pr.disabled = !(push && push.checked) || !(repo && repo.provider); if (pr.disabled) pr.checked = false; }
    const fd = new FormData(runForm);
    const choices = Object.fromEntries(['read_source', 'edit_source', 'commit', 'push_branch', 'open_draft_pr', 'edit_files', 'delete_files'].map((k) => [k, fd.get(k) === 'on' || !!runForm.querySelector(`[name="${k}"][disabled][checked]`)]));
    const out = runForm.querySelector('.run-summary');
    if (recipe && out) out.textContent = runSummary(recipe, choices, repo);
    // The time cap follows the checked access level (budgetFor, via the recipe's caps).
    const cap = runForm.querySelector('.run-cap');
    const access = fd.get('access');
    if (cap && typeof access === 'string' && cap.dataset[`cap${access.charAt(0).toUpperCase()}${access.slice(1)}`]) cap.textContent = cap.dataset[`cap${access.charAt(0).toUpperCase()}${access.slice(1)}`];
    // Write scopes only with Autonomous access; a checked scope that takes a target needs one.
    const scoped = access === 'autonomous';
    for (const input of runForm.querySelectorAll('input[name="scope"], input[data-scope-target]')) input.disabled = !scoped;
    const reason = runForm.querySelector('[data-scope-reason]');
    if (reason) reason.hidden = scoped;
    for (const t of runForm.querySelectorAll('input[data-scope-target]')) {
      const box = [...runForm.querySelectorAll('input[name="scope"]')].find((b) => b.value === t.dataset.scopeTarget);
      t.required = !!(box && box.checked && scoped);
    }
    scopeBlockers(runForm, scoped);
  }
  if (el.dataset.action === 'status-select') {
    const status = el.value;
    const t = ticketById(appState.snapshot, el.dataset.ticket);
    if (!t || status === t.status) return;
    appState.lastFocus = el;
    if (status === 'blocked' || (status === 'done' && t.deployments.some((d) => d.state === 'pending'))) {
      appState.dialog = { type: 'status', ticket: t.id, status };
      render();
    } else {
      submit({ kind: 'set-status', target_id: t.id, expected_revision: t.revision, payload: { status } }, { original: { status: t.status, blocker: t.blocker } });
    }
  }
}

function startCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const anyPending = [...appState.requests.values()].some((r) => r.state === 'pending');
    if (anyPending && !document.hidden) renderDetailPanel(nowIso(), [...appState.requests.values()]);
  }, 1000);
}

export function startApp() {
  applyTheme();
  try { appState.sidebarCollapsed = localStorage.getItem('st-sidebar-collapsed') === 'true'; } catch { /* use expanded navigation */ }
  motion = createDashboardMotion(document, window.matchMedia('(prefers-reduced-motion: reduce)'));
  readHash();
  const staticSnapshot = window.__SNAPSHOT__ ?? null;
  api = createApi({ staticSnapshot });
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  document.addEventListener('change', onChange);
  // The Advanced access details stays open while it holds the checked access level, so that
  // radio is never hidden or unfocusable (design system §8). 'toggle' does not bubble.
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d instanceof HTMLDetailsElement && d.classList.contains('access-advanced') && !d.open && d.querySelector('input[name="access"]:checked')) d.open = true;
    // A run's diff file stays open or closed as the owner left it across polls (ADR 0040).
    if (d instanceof HTMLDetailsElement && d.dataset.diffFile) appState.diffOpen[d.dataset.diffFile] = d.open;
  }, true);
  // Typing a scope's target ticks its box (review M5), so a typed target is never silently dropped.
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !t.dataset.scopeTarget || !t.value.trim()) return;
    const form = t.closest('form[data-form="recipe-run"]');
    const box = form && [...form.querySelectorAll('input[name="scope"]')].find((b) => b.value === t.dataset.scopeTarget);
    if (box && !box.disabled && !box.checked) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  // A Memory edit's text is kept as it is typed, so a re-render or a failed save never loses it.
  document.addEventListener('input', (e) => { const t = e.target; if (t instanceof HTMLTextAreaElement && t.dataset.memoryDraft) appState.memoryDrafts[t.dataset.memoryDraft] = t.value; });
  document.addEventListener('input', (e) => { if (e.target.dataset && e.target.dataset.filter === 'q') { appState.filters.q = e.target.value; render(); const s = $('#search'); if (s && document.activeElement !== s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } } });
  document.addEventListener('submit', (e) => { const form = e.target.closest('form[data-form]'); if (form) { e.preventDefault(); handleSubmit(form); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('online', () => poll());
  window.addEventListener('hashchange', () => { readHash(); render(); });
  window.addEventListener('resize', () => render());
  $('#dialog').addEventListener('close', () => { if (appState.dialog) { appState.dialog = null; render(); } });
  startCountdown();
  poll();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startApp);
  else startApp();
}
