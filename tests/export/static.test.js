import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { sanitizeSnapshot, previewExport, DEFAULT_FIELDS } from '../../src/export/sanitize.js';
import { buildStaticHtml, bundleUiModules } from '../../src/export/static.js';
import { snapshot, TID } from '../ui/fixtures.js';
import { makeHome, startWorker, cli, DESC } from '../cli/helpers.js';

function privateSnapshot() {
  const s = snapshot();
  s.sessions[0].cwd = 'C:\\Users\\shivam\\repo';
  s.tickets[0].summary = 'See /Users/shivam/secret/notes.md and C:\\Users\\shivam\\x.txt for details';
  s.tickets[0].timeline = [{ id: 't', at: '2026-10-02T11:00:00Z', kind: 'write', text: 'Edit C:\\Users\\shivam\\repo\\src\\a.js', event_id: 'e', content_ref: 'a'.repeat(64), coverage: 'complete' }];
  s.tickets[0].jira = { key: 'PMLA-42', url: 'https://jira.corp.example/browse/PMLA-42', validation: 'pending', validated_at: null, error: null };
  s.handoffs[0].worktree_path = '/home/shivam/.worktrees/h1';
  s.repos[0].canonical_path = 'C:\\Users\\shivam\\repo';
  s.repos[0].provider_config_ref = 'secret-ref';
  s.requests = [{ id: 'r', kind: 'refresh', state: 'pending' }];
  return s;
}

test('sanitizeSnapshot strips local paths, credentials, content refs, request state and mutation capabilities by default', () => {
  const out = sanitizeSnapshot(privateSnapshot(), { exportedAt: '2026-10-02T12:30:00Z' });
  const text = JSON.stringify(out);
  for (const needle of ['/Users/', 'C:\\\\Users', '/home/', 'shivam', 'secret-ref', 'content_ref', 'cwd', 'worktree_path', 'canonical_path', '"requests":[{']) {
    assert.equal(text.includes(needle), false, `export must not contain ${needle}`);
  }
  assert.deepEqual(out.capabilities, { read: true, edit_tickets: false, handoff: false, refresh: false, cancel_requests: false, export: false });
  assert.equal(out.meta.exported_at, '2026-10-02T12:30:00Z');
  assert.equal(out.meta.last_sync, '2026-10-02T09:30:00Z');
  assert.equal(out.meta.owner_machine_id, null);
  assert.deepEqual(out.requests, []);
  assert.deepEqual(out.checkpoints, []);
  assert.equal(out.tickets.find((t) => t.id === TID(5)).prs[0].url, undefined, 'PR links excluded by default');
  assert.equal(out.tickets.find((t) => t.id === TID(5)).prs[0].state, 'open', 'PR evidence state kept');
  assert.equal(out.tickets.find((t) => t.id === TID(1)).jira.url, undefined);
  assert.equal(out.tickets.find((t) => t.id === TID(1)).summary, undefined, 'summary is not a default field');
  assert.equal(out.sessions[0].last_checkpoint_preview, undefined);
  assert.ok(out.tickets.length > 0);
});

test('sanitizeSnapshot honours project and field selection, link and checkpoint opt-ins, and redacts absolute paths inside included text', () => {
  const s = privateSnapshot();
  const out = sanitizeSnapshot(s, { exportedAt: '2026-10-02T12:30:00Z', projects: ['demo'], fields: [...DEFAULT_FIELDS, 'summary', 'timeline'], includeLinks: true, includeCheckpoints: true });
  const t1 = out.tickets.find((t) => t.id === TID(1));
  assert.match(t1.summary, /\[path redacted\]/);
  assert.equal(t1.summary.includes('shivam'), false);
  assert.ok(t1.timeline.length);
  assert.equal(t1.timeline[0].content_ref, undefined);
  assert.match(t1.timeline[0].text, /\[path redacted\]/);
  assert.equal(out.tickets.find((t) => t.id === TID(5)).prs[0].url, 'https://github.com/acme/demo/pull/5');
  assert.equal(t1.jira.url, 'https://jira.corp.example/browse/PMLA-42');
  assert.equal(out.checkpoints.length, 2);
  assert.equal(out.checkpoints[0].content_ref, undefined);
  assert.ok(out.checkpoints.some((c) => c.preview === 'Checkpoint preview text'));
  const none = sanitizeSnapshot(s, { exportedAt: '2026-10-02T12:30:00Z', projects: ['other'] });
  assert.equal(none.tickets.length, 0);
});

