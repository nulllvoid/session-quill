import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bootWorker, makeRepo, until, T1 } from '../handoff/helpers.js';
import { submitRequest } from '../../src/server/requests.js';

const RID = (n) => `33333333-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NONE = { read_source: false, edit_source: false, commit: false, push_branch: false, open_draft_pr: false };
const RESULT = {
  summary: 'Production has the v1.2 tag; staging was never targeted.',
  next_action: 'Confirm the production rollout with the release owner',
  blocker: null,
  children: [{ title: 'Should not appear', category: 'bugfix', priority: 'P2' }],
  deploy_evidence: [
    { environment: 'production', state: 'deployed', evidence: 'deploy/values.yaml tag bump to v1.2 in 3f2a1c9', deployed_at: '2026-10-01T15:00:00Z' },
    { environment: 'staging', state: 'n-a', evidence: 'this service has no staging target' },
  ],
  comment_draft: 'not declared by deploy-check',
};

async function boot(extra = {}) {
  const repo = makeRepo();
  const capture = path.join(repo.dir, '..', `capture-${randomUUID()}.json`);
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_RESULT: JSON.stringify(RESULT), FAKE_CLAUDE_CAPTURE: capture }, ...extra });
  return { b, repo, capture };
}

async function runToDone(b, rid, payload, t) {
  b.request(rid, { target_id: T1, expected_revision: t.revision, payload });
  b.w.tick();
  const req = b.w.state.requests.get(rid);
  assert.equal(req.state, 'applied', JSON.stringify(req.error));
  const hid = req.result.handoff_id;
  return until(() => { b.w.tick(); const h = b.w.state.handoffs.get(hid); return ['done', 'failed'].includes(h.state) ? h : null; });
}

test('a recipe run uses its prompt, tools and time cap; declared outputs become suggestions instead of edits', async () => {
  const { b, capture } = await boot();
  try {
    const t = b.ticket(T1, 'PROJ-7');
    const h = await runToDone(b, RID(1), { recipe: 'deploy-check', note: '', permissions: { ...NONE, read_source: true } }, t);
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    assert.deepEqual([h.recipe.name, h.recipe.source, h.mode], ['deploy-check', 'builtin', 'analyse']);
    assert.equal(Date.parse(h.deadline_at) - Date.parse(h.started_at), 10 * 60_000, 'deploy-check caps itself at 10 minutes');
    const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.match(seen.prompt, /Check the deployment state of PROJ-7/);
    assert.match(seen.prompt, /BEGIN TICKET NOTES \(data\)/);
    const allowed = seen.args.slice(seen.args.indexOf('--allowedTools') + 1, seen.args.indexOf('--disallowedTools'));
    assert.deepEqual(allowed, ['Read', 'Grep', 'Glob'], 'git log/show stay with the runtime\'s read-only check, not an allow rule');
    const denied = seen.args.slice(seen.args.indexOf('--disallowedTools') + 1);
    assert.ok(denied.includes('Bash(git diff*)') && denied.includes('Bash(git log *--output*)'));
    assert.ok(!denied.includes('Bash(git log*)') && !denied.includes('Bash(git show*)'), 'the recipe keeps git log and git show');
    const ticket = b.w.state.tickets.get(T1);
    assert.equal(ticket.next_action, '', 'nothing is applied without acceptance');
    assert.equal(ticket.children_ids.length, 0);
    assert.deepEqual(h.suggestions.map((s) => [s.type, s.state]), [['next-action', 'proposed'], ['deploy-evidence', 'proposed']], 'undeclared outputs are dropped');
    assert.equal(h.suggestions[1].items.length, 2);
  } finally { await b.w.stop(); }
});

test('accepting a suggestion is a revision-checked request; dismissing one changes nothing on the ticket', async () => {
  const { b } = await boot();
  try {
    const t = b.ticket(T1, 'PROJ-7');
    const h = await runToDone(b, RID(2), { recipe: 'deploy-check', note: '', permissions: { ...NONE, read_source: true } }, t);
    const [next, evidence] = h.suggestions;
    const ticket = b.w.state.tickets.get(T1);
    ticket.deployments.push({ id: 'd1', pr_id: 'pr1', environment: 'production', state: 'pending', merged_at: '2026-10-01T12:00:00Z', deployed_at: null, evidence: null, waiver_reason: null, source_event_id: null });
    const stale = submitRequest(b.w, { id: randomUUID(), kind: 'accept-suggestion', target_id: T1, expected_revision: ticket.revision - 1, payload: { handoff_id: h.id, suggestion_id: next.id } }).request;
    b.advance(11_000);
    b.w.tick();
    assert.equal(b.w.state.requests.get(stale.id).state, 'conflict');
    const ok = submitRequest(b.w, { id: randomUUID(), kind: 'accept-suggestion', target_id: T1, expected_revision: ticket.revision, payload: { handoff_id: h.id, suggestion_id: next.id } }).request;
    b.advance(11_000);
    b.w.tick();
    assert.equal(b.w.state.requests.get(ok.id).state, 'applied');
    assert.equal(b.w.state.tickets.get(T1).next_action, 'Confirm the production rollout with the release owner');
    assert.equal(b.w.state.handoffs.get(h.id).suggestions[0].state, 'accepted');
    assert.throws(() => submitRequest(b.w, { id: randomUUID(), kind: 'accept-suggestion', target_id: T1, expected_revision: b.w.state.tickets.get(T1).revision, payload: { handoff_id: h.id, suggestion_id: next.id } }), (e) => e.code === 'suggestion-resolved');
    const ev = submitRequest(b.w, { id: randomUUID(), kind: 'accept-suggestion', target_id: T1, expected_revision: b.w.state.tickets.get(T1).revision, payload: { handoff_id: h.id, suggestion_id: evidence.id } }).request;
    b.advance(11_000);
    b.w.tick();
    assert.equal(b.w.state.requests.get(ev.id).state, 'applied', JSON.stringify(b.w.state.requests.get(ev.id).error));
    const d = b.w.state.tickets.get(T1).deployments.find((x) => x.id === 'd1');
    assert.deepEqual([d.state, d.deployed_at, d.evidence], ['deployed', '2026-10-01T15:00:00Z', 'deploy/values.yaml tag bump to v1.2 in 3f2a1c9']);
    const before = b.w.state.tickets.get(T1).revision;
    const h2 = await runToDone(b, RID(3), { recipe: 'deploy-check', note: '', permissions: { ...NONE, read_source: true } }, b.w.state.tickets.get(T1));
    const dis = submitRequest(b.w, { id: randomUUID(), kind: 'dismiss-suggestion', target_id: T1, expected_revision: null, payload: { handoff_id: h2.id, suggestion_id: h2.suggestions[0].id } }).request;
    b.advance(11_000);
    b.w.tick();
    assert.equal(b.w.state.requests.get(dis.id).state, 'applied');
    assert.equal(b.w.state.handoffs.get(h2.id).suggestions[0].state, 'dismissed');
    assert.equal(b.w.state.tickets.get(T1).next_action, 'Confirm the production rollout with the release owner');
    assert.ok(b.w.state.tickets.get(T1).revision >= before);
  } finally { await b.w.stop(); }
});

test('a recipe cannot be granted more than its frontmatter; unknown and invalid recipes are refused', async () => {
  const { b } = await boot();
  try {
    const t = b.ticket(T1, 'PROJ-7');
    fs.mkdirSync(path.join(b.home, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(b.home, 'agents', 'broken.md'), '---\nname: broken\ndescription: x\npermissions: { commit: true }\n---\nx');
    const body = (payload) => ({ id: randomUUID(), kind: 'handoff', target_id: T1, expected_revision: t.revision, payload });
    assert.throws(() => submitRequest(b.w, body({ recipe: 'standup', note: '', permissions: { ...NONE, read_source: true } })), (e) => e.code === 'permission-beyond-recipe' && /read_source/.test(e.message));
    assert.throws(() => submitRequest(b.w, body({ recipe: 'nope', note: '', permissions: NONE })), (e) => e.code === 'recipe-unknown');
    assert.throws(() => submitRequest(b.w, body({ recipe: 'broken', note: '', permissions: NONE })), (e) => e.code === 'recipe-invalid' && /commit requires edit_source/.test(e.message));
    // The CLI path skips submit validation; the worker re-checks when it applies the request.
    b.request(RID(4), { target_id: T1, expected_revision: t.revision, payload: { recipe: 'standup', note: '', permissions: { ...NONE, read_source: true } } });
    b.w.tick();
    assert.deepEqual([b.w.state.requests.get(RID(4)).state, b.w.state.requests.get(RID(4)).error.code], ['failed', 'permission-beyond-recipe']);
  } finally { await b.w.stop(); }
});

test('a recipe edited after it was queued fails at dispatch instead of running with permissions nobody reviewed', async () => {
  const { b } = await boot();
  try {
    const t = b.ticket(T1, 'PROJ-7');
    const dir = path.join(b.home, 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'triage.md'), '---\nname: triage\ndescription: Triage\npermissions: { read_source: true }\n---\nTriage {{ticket.key}}');
    b.hext.pause();
    b.request(RID(5), { target_id: T1, expected_revision: t.revision, payload: { recipe: 'triage', note: '', permissions: NONE } });
    b.w.tick();
    const hid = b.w.state.requests.get(RID(5)).result.handoff_id;
    assert.equal(b.w.state.handoffs.get(hid).recipe.source, 'personal');
    fs.writeFileSync(path.join(dir, 'triage.md'), '---\nname: triage\ndescription: Triage\npermissions: { read_source: true }\n---\nTriage {{ticket.key}} and also everything else');
    b.hext.resume();
    const h = await until(() => { b.w.tick(); const x = b.w.state.handoffs.get(hid); return x.state === 'failed' ? x : null; });
    assert.equal(h.error.code, 'recipe-changed');
  } finally { await b.w.stop(); }
});

test('the handoff form and quill handoff still work: a mode request runs the built-in recipe of that name', async () => {
  const { b } = await boot({ fakeEnv: {} });
  try {
    const t = b.ticket(T1, 'PROJ-7');
    const h = await runToDone(b, RID(6), { mode: 'analyse-followups', note: '', permissions: NONE, branch: null }, t);
    assert.equal(h.state, 'done');
    assert.deepEqual([h.recipe.name, h.recipe.source], ['analyse-followups', 'builtin']);
    assert.equal(b.w.state.tickets.get(T1).children_ids.length, 2, 'built-in modes keep applying their results directly');
    assert.equal((h.suggestions ?? []).length, 0);
  } finally { await b.w.stop(); }
});

test('the snapshot lists available recipes with their permissions, without file paths or full prompts', async () => {
  const { b } = await boot();
  try {
    const snap = b.w.liveSnapshot();
    const dc = snap.recipes.find((r) => r.name === 'deploy-check');
    assert.deepEqual([dc.source, dc.repo_id, dc.permissions.read_source, dc.timeout_min], ['builtin', null, true, 10]);
    assert.ok(snap.recipes.every((r) => !('path' in r) && !('body' in r)));
    assert.ok(!JSON.stringify(snap.recipes).includes(b.home));
  } finally { await b.w.stop(); }
});

test('exports carry recipe suggestions only when checkpoints are included, like result summaries', async () => {
  const { sanitizeSnapshot } = await import('../../src/export/sanitize.js');
  const snap = { tickets: [{ id: T1, key: 'PROJ-7', project_id: 'demo', title: 't', status: 'todo', timeline: [], deployments: [], prs: [] }], handoffs: [{ id: 'h1', ticket_id: T1, state: 'done', recipe: { name: 'deploy-check' }, suggestions: [{ id: 's1', type: 'comment-draft', state: 'proposed', text: 'internal draft text' }] }], meta: {}, recipes: [{ name: 'x' }] };
  const plain = sanitizeSnapshot(snap, { fields: ['key', 'title', 'status'] });
  assert.deepEqual(plain.handoffs[0].suggestions, []);
  assert.ok(!('recipes' in plain));
  const full = sanitizeSnapshot(snap, { fields: ['key', 'title', 'status'], includeCheckpoints: true });
  assert.equal(full.handoffs[0].suggestions[0].text, 'internal draft text');
});

test('a reply without its JSON block gets one repair turn in the same session, and the run says so', async () => {
  const capture2 = path.join(makeRepo().dir, '..', `capture-${randomUUID()}.json`);
  const { b: b2 } = await boot({ fakeEnv: { FAKE_CLAUDE_MODE: 'malformed', FAKE_CLAUDE_RESULT: JSON.stringify({ ...RESULT, confidence: 'low', sources: ['deploy/values.yaml'] }), FAKE_CLAUDE_CAPTURE: capture2 } });
  try {
    const t = b2.ticket(T1, 'PROJ-8');
    const h = await runToDone(b2, RID(20), { recipe: 'standup', note: '', permissions: NONE }, t);
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    assert.equal(h.result_summary, RESULT.summary, 'the repaired reply is the result');
    assert.deepEqual([h.result_quality.repaired, h.result_quality.problems], [true, []]);
    assert.deepEqual([h.result_confidence, h.result_sources], ['low', ['deploy/values.yaml']]);
    const turns = fs.readFileSync(`${capture2}.resume`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(turns.length, 1, 'standup has no self-check, so only the repair turn ran');
    assert.match(turns[0].prompt, /no fenced ```json block/);
    assert.equal(turns[0].args[turns[0].args.indexOf('--resume') + 1], 'fake-session');
  } finally { await b2.w.stop(); }
});

