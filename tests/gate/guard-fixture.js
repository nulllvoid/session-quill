// Shared fixture for the guard tests (run-guard-rows.test.js, run-guard-paths.test.js, and the row
// tables guard-rows-basic.js and guard-rows-shell.js). Not a test file itself: node --test runs each
// test file in its own process, so each one gets its own throwaway machine and removes it after.
// The tests are split across files because one antivirus quarantined the single large file.
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide } from '../../src/gate/run-guard.js';

// A throwaway machine: home with credentials and Claude settings, a Quill home with memory and
// this run's directory, the run's checkout (a worktree under the Quill home, as the worker makes
// it), a temp dir, an install root with guard code, and somewhere outside every root.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'quill-guard-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const at = (...p) => path.join(base, ...p);
const dir = (...p) => { const d = at(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const file = (...p) => { const f = at(...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x\n'); return f; };

const home = dir('home');
file('home', '.aws', 'config');
file('home', '.claude', 'settings.json');
const plugins = dir('home', '.claude', 'plugins');
file('home', '.claude', 'plugins', 'p1', 'SKILL.md');
const qh = dir('quill');
file('quill', 'memory', '_quarantine.md');
const runDir = dir('quill', 'handoffs', 'runs', 'run1');
file('quill', 'handoffs', 'runs', 'run1', 'context', 'repo.md');
const checkout = dir('quill', 'handoffs', 'worktrees', 'run1');
file('quill', 'handoffs', 'worktrees', 'run1', 'src', 'app.js');
file('quill', 'handoffs', 'worktrees', 'run1', '.git', 'config');
dir('quill', 'handoffs', 'worktrees', 'run1', '.git', 'hooks');
file('quill', 'handoffs', 'worktrees', 'run1', '.claude', 'settings.json');
const tmp = dir('tmp');
const install = dir('install');
file('install', 'src', 'gate', 'run-guard.js');
file('install', 'src', 'handoff', 'grant.js');
file('install', 'src', 'lib', 'x.js');
const outside = dir('outside');
file('outside', 'secret.txt');
file('outside', 'credentials');
// a directory junction (a dir symlink elsewhere) inside the checkout, leading outside every root
fs.symlinkSync(outside, path.join(checkout, 'esc'), 'junction');

const VARS = { USERPROFILE: home, HOME: home, QUILL_HOME: qh, QUILL_HANDOFF_ID: 'run1', TEMP: tmp, TMP: tmp, TMPDIR: tmp, QUILL_HANDOFF_GUARD: 'enforce' };
const ENV = { cwd: checkout, vars: VARS, currentBranch: 'feat/x', defaultBranch: 'main', installRoot: install };

const RO = { read_source: true };
const EDIT = { read_source: true, edit_source: true };
const COMMIT = { ...EDIT, commit: true };
const PUSH = { ...COMMIT, push_branch: true };
const PR = { ...PUSH, open_draft_pr: true };

function grantWith(over = {}) {
  const edits = !!(over.permissions && over.permissions.edit_source);
  return {
    access: 'autonomous',
    permissions: RO,
    scopes: [],
    actionPins: [],
    readableRoots: [checkout, runDir, path.join(runDir, 'context'), tmp, plugins],
    writableRoots: edits ? [checkout, runDir, tmp] : [runDir, tmp],
    protectedPaths: [path.join(install, 'src', 'gate'), path.join(install, 'bin', 'quill-guard.js'), qh, path.join(home, '.claude'), path.join(home, '.claude.json')],
    mcpPolicy: { read: [], write: {} },
    trustedMcpServers: ['team_docs'],
    trackerHosts: [],
    ...over,
  };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const pwsh = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
const call = (tool_name, tool_input, extra = {}) => ({ tool_name, tool_input, ...extra });
const q = (p) => `'${p}'`;

const K8S_STG = { name: 'k8s.write', target: 'stg', matchers: { bash: ['kubectl *', 'helm *'], mcp: [], hosts: [] }, fingerprint: 'f-k8s' };
const ARGO = { name: 'argo.sync', matchers: { bash: ['argocd app *'], mcp: ['mcp__argocd__*'], hosts: [] }, fingerprint: 'f-argo' };
const JIRA = { name: 'jira.write', matchers: { mcp: ['mcp__claude_ai_Atlassian__*'], bash: [], hosts: [] }, fingerprint: 'f-jira' };
const HTTP_API = { name: 'http.write', target: 'api.example.com', matchers: { hosts: ['api.example.com'], bash: [], mcp: [] }, fingerprint: 'f-http' };
const PIN = { scope: 'argo.sync', pin: 'argocd app sync pay-stg' };
const MCP_PIN = { scope: 'argo.sync', pin: 'mcp__argocd__sync_application {"applicationName":"pay-stg"}' };
// R48: a pinned write is allowed only when it matches a pin AND a granted scope covers it.
const ARGO_STG = { ...ARGO, target: 'pay-stg' };
const PIN_STG = { scope: 'argo.sync:pay-stg', pin: 'argocd app sync pay-stg' };
const KUBECTL_ONLY = { name: 'k8s.write', target: 'stg', matchers: { bash: ['kubectl *'] }, fingerprint: 'f-kubectl' };

const CRITICAL_TAIL = 'Record it in critical_changes with action, target, why, evidence, verify and rollback, then continue with everything else.';
const denied = (code) => new RegExp(`^QUILL_DENIED ${code}: `);
// R17.1: `..` after a name in one path word, refused with a reason that says what to write instead
const CLIMBS = /^QUILL_DENIED unparseable: the path .* has '\.\.' after a directory name.*Write the path without 'name\/\.\.'/;
// outside the writable roots (the fixture's outside directories sit under the protected Quill home)
const OUT_W = /^QUILL_DENIED (outside-writable|protected-path): /;
const critical = (scope, target) => new RegExp(`^QUILL_CRITICAL_CHANGE scope=${scope.replace(/\./g, '\\.')} target=${target === undefined ? '' : target.replace(/\./g, '\\.')}`);
// A row option: cmd.exe forms that only mean what the row says on Windows. cmd does not exist on
// macOS or Linux, where the fixture's absolute paths start with / (which cmd reads as a switch) and
// \ is part of a name in every shell but PowerShell.
const CMD_ONLY = 'cmd.exe exists only on Windows';
const skipOn = (opts) => (opts.winOnly && process.platform !== 'win32' ? opts.winOnly : false);

// Install root used as the checkout (Review Focus 2): edits must work, the guard code must not change.
const IN_INSTALL = {
  env: { cwd: install, installRoot: install },
  grant: { permissions: EDIT, readableRoots: [install, runDir, tmp], writableRoots: [install, runDir, tmp], protectedPaths: [] },
};
const FULL = { grant: { access: 'full' }, env: { vars: { ...VARS, QUILL_HANDOFF_GUARD: 'observe' } } };

function run(c, opts = {}) {
  const env = { ...ENV, ...(opts.env ?? {}) };
  return decide(c, grantWith(opts.grant ?? {}), env);
}

export {
  base, at, dir, file, home, plugins, qh, runDir, checkout, tmp, install, outside, VARS, ENV, RO,
  EDIT, COMMIT, PUSH, PR, grantWith, bash, pwsh, call, q, K8S_STG, ARGO, JIRA, HTTP_API, PIN,
  MCP_PIN, ARGO_STG, PIN_STG, KUBECTL_ONLY, CRITICAL_TAIL, denied, CLIMBS, OUT_W, critical,
  CMD_ONLY, skipOn, IN_INSTALL, FULL, run,
};
