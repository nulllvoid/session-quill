// Markdown projections with preserved authored sections and hash-guarded generated blocks
// (TRD §Durability: user-authored text is byte-for-byte preserved; edited generated blocks become
// conflicts and the original file is kept).
import fs from 'node:fs';
import { contentHash } from '../lib/ids.js';
import { writeFileAtomic } from '../lib/atomic-fs.js';
import { stringifyYaml, parseYaml, safeInline } from './markdown.js';

export const GENERATED_SECTIONS = ['timeline', 'plans', 'conclusions', 'files', 'prs', 'followups', 'handoffs'];
const HEADINGS = {
  timeline: 'Timeline', plans: 'Approved plans', conclusions: 'Conclusions', files: 'Files touched', prs: 'PRs and deployments', followups: 'Follow-ups', handoffs: 'Handoff notes',
};
// Markers are matched with optional carriage returns so a CRLF-converted note is still recognized
// (its block hashes will then mismatch and the file is treated as a conflict, never overwritten).
const MARKER_RE = /<!-- tracker:generated:([a-z-]+) start hash=([0-9a-f]{64}) -->\r?\n([\s\S]*?)<!-- tracker:generated:\1 end -->\r?\n/g;

function block(section, body) {
  const text = body.endsWith('\n') ? body : `${body}\n`;
  return `<!-- tracker:generated:${section} start hash=${contentHash(text)} -->\n${text}<!-- tracker:generated:${section} end -->\n`;
}

function frontmatterFor(ticket) {
  const fm = { ...ticket };
  fm.plans = ticket.plans.map(({ id, session_id, checkpoint_id, content_ref, approved_at, provenance }) => ({ id, session_id, checkpoint_id, content_ref, approved_at, provenance }));
  fm.conclusions = ticket.conclusions.map(({ id, session_id, checkpoint_id, content_ref, recorded_at, approved_at, provenance }) => ({ id, session_id, checkpoint_id, content_ref, recorded_at, approved_at, provenance }));
  return fm;
}

