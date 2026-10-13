// Run agent dialog (spec §5): pick a recipe, then permissions with a plain summary and blockers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../../ui/components.js';
import { renderRunAgentDialog } from '../../ui/views/run-dialog.js';
import { runSummary, runBlockers } from '../../ui/views/agents.js';
import { snapshot, ticket } from './fixtures.js';

const recipes = [
  { name: 'analyse', source: 'builtin', mode: 'analyse', description: 'Summarise', permissions: { read_source: true }, timeout_min: 20, legacy: true, repo_id: null },
  { name: 'attempt-fix', source: 'builtin', mode: 'attempt-fix', description: 'Fix it', permissions: { read_source: true, edit_source: true, commit: true, push_branch: true, open_draft_pr: true }, timeout_min: 20, legacy: true, repo_id: null },
  { name: 'standup', source: 'repo', mode: 'analyse', description: 'Standup <b>', permissions: {}, timeout_min: 10, legacy: false, repo_id: 'demo', outputs: ['comment-draft'] },
];
const REPO = { id: 'demo', project_id: 'demo', display_name: 'demo', default_branch: 'main', deployment_environments: [] };
const snap = (extra = {}) => normalizeSnapshot({ ...snapshot(), recipes, repos: [{ ...REPO, test_command: 'npm test' }], ...extra });

test('step 1 shows a card per recipe with what it may do', () => {
  const s = snap();
  const html = renderRunAgentDialog(s.tickets[0], s, { recipe: null });
  assert.match(html, /data-action="run-agent-pick" data-ticket="[^"]+" data-recipe="analyse"/);
  const card = (name) => new RegExp(`data-recipe="${name}"[^]*?</button>`).exec(html)[0];
  assert.match(card('attempt-fix'), /<span class="chip small warning">Edits source<\/span>/);
  assert.match(card('analyse'), /<span class="chip small">Reads source<\/span>/);
  assert.match(card('standup'), /<span class="chip small">Notes only<\/span>/);
  assert.doesNotMatch(html, /Reads only/);
  assert.match(html, /Standup &lt;b&gt;/);
  const tidy = { name: 'tidy', source: 'personal', mode: 'files', description: 'Tidy', permissions: { edit_files: true }, timeout_min: 10, legacy: false, repo_id: null };
  const withFiles = snap({ recipes: [...recipes, tidy] });
  const files = renderRunAgentDialog({ ...withFiles.tickets[0], files_touched: ['C:/notes/a.txt'] }, withFiles, { recipe: null });
  assert.match(/data-recipe="tidy"[\s\S]*?<\/button>/.exec(files)[0], /<span class="chip small warning">Changes files<\/span>/);
  assert.doesNotMatch(html, /<form/);
});

test('step 2 is the recipe form with Advanced side effects, a summary and a Back button', () => {
  const s = snap();
  const html = renderRunAgentDialog(s.tickets[0], s, { recipe: 'attempt-fix', retryOf: 'run-9' });
  assert.match(html, /<form class="handoff-form" data-form="recipe-run"[^>]*data-recipe="attempt-fix"[^>]*data-retry-of="run-9"/);
  assert.match(html, /<details class="advanced"><summary>Advanced: commit, push, PR<\/summary>[\s\S]*name="commit"/);
  assert.match(html, /<p class="run-summary"[^>]*>Edits in an isolated checkout · tests: npm test run by the worker · no commit, push or PR · applies its next action and follow-ups directly<\/p>/);
  assert.match(html, /data-action="run-agent-back"/);
});

test('Advanced options say what they require and start disabled until their parent is ticked', () => {
  const html = renderRunAgentDialog(snap().tickets[0], snap(), { recipe: 'attempt-fix' });
  assert.match(html, /<input type="checkbox" name="commit"> Commit locally <span class="muted small">\(requires edit source\)<\/span>/);
  assert.match(html, /<input type="checkbox" name="push_branch" disabled> Push a branch <span class="muted small">\(requires commit; never a default or protected branch\)<\/span>/);
  assert.match(html, /<input type="checkbox" name="open_draft_pr" disabled> Open a draft PR <span class="muted small">\(requires push branch\)<\/span>/);
  const withProvider = snap({ repos: [{ ...REPO, test_command: 'npm test', provider: 'github' }] });
  assert.match(renderRunAgentDialog(withProvider.tickets[0], withProvider, { recipe: 'attempt-fix' }), /name="open_draft_pr" disabled>/, 'PR stays disabled until Push is ticked, even with a provider');
});

