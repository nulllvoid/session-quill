// Scope catalog (spec §4.3, ADR 0026): built-in write scopes, owner overrides from config.toml,
// strict name and target validation, credentials per target, the grant and env a scope reaches,
// and the full-access observe ledger (`prod_effects`).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadScopeCatalog, resolveScopes, scopeFingerprint, scopeValidator, catalogSummary } from '../../src/handoff/scopes.js';
import { BUILTIN_SCOPES, scopeSettings } from '../../src/config/scopes.js';
import { parseToml, stringifyToml } from '../../src/config/toml.js';
import { loadRepoConfig } from '../../src/config/config.js';
import { validateHandoffRequest } from '../../src/handoff/permissions.js';
import { decide } from '../../src/gate/run-guard.js';
import { prodEffects } from '../../src/handoff/autonomous.js';
import { handoffRunDir } from '../../src/lib/paths.js';
import { bootWorker, makeRepo, until, T1 } from './helpers.js';

const BUILTINS = ['jira.write', 'confluence.write', 'slack.post', 'k8s.write', 'argo.sync', 'cloud.write', 'db.write', 'deploy', 'http.write', 'package.publish'];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scopes-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const rw = path.join(scratch, 'rw-kubeconfig');
const rwStg = path.join(scratch, 'stg-kubeconfig');
const toml = (text) => parseToml(text);
const ownerK8s = () => toml(`[scopes."k8s.write"]\nenv.KUBECONFIG = "${rw.replace(/\\/g, '/')}"\n`);

test('built-ins: the ten scopes of spec §4.3, each with a label, matchers as data and a fingerprint', () => {
  const catalog = loadScopeCatalog({});
  assert.deepEqual(Object.keys(BUILTIN_SCOPES).sort(), [...BUILTINS].sort());
  for (const name of BUILTINS) {
    const s = catalog[name];
    assert.ok(s, name);
    assert.equal(typeof s.label, 'string', name);
    assert.ok(s.label.length > 0 && s.permits.length > 0, name);
    for (const k of ['mcp', 'bash', 'hosts']) assert.ok(Array.isArray(s[k]) && s[k].every((x) => typeof x === 'string'), `${name}.${k}`);
    assert.ok(s.mcp.length + s.bash.length + s.hosts.length > 0, `${name} has matchers`);
    assert.deepEqual(s.env, {}, `${name}: no credentials until the owner configures them`);
    assert.match(s.fingerprint, /^[0-9a-f]{64}$/, name);
  }
  assert.ok(catalog['jira.write'].mcp.some((p) => p.includes('createJiraIssue')) && catalog['jira.write'].mcp.some((p) => p.includes('transitionJiraIssue')));
  assert.ok(catalog['k8s.write'].bash.includes('kubectl *') && catalog['k8s.write'].bash.includes('helm *'));
  assert.ok(catalog['argo.sync'].bash.some((p) => p.startsWith('argocd app sync')));
  assert.equal(catalog['git.push'], undefined, 'R2: git is a per-run permission, never a scope');
});

test('owner [scopes."k8s.write"] env.KUBECONFIG merges over the built-in; matchers stay the built-in ones', () => {
  const base = loadScopeCatalog({});
  const owned = loadScopeCatalog(ownerK8s());
  assert.equal(owned['k8s.write'].env.KUBECONFIG, rw.replace(/\\/g, '/'));
  assert.deepEqual(owned['k8s.write'].bash, base['k8s.write'].bash);
  assert.equal(owned['k8s.write'].label, base['k8s.write'].label);
  assert.notEqual(owned['k8s.write'].fingerprint, base['k8s.write'].fingerprint, 'a credential change is a table change');
  // Matchers the owner names replace the built-in list; the label and description may change too.
  const narrowed = loadScopeCatalog(toml('[scopes."k8s.write"]\nbash = ["kubectl *"]\nlabel = "Staging cluster"\n'));
  assert.deepEqual(narrowed['k8s.write'].bash, ['kubectl *']);
  assert.equal(narrowed['k8s.write'].label, 'Staging cluster');
});

