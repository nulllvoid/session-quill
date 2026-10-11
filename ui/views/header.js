import { esc, attr, icon, timeEl, STATUS_ORDER, normalizeSnapshot, viewCounts, openProposals, EMPTY_FILTERS, NEEDS_CLONE_FILTER } from '../components.js';
import { freshness, relativeTime } from '../lib/time.js';
import { needsYouCount } from '../lib/runs.js';

const FRESH_LABELS = { 'never-synced': 'Never synced', fresh: 'Fresh', ageing: 'Ageing', stale: 'Stale' };
export const NAV_ITEMS = [
  ['picknext', 'Pick next', 'ticket', '1', 'work'], ['board', 'Board', 'machine', '2', 'work'], ['runs', 'Runs', 'play', '7', 'work'],
  ['today', 'Activity', 'clock', '6', 'track'], ['sessions', 'Sessions', 'user', '4', 'track'], ['deployments', 'Deployments', 'rocket', '5', 'track'], ['tree', 'Relationships', 'branch', '3', 'track'],
];
// The phone bottom bar holds these four plus More (at most five items).
export const PHONE_PRIMARY = new Set(['picknext', 'board', 'runs', 'today']);
const GROUP_LABELS = { work: 'Work', track: 'Track' };
export const SHORTCUT_VIEWS = { 1: 'picknext', 2: 'board', 3: 'tree', 4: 'sessions', 5: 'deployments', 6: 'today', 7: 'runs' };

export function renderPageHeading(view, snapshot) {
  const label = NAV_ITEMS.find(([id]) => id === view)?.[1] ?? 'Pick next';
  return `<header class="page-heading"><h1>${esc(label)}</h1><span class="workspace-label">${icon('branch')}${esc(snapshot.meta.store_name || 'Local workspace')}</span></header>`;
}

export function logoSvg() {
  return '<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="28" height="28" fill="none" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--accent-fill)"/><path d="M22.5 7.5c-6 1-10.5 5.5-12 13l-1 4 3.2-2.6c6.8-1.4 10.3-6.2 9.8-14.4Z" fill="var(--accent-fg)"/><path d="M9.5 24.5l6-8" stroke="var(--accent-fill)" stroke-width="1.4" stroke-linecap="round"/></svg>';
}

function navButton(item, { view, counts, needs }) {
  const [id, label, ic, key] = item;
  const badge = counts[id] ?? 0;
  const dot = id === 'runs' && needs ? '<span class="attention-dot" aria-hidden="true"></span>' : '';
  const name = id === 'runs' ? `${label}, ${badge} live${needs ? `, ${needs} need${needs === 1 ? 's' : ''} you` : ''}` : `${label}, ${badge} items`;
  return `<button type="button" role="tab" class="nav-item${PHONE_PRIMARY.has(id) ? '' : ' nav-overflow'}" title="${esc(label)}" aria-label="${attr(name)}" data-view="${id}" id="tab-${id}" aria-selected="${view === id ? 'true' : 'false'}" aria-controls="main" aria-keyshortcuts="${key}">${icon(ic)}<span class="nav-label">${esc(label)}</span>${dot}<span class="badge" aria-hidden="true" title="Shortcut ${key}">${esc(badge)}</span></button>`;
}

function navGroups(opts) {
  return ['work', 'track'].map((g) => `<span class="nav-caption">${GROUP_LABELS[g]}</span>${NAV_ITEMS.filter((n) => n[4] === g).map((n) => navButton(n, opts)).join('')}`).join('');
}

function moreControl({ view, moreOpen, counts }) {
  const overflow = NAV_ITEMS.filter(([id]) => !PHONE_PRIMARY.has(id));
  const current = overflow.some(([id]) => id === view);
  const sheet = moreOpen ? `<div id="more-sheet" class="more-sheet" role="dialog" aria-label="More views"><button type="button" class="more-backdrop" data-action="toggle-more" aria-label="Close"></button><div class="more-panel">${overflow.map(([id, label, ic]) => `<button type="button" class="nav-item" data-view="${id}"${view === id ? ' aria-current="page"' : ''}>${icon(ic)}<span class="nav-label">${esc(label)}</span><span class="badge">${esc(counts[id] ?? 0)}</span></button>`).join('')}</div></div>` : '';
  return `<button type="button" class="nav-item nav-more" data-action="toggle-more" aria-expanded="${moreOpen}" aria-controls="more-sheet"${current ? ' aria-current="page"' : ''}>${icon('chevron')}<span class="nav-label">More</span></button>${sheet}`;
}

