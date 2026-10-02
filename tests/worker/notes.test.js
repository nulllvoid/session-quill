import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { renderTicketNote, parseNote, writeNote, GENERATED_SECTIONS } from '../../src/worker/notes.js';
import { stringifyYaml, parseYaml } from '../../src/worker/markdown.js';
import { newState, createTicket } from '../core/helpers.js';

function sampleTicket() {
  const state = newState();
  const t = createTicket(state);
  t.next_action = 'Verify restart recovery';
  t.timeline.push({ id: 'tl1', at: '2026-10-02T08:05:00Z', kind: 'write', text: 'Edit src/a.js', event_id: 'e1', content_ref: null, coverage: 'complete' });
  t.plans.push({ id: 'p1', session_id: 's1', checkpoint_id: 'c1', content_ref: 'a'.repeat(64), preview: 'Plan preview <b>escaped</b>', approved_at: '2026-10-02T08:06:00Z', provenance: 'explicit' });
  return { state, ticket: t };
}

test('stringifyYaml/parseYaml round-trip the frontmatter subset including nested objects and arrays', () => {
  const obj = { a: 1, b: 'two: with colon', c: null, d: true, e: [], f: ['x', 'y'], g: { h: 'i', j: [{ k: 1, l: 'm' }] }, n: 'multi\nline', o: '' };
  const text = stringifyYaml(obj);
  assert.deepEqual(parseYaml(text), obj);
});

test('renderTicketNote emits frontmatter, user Summary first, generated sections in order, user Notes last', () => {
  const { state, ticket } = sampleTicket();
  const text = renderTicketNote(ticket, { state, authored: { summary: '\nMy summary\n\n', notes: '\nkeep me\n' } });
  assert.match(text, /^---\nschema_version: 1\n/);
  const order = GENERATED_SECTIONS.map((s) => text.indexOf(`<!-- quill:generated:${s} start`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(text.indexOf('## Summary') < order[0]);
  assert.ok(text.lastIndexOf('## Notes') > order[order.length - 1]);
  assert.equal(text.includes('<b>escaped</b>'), false, 'raw HTML in user content is escaped');
  assert.match(text, /&lt;b&gt;escaped&lt;\/b&gt;/);
});

test('parseNote preserves authored sections byte-for-byte including CRLF and trailing spaces', () => {
  const { state, ticket } = sampleTicket();
  const summary = '\r\nSummary line  \r\n\r\n  indented\t\r\n';
  const notes = '\n- note one   \n\n\n';
  const text = renderTicketNote(ticket, { state, authored: { summary, notes } });
  const parsed = parseNote(text);
  assert.equal(parsed.authored.summary, summary);
  assert.equal(parsed.authored.notes, notes);
  assert.equal(parsed.frontmatter.key, ticket.key);
  assert.equal(Object.keys(parsed.generated).length, GENERATED_SECTIONS.length);
  for (const block of Object.values(parsed.generated)) assert.equal(block.intact, true);
});

test('writeNote writes, then preserves user-edited authored text on the next update', () => {
  const { state, ticket } = sampleTicket();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-notes-'));
  const file = path.join(dir, `${ticket.key}.md`);
  const index = {};
  assert.equal(writeNote(file, ticket, { state, index }), 'written');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('## Summary\n', '## Summary\nUser wrote this.\n'));
  ticket.next_action = 'Changed';
  assert.equal(writeNote(file, ticket, { state, index }), 'written');
  const after = fs.readFileSync(file, 'utf8');
  assert.match(after, /## Summary\nUser wrote this\.\n/);
  assert.match(after, /next_action: Changed/);
});

test('writeNote returns unchanged when nothing differs and conflict when a generated block was edited', () => {
  const { state, ticket } = sampleTicket();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-notes-'));
  const file = path.join(dir, `${ticket.key}.md`);
  const index = {};
  writeNote(file, ticket, { state, index });
  assert.equal(writeNote(file, ticket, { state, index }), 'unchanged');
  const text = fs.readFileSync(file, 'utf8');
  const tampered = text.replace('· write · Edit src/a.js', '· write · Edit src/HACKED.js');
  assert.notEqual(tampered, text);
  fs.writeFileSync(file, tampered);
  ticket.next_action = 'Something new';
  const outcome = writeNote(file, ticket, { state, index });
  assert.equal(outcome, 'conflict');
  assert.equal(fs.readFileSync(file, 'utf8'), tampered, 'original file kept');
  assert.ok(ticket.validation_issues.some((i) => i.startsWith('generated-block-edited:timeline')));
});

test('writeNote treats a manually edited frontmatter as a conflict too', () => {
  const { state, ticket } = sampleTicket();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-notes-'));
  const file = path.join(dir, `${ticket.key}.md`);
  const index = {};
  writeNote(file, ticket, { state, index });
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('status: todo', 'status: done'));
  ticket.next_action = 'x';
  assert.equal(writeNote(file, ticket, { state, index }), 'conflict');
  assert.ok(ticket.validation_issues.some((i) => i === 'generated-frontmatter-edited'));
});