test('TOML: quoted table names and dotted keys parse, and a config with them round-trips', () => {
  const text = `[scopes."k8s.write"]\nenv.KUBECONFIG = "/k/rw"\n\n[scopes."k8s.write".targets.stg]\nenv.KUBECONFIG = "/k/stg"\n\n[scopes."http.write"]\nhosts = ["{target}"]\n`;
  const parsed = parseToml(text);
  assert.deepEqual(parsed.scopes['k8s.write'], { env: { KUBECONFIG: '/k/rw' }, targets: { stg: { env: { KUBECONFIG: '/k/stg' } } } });
  assert.deepEqual(parseToml(stringifyToml(parsed)), parsed);
  assert.throws(() => parseToml('[scopes.__proto__]\nx = "y"\n'), (e) => e.code === 'toml-unsupported');
  assert.throws(() => parseToml('a.__proto__.b = "y"\n'), (e) => e.code === 'toml-unsupported');
  assert.equal({}.b, undefined);
});

test('resolveScopes: k8s.write:stg has target stg, its matchers, a fingerprint and the target credentials', () => {
  const cfg = toml(`[scopes."k8s.write"]\nenv.KUBECONFIG = "${rw.replace(/\\/g, '/')}"\n[scopes."k8s.write".targets.stg]\nenv.KUBECONFIG = "${rwStg.replace(/\\/g, '/')}"\n`);
  const catalog = loadScopeCatalog(cfg);
  const [s] = resolveScopes(['k8s.write:stg'], catalog);
  assert.equal(s.name, 'k8s.write');
  assert.equal(s.target, 'stg');
  assert.deepEqual(s.matchers, { mcp: catalog['k8s.write'].mcp, bash: catalog['k8s.write'].bash, hosts: catalog['k8s.write'].hosts });
  assert.match(s.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(s.env.KUBECONFIG, rwStg.replace(/\\/g, '/'), 'the target table wins over the scope table');
  const [dev] = resolveScopes(['k8s.write:dev'], catalog);
  assert.equal(dev.env.KUBECONFIG, rw.replace(/\\/g, '/'), 'a target without its own table uses the scope table');
  assert.notEqual(dev.fingerprint, s.fingerprint, 'the fingerprint is of what this grant holds');
  // A scope that takes no target, and a connector-only scope with no credentials at all.
  const [jira] = resolveScopes(['jira.write'], catalog);
  assert.deepEqual([jira.name, jira.target, jira.env], ['jira.write', null, {}]);
  // http.write pins its hosts matcher to the target.
  const [http] = resolveScopes(['http.write:api.example.com'], catalog);
  assert.deepEqual(http.matchers.hosts, ['api.example.com']);
});

test('resolveScopes refuses unknown scopes, git pseudo-scopes and bad targets', () => {
  const catalog = loadScopeCatalog(ownerK8s());
  const throwsCode = (list, code, name) => assert.throws(() => resolveScopes(list, catalog), (e) => e.code === code && e.message.startsWith(`${code}:${name}`), JSON.stringify(list));
  throwsCode(['k8s.nope'], 'unknown-scope', 'k8s.nope');
  throwsCode(['git.push'], 'unknown-scope', 'git.push');
  throwsCode(['git.commit:main'], 'unknown-scope', 'git.commit');
  throwsCode(['__proto__'], 'unknown-scope', '__proto__');
  throwsCode(['jira.write:PROJ-1'], 'invalid-scope-target', 'jira.write');
  throwsCode(['package.publish:npm'], 'invalid-scope-target', 'package.publish');
  throwsCode(['k8s.write'], 'invalid-scope-target', 'k8s.write');
  for (const bad of ['k8s.write:a..b', 'k8s.write:..', 'k8s.write:a/b', 'k8s.write:-x', 'k8s.write:*', 'http.write:api.example.com/x', 'http.write:-bad.com', 'argo.sync:a/b/c', 'db.write:x y']) throwsCode([bad], 'invalid-scope-target', bad.split(':')[0]);
  assert.equal(resolveScopes(['argo.sync:pay/api'], loadScopeCatalog({})).length, 1, 'an Argo app in a project');
  assert.deepEqual(resolveScopes([], catalog), []);
});

test('a scope whose CLI needs credentials is refused when none are configured, naming the missing config', () => {
  const catalog = loadScopeCatalog({});
  assert.throws(() => resolveScopes(['k8s.write:stg'], catalog), (e) => e.code === 'scope-credentials-missing' && /\[scopes\."k8s\.write"\.targets\.stg\] env\.KUBECONFIG/.test(e.message));
  assert.throws(() => resolveScopes(['db.write:stg'], catalog), (e) => e.code === 'scope-credentials-missing');
  assert.throws(() => resolveScopes(['cloud.write:rw'], catalog), (e) => e.code === 'scope-credentials-missing');
  assert.throws(() => resolveScopes(['package.publish'], catalog), (e) => e.code === 'scope-credentials-missing');
  // Variables of another system do not count: KUBECONFIG is no database credential.
  assert.throws(() => resolveScopes(['db.write:stg'], loadScopeCatalog(toml('[scopes."db.write"]\nenv.KUBECONFIG = "/x"\n'))), (e) => e.code === 'scope-credentials-missing');
  // Connector scopes need none; Argo, deploy and http.write work through connectors or the target alone.
  for (const s of ['jira.write', 'confluence.write', 'slack.post', 'argo.sync:pay-stg', 'deploy:stg', 'http.write:api.example.com']) assert.equal(resolveScopes([s], catalog).length, 1, s);
  // Two targets of one scope with different credentials would leave one of them with the wrong file.
  const two = loadScopeCatalog(toml('[scopes."k8s.write".targets.stg]\nenv.KUBECONFIG = "/a"\n[scopes."k8s.write".targets.dev]\nenv.KUBECONFIG = "/b"\n'));
  assert.throws(() => resolveScopes(['k8s.write:stg', 'k8s.write:dev'], two), (e) => e.code === 'scope-conflict');
  assert.equal(resolveScopes(['http.write:a.example.com', 'http.write:b.example.com'], catalog).length, 2);
});

test('scopeFingerprint: canonical (order of keys and matchers does not matter), changes when matchers or credentials change', () => {
  const a = { mcp: ['mcp__x__a', 'mcp__x__b'], bash: ['kubectl *'], hosts: [], env: { KUBECONFIG: '/a', X: '1' } };
  const b = { env: { X: '1', KUBECONFIG: '/a' }, hosts: [], bash: ['kubectl *'], mcp: ['mcp__x__b', 'mcp__x__a'] };
  assert.equal(scopeFingerprint(a), scopeFingerprint(b));
  assert.match(scopeFingerprint(a), /^[0-9a-f]{64}$/);
  assert.notEqual(scopeFingerprint(a), scopeFingerprint({ ...a, bash: ['kubectl *', 'helm *'] }));
  assert.notEqual(scopeFingerprint(a), scopeFingerprint({ ...a, env: { KUBECONFIG: '/b', X: '1' } }));
  const before = loadScopeCatalog(ownerK8s());
  const widened = loadScopeCatalog(toml(`[scopes."k8s.write"]\nenv.KUBECONFIG = "${rw.replace(/\\/g, '/')}"\nbash = ["kubectl *", "helm *", "k9s *"]\n`));
  assert.notEqual(widened['k8s.write'].fingerprint, before['k8s.write'].fingerprint);
  const relabelled = loadScopeCatalog(toml(`[scopes."k8s.write"]\nenv.KUBECONFIG = "${rw.replace(/\\/g, '/')}"\nlabel = "Other words"\n`));
  assert.equal(relabelled['k8s.write'].fingerprint, before['k8s.write'].fingerprint, 'a label is not what the scope allows');
  assert.equal(resolveScopes(['k8s.write:stg'], before)[0].fingerprint, resolveScopes(['k8s.write:stg'], loadScopeCatalog(ownerK8s()))[0].fingerprint, 'stable across loads');
});

test('config: invalid entries are ignored with warnings that name keys, never values; repositories cannot set scopes', () => {
  const secret = 'sk-live-should-never-appear';
  const { warnings } = scopeSettings(toml(`[scopes."git.push"]\nbash = ["git push *"]\n[scopes."k8s.write"]\nbash = "kubectl *"\nmcp = ["not-mcp"]\nfoo = "x"\nenv.NPM_TOKEN = "${secret}"\n[scopes."k8s.write".targets."a b"]\nenv.KUBECONFIG = "/x"\n`));
  const text = warnings.join('\n');
  assert.match(text, /git\.push/);
  assert.match(text, /\[scopes\."k8s\.write"\] bash/);
  assert.match(text, /\[scopes\."k8s\.write"\] mcp\[0\]/);
  assert.match(text, /\[scopes\."k8s\.write"\] foo/);
  assert.match(text, /NPM_TOKEN/);
  assert.match(text, /targets/);
  assert.doesNotMatch(text, new RegExp(secret));
  const catalog = loadScopeCatalog(toml(`[scopes."k8s.write"]\nenv.NPM_TOKEN = "${secret}"\nenv.NODE_AUTH_TOKEN = "env:MY_NPM_TOKEN"\n`));
  assert.equal(catalog['k8s.write'].env.NPM_TOKEN, undefined, 'a literal secret is never taken from config.toml');
  assert.equal(catalog['k8s.write'].env.NODE_AUTH_TOKEN, 'env:MY_NPM_TOKEN', 'a reference to an inherited variable is');
  assert.equal(loadScopeCatalog(toml('[scopes."git.push"]\nbash = ["git push *"]\n'))['git.push'], undefined);
  assert.equal(loadScopeCatalog(toml('[scopes."unknown-prod"]\nbash = ["*"]\n'))['unknown-prod'], undefined, 'a guard class is never a scope');
  // A custom scope the owner maps an MCP write to.
  const custom = loadScopeCatalog(toml('[scopes."pager.write"]\nlabel = "Pager"\nmcp = ["mcp__pager__create_incident"]\n'));
  assert.deepEqual(resolveScopes(['pager.write'], custom)[0].matchers.mcp, ['mcp__pager__create_incident']);
  const repo = fs.mkdtempSync(path.join(scratch, 'repo-'));
  fs.writeFileSync(path.join(repo, '.quill.toml'), '[scopes."k8s.write"]\nenv.KUBECONFIG = "/evil"\n');
  assert.equal(loadRepoConfig(repo).scopes, undefined, 'scopes are user-only config');
});

test('validation: the dashboard and the CLI validate scopes through the same catalog path', () => {
  const check = scopeValidator(ownerK8s());
  const v = (scopes, access = 'autonomous') => validateHandoffRequest({ mode: 'analyse', note: '', permissions: {}, access, scopes }, { scopeCheck: check });
  assert.deepEqual(v(['k8s.write:stg', 'jira.write']).scopes, ['k8s.write:stg', 'jira.write']);
  assert.throws(() => v(['k8s.write:stg'], 'standard'), (e) => e.code === 'scope-needs-autonomous');
  assert.throws(() => v(['nope.write']), (e) => e.code === 'unknown-scope');
  assert.throws(() => v(['jira.write:X']), (e) => e.code === 'invalid-scope-target');
  assert.throws(() => validateHandoffRequest({ mode: 'analyse', permissions: {}, access: 'autonomous', scopes: ['db.write:stg'] }, { scopeCheck: check }), (e) => e.code === 'scope-credentials-missing');
});

test('a resolved scope never covers more than its matchers and target (the guard reads the grant entry)', () => {
  const tmp = fs.mkdtempSync(path.join(scratch, 'g-'));
  const catalog = loadScopeCatalog(toml(`[scopes."k8s.write"]\nenv.KUBECONFIG = "/rw"\nbash = ["kubectl *"]\n`));
  const grantScopes = resolveScopes(['k8s.write:stg', 'jira.write', 'http.write:api.example.com'], catalog).map(({ name, target, matchers, fingerprint }) => ({ name, ...(target ? { target } : {}), matchers, fingerprint }));
  const grant = { access: 'autonomous', permissions: {}, scopes: grantScopes, actionPins: [], readableRoots: [tmp], writableRoots: [tmp], protectedPaths: [], mcpPolicy: { read: [], write: {} }, trustedMcpServers: [], trackerHosts: [] };
  const env = { cwd: tmp, vars: { HOME: tmp, USERPROFILE: tmp, TEMP: tmp, TMP: tmp, QUILL_HANDOFF_GUARD: 'enforce' } };
  const bash = (command) => decide({ tool_name: 'Bash', tool_input: { command } }, grant, env).decision;
  assert.equal(bash('kubectl --context stg delete pod api'), 'allow');
  assert.equal(bash('kubectl --context prod delete pod api'), 'deny', 'another context');
  assert.equal(bash('kubectl delete pod api'), 'deny', 'no context named');
  assert.equal(bash('helm --kube-context stg uninstall api'), 'deny', 'helm is outside the owner matchers');
  assert.equal(bash('curl -X POST https://api.example.com/v1/x'), 'allow');
  assert.equal(bash('curl -X POST https://evil.example.com/v1/x'), 'deny');
  const mcp = (tool_name) => decide({ tool_name, tool_input: { issueIdOrKey: 'PROJ-1' }, mcp_server_source: 'claudeai' }, grant, env).decision;
  assert.equal(mcp('mcp__claude_ai_Atlassian__transitionJiraIssue'), 'allow');
  assert.equal(mcp('mcp__claude_ai_Atlassian__createConfluencePage'), 'deny', 'confluence.write was not granted');
});

test('catalogSummary: what the dialog shows, names only (never credential values)', () => {
  const cfg = toml(`[scopes."k8s.write"]\nlabel = "Cluster <b>"\n[scopes."k8s.write".targets.stg]\nenv.KUBECONFIG = "/very/private/rw-kubeconfig"\n[scopes."db.write"]\nenv.PGSERVICEFILE = "/very/private/pg"\n`);
  const rows = catalogSummary(loadScopeCatalog(cfg));
  assert.deepEqual(rows.map((r) => r.name).sort(), [...BUILTINS].sort());
  const k8s = rows.find((r) => r.name === 'k8s.write');
  assert.equal(k8s.label, 'Cluster <b>', 'escaping is the renderer\'s job');
  assert.equal(k8s.takes_target, true);
  assert.equal(k8s.target_label, 'Context');
  assert.deepEqual(k8s.targets, ['stg']);
  assert.match(k8s.switches, /KUBECONFIG/);
  assert.match(k8s.switches, /stg/);
  const jira = rows.find((r) => r.name === 'jira.write');
  assert.equal(jira.takes_target, false);
  assert.match(jira.switches, /connect/i);
  assert.match(rows.find((r) => r.name === 'cloud.write').switches, /No credentials configured/);
  assert.doesNotMatch(JSON.stringify(rows), /very\/private/);
});

test('prodEffects: observed writes of a full-access run, scope, target, tool and time only', () => {
  const lines = [
    { kind: 'tool_use', tool: 'Bash', input_summary: 'kubectl apply' },
    { kind: 'guard', ts: '2026-10-02T08:00:01Z', tool_name: 'Bash', decision: 'allow', class: 'write', scope: 'k8s.write', target: 'prod', critical: true, enforce_decision: 'deny', enforce_reason: 'QUILL_CRITICAL_CHANGE scope=k8s.write target=prod: …', input_excerpt: '{"command":"kubectl --context prod apply -f secret.yaml"}' },
    { kind: 'guard', ts: '2026-10-02T08:00:02Z', tool_name: 'Bash', decision: 'allow', class: 'read', enforce_decision: 'allow' },
    { kind: 'guard', ts: '2026-10-02T08:00:03Z', tool_name: 'Bash', decision: 'allow', class: 'write', scope: 'git.commit', critical: true, enforce_decision: 'deny' },
    { kind: 'guard', ts: '2026-10-02T08:00:04Z', tool_name: 'mcp__claude_ai_Atlassian__transitionJiraIssue', decision: 'allow', class: 'write', scope: 'jira.write', target: 'PROJ-1', critical: true, enforce_decision: 'deny' },
    { kind: 'guard', ts: '2026-10-02T08:00:05Z', tool_name: 'Bash', decision: 'deny', class: 'write', scope: 'k8s.write', target: 'x', critical: true },
    { kind: 'guard', ts: '2026-10-02T08:00:06Z', tool_name: 'Bash', decision: 'allow', class: 'privileged', scope: 'privileged', critical: true, enforce_decision: 'deny' },
  ];
  assert.deepEqual(prodEffects(lines), [
    { scope: 'k8s.write', target: 'prod', tool: 'Bash', t: '2026-10-02T08:00:01Z' },
    { scope: 'jira.write', target: 'PROJ-1', tool: 'mcp__claude_ai_Atlassian__transitionJiraIssue', t: '2026-10-02T08:00:04Z' },
  ]);
  assert.deepEqual(prodEffects([]), []);
});

// ---------------------------------------------------------------- through the worker

const NONE = { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false };
async function queueRun(b, n, payload) {
  const rid = `77777777-0000-4000-8000-00000000000${n}`;
  b.request(rid, { target_id: T1, expected_revision: b.w.state.tickets.get(T1).revision, payload });
  b.w.tick();
  return b.w.state.requests.get(rid);
}
const settle = (b, hid) => until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return ['done', 'failed', 'cancelled', 'timed-out'].includes(x.state) ? x : null; }, { timeoutMs: 20000 });
const cleanup = (b, repo) => { for (const d of [b.home, repo.dir]) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } };

