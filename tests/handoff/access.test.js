import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validateHandoffRequest, ACCESS } from '../../src/handoff/permissions.js';
import { runtimeAccess, childEnvFor } from '../../src/handoff/runner.js';
import { normalizeRecipe } from '../../src/agents/recipes.js';
import { handoffRunDir } from '../../src/lib/paths.js';
import { NO_CREDENTIAL_PLACEHOLDER } from '../../src/handoff/cred-env.js';
import { bootWorker, makeRepo, until, T1 } from './helpers.js';

const NONE = { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false };

test('access is standard unless asked for, must be a known level, and never applies to file runs', () => {
  assert.equal(validateHandoffRequest({ mode: 'analyse', note: '', permissions: {} }, {}).access, 'standard', 'schedules and older requests stay standard');
  assert.equal(validateHandoffRequest({ mode: 'analyse', note: '', permissions: {}, access: 'settings' }, {}).access, 'settings');
  assert.equal(validateHandoffRequest({ mode: 'analyse', note: '', permissions: {}, access: 'full' }, {}).access, 'full');
  assert.throws(() => validateHandoffRequest({ mode: 'analyse', note: '', permissions: {}, access: 'root' }, {}), (e) => e.code === 'access-invalid');
  const files = normalizeRecipe({ name: 'file-task', source: 'builtin', text: '---\nname: file-task\ndescription: d\nmode: files\npermissions: { delete_files: true }\n---\nGo.' });
  assert.throws(() => validateHandoffRequest({ recipe: 'file-task', note: '', permissions: { delete_files: true }, access: 'settings' }, { recipe: files, attachedFileCount: 1 }), (e) => e.code === 'access-invalid');
});

test('settings access hands permissions to Claude Code but still gates side effects; full access lifts every check', () => {
  const read = runtimeAccess({ access: 'settings', mode: 'analyse', permissions: { read_source: true } });
  assert.equal(read.permissionMode, 'default', 'what the owner would be asked about is refused');
  assert.deepEqual(read.allowed, []);
  for (const t of ['Bash(git commit*)', 'Bash(git push*)', 'Bash(gh pr create*)', 'Bash(gh pr merge*)', 'Edit', 'Write']) assert.ok(read.disallowed.includes(t), t);
  const fix = runtimeAccess({ access: 'settings', mode: 'attempt-fix', permissions: { read_source: true, edit_source: true, commit: true, push_branch: true } });
  assert.equal(fix.permissionMode, 'acceptEdits');
  assert.ok(!fix.disallowed.includes('Edit') && !fix.disallowed.includes('Bash(git commit*)') && !fix.disallowed.includes('Bash(git push*)'));
  assert.ok(fix.disallowed.includes('Bash(git push --force*)') && fix.disallowed.includes('Bash(gh pr merge*)'), 'no force push or merge even when push is granted');
  const full = runtimeAccess({ access: 'full', mode: 'analyse', permissions: {} });
  assert.deepEqual([full.permissionMode, full.allowed, full.disallowed, full.keepCredentials], ['bypassPermissions', [], [], true]);
  assert.equal(childEnvFor({}, { GH_TOKEN: 't' }, {}, { keepCredentials: true }).GH_TOKEN, 't');
  assert.equal(childEnvFor({}, { GH_TOKEN: 't' }).GH_TOKEN, undefined);
});

test('through the worker: each access level reaches the runtime as its permission mode, and only full access keeps credentials', async () => {
  const repo = makeRepo();
  const capture = path.join(repo.dir, '..', `capture-${randomUUID()}.json`);
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_CAPTURE: capture, GH_TOKEN: 'secret-token' } });
  try {
    const t = b.ticket(T1, 'PROJ-7');
    const run = async (n, access) => {
      const rid = `55555555-0000-4000-8000-00000000000${n}`;
      b.request(rid, { target_id: T1, expected_revision: b.w.state.tickets.get(T1).revision, payload: { recipe: 'analyse', note: '', permissions: { ...NONE, read_source: true }, ...(access ? { access } : {}) } });
      b.w.tick();
      const hid = b.w.state.requests.get(rid).result.handoff_id;
      const h = await until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return ['done', 'failed'].includes(x.state) ? x : null; });
      const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
      return { h, seen, mode: seen.args[seen.args.indexOf('--permission-mode') + 1] };
    };
    void t;
    const std = await run(1, null);
    assert.deepEqual([std.h.access, std.mode, std.seen.args.includes('--allowedTools'), std.seen.gh_token], ['standard', 'dontAsk', true, false]);
    const mine = await run(2, 'settings');
    assert.deepEqual([mine.h.access, mine.mode, mine.seen.args.includes('--allowedTools'), mine.seen.gh_token], ['settings', 'default', false, false]);
    assert.match(mine.seen.prompt, /Access: the owner's Claude Code settings/);
    const full = await run(3, 'full');
    assert.deepEqual([full.h.access, full.mode, full.seen.args.includes('--disallowedTools'), full.seen.gh_token], ['full', 'bypassPermissions', false, true]);
    assert.match(full.seen.prompt, /Access: full\. No permission checks apply/);
  } finally { await b.w.stop(); }
});

