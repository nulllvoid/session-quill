// Dashboard QA fixes: issues #7–#12.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, pickNextEntries, viewCounts, filtersFromHash, EMPTY_FILTERS, PICKNEXT_SIZE } from '../../ui/components.js';
import { renderPickNext } from '../../ui/views/picknext.js';
import { renderBoard, columnCollapsed } from '../../ui/views/board.js';
import { renderSidebar, NAV_ITEMS } from '../../ui/views/header.js';
import { derive } from '../../src/reconcile/derive.js';
import { snapshot, ticket, TID } from './fixtures.js';
import { cli } from '../cli/helpers.js';

const NOW = '2026-10-02T12:00:00Z';
const VIEWS = NAV_ITEMS.map(([id]) => id);

// Eight eligible tickets ranked globally; the two in repo "other" rank 7th and 8th.
function ranked() {
  const tickets = Array.from({ length: 8 }, (_, i) => ticket(i + 1, { repo_id: i >= 6 ? 'other' : 'demo' }));
  const picknext = tickets.map((t, i) => ({ rank: i + 1, ticket_id: t.id, raw_score: 100 - i, score: 100 - i, reasons: [], limitations: [] }));
  return normalizeSnapshot(snapshot({ tickets, picknext, blocked: [], deployments_outstanding: [] }));
}

test('#8 Pick next ranks within the filter instead of filtering the global top five', () => {
  const s = ranked();
  const all = pickNextEntries(s, EMPTY_FILTERS);
  assert.equal(all.length, PICKNEXT_SIZE);
  assert.deepEqual(all.map((x) => x.entry.rank), [1, 2, 3, 4, 5]);
  const other = pickNextEntries(s, { ...EMPTY_FILTERS, repo: 'other' });
  assert.deepEqual(other.map((x) => x.ticket.id), [TID(7), TID(8)]);
  assert.deepEqual(other.map((x) => x.entry.rank), [1, 2], 'ranks restart within the filtered set');
  const html = renderPickNext(s, { ...EMPTY_FILTERS, repo: 'other' }, { now: NOW });
  assert.doesNotMatch(html, /No matching work/);
  assert.match(html, /2 candidates/);
});

test('#8 the worker publishes every eligible ticket, not only the top five', () => {
  const tickets = new Map(Array.from({ length: 7 }, (_, i) => [TID(i + 1), ticket(i + 1)]));
  const state = { tickets, meta: { timezone: 'UTC' }, sessions: new Map(), checkpoints: new Map(), handoffs: new Map() };
  assert.equal(derive(state, NOW).picknext.length, 7);
});

test('#7 every board column can be hidden; Done starts hidden and the others start open', () => {
  assert.equal(columnCollapsed('done', new Set()), true);
  assert.equal(columnCollapsed('todo', new Set()), false);
  assert.equal(columnCollapsed('todo', new Set(['todo'])), true);
  assert.equal(columnCollapsed('done', new Set(['done'])), false);
  const html = renderBoard(snapshot(), EMPTY_FILTERS, { now: NOW, toggled: new Set(['todo']), pages: {} });
  for (const status of ['todo', 'active', 'review', 'deploy-pending', 'blocked', 'done']) assert.match(html, new RegExp(`data-action="toggle-column" data-column="${status}"`));
  assert.match(html, /data-column="todo" data-collapsed="true"/);
  assert.match(html, /data-column="active" data-collapsed="false"/);
  assert.match(html, /data-column="done" data-collapsed="true"/);
});

test('#9 the Board badge and the Board header use the same open count', () => {
  const s = snapshot();
  const html = renderBoard(s, EMPTY_FILTERS, { now: NOW, toggled: new Set(), pages: {} });
  const open = s.tickets.filter((t) => t.status !== 'done').length;
  assert.match(html, new RegExp(`${open} open tickets · 2 done`));
  assert.equal(viewCounts(normalizeSnapshot(s), EMPTY_FILTERS).board, open);
});

test('#10 sidebar badges count what each view shows under the active filters', () => {
  const s = ranked();
  const filters = { ...EMPTY_FILTERS, repo: 'other' };
  const counts = viewCounts(s, filters);
  assert.equal(counts.picknext, 2);
  assert.equal(counts.board, 2);
  assert.equal(counts.tree, 2);
  const side = renderSidebar(s, { view: 'board', filters });
  assert.match(side, /aria-label="Board, 2 items" data-view="board"/);
  assert.equal(viewCounts(s, EMPTY_FILTERS).picknext, 5);
});

test('the Runs badge counts live runs on tickets the filters keep', () => {
  const s = ranked();
  const other = s.tickets.find((t) => t.repo_id === 'other');
  const mine = s.tickets.find((t) => t.repo_id !== 'other');
  const live = normalizeSnapshot({ ...s, handoffs: [{ id: 'a', ticket_id: other.id, state: 'running', permissions: {} }, { id: 'b', ticket_id: mine.id, state: 'queued', permissions: {} }, { id: 'c', ticket_id: other.id, state: 'done', permissions: {} }] });
  assert.equal(viewCounts(live, EMPTY_FILTERS).runs, 2);
  assert.equal(viewCounts(live, { ...EMPTY_FILTERS, repo: 'other' }).runs, 1);
});

test('#11 a hash that names a view replaces remembered filters; a bare hash keeps them', () => {
  const remembered = { ...EMPTY_FILTERS, repo: 'pml-datalake' };
  assert.deepEqual(filtersFromHash('#view=board', remembered, VIEWS), EMPTY_FILTERS);
  assert.deepEqual(filtersFromHash('#view=board&repo=x&stale=1', remembered, VIEWS), { ...EMPTY_FILTERS, repo: 'x', stale: true });
  assert.equal(filtersFromHash('', remembered, VIEWS).repo, 'pml-datalake');
});

test('#12 help documents --no-open for the live dashboard and --open for --static', async () => {
  const r = await cli(['help'], {});
  assert.match(r.out, /ui \[--no-open\] \| ui --static <out\.html> \[--open\]/);
});