test('runSummary says what the run will do', () => {
  const [analyse, fix, standup] = recipes;
  assert.equal(runSummary(analyse, { read_source: true }, REPO), 'Reads source · applies its next action and follow-ups directly');
  assert.equal(runSummary(fix, { read_source: true, edit_source: true, commit: true, push_branch: true }, { ...REPO, test_command: 'npm test' }), 'Edits in an isolated checkout · tests: npm test run by the worker · commits, pushes a branch · applies its next action and follow-ups directly');
  assert.equal(runSummary(fix, { edit_source: true }, REPO), 'Edits in an isolated checkout · not test-verified (no test command) · no commit, push or PR · applies its next action and follow-ups directly');
  assert.equal(runSummary(standup, {}, REPO), 'Notes only · result needs your acceptance');
});

test('blockers disable Queue; warnings do not', () => {
  const t = ticket(1);
  const busy = snap({ handoffs: [{ id: 'h', ticket_id: t.id, state: 'running', permissions: {} }] });
  assert.deepEqual(runBlockers(t, busy, recipes[0]).map((b) => b.level), ['blocker']);
  const html = renderRunAgentDialog(t, busy, { recipe: 'analyse' });
  assert.match(html, /<button type="submit" class="btn primary" disabled/);
  assert.match(html, /already queued or running/);
  const noRepo = snap({ repos: [] });
  assert.equal(runBlockers({ ...t, repo_id: null }, noRepo, recipes[1])[0].level, 'blocker');
  assert.equal(runBlockers({ ...t, repo_id: null }, noRepo, recipes[0])[0].level, 'warning');
  const noTests = snap({ repos: [REPO] });
  assert.match(runBlockers(t, noTests, recipes[1]).map((b) => b.text).join(' '), /Not test-verified/);
  assert.match(renderRunAgentDialog(t, noTests, { recipe: 'attempt-fix' }), /<button type="submit" class="btn primary">Queue run/);
});

// Autonomous access (spec §3, §8; ADR 0026). The dialog shows what the worker last recorded:
// meta.autonomy carries the latest init inventory and the latest autonomous run's credential report.
const FULL_NOTE = 'No Quill guard; prod writes allowed; your Claude Code deny rules still apply.';
const STUBS = { kubernetes: 'stub', aws: 'stub', gcp: 'stub', azure: 'stub', databases: 'stub', argo: 'stub', git: 'stub', netrc: 'stub', registries: 'stub', residual: [] };
const autonomy = (over = {}) => ({ inventory: null, credentials: null, readonly_configured: [], trusted_mcp_servers: [], min_runtime: '2.1.295', ...over });
const withMeta = (a) => snap({ meta: { ...snapshot().meta, autonomy: a } });
const dialogFor = (s, recipe = 'analyse') => renderRunAgentDialog(s.tickets[0], s, { recipe });

test('access: Autonomous is checked, my settings sit under Advanced, Full access carries its note', () => {
  const html = dialogFor(withMeta(autonomy()));
  assert.match(html, /<input type="radio" name="access" value="autonomous" checked> Autonomous/);
  assert.match(html, /<details class="advanced access-advanced"><summary>[^<]+<\/summary>\s*<label><input type="radio" name="access" value="settings"> Use my Claude Code settings/);
  assert.match(html, /<label class="danger"><input type="radio" name="access" value="full"> Full access <span class="small access-note">([^<]*)<\/span><\/label>/);
  assert.equal(/<span class="small access-note">([^<]*)<\/span>/.exec(html)[1], FULL_NOTE);
  assert.match(html, /value="standard"> Standard/);
});

