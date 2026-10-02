// Deployments (ADR 0009): every ticket with outstanding work, as a PR by environment matrix with
// the evidence for each cell. A done ticket stays here until each obligation is confirmed or waived.
import { esc, attr, keyEl, statusChip, timeEl, ticketById, matchesFilters, emptyState, icon, countLabel, normalizeSnapshot } from '../components.js';

export const EVIDENCE_LABELS = { merge: 'Merge', tag: 'Tag bump', argocd: 'ArgoCD sync', release: 'Release', manual: 'Recorded', agent: 'Agent evidence' };
export const ENV_STATE_LABELS = { pending: 'Pending', done: 'Done', 'n-a': 'N/A', none: 'Not yet' };

export function journeyStrip(ticket, pr, obligation, { now, tz }) {
  const steps = [
    ['Opened', pr && pr.opened_at],
    ['Merged', obligation.merged_at],
    ['Deployed', obligation.deployed_at ?? null],
  ];
  return `<ol class="journey" aria-label="Ticket journey">${steps.map(([label, at]) => `<li data-done="${at ? 'true' : 'false'}"><span class="journey-label">${esc(label)}</span>${at ? timeEl(at, now, tz) : '<span class="muted">pending</span>'}</li>`).join('')}</ol>`;
}

function environmentsOf(ticket) {
  const names = (ticket.environments ?? []).map((e) => e.environment);
  for (const d of ticket.deployments ?? []) if (!names.includes(d.environment)) names.push(d.environment);
  return names;
}

function cell(d, ticket, { now, tz, canEdit }) {
  if (!d) return '<td class="env-cell" data-env-state="none"><span class="muted">—</span></td>';
  if (d.state === 'deployed') return `<td class="env-cell" data-env-state="done"><span class="chip good small">Done</span> ${d.deployed_at ? timeEl(d.deployed_at, now, tz) : ''}<div class="small">${esc(EVIDENCE_LABELS[d.evidence_kind ?? 'manual'] ?? d.evidence_kind)}${d.evidence ? `: ${esc(d.evidence)}` : ''}</div></td>`;
  if (d.state === 'waived') return `<td class="env-cell" data-env-state="n-a"><span class="chip small">N/A</span><div class="small muted">${esc(d.waiver_reason ?? '')}</div></td>`;
  const actions = canEdit ? `<div class="env-actions"><button type="button" class="btn small" data-action="record-deployment" data-ticket="${attr(ticket.id)}" data-deployment="${attr(d.id)}">${icon('rocket')}Record</button><button type="button" class="btn small ghost" data-action="waive-deployment" data-ticket="${attr(ticket.id)}" data-deployment="${attr(d.id)}">N/A…</button></div>` : '';
  return `<td class="env-cell" data-env-state="pending"><span class="chip warning small">Pending</span>${actions}</td>`;
}

export function renderDeployments(rawSnapshot, filters, { now, pending = [] }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const tz = snapshot.meta.timezone;
  const caps = snapshot.capabilities ?? {};
  const order = [];
  for (const o of snapshot.deployments_outstanding ?? []) if (!order.includes(o.ticket_id)) order.push(o.ticket_id);
  const tickets = order.map((id) => ticketById(snapshot, id)).filter((t) => t && matchesFilters(t, filters, snapshot));
  if (!tickets.length) return `<section class="view view-deployments" aria-labelledby="tab-deployments">${emptyState('Nothing awaiting deployment', 'Obligations appear when a PR with merge evidence lands, one for each configured environment. Draft or closed-unmerged PRs create none.')}</section>`;
  const cards = tickets.map((ticket) => {
    const envs = environmentsOf(ticket);
    const prIds = [...new Set((ticket.deployments ?? []).map((d) => d.pr_id))];
    const pend = pending.find((r) => r.target_id === ticket.id && ['pending', 'applying'].includes(r.state) && (r.kind === 'record-deployment' || r.kind === 'set-status'));
    const rows = prIds.map((prId) => {
      const pr = ticket.prs.find((p) => p.id === prId);
      const items = (ticket.deployments ?? []).filter((d) => d.pr_id === prId);
      const merged = items.find((d) => d.merged_at);
      return `<tr><th scope="row">${pr ? `<a href="${attr(pr.url)}" rel="noopener noreferrer" target="_blank">${esc(pr.url.replace(/^https:\/\//, ''))}</a>` : `<span class="muted">PR ${esc(String(prId).slice(0, 8))}</span>`}${merged ? `<div class="small muted">merged ${timeEl(merged.merged_at, now, tz, { absolute: true })}</div>` : ''}${pr && pr.state === 'unknown' ? '<div class="small muted">provider evidence unavailable</div>' : ''}</th>${envs.map((e) => cell(items.find((d) => d.environment === e), ticket, { now, tz, canEdit: !!caps.edit_tickets })).join('')}</tr>`;
    }).join('');
    return `<article class="deployment" data-ticket="${attr(ticket.id)}">
  <header><button type="button" class="link" data-open="${attr(ticket.id)}">${keyEl(ticket.key)} ${esc(ticket.title)}</button> ${statusChip(ticket.status)}${ticket.status === 'done' ? ' <span class="chip warning">Done with outstanding deployment</span>' : ''}${pend ? ' <span class="chip request" data-state="pending">Pending edit</span>' : ''}</header>
  <div class="table-wrap"><table class="env-matrix"><thead><tr><th scope="col">Pull request</th>${envs.map((e) => `<th scope="col">${esc(e)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
</article>`;
  }).join('');
  const outstanding = (snapshot.deployments_outstanding ?? []).filter((o) => tickets.some((t) => t.id === o.ticket_id)).length;
  return `<section class="view view-deployments" aria-labelledby="tab-deployments"><p class="section-count">${esc(countLabel(outstanding, 'outstanding obligation'))} across ${esc(countLabel(tickets.length, 'ticket'))}, oldest first</p><div class="deployments">${cards}</div></section>`;
}

// One line per environment for ticket detail: state and the latest evidence.
export function environmentLine(ticket, { now, tz }) {
  const envs = ticket.environments ?? [];
  if (!envs.length) return '';
  return `<ul class="env-status" aria-label="Deployment status by environment">${envs.map((e) => `<li data-env-state="${attr(e.state)}"><strong>${esc(e.environment)}</strong> <span class="chip small">${esc(ENV_STATE_LABELS[e.state] ?? e.state)}</span>${e.state === 'done' ? ` ${e.deployed_at ? timeEl(e.deployed_at, now, tz) : ''} <span class="small">${esc(EVIDENCE_LABELS[e.evidence_kind ?? 'manual'] ?? e.evidence_kind)}${e.evidence ? `: ${esc(e.evidence)}` : ''}</span>` : ''}${e.state === 'n-a' && e.waiver_reason ? ` <span class="small muted">${esc(e.waiver_reason)}</span>` : ''}</li>`).join('')}</ul>`;
}