export function renderSidebar(rawSnapshot, { view = 'picknext', endpoint = null, online = true, filters = {}, collapsed = false, now = null, moreOpen = false } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const meta = snapshot ? snapshot.meta : null;
  const counts = snapshot ? viewCounts(snapshot, filters) : {};
  const isStatic = !!(meta && meta.exported_at);
  const needs = snapshot && now && !isStatic ? needsYouCount(snapshot, now) : 0;
  const opts = { view, counts, needs, moreOpen };
  const conn = isStatic ? 'snapshot' : online ? 'online' : 'offline';
  return `<div class="sidebar-brand">${logoSvg()}<div class="brand-text"><span class="brand-name">Session Quill</span><span class="brand-sub">${isStatic ? 'Snapshot' : 'Local'}${meta ? ` · v${esc(meta.tracker_version)}` : ''}</span></div></div>
<button type="button" class="btn small ghost sidebar-toggle" data-action="toggle-sidebar" aria-label="${collapsed ? 'Expand navigation' : 'Collapse navigation'}" aria-expanded="${!collapsed}">${icon('machine')}<span class="nav-label">Collapse navigation</span></button><div class="nav" role="tablist" aria-label="Views">${navGroups(opts)}</div>${moreControl(opts)}
${meta ? `<details class="sidebar-section workspace-details"><summary>Workspace details</summary>
<dl class="context-list">
  <div><dt>Store</dt><dd title="${attr(meta.store_name)}">${esc(meta.store_name)}</dd></div>
  <div><dt>Timezone</dt><dd title="${attr(meta.timezone)}">${esc(meta.timezone)}</dd></div>
  <div><dt>Schema</dt><dd>${esc(meta.schema_version)}</dd></div>
  <div><dt>Stale</dt><dd${meta.stale_ticket_count ? ' class="stale-count"' : ''}>${esc(meta.stale_ticket_count)} ticket${meta.stale_ticket_count === 1 ? '' : 's'}</dd></div>
</dl></details>` : ''}
<div class="sidebar-foot">
  <div class="conn" data-connection="${conn}"><span class="dot" aria-hidden="true"></span><span class="conn-text"><strong>${isStatic ? 'Read-only snapshot' : online ? 'Connected' : 'Worker offline'}</strong><span>${isStatic ? `Exported ${esc(meta.exported_at)}` : esc(endpoint ?? '127.0.0.1')}</span></span></div>
</div>`;
}

const PROVIDER_NAMES = { github: 'GitHub', bitbucket: 'Bitbucket', null: 'PR provider' };

// Provider errors arrive as raw tool output; say what is wrong and what to do in one short line.
export function humaniseProviderError(provider, error) {
  const name = PROVIDER_NAMES[provider] ?? provider;
  const text = String(error ?? '').trim();
  const repo = /no PR provider configured for repository (\S+?);?(\s|$)/.exec(text);
  if (repo) return `No PR provider is set up for ${repo[1]}, so its PRs are not refreshed.`;
  if (/gh auth login|not logged in|authenticat|401|403|bad credentials/i.test(text)) return `${name} is not signed in. Run gh auth login, then refresh.`;
  if (/(command not found|not recognized|ENOENT)/i.test(text)) return `${name} CLI is not installed or not on PATH.`;
  if (/rate limit/i.test(text)) return `${name} rate limit reached; PRs refresh on the next run.`;
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|timed out/i.test(text)) return `Could not reach ${name}; PRs refresh on the next run.`;
  if (/malformed JSON/i.test(text)) return `${name} returned an unreadable response.`;
  const first = text.split(/(?<=[.;])\s/)[0].replace(/[;.]$/, '');
  return `${name}: ${first ? first.charAt(0).toUpperCase() + first.slice(1) : 'unknown error'}.`;
}

