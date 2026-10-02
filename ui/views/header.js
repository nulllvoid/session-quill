import { esc, attr, icon, timeEl, STATUS_ORDER, normalizeSnapshot } from '../components.js';
import { freshness, relativeTime } from '../lib/time.js';

const FRESH_LABELS = { 'never-synced': 'Never synced', fresh: 'Fresh', ageing: 'Ageing', stale: 'Stale' };
export const NAV_ITEMS = [['picknext', 'Pick next', 'ticket', '1'], ['board', 'Board', 'machine', '2'], ['tree', 'Tree', 'branch', '3'], ['sessions', 'Sessions', 'user', '4'], ['deployments', 'Deployments', 'rocket', '5']];

export function logoSvg() {
  return '<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="28" height="28" fill="none" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--surface)" stroke="var(--border)" stroke-width="1.5"/><path d="M7 11h18M7 16h11M7 21h15" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round"/><circle cx="23" cy="16" r="3" fill="var(--accent-fill)"/><path d="M21 16l1.5 1.5L25 14" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

export function renderSidebar(rawSnapshot, { view = 'picknext', endpoint = null, online = true } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const meta = snapshot ? snapshot.meta : null;
  const counts = snapshot ? {
    picknext: (snapshot.picknext ?? []).length,
    board: snapshot.tickets.filter((t) => t.status !== 'done').length,
    tree: snapshot.tickets.filter((t) => !t.parent_id).length,
    sessions: snapshot.sessions.filter((s) => s.state === 'live' || s.state === 'idle').length,
    deployments: (snapshot.deployments_outstanding ?? []).length,
  } : {};
  const isStatic = !!(meta && meta.exported_at);
  return `<div class="sidebar-head"><span class="eyebrow">${icon('machine')}Workspace</span><span class="pill">${isStatic ? 'SNAPSHOT' : 'LOCAL'}</span></div>
<div class="nav" role="tablist" aria-label="Views">
  ${NAV_ITEMS.map(([id, label, ic, key]) => `<button type="button" role="tab" class="nav-item" data-view="${id}" id="tab-${id}" aria-selected="${view === id ? 'true' : 'false'}" aria-controls="main" aria-keyshortcuts="${key}">${icon(ic)}<span class="nav-label">${esc(label)}</span><span class="badge" aria-label="${attr(`${counts[id] ?? 0} items, shortcut ${key}`)}" title="Shortcut ${key}">${esc(counts[id] ?? key)}</span></button>`).join('')}
</div>
${meta ? `<div><span class="eyebrow">Runtime context</span>
<div class="context-card" style="margin-top:8px">
  <div class="row"><span>Store</span><span>${esc(meta.store_name)}</span></div>
  <div class="row"><span>Timezone</span><span>${esc(meta.timezone)}</span></div>
  <div class="row"><span>Quill</span><span>v${esc(meta.tracker_version)}</span></div>
  <div class="row"><span>Schema</span><span>${esc(meta.schema_version)}</span></div>
  <div class="row"><span>Stale</span><span>${esc(meta.stale_ticket_count)} ticket${meta.stale_ticket_count === 1 ? '' : 's'}</span></div>
</div></div>` : ''}
<div class="sidebar-foot">
  <div class="context-card">
    <div class="row"><span>${isStatic ? 'Snapshot' : 'Loopback'}</span><span class="${isStatic ? 'muted' : online ? 'good' : 'critical'}">${isStatic ? 'READ-ONLY' : online ? 'ACTIVE' : 'OFFLINE'}</span></div>
    <div class="row"><span>${isStatic ? 'Exported' : 'Endpoint'}</span><span>${isStatic ? esc(meta.exported_at) : esc(endpoint ?? '127.0.0.1')}</span></div>
  </div>
  <div class="sidebar-copy"><span>Session Quill</span><span>${meta ? `v${esc(meta.tracker_version)}` : ''}</span></div>
</div>`;
}

export function renderHealth(snapshot, { now, online }) {
  const meta = snapshot.meta;
  const tz = meta.timezone;
  const f = freshness(meta, now);
  const parts = [];
  parts.push(`<span class="health-item" data-freshness="${attr(f)}" title="${attr(meta.last_sync ? `Last sync ${meta.last_sync}` : 'No reconciliation has completed')}"><span class="dot" aria-hidden="true"></span>Sync: ${meta.last_sync ? timeEl(meta.last_sync, now, tz) : 'never'} <strong>(${esc(FRESH_LABELS[f])})</strong></span>`);
  if (meta.next_sync_due && !meta.exported_at) parts.push(`<span class="health-item">Next ${esc(relativeTime(meta.next_sync_due, now))}</span>`);
  if (!meta.exported_at) {
    parts.push(`<span class="health-item" data-connection="${online ? 'online' : 'offline'}"><span class="dot" aria-hidden="true"></span>Worker: ${online ? 'connected' : '<strong>Offline</strong> — last generation shown, submissions disabled'}</span>`);
  }
  const ch = meta.capture_health ?? { status: 'ok' };
  parts.push(`<span class="health-item" data-health="${attr(ch.status)}"><span class="dot" aria-hidden="true"></span>Capture: ${esc(ch.status)}${ch.reason ? ` — ${esc(ch.reason)}` : ''}${meta.oldest_pending_event_at ? ` · backlog since ${timeEl(meta.oldest_pending_event_at, now, tz)}` : ''}</span>`);
  for (const p of meta.provider_health ?? []) {
    if (p.error) parts.push(`<span class="health-item" data-health="error"><span class="dot" aria-hidden="true"></span>${esc(p.provider)}: ${esc(p.error)}${p.last_success_at ? ` (last ok ${timeEl(p.last_success_at, now, tz)})` : ''}</span>`);
    else parts.push(`<span class="health-item" data-health="ok"><span class="dot" aria-hidden="true"></span>${esc(p.provider)}: ok</span>`);
  }
  if (meta.unresolved_event_count) parts.push(`<span class="health-item" data-health="degraded"><span class="dot" aria-hidden="true"></span>${esc(meta.unresolved_event_count)} unresolved event${meta.unresolved_event_count === 1 ? '' : 's'}</span>`);
  if (meta.exported_at) parts.push(`<span class="health-item" data-health="snapshot"><span class="dot" aria-hidden="true"></span>Snapshot exported ${timeEl(meta.exported_at, now, tz)} · fixed last sync ${meta.last_sync ? esc(meta.last_sync) : 'never'} · will not update</span>`);
  return parts.join('');
}

export function renderRefreshControl(snapshot, { online, refresh }) {
  const caps = snapshot.capabilities ?? {};
  if (!caps.refresh) return '';
  let label = 'Refresh';
  let status = 'Idle';
  let note = '';
  if (refresh) {
    if (refresh.state === 'sending') { label = 'Sending…'; status = 'Sending'; }
    else if (refresh.state === 'pending') { label = 'Queued'; status = 'Queued'; }
    else if (refresh.state === 'applying') { label = 'Running…'; status = 'Running'; }
    else if (refresh.state === 'failed') { label = 'Retry refresh'; status = 'Failed'; note = `<span class="critical">${refresh.error ? esc(refresh.error.message) : 'refresh failed'}</span>`; }
    else if (refresh.state === 'applied') { status = 'Reconciled'; note = '<span class="good">Reconciled</span>'; }
  }
  const busy = refresh && ['sending', 'pending', 'applying'].includes(refresh.state);
  const disabled = !online || busy;
  const title = !online ? 'Offline: nothing can be queued until the worker connection returns' : 'Run reconciliation now (independent of the 2-hour schedule)';
  return `<span class="health-right"><span>Status: <strong>${esc(status)}</strong></span>${note}<button type="button" class="btn small" data-action="refresh" ${disabled ? 'disabled' : ''} title="${attr(title)}">${icon('refresh')}${esc(label)}</button></span>`;
}

export function renderReceipt(receipt, { online }) {
  if (!receipt) return `<div class="receipt" data-tone="neutral">${icon('check')}<span class="receipt-text">Receipt: waiting for the first persisted outcome. Only acknowledged persisted requests count as queued.</span><span class="live">${online ? 'LIVE' : 'OFFLINE'}</span></div>`;
  return `<div class="receipt" data-tone="${attr(receipt.tone ?? 'neutral')}" title="${attr(receipt.at ?? '')}">${icon(receipt.tone === 'critical' ? 'alert' : 'check')}<span class="receipt-text">Receipt: ${esc(receipt.text)}</span><span class="live">${online ? 'LIVE' : 'OFFLINE'}</span></div>`;
}

export function renderHeader(rawSnapshot, { now, online, refresh, theme, filters = {}, view = 'picknext', endpoint = null, receipt = null }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const caps = snapshot.capabilities ?? {};
  const isStatic = !!snapshot.meta.exported_at;
  return `<div class="topbar">
  <div class="brand">${logoSvg()}<span>Session Quill</span><span class="pill">v${esc(snapshot.meta.tracker_version)}</span></div>
  <label class="search">${icon('search')}<input type="search" id="search" data-filter="q" placeholder="Search tickets, keys, tags…" value="${attr(filters.q ?? '')}" aria-label="Search tickets"><kbd aria-hidden="true">/</kbd></label>
  <span class="endpoint" title="${attr(isStatic ? 'Read-only exported snapshot' : 'Owner session on loopback')}"><span class="dot ${isStatic ? 'muted' : online ? 'good' : 'critical'}" aria-hidden="true"></span>${isStatic ? 'snapshot' : esc(endpoint ?? '127.0.0.1')} <strong>[${isStatic ? 'Viewer' : 'Owner'}]</strong></span>
  <div class="topbar-actions">
    ${snapshot.schedules.length && !isStatic ? `<button type="button" class="btn small" data-action="schedules">${icon('clock')}Schedules</button>` : ''}
    ${caps.export ? `<button type="button" class="btn small" data-action="export">${icon('download')}Export</button>` : ''}
    <button type="button" class="btn small icon-only" data-action="theme" aria-label="Switch to ${theme === 'dark' ? 'light' : 'dark'} theme" title="Theme">${icon(theme === 'dark' ? 'sun' : 'moon')}</button>
    <button type="button" class="btn small icon-only" data-action="help" aria-label="Keyboard shortcuts" title="Help (?)">${icon('help')}</button>
  </div>
</div>
<div class="healthbar" role="status" aria-label="Freshness and health">${renderHealth(snapshot, { now, online })}${renderRefreshControl(snapshot, { online, refresh })}</div>
${renderReceipt(receipt, { online })}`;
}

export function statusCounts(snapshot) {
  return STATUS_ORDER.map((s) => [s, snapshot.meta.counts_by_status ? snapshot.meta.counts_by_status[s] ?? 0 : 0]);
}
