// Server-rendered team hub pages (ADR 0044): the overview and the sign-in form. No script; every
// value that came from a board or a token is escaped here.
import { STATUSES, MAX_OPEN_ROWS } from './team.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const STATUS_LABEL = { todo: 'To do', active: 'Active', blocked: 'Blocked', review: 'In review', 'deploy-pending': 'Deploy pending', done: 'Done' };
const STATUS_TONE = { active: 'active', blocked: 'critical', review: 'review', 'deploy-pending': 'warning', done: 'good' };

export function ago(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  const days = Math.floor(ms / 86_400_000);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function chip(status) {
  const tone = STATUS_TONE[status];
  return `<span class="q-chip"${tone ? ` data-tone="${tone}"` : ''}>${esc(STATUS_LABEL[status] ?? status)}</span>`;
}

function timeEl(iso, nowMs) {
  if (!iso) return '<span class="hub-sub">not recorded</span>';
  return `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(ago(nowMs - Date.parse(iso)))}</time>`;
}

function shell({ title, body, bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="/assets/mark.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/hub.css">
</head>
<body class="${bodyClass}">
${body}
</body>
</html>
`;
}

const boardHref = (r) => `/b/${encodeURIComponent(r.member)}/${encodeURIComponent(r.store_id)}/`;

function boardsTable(overview) {
  if (!overview.boards.length) {
    return `<section class="q-panel q-empty" aria-labelledby="boards-h">
<h2 id="boards-h">No boards pushed yet</h2>
<p>Each member runs <code>quill hub join</code> with this hub's address and their token. Their worker then pushes a read-only copy of their board.</p>
</section>`;
  }
  const rows = overview.boards.map((r) => `<tr>
<td><a href="${boardHref(r)}">${esc(r.member)}</a>${r.machine_name ? `<span class="hub-sub">${esc(r.machine_name)}</span>` : ''}</td>
<td>${esc(r.store_name ?? 'Quill')}<span class="hub-sub hub-key">${esc(r.store_id.slice(0, 8))}</span></td>
<td><time datetime="${esc(r.pushed_at)}" title="${esc(r.pushed_at)}">Pushed ${esc(ago(r.age_ms))}</time>${r.quiet ? ' <span class="q-chip" data-tone="warning">No push for over a day</span>' : ''}</td>
${STATUSES.map((s) => `<td class="hub-num">${r.counts_by_status[s]}</td>`).join('')}
<td class="hub-num">${r.stale_ticket_count}</td>
</tr>`).join('\n');
  return `<section aria-labelledby="boards-h">
<h2 id="boards-h">Boards (${overview.boards.length})</h2>
<p class="hub-note">One row per store a member pushes. Open a board for its full read-only dashboard.</p>
<div class="hub-scroll" role="region" aria-labelledby="boards-h" tabindex="0">
<table class="hub-table">
<thead><tr><th scope="col">Member</th><th scope="col">Store</th><th scope="col">Last push</th>${STATUSES.map((s) => `<th scope="col" class="hub-num">${esc(STATUS_LABEL[s])}</th>`).join('')}<th scope="col" class="hub-num">Stale</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</section>`;
}

function deploymentsTable(overview, nowMs) {
  if (!overview.boards.length) return '';
  if (!overview.deployments.length) {
    return `<section aria-labelledby="deploy-h">
<h2 id="deploy-h">Deployments owed (0)</h2>
<p class="hub-note">No merged pull request on these boards has a deployment still recorded as pending.</p>
</section>`;
  }
  const rows = overview.deployments.map((d) => `<tr>
<td class="hub-wide"><span class="hub-key">${esc(d.ticket_key)}</span>${d.title ? `<span class="hub-sub">${esc(d.title)}</span>` : ''}</td>
<td>${esc(d.environment)}</td>
<td>${d.merged_at ? `Merged ${timeEl(d.merged_at, nowMs)}` : '<span class="hub-sub">merge time not recorded</span>'}</td>
<td><a href="${boardHref(d)}">${esc(d.member)}</a></td>
</tr>`).join('\n');
  return `<section aria-labelledby="deploy-h">
<h2 id="deploy-h">Deployments owed (${overview.deployments.length})</h2>
<p class="hub-note">A merged pull request is not a deployment. Each row is one environment a merged pull request has no recorded deployment for yet, oldest merge first.</p>
<div class="hub-scroll" role="region" aria-labelledby="deploy-h" tabindex="0">
<table class="hub-table">
<thead><tr><th scope="col">Ticket</th><th scope="col">Environment</th><th scope="col">Merged</th><th scope="col">Board</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</section>`;
}

function openTable(overview, nowMs) {
  if (!overview.boards.length) return '';
  if (!overview.open.length) {
    return `<section aria-labelledby="open-h">
<h2 id="open-h">Open work (0)</h2>
<p class="hub-note">No ticket on these boards is open.</p>
</section>`;
  }
  const rows = overview.open.map((t) => `<tr>
<td class="hub-wide"><span class="hub-key">${esc(t.key)}</span><span class="hub-sub">${esc(t.title)}</span></td>
<td>${chip(t.status)}${t.stale ? ' <span class="q-chip">Stale</span>' : ''}</td>
<td>${esc(t.priority ?? '')}</td>
<td class="hub-wide">${t.blocker ? `<strong>Blocked:</strong> ${esc(t.blocker)}` : esc(t.next_action) || '<span class="hub-sub">no next action recorded</span>'}</td>
<td>${timeEl(t.last_activity, nowMs)}</td>
<td><a href="${boardHref(t)}">${esc(t.member)}</a></td>
</tr>`).join('\n');
  const more = overview.open_count > overview.open.length ? `<p class="hub-note">Showing the ${MAX_OPEN_ROWS} most recently active of ${overview.open_count} open tickets. Each board lists all of its own.</p>` : '';
  return `<section aria-labelledby="open-h">
<h2 id="open-h">Open work (${overview.open_count})</h2>
<p class="hub-note">Every ticket that is not done, across all boards, most recent activity first.</p>
<div class="hub-scroll" role="region" aria-labelledby="open-h" tabindex="0">
<table class="hub-table">
<thead><tr><th scope="col">Ticket</th><th scope="col">Status</th><th scope="col">Priority</th><th scope="col">Next action</th><th scope="col">Last activity</th><th scope="col">Board</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
${more}
</section>`;
}

export function overviewPage({ hubName, who, overview }) {
  const nowMs = Date.parse(overview.generated_at);
  const totals = overview.boards.length
    ? `<ul class="hub-totals" aria-label="Tickets by status, all boards">${STATUSES.map((s) => `<li>${chip(s)} ${overview.totals[s]}</li>`).join('')}</ul>`
    : '';
  const body = `<a class="hub-skip" href="#main">Skip to content</a>
<header class="hub-top">
<div class="hub-brand">Session Quill <span>· Team hub</span></div>
<div class="hub-who"><span>Signed in as <strong>${esc(who.name)}</strong> (${esc(who.role)})</span><form method="post" action="/logout"><button class="q-button" type="submit">Sign out</button></form></div>
</header>
<main id="main" class="hub-main">
<h1>${esc(hubName)}</h1>
<p class="hub-lead">Read-only copies that each member's own machine pushed. Nothing on this page changes a ticket. Page built <time datetime="${esc(overview.generated_at)}">${esc(overview.generated_at)}</time>; reload for newer pushes.</p>
${totals}
${boardsTable(overview)}
${deploymentsTable(overview, nowMs)}
${openTable(overview, nowMs)}
</main>`;
  return shell({ title: `${hubName} · Session Quill team hub`, body, bodyClass: 'hub' });
}

export function signInPage({ hubName, error = null }) {
  const body = `<main class="hub-signin">
<h1>Sign in</h1>
<p class="hub-lead">${esc(hubName)} is a Session Quill team hub. It shows read-only boards to people with an access token.</p>
<form method="post" action="/login">
<label class="q-field" for="token">Access token
<input class="q-input" id="token" name="token" type="password" autocomplete="off" spellcheck="false" required${error ? ' aria-invalid="true" aria-describedby="token-error token-help"' : ' aria-describedby="token-help"'}>
</label>
${error ? `<p class="q-error" id="token-error" role="alert">${esc(error)}</p>` : ''}
<p class="q-caption" id="token-help">Ask whoever runs this hub for a token. On the hub's host, <code>quill hub token add &lt;name&gt; --role viewer</code> creates one.</p>
<button class="q-button q-button--primary" type="submit">Sign in</button>
</form>
</main>`;
  return shell({ title: `Sign in · ${hubName}`, body, bodyClass: 'hub' });
}

export function messagePage({ hubName, title, message }) {
  const body = `<main class="hub-signin">
<h1>${esc(title)}</h1>
<p class="hub-lead">${esc(message)}</p>
<p><a href="/">Back to ${esc(hubName)}</a></p>
</main>`;
  return shell({ title: `${title} · ${hubName}`, body, bodyClass: 'hub' });
}