function sectionBodies(ticket, state) {
  const b = {};
  b.timeline = ticket.timeline.length
    ? ticket.timeline.map((e) => `- ${e.at} · ${e.kind} · ${safeInline(e.text)}${e.coverage !== 'complete' ? ` _(coverage: ${e.coverage})_` : ''}${e.content_ref ? ` [full](tracker://content/${e.content_ref})` : ''}`).join('\n')
    : '_No events yet._';
  b.plans = ticket.plans.length
    ? ticket.plans.map((p) => `### Plan ${p.id.slice(0, 8)} — approved ${p.approved_at} (${p.provenance})\n\n${safeInline(p.preview).replace(/\\n/g, '\n')}\n\n[Full plan](tracker://content/${p.content_ref})`).join('\n\n')
    : '_No approved plans._';
  b.conclusions = ticket.conclusions.length
    ? ticket.conclusions.map((c) => `- ${c.recorded_at}: ${safeInline(c.preview)} [full](tracker://content/${c.content_ref})`).join('\n')
    : '_No conclusions recorded._';
  b.files = ticket.files_touched.length
    ? ticket.files_touched.map((f) => `- \`${safeInline(f.relative_path)}\`${f.repo_id ? ` (${safeInline(f.repo_id)})` : ''} — first ${f.first_seen}, last ${f.last_seen}`).join('\n')
    : '_No verified file changes._';
  const prLines = ticket.prs.map((pr) => `- PR ${safeInline(pr.url)} — ${pr.state}${pr.merged_at ? `, merged ${pr.merged_at}` : ''}${pr.error ? ` _(provider error: ${safeInline(pr.error)})_` : ''}`);
  const depLines = ticket.deployments.map((d) => `- Deployment ${safeInline(d.environment)} for PR ${d.pr_id.slice(0, 8)} — ${d.state}${d.deployed_at ? ` at ${d.deployed_at}` : ''}${d.waiver_reason ? ` (waived: ${safeInline(d.waiver_reason)})` : ''}`);
  b.prs = [...prLines, ...depLines].join('\n') || '_No PR or deployment evidence._';
  const children = ticket.children_ids.map((id) => state.tickets.get(id)).filter(Boolean);
  b.followups = [
    ticket.next_action ? `**Next action:** ${safeInline(ticket.next_action)}` : '_No next action._',
    ticket.blocker ? `**Blocker:** ${safeInline(ticket.blocker)}` : '',
    ...children.map((c) => `- [[${safeInline(c.key)}]] ${safeInline(c.title)} — ${c.status}`),
  ].filter(Boolean).join('\n');
  const handoffs = ticket.handoff_ids.map((id) => state.handoffs.get(id)).filter(Boolean);
  b.handoffs = handoffs.length
    ? handoffs.map((h) => `- ${h.requested_at} · ${h.mode} · ${h.state}${h.result_summary ? ` — ${safeInline(h.result_summary).slice(0, 300)}` : ''}${h.error && h.error.code ? ` _(error: ${safeInline(h.error.code)})_` : ''}`).join('\n')
    : '_No handoffs._';
  return b;
}

export function renderTicketNote(ticket, { state, authored = {} } = {}) {
  const summary = authored.summary ?? '\n';
  const notes = authored.notes ?? '\n';
  const bodies = sectionBodies(ticket, state);
  const blocks = GENERATED_SECTIONS.map((s) => block(s, `## ${HEADINGS[s]}\n${bodies[s]}\n`)).join('');
  return `---\n${stringifyYaml(frontmatterFor(ticket))}---\n## Summary\n${summary}${blocks}## Notes\n${notes}`;
}

export function renderSessionNote(session, { state }) {
  const tickets = session.ticket_ids.map((id) => state.tickets.get(id)).filter(Boolean);
  const fm = { ...session };
  const body = [
    `## Session ${session.host_session_id}${session.agent_id ? ` / agent ${session.agent_id}` : ''}`,
    `- State: ${session.state}${session.ended_at ? ` (ended ${session.ended_at})` : ''}`,
    `- Machine: ${safeInline(session.machine_name)}`,
    `- Started: ${session.started_at}; last event: ${session.last_event_at}`,
    `- Successful writes: ${session.successful_write_count}; coverage: ${session.change_coverage}`,
    `- Gate: ${session.gate_enabled ? 'on' : 'OFF'}; unpromoted checkpoints: ${session.unpromoted ? 'yes' : 'no'}`,
    '',
    '### Bindings',
    ...(session.bindings.length ? session.bindings.map((b) => `- rev ${b.revision}: ${b.ticket_id ? safeInline(state.tickets.get(b.ticket_id)?.key ?? b.ticket_id) : 'unbound'} from ${b.bound_at}${b.unbound_at ? ` to ${b.unbound_at}` : ''}`) : ['- none']),
    '',
    '### Tickets',
    ...(tickets.length ? tickets.map((t) => `- [[${safeInline(t.key)}]] ${safeInline(t.title)} — ${t.status}`) : ['- none']),
    '',
    '### Last checkpoint',
    session.last_checkpoint_preview ? safeInline(session.last_checkpoint_preview) : '_none_',
    '',
  ].join('\n');
  return `---\n${stringifyYaml(fm)}---\n${block('session', body)}## Notes\n\n`;
}

export function renderHandoffNote(handoff, { state }) {
  const ticket = state.tickets.get(handoff.ticket_id);
  const body = [
    `## Handoff ${handoff.id.slice(0, 8)} — ${handoff.mode} — ${handoff.state}`,
    `- Ticket: ${ticket ? `[[${safeInline(ticket.key)}]] ${safeInline(ticket.title)}` : handoff.ticket_id}`,
    `- Requested: ${handoff.requested_at}; started: ${handoff.started_at ?? '—'}; finished: ${handoff.finished_at ?? '—'}`,
    `- Permissions: ${Object.entries(handoff.permissions ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`,
    handoff.note ? `- Note: ${safeInline(handoff.note)}` : '',
    handoff.error ? `- Error: ${safeInline(handoff.error.code)} ${safeInline(handoff.error.message ?? '')}` : '',
    handoff.result_summary ? `\n### Result\n${safeInline(handoff.result_summary).replace(/\\n/g, '\n')}` : '',
    handoff.changed_files && handoff.changed_files.length ? `\n### Changed files\n${handoff.changed_files.map((f) => `- \`${safeInline(f)}\``).join('\n')}` : '',
    handoff.test_results && handoff.test_results.length ? `\n### Tests\n${handoff.test_results.map((t) => `- ${safeInline(typeof t === 'string' ? t : JSON.stringify(t))}`).join('\n')}` : '',
    handoff.children_ids && handoff.children_ids.length ? `\n### Children\n${handoff.children_ids.map((id) => `- [[${safeInline(state.tickets.get(id)?.key ?? id)}]]`).join('\n')}` : '',
    handoff.uncertain_effects && handoff.uncertain_effects.length ? `\n### Uncertain effects\n${handoff.uncertain_effects.map((u) => `- ${safeInline(u)}`).join('\n')}` : '',
    '',
  ].filter((l) => l !== '').join('\n');
  const fm = { ...handoff };
  delete fm.worktree_path;
  return `---\n${stringifyYaml(fm)}---\n${block('handoff', body)}## Notes\n\n`;
}