test('dashboard: both dialogs offer access with Autonomous preselected, my settings under Advanced and full access marked; file runs offer none', async () => {
  const { renderRecipeRunDialog } = await import('../../ui/views/agents.js');
  const { renderRunAgentDialog } = await import('../../ui/views/run-dialog.js');
  const ticket = { id: T1, key: 'PROJ-1', title: 'T', status: 'active', repo_id: null, files_touched: [{ relative_path: 'C:/x/a.cjs' }], tags: [], timeline: [] };
  const snap = { tickets: [ticket], handoffs: [], recipes: [], capabilities: { read: true, handoff: true }, meta: { timezone: 'UTC' } };
  const analyse = { name: 'analyse', description: 'd', source: 'builtin', mode: 'analyse', permissions: { ...NONE, read_source: true }, timeout_min: 20, legacy: true };
  const dialog = renderRecipeRunDialog(analyse, ticket, snap);
  assert.match(dialog, /name="access" value="autonomous" checked/);
  assert.doesNotMatch(dialog, /value="settings" checked/);
  assert.match(dialog, /<details class="advanced access-advanced"><summary>[^<]*<\/summary>\s*<label><input type="radio" name="access" value="settings"> Use my Claude Code settings/);
  assert.match(dialog, /class="danger"><input type="radio" name="access" value="full">/);
  assert.match(renderRunAgentDialog(ticket, { ...snap, recipes: [analyse] }, { recipe: 'analyse' }), /name="access" value="autonomous" checked/);
  const files = { name: 'file-task', description: 'd', source: 'builtin', mode: 'files', permissions: { ...NONE, delete_files: true }, timeout_min: 10, legacy: false };
  assert.doesNotMatch(renderRecipeRunDialog(files, ticket, snap), /name="access"/);
});

test('autonomous is a known access level; write scopes need it; file runs never get it', () => {
  assert.deepEqual(ACCESS, ['standard', 'settings', 'autonomous', 'full']);
  const v = (extra, opts = {}) => validateHandoffRequest({ mode: 'analyse', note: '', permissions: {}, ...extra }, opts);
  assert.equal(v({ access: 'autonomous' }).access, 'autonomous');
  assert.equal('scopes' in v({ access: 'autonomous' }), false, 'no scopes, no field');
  assert.deepEqual(v({ access: 'autonomous', scopes: ['k8s.write:stg', 'jira.write', 'k8s.write:stg'] }).scopes, ['k8s.write:stg', 'jira.write']);
  for (const access of ['standard', 'settings', 'full', undefined]) {
    assert.throws(() => v({ access, scopes: ['jira.write'] }), (e) => e.code === 'scope-needs-autonomous', String(access));
  }
  assert.equal('scopes' in v({ access: 'standard', scopes: [] }), false, 'an empty list is no scope');
  for (const bad of [['Bad Scope'], ['x:'], [':t'], 'jira.write', [7], ['a'.repeat(80)], Array.from({ length: 21 }, (_, i) => `s${i}.write`)]) {
    assert.throws(() => v({ access: 'autonomous', scopes: bad }), (e) => e.code === 'scope-invalid', JSON.stringify(bad));
  }
  const files = normalizeRecipe({ name: 'file-task', source: 'builtin', text: '---\nname: file-task\ndescription: d\nmode: files\npermissions: { delete_files: true }\n---\nGo.' });
  assert.throws(() => validateHandoffRequest({ recipe: 'file-task', note: '', permissions: { delete_files: true }, access: 'autonomous' }, { recipe: files, attachedFileCount: 1 }), (e) => e.code === 'access-invalid');
});