test('worker: a scoped autonomous run gets the scope in its grant (no credentials there) and the scope credentials in its env', async () => {
  const repo = makeRepo();
  const capture = path.join(scratch, `capture-${randomUUID()}.json`);
  const scopes = toml(`[scopes."k8s.write".targets.stg]\nenv.KUBECONFIG = "env:FAKE_RW_KUBECONFIG"\n`).scopes;
  const b = await bootWorker({ repo, runtimeAvailable: true, configExtra: { scopes }, fakeEnv: { FAKE_CLAUDE_CAPTURE: capture, FAKE_RW_KUBECONFIG: '/fake/rw/kubeconfig', FAKE_CLAUDE_ENV_PROBE: 'KUBECONFIG,QUILL_HANDOFF_SCOPES' } });
  try {
    b.ticket(T1, 'PROJ-21');
    const req = await queueRun(b, 1, { recipe: 'analyse', note: '', permissions: { ...NONE, read_source: true }, access: 'autonomous', scopes: ['k8s.write:stg', 'jira.write'] });
    assert.equal(req.state, 'applied', JSON.stringify(req.error));
    const hid = req.result.handoff_id;
    assert.deepEqual(b.w.state.handoffs.get(hid).scopes, ['k8s.write:stg', 'jira.write'], 'the record copies the scopes');
    const h = await settle(b, hid);
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
    const grant = JSON.parse(seen.grant_text);
    assert.deepEqual(grant.scopes.map((s) => [s.name, s.target ?? null]), [['k8s.write', 'stg'], ['jira.write', null]]);
    assert.ok(grant.scopes.every((s) => s.matchers && s.fingerprint && !('env' in s)), 'no env in the grant');
    assert.doesNotMatch(seen.grant_text, /fake\/rw|FAKE_RW_KUBECONFIG/);
    assert.deepEqual(seen.env_probe, { KUBECONFIG: '/fake/rw/kubeconfig', QUILL_HANDOFF_SCOPES: 'k8s.write:stg,jira.write' });
    assert.equal(h.cred_report.kubernetes, 'scope');
    // The snapshot offers the catalog to the dialog by name only.
    const info = b.w.autonomyInfo();
    assert.deepEqual(info.scopes.find((s) => s.name === 'k8s.write').targets, ['stg']);
    assert.doesNotMatch(JSON.stringify(info.scopes), /FAKE_RW_KUBECONFIG|fake\/rw/);
  } finally { await b.w.stop(); cleanup(b, repo); }
});

