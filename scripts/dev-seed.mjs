#!/usr/bin/env node
// Development helper: starts an in-process worker on a throwaway store seeded with sample tickets,
// sessions, PRs and checkpoints, and prints a one-use owner URL for the dashboard.
//
//   node scripts/dev-seed.mjs [--home <dir>] [--port <n>]
//
// Nothing here touches ~/.claude/quill; the home defaults to a temp directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureMachineId, createStoreMeta, writeStoreMeta, loadStoreMeta } from '../src/config/store.js';
import { defaultUserConfig, saveUserConfig } from '../src/config/config.js';
import { Worker } from '../src/worker/worker.js';
import { derive } from '../src/reconcile/derive.js';
import { createExtension as reconcileExt } from '../src/reconcile/extension.js';
import { createExtension as serverExt } from '../src/server/extension.js';
import { createExtension as handoffExt } from '../src/handoff/extension.js';
import { hashSecret } from '../src/server/auth.js';
import { makeEvent } from '../src/core/events.js';
import { writeIngress } from '../src/core/ingress.js';
import { putBlob } from '../src/core/blobs.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const home = path.resolve(flag('home', fs.mkdtempSync(path.join(os.tmpdir(), 'quill-dev-'))));
const port = Number(flag('port', 0));
const env = { QUILL_HOME: home };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const storePath = path.join(home, 'Quill');
fs.mkdirSync(storePath, { recursive: true });
const machine = ensureMachineId(env);
let meta = loadStoreMeta(storePath);
if (!meta) { meta = createStoreMeta({ store_name: 'Quill (dev)', owner_machine_id: machine, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); writeStoreMeta(storePath, meta); }
const config = {
  ...defaultUserConfig(), store_path: storePath, default_project: 'session-quill',
  projects: { 'session-quill': { name: 'Session Quill', repo_id: 'session-quill' }, legacy: { name: 'Legacy Delivery', repo_id: 'legacy' } },
  repos: { 'session-quill': { project_id: 'session-quill', display_name: 'session-quill', canonical_path: root, default_branch: 'main', deployment_environments: ['staging', 'production'], provider: 'github' }, legacy: { project_id: 'legacy', display_name: 'legacy-tracker', default_branch: 'main', deployment_environments: ['production'] } },
  tracker: { system: 'jira', domain: 'https://example.atlassian.net', prefixes: ['PROJ'] },
};
saveUserConfig(config, env);
const ctx = { env, config, storeMeta: meta };
const w = new Worker({ config, storeMeta: meta, env, derive, log: (m) => console.error(`[worker] ${m}`) });
// A fake provider so the dashboard shows both a merged PR and a provider error without network access.
const providers = { for: () => ({ name: 'github', fetchPr: async (url) => { if (url.endsWith('/7')) return { state: 'merged', opened_at: '2026-09-28T08:00:00Z', merged_at: '2026-09-29T08:00:00Z', base_branch: 'main', head_branch: 'feat/journal' }; throw new Error('gh: authentication required (run gh auth login)'); } }) };
const rext = reconcileExt(ctx, { providers });
const sext = serverExt(ctx, { port });
w.use(rext).use(sext).use(handoffExt(ctx));
await w.start();

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const ago = (ms) => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ev = (kind, payload, extra = {}) => writeIngress(makeEvent({ kind, payload, store_id: meta.store_id, machine_id: machine, producer: 'cli', occurred_at: extra.at ?? now(), ...extra }), env);
const T = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
if (!fs.existsSync(path.join(home, 'seeded.flag'))) {
  const mk = (n, title, o = {}) => ev('ticket-create', { ticket: { id: T(n), key: `LOCAL-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 28)}-${n.toString(16).padStart(8, '0')}`, title, project_id: o.project ?? 'session-quill', project_name: o.project === 'legacy' ? 'Legacy Delivery' : 'Session Quill', category: o.cat ?? 'feature', priority: o.pri ?? 'P2', parent_id: o.parent ?? null, repo_id: o.project === 'legacy' ? 'legacy' : 'session-quill', due: o.due ?? null, jira: null } }, { at: o.at ?? ago(6 * 86400e3) });
  mk(1, 'Preserve session checkpoints and recovery journal', { pri: 'P0', due: new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10) });
  mk(2, 'PR polling provider error isolation', { pri: 'P1', cat: 'bugfix' });
  mk(3, 'Restricted PowerShell read-only grammar', { pri: 'P2', cat: 'infra' });
  mk(4, 'Static standalone HTML export', { pri: 'P2' });
  mk(5, 'Jira external link validation adapter', { pri: 'P1', cat: 'research' });
  mk(6, 'Migrate legacy delivery notes', { pri: 'P3', project: 'legacy', cat: 'analysis' });
  mk(7, 'Durable ingress journal with monotonic sequence', { parent: T(1), pri: 'P1' });
  mk(8, 'Torn journal tail verification under SIGKILL', { parent: T(1), pri: 'P0' });
  mk(9, 'Stale ticket aging without mtime change', { pri: 'P2', cat: 'bugfix', at: ago(9 * 86400e3) });
  ev('ticket-update', { ticket_id: T(1), fields: { next_action: 'Verify restart recovery from torn journal tail before committing generation manifest' }, source: 'manual' });
  ev('ticket-update', { ticket_id: T(2), fields: { next_action: 'Run dry reconciliation on staged provider responses' }, source: 'manual' });
  ev('ticket-update', { ticket_id: T(5), fields: { status: 'blocked', blocker: 'Upstream SSO gateway token expired; awaiting IT security cert renewal' }, source: 'manual' });
  ev('ticket-update', { ticket_id: T(7), fields: { status: 'done' }, source: 'manual' });
  ev('ticket-update', { ticket_id: T(9), fields: { status: 'active' }, source: 'manual' }, { at: ago(8 * 86400e3) });
  ev('session-start', { source: 'startup', cwd: root }, { session_id: 'sess-live-8f2a1b9c', at: ago(3600e3) });
  ev('bind', { ticket_id: T(1), project_id: 'session-quill' }, { session_id: 'sess-live-8f2a1b9c', at: ago(3500e3) });
  ev('prompt', { title_candidate: 'Fix the flaky retry test and add coverage', approval_candidate: false }, { session_id: 'sess-live-8f2a1b9c', at: ago(3400e3) });
  for (let i = 0; i < 4; i += 1) {
    ev('pre-tool', { tool_name: 'Edit', write_target: `src/core/file${i}.js` }, { session_id: 'sess-live-8f2a1b9c', tool_call_id: `t${i}`, source_identity: `pre:s1:t${i}`, at: ago(3000e3 - i * 1000) });
    ev('post-tool', { tool_name: 'Edit', write_paths: [`src/core/file${i}.js`], repo_id: 'session-quill', success: true }, { session_id: 'sess-live-8f2a1b9c', tool_call_id: `t${i}`, source_identity: `post:s1:t${i}`, at: ago(2990e3 - i * 1000) });
  }
  const plan = putBlob('# Plan\n\n1. Write the failing journal test\n2. Quarantine torn tail\n3. Verify replay', env).hash;
  ev('pre-tool', { tool_name: 'ExitPlanMode' }, { session_id: 'sess-live-8f2a1b9c', tool_call_id: 'tp', source_identity: 'pre:s1:tp', at: ago(2800e3) });
  ev('post-tool', { tool_name: 'ExitPlanMode', plan_ref: plan, plan_preview: '# Plan\n\n1. Write the failing journal test…', write_paths: [], success: true }, { session_id: 'sess-live-8f2a1b9c', tool_call_id: 'tp', source_identity: 'post:s1:tp', at: ago(2790e3) });
  const cp = putBlob(`I verified the torn-tail path.\n\nConclusion: worker ownership and crash-recovery protocols ready for phase 1 merge.\n${'x'.repeat(2000)}`, env).hash;
  ev('stop', { content_ref: cp, preview: 'I verified the torn-tail path. Conclusion: worker ownership and crash-recovery protocols ready for phase 1 merge.', length: 2100, complete: true, conclusions: ['worker ownership and crash-recovery protocols ready for phase 1 merge.'] }, { session_id: 'sess-live-8f2a1b9c', at: ago(600e3) });
  ev('session-start', { source: 'startup', cwd: root }, { session_id: 'sess-idle-4e7190d2', at: ago(5 * 3600e3) });
  ev('bind', { ticket_id: T(2), project_id: 'session-quill' }, { session_id: 'sess-idle-4e7190d2', at: ago(5 * 3600e3) });
  ev('pre-tool', { tool_name: 'Bash', write_target: 'gh pr create' }, { session_id: 'sess-idle-4e7190d2', tool_call_id: 'g1', source_identity: 'pre:s2:g1', at: ago(4 * 3600e3) });
  ev('post-tool', { tool_name: 'Bash', write_paths: [], repo_id: 'session-quill', success: true, pr: { url: 'https://github.com/acme/session-quill/pull/7', provider: 'github', state: 'open' } }, { session_id: 'sess-idle-4e7190d2', tool_call_id: 'g1', source_identity: 'post:s2:g1', at: ago(4 * 3600e3 - 5e3) });
  ev('pre-tool', { tool_name: 'Bash', write_target: 'gh pr create' }, { session_id: 'sess-idle-4e7190d2', tool_call_id: 'g2', source_identity: 'pre:s2:g2', at: ago(3 * 3600e3) });
  ev('post-tool', { tool_name: 'Bash', write_paths: [], repo_id: 'session-quill', success: true, pr: { url: 'https://github.com/acme/session-quill/pull/9', provider: 'github', state: 'draft' } }, { session_id: 'sess-idle-4e7190d2', tool_call_id: 'g2', source_identity: 'post:s2:g2', at: ago(3 * 3600e3 - 5e3) });
  ev('session-start', { source: 'startup', cwd: root }, { session_id: 'sess-extinct-009c4d31', at: ago(60 * 3600e3) });
  ev('bind', { ticket_id: T(3), project_id: 'session-quill' }, { session_id: 'sess-extinct-009c4d31', at: ago(60 * 3600e3) });
  ev('gate-off', {}, { session_id: 'sess-extinct-009c4d31', at: ago(59 * 3600e3) });
  ev('stop', { content_ref: putBlob('Checkpoint from the extinct session.', env).hash, preview: 'Checkpoint from the extinct session.', length: 36, complete: true, conclusions: [] }, { session_id: 'sess-extinct-009c4d31', at: ago(58 * 3600e3) });
  ev('session-start', { source: 'startup', cwd: root }, { session_id: 'sess-ended-110293aa', at: ago(20 * 3600e3) });
  ev('session-end', { reason: 'other' }, { session_id: 'sess-ended-110293aa', at: ago(19 * 3600e3) });
  // Unlinked work for the inbox (ADR 0006): a session that edited and committed without a ticket.
  ev('session-start', { source: 'startup', cwd: root }, { session_id: 'sess-unlinked-5a6b7c8d', at: ago(1800e3) });
  ev('prompt', { title_candidate: 'Tidy the export dialog copy', approval_candidate: false, length: 28 }, { session_id: 'sess-unlinked-5a6b7c8d', at: ago(1790e3) });
  for (const [i, file] of ['ui/views/dialogs.js', 'ui/styles.css'].entries()) {
    ev('pre-tool', { tool_name: 'Edit', write_target: file }, { session_id: 'sess-unlinked-5a6b7c8d', tool_call_id: `u${i}`, source_identity: `pre:su:u${i}`, at: ago(1700e3 - i * 1000) });
    ev('post-tool', { tool_name: 'Edit', write_paths: [file], repo_id: null, success: true }, { session_id: 'sess-unlinked-5a6b7c8d', tool_call_id: `u${i}`, source_identity: `post:su:u${i}`, at: ago(1690e3 - i * 1000) });
  }
  ev('pre-tool', { tool_name: 'Bash', write_target: 'git commit' }, { session_id: 'sess-unlinked-5a6b7c8d', tool_call_id: 'uc', source_identity: 'pre:su:uc', at: ago(1600e3) });
  ev('post-tool', { tool_name: 'Bash', write_paths: [], commit: { sha: '9f8e7d6c5b4a', message: 'ui: clearer export copy' }, repo_id: null, success: true }, { session_id: 'sess-unlinked-5a6b7c8d', tool_call_id: 'uc', source_identity: 'post:su:uc', at: ago(1590e3) });
  ev('stop', { content_ref: putBlob('Reworded the export dialog and tightened spacing.', env).hash, preview: 'Reworded the export dialog and tightened spacing.', length: 49, complete: true, conclusions: [] }, { session_id: 'sess-unlinked-5a6b7c8d', at: ago(1500e3) });
  // A ticket created from a tracker key, so its key renders as a link with a copy button.
  ev('ticket-create', { ticket: { id: T(20), key: 'PROJ-42', title: 'Tracker-linked ticket from a prompt mention', project_id: 'session-quill', project_name: 'Session Quill', category: 'feature', priority: 'P1', parent_id: null, repo_id: 'session-quill', due: null, jira: { key: 'PROJ-42', url: 'https://example.atlassian.net/browse/PROJ-42', validation: 'pending', validated_at: null, error: null }, external: { system: 'jira', key: 'PROJ-42', url: 'https://example.atlassian.net/browse/PROJ-42', validation: 'pending', validated_at: null, error: null } } }, { at: ago(2 * 86400e3) });
  fs.writeFileSync(path.join(home, 'seeded.flag'), '1');
}
w.tick();
await rext.idle();
w.tick();
const secret = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('hex');
sext.acceptSecretHash(hashSecret(secret), Date.now() + 3600e3);
const addr = sext.address();
console.log(`Session Quill dev store: ${home}`);
console.log(`Owner URL (one use, 60 min): http://127.0.0.1:${addr.port}/auth?secret=${secret}`);
console.log('Press Ctrl+C to stop. Tickets, sessions, a merged PR obligation, a provider error and a stale ticket are seeded.');
const timer = setInterval(() => { try { w.tick(); } catch (e) { console.error(e); } }, 500);
const stop = async () => { clearInterval(timer); await w.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