function providerHealth(meta, { now, tz }) {
  const providers = meta.provider_health ?? [];
  const failing = providers.filter((p) => p.error);
  if (!failing.length) {
    if (!providers.length) return '';
    return `<span class="health-item" data-health="ok"><span class="dot" aria-hidden="true"></span>Providers: ok</span>`;
  }
  const label = failing.length === 1 ? '1 provider error' : `${failing.length} provider errors`;
  const rows = failing.map((p) => `<li><strong>${esc(PROVIDER_NAMES[p.provider] ?? p.provider)}</strong> ${esc(humaniseProviderError(p.provider, p.error))}${p.last_success_at ? ` <span class="muted">Last worked ${timeEl(p.last_success_at, now, tz)}.</span>` : ''}<details class="raw"><summary>Details</summary><code>${esc(p.error)}</code></details></li>`).join('');
  return `<details class="health-item health-pop" data-health="error"><summary><span class="dot" aria-hidden="true"></span>${esc(label)}</summary><div class="popover" role="group" aria-label="Provider errors"><ul>${rows}</ul><p class="muted small">PR and merge evidence from these providers is shown as last observed.</p></div></details>`;
}

export function renderHealth(snapshot, { now, online, includeProviders = true }) {
  const meta = snapshot.meta;
  const tz = meta.timezone;
  const f = freshness(meta, now);
  const parts = [];
  parts.push(`<span class="health-item" data-freshness="${attr(f)}" title="${attr(meta.last_sync ? `Last sync ${meta.last_sync}` : 'No reconciliation has completed')}"><span class="dot" aria-hidden="true"></span>Sync: ${meta.last_sync ? timeEl(meta.last_sync, now, tz) : 'never'} <strong>(${esc(FRESH_LABELS[f])})</strong></span>`);
  if (meta.next_sync_due && !meta.exported_at) parts.push(`<span class="health-item">Next ${esc(relativeTime(meta.next_sync_due, now))}</span>`);
  if (!meta.exported_at) {
    const worker = `<span class="dot" aria-hidden="true"></span>Worker: ${online ? 'connected' : '<strong>Offline</strong>. Last generation shown, submissions disabled'}`;
    // With a login entry (ADR 0022) the worker item opens a popover saying so.
    if (meta.worker_autostart) parts.push(`<details class="health-item health-pop" data-connection="${online ? 'online' : 'offline'}"><summary>${worker}</summary><div class="popover" role="group" aria-label="Worker"><p>Starts at login</p><p class="muted small">Registered with quill worker install. Remove it with quill worker uninstall.</p></div></details>`);
    else parts.push(`<span class="health-item" data-connection="${online ? 'online' : 'offline'}">${worker}</span>`);
  }
  const ch = meta.capture_health ?? { status: 'ok' };
  parts.push(`<span class="health-item" data-health="${attr(ch.status)}"><span class="dot" aria-hidden="true"></span>Capture: ${esc(ch.status)}${ch.reason ? ` (${esc(ch.reason)})` : ''}${meta.oldest_pending_event_at ? ` · backlog since ${timeEl(meta.oldest_pending_event_at, now, tz)}` : ''}</span>`);
  const providers = providerHealth(meta, { now, tz });
  if (providers && includeProviders) parts.push(providers);
  if (meta.unresolved_event_count) parts.push(`<span class="health-item" data-health="degraded"><span class="dot" aria-hidden="true"></span>${esc(meta.unresolved_event_count)} unresolved event${meta.unresolved_event_count === 1 ? '' : 's'}</span>`);
  if (meta.exported_at) parts.push(`<span class="health-item" data-health="snapshot"><span class="dot" aria-hidden="true"></span>Snapshot exported ${timeEl(meta.exported_at, now, tz)} · fixed last sync ${meta.last_sync ? esc(meta.last_sync) : 'never'} · will not update</span>`);
  return parts.join('');
}

export function renderRefreshControl(snapshot, { online, refresh }) {
  const caps = snapshot.capabilities ?? {};
  if (!caps.refresh) return '';
  let label = 'Refresh';
  let note = '';
  if (refresh) {
    if (refresh.state === 'sending') label = 'Sending…';
    else if (refresh.state === 'pending') label = 'Queued';
    else if (refresh.state === 'applying') label = 'Running…';
    else if (refresh.state === 'failed') { label = 'Retry refresh'; note = `<span class="critical">${refresh.error ? esc(refresh.error.message) : 'refresh failed'}</span>`; }
    else if (refresh.state === 'applied') note = '<span class="good">Reconciled</span>';
  }
  const busy = refresh && ['sending', 'pending', 'applying'].includes(refresh.state);
  const disabled = !online || busy;
  const title = !online ? 'Offline: nothing can be queued until the worker connection returns' : 'Run reconciliation now (independent of the 2-hour schedule)';
  return `<span class="health-right">${note}<button type="button" class="btn small" data-action="refresh" ${disabled ? 'disabled' : ''} title="${attr(title)}">${icon('refresh')}${esc(label)}</button></span>`;
}

