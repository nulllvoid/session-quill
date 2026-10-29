// Run with NODE_PATH pointing to an existing Playwright installation; no app dependency needed.
// NODE_PATH=/path/to/node_modules node --test tests/ui/browser.mjs
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { snapshot } from './fixtures.js';
const { chromium } = createRequire(import.meta.url)('playwright');
let browser, server, base, context, page, data;
const errors = [];
before(async () => {
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/v1/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(pathname === '/v1/snapshot' ? data : { entries: [], conflicts: [] }));
      return;
    }
    try {
      const file = pathname === '/' ? 'ui/index.html' : pathname.slice(1);
      if ((!file.startsWith('ui/') && !file.startsWith('docs/design-system/')) || file.includes('..')) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.json') ? 'application/json' : 'text/html');
      res.end(await readFile(new URL(`../../${file}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
});
after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
beforeEach(async () => {
  data = snapshot(); errors.length = 0;
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
});
afterEach(async () => { await context.close(); assert.deepEqual(errors, [], 'no browser runtime errors'); });
async function open(hash = '') { await page.goto(base + '/' + hash); const view = new URLSearchParams(hash.slice(1)).get('view') || 'work'; await page.waitForSelector(`#main .view-${['board','tree','picknext'].includes(view) ? 'work' : view}`); }
async function refresh() {
  const response = page.waitForResponse(r => r.url().endsWith('/v1/snapshot'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await response; await page.waitForTimeout(100);
}

test('Enter on a card action opens its dialog, not ticket detail', async () => {
  await open();
  await page.locator('.work-row [data-action="handoff"]').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#dialog').evaluate(el => el.open), true);
  assert.equal(await page.locator('#dialog [data-form="status"]').count(), 0, 'a run action must never open ticket resolution');
  assert.equal(await page.locator('#detail').isVisible(), false);
});

test('browser modifier shortcuts do not navigate the dashboard', async () => {
  await open(); await page.locator('#main').focus();
  await page.keyboard.press('Control+2');
  assert.match(page.url(), /view=work/);
});

test('status select can open natively with the mouse', async () => {
  await open(); await page.locator('.work-title').first().click();
  const select = page.locator('#detail [data-action="status-select"]');
  const prevented = await select.evaluate(el => !el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  assert.equal(prevented, false, 'native select click must not be cancelled');
});

test('next-action draft survives polling after focus leaves the textarea', async () => {
  await open(); await page.locator('.work-title').first().click();
  await page.locator('[data-action="edit-next"]').click();
  const input = page.locator('textarea[name="next_action"]');
  await input.fill('Unsaved draft that must survive');
  await page.locator('#detail [data-action="cancel-next"]').focus();
  data.tickets[0].title = 'Updated by a poll'; data.tickets[0].revision = 2; data.generation_id += '-new';
  await refresh();
  assert.equal(await input.inputValue(), 'Unsaved draft that must survive');
  assert.equal(await input.evaluate(el => el.form.dataset.revision), '1', 'retain the edit revision for conflict detection');
  await page.locator('#detail [data-action="cancel-next"]').click();
  await page.locator('[data-action="edit-next"]').click();
  assert.equal(await input.inputValue(), 'Write the plan', 'Cancel discards the draft');
});

test('search on a later Sessions page shows matching rows immediately', async () => {
  data.sessions = Array.from({ length: 60 }, (_, i) => ({ ...data.sessions[0], id: `s${i}`, host_session_id: `host${i}`, title: i === 0 ? 'Needle' : `Session ${i}` }));
  await open('#view=sessions');
  await page.locator('[data-action="sessions-page"][data-page="1"]').click();
  await page.locator('#search').fill('Needle');
  assert.equal(await page.locator('tbody tr').count(), 1);
});

test('session metadata stays expanded when polling changes a row', async () => {
  await open('#view=sessions');
  await page.locator('.session-metadata summary').click();
  data.sessions[0].title = 'Updated session title'; data.generation_id += '-new';
  await refresh();
  assert.equal(await page.locator('.session-metadata').evaluate(el => el.open), true);
});

test('Sessions clamps a page after its records disappear', async () => {
  data.sessions = Array.from({ length: 60 }, (_, i) => ({ ...data.sessions[0], id: `s${i}` }));
  await open('#view=sessions');
  await page.locator('[data-action="sessions-page"][data-page="1"]').click();
  data.sessions = data.sessions.slice(0, 1); data.generation_id += '-new';
  await refresh();
  assert.equal(await page.locator('tbody tr').count(), 1);
});

test('approved plans stay expanded when polling changes ticket details', async () => {
  data.tickets[0].plans = [{ checkpoint_id: 'plan-1', approved_at: '2026-10-02T12:00:00Z', provenance: 'owner', preview: 'Approved steps', content_ref: 'a'.repeat(64) }];
  data.tickets[0].plans_count = 1;
  await open(); await page.locator('.work-title').first().click();
  await page.locator('.plan summary').click();
  data.tickets[0].title = 'Updated ticket title'; data.generation_id += '-new';
  await refresh();
  assert.equal(await page.locator('.plan').evaluate(el => el.open), true);
});

test('all views fit mobile and desktop in both themes', async () => {
  for (const width of [390, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const theme of ['light', 'dark']) {
      for (const view of ['picknext', 'board', 'runs', 'today', 'sessions', 'deployments', 'tree', 'memory']) {
        await open(`#view=${view}`);
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${view} ${theme} ${width}px`);
      }
    }
  }
});

test('mobile detail and run dialog fit long ticket data and retain keyboard navigation', async () => {
  data.tickets[0].title = 'LongTitle'.repeat(40);
  data.tickets[0].key = 'PROJECT-' + '1234567890'.repeat(20);
  data.tickets[0].next_action = 'LongNextAction'.repeat(40);
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await page.locator('.work-title').first().focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#detail').getAttribute('aria-modal'), 'true');
  assert.equal(await page.locator('#main').evaluate(el => el.inert), true);
  assert.equal(await page.locator('#detail').evaluate(el => el.scrollWidth <= el.clientWidth), true, JSON.stringify(await page.locator('#detail').evaluate(el => [...el.querySelectorAll('*')].filter(n => n.scrollWidth > n.clientWidth + 1 && n.clientWidth).map(n => [n.tagName, n.className, n.clientWidth, n.scrollWidth]))));
  await page.keyboard.press('Escape');
  await page.waitForSelector('#detail', { state: 'hidden' });
  await page.locator('.work-row [data-action="handoff"]').first().focus(); await page.keyboard.press('Space');
  assert.equal(await page.locator('#dialog').evaluate(el => el.open), true);
  assert.equal(await page.locator('#dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#dialog').evaluate(el => el.open), false);
});

test('closing a dialog returns focus to its own trigger after another action', async () => {
  await open();
  await page.locator('[data-action="help"]').click();
  await page.keyboard.press('Escape');
  const trigger = page.locator('.work-row [data-action="handoff"]').first();
  await trigger.click();
  await page.keyboard.press('Escape');
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
});

test('sidebar tabs support arrows, a single tab stop, and a labelled panel', async () => {
  await open();
  await page.locator('#tab-work').focus(); await page.keyboard.press('ArrowDown');
  assert.match(page.url(), /view=runs/);
  assert.equal(await page.locator('#tab-runs').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#sidebar [role="tab"]').evaluateAll(els => els.filter(el => el.tabIndex === 0).length), 1);
  assert.equal(await page.locator('#main').getAttribute('aria-labelledby'), 'tab-runs');
  await page.keyboard.press('End'); assert.match(page.url(), /view=memory/);
  await page.keyboard.press('Home'); assert.match(page.url(), /view=work/);
});

test('touch controls meet the design system minimum on phones', async () => {
  await context.close();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await open();
  const short = await page.locator('.btn, #search').evaluateAll(els => els.filter(el => el.getClientRects().length && !el.closest('details:not([open]) .popover')).map(el => ({ label: el.getAttribute('aria-label') || el.textContent, height: el.getBoundingClientRect().height })).filter(el => el.height < 44));
  assert.deepEqual(short, []);
  await page.locator('.work-title').first().click();
  const detailShort = await page.locator('#detail .btn, #detail select, #detail .detail-tabs button').evaluateAll(els => els.filter(el => el.getClientRects().length).map(el => ({ label: el.getAttribute('aria-label') || el.textContent, height: el.getBoundingClientRect().height })).filter(el => el.height < 44));
  assert.deepEqual(detailShort, []);
});

test('long ticket headers do not cover the content while scrolling', async () => {
  data.tickets[0].title = 'Long title with important evidence '.repeat(30);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(); await page.locator('.work-title').first().click();
  const tab = page.locator('#detail-tab-activity');
  await tab.scrollIntoViewIfNeeded();
  assert.equal(await tab.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true);
});

test('design reference panels are keyboard reachable and theme control has a stable name', async () => {
  await page.goto(base + '/docs/design-system/index.html');
  await page.waitForSelector('.icon-tile');
  await page.locator('#tab-needs').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tab-live').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#panel-live').evaluate(el => el === document.activeElement), true);
  const before = await page.locator('#theme').innerText();
  await page.locator('#theme').click();
  assert.equal(await page.locator('#theme').innerText(), before);
  assert.equal(await page.locator('#theme').getAttribute('aria-pressed'), 'true');
});

test('design reference controls work before the icon catalog finishes loading', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/ui/assets/manifest.json', async route => { await held; await route.continue(); });
  try {
    await page.goto(base + '/docs/design-system/index.html', { waitUntil: 'domcontentloaded' });
    await page.locator('#tab-needs').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-live').getAttribute('aria-selected'), 'true');
    await page.locator('#icon-search').fill('queue');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  const manifest = JSON.parse(await readFile(new URL('../../ui/assets/manifest.json', import.meta.url), 'utf8'));
  const count = manifest.files.filter(f => f.role === 'icon' && f.path !== 'icons/sprite.svg').length;
  await page.waitForFunction(count => document.querySelectorAll('.icon-tile').length === count, count);
  assert.deepEqual(await page.locator('.icon-tile:visible').evaluateAll(els => els.map(el => el.dataset.name)), ['queue']);
});

test('design reference fits four viewport sizes in both themes and loads its images', async () => {
  await page.goto(base + '/docs/design-system/index.html');
  for (const width of [390, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `reference ${theme} ${width}px`);
      await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
    }
  }
});

test('phone navigation skips hidden tabs and keeps More views reachable', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await page.locator('#tab-work').focus(); await page.keyboard.press('End');
  assert.match(page.url(), /view=sessions/);
  await page.keyboard.press('ArrowRight'); assert.match(page.url(), /view=work/);
  await page.locator('[data-action="toggle-more"]').first().click();
  await page.locator('#more-sheet [data-view="today"]').click();
  assert.equal(await page.locator('.nav-more').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('#tab-work').evaluate(el => el === document.activeElement), true);
});

async function captureEdits() {
  const edits = [];
  await page.route('**/v1/requests', async route => {
    const body = route.request().postDataJSON(); edits.push(body);
    await route.fulfill({ json: { ...body, state: 'pending', created_at: '2026-10-02T12:30:00Z', not_before: '2099-10-02T12:30:10Z' } });
  });
  return edits;
}

test('closure controls retain drafts and their opening revision, then submit explicit settings once', async () => {
  page.setDefaultTimeout(2000);
  const edits = await captureEdits();
  await open('#view=board&ticket=' + data.tickets[6].id);
  await page.locator('[data-action="completion-settings"]').click();
  await page.locator('[name="completion_mode"]').selectOption('children');
  await page.locator('[name="blocks_parent"]').selectOption('false');
  data.tickets[6].revision = 2; data.generation_id += '-new'; await refresh();
  assert.equal(await page.locator('[name="completion_mode"]').inputValue(), 'children');
  const sent = page.waitForResponse(r => r.url().endsWith('/v1/requests'));
  await page.getByRole('button', { name: 'Save settings' }).click(); await sent;
  assert.equal(edits.length, 1);
  assert.equal(edits[0].kind, 'set-completion');
  assert.equal(edits[0].expected_revision, 1);
  assert.deepEqual(edits[0].payload, { completion_mode: 'children', blocks_parent: false });
  assert.equal(await page.locator('[data-action="completion-settings"]').isDisabled(), true);
});

test('closure resolution validates reason and related ticket, preserves pending deployment confirmation', async () => {
  page.setDefaultTimeout(2000);
  const edits = await captureEdits();
  await open('#view=board&ticket=' + data.tickets[5].id);
  await page.locator('[data-action="resolve-ticket"]').click();
  await page.locator('[name="resolution_kind"]').selectOption('duplicate');
  await page.locator('[name="deployment_choice"][value="leave"]').check();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.equal(edits.length, 0);
  await page.locator('[name="resolution_reason"]').fill('Same task and acceptance condition');
  await page.locator('[name="related_ticket_id"]').selectOption(data.tickets[0].id);
  const sent = page.waitForResponse(r => r.url().endsWith('/v1/requests'));
  await page.getByRole('button', { name: 'Apply', exact: true }).click(); await sent;
  assert.deepEqual(edits[0].payload, { status: 'done', resolution: { kind: 'duplicate', reason: 'Same task and acceptance condition', related_ticket_id: data.tickets[0].id }, deployment_choice: 'leave' });
});

test('follow-up acceptance asks relationship and description before sending the existing request', async () => {
  page.setDefaultTimeout(2000);
  const edits = await captureEdits();
  data.handoffs[0].state = 'done';
  data.handoffs[0].suggestions = [{ id: 'followup-1', type: 'followup', state: 'proposed', title: 'Add coverage' }];
  await open('#view=runs&run=h1');
  await page.locator('[data-action="accept-suggestion"]').click();
  assert.equal(edits.length, 0);
  await page.locator('[name="blocks_parent"][value="true"]').check();
  const description = 'Goal: Cover the fix\n\nContext: A regression was found\n\nDone when:\n- The regression test passes';
  await page.locator('textarea[name="description"]').fill(description);
  const sent = page.waitForResponse(r => r.url().endsWith('/v1/requests'));
  await page.getByRole('button', { name: 'Accept follow-up', exact: true }).click(); await sent;
  assert.equal(edits[0].kind, 'accept-suggestion');
  assert.equal(edits[0].expected_revision, 1);
  assert.deepEqual(edits[0].payload, { handoff_id: 'h1', suggestion_id: 'followup-1', blocks_parent: true, description });
});

test('closure review supports keyboard at phone width and never queues settings offline', async () => {
  page.setDefaultTimeout(2000);
  const edits = await captureEdits();
  await page.setViewportSize({ width: 390, height: 844 });
  data.reconciliation = { items: [{ ticket_id: data.tickets[0].id, key: data.tickets[0].key, title: 'Long'.repeat(120), reason: 'Missing'.repeat(100), blockers: ['Required'.repeat(100)], kind: 'review', closable: false }] };
  await open('#view=runs&tab=needs');
  await page.getByRole('button', { name: 'Open ticket', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.locator('[data-action="completion-settings"]').click();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByRole('button', { name: 'Save settings' }).click();
  assert.equal(edits.length, 0);
  assert.equal(await page.locator('#dialog').evaluate(el => el.open), true, 'offline preserves the form');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('closure acknowledgement submits the displayed evidence version once and waits for snapshot confirmation', async () => {
  page.setDefaultTimeout(2000);
  const edits = await captureEdits();
  data.handoffs = [];
  data.reconciliation = { items: [{ ticket_id: data.tickets[0].id, key: data.tickets[0].key, title: 'Review closure', status: 'todo', reason: 'Needs owner acceptance', blockers: [], evidence_version: 'closure-v1' }] };
  await open('#view=runs&tab=needs');
  const button = page.getByRole('button', { name: 'Reviewed — keep open', exact: true });
  await button.focus();
  const sent = page.waitForResponse(r => r.url().endsWith('/v1/requests'));
  await page.keyboard.press('Enter'); await sent;
  assert.equal(edits.length, 1);
  assert.equal(edits[0].kind, 'acknowledge-closure');
  assert.equal(edits[0].target_id, data.tickets[0].id);
  assert.equal(edits[0].expected_revision, 1);
  assert.deepEqual(edits[0].payload, { evidence_version: 'closure-v1' });
  assert.equal(await button.isDisabled(), true);
  assert.equal(await page.locator('[data-closure]').count(), 1, 'a pending acknowledgement does not hide evidence');
  data.reconciliation.items = []; data.generation_id += '-ack'; await refresh();
  assert.equal(await page.locator('[data-closure]').count(), 0);
});


test('completed resolution also requires a reason and sends the supported limit', async () => {
  page.setDefaultTimeout(2000);
  const edits = await captureEdits();
  await open('#view=board&ticket=' + data.tickets[0].id);
  await page.locator('[data-action="resolve-ticket"]').click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.equal(edits.length, 0);
  const reason = page.locator('[name="resolution_reason"]');
  assert.equal(await reason.getAttribute('maxlength'), '500');
  await reason.fill('Acceptance criteria verified by the owner');
  const sent = page.waitForResponse(r => r.url().endsWith('/v1/requests'));
  await page.getByRole('button', { name: 'Apply', exact: true }).click(); await sent;
  assert.deepEqual(edits[0].payload.resolution, { kind: 'completed', reason: 'Acceptance criteria verified by the owner' });
});

test('Work filters preserve ancestry, parent completion and restored expansion without retaining bulk selection', async () => {
  data.tickets[0].work_rollup={required_total:2,required_completed:1,required_remaining:1};
  data.tickets[6].blocks_parent=true; data.tickets[6].status='todo'; data.tickets[6].title='Deep exact search target';
  await open('#view=work');
  const parent=data.tickets[0].id, child=data.tickets[6].id;
  assert.equal(await page.locator(`[data-work-row="${child}"]`).count(),0);
  await page.locator(`[data-check="${parent}"]`).check();
  await page.locator('#search').fill('Deep exact');
  assert.equal(await page.locator(`[data-work-row="${child}"]`).isVisible(),true);
  assert.match(await page.locator(`[data-work-row="${parent}"]`).textContent(),/1 of 2 required subtasks completed/);
  assert.equal(await page.locator('[data-check]:checked').count(),0);
  await page.locator('#search').fill('');
  assert.equal(await page.locator(`[data-work-row="${child}"]`).count(),0);
  await page.locator(`[data-action="work-expand"][data-ticket="${parent}"]`).click();
  data.generation_id+='-poll'; await refresh();
  assert.equal(await page.locator(`[data-work-row="${child}"]`).isVisible(),true);
});

test('Work inline and bulk edits send only explicit IDs and opening revisions', async () => {
  const edits=await captureEdits(); await open('#view=work');
  const parent=data.tickets[0], other=data.tickets[1];
  const inlineSent=page.waitForResponse(r=>r.url().endsWith('/v1/requests')); await page.locator(`[data-action="priority-select"][data-ticket="${parent.id}"]`).selectOption('P0'); await inlineSent;
  assert.deepEqual(edits[0].payload,{priority:'P0'}); assert.equal(edits[0].expected_revision,parent.revision);
  await page.locator(`[data-check="${parent.id}"]`).check(); await page.locator(`[data-check="${other.id}"]`).check();
  await page.locator('[data-action="bulk-priority"]').click(); await page.locator('#dialog [name="priority"]').selectOption('P3');
  const sent=page.waitForResponse(r=>r.url().endsWith('/v1/requests')); await page.locator('#dialog [type="submit"]').click(); await sent;
  await page.waitForFunction(()=>document.querySelectorAll('.request-feedback').length>=3);
  assert.deepEqual(edits.slice(1).map(e=>e.target_id).sort(),[parent.id,other.id].sort());
  assert.match(await page.locator('#main').textContent(),/Undo/);
});

test('create, link and move flows preserve all three revisions', async () => {
  const edits=await captureEdits(); const t=data.tickets[0], child=data.tickets[6]; await open(`#view=work&ticket=${t.id}`);
  await page.locator('[data-action="create-subtask"]').click(); await page.locator('#dialog [name="title"]').fill('A bounded child'); await page.locator('#dialog [name="description"]').fill('Goal: verify\nContext: parent\nDone when:\n- tests pass');
  let sent=page.waitForResponse(r=>r.url().endsWith('/v1/requests')); await page.locator('#dialog [type="submit"]').click(); await sent;
  assert.equal(edits[0].kind,'create-subtask'); assert.equal(edits[0].payload.blocks_parent,true);
  await page.locator('[data-action="link-child"]').click(); await page.locator('#dialog [name="child_id"]').selectOption(child.id);
  sent=page.waitForResponse(r=>r.url().endsWith('/v1/requests')); await page.locator('#dialog [type="submit"]').click(); await sent;
  assert.equal(edits[1].target_id,child.id); assert.equal(edits[1].expected_revision,child.revision); assert.equal(edits[1].payload.old_parent_revision,t.revision); assert.equal(edits[1].payload.new_parent_revision,t.revision);
});

test('short-screen composer keeps Cancel and close visible, preserves draft on polling and sends explicit Auto delivery', async () => {
  const edits=await captureEdits(); await page.setViewportSize({width:1366,height:768}); await open('#view=work'); await page.locator('.work-row [data-action="handoff"]').first().click();
  await page.locator('[name="instructions"]').fill('Verify the exact isolated fix'); await page.locator('[name="intent"][value="auto"]').check(); await page.locator('[name="commit"]').check();
  data.generation_id+='-poll'; await refresh(); assert.equal(await page.locator('[name="instructions"]').inputValue(),'Verify the exact isolated fix');
  for(const selector of ['[aria-label="Close Run agent"]','.composer-footer [data-action="close-dialog"]']) { const box=await page.locator(selector).boundingBox(); assert.ok(box.y>=0 && box.y+box.height<=768); }
  const sent=page.waitForResponse(r=>r.url().endsWith('/v1/requests')); await page.locator('#dialog button[type="submit"]').click(); await sent;
  assert.equal(edits[0].payload.intent,'auto'); assert.deepEqual(edits[0].payload.permissions,{commit:true,push_branch:false,open_draft_pr:false});
});

test('Daily generates explicit scope, previews sanitized content and saves an opt-in schedule', async () => {
 const update={id:'daily-1',revision:2,state:'ready',window_kind:'today',timezone:'UTC',window_start:'2026-10-29T00:00:00Z',window_end:'2026-10-30T00:00:00Z',coverage:{state:'complete'},content:'# Daily update\n## Private outcome\nSecret owner wording',scope:{project_ids:[],repo_ids:[]}};
 await page.route('**/v1/updates',r=>r.fulfill({json:{updates:[update],schedule:{fingerprint:'schedule-fingerprint',enabled:false,time:'18:00',weekdays:[1,2,3,4,5]}}}));
 await page.route('**/v1/updates/daily-1*',r=>r.fulfill({json:r.request().url().includes('share=1')?{...update,content:'Safe shared wording',share_content:'Safe shared wording'}:update}));
 const edits=await captureEdits(); await open('#view=updates'); await page.waitForSelector('.daily-report');
 await page.locator('[data-action="update-preview"]').click(); await page.waitForSelector('#dialog .update-content'); assert.match(await page.locator('#dialog').textContent(),/Safe shared wording/); assert.doesNotMatch(await page.locator('#dialog').textContent(),/Secret owner wording/); await page.keyboard.press('Escape');
 await page.locator('#update-scope').selectOption('repo:demo'); let sent=page.waitForResponse(r=>r.url().endsWith('/v1/requests')); await page.locator('.update-controls [type="submit"]').click(); await sent; assert.deepEqual(edits[0].payload.scope,{project_ids:[],repo_ids:['demo']});
 await page.locator('[data-disclosure="update-schedule"] summary').click(); await page.locator('[data-form="set-update-schedule"] [name="enabled"]').check(); await page.locator('[name="time"]').fill('17:30');
 data.generation_id+='-poll'; await refresh(); assert.equal(await page.locator('[name="time"]').inputValue(),'17:30');
 sent=page.waitForResponse(r=>r.url().endsWith('/v1/requests')); await page.locator('[data-form="set-update-schedule"] [type="submit"]').click(); await sent;
 assert.equal(edits[1].payload.enabled,true); assert.equal(edits[1].payload.time,'17:30'); assert.equal(edits[1].payload.expected_fingerprint,'schedule-fingerprint'); assert.equal(edits[1].payload.synthesis,false);
});

test('Work layout evidence: six parent outcomes at 1366×768 and responsive screenshots in both themes', async () => {
 const { ticket }=await import('./fixtures.js');
 data.tickets=Array.from({length:12},(_,i)=>ticket(i+1,{title:['Platform migration','Retry reliability','Release verification','Session continuity','Repository onboarding','Capture health'][i%6],priority:`P${i%4}`,next_action:'Confirm the next required step and evidence',work_rollup:{required_total:6,required_completed:4,required_remaining:2,closure_state:'not-ready',reasons:[]}}));
 for(const width of [1440,1366,1024,768,390]) {
   await page.setViewportSize({width,height:width===1366?768:900}); await open('#view=work');
   for(const theme of ['light','dark']) {
     await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width} ${theme} no page overflow`);
     if(width===1366) { const visible=await page.locator('[data-work-row]').evaluateAll(rows=>rows.filter(row=>{const r=row.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}).length); assert.ok(visible>=6,`${visible} rows visible`); }
     await page.screenshot({path:`/tmp/quill-control-ui-${theme}-${width}.png`});
   }
 }
});

test('Work performance: 2000 tasks, 20000 events, a 1000-child root and a 50-level chain', async () => {
 await open('#view=work');
 const result=await page.evaluate(async()=>{
   const {renderWork}=await import('/ui/views/work.js'); const seed=window.performance.now();
   const tickets=Array.from({length:2000},(_,i)=>({id:`perf-${i}`,key:`TASK-${i}`,title:`Outcome ${i}`,status:'todo',priority:`P${i%4}`,parent_id:i>0&&i<=1000?'perf-0':i>1000&&i<=1050?`perf-${i-1}`:null,blocks_parent:true,repo_id:'demo',project_id:'demo',tags:[],aliases:[],last_activity:'2026-10-01T00:00:00Z',next_action:i===1050?'deep needle':'Next bounded action',timeline:Array.from({length:10},(_,n)=>({id:`event-${i}-${n}`,text:'Recorded change'})),work_rollup:{required_total:i===0?1000:i>=1000&&i<1050?1:0,required_completed:0,required_remaining:i===0?1000:0}}));
   const snapshot={tickets,repos:[{id:'demo',display_name:'Demo'}],handoffs:[],capabilities:{read:true},meta:{timezone:'UTC'}};
   const host=document.getElementById('main'), times=[], long=[]; const observer=new PerformanceObserver(list=>long.push(...list.getEntries().map(e=>e.duration))); observer.observe({entryTypes:['longtask']});
   for(let i=0;i<35;i++) { await new Promise(requestAnimationFrame); const start=performance.now(); host.innerHTML=renderWork(snapshot,i%2?{q:'deep needle'}:{},{lens:'all',expanded:new Set(['perf-0'])}); host.getBoundingClientRect(); if(i>=5)times.push(performance.now()-start); }
   await new Promise(requestAnimationFrame); observer.disconnect(); times.sort((a,b)=>a-b);
   return {samples:times.length,p95_ms:times[Math.ceil(times.length*.95)-1],max_ms:Math.max(...times),long_tasks_over_100_ms:long.filter(x=>x>100),dom_rows:host.querySelectorAll('[data-work-row]').length,user_agent:navigator.userAgent,hardware_concurrency:navigator.hardwareConcurrency,setup_ms:performance.now()-seed};
 });
 console.log('WORK_PERFORMANCE '+JSON.stringify(result));
 assert.ok(result.p95_ms<100,`Work p95 ${result.p95_ms} ms`); assert.equal(result.long_tasks_over_100_ms.length,0,'no >100 ms main-thread task during the warm benchmark');
});

test('reviewed plan execution sends the exact immutable manifest; changing wording only requests a revision', async () => {
 const t=data.tickets[0], ref='a'.repeat(64), review={source_plan_run_id:'plan-1',source_plan_ref:ref,source_plan_revision:2,reviewed_context_fingerprint:'b'.repeat(64),reviewed_base_commit:'c'.repeat(40),current_context:{title:t.title},original_context:{title:t.title},context_changed:false,base_changed:false};
 data.handoffs=[{...data.handoffs[0],id:'plan-1',ticket_id:t.id,state:'done',intent:'plan',result_ref:null,plan_ref:ref,plan_revision:2}];
 await page.route('**/v1/handoffs/plan-1/plan-review',r=>r.fulfill({json:review})); await page.route('**/v1/content/'+ref+'*',r=>r.fulfill({body:'1. Inspect configuration.\n2. Apply bounded fix.\n3. Verify with tests.'}));
 const edits=await captureEdits(); await open('#view=runs&run=plan-1'); await page.locator('[data-action="review-plan"]').click(); await page.waitForSelector('[data-form="execute-plan"]');
 await page.locator('[name="reviewed"]').check(); let sent=page.waitForResponse(r=>r.url().endsWith('/v1/requests')); await page.locator('[data-form="execute-plan"] [type="submit"]').click(); await sent;
 for(const key of ['source_plan_run_id','source_plan_ref','source_plan_revision','reviewed_context_fingerprint','reviewed_base_commit']) assert.equal(edits[0].payload[key],review[key]);
 assert.equal(edits[0].payload.intent,'auto'); assert.equal(edits[0].payload.permissions.commit,false);
 await page.locator('[data-action="review-plan"]').click(); await page.getByText('Edit plan wording',{exact:true}).click(); await page.locator('[data-form="revise-plan"] textarea').fill('Owner revised exact plan');
 sent=page.waitForResponse(r=>r.url().endsWith('/v1/requests')); await page.locator('[data-form="revise-plan"] [type="submit"]').click(); await sent;
 assert.equal(edits[1].kind,'revise-run-plan'); assert.equal(edits[1].payload.expected_plan_revision,2); assert.equal(edits[1].payload.text,'Owner revised exact plan');
});

test('static export loads unified Work and old route aliases with no owner endpoint calls', async () => {
 const {buildStaticHtml}=await import('../../src/export/static.js'); const html=buildStaticHtml(data,{exportedAt:'2026-10-30T00:00:00Z'}); const calls=[];
 await page.route('**/snapshot-fixture',r=>r.fulfill({contentType:'text/html',body:html})); page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/v1/')) calls.push(r.url());});
 await page.goto(base+'/snapshot-fixture#view=tree'); await page.waitForSelector('.view-work');
 assert.equal(await page.locator('[data-view="updates"],[data-view="memory"]').count(),0); assert.equal(await page.locator('[data-check]').count(),0); assert.equal(await page.locator('[data-action="priority-select"]').count(),0); assert.deepEqual(calls,[]);
});

test('expanded hierarchy, four-mode composer and long-task Daily screenshots', async () => {
 const {ticket}=await import('./fixtures.js'); const root=ticket(1,{title:'Platform migration',next_action:'Confirm staging access, then validate production rollout',priority:'P1',work_rollup:{required_total:6,required_completed:4,required_remaining:2,closure_state:'not-ready',reasons:[{code:'required-blocked',text:'Staging verification needs credentials'}]}});
 const blocked=ticket(2,{title:'Staging verification',parent_id:root.id,blocks_parent:true,status:'blocked',priority:'P1',blocker:'Waiting for staging credentials',work_rollup:{required_total:2,required_completed:0,required_remaining:2}});
 data.tickets=[root,blocked,ticket(3,{title:'Production rollout',parent_id:root.id,blocks_parent:true}),...Array.from({length:4},(_,i)=>ticket(i+4,{title:['Upgrade runtime','Migrate schema','Backfill records','Validate data parity'][i],status:'done',parent_id:root.id,blocks_parent:true})),ticket(8,{title:'Validate staging access',parent_id:blocked.id,blocks_parent:true}),ticket(9,{title:'Run staging smoke checks',parent_id:blocked.id,blocks_parent:true}),ticket(10,{title:'Improve rollout checklist',parent_id:root.id,blocks_parent:false}),ticket(11,{title:'Document observability follow-up',parent_id:root.id,blocks_parent:false}),ticket(12,{title:'Classify rollback notes',parent_id:root.id,blocks_parent:null}),ticket(13,{title:'Retry reliability',status:'review',work_rollup:{required_total:0,closure_state:'ready'}})]; data.handoffs=[];
 await page.setViewportSize({width:1366,height:768}); await open('#view=work'); await page.locator(`[data-action="work-expand"][data-ticket="${root.id}"]`).click(); await page.locator(`[data-action="work-expand"][data-ticket="${blocked.id}"]`).click(); await page.screenshot({path:'/tmp/quill-control-hierarchy-1366.png'});
 await page.locator('.work-row [data-action="handoff"]').first().click(); await page.locator('[name="intent"][value="auto"]').check(); await page.locator('[name="instructions"]').fill('Verify staging access and fix the smoke-test configuration if needed.'); await page.screenshot({path:'/tmp/quill-control-composer-1366.png'});
 await page.setViewportSize({width:390,height:844}); await page.screenshot({path:'/tmp/quill-control-composer-390.png'}); await page.keyboard.press('Escape');
 const report={id:'long-task',revision:1,state:'ready',window_kind:'last-24-hours',timezone:'Asia/Kolkata',window_start:'2026-10-29T18:00:00+05:30',window_end:'2026-10-30T18:00:00+05:30',coverage:{state:'complete'},scope:{project_ids:[],repo_ids:[]},content:'# Daily update\n## Platform migration — continuing objective\nGoal: migrate the platform with verified parity and a reversible rollout. [ticket-1]\nObserved since: 2026-09-12 [ticket-1]\nBlocked: waiting for staging credentials [event-48]\nNext: confirm access, then run staging smoke checks [ticket-2]\n### Changed in this window\n- Data parity checks passed on the recorded migration commit · worker test gate [test-49]\n- Rollout checklist accepted as an independent follow-up · owner decision [event-51]\nRequired work remaining:\n- Staging verification · blocked\n- Production rollout · to do\n<details><summary>Earlier milestones and continuity</summary>\n- Schema migration and backfill completed; production rollout still requires verification. [event-32]\n</details>'};
 await page.route('**/v1/updates',r=>r.fulfill({json:{updates:[report],schedule:{fingerprint:'f'.repeat(64),enabled:false}}})); await page.route('**/v1/updates/long-task*',r=>r.fulfill({json:report}));
 data.meta.timezone='Asia/Kolkata'; data.generation_id+='-daily'; await page.setViewportSize({width:1366,height:768}); await open('#view=updates'); await refresh(); await page.waitForSelector('.daily-report'); await page.screenshot({path:'/tmp/quill-control-daily-1366.png'});
});

test('Auto push has a required destination branch and preserves it on polling', async () => {
 data.repos[0].provider_configured=true; delete data.repos[0].provider; const edits=await captureEdits(); await open('#view=work'); await page.locator('.work-row [data-action="handoff"]').first().click(); await page.locator('[name="instructions"]').fill('Implement and publish this bounded fix'); await page.locator('[name="intent"][value="auto"]').check(); await page.locator('[name="commit"]').check(); await page.locator('[name="push_branch"]').check();
 assert.equal(await page.locator('[name="branch"]').getAttribute('required'),''); await page.locator('[name="branch"]').fill('feat/scoped-delivery'); await page.locator('[name="open_draft_pr"]').check(); data.generation_id+='-poll'; await refresh(); assert.equal(await page.locator('[name="branch"]').inputValue(),'feat/scoped-delivery');
 const sent=page.waitForResponse(r=>r.url().endsWith('/v1/requests')); await page.locator('#dialog [type="submit"]').click(); await sent;
 assert.equal(edits[0].payload.branch,'feat/scoped-delivery'); assert.equal(edits[0].payload.permissions.open_draft_pr,true);
});

test('rejected and network-failed run submissions retain instructions, delivery and destination drafts', async () => {
 await page.route('**/v1/requests',r=>r.fulfill({status:409,json:{error:{code:'revision-conflict',message:'Ticket changed; review it before retrying'}}}));
 await open('#view=work'); await page.locator('.work-row [data-action="handoff"]').first().click(); await page.locator('[name="instructions"]').fill('Preserve my exact unsent task'); await page.locator('[name="intent"][value="auto"]').check(); await page.locator('[name="commit"]').check(); await page.locator('[name="push_branch"]').check(); await page.locator('[name="branch"]').fill('feat/preserve-draft');
 await page.locator('#dialog [type="submit"]').click(); await page.waitForSelector('[data-form-error]'); assert.equal(await page.locator('#dialog').evaluate(d=>d.open),true); assert.equal(await page.locator('[name="instructions"]').inputValue(),'Preserve my exact unsent task'); assert.equal(await page.locator('[name="branch"]').inputValue(),'feat/preserve-draft');
 await page.unroute('**/v1/requests'); await page.route('**/v1/requests',r=>r.abort('connectionfailed')); await page.locator('#dialog [type="submit"]').click(); await page.waitForFunction(()=>document.querySelector('[data-form-error]')?.textContent.includes('fetch')); assert.equal(await page.locator('[name="instructions"]').inputValue(),'Preserve my exact unsent task'); assert.equal(await page.locator('[name="branch"]').inputValue(),'feat/preserve-draft');
});

test('desktop detail keeps Work operable and closing a removed child returns focus to its parent', async () => {
 const parent=data.tickets[0],child=data.tickets[6]; child.blocks_parent=true; child.status='todo'; await open('#view=work'); await page.locator(`[data-action="work-expand"][data-ticket="${parent.id}"]`).click(); await page.locator(`#work-open-${child.id}`).click(); assert.equal(await page.locator('#main').evaluate(el=>el.inert),false);
 data.tickets=data.tickets.filter(t=>t.id!==child.id); data.generation_id+='-removed'; await refresh(); await page.keyboard.press('Escape'); assert.equal(await page.locator(`#work-open-${parent.id}`).evaluate(el=>el===document.activeElement),true);
});

test('an accepted run whose response is lost reuses its request identity after reconnect', async () => {
 const received=[]; await page.route('**/v1/requests',async r=>{const body=r.request().postDataJSON(); received.push(body); if(received.length===1) await r.abort('connectionfailed'); else await r.fulfill({json:{...body,state:'pending',not_before:'2099-01-01T00:00:00Z'}});});
 await open('#view=work'); await page.locator('.work-row [data-action="handoff"]').first().click(); await page.locator('[name="instructions"]').fill('Exactly one durable run'); await page.locator('#dialog [type="submit"]').click(); await page.waitForSelector('[data-form-error]');
 assert.match(await page.locator('[data-form-error]').textContent(),/not acknowledged.*status is unknown/);
 await refresh(); const response=page.waitForResponse(r=>r.url().endsWith('/v1/requests')); await page.locator('#dialog [type="submit"]').click(); await response;
 assert.equal(received.length,2); assert.equal(received[0].id,received[1].id); assert.deepEqual(received[0],received[1]);
});

test('a definitive rejection or edited task authorizes a fresh request identity', async () => {
 const received=[]; await page.route('**/v1/requests',async r=>{const body=r.request().postDataJSON();received.push(body);if(received.length===1) await r.fulfill({status:400,json:{error:{code:'invalid-task',message:'Definitively rejected'}}});else await r.abort('connectionfailed');});
 await open('#view=work'); await page.locator('.work-row [data-action="handoff"]').first().click(); await page.locator('[name="instructions"]').fill('Original wording'); await page.locator('#dialog [type="submit"]').click(); await page.waitForSelector('[data-form-error]');
 await page.locator('#dialog [type="submit"]').click(); await page.waitForFunction(()=>document.querySelector('[data-form-error]')?.textContent.includes('status is unknown')); assert.notEqual(received[0].id,received[1].id);
 await refresh(); await page.locator('[name="instructions"]').fill('Owner changed the requested task'); await page.locator('#dialog [type="submit"]').click(); await page.waitForFunction(()=>document.querySelector('#dialog [type="submit"]')?.disabled===false);
 assert.equal(received.length,3); assert.notEqual(received[1].id,received[2].id);
});

test('Escape and Cancel retain only the objective; accepted submission or view navigation clears it', async () => {
 const edits=await captureEdits(); await open('#view=work'); const trigger=page.locator('.work-row [data-action="handoff"]').first();
 await trigger.click(); const initial=await page.locator('[name="instructions"]').inputValue(); await page.locator('[name="instructions"]').fill('Keep this objective while I inspect the task'); await page.locator('[name="intent"][value="full"]').check(); assert.equal(await page.locator('[data-full-delivery-note]').isVisible(),true); assert.equal(await page.locator('[data-auto-delivery-note]').isVisible(),false); await page.locator('[name="commit"]').check(); await page.keyboard.press('Escape');
 await trigger.click(); assert.equal(await page.locator('[name="instructions"]').inputValue(),'Keep this objective while I inspect the task'); assert.equal(await page.locator('[name="intent"]:checked').inputValue(),'read-only'); assert.equal(await page.locator('[name="commit"]').isChecked(),false);
 await page.locator('.composer-footer [data-action="close-dialog"]').click(); await trigger.click(); assert.equal(await page.locator('[name="instructions"]').inputValue(),'Keep this objective while I inspect the task');
 const response=page.waitForResponse(r=>r.url().endsWith('/v1/requests')); await page.locator('#dialog [type="submit"]').click(); await response; await page.waitForFunction(()=>!document.getElementById('dialog').open); assert.equal(edits[0].payload.intent,'read-only');
 await trigger.click(); assert.equal(await page.locator('[name="instructions"]').inputValue(),initial); await page.locator('[name="instructions"]').fill('Draft cleared by navigation'); await page.keyboard.press('Escape'); await page.locator('#tab-runs').click(); await page.locator('#tab-work').click(); await trigger.click(); assert.equal(await page.locator('[name="instructions"]').inputValue(),initial);
});

test('unconfigured Daily schedule offers setup without enabling it and shows next run and latest result', async () => {
 data.schedules=[{name:'daily-update',job:'daily-update',enabled:false,last_outcome:'failed',last_finished_at:'2026-10-30T12:00:00Z',last_error:'Evidence input missing'}];
 await page.route('**/v1/updates',r=>r.fulfill({json:{updates:[],schedule:{configured:false,enabled:false,fingerprint:'f'.repeat(64)}}}));
 await open('#view=updates'); await page.locator('[data-action="configure-update-schedule"]').click(); assert.equal(await page.locator('[data-disclosure="update-schedule"]').evaluate(d=>d.open),true); assert.equal(await page.locator('[name="enabled"]').isChecked(),false); assert.equal(await page.locator('[name="enabled"]').evaluate(e=>e===document.activeElement),true);
 assert.match(await page.locator('[data-disclosure="update-schedule"]').textContent(),/Next run: Not scheduled/); assert.match(await page.locator('[data-disclosure="update-schedule"]').textContent(),/Latest result: failed/); assert.match(await page.locator('[data-disclosure="update-schedule"]').textContent(),/Evidence input missing/);
});
