import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateHandoffRequest } from '../../src/handoff/permissions.js';
import { runtimeAccess, childEnvFor } from '../../src/handoff/runner.js';
import { normalizeRecipe } from '../../src/agents/recipes.js';
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

test('dashboard: both dialogs offer access with my settings preselected and full access marked; file runs offer none', async () => {
  const { renderRecipeRunDialog } = await import('../../ui/views/agents.js');
  const { renderHandoffForm } = await import('../../ui/views/handoff-form.js');
  const ticket = { id: T1, key: 'PROJ-1', title: 'T', status: 'active', repo_id: null, files_touched: [{ relative_path: 'C:/x/a.cjs' }], tags: [], timeline: [] };
  const snap = { tickets: [ticket], handoffs: [], recipes: [], capabilities: { read: true, handoff: true }, meta: { timezone: 'UTC' } };
  const analyse = { name: 'analyse', description: 'd', source: 'builtin', mode: 'analyse', permissions: { ...NONE, read_source: true }, timeout_min: 20, legacy: true };
  const dialog = renderRecipeRunDialog(analyse, ticket, snap);
  assert.match(dialog, /name="access" value="settings" checked/);
  assert.match(dialog, /class="danger"><input type="radio" name="access" value="full">/);
  assert.match(renderHandoffForm(ticket, snap), /name="access" value="settings" checked/);
  const files = { name: 'file-task', description: 'd', source: 'builtin', mode: 'files', permissions: { ...NONE, delete_files: true }, timeout_min: 10, legacy: false };
  assert.doesNotMatch(renderRecipeRunDialog(files, ticket, snap), /name="access"/);
});
