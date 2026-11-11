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
<td class="hub-wide"><a class="hub-key" href="${ticketHref(t)}">${esc(t.key) || 'Open'}</a><span class="hub-sub">${esc(t.title)}</span></td>
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

function topBar(who) {
  const scope = who.boards ? `${who.role}, ${who.boards.length} board${who.boards.length === 1 ? '' : 's'}` : who.role;
  return `<a class="hub-skip" href="#main">Skip to content</a>
<header class="hub-top">
<div class="hub-brand"><a href="/">Session Quill <span>· Team hub</span></a></div>
<div class="hub-who"><span>Signed in as <strong>${esc(who.name)}</strong> (${esc(scope)})</span><form method="post" action="/logout"><button class="q-button" type="submit">Sign out</button></form></div>
</header>`;
}

export const EDIT_STATUSES = Object.freeze(['todo', 'active', 'review', 'deploy-pending', 'done']);
export const ticketHref = (t) => `/b/${encodeURIComponent(t.member)}/${encodeURIComponent(t.store_id)}/t/${encodeURIComponent(t.id)}`;

// What is known about a proposed edit, from the hub's own records and the latest push only.
export function editState(edit, ticket, member, nowMs) {
  if (!edit.delivered_at) return `Waiting for ${member}'s machine to collect it`;
  const collected = `Collected ${ago(nowMs - Date.parse(edit.delivered_at))}`;
  const shown = ticket && (edit.field === 'status' ? ticket.status : (ticket.next_action ?? '')) === edit.value;
  if (shown) return `${collected}; the board now shows this value`;
  if (ticket && Number.isInteger(ticket.revision) && ticket.revision > edit.expected_revision) return `${collected}; the ticket has changed since and does not show this value`;
  return `${collected}; not visible in a push yet`;
}

function editLine(edit, ticket, member, nowMs) {
  const what = edit.field === 'status' ? `status to ${STATUS_LABEL[edit.value] ?? edit.value}` : 'the next action';
  return `<li><strong>${esc(edit.by)}</strong> proposed ${esc(what)} ${timeEl(edit.at, nowMs)}${edit.field === 'next_action' ? `<span class="hub-sub">${esc(edit.value) || '(empty)'}</span>` : ''}<span class="hub-sub">${esc(editState(edit, ticket, member, nowMs))}</span></li>`;
}

