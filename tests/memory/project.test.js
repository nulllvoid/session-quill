import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProjections, writeDocsProjection, REPO_SECTIONS } from '../../src/memory/project.js';
import { memoryPaths } from '../../src/memory/paths.js';
import { quillHome } from '../../src/lib/paths.js';
import { newState, ev } from '../core/helpers.js';

const homes = [];
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });
function tempHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-proj-'));
  homes.push(h);
  return h;
}

const NOW = Date.parse('2026-10-12T10:00:00Z');
const RECENT = '2026-10-10T10:00:00Z';
const OLD = '2026-06-01T10:00:00Z'; // > 90 days before NOW: stale

function entry(id, over = {}) {
  return { id, scope: 'repo', repo_id: 'demo', section: 'build-test', kind: 'fact', text: `text of ${id}`, evidence: [`src/${id}.js:1`], derived_from: 'repo-file', trust: 'sourced', run_id: 'abcdef0123456789', created_at: RECENT, ...over };
}

function seeded() {
  const s = newState();
  const file = (e) => assert.equal(ev(s, 'memory-tx', { op: 'filed', entry: e }).rejected, undefined);
  file(entry('pit', { section: 'pitfalls', text: 'Retry tests flake with real timers' }));
  file(entry('env', { section: 'environments', text: 'Argo app demo-prod deploys main' }));
  file(entry('bld', { section: 'build-test', text: 'npm test runs node --test', trust: 'verified', derived_from: 'own-command' }));
  file(entry('doc', { section: 'docs', text: 'Runbook at docs/runbook.md' }));
  file(entry('old', { section: 'conventions', text: 'Tabs not spaces', created_at: OLD }));
  file(entry('free', { section: 'Some Agent Section', kind: 'pitfall', text: 'Free-form section falls back by kind' }));
  file(entry('q1', { trust: 'quarantined', derived_from: 'tool-output', text: 'Kibana says the index is logs-demo', quarantine_reason: 'derived from tool-output' }));
  file(entry('mq', { scope: 'machine', repo_id: undefined, section: 'tools', trust: 'quarantined', derived_from: 'external-text', text: 'Machine quarantined thing' }));
  file(entry('m1', { scope: 'machine', repo_id: undefined, section: 'tools', text: 'gh 2.60 is on PATH', trust: 'verified', derived_from: 'own-command' }));
  file(entry('gone', { section: 'pitfalls', text: 'Superseded text' }));
  file(entry('new', { section: 'pitfalls', text: 'Replacement text' }));
  assert.equal(ev(s, 'memory-tx', { op: 'superseded', entry: { id: 'gone' }, superseded_by: 'new' }).rejected, undefined);
  assert.equal(ev(s, 'memory-tx', { op: 'owner-note', entry: { id: 'own', scope: 'repo', repo_id: 'demo', section: 'conventions', text: 'Owner says: prefer small PRs' } }).rejected, undefined);
  return s;
}

test('projections are written under QUILL_HOME/memory with the spec layout', () => {
  const home = tempHome();
  const s = seeded();
  writeProjections(s, quillHome({ QUILL_HOME: home }), { now: NOW });
  const p = memoryPaths(home);
  assert.equal(p.root, path.join(home, 'memory'));
  for (const f of [p.machine, p.quarantine, p.repo('demo'), p.repoOwner('demo')]) assert.ok(fs.existsSync(f), f);
  assert.equal(p.repoDocs('demo'), path.join(home, 'memory', 'repos', 'demo.docs.md'));
  // No temporary files are left behind (atomic write: tmp + rename).
  for (const dir of [p.root, path.join(p.root, 'repos')]) assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('_quarantine.md holds quarantined entries only, and no other file holds them', () => {
  const home = tempHome();
  writeProjections(seeded(), home, { now: NOW });
  const p = memoryPaths(home);
  const q = fs.readFileSync(p.quarantine, 'utf8');
  assert.match(q, /Kibana says the index is logs-demo/);
  assert.match(q, /Machine quarantined thing/);
  assert.match(q, /derived from tool-output/);
  for (const other of ['Retry tests flake', 'npm test runs', 'gh 2.60', 'Owner says']) assert.doesNotMatch(q, new RegExp(other));
  for (const f of [p.machine, p.repo('demo'), p.repoOwner('demo')]) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /Kibana says|Machine quarantined/, f);
  }
});