test('a repair that still breaks the contract leaves the first reply and records the problems', async () => {
  const { b } = await boot({ fakeEnv: { FAKE_CLAUDE_MODE: 'malformed', FAKE_CLAUDE_RESUME_RESULT: 'malformed' } });
  try {
    const t = b.ticket(T1, 'PROJ-9');
    const h = await runToDone(b, RID(21), { recipe: 'standup', note: '', permissions: NONE }, t);
    assert.equal(h.state, 'done');
    assert.equal(h.result_summary, null);
    assert.equal(h.result_quality.repaired, false);
    assert.match(h.result_quality.problems.join(' '), /no fenced/);
    assert.deepEqual(h.suggestions, []);
  } finally { await b.w.stop(); }
});

test('a self-checking recipe verifies its reply in a read-only follow-up turn and keeps the checked answer', async () => {
  const checked = { ...RESULT, summary: 'Checked: production has the v1.2 tag.', confidence: 'high', sources: ['deploy/values.yaml@3f2a1c9'] };
  const repo = makeRepo();
  const capture = path.join(repo.dir, '..', `capture-${randomUUID()}.json`);
  const b = await bootWorker({ repo, runtimeAvailable: true, fakeEnv: { FAKE_CLAUDE_RESULT: JSON.stringify(RESULT), FAKE_CLAUDE_RESUME_RESULT: JSON.stringify(checked), FAKE_CLAUDE_CAPTURE: capture } });
  try {
    const t = b.ticket(T1, 'PROJ-10');
    const h = await runToDone(b, RID(22), { recipe: 'deploy-check', note: '', permissions: { ...NONE, read_source: true } }, t);
    assert.equal(h.state, 'done', JSON.stringify(h.error));
    assert.deepEqual([h.result_quality.self_checked, h.result_quality.repaired], [true, false]);
    assert.equal(h.result_summary, checked.summary);
    assert.equal(h.result_confidence, 'high');
    const [turn] = fs.readFileSync(`${capture}.resume`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.match(turn.prompt, /check your answer/i);
    const denied = turn.args.slice(turn.args.indexOf('--disallowedTools') + 1);
    assert.ok(denied.includes('Edit') && denied.includes('Write'), 'the self-check never edits');
  } finally { await b.w.stop(); }
});

test('run detail shows confidence, checks and sources; exports keep sources only with checkpoints', async () => {
  const { renderAgentsSection } = await import('../../ui/views/agents.js');
  const { sanitizeSnapshot } = await import('../../src/export/sanitize.js');
  const h = { id: 'h9', ticket_id: T1, state: 'done', mode: 'analyse', recipe: { name: 'deploy-check', source: 'builtin' }, legacy: false, requested_at: '2026-10-02T08:00:00Z', result_summary: 'ok', result_confidence: 'low', result_sources: ['deploy/values.yaml@3f2a1c9'], result_quality: { problems: [], repaired: true, self_checked: true }, suggestions: [] };
  const ticket = { id: T1, key: 'PROJ-1', title: 'T', status: 'active', project_id: 'demo', repo_id: null, handoff_ids: ['h9'], tags: [], timeline: [], prs: [], deployments: [] };
  const snap = { generation_id: 'g', tickets: [ticket], handoffs: [h], recipes: [], capabilities: { read: true, handoff: true, edit_tickets: true }, meta: { timezone: 'UTC' } };
  const html = renderAgentsSection(ticket, snap, { now: '2026-10-02T09:00:00Z' });
  for (const re of [/Low confidence/, /Self-checked/, /Repaired reply/, /1 source</, /deploy\/values\.yaml@3f2a1c9/]) assert.match(html, re);
  const exported = sanitizeSnapshot({ ...snap, sessions: [], checkpoints: [] }, { fields: ['key', 'title', 'status'] });
  assert.equal(JSON.stringify(exported.handoffs).includes('values.yaml'), false);
  assert.equal('result_quality' in exported.handoffs[0], false);
  const withCp = sanitizeSnapshot({ ...snap, sessions: [], checkpoints: [] }, { fields: ['key', 'title', 'status'], includeCheckpoints: true });
  assert.deepEqual([withCp.handoffs[0].result_confidence, withCp.handoffs[0].result_sources], ['low', ['deploy/values.yaml@3f2a1c9']]);
});

test('a recipe that declares description offers it as a suggestion; accepting it sets the description', async () => {
  const { buildSuggestions, suggestionMutation } = await import('../../src/agents/suggestions.js');
  const desc = '**Goal:** Ship the deploy check.\n\n**Context:** deploy/values.yaml.\n\n**Done when:**\n- production shows v1.2';
  const [sug] = buildSuggestions(['summary', 'description'], { description: desc }, '2026-10-02T09:00:00Z');
  assert.deepEqual([sug.type, sug.text], ['description', desc]);
  const m = suggestionMutation({}, { id: T1, deployments: [], prs: [] }, { id: 'h1' }, sug, 'accepted');
  assert.deepEqual(m.fields, { summary: desc });
  assert.deepEqual(buildSuggestions(['summary'], { description: desc }, 'x'), [], 'undeclared, it is dropped');
});

test('ticket detail shows the description as Goal, Context and Done when, and flags a missing one', async () => {
  const { renderDetail } = await import('../../ui/views/detail.js');
  const { ticketSummary } = await import('../../src/worker/projections.js');
  const { sanitizeSnapshot } = await import('../../src/export/sanitize.js');
  const base = { id: T1, key: 'PROJ-1', title: 'T', status: 'active', project_id: 'demo', repo_id: null, timeline: [], prs: [], deployments: [], tags: [], plans: [], conclusions: [], files_touched: [], children_ids: [], handoff_ids: [] };
  const desc = '**Goal:** Ship the deploy check.\n\n**Context:** deploy/values.yaml <b>tag</b>.\n\n**Done when:**\n- production shows v1.2';
  const valid = ticketSummary({ ...base, summary: desc });
  const snap = { generation_id: 'g', tickets: [valid], handoffs: [], recipes: [], sessions: [], checkpoints: [], capabilities: { read: true }, meta: { timezone: 'UTC' } };
  const html = renderDetail(valid, snap, { now: '2026-10-02T09:00:00Z' });
  assert.match(html, /<dt>Goal<\/dt><dd>Ship the deploy check\.<\/dd>/);
  assert.match(html, /&lt;b&gt;tag&lt;\/b&gt;/, 'escaped');
  assert.match(html, /<li>production shows v1\.2<\/li>/);
  const missing = ticketSummary({ ...base, summary: '' });
  assert.match(renderDetail(missing, { ...snap, tickets: [missing] }, { now: '2026-10-02T09:00:00Z' }), /Missing description[\s\S]*quill ticket set PROJ-1 --description/);
  const loose = ticketSummary({ ...base, summary: 'just some text' });
  assert.match(renderDetail(loose, { ...snap, tickets: [loose] }, { now: '2026-10-02T09:00:00Z' }), /not in the required format[\s\S]*just some text/);
  assert.equal('description' in sanitizeSnapshot(snap, { fields: ['key', 'title'] }).tickets[0], false, 'not exported without the summary');
  assert.equal(sanitizeSnapshot(snap, { fields: ['key', 'title', 'summary'] }).tickets[0].description.goal, 'Ship the deploy check.');
});