export function parseNote(text) {
  const result = { frontmatter: null, frontmatterText: null, authored: { summary: '\n', notes: '\n' }, generated: {}, hasMarkers: false };
  let rest = text;
  const fmOpen = /^---\r?\n/.exec(text);
  if (fmOpen) {
    const close = /\r?\n---\r?\n/g;
    close.lastIndex = fmOpen[0].length;
    const end = close.exec(text);
    if (end) {
      result.frontmatterText = text.slice(fmOpen[0].length, end.index + 1);
      try { result.frontmatter = parseYaml(result.frontmatterText); } catch { result.frontmatter = null; }
      rest = text.slice(end.index + end[0].length);
    }
  }
  const markers = [...rest.matchAll(MARKER_RE)];
  result.hasMarkers = markers.length > 0;
  for (const m of markers) {
    const [, section, hash, body] = m;
    result.generated[section] = { hash, body, intact: contentHash(body) === hash, start: m.index, end: m.index + m[0].length };
  }
  const summaryHeading = /## Summary\r?\n/.exec(rest);
  if (summaryHeading) {
    const firstMarker = markers.length ? markers[0].index : rest.length;
    result.authored.summary = rest.slice(summaryHeading.index + summaryHeading[0].length, firstMarker);
  }
  const lastEnd = markers.length ? markers[markers.length - 1].index + markers[markers.length - 1][0].length : 0;
  const notesRe = /## Notes\r?\n/g;
  notesRe.lastIndex = lastEnd;
  const notesHeading = notesRe.exec(rest);
  if (notesHeading) result.authored.notes = rest.slice(notesHeading.index + notesHeading[0].length);
  return result;
}

function addIssue(ticket, issue) {
  if (!ticket.validation_issues.includes(issue)) ticket.validation_issues.push(issue);
}

function clearIssues(ticket, prefix) {
  ticket.validation_issues = ticket.validation_issues.filter((i) => !i.startsWith(prefix));
}

// Returns 'written' | 'unchanged' | 'conflict'. `index` persists the hash of the frontmatter we last
// wrote per ticket so manual frontmatter edits are detected as conflicts, never absorbed.
export function writeNote(file, ticket, { state, index = {}, force = false }) {
  let existing = null;
  try { existing = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  let authored = {};
  if (existing !== null) {
    const parsed = parseNote(existing);
    authored = parsed.authored;
    if (!force) {
      // A file we cannot recognize as one of ours is never overwritten: it may be entirely authored.
      if (!parsed.hasMarkers || parsed.frontmatter === null) {
        addIssue(ticket, 'note-layout-unrecognized');
        return 'conflict';
      }
      const edited = Object.entries(parsed.generated).filter(([, b]) => !b.intact).map(([s]) => s);
      const prior = index[ticket.id];
      const fmEdited = prior && parsed.frontmatterText !== null && contentHash(parsed.frontmatterText) !== prior.frontmatter_hash;
      if (edited.length || fmEdited) {
        for (const s of edited) addIssue(ticket, `generated-block-edited:${s}`);
        if (fmEdited) addIssue(ticket, 'generated-frontmatter-edited');
        return 'conflict';
      }
    }
  }
  clearIssues(ticket, 'generated-block-edited:');
  clearIssues(ticket, 'generated-frontmatter-edited');
  clearIssues(ticket, 'note-layout-unrecognized');
  const text = renderTicketNote(ticket, { state, authored });
  const fmText = text.slice(4, text.indexOf('\n---\n', 4) + 1);
  index[ticket.id] = { path: file, frontmatter_hash: contentHash(fmText), revision: ticket.revision };
  if (existing === text) return 'unchanged';
  writeFileAtomic(file, text);
  return 'written';
}

export function writeGeneratedNote(file, text) {
  let existing = null;
  try { existing = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  let notes = '\n';
  if (existing !== null) notes = parseNote(existing).authored.notes;
  const full = text.replace(/## Notes\n[\s\S]*$/, `## Notes\n${notes}`);
  if (existing === full) return 'unchanged';
  writeFileAtomic(file, full);
  return 'written';
}
