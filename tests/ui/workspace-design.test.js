import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDetail } from '../../ui/views/detail.js';
import { renderHeader } from '../../ui/views/header.js';
import { renderPickNext } from '../../ui/views/picknext.js';
import { snapshot } from './fixtures.js';

const now = '2026-10-02T12:00:00Z';

test('ticket sections retain context and delivery controls while next action precedes the description', () => {
  const s = snapshot();
  for (const tab of ['overview', 'activity', 'delivery']) {
    const html = renderDetail(s.tickets[0], s, { now, tab });
    assert.ok(html.indexOf('<h3>Next action') < html.indexOf('<h3>Description'));
    for (const section of ['overview', 'activity', 'delivery']) {
      assert.ok(html.includes(`id="detail-page-${section}" role="tabpanel" aria-labelledby="detail-tab-${section}" ${section !== tab ? 'hidden' : ''}>`));
    }
    for (const title of ['Timeline', 'Files touched', 'PRs and deployments', 'Follow-ups', 'Sessions']) assert.ok(html.includes(`<h3>${title}`));
  }
});

test('recent context follows matching tickets and does not expose an unrelated project', () => {
  const s = snapshot();
  s.sessions[0].current_ticket_id = s.tickets[0].id;
  s.checkpoints[0].preview = '<checkpoint text>';
  s.checkpoints[0].ticket_id = s.tickets[0].id;
  const html = renderPickNext(s, {}, { now });
  assert.ok(html.includes('Where you left off'));
  assert.ok(html.includes('&lt;checkpoint text&gt;'));
  assert.ok(!renderPickNext(s, { project: 'unrelated' }, { now }).includes('Where you left off'));
});

test('compact health keeps an offline warning and disables refresh', () => {
  const html = renderHeader(snapshot(), { now, online: false, theme: 'light' });
  assert.match(html, /Worker offline/);
  assert.match(html, /Changes unavailable until the worker reconnects/);
  assert.match(html, /data-action="refresh" disabled/);
});

test('recent context uses the checkpoint ticket after a session switches tickets', () => {
  const s = snapshot();
  s.checkpoints = [{ id: 'cp-switch', session_id: s.sessions[0].id, ticket_id: s.tickets[0].id, recorded_at: now, complete: true, preview: 'Context from the previous ticket' }];
  s.sessions[0].current_ticket_id = s.tickets[1].id;
  s.sessions[0].last_checkpoint_preview = 'Context from the previous ticket';
  const html = renderPickNext(s, {}, { now });
  const recent = html.slice(html.indexOf('<section class="recent-work">'), html.indexOf('<section class="attention-section"'));
  assert.ok(recent.includes(`data-open="${s.tickets[0].id}"`));
  assert.ok(!recent.includes(`data-open="${s.tickets[1].id}"`));
});
