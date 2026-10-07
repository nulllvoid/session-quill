import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachedFiles, stageFiles, applyFileRun, undoFileEffect, trashDir } from '../../src/handoff/files.js';
import { validateHandoffRequest } from '../../src/handoff/permissions.js';
import { allowedToolsFor, buildPrompt } from '../../src/handoff/runner.js';
import { normalizeRecipe } from '../../src/agents/recipes.js';
import { writeIngress } from '../../src/core/ingress.js';
import { bootWorker, until, T1 } from './helpers.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const NONE = { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false, edit_files: false, delete_files: false };

function fixture() {
  const dir = tmp('st-files-');
  const keep = path.join(dir, 'keep.txt');
  const junk = path.join(dir, 'readme-install.cjs');
  fs.writeFileSync(keep, 'keep me\n');
  fs.writeFileSync(junk, 'console.log("one-off");\n');
  const ticket = { files_touched: [{ relative_path: junk.split(path.sep).join('/') }, { relative_path: 'src/relative.js' }, { relative_path: keep }, { relative_path: path.join(dir, 'gone.txt') }] };
  return { dir, keep, junk, ticket };
}

test('only absolute attached paths are in reach; copies are staged and a missing file is reported', () => {
  const { junk, keep, ticket } = fixture();
  assert.deepEqual(attachedFiles(ticket), [path.resolve(junk), path.resolve(keep), path.resolve(path.dirname(keep), 'gone.txt')], 'repository-relative paths are left to checkouts');
  const sandbox = tmp('st-sbx-');
  const staged = stageFiles(ticket, sandbox);
  assert.deepEqual(staged.map((f) => [f.id, f.state]), [['f1', 'staged'], ['f2', 'staged'], ['f3', 'missing']]);
  assert.equal(fs.readFileSync(path.join(sandbox, staged[0].staged), 'utf8'), 'console.log("one-off");\n');
  assert.throws(() => stageFiles({ files_touched: [] }, tmp('st-sbx-')), (e) => e.code === 'files-unavailable');
});

test('the worker deletes into the Quill trash and applies edits with a backup, only as permitted, and every change undoes', () => {
  const { keep, junk, ticket } = fixture();
  const env = { QUILL_HOME: tmp('st-home-') };
  const sandbox = tmp('st-sbx-');
  const files = stageFiles(ticket, sandbox);
  fs.writeFileSync(path.join(sandbox, files[1].staged), 'keep me, edited\n');
  const denied = applyFileRun({ env, handoffId: 'h1', sandbox, files, permissions: {}, deleteIds: ['f1'], now: 'T' });
  assert.deepEqual(denied.effects, []);
  assert.equal(denied.skipped.length, 2, 'neither the deletion nor the edit was permitted');
  assert.ok(fs.existsSync(junk));
  const { effects, skipped } = applyFileRun({ env, handoffId: 'h1', sandbox, files, permissions: { edit_files: true, delete_files: true }, deleteIds: ['f1', 'f9'], now: 'T' });
  assert.deepEqual(skipped, []);
  assert.deepEqual(effects.map((e) => [e.action, path.basename(e.path)]), [['deleted', 'readme-install.cjs'], ['edited', 'keep.txt']]);
  assert.equal(fs.existsSync(junk), false);
  assert.ok(effects[0].backup.startsWith(trashDir(env, 'h1')));
  assert.equal(fs.readFileSync(keep, 'utf8'), 'keep me, edited\n');
  undoFileEffect(effects[0]);
  assert.equal(fs.readFileSync(junk, 'utf8'), 'console.log("one-off");\n', 'the deleted file is back');
  undoFileEffect(effects[1]);
  assert.equal(fs.readFileSync(keep, 'utf8'), 'keep me\n', 'the edit is reverted');
});

test('a file changed during the run is left alone, and an undo refuses to overwrite newer work', () => {
  const { keep, ticket } = fixture();
  const env = { QUILL_HOME: tmp('st-home-') };
  const sandbox = tmp('st-sbx-');
  const files = stageFiles(ticket, sandbox);
  fs.writeFileSync(keep, 'someone else changed this\n');
  const r = applyFileRun({ env, handoffId: 'h2', sandbox, files, permissions: { delete_files: true }, deleteIds: ['f2'], now: 'T' });
  assert.deepEqual(r.effects, []);
  assert.match(r.skipped[0], /changed or removed during the run/);
  const sandbox2 = tmp('st-sbx-');
  const files2 = stageFiles(ticket, sandbox2);
  fs.writeFileSync(path.join(sandbox2, files2[1].staged), 'agent edit\n');
  const [edit] = applyFileRun({ env, handoffId: 'h3', sandbox: sandbox2, files: files2, permissions: { edit_files: true }, deleteIds: [], now: 'T' }).effects;
  fs.writeFileSync(keep, 'owner edit after the run\n');
  assert.throws(() => undoFileEffect(edit), (e) => e.code === 'file-changed');
  assert.equal(fs.readFileSync(keep, 'utf8'), 'owner edit after the run\n');
});