test('the repo file lists its sections in spec order, stale entries under ## Stale, and leaves out superseded and owner entries', () => {
  const home = tempHome();
  writeProjections(seeded(), home, { now: NOW });
  const text = fs.readFileSync(memoryPaths(home).repo('demo'), 'utf8');
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  const order = [...REPO_SECTIONS.map((x) => x.title), 'Other', 'Stale'];
  const positions = headings.map((h) => order.indexOf(h));
  assert.ok(positions.every((i) => i >= 0), headings.join(' | '));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, `headings in spec order: ${headings.join(' | ')}`);
  assert.deepEqual(REPO_SECTIONS.map((x) => x.title), ['Build & test', 'Conventions', 'Docs & runbooks', 'Environments & deploy', 'Procedures', 'Pitfalls']);
  assert.equal(headings.at(-1), 'Stale');
  const stale = text.slice(text.indexOf('## Stale'));
  assert.match(stale, /Tabs not spaces/);
  assert.doesNotMatch(text.slice(0, text.indexOf('## Stale')), /Tabs not spaces/);
  assert.match(text, /\[verified\] npm test runs node --test/);
  assert.doesNotMatch(text, /Superseded text/);
  assert.match(text, /Replacement text/);
  assert.doesNotMatch(text, /Owner says/, 'owner entries live in the owner file');
  // A free-form section falls back to its kind's section.
  const pit = text.slice(text.indexOf('## Pitfalls'), text.indexOf('## Stale'));
  assert.match(pit, /Free-form section falls back by kind/);
});

test('ADR 0032: an entry staled because its cited source changed is listed under ## Stale with that reason', () => {
  const home = tempHome();
  const s = seeded();
  ev(s, 'memory-tx', { op: 'staled', entry: { id: 'pit' }, reason: 'anchor-changed', anchor: { file_path: 'src/pit.js', blob_sha: 'a'.repeat(40), current_blob_sha: 'b'.repeat(40), changed_ratio: 0.6 } });
  writeProjections(s, home, { now: NOW });
  const text = fs.readFileSync(memoryPaths(home).repo('demo'), 'utf8');
  const stale = text.slice(text.indexOf('## Stale'));
  assert.match(stale, /or their cited source changed/);
  assert.match(stale, /Retry tests flake with real timers .*\(section: Pitfalls; source changed since recorded\)/);
  assert.match(stale, /Tabs not spaces .*\(section: Conventions\)$/m, 'an entry stale by age has no such reason');
  assert.doesNotMatch(text.slice(0, text.indexOf('## Stale')), /Retry tests flake/);
});