test('a run may set its own turn and spend caps, within bounds', () => {
  const v = (extra) => validateHandoffRequest({ mode: 'analyse', note: '', permissions: {}, access: 'autonomous', ...extra }, {});
  const ok = v({ max_turns: 40, max_budget_usd: 2.5 });
  assert.deepEqual([ok.max_turns, ok.max_budget_usd], [40, 2.5]);
  assert.equal('max_turns' in v({}), false);
  for (const bad of [{ max_turns: 0 }, { max_turns: 1.5 }, { max_turns: 1001 }, { max_turns: '40' }, { max_budget_usd: 0 }, { max_budget_usd: -1 }, { max_budget_usd: 1001 }, { max_budget_usd: 'x' }]) {
    assert.throws(() => v(bad), (e) => e.code === 'budget-invalid', JSON.stringify(bad));
  }
});

test('autonomous runtime access: dontAsk, no static allow rules, prompts off, the guard decides; fan-out and recipe tool families narrow as before', () => {
  const a = runtimeAccess({ access: 'autonomous', mode: 'analyse', permissions: { read_source: true } });
  assert.deepEqual([a.permissionMode, a.allowed, a.permissionPrompts, a.guard, a.keepCredentials], ['dontAsk', [], 'none', 'enforce', false]);
  assert.ok(!a.disallowed.includes('Task'), 'a read-only analysis may fan out');
  assert.ok(!a.disallowed.includes('Bash') && !a.disallowed.includes('WebFetch'), 'the guard decides shell and web calls');
  const fix = runtimeAccess({ access: 'autonomous', mode: 'attempt-fix', permissions: { read_source: true, edit_source: true } });
  assert.ok(fix.disallowed.includes('Task') && fix.disallowed.includes('Agent'), 'a fix stays a single agent');
  assert.ok(!fix.disallowed.includes('Edit'), 'edits are decided by the guard');
  const narrowed = runtimeAccess({ access: 'autonomous', mode: 'analyse', permissions: { read_source: true }, tools: ['Read', 'Grep', 'Bash(git log:*)'] });
  for (const t of ['Glob', 'Edit', 'Write', 'WebFetch', 'PowerShell', 'Task', 'Agent']) assert.ok(narrowed.disallowed.includes(t), t);
  for (const t of ['Read', 'Grep', 'Bash']) assert.ok(!narrowed.disallowed.includes(t), t);
  assert.ok(!narrowed.disallowed.some((t) => t.startsWith('mcp__')), 'connectors are the guard\'s to decide (R8)');
});

const SERVERS = [{ name: 'claude_ai_Atlassian', status: 'connected', source: 'claudeai' }, { name: 'repo-db', status: 'connected', source: 'project' }];
const PROBE = 'GH_TOKEN,KUBECONFIG,QUILL_HANDOFF_ID,QUILL_HANDOFF_ACCESS,QUILL_HANDOFF_PERMISSIONS,QUILL_HANDOFF_SCOPES,QUILL_HANDOFF_GUARD,QUILL_HANDOFF_GRANT_SHA256,CLAUDE_CODE_DISABLE_AUTO_MEMORY,FAKE_OWNER_SECRET';

async function queueRun(b, n, payload) {
  const rid = `66666666-0000-4000-8000-00000000000${n}`;
  b.request(rid, { target_id: T1, expected_revision: b.w.state.tickets.get(T1).revision, payload });
  b.w.tick();
  const req = b.w.state.requests.get(rid);
  assert.equal(req.state, 'applied', JSON.stringify(req.error));
  return req.result.handoff_id;
}
const settle = (b, hid) => until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return ['done', 'failed', 'cancelled', 'timed-out'].includes(x.state) ? x : null; }, { timeoutMs: 15000 });

