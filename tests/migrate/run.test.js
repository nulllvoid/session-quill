import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeHome, startWorker, cli } from '../cli/helpers.js';
import { Journal } from '../../src/core/journal.js';
import { journalPath } from '../../src/lib/paths.js';
import { listIngress } from '../../src/core/ingress.js';
import { backup, restoreBackup } from '../../src/migrate/backup.js';

const FIX = path.resolve('tests/fixtures/pmla');

function copyFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pmla-'));
  fs.cpSync(FIX, dir, { recursive: true });
  return dir;
}

test('dry run writes nothing and lists mapped and ambiguous records', async () => {
  const fx = makeHome();
  const src = copyFixtures();
  const before = JSON.stringify(fs.readdirSync(src, { recursive: true }).sort());
  const r = await cli(['migrate', '--source', src, '--profile', 'pmla', '--project', 'pmla', '--dry-run'], fx.env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /9 ticket/);
  assert.match(r.out, /2 ambiguous/);
  assert.match(r.out, /PMLA-107/);
  assert.match(r.out, /weird-status/);
  assert.match(r.out, /dry run: no files written/i);
  assert.equal(JSON.stringify(fs.readdirSync(src, { recursive: true }).sort()), before, 'source untouched');
  assert.equal(listIngress(fx.env).length, 0);
  assert.equal(fs.existsSync(path.join(fx.home, 'migrations')), false);
});

test('import creates replayable migration events once, preserves authored text and originals, backs up first; rollback restores and exports', async () => {
  const fx = makeHome();
  const src = copyFixtures();
  const w = await startWorker(fx);
  try {
    const first = await cli(['migrate', '--source', src, '--profile', 'pmla', '--project', 'pmla', '--backup', path.join(fx.home, 'backups'), '--yes'], fx.env);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /imported 9 ticket/);
    const manifestPath = /manifest: (.+\.json)/.exec(first.out)[1].trim();
    assert.ok(fs.existsSync(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.tickets.length, 9);
    assert.ok(fs.existsSync(manifest.backup.manifest));
    assert.ok(fs.readdirSync(path.join(fx.home, 'backups')).length >= 1);
    // originals preserved
    assert.ok(fs.existsSync(path.join(src, 'PMLA-101-open-active.md')));
    await new Promise((r) => setTimeout(r, 300));
    const list = await cli(['ticket', 'list', '--json'], fx.env);
    const tickets = JSON.parse(list.out);
    assert.equal(tickets.length, 9);
    const t101 = tickets.find((t) => t.key === 'PMLA-101');
    assert.equal(t101.status, 'active');
    assert.equal(t101.status_source, 'migration');
    assert.match(t101.summary, /Rotation keeps the owner cookie fresh/);
    assert.match(t101.user_notes, /Remember to update the runbook/);
    assert.equal(t101.next_action, 'Finish the key rotation unit tests');
    const t103 = tickets.find((t) => t.key === 'PMLA-103');
    assert.equal(t103.parent_id, t101.id);
    assert.equal(t103.prs.length, 1);
    const t104 = tickets.find((t) => t.key === 'PMLA-104');
    assert.equal(t104.status, 'deploy-pending');
    assert.equal(t104.deployments.length, 1);
    const t107 = tickets.find((t) => t.key === 'PMLA-107');
    assert.ok(t107.validation_issues.includes('missing-waiver-reason'));
    const t108 = tickets.find((t) => t.key === 'PMLA-108');
    assert.equal(t108.status, 'done');
    assert.equal(t108.deployments[0].state, 'waived');
    const weird = tickets.find((t) => t.title === 'Unknown status record');
    assert.ok(weird.validation_issues.includes('status-unknown'));
    // second run: idempotent
    const second = await cli(['migrate', '--source', src, '--profile', 'pmla', '--project', 'pmla', '--backup', path.join(fx.home, 'backups'), '--yes'], fx.env);
    assert.equal(second.code, 0, second.err);
    await new Promise((r) => setTimeout(r, 300));
    const j = new Journal(journalPath(fx.env));
    j.open();
    const migrationEvents = [...j.read()].filter((e) => e.kind === 'migration');
    j.close();
    const perPath = new Map();
    for (const e of migrationEvents) perPath.set(e.source_identity, (perPath.get(e.source_identity) ?? 0) + 1);
    assert.ok([...perPath.values()].every((n) => n === 1), 'each source identity journaled once');
    assert.equal(JSON.parse((await cli(['ticket', 'list', '--json'], fx.env)).out).length, 9);
    // rollback: delete a source note, then restore from the backup and export newer tracker events
    fs.unlinkSync(path.join(src, 'PMLA-102-open-todo.md'));
    const rb = await cli(['migrate', 'rollback', '--manifest', manifestPath, '--yes'], fx.env);
    assert.equal(rb.code, 0, rb.err);
    assert.ok(fs.existsSync(path.join(src, 'PMLA-102-open-todo.md')), 'source note restored from backup');
    const exportFile = /exported (\d+) newer tracker event\(s\) to (.+\.jsonl)/.exec(rb.out);
    assert.ok(exportFile, rb.out);
    assert.ok(fs.existsSync(exportFile[2].trim()));
  } finally {
    await w.stop();
  }
});

test('backup copies files and directories into a dated folder with a manifest and restores them', () => {
  const src = copyFixtures();
  const extra = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-bk-')), 'settings.json');
  fs.writeFileSync(extra, '{"hooks":{}}');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'st-bkdest-'));
  const manifest = backup({ paths: [src, extra, path.join(os.tmpdir(), 'does-not-exist-xyz.json')], dest, label: 'test' });
  assert.equal(manifest.entries.length, 2);
  assert.ok(fs.existsSync(manifest.manifest));
  fs.unlinkSync(extra);
  fs.rmSync(src, { recursive: true, force: true });
  const restored = restoreBackup(manifest.manifest);
  assert.equal(restored.length, 2);
  assert.ok(fs.existsSync(extra));
  assert.ok(fs.existsSync(path.join(src, 'PMLA-101-open-active.md')));
});
