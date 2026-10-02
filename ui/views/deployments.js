import { esc, attr, keyEl, statusChip, timeEl, ticketById, matchesFilters, emptyState, icon, countLabel } from '../components.js';

export function journeyStrip(ticket, pr, obligation, { now, tz }) {
  const steps = [
    ['Opened', pr && pr.opened_at],
    ['Merged', obligation.merged_at],
    ['Deployed', obligation.deployed_at ?? null],
  ];
  return `<ol class="journey" aria-label="Ticket journey">${steps.map(([label, at]) => `<li data-done="${at ? 'true' : 'false'}"><span class="journey-label">${esc(label)}</span>${at ? timeEl(at, now, tz) : '<span class="muted">pending</span>'}</li>`).join('')}</ol>`;
}

export function renderDeployments(snapshot, filters, { now, pending = [] }) {
  const tz = snapshot.meta.timezone;
  const items = (snapshot.deployments_outstanding ?? []).map((o) => ({ o, ticket: ticketById(snapshot, o.ticket_id) })).filter((x) => x.ticket && matchesFilters(x.ticket, filters, snapshot));
  if (!items.length) return `<section class="view view-deployments" aria-labelledby="tab-deployments">${emptyState('Nothing awaiting deployment', 'Obligations appear when a PR with merge evidence lands for a configured environment. Draft or closed-unmerged PRs create none.')}</section>`;
  const caps = snapshot.capabilities ?? {};
  const rows = items.map(({ o, ticket }) => {
    const pr = ticket.prs.find((p) => p.id === o.pr_id);
    const obligation = ticket.deployments.find((d) => d.id === o.deployment_id) ?? { merged_at: o.merged_at };
    const unknown = pr && pr.state === 'unknown';
    const pend = pending.find((r) => r.target_id === ticket.id && ['pending', 'applying'].includes(r.state) && (r.kind === 'record-deployment' || r.kind === 'set-status'));
    return `<article class="deployment" data-ticket="${attr(ticket.id)}">
  <header><button type="button" class="link" data-open="${attr(ticket.id)}">${keyEl(ticket.key)} ${esc(ticket.title)}</button> ${statusChip(ticket.status)}${ticket.status === 'done' ? ' <span class="chip warning">Done with outstanding deployment</span>' : ''}${pend ? ' <span class="chip request" data-state="pending">Pending edit</span>' : ''}</header>
  <div class="deployment-body">
    <div><span class="label">Environment</span> <strong>${esc(o.environment)}</strong></div>
    <div><span class="label">PR</span> ${pr ? `<a href="${attr(pr.url)}" rel="noopener noreferrer" target="_blank">${esc(pr.url)}</a> <span class="muted small">${esc(pr.state)}${unknown ? ' — provider evidence unavailable' : ''}</span>` : '<span class="muted">unknown</span>'}</div>
    <div><span class="label">Merged</span> ${timeEl(o.merged_at, now, tz, { absolute: true })}</div>
    ${journeyStrip(ticket, pr, obligation, { now, tz })}
  </div>
  ${caps.edit_tickets ? `<footer class="deployment-actions"><button type="button" class="btn small" data-action="record-deployment" data-ticket="${attr(ticket.id)}" data-deployment="${attr(o.deployment_id)}">${icon('rocket')}Record deployment</button><button type="button" class="btn small ghost" data-action="waive-deployment" data-ticket="${attr(ticket.id)}" data-deployment="${attr(o.deployment_id)}">Waive…</button></footer>` : ''}
</article>`;
  }).join('');
  return `<section class="view view-deployments" aria-labelledby="tab-deployments"><p class="section-count">${esc(countLabel(items.length, 'outstanding obligation'))}, oldest first</p><div class="deployments">${rows}</div></section>`;
}