test('previewExport reports exact fields, projects, counts and exclusions', () => {
  const p = previewExport(privateSnapshot(), { projects: 'demo', fields: 'key,title,status', include_links: '0', include_checkpoints: '0' });
  assert.deepEqual(p.fields, ['key', 'title', 'status']);
  assert.deepEqual(p.projects, ['demo']);
  assert.equal(p.ticket_count, 7);
  assert.ok(p.excluded.some((x) => /checkpoint/i.test(x)));
  assert.ok(p.excluded.some((x) => /link/i.test(x)));
  assert.ok(p.excluded.some((x) => /path/i.test(x)));
});

test('bundleUiModules concatenates the UI into one importless module that parses and stays inert without a DOM', () => {
  const bundle = bundleUiModules({ staticMode: true });
  assert.equal(/^import\s/m.test(bundle), false);
  assert.equal(/^export\s/m.test(bundle), false);
  assert.equal(bundle.includes('/v1/requests'), false);
  const ctx = vm.createContext({ console, globalThis: {}, crypto: globalThis.crypto, Intl, Date, Math, JSON, URLSearchParams });
  vm.runInContext(bundle, ctx, { filename: 'bundle.js' });
});

test('buildStaticHtml inlines CSS, snapshot and bundle, with no request endpoints, tokens or local store URIs', () => {
  const html = buildStaticHtml(privateSnapshot(), { exportedAt: '2026-10-02T12:30:00Z' });
  assert.match(html, /<style>/);
  assert.match(html, /window\.__SNAPSHOT__/);
  assert.match(html, /2026-10-02T12:30:00Z/);
  for (const needle of ['/v1/requests', 'st_owner', 'x-quill-csrf', '/auth?secret', 'quill://', 'C:\\\\Users', '/Users/', 'shivam', '<link rel="stylesheet"', 'src="/ui/']) {
    assert.equal(html.includes(needle), false, `static export must not contain ${needle}`);
  }
  assert.match(html, /LOCAL-ticket-1-abcdef01/);
  assert.equal(html.includes('</script>', html.indexOf('__SNAPSHOT__') + 1) >= 0, true);
  assert.equal(/<\/script>/i.test(JSON.stringify(privateSnapshot().tickets[0].title)), false);
});

test('CLI: quill ui --static writes a standalone file; quill export requires --yes and respects field selection', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const c = await cli(['ticket', 'create', '--description', DESC, 'Export me please', '--session', 'sess-X'], fx.env);
    const key = /((?:DEV|FEAT|FIX)-[0-9]+)/.exec(c.out)[1];
    const out = path.join(fx.home, 'snapshot.html');
    const r = await cli(['ui', '--static', out], fx.env);
    assert.equal(r.code, 0, r.err);
    const html = fs.readFileSync(out, 'utf8');
    assert.match(html, new RegExp(key));
    assert.equal(html.includes('/v1/'), false);
    const noYes = await cli(['export', '--out', path.join(fx.home, 'e.html'), '--fields', 'key,title'], fx.env);
    assert.notEqual(noYes.code, 0);
    assert.match(noYes.out + noYes.err, /preview/i);
    const yes = await cli(['export', '--out', path.join(fx.home, 'e.html'), '--fields', 'key,title', '--yes'], fx.env);
    assert.equal(yes.code, 0, yes.err);
    const e = fs.readFileSync(path.join(fx.home, 'e.html'), 'utf8');
    assert.match(e, new RegExp(key));
    const embedded = JSON.parse(/window\.__SNAPSHOT__ = (.*?);<\/script>/s.exec(e)[1]);
    const exported = embedded.tickets.find((t) => t.key === key);
    assert.equal(exported.title, 'Export me please');
    assert.equal(exported.next_action, undefined, 'unselected fields are absent from the embedded data');
    assert.deepEqual(embedded.export.fields, ['key', 'title']);
  } finally {
    await w.stop();
  }
});
