// Proposed runs (ADR 0025): which ones a poll brought that the owner has not been told about yet.
// The first poll only learns what is there, so opening the dashboard announces nothing old.
export function freshProposals(seen, snapshot) {
  const open = (snapshot.run_proposals ?? []).filter((p) => p.state === 'proposed');
  const next = new Set(open.map((p) => p.id));
  if (seen === null) return { seen: next, fresh: [] };
  return { seen: next, fresh: open.filter((p) => !seen.has(p.id)) };
}

// The live-region and receipt text for a new proposal. Plain text: callers escape when rendering.
export function proposalNotice(p) {
  return `Run of ${p.recipe.name} proposed on ${p.ticket_key ?? 'a ticket'} from the ${p.publisher} page${p.editor ? ` by ${p.editor}` : ''}; approve or dismiss it in Today`;
}