export function ticketPage({ hubName, who, member, storeId, info, ticket, edits, now, canEdit, whyNot = null, sent = 0, error = null, draft = null }) {
  const nowMs = Date.parse(now);
  const board = { member, store_id: storeId };
  const action = ticketHref({ ...board, id: ticket.id });
  const nextAction = draft && draft.field === 'next_action' ? draft.value : (ticket.next_action ?? '');
  const errFor = (field) => (error && (!draft || draft.field === field) ? error : null);
  const statusError = errFor('status');
  const nextError = errFor('next_action');
  // One change per request: each is checked against the ticket's revision on the owner's machine,
  // so two sent together would have the second refused as out of date.
  const form = canEdit ? `<p class="hub-note" id="edit-help">A change goes to ${esc(member)}'s machine as a request from <strong>${esc(who.name)}</strong>. Their worker applies it after a 10-second undo window, or refuses it if the ticket changed after this copy was pushed. Send one change at a time; this page changes only when their machine pushes again.</p>
<form class="hub-form" method="post" action="${action}">
<input type="hidden" name="field" value="status">
<label class="q-field" for="status">Status
<select class="q-input" id="status" name="value" required${statusError ? ' aria-invalid="true" aria-describedby="status-error edit-help"' : ' aria-describedby="edit-help"'}>
<option value="">Now: ${esc(STATUS_LABEL[ticket.status] ?? ticket.status)}. Choose a new status</option>
${EDIT_STATUSES.filter((s) => s !== ticket.status).map((s) => `<option value="${s}">${esc(STATUS_LABEL[s])}</option>`).join('\n')}
</select>
</label>
${statusError ? `<p class="q-error" id="status-error" role="alert">${esc(statusError)}</p>` : ''}
<div><button class="q-button q-button--primary" type="submit">Send status to ${esc(member)}'s machine</button></div>
</form>
<form class="hub-form" method="post" action="${action}">
<input type="hidden" name="field" value="next_action">
<label class="q-field" for="next_action">Next action
<textarea class="q-input" id="next_action" name="value" rows="3" maxlength="2000"${nextError ? ' aria-invalid="true" aria-describedby="next-error edit-help"' : ' aria-describedby="edit-help"'}>${esc(nextAction)}</textarea>
</label>
${nextError ? `<p class="q-error" id="next-error" role="alert">${esc(nextError)}</p>` : ''}
<div><button class="q-button" type="submit">Send next action to ${esc(member)}'s machine</button></div>
</form>` : `${error ? `<p class="q-error" role="alert">${esc(error)}</p>` : ''}<p class="hub-note">${esc(whyNot ?? 'This board is read-only here.')}</p>`;
  const body = `${topBar(who)}
<main id="main" class="hub-main">
<p class="hub-crumb"><a href="/">${esc(hubName)}</a> / <a href="${boardHref(board)}">${esc(member)}</a></p>
<h1><span class="hub-key">${esc(ticket.key ?? '')}</span> ${esc(ticket.title ?? '')}</h1>
${sent ? `<p class="hub-sent" role="status">Your change is queued for ${esc(member)}'s machine. Queued is not applied: the list below says what happened to it.</p>` : ''}
<dl class="hub-facts">
<div><dt>Status</dt><dd>${chip(STATUSES.includes(ticket.status) ? ticket.status : 'todo')}${ticket.stale === true ? ' <span class="q-chip">Stale</span>' : ''}</dd></div>
<div><dt>Priority</dt><dd>${esc(ticket.priority ?? 'not set')}</dd></div>
<div><dt>Next action</dt><dd>${esc(ticket.next_action) || '<span class="hub-sub">none recorded</span>'}</dd></div>
${ticket.blocker ? `<div><dt>Blocker</dt><dd>${esc(ticket.blocker)}</dd></div>` : ''}
<div><dt>Last activity</dt><dd>${timeEl(typeof ticket.last_activity === 'string' ? ticket.last_activity : null, nowMs)}</dd></div>
<div><dt>This copy</dt><dd>Pushed ${timeEl(info.pushed_at, nowMs)} from ${esc(member)}'s machine</dd></div>
</dl>
<section aria-labelledby="edit-h">
<h2 id="edit-h">Propose a change</h2>
${form}
</section>
<section aria-labelledby="edits-h">
<h2 id="edits-h">Changes proposed on this hub (${edits.length})</h2>
${edits.length ? `<ul class="hub-edits">${edits.map((e) => editLine(e, ticket, member, nowMs)).join('\n')}</ul>` : '<p class="hub-note">None in the last week.</p>'}
</section>
</main>`;
  return shell({ title: `${ticket.key ?? 'Ticket'} · ${hubName}`, body, bodyClass: 'hub' });
}

// One board: the hub's bar, then the read-only dashboard in a frame of its own, so the dashboard's
// full-height layout is untouched.
export function boardFramePage({ hubName, who, member, storeId, pushedAt, now }) {
  const nowMs = Date.parse(now);
  const src = `/b/${encodeURIComponent(member)}/${encodeURIComponent(storeId)}/frame`;
  const body = `${topBar(who)}
<main id="main" class="hub-board">
<p class="hub-crumb"><a href="/">${esc(hubName)}</a> / ${esc(member)} <span class="hub-crumb-note">Read-only copy, pushed ${timeEl(pushedAt, nowMs)}</span></p>
<iframe class="hub-frame" src="${src}" title="${esc(member)}'s board, read-only"></iframe>
</main>`;
  return shell({ title: `${member} · ${hubName}`, body, bodyClass: 'hub hub-board-page' });
}

export function overviewPage({ hubName, who, overview }) {
  const nowMs = Date.parse(overview.generated_at);
  const totals = overview.boards.length
    ? `<ul class="hub-totals" aria-label="Tickets by status, all boards">${STATUSES.map((s) => `<li>${chip(s)} ${overview.totals[s]}</li>`).join('')}</ul>`
    : '';
  const body = `${topBar(who)}
<main id="main" class="hub-main">
<h1>${esc(hubName)}</h1>
<p class="hub-lead">Copies that each member's own machine pushed. Nothing here changes a ticket directly; on boards that accept it, a member can propose a change from a ticket's page. Page built <time datetime="${esc(overview.generated_at)}">${esc(overview.generated_at)}</time>; reload for newer pushes.</p>
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
