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
      if (!file.startsWith('ui/') || file.includes('..')) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html');
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
