// Dashboard shell: state, polling, routing, keyboard, dialogs and request feedback (UI-DESIGN.md).
import { esc, attr, icon, ticketById, STATUS_LABELS, normalizeSnapshot } from './components.js';
import { renderHeader, renderSidebar, renderPageHeading } from './views/header.js';
import { renderPickNext } from './views/picknext.js';
import { renderBoard } from './views/board.js';
import { renderTree } from './views/tree.js';
import { renderSessions } from './views/sessions.js';
import { renderDeployments } from './views/deployments.js';
import { renderToday } from './views/today.js';
import { renderDetail } from './views/detail.js';
import { renderHandoffForm } from './views/handoff-form.js';
import { renderStatusDialog, renderDeploymentDialog, renderExportDialog, renderHelpDialog, renderAttachDialog, renderLinkExternalDialog, renderSchedulesDialog, schedulesDialogKey, renderPublishDialog, publishDialogKey } from './views/dialogs.js';
import { createApi, uuidv4 } from './lib/api.js';
import { createDashboardMotion } from './lib/motion.js';
import { renderRecipeRunDialog, effectiveRecipes } from './views/agents.js';

const VIEWS = ['picknext', 'board', 'tree', 'sessions', 'deployments', 'today'];
const POLL_VISIBLE_MS = 2000;
const POLL_HIDDEN_MS = 30000;

const appState = {
  snapshot: null,
  online: true,
  view: 'picknext',
  filters: { project: '', category: '', tag: '', repo: '', machine: '', stale: false, q: '' },
  selected: null,
  requests: new Map(),
  refresh: null,
  dialog: null,
  theme: null,
  boardExpanded: new Set(),
  blockedExpanded: false,
  editingNext: null,
  boardPages: {},
  sessionsPage: 0,
  treeRoot: null,
  content: {},
  loadedTicket: null,
  lastFocus: null,
  error: null,
  receipt: null,
  endpoint: typeof location !== 'undefined' && location.host ? location.host : null,
};

function setReceipt(text, tone = 'neutral') {
  appState.receipt = { text, tone, at: nowIso() };
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
  if (VIEWS.includes(view)) appState.view = view;
  for (const k of ['project', 'category', 'tag', 'repo', 'machine', 'q']) if (params.has(k)) appState.filters[k] = params.get(k);
  appState.filters.stale = params.get('stale') === '1';
  appState.selected = params.get('ticket') || null;
  appState.treeRoot = params.get('root') || null;
}

// The drawer belongs to the view it was opened from: switching views closes it.
function setView(view) {
  if (view === appState.view) return;
  appState.view = view;
  appState.treeRoot = null;
  appState.selected = null;
  appState.editingNext = null;
  appState.loadedTicket = null;
}

