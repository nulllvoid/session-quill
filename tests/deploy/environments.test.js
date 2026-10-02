import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTracker } from '../../src/core/external-keys.js';
import { effectiveEnvironments, environmentStatus, EVIDENCE_KINDS } from '../../src/deploy/environments.js';
import { scenario, T1 } from '../acceptance/scenario.js';
import { runReconciliation } from '../../src/reconcile/run.js';
import { Journal } from '../../src/core/journal.js';
import { journalPath } from '../../src/lib/paths.js';
import { Worker } from '../../src/worker/worker.js';
import { validateRequestBody } from '../../src/server/requests.js';

test('[tracker].environments are validated: lowercase names, no duplicates, at most ten; empty by default', () => {
  assert.deepEqual(normalizeTracker({ environments: ['stage', 'prod'] }).environments, ['stage', 'prod']);
  assert.deepEqual(normalizeTracker({}).environments, []);
  for (const bad of [['Prod'], ['a b'], ['stage', 'stage'], Array.from({ length: 11 }, (_, i) => `e${i}`), 'prod']) {
    assert.throws(() => normalizeTracker({ environments: bad }), (e) => e.code === 'config-invalid' && /tracker\.environments/.test(e.message), JSON.stringify(bad));
  }
});

test('a repository\'s own deployment_environments win, then the tracker\'s, then production', () => {
  assert.deepEqual(effectiveEnvironments({ deployment_environments: ['qa'] }, { environments: ['stage'] }), ['qa']);
  assert.deepEqual(effectiveEnvironments({}, { environments: ['stage', 'prod'] }), ['stage', 'prod']);
  assert.deepEqual(effectiveEnvironments({ deployment_environments: [] }, null), ['production']);
  assert.deepEqual(effectiveEnvironments(null, null), ['production']);
});

test('per-environment status: pending wins, then done with its latest evidence, then n/a when every obligation was waived', () => {
  const d = (environment, state, extra = {}) => ({ id: `${environment}-${state}-${extra.pr_id ?? 'p1'}`, pr_id: 'p1', environment, state, merged_at: '2026-10-01T12:00:00Z', deployed_at: null, evidence: null, evidence_kind: null, waiver_reason: null, ...extra });
  const ticket = { deployments: [
    d('stage', 'deployed', { deployed_at: '2026-10-02T09:00:00Z', evidence: 'values tag v1', evidence_kind: 'tag' }),
    d('stage', 'pending', { pr_id: 'p2' }),
    d('prod', 'deployed', { deployed_at: '2026-10-02T10:00:00Z', evidence: 'argo sync 41', evidence_kind: 'argocd' }),
    d('prod', 'deployed', { pr_id: 'p0', deployed_at: '2026-10-01T10:00:00Z', evidence: 'older', evidence_kind: 'manual' }),
    d('dr', 'waived', { waiver_reason: 'not applicable: no DR target' }),
    d('legacy', 'pending'),
  ] };
  const status = environmentStatus(ticket, ['stage', 'prod', 'dr', 'qa']);
  assert.deepEqual(status.map((s) => [s.environment, s.state, s.pending]), [['stage', 'pending', 1], ['prod', 'done', 0], ['dr', 'n-a', 0], ['qa', 'none', 0], ['legacy', 'pending', 1]]);
  const prod = status.find((s) => s.environment === 'prod');
  assert.deepEqual([prod.deployed_at, prod.evidence, prod.evidence_kind], ['2026-10-02T10:00:00Z', 'argo sync 41', 'argocd']);
  assert.equal(status.find((s) => s.environment === 'dr').waiver_reason, 'not applicable: no DR target');
  assert.deepEqual(EVIDENCE_KINDS, ['merge', 'tag', 'argocd', 'release', 'manual', 'agent']);
});

test('merge evidence creates one obligation per tracker environment, journals the list, and replays the same after the config changes', async () => {
  const merged = { state: 'merged', opened_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-01T12:00:00Z' };
  const providers = { for: () => ({ name: 'github', fetchPr: async () => merged }) };
  const s = scenario({ providers, repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', provider: 'github' } } });
  s.config.tracker = { system: 'jira', domain: 'https://example.atlassian.net', environments: ['stage', 'prod'] };
  await s.start();
  try {
    s.ticket(T1, 'PROJ-1');
    s.bind('pr1', T1);
    s.ingest('pre-tool', { tool_name: 'Bash' }, { session_id: 'pr1', tool_call_id: 'g1', source_identity: 'pre:pr1:g1' });
    s.ingest('post-tool', { tool_name: 'Bash', write_paths: [], repo_id: 'demo', success: true, pr: { url: 'https://github.com/acme/demo/pull/1', provider: 'github', state: 'open' } }, { session_id: 'pr1', tool_call_id: 'g1', source_identity: 'post:pr1:g1' });
    s.w.tick();
    await runReconciliation(s.w, { providers });
    const t = s.w.state.tickets.get(T1);
    assert.deepEqual(t.deployments.map((d) => d.environment), ['stage', 'prod']);
    const snap = s.w.publishGeneration();
    assert.deepEqual(snap.tickets.find((x) => x.id === T1).environments.map((e) => [e.environment, e.state]), [['stage', 'pending'], ['prod', 'pending']]);
    const j = new Journal(journalPath(s.env));
    j.open();
    const rec = [...j.read()].filter((e) => e.kind === 'reconcile').map((e) => e.payload.pr_updates).flat().find((u) => u.state === 'merged');
    j.close();
    assert.deepEqual(rec.environments, ['stage', 'prod']);
    await s.stop();
    const replayed = new Worker({ config: { ...s.config, tracker: { system: 'jira', domain: 'https://example.atlassian.net', environments: ['production'] } }, storeMeta: s.meta, env: s.env, clock: s.clock });
    await replayed.start();
    assert.deepEqual(replayed.state.tickets.get(T1).deployments.map((d) => d.environment), ['stage', 'prod']);
    await replayed.stop();
  } finally { if (s.w.running) await s.stop(); }
});

test('recording a deployment takes an evidence kind; unknown kinds are refused', async () => {
  const s = await scenario({ repos: { demo: { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['stage', 'prod'], provider: 'github' } } }).start();
  try {
    s.ticket(T1, 'PROJ-1');
    const t = s.w.state.tickets.get(T1);
    t.deployments.push({ id: 'd1', pr_id: 'p1', environment: 'stage', state: 'pending', merged_at: '2026-10-01T12:00:00Z', deployed_at: null, evidence: null, waiver_reason: null, source_event_id: null });
    const body = (kind) => ({ id: '44444444-0000-4000-8000-000000000001', kind: 'record-deployment', target_id: T1, expected_revision: t.revision, payload: { items: [{ pr_id: 'p1', environment: 'stage', deployed_at: '2026-10-02T09:00:00Z', evidence: 'stage values v1.4', evidence_kind: kind }] } });
    assert.equal(validateRequestBody(body('tag'), s.w.state, s.iso()).payload.items[0].evidence_kind, 'tag');
    assert.equal(validateRequestBody(body(undefined), s.w.state, s.iso()).payload.items[0].evidence_kind, 'manual');
    assert.throws(() => validateRequestBody(body('telepathy'), s.w.state, s.iso()), (e) => e.code === 'request-invalid' && /evidence_kind/.test(e.message));
  } finally { await s.stop(); }
});