test('file permissions belong to files runs only, which get no repository access and need attached files', () => {
  const recipe = normalizeRecipe({ name: 'file-task', source: 'builtin', text: '---\nname: file-task\ndescription: d\nmode: files\npermissions: { edit_files: true, delete_files: true }\n---\nGo.' });
  assert.equal(recipe.error, null);
  assert.equal(recipe.schedulable, false);
  assert.match(normalizeRecipe({ name: 'x', source: 'personal', text: '---\nname: x\ndescription: d\npermissions: { delete_files: true }\n---\nGo.' }).error, /require mode files/);
  assert.match(normalizeRecipe({ name: 'x', source: 'personal', text: '---\nname: x\ndescription: d\nmode: files\npermissions: { read_source: true }\n---\nGo.' }).error, /cannot have repository permissions/);
  const ok = validateHandoffRequest({ recipe: 'file-task', note: '', permissions: { delete_files: true } }, { recipe, attachedFileCount: 1 });
  assert.equal(ok.permissions.delete_files, true);
  assert.throws(() => validateHandoffRequest({ recipe: 'file-task', note: '', permissions: { delete_files: true } }, { recipe, attachedFileCount: 0 }), (e) => e.code === 'files-required');
  assert.throws(() => validateHandoffRequest({ mode: 'analyse', note: '', permissions: { edit_files: true } }, {}), (e) => e.code === 'permission-dependency');
});

test('a files run reads and edits only inside its sandbox, with no shell, search or network', () => {
  const read = allowedToolsFor({ mode: 'files', permissions: {} });
  assert.deepEqual(read.allowed, ['Read(./**)']);
  for (const t of ['Bash', 'PowerShell', 'Glob', 'Grep', 'WebFetch', 'Edit', 'Write']) assert.ok(read.disallowed.includes(t), t);
  const edit = allowedToolsFor({ mode: 'files', permissions: { edit_files: true, delete_files: true } });
  assert.deepEqual(edit.allowed, ['Read(./**)', 'Edit(./**)', 'Write(./**)', 'MultiEdit(./**)']);
  assert.ok(!edit.disallowed.includes('Edit') && edit.disallowed.includes('Bash'));
  const p = buildPrompt({ id: 'h', mode: 'files', note: '', permissions: { delete_files: true } }, { key: 'PROJ-1', title: 'delete it', status: 'active', timeline: [], plans: [], conclusions: [] }, { recipe: { name: 'file-task', legacy: false, inputs: ['ticket'], outputs: ['summary'], body: 'Go.' }, context: { staged_files: [{ id: 'f1', path: 'C:/x/a.cjs', state: 'staged', staged: 'files/f1-a.cjs', size: 3 }] } });
  assert.match(p, /Attached files:\n- f1: C:\/x\/a\.cjs — copy at \.\/files\/f1-a\.cjs \(3 bytes\)/);
  assert.match(p, /"delete_files": \[/);
  assert.match(p, /list its id \(such as f1\) in "delete_files"/);
});

test('through the worker: a file-task run deletes an attached artifact into the trash, moves the ticket to review, and Undo restores it', async () => {
  const { junk, keep } = fixture();
  const b = await bootWorker({ runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_RESULT: JSON.stringify({ summary: 'readme-install.cjs is a one-off script; deleted it. keep.txt left alone.', next_action: 'Confirm and close', delete_files: ['f1'] }) } });
  try {
    const t = b.ticket(T1, 'PROJ-1', { repo_id: null });
    b.w.state.tickets.get(T1).files_touched.push({ relative_path: junk, first_seen: b.iso(), last_seen: b.iso() }, { relative_path: keep, first_seen: b.iso(), last_seen: b.iso() });
    b.request('44444444-0000-4000-8000-000000000001', { target_id: T1, expected_revision: t.revision, payload: { recipe: 'file-task', note: '', permissions: { ...NONE, delete_files: true } } });
    b.w.tick();
    const req = b.w.state.requests.get('44444444-0000-4000-8000-000000000001');
    assert.equal(req.state, 'applied', JSON.stringify(req.error));
    const hid = req.result.handoff_id;
    const done = await until(() => { b.w.tick(); const h = b.w.state.handoffs.get(hid); return ['done', 'failed'].includes(h.state) ? h : null; });
    assert.equal(done.state, 'done', JSON.stringify(done.error));
    assert.deepEqual(done.file_effects.map((e) => [e.action, path.basename(e.path)]), [['deleted', 'readme-install.cjs']]);
    assert.equal(fs.existsSync(junk), false);
    assert.ok(fs.existsSync(keep), 'a file the agent did not name is untouched');
    const ticket = b.w.state.tickets.get(T1);
    assert.equal(ticket.status, 'review', 'done by the agent, waiting for the owner');
    assert.ok(ticket.timeline.some((e) => /Deleted \(moved to Quill trash\) .*readme-install\.cjs/.test(e.text)));
    const undoId = '44444444-0000-4000-8000-000000000002';
    writeIngress(b.mk('request', { id: undoId, kind: 'undo-file-effect', target_id: T1, expected_revision: null, payload: { handoff_id: hid, effect_id: 'e1' }, created_at: b.iso(), not_before: b.iso(), actor_id: 'test', body_hash: 'x' }, { source_identity: `request:${undoId}` }), b.env);
    b.w.tick();
    const undo = await until(() => { b.w.tick(); const r = b.w.state.requests.get(undoId); return r && ['applied', 'failed'].includes(r.state) ? r : null; });
    assert.equal(undo.state, 'applied', JSON.stringify(undo.error));
    assert.equal(fs.readFileSync(junk, 'utf8'), 'console.log("one-off");\n');
    assert.ok(b.w.state.handoffs.get(hid).file_effects[0].undone_at);
  } finally { await b.w.stop(); }
});

