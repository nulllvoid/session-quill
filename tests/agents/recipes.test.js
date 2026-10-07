import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeRecipe, loadRecipes, renderRecipe, permissionsBeyond, createRecipeCatalog, recipeTools, BUILTIN_DIR } from '../../src/agents/recipes.js';

const DEPLOY_CHECK = [
  '---',
  'name: deploy-check',
  "description: Verify stage/prod deployment for a ticket's merged PRs",
  'mode: analyse',
  'permissions: { read_source: true, edit_source: false, commit: false, push: false, draft_pr: false }',
  'tools: [Read, Grep, "Bash(git log:*)"]',
  'timeout_min: 10',
  'inputs: [ticket, prs, deployments]',
  'outputs: [deploy_evidence, next_action]',
  '---',
  'For {{ticket.key}} ({{ticket.url}}): for each merged PR {{prs}}, find the image tag.',
].join('\n');

const recipe = (body, extra = '') => `---\nname: r\ndescription: test\n${extra}---\n${body}`;

test('recipes: the proposal example normalizes, with push and draft_pr as aliases', () => {
  const r = normalizeRecipe({ name: 'deploy-check', text: DEPLOY_CHECK, source: 'repo' });
  assert.equal(r.error, null);
  assert.deepEqual(r.permissions, { read_source: true, edit_source: false, commit: false, push_branch: false, open_draft_pr: false, edit_files: false, delete_files: false });
  assert.deepEqual([r.mode, r.timeout_min, r.legacy, r.schedulable], ['analyse', 10, false, true]);
  assert.deepEqual(r.outputs, ['deploy_evidence', 'next_action']);
  assert.deepEqual(r.tools, ['Read', 'Grep', 'Bash(git log:*)']);
  assert.match(r.hash, /^[0-9a-f]{64}$/);
});

test('recipes: invalid frontmatter becomes a listed error, never a runnable recipe', () => {
  const cases = [
    [recipe('x'), 'other-name', /must match the file name/],
    [recipe('x', 'permissions: { sudo: true }\n'), 'r', /unknown permission "sudo"/],
    [recipe('x', 'permissions: { commit: true }\n'), 'r', /commit requires edit_source/],
    [recipe('x', 'permissions: { read_source: true, edit_source: true }\n'), 'r', /edit_source requires mode attempt-fix/],
    [recipe('x', 'mode: deploy\n'), 'r', /mode must be one of/],
    [recipe('x', 'tools: [Edit]\n'), 'r', /tool "Edit" needs more than this recipe's permissions/],
    [recipe('x', 'permissions: { read_source: true }\ntools: ["Bash(rm -rf:*)"]\n'), 'r', /tool "Bash\(rm -rf:\*\)"/],
    [recipe('x', 'timeout_min: 45\n'), 'r', /timeout_min must be a whole number from 1 to 20/],
    [recipe('x', 'outputs: [poem]\n'), 'r', /unknown output "poem"/],
    [recipe('For {{ticket.secret}}'), 'r', /unknown placeholder \{\{ticket\.secret\}\}/],
    [recipe('   '), 'r', /prompt body is empty/],
    ['no frontmatter', 'r', /must start with ---/],
  ];
  for (const [text, name, re] of cases) {
    const r = normalizeRecipe({ name, text, source: 'personal' });
    assert.match(String(r.error), re, `${name}: ${text}`);
  }
});

test('recipes: a read-only recipe may narrow its tools; git log is accepted in either spelling', () => {
  const r = normalizeRecipe({ name: 'r', text: recipe('x', 'permissions: { read_source: true }\ntools: [Read, "Bash(git log --oneline:*)", "Bash(git show*)"]\n'), source: 'repo' });
  assert.equal(r.error, null);
  const t = recipeTools(r, r.permissions);
  assert.deepEqual(t.allowed, ['Read'], 'kept git read rules are left to the runtime\'s read-only check');
  assert.ok(!t.disallowed.includes('Bash(git log*)') && !t.disallowed.includes('Bash(git show*)') && t.disallowed.includes('Bash(git diff*)'));
  assert.ok(t.disallowed.includes('Edit'));
  assert.deepEqual(recipeTools(r, { read_source: false }).allowed, [], 'without source access the run gets no tools at all');
});

test('recipes: built-ins ship the three handoff modes plus deploy-check and standup, all valid', () => {
  const { effective } = loadRecipes({ env: { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'st-rec-')) } });
  assert.deepEqual([...effective.keys()].sort(), ['analyse', 'analyse-followups', 'attempt-fix', 'deploy-check', 'file-task', 'standup']);
  assert.deepEqual([effective.get('file-task').mode, effective.get('file-task').schedulable], ['files', false], 'a files run is never scheduled');
  for (const r of effective.values()) assert.equal(r.error, null, r.name);
  assert.deepEqual(['analyse', 'analyse-followups', 'attempt-fix'].map((n) => effective.get(n).legacy), [true, true, true]);
  assert.equal(effective.get('deploy-check').legacy, false);
  assert.equal(effective.get('attempt-fix').schedulable, false);
  assert.match(effective.get('analyse').body, /Do not propose child tickets/);
  assert.ok(fs.existsSync(path.join(BUILTIN_DIR, 'standup.md')));
});

