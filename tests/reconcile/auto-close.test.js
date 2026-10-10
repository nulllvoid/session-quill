// ADR 0021: a merge closes every ticket whose work it carried, found through the branch the work
// landed on; deploy_on = "merge" makes the merge the deployment; done tickets keep fresh PR state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from '../../src/worker/worker.js';
import { makeEvent } from '../../src/core/events.js';
import { writeIngress } from '../../src/core/ingress.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig } from '../../src/config/config.js';
import { runReconciliation } from '../../src/reconcile/run.js';
import { derive } from '../../src/reconcile/derive.js';
import { createGithubProvider } from '../../src/reconcile/providers/github.js';
import { runHook } from '../../src/hooks/adapter.js';
import { writeRuntimeIdentity, writeBindingSnapshot } from '../../src/hooks/binding-snapshot.js';
import { listIngress } from '../../src/core/ingress.js';

const MACHINE = '22222222-2222-4222-8222-222222222222';
const PR = 'https://github.com/acme/demo/pull/21';
const tid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

function fixture({ deployOn = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-auto-'));
  const storePath = path.join(home, 'Quill');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  const repo = { project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: ['production'], provider: 'github', canonical_path: home, ...(deployOn ? { deploy_on: deployOn } : {}) };
  const config = { ...defaultUserConfig(), store_path: storePath, projects: { demo: { name: 'Demo', repo_id: 'demo' } }, repos: { demo: repo } };
  const env = { QUILL_HOME: home };
  let nowMs = Date.parse('2026-10-11T08:00:00Z');
  const iso = () => new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mk = (kind, payload, extra = {}) => makeEvent({ kind, payload, store_id: meta.store_id, machine_id: MACHINE, producer: 'test', occurred_at: iso(), ...extra });
  const w = new Worker({ config, storeMeta: meta, env, clock: () => nowMs, derive });
  return { env, w, mk, home };
}

// A ticket with one Edit on `branch`, as the hook now records it.
function ticketOnBranch(f, n, branch, { status = 'review' } = {}) {
  const id = tid(n);
  writeIngress(f.mk('ticket-create', { ticket: { id, key: `FEAT-${n}`, title: `Work ${n}`, project_id: 'demo', project_name: 'Demo', category: 'feature', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } }), f.env);
  writeIngress(f.mk('session-start', { source: 'startup' }, { session_id: `s${n}` }), f.env);
  writeIngress(f.mk('bind', { ticket_id: id, project_id: 'demo' }, { session_id: `s${n}` }), f.env);
  writeIngress(f.mk('pre-tool', { tool_name: 'Edit' }, { session_id: `s${n}`, tool_call_id: `t${n}`, source_identity: `pre:s${n}:t${n}` }), f.env);
  writeIngress(f.mk('post-tool', { tool_name: 'Edit', write_paths: [`src/f${n}.js`], repo_id: 'demo', success: true, branch }, { session_id: `s${n}`, tool_call_id: `t${n}`, source_identity: `post:s${n}:t${n}` }), f.env);
  f.w.tick();
  if (status) {
    writeIngress(f.mk('ticket-update', { ticket_id: id, fields: { status }, source: 'evidence' }), f.env);
    f.w.tick();
  }
  return id;
}

function providers({ byBranch = {}, byUrl = {} } = {}) {
  const calls = [];
  return {
    calls,
    for: () => ({
      name: 'github',
      fetchPr: async (url) => { calls.push(['fetch', url]); return byUrl[url]; },
      findPrs: async (branch, { cwd }) => { calls.push(['find', branch, cwd]); return byBranch[branch] ?? []; },
    }),
  };
}

const merged = { url: PR, state: 'merged', opened_at: '2026-10-10T20:00:00Z', merged_at: '2026-10-11T07:00:00Z', base_branch: 'main', head_branch: 'fix/polish' };

test('a merged PR found by branch closes every ticket that worked on it when deploy_on = "merge"', async () => {
  const f = fixture({ deployOn: 'merge' });
  await f.w.start();
  try {
    const a = ticketOnBranch(f, 3, 'fix/polish');
    const b = ticketOnBranch(f, 4, 'fix/polish', { status: 'active' });
    const other = ticketOnBranch(f, 5, 'feat/other');
    const onMain = ticketOnBranch(f, 6, 'main');
    assert.deepEqual(f.w.state.tickets.get(a).branches.map((x) => x.name), ['fix/polish']);
    const p = providers({ byBranch: { 'fix/polish': [merged] } });
    await runReconciliation(f.w, { providers: p });
    for (const id of [a, b]) {
      const t = f.w.state.tickets.get(id);
      assert.equal(t.status, 'done', `${t.key} closed by the merge`);
      assert.equal(t.prs[0].url, PR);
      assert.equal(t.deployments[0].state, 'deployed');
      assert.equal(t.deployments[0].evidence_kind, 'merge');
    }
    assert.equal(f.w.state.tickets.get(other).status, 'review');
    assert.equal(f.w.state.tickets.get(onMain).prs.length, 0);
    const finds = p.calls.filter((c) => c[0] === 'find');
    assert.deepEqual(finds.map((c) => c[1]).sort(), ['feat/other', 'fix/polish'], 'one lookup per branch; main is never looked up');
    assert.equal(finds[0][2], f.home, 'gh runs in the repository checkout');
    // A second run finds nothing new and changes nothing.
    await runReconciliation(f.w, { providers: p });
    assert.equal(f.w.state.tickets.get(a).prs.length, 1);
  } finally {
    await f.w.stop();
  }
});

test('without deploy_on, a merge found by branch moves tickets to deploy-pending as before', async () => {
  const f = fixture();
  await f.w.start();
  try {
    const a = ticketOnBranch(f, 3, 'fix/polish');
    await runReconciliation(f.w, { providers: providers({ byBranch: { 'fix/polish': [merged] } }) });
    const t = f.w.state.tickets.get(a);
    assert.equal(t.status, 'deploy-pending');
    assert.equal(t.deployments[0].state, 'pending');
  } finally {
    await f.w.stop();
  }
});

test('done tickets keep their status but their open PRs are refreshed', async () => {
  const f = fixture({ deployOn: 'merge' });
  await f.w.start();
  try {
    const a = ticketOnBranch(f, 3, 'fix/polish');
    await runReconciliation(f.w, { providers: providers({ byBranch: { 'fix/polish': [{ ...merged, state: 'open', merged_at: null }] } }) });
    writeIngress(f.mk('ticket-update', { ticket_id: a, fields: { status: 'done' }, source: 'manual' }), f.env);
    f.w.tick();
    assert.equal(f.w.state.tickets.get(a).prs[0].state, 'open');
    await runReconciliation(f.w, { providers: providers({ byUrl: { [PR]: { state: 'merged', merged_at: merged.merged_at, opened_at: merged.opened_at, base_branch: 'main', head_branch: 'fix/polish' } } }) });
    const t = f.w.state.tickets.get(a);
    assert.equal(t.prs[0].state, 'merged');
    assert.equal(t.status, 'done');
  } finally {
    await f.w.stop();
  }
});

test('gh pr list is asked for the branch in the checkout, and only matching GitHub PRs come back', async () => {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return JSON.stringify([
      { url: PR, state: 'MERGED', isDraft: false, createdAt: '2026-10-10T20:00:00Z', mergedAt: '2026-10-11T07:00:00Z', baseRefName: 'main', headRefName: 'fix/polish' },
      { url: 'https://github.com/acme/demo/pull/9', state: 'OPEN', headRefName: 'fix/polish-other' },
      { url: 'https://evil.example/pull/1', state: 'OPEN', headRefName: 'fix/polish' },
    ]);
  };
  const gh = createGithubProvider({ exec });
  const prs = await gh.findPrs('fix/polish', { cwd: 'C:/repo' });
  assert.deepEqual(prs.map((p) => [p.url, p.state]), [[PR, 'merged']]);
  assert.deepEqual(calls[0].args.slice(0, 7), ['pr', 'list', '--head', 'fix/polish', '--state', 'all', '--limit']);
  assert.equal(calls[0].opts.cwd, 'C:/repo');
  await assert.rejects(gh.findPrs('--upload-pack=x', { cwd: 'C:/repo' }), /unsupported branch name/);
});

test('the hook records the branch a write landed on, read from .git/HEAD', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-branch-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/fix/polish\n');
  const env = { QUILL_HOME: home };
  writeRuntimeIdentity({ store_id: '33333333-3333-4333-8333-333333333333', machine_id: MACHINE, store_path: path.join(home, 'Quill'), gate_enabled: true, gate_mode: 'nudge', approval_phrases_enabled: false, allow_tools: [] }, env);
  writeBindingSnapshot('s1', { ticket_id: tid(1), ticket_key: 'FEAT-1', binding_revision: 1, gate_enabled: true }, env);
  runHook('PostToolUse', { session_id: 's1', cwd: home, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'a.js'), old_string: 'a', new_string: 'b' }, tool_response: {}, tool_use_id: 'x1' }, { env, now: '2026-10-11T08:00:00Z' });
  const [ev] = listIngress(env).map((x) => x.event);
  assert.equal(ev.payload.branch, 'fix/polish');
});