test('connected tools come from the latest inventory: source and status, needs-auth unavailable, project servers not trusted', () => {
  const inventory = { run_id: 'abcdef12-0000-4000-8000-000000000000', at: '2026-10-02T11:00:00Z', version: '2.1.296', tools: [], plugins: [], skills: [], mcpServers: [
    { name: 'claude_ai_Atlassian', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai' },
    { name: 'repo<db>', status: 'connected', source: 'project' },
    { name: 'trusted-db', status: 'connected', source: 'project' },
    { name: 'mine', status: 'failed', source: 'user' },
  ] };
  const html = dialogFor(withMeta(autonomy({ inventory, trusted_mcp_servers: ['trusted-db'] })));
  const row = (name) => new RegExp(`<li[^>]*><strong>${name}</strong>[^]*?</li>`).exec(html)?.[0] ?? '';
  assert.match(html, /Connected tools this run can use/);
  assert.match(row('claude_ai_Atlassian'), /claude\.ai connector/);
  assert.match(row('claude_ai_Atlassian'), /Connected/);
  assert.match(row('claude\.ai Gmail'), /Unavailable \(needs auth\)/);
  assert.match(row('repo&lt;db&gt;'), /Not trusted for autonomous runs/);
  assert.doesNotMatch(html, /repo<db>/, 'server names are escaped');
  assert.doesNotMatch(row('trusted-db'), /Not trusted/, 'listed in [handoff] trusted_mcp_servers');
  assert.match(row('mine'), /Unavailable \(failed\)/);
  assert.match(html, /run abcdef12/);
  const none = dialogFor(withMeta(autonomy()));
  assert.match(none, /Connected tools: not known yet/);
});

test('fresh machine (Review Focus 5): "No read-only credentials configured" is a warning, never a blocker', () => {
  for (const a of [autonomy(), autonomy({ credentials: { report: STUBS, run_id: 'r1', at: '2026-10-02T10:00:00Z' } })]) {
    const html = dialogFor(withMeta(a));
    assert.match(html, /<li data-level="warning">[^<]*<svg[^]*?No read-only credentials configured/);
    assert.match(html, /<button type="submit" class="btn primary">Queue run/, 'Queue stays enabled');
  }
  const ro = dialogFor(withMeta(autonomy({ credentials: { report: { ...STUBS, kubernetes: 'readonly' }, run_id: 'r1', at: '2026-10-02T10:00:00Z' } })));
  assert.doesNotMatch(ro, /No read-only credentials configured/);
  assert.match(ro, /Kubernetes \(kubectl\): read-only profile/);
  assert.match(ro, /AWS \(aws\): no read-only profile/);
  const configured = dialogFor(withMeta(autonomy({ readonly_configured: ['kubernetes'] })));
  assert.doesNotMatch(configured, /No read-only credentials configured/);
  assert.match(configured, /Kubernetes \(kubectl\): read-only profile configured; checked when a run starts/);
  // An older worker or a snapshot without meta.autonomy: nothing is claimed either way.
  const unknown = dialogFor(snap());
  assert.doesNotMatch(unknown, /read-only credentials|Connected tools/);
});

test('residual credentials, scope errors and a shared cloud provider are shown, escaped', () => {
  const report = { ...STUBS, aws: 'owner', provider: 'shared', residual: ['ssh: ssh, scp and rsync run directly still read the keys in ~/.ssh <x>'], scope_errors: ['k8s.write: KUBE_X is <not> this scope\'s to set; ignored'] };
  const html = dialogFor(withMeta(autonomy({ credentials: { report, run_id: 'r1', at: '2026-10-02T10:00:00Z' } })));
  assert.match(html, /Bedrock or Vertex/);
  assert.match(html, /the agent can use those provider credentials too/);
  assert.match(html, /still read the keys in ~\/\.ssh &lt;x&gt;/);
  assert.match(html, /KUBE_X is &lt;not&gt; this scope&#39;s to set; ignored|KUBE_X is &lt;not&gt; this scope's to set; ignored/);
  assert.doesNotMatch(html, /<x>|<not>/);
});

test('the bulk dialog offers the same access choice', async () => {
  const { renderBulkHandoffForm } = await import('../../ui/views/bulk.js');
  const s = withMeta(autonomy());
  const html = renderBulkHandoffForm(s, [s.tickets[0].id], { mode: 'analyse' });
  assert.match(html, /name="access" value="autonomous" checked/);
  assert.match(html, /No read-only credentials configured/);
});

// Fix round 1 (review M-3, M-4, M-5).
test('my settings checked: the Advanced details renders open so the checked radio stays visible', async () => {
  const { accessFieldset } = await import('../../ui/components.js');
  const html = accessFieldset(null, { access: 'settings' });
  assert.match(html, /<details class="advanced access-advanced" open>/);
  assert.match(html, /value="settings" checked/);
  assert.doesNotMatch(html, /value="autonomous" checked/);
  assert.match(accessFieldset(null), /<details class="advanced access-advanced">/, 'closed by default');
  assert.match(accessFieldset(null, { access: 'bogus' }), /value="autonomous" checked/);
});

test('the Full access note is not dimmed (essential text)', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../../ui/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.access label\.danger \.access-note \{ opacity: 1; \}/);
});