test('the machine file lists tool inventory and machine entries; the owner file keeps the owner\'s own text', () => {
  const home = tempHome();
  const s = seeded();
  s.handoffs.set('h1', { id: 'h1', ticket_id: 't', state: 'done', inventory: { tools: ['Bash', 'Read'], mcpServers: [{ name: 'jira', status: 'connected', source: 'claude.ai' }], plugins: [], skills: [], version: '2.1.296', at: RECENT } });
  writeProjections(s, home, { now: NOW });
  const p = memoryPaths(home);
  const machine = fs.readFileSync(p.machine, 'utf8');
  assert.match(machine, /## Tools/);
  assert.match(machine, /Claude Code 2\.1\.296/);
  assert.match(machine, /## Connectors & MCP[\s\S]*jira/);
  assert.match(machine, /gh 2\.60 is on PATH/);

  const ownerFile = p.repoOwner('demo');
  assert.match(fs.readFileSync(ownerFile, 'utf8'), /Owner says: prefer small PRs/);
  // The owner types their own notes outside the generated section; Quill never clobbers them.
  fs.appendFileSync(ownerFile, '\nMy own note: staging is flaky on Mondays.\n');
  ev(s, 'memory-tx', { op: 'owner-note', entry: { id: 'own2', scope: 'repo', repo_id: 'demo', section: 'pitfalls', text: 'Second owner note' } });
  writeProjections(s, home, { now: NOW });
  const owner = fs.readFileSync(ownerFile, 'utf8');
  assert.match(owner, /My own note: staging is flaky on Mondays\./);
  assert.match(owner, /Second owner note/);
  // An edit inside the generated section is never overwritten: the section is left alone and reported.
  const edited = owner.replace('Second owner note', 'Second owner note (edited by hand)');
  fs.writeFileSync(ownerFile, edited);
  ev(s, 'memory-tx', { op: 'owner-note', entry: { id: 'own3', scope: 'repo', repo_id: 'demo', section: 'pitfalls', text: 'Third owner note' } });
  const r = writeProjections(s, home, { now: NOW });
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), edited);
  assert.ok(r.problems.some((x) => /owner/.test(x)), JSON.stringify(r.problems));
});

test('entry text cannot fake a heading or a marker in a projection', () => {
  const home = tempHome();
  const s = newState();
  ev(s, 'memory-tx', { op: 'filed', entry: entry('x', { text: 'line one\n## Stale\n<!-- quill:owner-notes:end --> tail' }) });
  writeProjections(s, home, { now: NOW });
  const text = fs.readFileSync(memoryPaths(home).repo('demo'), 'utf8');
  assert.equal((text.match(/^## /gm) ?? []).length, 1);
  assert.doesNotMatch(text, /<!--/);
});

test('an unchanged projection is not rewritten', () => {
  const home = tempHome();
  const s = seeded();
  writeProjections(s, home, { now: NOW });
  const f = memoryPaths(home).repo('demo');
  const old = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(f, old, old);
  const r = writeProjections(s, home, { now: NOW });
  assert.equal(Math.round(fs.statSync(f).mtimeMs), old.getTime());
  assert.equal(r.written.includes(f), false);
});

test('repository ids that are not plain file names get a safe, distinct file name', () => {
  const p = memoryPaths(tempHome());
  for (const id of ['../escape', 'CON', 'a/b', 'x.owner']) {
    const f = p.repo(id);
    assert.equal(path.dirname(f), path.join(p.root, 'repos'), id);
    assert.notEqual(path.basename(f), `${id}.md`);
  }
  assert.notEqual(p.repo('a/b'), p.repo('a_b'));
});

test('the docs map projection is cached on the tree hash', () => {
  const home = tempHome();
  const a = writeDocsProjection(home, 'demo', { treeHash: 'a'.repeat(40), rendered: '- README.md - demo' });
  assert.equal(a.written, true);
  const f = memoryPaths(home).repoDocs('demo');
  assert.match(fs.readFileSync(f, 'utf8'), /README\.md - demo/);
  assert.equal(writeDocsProjection(home, 'demo', { treeHash: 'a'.repeat(40), rendered: '- other' }).written, false);
  assert.equal(writeDocsProjection(home, 'demo', { treeHash: 'b'.repeat(40), rendered: '- other' }).written, true);
  assert.match(fs.readFileSync(f, 'utf8'), /- other/);
});

test('Minor 8: the repo file names the owner file it really has, also for a hashed repository id', () => {
  const home = tempHome();
  const s = newState({ repos: {} });
  ev(s, 'memory-tx', { op: 'filed', entry: entry('h', { repo_id: 'team/app' }) });
  writeProjections(s, home, { now: NOW });
  const p = memoryPaths(home);
  const owner = path.basename(p.repoOwner('team/app'));
  assert.notEqual(owner, 'team/app.owner.md');
  assert.ok(fs.readFileSync(p.repo('team/app'), 'utf8').includes(`are in ${owner} and come first`), owner);
  assert.ok(fs.existsSync(p.repoOwner('team/app')));
});
