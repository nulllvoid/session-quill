import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeHome, startWorker, cli } from '../cli/helpers.js';
import { loadProfile, mapRecord } from '../../src/migrate/pmla.js';
import { inventory } from '../../src/migrate/inventory.js';

function note(fm, body = '## Summary\nText') {
  return `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;
}

function writeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-legacy-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const profile = loadProfile('pmla');

function duplicateTree() {
  return writeTree({
    'ABC-12.md': note({ title: 'Canonical work', status: 'open', jira: 'ABC-12', last_activity: '2026-09-01T08:00:00Z' }),
    'ABC-12-pr7.md': note({ title: 'PR seven follow-up', status: 'blocked', blocker: 'waiting on review', jira: 'ABC-12', last_activity: '2026-09-20T08:00:00Z' }),
    'ABC-12-stage.md': note({ title: 'Stage rollout', status: 'open', jira: 'ABC-12', last_activity: '2026-09-10T08:00:00Z' }),
    'XYZ-1-a.md': note({ title: 'Older', status: 'open', jira: 'XYZ-1', last_activity: '2026-08-01T08:00:00Z' }),
    'XYZ-1-b.md': note({ title: 'Newer', status: 'open', jira: 'XYZ-1', last_activity: '2026-09-01T08:00:00Z' }),
  });
}

test('issue #2: inventory picks the note named after the key, else the newest, and turns the rest into children with derived keys', () => {
  const inv = inventory(duplicateTree(), profile, { project_id: 'demo' });
  const byKey = Object.fromEntries(inv.tickets.map((t) => [t.mapped.key, t]));
  assert.equal(inv.tickets.length, 5, 'nothing is dropped');
  assert.equal(byKey['ABC-12'].rel, 'ABC-12.md', 'the canonical note wins even though ABC-12-pr7.md sorts first');
  assert.equal(byKey['ABC-12'].mapped.title, 'Canonical work');
  const children = ['ABC-12.1', 'ABC-12.2'].map((k) => byKey[k]);
  assert.deepEqual(children.map((c) => c.mapped.parent_key), ['ABC-12', 'ABC-12']);
  assert.deepEqual(children.map((c) => c.rel).sort(), ['ABC-12-pr7.md', 'ABC-12-stage.md']);
  assert.ok(children.every((c) => c.mapped.jira === null), 'only the winner keeps the tracker link');
  assert.equal(byKey['XYZ-1'].rel, 'XYZ-1-b.md', 'without a canonical name the newest note wins');
  assert.equal(byKey['XYZ-1.1'].rel, 'XYZ-1-a.md');
  assert.deepEqual(inv.duplicates.map((d) => d.key).sort(), ['ABC-12', 'XYZ-1']);
  assert.equal(inv.counts.duplicates, 2);
});

test('issue #2: the dry run lists duplicate keys as ambiguous', async () => {
  const fx = makeHome();
  const r = await cli(['migrate', '--source', duplicateTree(), '--project', 'demo', '--dry-run'], fx.env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /duplicate-key: ABC-12 <- ABC-12\.md \(kept\), ABC-12-pr7\.md, ABC-12-stage\.md/);
  assert.match(r.out, /2 duplicate key/);
});

test('issue #2: the import summary counts only applied events, lists rejected ones and exits non-zero', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const existing = writeTree({ 'DUP-1.md': note({ title: 'Already here', status: 'open', jira: 'DUP-1' }) });
    assert.equal((await cli(['migrate', '--source', existing, '--project', 'demo', '--yes'], fx.env)).code, 0);
    const src = writeTree({
      'DUP-1-copy.md': note({ title: 'Same key, other file', status: 'open', jira: 'DUP-1' }),
      'NEW-1.md': note({ title: 'Fresh', status: 'open', jira: 'NEW-1' }),
    });
    const r = await cli(['migrate', '--source', src, '--project', 'demo', '--yes'], fx.env);
    assert.notEqual(r.code, 0, 'a rejected note makes the run fail');
    assert.match(r.out, /imported 1 ticket\(s\), rejected 1/);
    assert.match(r.out, /DUP-1-copy\.md \(DUP-1\): (key-collision|ticket-exists)/);
    const dup = await cli(['migrate', '--source', duplicateTree(), '--project', 'demo', '--yes'], fx.env);
    assert.equal(dup.code, 0, dup.out + dup.err);
    assert.match(dup.out, /imported 5 ticket\(s\)/);
    const rows = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out);
    const parent = rows.find((t) => t.key === 'ABC-12');
    assert.equal(rows.find((t) => t.key === 'ABC-12.1').parent_id, parent.id);
  } finally {
    await w.stop();
  }
});

test('issue #3: profile fields accept candidate names, so key/next/pri map like jira/next_action/priority', () => {
  const custom = { ...profile, fields: { ...profile.fields, jira: ['jira', 'key'], next_action: ['next_action', 'next'], priority: ['priority', 'pri'] } };
  const m = mapRecord({ frontmatter: { title: 'Legacy', status: 'open', key: 'ABC-7', next: 'Ship it', pri: 'P1' } }, custom);
  assert.equal(m.jira_key, 'ABC-7');
  assert.equal(m.next_action, 'Ship it');
  assert.equal(m.priority, 'P1');
  const first = mapRecord({ frontmatter: { title: 'Both', status: 'open', jira: 'ABC-8', key: 'ABC-9' } }, custom);
  assert.equal(first.jira_key, 'ABC-8', 'the first candidate that is present wins');
});

test('issue #3: the bundled profile reads the common legacy names and maps progress to active', () => {
  const m = mapRecord({ frontmatter: { title: 'Legacy', status: 'progress', key: 'ABC-7', next: 'Ship it', pri: 'P1' } }, profile);
  assert.deepEqual([m.jira_key, m.next_action, m.priority, m.status], ['ABC-7', 'Ship it', 'P1', 'active']);
});

test('issue #3: a repo field maps to registered repositories, and unmatched values are reported', () => {
  const dir = writeTree({
    'AA-1.md': note({ title: 'One', status: 'open', jira: 'AA-1', repo: 'Payments API' }),
    'AA-2.md': note({ title: 'Two', status: 'open', jira: 'AA-2', repo: 'mystery' }),
    'AA-3.md': note({ title: 'Three', status: 'open', jira: 'AA-3', repo: 'mystery' }),
  });
  const inv = inventory(dir, profile, { project_id: 'demo', repos: { 'payments-api': {} } });
  const byKey = Object.fromEntries(inv.tickets.map((t) => [t.mapped.key, t]));
  assert.equal(byKey['AA-1'].mapped.repo_id, 'payments-api');
  assert.equal(byKey['AA-2'].mapped.repo_id, null);
  assert.deepEqual(inv.unregistered_repos, [{ value: 'mystery', count: 2 }]);
});

test('issue #3: ignore_globs skips templates by default, and the dry run warns when no tracker keys were found', async () => {
  const dir = writeTree({
    'templates/ticket.md': note({ title: '{{title}}', status: 'open' }),
    'notes/one.md': note({ title: 'One', status: 'open', ticket: 'ABC-1' }),
    'notes/two.md': note({ title: 'Two', status: 'open', ticket: 'ABC-2' }),
  });
  const inv = inventory(dir, profile, { project_id: 'demo' });
  assert.equal(inv.tickets.length, 2);
  assert.ok(inv.ignored.some((f) => /templates[\\/]ticket\.md$/.test(f)));
  assert.equal(inventory(dir, { ...profile, ignore_globs: [] }, { project_id: 'demo' }).tickets.length, 3);
  const fx = makeHome();
  const r = await cli(['migrate', '--source', dir, '--project', 'demo', '--dry-run'], fx.env);
  assert.match(r.out, /no tracker keys found in 2 notes/);
});

test('issue #3: the repository mapping reaches imported tickets', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const src = writeTree({ 'RR-1.md': note({ title: 'Mapped', status: 'open', jira: 'RR-1', repo: 'demo' }) });
    const r = await cli(['migrate', '--source', src, '--project', 'demo', '--yes'], fx.env);
    assert.equal(r.code, 0, r.out + r.err);
    const t = JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out).find((x) => x.key === 'RR-1');
    assert.equal(t.repo_id, 'demo');
  } finally {
    await w.stop();
  }
});

test('issue #3: migrate usage documents --profile <path.json>', async () => {
  const fx = makeHome();
  const r = await cli(['migrate'], fx.env);
  assert.match(r.err, /--profile <name\|path\.json>/);
  const help = await cli(['help'], fx.env);
  assert.match(help.out, /--profile <name\|path\.json>/);
});