test('a configured read-only profile the latest run could not use is a warning', () => {
  const html = dialogFor(withMeta(autonomy({ readonly_configured: ['kubernetes'], credentials: { report: STUBS, run_id: 'abcdef1234', at: '2026-10-02T10:00:00Z' } })));
  assert.match(html, /<li data-level="warning">[^<]*<svg[^]*?Read-only profile configured but not used by run abcdef12: Kubernetes \(kubectl\)/);
  assert.doesNotMatch(html, /No read-only credentials configured/);
  const used = dialogFor(withMeta(autonomy({ readonly_configured: ['kubernetes'], credentials: { report: { ...STUBS, kubernetes: 'readonly' }, run_id: 'r1', at: 'x' } })));
  assert.doesNotMatch(used, /configured but not used/);
});

test('record text that names an object property is shown as text', () => {
  const inventory = { run_id: 'r1', at: 'x', mcpServers: [{ name: 'odd', status: 'connected', source: '__proto__' }, { name: 'odd2', status: 'connected', source: 'constructor' }] };
  const html = dialogFor(withMeta(autonomy({ inventory, credentials: { report: { ...STUBS, aws: '__proto__' }, run_id: 'r1', at: 'x' } })));
  assert.doesNotMatch(html, /\[object Object\]|function Object/);
  assert.match(html, /__proto__ configuration/);
  assert.match(html, /AWS \(aws\): no read-only profile/);
});

test('bulk requests default to autonomous access', async () => {
  const { bulkRequests } = await import('../../ui/lib/bulk.js');
  const [body] = bulkRequests([{ ticket: { id: 't1', revision: 1, repo_id: 'demo' }, state: 'ready' }], { mode: 'analyse', batchId: 'b1' });
  assert.equal(body.payload.access, 'autonomous');
});

// Write scopes (spec §8, Task 11): Advanced → one checkbox per catalog entry, with what it permits
// and which credentials it switches to; a target field where the scope takes one; off unless the
// access is Autonomous; the form submits ["k8s.write:stg", …].
const SCOPES = [
  { name: 'jira.write', label: 'Jira: change issues', permits: 'Create and transition <issues>', switches: 'No credentials change: your connected Atlassian tool.', takes_target: false, target_label: null, targets: [], credentials: 'none', ready: true },
  { name: 'k8s.write', label: 'Kubernetes <b>bold</b>', permits: 'kubectl and helm writes on the context', switches: 'KUBECONFIG for stg', takes_target: true, target_label: 'Context', targets: ['stg', 'pr"od'], credentials: 'required', ready: true },
  { name: 'db.write', label: 'Databases', permits: 'SQL writes', switches: 'No credentials configured: set [scopes."db.write"] env.PGSERVICEFILE in config.toml.', takes_target: true, target_label: 'Host or database', targets: [], credentials: 'required', ready: false },
];

