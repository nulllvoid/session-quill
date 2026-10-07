// Ticket descriptions (ADR 0014): every ticket an agent creates says what it is for, why, and how
// to tell it is done, in one shape that people scan and recipe runs read as context. The
// description is the ticket's Summary section; the format is checked, never rewritten.

export const DESCRIPTION_MAX = 4000;

export const DESCRIPTION_TEMPLATE = [
  '**Goal:** <one sentence: what this ticket achieves>',
  '',
  '**Context:** <why it matters and where: files, components, links, constraints>',
  '',
  '**Done when:**',
  '- <a condition someone can check>',
  '- <another, such as the test command that must pass>',
].join('\n');

const LABELS = { goal: 'goal', context: 'context', 'done when': 'done' };
// "**Goal:**", "Goal:", "**Goal**:", "## Goal" and similar spellings all count as the label.
const LABEL_RE = /^\s*(?:#{1,6}\s*)?\**\s*(goal|context|done when)\s*\**\s*:?\s*\**\s*(.*)$/i;
const ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(\S.*)$/;

// A shell argument often carries "\n" as two characters; a description with no real line breaks
// has those turned into line breaks.
export function normalizeDescription(text) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!s.includes('\n') && s.includes('\\n')) s = s.replace(/\\n/g, '\n');
  return s.trim();
}

export function parseDescription(text) {
  const out = { goal: '', context: '', done: [] };
  let current = null;
  for (const line of normalizeDescription(text).split('\n')) {
    const label = LABEL_RE.exec(line);
    if (label) {
      current = LABELS[label[1].toLowerCase()];
      const rest = label[2].trim();
      if (current === 'done') { const item = ITEM_RE.exec(rest); if (item) out.done.push(item[1].trim()); } else if (rest) out[current] = out[current] ? `${out[current]} ${rest}` : rest;
      continue;
    }
    if (!current || !line.trim()) continue;
    if (current === 'done') {
      const item = ITEM_RE.exec(line);
      if (item) out.done.push(item[1].trim());
    } else {
      out[current] = out[current] ? `${out[current]} ${line.trim()}` : line.trim();
    }
  }
  return out;
}

// What is missing or malformed, in words an agent can act on; empty means the description is valid.
export function descriptionProblems(text) {
  const s = normalizeDescription(text);
  if (!s) return ['the description is empty'];
  const problems = [];
  if (s.length > DESCRIPTION_MAX) problems.push(`the description is ${s.length} characters; keep it under ${DESCRIPTION_MAX}`);
  const d = parseDescription(s);
  if (!d.goal) problems.push('"**Goal:**" is missing or empty');
  else if (d.goal.length < 10) problems.push('"**Goal:**" needs a full sentence');
  if (!d.context) problems.push('"**Context:**" is missing or empty');
  if (!d.done.length) problems.push('"**Done when:**" needs at least one "- " item');
  return problems;
}

export function hasValidDescription(ticket) {
  return !!ticket && descriptionProblems(ticket.summary).length === 0;
}

export function descriptionHelp(problems = []) {
  return `${problems.length ? `The ticket description is not valid: ${problems.join('; ')}.\n` : ''}Write it in this format (Markdown, one line per part; pass real line breaks or \\n):\n${DESCRIPTION_TEMPLATE}`;
}
