import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizePublishers, destinationOf } from '../../src/publish/config.js';
import { rowsFor, renderRollup } from '../../src/publish/content.js';
import { publishMarkdown, publishHtml } from '../../src/publish/writers.js';
import { snapshot } from '../ui/fixtures.js';

test('[[publish]] entries are validated; field aliases map to export fields; planned kinds are skipped with a warning', () => {
  const store = 'C:/Quill';
  const { publishers, warnings } = normalizePublishers({ store_path: store, publish: [
    { name: 'team-artifact', kind: 'artifact', projects: ['pmla'], fields: ['key', 'title', 'status', 'next', 'pr', 'deployments', 'updated'] },
    { name: 'rollup', kind: 'markdown', on: ['reconcile'] },
    { name: 'copy', kind: 'html', path: 'C:/share/quill.html', include_links: true },
    { name: 'wiki', kind: 'confluence' },
    { name: 'nopath', kind: 'html' },
    { name: 'oddfield', kind: 'markdown', fields: ['key', 'secrets'] },
    { name: 'Bad Name', kind: 'markdown' },
    { name: 'rollup', kind: 'markdown' },
    { name: 'take-over', kind: 'artifact', url: 'https://claude.ai/artifact/abc123' },
    { name: 'evil-url', kind: 'artifact', url: 'https://evil.example/artifact/abc' },
  ] });
  assert.deepEqual(publishers.map((p) => p.name), ['team-artifact', 'rollup', 'copy', 'take-over']);
  const [art, roll, copy, take] = publishers;
  assert.deepEqual(art.fields, ['key', 'title', 'status', 'next', 'pr', 'deployments', 'updated']);
  assert.deepEqual([art.projects, art.include_links, art.after_reconcile, art.url], [['pmla'], false, false, null]);
  assert.equal(roll.path, path.resolve(store, 'rollups', 'rollup.md'));
  assert.equal(roll.after_reconcile, true);
  assert.deepEqual([copy.path, copy.include_links], [path.resolve('C:/share/quill.html'), true]);
  assert.equal(take.url, 'https://claude.ai/artifact/abc123');
  assert.equal(destinationOf(art), 'artifact:new');
  assert.equal(destinationOf(take), 'artifact:https://claude.ai/artifact/abc123');
  assert.equal(destinationOf(copy), `html:${path.resolve('C:/share/quill.html')}`);
  const text = warnings.join('\n');
  for (const re of [/wiki.*confluence.*later release/, /nopath.*needs path/, /oddfield.*unknown field "secrets"/, /lowercase/, /rollup.*duplicate/, /evil-url.*claude\.ai/]) assert.match(text, re);
});

test('publish rows come from the export sanitizer: configured fields and projects only, no links unless asked, no local paths', () => {
  const s = snapshot();
  s.tickets[0].next_action = 'Look at C:\\Users\\me\\secret\\notes.txt';
  s.tickets[0].environments = [{ environment: 'stage', state: 'done' }, { environment: 'prod', state: 'pending' }];
  const pub = { name: 'p', kind: 'markdown', fields: ['key', 'title', 'status', 'next', 'pr', 'deployments', 'updated'], projects: null, include_links: false };
  const rows = rowsFor(s, pub);
  assert.equal(rows.length, s.tickets.length);
  const r0 = rows.find((r) => r.key === s.tickets[0].key);
  assert.deepEqual(Object.keys(r0).sort(), ['deployments', 'key', 'next', 'pr', 'status', 'title', 'updated']);
  assert.match(r0.next, /\[path redacted\]/);
  assert.equal(r0.deployments, 'stage: done · prod: pending');
  const withPr = rows.find((r) => r.pr);
  assert.doesNotMatch(withPr.pr, /https?:/, 'links stay out unless include_links');
  assert.match(rowsFor(s, { ...pub, include_links: true }).find((r) => r.key === withPr.key).pr, /https:\/\/github\.com/);
  assert.equal(rowsFor(s, { ...pub, projects: ['nope'] }).length, 0);
});

test('the markdown roll-up groups rows by status, escapes table cells, and is written into its own marked section', () => {
  const rows = [{ key: 'PROJ-1', title: 'A | pipe', status: 'active', next: 'Do it' }, { key: 'PROJ-2', title: 'B', status: 'done', next: '' }];
  const md = renderRollup(rows, { title: 'Team roll-up', fields: ['key', 'title', 'status', 'next'], generatedAt: '2026-10-03T10:00:00Z' });
  assert.match(md, /^## Team roll-up$/m);
  assert.match(md, /^### Active \(1\)$/m);
  assert.match(md, /\| PROJ-1 \| A \\\| pipe \| Do it \|/);
  assert.ok(md.indexOf('Active') < md.indexOf('Done'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pub-'));
  const file = path.join(dir, 'rollups', 'team.md');
  const index = path.join(dir, 'index.json');
  const r = publishMarkdown({ name: 'team', path: file, title: 'Team roll-up', fields: ['key', 'title', 'status', 'next'] }, rows, { indexPath: index, now: '2026-10-03T10:00:00Z' });
  assert.equal(r.summary, '2 tickets written to team.md');
  fs.writeFileSync(file, `# Notes above\n\n${fs.readFileSync(file, 'utf8')}`);
  publishMarkdown({ name: 'team', path: file, title: 'Team roll-up', fields: ['key', 'title', 'status', 'next'] }, rows.slice(0, 1), { indexPath: index, now: '2026-10-03T11:00:00Z' });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# Notes above/);
  assert.match(text, /<!-- quill:publish:team:start -->/);
  assert.doesNotMatch(text, /PROJ-2/);
});

test('the html publisher writes the read-only standalone export to its path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pub-'));
  const out = path.join(dir, 'copy.html');
  const r = publishHtml({ name: 'copy', path: out, fields: ['key', 'title', 'status'], projects: null, include_links: false }, snapshot(), { now: '2026-10-03T10:00:00Z' });
  assert.equal(r.summary, `${snapshot().tickets.length} tickets copied to copy.html`);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /pull\/6/);
});