test('worker: an unknown scope, or a scope with no credentials, is refused when the request applies (the CLI path)', async () => {
  const repo = makeRepo();
  const b = await bootWorker({ repo, runtimeAvailable: true });
  try {
    b.ticket(T1, 'PROJ-22');
    const unknown = await queueRun(b, 2, { recipe: 'analyse', note: '', permissions: { ...NONE, read_source: true }, access: 'autonomous', scopes: ['k8s.nope'] });
    assert.deepEqual([unknown.state, unknown.error.code], ['failed', 'unknown-scope']);
    const missing = await queueRun(b, 3, { recipe: 'analyse', note: '', permissions: { ...NONE, read_source: true }, access: 'autonomous', scopes: ['k8s.write:stg'] });
    assert.deepEqual([missing.state, missing.error.code], ['failed', 'scope-credentials-missing']);
    assert.match(missing.error.message, /\[scopes\."k8s\.write"\.targets\.stg\]/);
    const standard = await queueRun(b, 4, { recipe: 'analyse', note: '', permissions: { ...NONE, read_source: true }, access: 'standard', scopes: ['jira.write'] });
    assert.deepEqual([standard.state, standard.error.code], ['failed', 'scope-needs-autonomous']);
  } finally { await b.w.stop(); cleanup(b, repo); }
});