test('through the worker: an autonomous run gets its grant, run settings, context dir, guard env and redirected credentials', async () => {
  const repo = makeRepo();
  const capture = path.join(repo.dir, '..', `capture-${randomUUID()}.json`);
  const b = await bootWorker({ repo, runtimeAvailable: true, handoff: { trusted_mcp_servers: ['repo-db'] }, fakeEnv: { FAKE_CLAUDE_CAPTURE: capture, GH_TOKEN: 'fake-owner-token', KUBECONFIG: '/owner/kube/config', FAKE_OWNER_SECRET: 'x', FAKE_CLAUDE_ENV_PROBE: PROBE, FAKE_CLAUDE_MCP_SERVERS: JSON.stringify(SERVERS) } });
  try {
    b.ticket(T1, 'PROJ-7');
    const hid = await queueRun(b, 1, { recipe: 'analyse', note: '', permissions: { ...NONE, read_source: true }, access: 'autonomous' });
    assert.equal(b.w.state.handoffs.get(hid).deadline_ms, 30 * 60_000, 'deadline from budgetFor at queue time (R8): 30 min for autonomous');
    const h = await settle(b, hid);
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    const runDir = handoffRunDir(b.env, hid);
    const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
    const after = (flag) => seen.args[seen.args.indexOf(flag) + 1];
    assert.equal(after('--permission-mode'), 'dontAsk');
    assert.equal(after('--permission-prompts'), 'none');
    assert.equal(after('--settings'), path.join(runDir, 'run-settings.json'));
    assert.equal(after('--add-dir'), path.join(runDir, 'context'));
    assert.ok(!seen.args.includes('--allowedTools'), 'the static allow list is empty');
    assert.ok(!seen.args.includes('--bare'));
    // Run settings: the guard hook, fail closed, no allow rules.
    const hook = seen.settings.hooks.PreToolUse[0];
    assert.deepEqual(seen.settings.permissions.allow, []);
    assert.equal(hook.hooks[0].onFailure, 'block');
    assert.match(hook.hooks[0].args[0], /quill-guard\.js$/);
    // Grant: frozen, hashed into the env, roots from the run.
    const grant = JSON.parse(seen.grant_text);
    const wt = h.worktree_path;
    assert.equal(grant.access, 'autonomous');
    assert.deepEqual(grant.permissions, { ...NONE, read_source: true, edit_files: false, delete_files: false });
    for (const r of [wt, runDir, path.join(runDir, 'context')]) assert.ok(grant.readableRoots.includes(r), r);
    assert.ok(!grant.writableRoots.includes(wt), 'no edit_source: the checkout is not writable');
    assert.ok(grant.writableRoots.includes(runDir));
    for (const p of [path.join(wt, '.mcp.json'), path.join(wt, '.claude'), path.join(wt, '.git')]) assert.ok(grant.protectedPaths.includes(p), p);
    assert.deepEqual(grant.trustedMcpServers, ['repo-db']);
    assert.deepEqual([grant.scopes, grant.actionPins, grant.defaultBranch, grant.credentialSystems], [[], [], 'main', []]);
    const probe = seen.env_probe;
    assert.equal(probe.QUILL_HANDOFF_GRANT_SHA256, createHash('sha256').update(seen.grant_text).digest('hex'));
    assert.deepEqual([probe.QUILL_HANDOFF_ID, probe.QUILL_HANDOFF_ACCESS, probe.QUILL_HANDOFF_GUARD, probe.QUILL_HANDOFF_PERMISSIONS, probe.QUILL_HANDOFF_SCOPES, probe.CLAUDE_CODE_DISABLE_AUTO_MEMORY], [hid, 'autonomous', 'enforce', 'read_source', '', '1']);
    // Credentials: redirected, never the owner's.
    assert.equal(probe.GH_TOKEN, NO_CREDENTIAL_PLACEHOLDER);
    assert.equal(probe.KUBECONFIG, path.join(runDir, 'env', 'kubeconfig'));
    assert.equal(probe.FAKE_OWNER_SECRET, null, 'the generic secret-name pass ran');
    assert.match(seen.prompt, /Access: autonomous/);
    // The run records the credential report and the init inventory; nothing secret.
    assert.equal(h.cred_report.kubernetes, 'stub');
    assert.ok(Array.isArray(h.cred_report.residual));
    assert.deepEqual(h.inventory.mcpServers, SERVERS);
    assert.equal(h.inventory.version, '2.1.296');
    // The grant, settings, stubs and context go with the run; the ledger stays.
    for (const f of ['grant.json', 'run-settings.json', 'env', 'context', 'mcp-servers.json']) assert.equal(fs.existsSync(path.join(runDir, f)), false, f);
  } finally { await b.w.stop(); }
});

