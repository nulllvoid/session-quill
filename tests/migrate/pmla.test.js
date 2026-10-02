import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadProfile, mapRecord } from '../../src/migrate/pmla.js';
import { inventory, parseSourceNote } from '../../src/migrate/inventory.js';

const FIX = path.resolve('tests/fixtures/pmla');
const profile = loadProfile('pmla');

test('loadProfile reads the bundled PMLA profile with field and status maps', () => {
  assert.equal(profile.name, 'pmla');
  assert.equal(profile.fields.status, 'status');
  assert.equal(profile.status_map.pr_raised, 'review');
});

test('parseSourceNote extracts frontmatter and authored sections, falling back to the body as summary', () => {
  const a = parseSourceNote(path.join(FIX, 'PMLA-101-open-active.md'));
  assert.equal(a.frontmatter.title, 'Rotate IPC secret per execution session');
  assert.equal(a.frontmatter.in_progress, true);
  assert.match(a.authored.summary, /Rotation keeps the owner cookie fresh/);
  assert.match(a.authored.notes, /Remember to update the runbook/);
  assert.equal(a.hasTimeline, true);
  const b = parseSourceNote(path.join(FIX, 'PMLA-102-open-todo.md'));
  assert.match(b.authored.summary, /Just a body with no sections/);
  assert.equal(b.hasTimeline, false);
  const c = parseSourceNote(path.join(FIX, 'README.md'));
  assert.equal(c.frontmatter, null);
});

test('mapRecord: PMLA status mapping table', () => {
  const m = (fm, extra = {}) => mapRecord({ frontmatter: fm, hasTimeline: false, ...extra }, profile);
  assert.equal(m({ status: 'open', in_progress: true }).status, 'active');
  assert.equal(m({ status: 'open' }, { hasTimeline: true }).status, 'active');
  assert.equal(m({ status: 'open' }).status, 'todo');
  assert.equal(m({ status: 'pr_raised', pr: 'https://bitbucket.org/x/y/pull-requests/1' }).status, 'review');
  assert.equal(m({ status: 'pr_raised', pr: 'https://bitbucket.org/x/y/pull-requests/1' }).prs[0].state, 'open');
  const merged = m({ status: 'merged', pr: 'https://bitbucket.org/x/y/pull-requests/2', merged_at: '2026-09-28T12:00:00Z' });
  assert.equal(merged.status, 'deploy-pending');
  assert.equal(merged.prs[0].state, 'merged');
  assert.equal(merged.deployments.length, 1);
  assert.equal(merged.deployments[0].state, 'pending');
  const deployed = m({ status: 'deployed', pr: 'https://bitbucket.org/x/y/pull-requests/3', merged_at: '2026-09-20T12:00:00Z', deployed_at: '2026-09-21T09:00:00Z' });
  assert.equal(deployed.status, 'done');
  assert.equal(deployed.deployments[0].state, 'deployed');
  const stale = m({ status: 'stale', last_activity: '2026-08-01T00:00:00Z' });
  assert.equal(stale.status, 'active');
  assert.equal(stale.last_activity, '2026-08-01T00:00:00Z');
  const skipped = m({ status: 'merged', pr: 'https://bitbucket.org/x/y/pull-requests/4', merged_at: '2026-09-10T12:00:00Z', deploy_skipped: true });
  assert.equal(skipped.deployments[0].state, 'pending', 'no reason: stays pending for review');
  assert.ok(skipped.issues.includes('missing-waiver-reason'));
  const waived = m({ status: 'merged', pr: 'https://bitbucket.org/x/y/pull-requests/5', merged_at: '2026-09-11T12:00:00Z', deploy_skipped: true, deploy_skip_reason: 'Superseded' });
  assert.equal(waived.deployments[0].state, 'waived');
  assert.equal(waived.deployments[0].waiver_reason, 'Superseded');
  assert.equal(waived.status, 'done', 'all obligations waived maps to done');
  const unknown = m({ status: 'parked' });
  assert.equal(unknown.status, 'todo');
  assert.ok(unknown.issues.includes('status-unknown'));
  const blocked = m({ status: 'blocked' });
  assert.ok(blocked.issues.includes('blocker-missing'));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocker, 'Blocker text missing in source (review required)');
  assert.equal(m({ status: 'open', priority: 'P9', category: 'weird' }).priority, 'P2');
  assert.equal(m({ status: 'open', priority: 'P9', category: 'weird' }).category, 'research');
});

test('inventory lists every source note, flags ambiguous records and ignores non-ticket files', () => {
  const inv = inventory(FIX, profile, { project_id: 'pmla' });
  assert.equal(inv.tickets.length, 9);
  assert.equal(inv.ignored.length, 1);
  assert.match(inv.ignored[0], /README\.md$/);
  const ambiguous = inv.ambiguous.map((a) => path.basename(a.path)).sort();
  assert.deepEqual(ambiguous, ['PMLA-107-skipped.md', 'weird-status.md']);
  const byKey = Object.fromEntries(inv.tickets.map((t) => [t.mapped.key, t]));
  assert.equal(byKey['PMLA-103'].mapped.parent_key, 'PMLA-101');
  assert.equal(byKey['PMLA-101'].mapped.status, 'active');
  assert.equal(byKey['PMLA-106'].mapped.status, 'active');
  assert.ok(inv.counts.by_status.active >= 2);
  assert.equal(inv.counts.total, 9);
  assert.equal(inv.counts.ambiguous, 2);
  assert.ok(byKey['PMLA-101'].mapped.id);
  assert.equal(byKey['PMLA-101'].mapped.id, inventory(FIX, profile, { project_id: 'pmla' }).tickets.find((t) => t.mapped.key === 'PMLA-101').mapped.id, 'ids are deterministic from the source path');
});
