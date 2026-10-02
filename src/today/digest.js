// The daily digest (ADR 0009): one day of the Today feed as markdown, written into a marked
// section of a daily note (or a file). Text outside the section is never touched, and a section
// edited since Quill last wrote it is never overwritten.
import path from 'node:path';
import { writeMarkedSection, markers, inertMarkdown } from '../lib/marked-section.js';

export const { start: START, end: END } = markers('digest');
const LABELS = { commit: ['commit', 'commits'], pr: ['PR', 'PRs'], deployment: ['deployment', 'deployments'], status: ['status change', 'status changes'], write: ['file write', 'file writes'], plan: ['plan', 'plans'], conclusion: ['conclusion', 'conclusions'], handoff: ['agent run', 'agent runs'], bind: ['binding', 'bindings'] };
const ORDER = Object.keys(LABELS);

const oneLine = (s) => inertMarkdown(String(s ?? '').replace(/[\r\n]+/g, ' ').trim());

export function renderDigest(day, { pendingDeployments = [] } = {}) {
  const lines = [`## Session Quill — ${day.date}`, ''];
  if (!day.tickets.length) lines.push('No tracked activity.');
  for (const t of day.tickets) {
    const parts = ORDER.filter((k) => t.counts[k]).map((k) => `${t.counts[k]} ${LABELS[k][t.counts[k] === 1 ? 0 : 1]}`);
    lines.push(`- **${oneLine(t.key)}** ${oneLine(t.title)} — ${parts.join(', ')}`);
  }
  if (day.sessions) lines.push('', `Sessions started: ${day.sessions}`);
  if (pendingDeployments.length) lines.push('', `Awaiting deployment: ${pendingDeployments.map((d) => `${oneLine(d.ticket_key)} (${oneLine(d.environment)})`).join(', ')}`);
  return `${lines.join('\n')}\n`;
}

// Writes `markdown` between the digest markers of `file` (created when missing). `indexPath` keeps
// the hash of each section Quill wrote, so a section someone edited is reported instead of replaced.
export function writeDigestFile({ file, markdown, indexPath }) {
  return writeMarkedSection({ file, marker: 'digest', markdown, indexPath, conflictCode: 'digest-conflict' });
}

export function writeDigest({ dir, date, markdown, indexPath }) {
  return writeDigestFile({ file: path.join(dir, `${date}.md`), markdown, indexPath });
}
