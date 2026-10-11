// Defects found by driving the dashboard in a real browser against the UI plan (ADR 0022 to 0025).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderBulkActionBar, renderBulkHandoffForm } from '../../ui/views/bulk.js';
import { renderPickNext } from '../../ui/views/picknext.js';
import { snapshot, ticket, TID } from './fixtures.js';

const css = fs.readFileSync('ui/styles.css', 'utf8');
const NOW = '2026-10-02T12:30:00Z';

// Every rule inside the narrow-layout media queries, so a rule can be checked for its context.
function narrowRules() {
  return [...css.matchAll(/@media \(max-width: 899px\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
}

test('Undo all keeps its count inside one label, so the flex gap of the button never splits "Undo all (", the number and ")"', () => {
  const html = renderBulkActionBar({ count: 2, undo: 2 });
  assert.match(html, /<span class="bulk-undo-label">Undo all \(<span class="bulk-undo-count">2<\/span>\)<\/span>/);
  assert.doesNotMatch(html, /<\/svg>Undo all/);
});

test('on narrow layouts the bulk bar clears the bottom nav: its offset is at least the nav height (52px items, 8px padding, 1px border)', () => {
  const rule = /\.bulk-bar\s*\{[^}]*bottom:\s*calc\((\d+)px \+ env\(safe-area-inset-bottom\)\)/.exec(narrowRules());
  assert.ok(rule, 'the narrow bar offset is in the narrow media query');
  assert.ok(Number(rule[1]) >= 61 + 4, `offset ${rule[1]}px leaves a gap above the 61px nav`);
});

test('on narrow layouts the health popover is pinned to the viewport edges instead of overflowing to the right of its summary', () => {
  assert.match(narrowRules(), /\.health-pop \.popover\s*\{[^}]*position:\s*fixed;[^}]*left:\s*16px;[^}]*right:\s*16px;[^}]*width:\s*auto/);
});

test('in select mode the top-ranked Pick next card keeps its full-width row, checkbox included', () => {
  assert.match(css, /\.picknext-grid > \.card-pick:first-child\s*\{[^}]*grid-column:\s*1 \/ -1/);
  const s = snapshot();
  const html = renderPickNext(s, {}, { now: NOW, selecting: true, checked: new Set() });
  const first = /<div class="picknext-grid"><div class="card-pick"><input[^>]*><article class="card card-picknext top"/.exec(html);
  assert.ok(first, 'the top card is the first grid child, wrapped with its checkbox');
});

test('bulk form rows keep the eligibility chip on the ticket line: the title truncates instead of pushing the chip down', () => {
  assert.match(css, /\.bulk-entry, \.bulk-result\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /\.bulk-entry-title\s*\{[^}]*flex:\s*1 1 auto/);
  // On phones the rows wrap instead, the title reads in full and a long key may break, so nothing scrolls sideways.
  assert.match(narrowRules(), /\.bulk-entry, \.bulk-result\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(narrowRules(), /\.bulk-entry-title\s*\{[^}]*white-space:\s*normal/);
  assert.match(narrowRules(), /\.bulk-entry \.key, \.bulk-result \.key\s*\{[^}]*min-width:\s*0/);
  const s = snapshot({ tickets: [ticket(1, { status: 'blocked', title: 'A long title that would otherwise wrap the chip onto its own line' })] });
  const html = renderBulkHandoffForm(s, [TID(1)]);
  assert.match(html, /<li class="bulk-entry" data-state="not-eligible">[\s\S]*?<span class="bulk-entry-title">A long title[\s\S]*?<span class="chip small" data-entry="not-eligible">Not eligible<\/span> <span class="muted small">\(Blocked\)<\/span><\/li>/);
});
