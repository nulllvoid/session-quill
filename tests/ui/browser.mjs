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
async function open(hash = '') { await page.goto(base + '/' + hash); await page.waitForSelector(`#main .view-${new URLSearchParams(hash.slice(1)).get('view') || 'picknext'}`); }
async function refresh() {
  const response = page.waitForResponse(r => r.url().endsWith('/v1/snapshot'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await response; await page.waitForTimeout(100);
}

test('Enter on a card action opens its dialog, not ticket detail', async () => {
  await open();
  await page.locator('.card [data-action="handoff"]').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#dialog').evaluate(el => el.open), true);
  assert.equal(await page.locator('#dialog [data-form="status"]').count(), 0, 'a run action must never open ticket resolution');
  assert.equal(await page.locator('#detail').isVisible(), false);
});

test('browser modifier shortcuts do not navigate the dashboard', async () => {
  await open(); await page.locator('#main').focus();
  await page.keyboard.press('Control+2');
  assert.match(page.url(), /view=picknext/);
});

test('status select can open natively with the mouse', async () => {
  await open(); await page.locator('.card').first().click();
  const select = page.locator('#detail [data-action="status-select"]');
  const prevented = await select.evaluate(el => !el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  assert.equal(prevented, false, 'native select click must not be cancelled');
});

test('next-action draft survives polling after focus leaves the textarea', async () => {
  await open(); await page.locator('.card').first().click();
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
  await open(); await page.locator('.card').first().click();
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
  await page.locator('.card').first().focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#detail').getAttribute('aria-modal'), 'true');
  assert.equal(await page.locator('#main').evaluate(el => el.inert), true);
  assert.equal(await page.locator('#detail').evaluate(el => el.scrollWidth <= el.clientWidth), true, JSON.stringify(await page.locator('#detail').evaluate(el => [...el.querySelectorAll('*')].filter(n => n.scrollWidth > n.clientWidth + 1 && n.clientWidth).map(n => [n.tagName, n.className, n.clientWidth, n.scrollWidth]))));
  await page.keyboard.press('Escape');
  await page.waitForSelector('#detail', { state: 'hidden' });
  await page.locator('.card [data-action="handoff"]').first().focus(); await page.keyboard.press('Space');
  assert.equal(await page.locator('#dialog').evaluate(el => el.open), true);
  assert.equal(await page.locator('#dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#dialog').evaluate(el => el.open), false);
});

test('closing a dialog returns focus to its own trigger after another action', async () => {
  await open();
  await page.locator('[data-action="help"]').click();
  await page.keyboard.press('Escape');
  const trigger = page.locator('.card [data-action="handoff"]').first();
  await trigger.click();
  await page.keyboard.press('Escape');
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
});

test('sidebar tabs support arrows, a single tab stop, and a labelled panel', async () => {
  await open();
  await page.locator('#tab-picknext').focus(); await page.keyboard.press('ArrowDown');
  assert.match(page.url(), /view=board/);
  assert.equal(await page.locator('#tab-board').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#sidebar [role="tab"]').evaluateAll(els => els.filter(el => el.tabIndex === 0).length), 1);
  assert.equal(await page.locator('#main').getAttribute('aria-labelledby'), 'tab-board');
  await page.keyboard.press('End'); assert.match(page.url(), /view=memory/);
  await page.keyboard.press('Home'); assert.match(page.url(), /view=picknext/);
});

test('touch controls meet the design system minimum on phones', async () => {
  await context.close();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await open();
  const short = await page.locator('.btn, #search').evaluateAll(els => els.filter(el => el.getClientRects().length && !el.closest('details:not([open]) .popover')).map(el => ({ label: el.getAttribute('aria-label') || el.textContent, height: el.getBoundingClientRect().height })).filter(el => el.height < 44));
  assert.deepEqual(short, []);
  await page.locator('.card').first().click();
  const detailShort = await page.locator('#detail .btn, #detail select, #detail .detail-tabs button').evaluateAll(els => els.filter(el => el.getClientRects().length).map(el => ({ label: el.getAttribute('aria-label') || el.textContent, height: el.getBoundingClientRect().height })).filter(el => el.height < 44));
  assert.deepEqual(detailShort, []);
});

test('long ticket headers do not cover the content while scrolling', async () => {
  data.tickets[0].title = 'Long title with important evidence '.repeat(30);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(); await page.locator('.card').first().click();
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
  await page.locator('#tab-picknext').focus(); await page.keyboard.press('End');
  assert.match(page.url(), /view=today/);
  await page.keyboard.press('ArrowRight'); assert.match(page.url(), /view=picknext/);
  await page.locator('[data-action="toggle-more"]').first().click();
  await page.locator('#more-sheet [data-view="sessions"]').click();
  assert.equal(await page.locator('.nav-more').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('#tab-picknext').evaluate(el => el === document.activeElement), true);
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