export function statusLabel(snapshot, { now, online }) {
  const meta = snapshot.meta;
  if (meta.exported_at) return { text: 'Read-only snapshot', tone: 'muted' };
  if (!online) return { text: 'Offline', tone: 'critical' };
  const failing = (meta.provider_health ?? []).filter((p) => p.error).length;
  if (failing) return { text: failing === 1 ? '1 provider error' : `${failing} provider errors`, tone: 'critical' };
  if ((meta.capture_health && meta.capture_health.status !== 'ok') || meta.unresolved_event_count) return { text: 'Needs attention', tone: 'warning' };
  return { text: meta.last_sync ? `Updated ${relativeTime(meta.last_sync, now)}` : 'Not synced yet', tone: 'good' };
}

// Errors stay until dismissed; everything else clears itself (spec §1).
export function receiptLifetime(tone) {
  return tone === 'critical' ? null : 6000;
}

export function activeFilterCount(f = {}) {
  return ['project', 'category', 'tag', 'repo', 'machine', 'q'].filter((k) => f[k]).length + (f.stale ? 1 : 0);
}

export function renderFilterBar(rawSnapshot, f = EMPTY_FILTERS) {
  const s = normalizeSnapshot(rawSnapshot);
  const tokens = [];
  for (const [k, v] of Object.entries(f)) {
    if (!v || k === 'project') continue;
    tokens.push(`<button type="button" class="token" data-action="clear-filter" data-filter="${attr(k)}" aria-label="Remove filter ${attr(k)}">${esc(k)}: ${esc(k === 'stale' ? 'stale only' : v === NEEDS_CLONE_FILTER ? 'needs clone' : v)} ${icon('x')}</button>`);
  }
  const categories = ['feature', 'bugfix', 'vuln', 'infra', 'research', 'analysis'];
  const repos = s.repos ?? [];
  const needsClone = s.tickets.some((t) => t.repo_state === 'needs-clone');
  const tags = [...new Set(s.tickets.flatMap((t) => (t.tags ?? []).filter((x) => !x.startsWith('quill/'))))];
  const projects = [...new Map(s.tickets.map((t) => [t.project_id, t.project_name])).entries()];
  const n = activeFilterCount(f);
  const controls = `<label>Project <select data-filter="project" aria-label="Project filter (applies to every view)"><option value="">All</option>${projects.map(([id, name]) => `<option value="${attr(id)}" ${f.project === id ? 'selected' : ''}>${esc(name ?? id)}</option>`).join('')}</select></label>
  <label>Category <select data-filter="category"><option value="">All</option>${categories.map((c) => `<option value="${c}" ${f.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
  ${repos.length || needsClone ? `<label>Repo <select data-filter="repo"><option value="">All</option>${repos.map((r) => `<option value="${attr(r.id)}" ${f.repo === r.id ? 'selected' : ''}>${esc(r.display_name)}</option>`).join('')}${needsClone || f.repo === NEEDS_CLONE_FILTER ? `<option value="${NEEDS_CLONE_FILTER}" ${f.repo === NEEDS_CLONE_FILTER ? 'selected' : ''}>Needs clone</option>` : ''}</select></label>` : ''}
  ${tags.length ? `<label>Tag <select data-filter="tag"><option value="">All</option>${tags.map((t) => `<option value="${attr(t)}" ${f.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}
  <label class="check"><input type="checkbox" data-filter="stale" ${f.stale ? 'checked' : ''}> Stale only</label>`;
  return `<details class="filter-pop health-pop"><summary class="btn small ghost">${icon('search')}Filter${n ? ` · ${n}` : ''}</summary><div class="popover filter-popover" role="group" aria-label="Filters">${controls}</div></details>${tokens.length ? `<div class="tokens">${tokens.join('')}<button type="button" class="link small" data-action="clear-filters">Clear all</button></div>` : ''}`;
}

export function renderReceipt(receipt, { online }) {
  if (!receipt) return '';
  return `<div class="receipt toast" data-tone="${attr(receipt.tone ?? 'neutral')}" title="${attr(receipt.at ?? '')}">${icon(receipt.tone === 'critical' ? 'alert' : 'check')}<span class="receipt-text">Receipt: ${esc(receipt.text)}</span><span class="live">${online ? 'LIVE' : 'OFFLINE'}</span><button type="button" class="btn small ghost icon-only" data-action="dismiss-receipt" aria-label="Dismiss">${icon('x')}</button></div>`;
}

export function renderHeader(rawSnapshot, { now, online, refresh, theme, filters = {}, view = 'picknext', endpoint = null, receipt = null }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const caps = snapshot.capabilities ?? {};
  const isStatic = !!snapshot.meta.exported_at;
  return `<div class="topbar">
  <div class="brand">${logoSvg()}<span>Session Quill</span></div>
  <label class="search">${icon('search')}<input type="search" id="search" data-filter="q" placeholder="Search tickets, keys, tags" value="${attr(filters.q ?? '')}" aria-label="Search tickets"><kbd aria-hidden="true">/</kbd></label>
  ${(() => { const st = statusLabel(snapshot, { now, online }); return `<details class="health-pop status-pop" data-tone="${st.tone}"><summary class="btn small ghost status-button" aria-label="${attr(`Workspace status: ${st.text}`)}"><span class="dot" aria-hidden="true"></span><span class="status-label">${esc(st.text)}</span></summary><div class="popover status-popover" role="group" aria-label="Workspace status">
    ${renderHealth(snapshot, { now, online, includeProviders: true })}
    ${!online ? '<p class="critical small">Changes unavailable until the worker reconnects.</p>' : ''}
    ${renderRefreshControl(snapshot, { online, refresh })}
    <p class="endpoint" title="${attr(isStatic ? 'Read-only exported snapshot' : 'Owner session on loopback')}">${isStatic ? 'snapshot' : esc(endpoint ?? '127.0.0.1')} <strong>${isStatic ? 'Viewer' : 'Owner'}</strong>${!isStatic && endpoint ? ` <button type="button" class="btn small ghost icon-only endpoint-copy" data-copy="${attr(`http://${endpoint}/`)}" data-copy-label="the dashboard address" aria-label="Copy the dashboard address">${icon('copy')}</button>` : ''}</p>
  </div></details>`; })()}
  <div class="topbar-actions">
    ${openProposals(snapshot).length ? `<button type="button" class="btn small attention-button" data-action="review-proposals" aria-label="${openProposals(snapshot).length} awaiting approval">${icon('alert')}${openProposals(snapshot).length}<span class="action-label"> awaiting approval</span></button>` : ''}
    ${snapshot.schedules.length && !isStatic ? `<button type="button" class="btn small ghost" data-action="schedules">${icon('clock')}<span class="action-label">Schedules</span></button>` : ''}
    ${(snapshot.publishers ?? []).length && !isStatic ? `<button type="button" class="btn small ghost" data-action="publishers" data-publish-state="${snapshot.publishers.some((p) => p.last_outcome === 'failed' || !p.confirmed) ? 'attention' : 'ok'}">${icon('download')}<span class="action-label">Publish</span></button>` : ''}
    ${caps.export ? `<button type="button" class="btn small ghost" data-action="export">${icon('download')}<span class="action-label">Export</span></button>` : ''}
    <button type="button" class="btn small ghost icon-only" data-action="theme" aria-label="Switch to ${theme === 'dark' ? 'light' : 'dark'} theme" title="Theme">${icon(theme === 'dark' ? 'sun' : 'moon')}</button>
    <button type="button" class="btn small ghost icon-only" data-action="help" aria-label="Keyboard shortcuts" title="Help (?)">${icon('help')}</button>
  </div>
</div>
${renderReceipt(receipt, { online })}`;
}

export function statusCounts(snapshot) {
  return STATUS_ORDER.map((s) => [s, snapshot.meta.counts_by_status ? snapshot.meta.counts_by_status[s] ?? 0 : 0]);
}
