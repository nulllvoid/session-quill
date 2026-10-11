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