test('worker: a scope whose credential reference is unset when the run starts fails the run before it spawns', async () => {
  const repo = makeRepo();
  const capture = path.join(scratch, `capture-${randomUUID()}.json`);
  const scopes = toml('[scopes."k8s.write".targets.stg]\nenv.KUBECONFIG = "env:FAKE_UNSET_KUBECONFIG"\n').scopes;
  const b = await bootWorker({ repo, runtimeAvailable: true, configExtra: { scopes }, fakeEnv: { FAKE_CLAUDE_CAPTURE: capture } });
  try {
    b.ticket(T1, 'PROJ-23');
    const req = await queueRun(b, 5, { recipe: 'analyse', note: '', permissions: { ...NONE, read_source: true }, access: 'autonomous', scopes: ['k8s.write:stg'] });
    const h = await settle(b, req.result.handoff_id);
    assert.deepEqual([h.state, h.error.code], ['failed', 'scope-credentials-missing']);
    assert.match(h.error.message, /k8s\.write:stg/);
    assert.equal(fs.existsSync(capture), false, 'claude never started');
  } finally { await b.w.stop(); cleanup(b, repo); }
});

test('worker: a full-access run is observed, never refused, and its writes become prod_effects', async () => {
  const repo = makeRepo();
  const capture = path.join(scratch, `capture-${randomUUID()}.json`);
  const calls = [
    { tool_name: 'Bash', tool_input: { command: 'kubectl --context prod apply -f deploy.yaml' } },
    { tool_name: 'Bash', tool_input: { command: 'kubectl get pods' } },
    { tool_name: 'Bash', tool_input: { command: 'curl -X POST -H "Authorization: Bearer abc123secret" https://api.example.com/v1/items' } },
  ];
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_CAPTURE: capture, FAKE_CLAUDE_GUARD_CALLS: JSON.stringify(calls), FAKE_CLAUDE_ENV_PROBE: 'QUILL_HANDOFF_GUARD,QUILL_HANDOFF_ACCESS,GH_TOKEN', GH_TOKEN: 'fake-owner-token' } });
  try {
    b.ticket(T1, 'PROJ-24');
    const req = await queueRun(b, 6, { recipe: 'analyse', note: '', permissions: { ...NONE, read_source: true }, access: 'full' });
    assert.equal(req.state, 'applied', JSON.stringify(req.error));
    const h = await settle(b, req.result.handoff_id);
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.deepEqual(seen.env_probe, { QUILL_HANDOFF_GUARD: 'observe', QUILL_HANDOFF_ACCESS: 'full', GH_TOKEN: 'fake-owner-token' }, 'the owner environment is kept');
    assert.equal(seen.args[seen.args.indexOf('--permission-mode') + 1], 'bypassPermissions');
    assert.equal(JSON.parse(seen.grant_text).access, 'full');
    assert.notEqual(seen.settings.hooks.PreToolUse[0].hooks[0].onFailure, 'block', 'a failing observer never blocks a full-access call');
    assert.deepEqual(seen.guard_decisions, ['allow', 'allow', 'allow'], 'observe mode never denies');
    assert.deepEqual(h.prod_effects.map((e) => [e.scope, e.target, e.tool]), [['k8s.write', 'prod', 'Bash'], ['http.write', 'api.example.com', 'Bash']]);
    for (const e of h.prod_effects) assert.deepEqual(Object.keys(e).sort(), ['scope', 't', 'target', 'tool']);
    assert.doesNotMatch(JSON.stringify(h.prod_effects), /abc123secret|deploy\.yaml/);
    assert.ok(fs.existsSync(path.join(handoffRunDir(b.env, h.id), 'ledger.jsonl')));
  } finally { await b.w.stop(); cleanup(b, repo); }
});
