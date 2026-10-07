import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, startWorker, cli, DESC } from './helpers.js';
import { parseDescription, descriptionProblems, normalizeDescription, DESCRIPTION_TEMPLATE } from '../../src/core/description.js';

const list = async (env) => JSON.parse((await cli(['ticket', 'list', '--json'], env)).out);
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('condition not met in time'); await new Promise((r) => setTimeout(r, 50)); }
};

test('descriptions are parsed in any common spelling of the labels and checked for each part', () => {
  const d = parseDescription('Goal: Make retry() call fn attempts times.\nContext:\n retry.js:4 stops one early.\n## Done when\n* attempts 3 calls fn 3 times\n2. npm test passes');
  assert.deepEqual(d, { goal: 'Make retry() call fn attempts times.', context: 'retry.js:4 stops one early.', done: ['attempts 3 calls fn 3 times', 'npm test passes'] });
  assert.deepEqual(descriptionProblems(DESC), []);
  assert.deepEqual(descriptionProblems(''), ['the description is empty']);
  assert.deepEqual(descriptionProblems('**Goal:** short'), ['"**Goal:**" needs a full sentence', '"**Context:**" is missing or empty', '"**Done when:**" needs at least one "- " item']);
  assert.equal(normalizeDescription('**Goal:** a\\n**Context:** b'), '**Goal:** a\n**Context:** b', 'a shell-escaped \\n becomes a line break');
  assert.match(descriptionProblems(`${DESC}\n${'x'.repeat(4000)}`)[0], /keep it under 4000/);
  assert.ok(descriptionProblems(DESCRIPTION_TEMPLATE).length === 0, 'the template itself has the shape it asks for');
});

test('ticket create and work require a description in the format, and say how to write one', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    const missing = await cli(['ticket', 'create', 'No description', '--session', 's1'], fx.env);
    assert.notEqual(missing.code, 0);
    assert.match(missing.err, /description is required/);
    assert.match(missing.err, /\*\*Goal:\*\*.*\n\n\*\*Context:\*\*/s, 'the error shows the template');
    const bad = await cli(['ticket', 'work', 'Bad description', '--description', 'fix it', '--session', 's1'], fx.env);
    assert.notEqual(bad.code, 0);
    assert.match(bad.err, /not valid: .*"\*\*Context:\*\*" is missing/);
    assert.equal((await list(fx.env)).length, 0, 'nothing was created');
    const escaped = DESC.replace(/\n/g, '\\n');
    const ok = await cli(['ticket', 'create', 'Good one', '--description', escaped, '--session', 's1'], fx.env);
    assert.equal(ok.code, 0, ok.err);
    const [t] = await list(fx.env);
    assert.equal(t.summary, DESC, 'stored with real line breaks');
  } finally { await w.stop(); }
});

test('ticket set --description fills or replaces it; work fills a reused ticket only when its description is missing', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    w.worker.emit('ticket-create', { ticket: { id: 'aaaaaaaa-0000-4000-8000-000000000001', key: 'OPS-7', title: 'Rotate keys', project_id: 'demo', project_name: 'Demo', category: 'infra', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } }, { source_identity: 'test:ops-7' });
    await until(async () => (await list(fx.env)).length === 1);
    const other = DESC.replace('Exercise the ticket under test end to end.', 'Rotate the signing keys before they expire.');
    const reused = await cli(['ticket', 'work', 'Rotate keys', '--description', other, '--category', 'infra', '--project', 'demo', '--repo', 'demo', '--session', 's2'], fx.env);
    assert.equal(reused.code, 0, reused.err);
    assert.match(reused.out, /Reused OPS-7/);
    assert.equal((await list(fx.env))[0].summary, other, 'the reused ticket had none, so it takes this one');
    assert.equal((await cli(['ticket', 'work', 'Rotate keys', '--description', DESC, '--category', 'infra', '--project', 'demo', '--repo', 'demo', '--session', 's3'], fx.env)).code, 0);
    assert.equal((await list(fx.env))[0].summary, other, 'a valid description is never replaced by reuse');
    const badSet = await cli(['ticket', 'set', 'OPS-7', '--description', 'nope'], fx.env);
    assert.notEqual(badSet.code, 0);
    assert.equal((await cli(['ticket', 'set', 'OPS-7', '--description', DESC], fx.env)).code, 0);
    assert.equal((await list(fx.env))[0].summary, DESC, 'set replaces it on purpose');
  } finally { await w.stop(); }
});

test('a session on a ticket without a description is asked to write one, until it has one', async () => {
  const fx = makeHome();
  const w = await startWorker(fx);
  try {
    w.worker.emit('ticket-create', { ticket: { id: 'aaaaaaaa-0000-4000-8000-000000000002', key: 'OPS-8', title: 'From a tracker key', project_id: 'demo', project_name: 'Demo', category: 'infra', priority: 'P2', parent_id: null, repo_id: 'demo', due: null, jira: null } }, { source_identity: 'test:ops-8' });
    await until(async () => (await list(fx.env)).length === 1);
    assert.equal((await cli(['ticket', 'bind', 'OPS-8', '--session', 'nudge-session'], fx.env)).code, 0);
    const prompt = async () => JSON.parse((await cli(['hook', 'UserPromptSubmit'], fx.env, { stdin: JSON.stringify({ session_id: 'nudge-session', prompt: 'carry on', cwd: process.cwd() }) })).out).hookSpecificOutput.additionalContext;
    assert.match(await prompt(), /ticket OPS-8 has no valid description\. .*ticket set OPS-8 --description/);
    assert.match(await prompt(), /--description "<description>"/, 'the task instructions name the flag as well');
    assert.equal((await cli(['ticket', 'set', 'OPS-8', '--description', DESC], fx.env)).code, 0);
    await until(async () => !/has no valid description/.test(await prompt()));
  } finally { await w.stop(); }
});