test('recipes: repo overrides personal overrides built-in; invalid files are listed with their error', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-rec-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-rec-repo-'));
  fs.mkdirSync(path.join(home, 'agents'));
  fs.mkdirSync(path.join(repo, '.quill', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents', 'standup.md'), '---\nname: standup\ndescription: mine\n---\nPersonal standup for {{ticket.key}}');
  fs.writeFileSync(path.join(home, 'agents', 'triage.md'), '---\nname: triage\ndescription: personal triage\n---\nTriage {{ticket.title}}');
  fs.writeFileSync(path.join(repo, '.quill', 'agents', 'triage.md'), '---\nname: triage\ndescription: team triage\n---\nTeam triage {{ticket.key}}');
  fs.writeFileSync(path.join(repo, '.quill', 'agents', 'broken.md'), '---\nname: broken\ndescription: x\npermissions: { push: true }\n---\nx');
  fs.writeFileSync(path.join(repo, '.quill', 'agents', 'notes.txt'), 'ignored');
  const { effective, all } = loadRecipes({ env: { QUILL_HOME: home }, repoPath: repo });
  assert.equal(effective.get('standup').description, 'mine');
  assert.deepEqual([effective.get('triage').source, effective.get('triage').description], ['repo', 'team triage']);
  assert.equal(all.find((r) => r.name === 'triage' && r.source === 'personal').overridden_by, 'repo');
  assert.match(effective.get('broken').error, /push_branch requires commit/);
  assert.ok(!all.some((r) => r.name === 'notes'));
});

test('recipes: rendering fills placeholders from ticket data as plain text', () => {
  const r = normalizeRecipe({ name: 'deploy-check', text: DEPLOY_CHECK, source: 'repo' });
  const out = renderRecipe(r, { ticket: { key: 'PROJ-7', title: 'T', status: 'deploy-pending', next_action: '' }, url: 'https://example.atlassian.net/browse/PROJ-7', prs: [{ url: 'https://github.com/a/b/pull/3', state: 'merged', merged_at: '2026-10-01T10:00:00Z' }], deployments: [] });
  assert.match(out, /^For PROJ-7 \(https:\/\/example\.atlassian\.net\/browse\/PROJ-7\): for each merged PR https:\/\/github\.com\/a\/b\/pull\/3 \(merged 2026-10-01T10:00:00Z\), find/);
  assert.match(renderRecipe(r, { ticket: { key: 'K-1' }, url: null, prs: [], deployments: [] }), /K-1 \(no tracker link\)/);
});

test('recipes: requested permissions may narrow the recipe but never exceed it', () => {
  const ceiling = { read_source: true, edit_source: false, commit: false, push_branch: false, open_draft_pr: false };
  assert.deepEqual(permissionsBeyond({ read_source: false }, ceiling), []);
  assert.deepEqual(permissionsBeyond({ read_source: true, edit_source: true, commit: true }, ceiling), ['edit_source', 'commit']);
});

test('recipes: the catalog caches per repository and re-reads after its refresh interval', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-rec-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'st-rec-repo-'));
  fs.mkdirSync(path.join(repo, '.quill', 'agents'), { recursive: true });
  let now = 0;
  const cat = createRecipeCatalog({ env: { QUILL_HOME: home }, config: { repos: { app: { canonical_path: repo } } }, clock: () => now, ttlMs: 1000 });
  assert.equal(cat.get('triage', 'app'), null);
  fs.writeFileSync(path.join(repo, '.quill', 'agents', 'triage.md'), '---\nname: triage\ndescription: d\n---\nx');
  assert.equal(cat.get('triage', 'app'), null, 'cached');
  assert.equal(cat.get('triage', 'app', { fresh: true }).source, 'repo');
  now = 2000;
  assert.equal(cat.get('triage', 'app').source, 'repo');
  assert.equal(cat.get('triage', null), null, 'repo recipes apply only to that repository');
  const listed = cat.list();
  assert.ok(listed.some((r) => r.name === 'triage' && r.repo_id === 'app' && !('body' in r) && !('path' in r)));
  assert.ok(listed.some((r) => r.name === 'analyse' && r.repo_id === null));
});

test('recipes: work, related and history are inputs; self_check must be a boolean; the built-ins check deploy and fix replies', () => {
  const ok = normalizeRecipe({ name: 'r', source: 'personal', text: recipe('Go.', 'inputs: [ticket, work, related, history]\nself_check: true\n') });
  assert.equal(ok.error, null);
  assert.deepEqual([ok.inputs, ok.self_check], [['ticket', 'work', 'related', 'history'], true]);
  assert.match(normalizeRecipe({ name: 'r', source: 'personal', text: recipe('Go.', 'self_check: yes\n') }).error, /self_check must be true or false/);
  assert.equal(normalizeRecipe({ name: 'r', source: 'personal', text: recipe('Go.') }).self_check, false);
  const { effective } = loadRecipes({ env: { QUILL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'st-r-')) } });
  assert.deepEqual(['analyse', 'analyse-followups', 'attempt-fix', 'deploy-check', 'standup'].map((n) => effective.get(n).self_check), [false, false, true, true, false]);
  for (const r of effective.values()) assert.equal(r.error, null, `${r.name}: ${r.error}`);
});