function writeHash() {
  const params = new URLSearchParams();
  params.set('view', appState.view);
  for (const [k, v] of Object.entries(appState.filters)) if (v && k !== 'stale') params.set(k, v);
  if (appState.filters.stale) params.set('stale', '1');
  if (appState.selected) params.set('ticket', appState.selected);
  if (appState.treeRoot) params.set('root', appState.treeRoot);
  const next = `#${params.toString()}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

function layoutMode() {
  const w = window.innerWidth;
  if (w >= 1280) return 'desktop';
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
  const scroll = main.scrollTop;
  const searchFocused = document.activeElement && document.activeElement.id === 'search';
  const searchPos = searchFocused ? document.activeElement.selectionStart : null;
  setMarkup($('#sidebar'), renderSidebar(s, { view: appState.view, endpoint: appState.endpoint, online: appState.online }));
  // Keep the provider-error popover open across the header's per-minute re-render.
  const healthOpen = !!document.querySelector('#header .health-pop[open]');
  setMarkup($('#header'), renderHeader(s, { now, online: appState.online, refresh: appState.refresh, theme: appState.theme, filters: appState.filters, view: appState.view, endpoint: appState.endpoint, receipt: appState.receipt }));
  if (healthOpen) { const pop = $('#header .health-pop'); if (pop) pop.open = true; }
  if (searchFocused) { const sInput = $('#search'); if (sInput) { sInput.focus(); if (searchPos !== null) sInput.setSelectionRange(searchPos, searchPos); } }
  setMarkup($('#filters'), renderFilterBar(s));
  const pending = [...appState.requests.values()];
  const opts = { now, pending, selected: appState.selected };
  let html = '';
  if (appState.view === 'picknext') html = renderPickNext(s, appState.filters, { ...opts, blockedExpanded: appState.blockedExpanded });
  else if (appState.view === 'board') html = renderBoard(s, appState.filters, { ...opts, layout: layoutMode() === 'desktop' ? 'columns' : 'list', expanded: appState.boardExpanded, pages: appState.boardPages });
  else if (appState.view === 'tree') html = renderTree(s, appState.filters, { root: appState.treeRoot });
  else if (appState.view === 'sessions') html = renderSessions(s, appState.filters, { ...opts, page: appState.sessionsPage });
  else if (appState.view === 'deployments') html = renderDeployments(s, appState.filters, opts);
  else if (appState.view === 'today') html = renderToday(s, appState.filters, opts);
  setMarkup(main, (appState.error ? `<div class="banner critical" role="alert">${icon('alert')}${esc(appState.error)}</div>` : '') + renderPageHeading(appState.view, s) + html);
  main.scrollTop = renderedView === appState.view ? scroll : 0;
  renderedView = appState.view;
  document.body.dataset.layout = layoutMode();
  renderDetailPanel(now, pending);
  renderDialog();
  motion?.update({
    view: appState.view,
    results: JSON.stringify([appState.filters, appState.sessionsPage, appState.boardPages, [...appState.boardExpanded], appState.treeRoot]),
    detail: appState.selected,
    receipt: appState.receipt ? JSON.stringify(appState.receipt) : null,
  });
  writeHash();
}

function renderFilterBar(s) {
  const f = appState.filters;
  const tokens = [];
  for (const [k, v] of Object.entries(f)) {
    if (!v || k === 'project') continue;
    tokens.push(`<button type="button" class="token" data-action="clear-filter" data-filter="${attr(k)}" aria-label="Remove filter ${attr(k)}">${esc(k)}: ${esc(k === 'stale' ? 'stale only' : v)} ${icon('x')}</button>`);
  }
  const categories = ['feature', 'bugfix', 'vuln', 'infra', 'research', 'analysis'];
  const repos = s.repos ?? [];
  const tags = [...new Set(s.tickets.flatMap((t) => t.tags.filter((x) => !x.startsWith('quill/'))))];
  const projects = [...new Map(s.tickets.map((t) => [t.project_id, t.project_name])).entries()];
  return `<span class="eyebrow">${icon('search')}Filter by</span>
  <label>Project <select data-filter="project" aria-label="Project filter (applies to every view)"><option value="">All</option>${projects.map(([id, name]) => `<option value="${attr(id)}" ${f.project === id ? 'selected' : ''}>${esc(name ?? id)}</option>`).join('')}</select></label>
  <label>Category <select data-filter="category"><option value="">All</option>${categories.map((c) => `<option value="${c}" ${f.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
  ${repos.length ? `<label>Repo <select data-filter="repo"><option value="">All</option>${repos.map((r) => `<option value="${attr(r.id)}" ${f.repo === r.id ? 'selected' : ''}>${esc(r.display_name)}</option>`).join('')}</select></label>` : ''}
  ${tags.length ? `<label>Tag <select data-filter="tag"><option value="">All</option>${tags.map((t) => `<option value="${attr(t)}" ${f.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}
  <label class="check"><input type="checkbox" data-filter="stale" ${f.stale ? 'checked' : ''}> Stale only</label>
  ${tokens.length ? `<div class="tokens">${tokens.join('')}<button type="button" class="link small" data-action="clear-filters">Clear all</button></div>` : ''}`;
}

function renderDetailPanel(now, pending) {
  const panel = $('#detail');
  const s = appState.snapshot;
  const ticket = appState.selected ? ticketById(s, appState.selected) : null;
  const mode = layoutMode();
  panel.hidden = !ticket;
  document.body.dataset.detail = ticket ? 'open' : 'closed';
  if (!ticket) { setMarkup(panel, ''); panel.removeAttribute('aria-modal'); renderedDetail = null; return; }
  const modal = mode !== 'desktop';
  panel.setAttribute('role', modal ? 'dialog' : 'complementary');
  if (modal) panel.setAttribute('aria-modal', 'true'); else panel.removeAttribute('aria-modal');
  const active = document.activeElement;
  const activeId = active && panel.contains(active) ? active.id || active.dataset.action : null;
  const selectionStart = active && panel.contains(active) && active.tagName === 'TEXTAREA' ? active.selectionStart : null;
  const editing = active && panel.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
  if (editing) return; // never clobber an in-progress edit on poll
  setMarkup(panel, renderDetail(ticket, s, { now, pending, content: appState.content, loadedTicket: appState.loadedTicket, editingNext: appState.editingNext === ticket.id }));
  // A different ticket starts at its title, not at the previous ticket's scroll offset.
  if (renderedDetail !== ticket.id) { panel.scrollTop = 0; renderedDetail = ticket.id; }
  if (activeId) { const el = panel.querySelector(`#${CSS.escape(activeId)}`) || panel.querySelector(`[data-action="${CSS.escape(activeId)}"]`); if (el) { el.focus(); if (selectionStart !== null && el.setSelectionRange) el.setSelectionRange(selectionStart, selectionStart); } }
}

function renderDialog() {
  const host = $('#dialog');
  const d = appState.dialog;
  if (!d) { if (host.open) host.close(); host.innerHTML = ''; return; }
  const s = appState.snapshot;
  let html = '';
  if (d.type === 'handoff') html = renderHandoffForm(ticketById(s, d.ticket), s, { retryOf: d.retryOf });
  else if (d.type === 'status') html = renderStatusDialog(ticketById(s, d.ticket), d.status);
  else if (d.type === 'deployment') html = renderDeploymentDialog(ticketById(s, d.ticket), { mode: d.mode, deploymentId: d.deploymentId });
  else if (d.type === 'export') html = renderExportDialog(s, d.preview);
  else if (d.type === 'help') html = renderHelpDialog();
  else if (d.type === 'attach') {
    const sess = (s.sessions ?? []).find((x) => x.id === d.session);
    if (!sess) { appState.dialog = null; return renderDialog(); }
    html = renderAttachDialog(sess, s, { mode: d.mode });
  } else if (d.type === 'link-external') html = renderLinkExternalDialog(ticketById(s, d.ticket), s);
  else if (d.type === 'recipe-run') {
    const t = ticketById(s, d.ticket);
    const recipe = t ? effectiveRecipes(s, t.repo_id).find((r) => r.name === d.recipe && !r.error) : null;
    if (!recipe) { appState.dialog = null; return renderDialog(); }
    html = renderRecipeRunDialog(recipe, t, s, { retryOf: d.retryOf });
  } else if (d.type === 'publishers') html = renderPublishDialog(s, { now: nowIso(), pending: [...appState.requests.values()] });
  else if (d.type === 'schedules') html = renderSchedulesDialog(s, { now: nowIso(), pending: [...appState.requests.values()] });
  // The Schedules panel follows live state: it re-renders only when what it shows changes, and keeps
  // focus and any open run history across that re-render.
  const key = d.type === 'schedules' ? `${JSON.stringify(d)}:${schedulesDialogKey(s, appState.requests.values())}` : d.type === 'publishers' ? `${JSON.stringify(d)}:${publishDialogKey(s, appState.requests.values())}` : JSON.stringify(d);
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

async function poll() {
  clearTimeout(pollTimer);
  try {
    const snap = normalizeSnapshot(await api.getSnapshot());
    const changed = !appState.snapshot || snap.generation_id !== appState.snapshot.generation_id;
    appState.snapshot = snap;
    appState.online = true;
    appState.error = null;
    syncRequests(snap);
    if (changed) { appState.content = {}; appState.loadedTicket = null; }
    render();
  } catch (err) {
    if (err.code === 'unauthenticated') { appState.error = err.message; appState.online = false; }
    else appState.online = false;
    render();
  }
  if (!api.static) pollTimer = setTimeout(poll, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
}

function syncRequests(snap) {
  for (const r of snap.requests ?? []) {
    const local = appState.requests.get(r.id);
    if (local && local.state === 'already-applied') continue;
    if (local || ['pending', 'applying', 'conflict', 'failed'].includes(r.state)) {
      const prev = local ? local.state : null;
      appState.requests.set(r.id, { ...local, ...r, original: local ? local.original : null });
      if (prev && prev !== r.state && ['applied', 'conflict', 'failed', 'cancelled'].includes(r.state)) {
        const label = r.kind.replace(/-/g, ' ');
        const text = `${label} ${r.state}${r.state === 'conflict' ? ': the ticket changed first' : ''}${r.state === 'failed' && r.error ? `: ${r.error.message}` : ''}`;
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

// Inbox requests are checked against the session's unlinked-work revision, not a ticket's.
function targetRevision(r) {
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
    case 'cancel-next': appState.editingNext = null; render(); break;
    case 'toggle-blocked': appState.blockedExpanded = !appState.blockedExpanded; render(); break;
    case 'close-dialog': closeDialog(); break;
    case 'handoff': appState.dialog = { type: 'handoff', ticket: el.dataset.ticket, retryOf: el.dataset.retryOf ?? null }; render(); break;
    case 'record-deployment': appState.dialog = { type: 'deployment', ticket: el.dataset.ticket, mode: 'record', deploymentId: el.dataset.deployment ?? null }; render(); break;
    case 'attach-unbound': appState.dialog = { type: 'attach', session: el.dataset.session, mode: el.dataset.mode === 'create' ? 'create' : 'attach' }; render(); break;
    case 'dismiss-unbound': submit({ kind: 'dismiss-unbound', target_id: el.dataset.session, expected_revision: Number(el.dataset.revision), payload: {} }, { announceText: 'Dismissal queued; undo within 10 seconds' }); break;
    case 'link-external': appState.dialog = { type: 'link-external', ticket: el.dataset.ticket }; render(); break;
    case 'schedules': appState.dialog = { type: 'schedules' }; render(); break;
    case 'publishers': appState.dialog = { type: 'publishers' }; render(); break;
    case 'publish': {
      const confirm = el.dataset.confirm === 'true';
      submit({ kind: 'publish', target_id: null, expected_revision: null, payload: { publisher: el.dataset.publisher || null, confirm } }, { announceText: confirm ? `Confirmed; publishing ${el.dataset.publisher}` : `Publishing ${el.dataset.publisher}` });
      break;
    }
    case 'run-job': submit({ kind: 'run-job', target_id: null, expected_revision: null, payload: { schedule: el.dataset.schedule } }, { announceText: `Running ${el.dataset.schedule} now` }); break;
    case 'waive-deployment': appState.dialog = { type: 'deployment', ticket: el.dataset.ticket, mode: 'waive', deploymentId: el.dataset.deployment ?? null }; render(); break;
    case 'toggle-column': if (appState.boardExpanded.has('done')) appState.boardExpanded.delete('done'); else appState.boardExpanded.add('done'); render(); break;
    case 'column-page': appState.boardPages[el.dataset.column] = Number(el.dataset.page); render(); break;
    case 'toggle-stale': appState.filters.stale = !appState.filters.stale; render(); break;
    case 'sessions-page': appState.sessionsPage = Number(el.dataset.page); render(); break;
    case 'tree-root': appState.treeRoot = el.dataset.root || null; render(); break;
    case 'clear-filter': appState.filters[el.dataset.filter] = el.dataset.filter === 'stale' ? false : ''; render(); break;
    case 'clear-filters': appState.filters = { ...appState.filters, category: '', tag: '', repo: '', machine: '', stale: false, q: '' }; render(); break;
    case 'cancel-request': cancelRequest(el.dataset.request); break;
    case 'discard-request': appState.requests.delete(el.dataset.request); render(); break;
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
    case 'undo-file-effect': submit({ kind: 'undo-file-effect', target_id: el.dataset.ticket, expected_revision: null, payload: { handoff_id: el.dataset.handoff, effect_id: el.dataset.effect } }, { announceText: 'Undo queued; the file is restored within 10 seconds' }); break;
    case 'run-recipe': appState.dialog = { type: 'recipe-run', ticket: el.dataset.ticket, recipe: el.dataset.recipe, retryOf: el.dataset.retryOf ?? null }; render(); break;
    case 'accept-suggestion':
    case 'dismiss-suggestion': {
      const accept = el.dataset.action === 'accept-suggestion';
      submit({ kind: el.dataset.action, target_id: el.dataset.ticket, expected_revision: accept ? ticketRevision(el.dataset.ticket) : null, payload: { handoff_id: el.dataset.handoff, suggestion_id: el.dataset.suggestion } }, { announceText: accept ? 'Accepting the suggestion; undo within 10 seconds' : 'Dismissing the suggestion; undo within 10 seconds' });
      break;
    }
    case 'cancel-handoff': {
      const h = s.handoffs.find((x) => x.id === el.dataset.handoff);
      if (h) submit({ kind: 'handoff-cancel', target_id: h.ticket_id, expected_revision: ticketRevision(h.ticket_id), payload: { handoff_id: h.id } }, { announceText: 'Handoff cancellation requested' });
      break;
    }
    case 'load-content': {
      const hash = el.dataset.hash;
      api.getContent(hash, el.dataset.generation).then((text) => { appState.content[hash] = text ?? '(content unavailable: capture incomplete)'; render(); }).catch((err) => { if (err.code === 'generation-expired') poll(); });
      break;
    }
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
  appState.loadedTicket = null;
  appState.editingNext = null;
  render();
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
  } else if (kind === 'handoff') {
    const permissions = {};
    for (const k of ['read_source', 'edit_source', 'commit', 'push_branch', 'open_draft_pr']) permissions[k] = fd.get(k) === 'on';
    const payload = { mode: fd.get('mode'), note: String(fd.get('note') ?? '').trim(), permissions, access: fd.get('access') || 'settings', branch: String(fd.get('branch') ?? '').trim() || null };
    const retryOf = form.dataset.retryOf || null;
    closeDialog();
    submit({ kind: 'handoff', target_id: ticketId, expected_revision: revision, payload, retry_of: retryOf }, { announceText: 'Handoff request accepted; execution is tracked separately' });
  } else if (kind === 'recipe-run') {
    // Disabled boxes are not submitted: permissions the recipe requires come from the form itself.
    const required = form.dataset.requiresEdit === 'true';
    const permissions = {};
    for (const k of ['read_source', 'edit_source', 'commit', 'push_branch', 'open_draft_pr', 'edit_files', 'delete_files']) permissions[k] = fd.get(k) === 'on';
    if (required) { permissions.read_source = true; permissions.edit_source = true; }
    const payload = { recipe: form.dataset.recipe, note: String(fd.get('note') ?? '').trim(), permissions, access: fd.get('access') || 'standard', branch: String(fd.get('branch') ?? '').trim() || null };
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
  } else if (kind === 'export') {
    const d = appState.dialog;
    api.exportRun({ ...(d.params ?? exportParams(form)) }).then((res) => { announce(`Snapshot saved to ${res.path}`); appState.dialog = { ...d, saved: res.path, error: null }; closeDialog(); appState.error = null; alert(`Saved read-only snapshot to ${res.path}. Share the file yourself; it will not update.`); }).catch((err) => { appState.dialog = { ...d, error: err.message }; render(); });
  }
}

function onKey(e) {
  const target = e.target;
  const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
  const dialogOpen = $('#dialog').open;
  if (e.key === 'Escape') {
    const pop = document.querySelector('.health-pop[open]');
    if (pop) { e.preventDefault(); pop.open = false; pop.querySelector('summary')?.focus(); return; }
    if (dialogOpen) { e.preventDefault(); closeDialog(); return; }
    if (appState.selected && !inInput) { e.preventDefault(); closeDetail(); return; }
    if (inInput && target.form && target.form.dataset.form === 'next-action') { target.value = ticketById(appState.snapshot, target.form.dataset.ticket).next_action; target.blur(); appState.editingNext = null; render(); return; }
  }
  if (inInput || dialogOpen) {
    if (e.key === 'Enter' && !e.shiftKey && target.tagName === 'TEXTAREA' && target.form && target.form.dataset.form === 'next-action') { e.preventDefault(); handleSubmit(target.form); }
    return;
  }
  if (e.key === '/') { e.preventDefault(); const s = $('#search'); if (s) s.focus(); return; }
  if (/^[1-6]$/.test(e.key)) { setView(VIEWS[Number(e.key) - 1]); render(); const tab = $(`#tab-${appState.view}`); if (tab) tab.focus(); return; }
  if (e.key === '?') { appState.lastFocus = document.activeElement; appState.dialog = { type: 'help' }; render(); return; }
  const card = target && target.closest ? target.closest('[data-ticket][role=button]') : null;
  if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(card.dataset.ticket, card); return; }
  if (card && e.key === 'h' && card.querySelector('[data-action="handoff"]')) { e.preventDefault(); appState.lastFocus = card; appState.dialog = { type: 'handoff', ticket: card.dataset.ticket }; render(); return; }
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
  const open = e.target.closest('[data-open]');
  if (open) { e.preventDefault(); openDetail(open.dataset.open, open); return; }
  const action = e.target.closest('[data-action]');
  if (action && action.dataset.action !== 'detail-nav') { e.preventDefault(); appState.lastFocus = appState.lastFocus ?? action; handleAction(action); return; }
  const tab = e.target.closest('[data-view]');
  if (tab) { setView(tab.dataset.view); render(); return; }
  const card = e.target.closest('#main [data-ticket][role=button]');
  if (card && !e.target.closest('button, a, [data-copy]')) openDetail(card.dataset.ticket, card);
}

function onChange(e) {
  const el = e.target;
  if (el.dataset.filter) {
    appState.filters[el.dataset.filter] = el.type === 'checkbox' ? el.checked : el.value;
    appState.boardPages = {};
    appState.sessionsPage = 0;
    render();
    if (el.dataset.filter === 'q') { const s = $('#search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
    return;
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
  motion = createDashboardMotion(document, window.matchMedia('(prefers-reduced-motion: reduce)'));
  readHash();
  const staticSnapshot = window.__SNAPSHOT__ ?? null;
  api = createApi({ staticSnapshot });
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  document.addEventListener('change', onChange);
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