test('dashboard: the file recipe shows only on tickets with attached files, lists them, leaves both permissions off, and offers Undo per change', async () => {
  const { renderAgentsSection, renderRecipeRunDialog } = await import('../../ui/views/agents.js');
  const recipe = { name: 'file-task', description: 'Do the task on attached files', source: 'builtin', mode: 'files', permissions: { ...NONE, edit_files: true, delete_files: true }, timeout_min: 10, legacy: false, repo_id: null, error: null };
  const base = { id: T1, key: 'PROJ-1', title: 'T', status: 'active', repo_id: null, files_touched: [], handoff_ids: [], tags: [], timeline: [], prs: [], deployments: [] };
  const snap = (ticket, handoffs = []) => ({ generation_id: 'g', tickets: [ticket], handoffs, recipes: [recipe], capabilities: { read: true, handoff: true, edit_tickets: true }, meta: { timezone: 'UTC' } });
  assert.doesNotMatch(renderAgentsSection(base, snap(base), { now: 'T' }), /file-task/, 'no attached files, no file recipe');
  const withFiles = { ...base, files_touched: [{ relative_path: 'C:/Users/me/Temp/readme-install.cjs' }, { relative_path: 'src/in-repo.js' }] };
  assert.match(renderAgentsSection(withFiles, snap(withFiles), { now: 'T' }), /file-task/);
  const dialog = renderRecipeRunDialog(recipe, withFiles, snap(withFiles));
  assert.match(dialog, /<code>C:\/Users\/me\/Temp\/readme-install\.cjs<\/code>/);
  assert.doesNotMatch(dialog, /in-repo\.js/);
  assert.match(dialog, /name="edit_files">/);
  assert.match(dialog, /name="delete_files">/);
  assert.doesNotMatch(dialog, /name="(edit|delete)_files" checked/);
  const h = { id: 'h1', ticket_id: T1, state: 'done', mode: 'files', recipe: { name: 'file-task' }, legacy: false, requested_at: 'T', suggestions: [], file_effects: [{ id: 'e1', action: 'deleted', path: 'C:/Users/me/Temp/readme-install.cjs', undone_at: null }, { id: 'e2', action: 'edited', path: 'C:/x/b.txt', undone_at: 'T' }] };
  const html = renderAgentsSection({ ...withFiles, handoff_ids: ['h1'] }, snap({ ...withFiles, handoff_ids: ['h1'] }, [h]), { now: 'T' });
  assert.match(html, /Deleted<\/span> <code>C:\/Users\/me\/Temp\/readme-install\.cjs<\/code> <button[^>]*data-action="undo-file-effect"[^>]*data-effect="e1"/);
  assert.match(html, /Edited<\/span> <code>C:\/x\/b\.txt<\/code> <span class="chip small">Undone<\/span>/);
});