test('autonomous with edit_source: the checkout is writable and the test gate runs in the redirected environment', async () => {
  const repo = makeRepo();
  const capture = path.join(repo.dir, '..', `capture-${randomUUID()}.json`);
  const marker = path.join(repo.dir, '..', `gate-${randomUUID()}.txt`);
  const gate = `node -e "require('fs').writeFileSync(process.argv[1], String(process.env.GH_TOKEN))" "${marker.replace(/\\/g, '/')}"`;
  const b = await bootWorker({ repo, runtimeAvailable: true, repoExtra: { test_command: gate }, fakeEnv: { FAKE_CLAUDE_CAPTURE: capture, FAKE_CLAUDE_EDIT: 'src.js', GH_TOKEN: 'fake-owner-token' } });
  try {
    b.ticket(T1, 'PROJ-8');
    const hid = await queueRun(b, 2, { recipe: 'attempt-fix', note: '', permissions: { ...NONE, read_source: true, edit_source: true }, access: 'autonomous' });
    const h = await settle(b, hid);
    const grant = JSON.parse(JSON.parse(fs.readFileSync(capture, 'utf8')).grant_text);
    assert.ok(grant.writableRoots.includes(h.worktree_path));
    assert.equal(h.test_gate && h.test_gate.status, 'passed', JSON.stringify(h.test_gate ?? h.error));
    assert.equal(fs.readFileSync(marker, 'utf8'), NO_CREDENTIAL_PLACEHOLDER, 'the gate never sees the owner token');
  } finally { await b.w.stop(); }
});

test('autonomous dispatch refuses an old Claude Code with runtime-too-old before anything is spawned; standard still runs', async () => {
  const repo = makeRepo();
  const capture = path.join(repo.dir, '..', `capture-${randomUUID()}.json`);
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_CAPTURE: capture, FAKE_CLAUDE_VERSION: '2.1.200 (Claude Code)' } });
  try {
    b.ticket(T1, 'PROJ-9');
    const hid = await queueRun(b, 3, { recipe: 'analyse', note: '', permissions: { ...NONE, read_source: true }, access: 'autonomous' });
    const h = await settle(b, hid);
    assert.equal(h.state, 'failed');
    assert.equal(h.error.code, 'runtime-too-old');
    assert.match(h.error.message, /2\.1\.200/);
    assert.match(h.error.message, /standard/);
    assert.equal(fs.existsSync(capture), false, 'claude was never started for the run');
    assert.equal(h.worktree_path ?? null, null, 'no checkout was made');
    const std = await settle(b, await queueRun(b, 4, { recipe: 'analyse', note: '', permissions: { ...NONE, read_source: true }, access: 'standard' }));
    assert.equal(std.state, 'done', JSON.stringify(std.error));
  } finally { await b.w.stop(); }
});

test('an init event reporting an old runtime stops an autonomous run with runtime-too-old', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_INIT_VERSION: '2.1.100', FAKE_CLAUDE_SLEEP_MS: '4000' } });
  try {
    b.ticket(T1, 'PROJ-10');
    const h = await settle(b, await queueRun(b, 5, { recipe: 'analyse', note: '', permissions: { ...NONE, read_source: true }, access: 'autonomous' }));
    assert.deepEqual([h.state, h.error.code], ['failed', 'runtime-too-old']);
  } finally { await b.w.stop(); }
});

test('write scopes on a run resolve through the scope catalog at dispatch (Task 11)', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true, configExtra: { scopes: { 'k8s.write': { targets: { stg: { env: { KUBECONFIG: '/fake/rw' } } } } } } });
  try {
    b.ticket(T1, 'PROJ-11');
    const hid = await queueRun(b, 6, { recipe: 'analyse', note: '', permissions: { ...NONE, read_source: true }, access: 'autonomous', scopes: ['k8s.write:stg'] });
    assert.deepEqual(b.w.state.handoffs.get(hid).scopes, ['k8s.write:stg'], 'the record keeps the requested scopes');
    const h = await settle(b, hid);
    assert.equal(h.state, 'done', JSON.stringify(h.error));
  } finally { await b.w.stop(); }
});