test('Write scopes: a checklist under Advanced with label, what it permits and the credentials it switches to, all escaped', () => {
  const html = dialogFor(withMeta(autonomy({ scopes: SCOPES })));
  const block = /<fieldset class="write-scopes">[\s\S]*?<\/fieldset>/.exec(html)?.[0] ?? '';
  assert.ok(block, 'the checklist renders');
  assert.match(html, /<details class="advanced access-advanced">[\s\S]*value="settings"[\s\S]*<fieldset class="write-scopes"><legend>Write scopes<\/legend>[\s\S]*<\/details>/, 'inside Advanced, after my settings');
  assert.match(block, /<input type="checkbox" name="scope" value="jira\.write"/);
  assert.match(block, /<input type="checkbox" name="scope" value="k8s\.write"/);
  assert.match(block, /Kubernetes &lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(block, /Create and transition &lt;issues&gt;/);
  assert.match(block, /KUBECONFIG for stg/);
  assert.doesNotMatch(block, /<b>bold|<issues>/);
  assert.match(block, /<input type="text" name="scope_target:k8s\.write"/, 'a target field for a scope that takes one');
  assert.doesNotMatch(block, /name="scope_target:jira\.write"/);
  assert.match(block, /pr&quot;od|pr&#34;od/, 'configured targets are escaped');
  assert.match(block, /No credentials configured: set \[scopes\.&quot;db\.write&quot;\] env\.PGSERVICEFILE|No credentials configured: set \[scopes\."db\.write"\] env\.PGSERVICEFILE/);
  assert.doesNotMatch(block, / disabled/, 'Autonomous is checked: the scopes are available');
  assert.match(block, /data-scope-reason hidden/);
});

test('Write scopes are disabled with a reason when the access is not Autonomous; absent without a catalog and in bulk', async () => {
  const { accessFieldset } = await import('../../ui/components.js');
  const { renderBulkHandoffForm } = await import('../../ui/views/bulk.js');
  const s = withMeta(autonomy({ scopes: SCOPES }));
  const std = accessFieldset(s, { access: 'standard', scopes: true });
  assert.match(std, /<input type="checkbox" name="scope" value="jira\.write"[^>]* disabled/);
  assert.match(std, /<input type="text" name="scope_target:k8s\.write"[^>]* disabled/);
  assert.match(std, /<p class="small scope-reason" id="scope-reason" data-scope-reason>Write scopes need Autonomous access/);
  assert.doesNotMatch(dialogFor(withMeta(autonomy())), /write-scopes/, 'no catalog in the snapshot: no checklist');
  assert.doesNotMatch(renderBulkHandoffForm(s, [s.tickets[0].id], { mode: 'analyse' }), /write-scopes/, 'scopes are granted one run at a time');
});

test('the Run dialog submits the checked scopes, with the target where one was typed', async () => {
  const { scopeChoices } = await import('../../ui/components.js');
  const fd = new FormData();
  fd.append('scope', 'k8s.write');
  fd.append('scope_target:k8s.write', ' stg ');
  fd.append('scope', 'jira.write');
  fd.append('scope_target:db.write', 'ignored-not-checked');
  fd.append('scope', 'jira.write');
  assert.deepEqual(scopeChoices(fd), ['k8s.write:stg', 'jira.write']);
  assert.deepEqual(scopeChoices(new FormData()), []);
  const app = (await import('node:fs')).readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /scopeChoices\(fd\)/, 'the recipe form sends them');
});

// Review round 1: M3 (target fields named for their scope), M4 (a scope with no credentials blocks
// Queue with a reason), M5 (typing a target ticks its box).
test('Write scopes: each target field is named for its scope; a scope without credentials carries its blocker; app.js wires both', async () => {
  const html = dialogFor(withMeta(autonomy({ scopes: SCOPES })));
  assert.match(html, /name="scope_target:k8s\.write"[^>]* aria-label="Context for Kubernetes &lt;b&gt;bold&lt;\/b&gt;"/);
  assert.match(html, /name="scope_target:db\.write"[^>]* aria-label="Host or database for Databases"/);
  assert.match(html, /value="db\.write"[^>]* data-scope-blocker="Databases: no credentials are configured for this scope, so a run that asks for it is refused\./);
  assert.doesNotMatch(/value="k8s\.write"[^>]*>/.exec(html)[0], /data-scope-blocker/, 'a ready scope has none');
  assert.match(html, /<p class="small critical" role="alert" data-scope-blocked hidden><\/p>/);
  const app = (await import('node:fs')).readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /function scopeBlockers\(form, scoped\)/);
  assert.match(app, /submitBtn\.dataset\.blocked !== 'true'/, 'a form blocker keeps Queue disabled whatever the scopes are');
  assert.match(app, /t\.dataset\.scopeTarget[\s\S]{0,400}box\.checked = true/);
  // A form blocker is marked so the scope check never re-enables Queue.
  const t = ticket(1);
  const busy = snap({ handoffs: [{ id: 'h', ticket_id: t.id, state: 'running', permissions: {} }] });
  assert.match(renderRunAgentDialog(t, busy, { recipe: 'analyse' }), /<button type="submit" class="btn primary" disabled data-blocked="true"/);
});