// Fix round 1 (review I-1): the dialog shows the cap the run really gets, from the same function
// the CLI and the queued record use, for every access level.
test('recipe caps: the snapshot carries budgetFor minutes per access level, and the dialog and CLI show them', async () => {
  const { capMinutes } = await import('../../src/handoff/runner.js');
  const { renderRunAgentDialog } = await import('../../ui/views/run-dialog.js');
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true });
  try {
    const t = b.ticket(T1, 'PROJ-12');
    const recipes = b.w.snapshotOptions().recipes;
    const by = (n) => recipes.find((r) => r.name === n);
    for (const name of ['analyse', 'analyse-followups', 'attempt-fix']) {
      const r = by(name);
      assert.deepEqual([r.caps.autonomous, r.caps.standard, r.caps.settings, r.caps.full], [30, 20, 20, 20], name);
      assert.equal(r.caps.autonomous, capMinutes(r, b.config, 'autonomous'), `${name}: the CLI's number`);
    }
    assert.equal(by('standup').caps.autonomous, 5, 'a recipe that sets timeout_min keeps it on every level');
    const snap = { tickets: [{ ...t, status: 'active' }], handoffs: [], recipes, repos: [{ id: 'demo', project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: [] }], capabilities: { read: true, handoff: true }, meta: { timezone: 'UTC' } };
    for (const name of ['analyse', 'analyse-followups', 'attempt-fix']) {
      const html = renderRunAgentDialog(snap.tickets[0], snap, { recipe: name });
      assert.match(html, /Capped at <span class="run-cap" data-cap-standard="20" data-cap-settings="20" data-cap-autonomous="30" data-cap-full="20">30<\/span> minutes/, name);
    }
    assert.match(renderRunAgentDialog(snap.tickets[0], snap), /data-recipe="analyse"[^]*?· 30 min<\/span>/, 'the recipe card shows the default (autonomous) cap');
    // The queued record agrees.
    const hid = await queueRun(b, 7, { recipe: 'analyse-followups', note: '', permissions: { ...NONE, read_source: true }, access: 'standard' });
    assert.equal(b.w.state.handoffs.get(hid).deadline_ms, by('analyse-followups').caps.standard * 60_000);
    await settle(b, hid);
  } finally { await b.w.stop(); }
});

// Fix round 1 (review I-2): per-run inventory and credential reports stay on the records; the
// snapshot's handoff list carries neither, so it grows only by each run's own summary.
test('the snapshot strips inventory and cred_report from every run; meta.autonomy keeps only the latest', async () => {
  const { newState } = await import('../core/helpers.js');
  const { buildSnapshot } = await import('../../src/worker/projections.js');
  const { autonomyInfo } = await import('../../src/handoff/inventory.js');
  const bigInventory = { tools: Array.from({ length: 500 }, (_, i) => `mcp__server_${i}__tool_with_a_long_name`), mcpServers: Array.from({ length: 200 }, (_, i) => ({ name: `server-${i}`, status: 'connected', source: 'claudeai' })), plugins: [], skills: [], version: '2.1.296', counts: { tools: 500, mcpServers: 200, plugins: 0, skills: 0 }, at: '2026-10-02T08:00:00Z' };
  const sizeWith = (n) => {
    const state = newState();
    for (let i = 0; i < n; i += 1) state.handoffs.set(`h${i}`, { id: `h${i}`, ticket_id: 't', state: 'done', access: 'autonomous', requested_at: `2026-10-02T08:${String(i).padStart(2, '0')}:00Z`, inventory: bigInventory, cred_report: { kubernetes: 'stub', residual: ['x'.repeat(200)] } });
    const snap = buildSnapshot(state, { generation_id: 'g', generated_at: '2026-10-02T09:00:00Z', autonomy: autonomyInfo(state, {}) });
    for (const h of snap.handoffs) assert.ok(!('inventory' in h) && !('cred_report' in h));
    assert.equal(snap.meta.autonomy.inventory.mcpServers.length, 200, 'the latest inventory is still there once');
    return JSON.stringify(snap).length;
  };
  const one = sizeWith(1);
  const twenty = sizeWith(20);
  assert.ok(twenty - one < 19 * 400, `20 runs add ${twenty - one} bytes over 1; only the small per-run summaries`);
});
