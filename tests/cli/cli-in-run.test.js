// Inside an agent run (QUILL_HANDOFF_ID set) every mutating CLI command refuses with `cli-in-run`;
// only the read commands of spec §4.2 work (ADR 0026). The refusal sits in the dispatcher, so a
// command added later refuses unless it is added to the read list on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMMAND_NAMES, HELP } from '../../src/cli/main.js';
import { IN_RUN_READS, isReadInRun, refuseInRun, CLI_IN_RUN_MESSAGE } from '../../src/cli/in-run.js';
import { makeHome, cli } from './helpers.js';

const REFUSAL = 'quill: refused inside an agent run (cli-in-run)';

test('the read list is spec §4.2 verbatim', () => {
  assert.deepEqual(IN_RUN_READS, { status: '*', doctor: '*', ticket: ['show', 'list', 'children'], agent: ['list', 'show', 'suggestions'], handoff: ['list'], repo: ['list'] });
  assert.equal(CLI_IN_RUN_MESSAGE, REFUSAL);
});

test('refuseInRun throws cli-in-run only when QUILL_HANDOFF_ID is set and non-empty', () => {
  assert.doesNotThrow(() => refuseInRun({}));
  assert.doesNotThrow(() => refuseInRun({ QUILL_HANDOFF_ID: '' }));
  assert.throws(() => refuseInRun({ QUILL_HANDOFF_ID: 'x' }), (e) => e.code === 'cli-in-run' && e.message === REFUSAL);
});

test('QUILL_HANDOFF_ID=x quill ticket set K --status done exits 2 with cli-in-run and changes nothing', async () => {
  const fx = makeHome();
  const ingress = path.join(fx.home, 'ingress');
  const before = fs.existsSync(ingress) ? fs.readdirSync(ingress).length : 0;
  const r = await cli(['ticket', 'set', 'LOCAL-1', '--status', 'done'], { ...fx.env, QUILL_HANDOFF_ID: 'x' });
  assert.equal(r.code, 2);
  assert.equal(r.err.trim(), REFUSAL);
  assert.equal(fs.existsSync(ingress) ? fs.readdirSync(ingress).length : 0, before, 'no event was written');
  const json = await cli(['ticket', 'set', 'LOCAL-1', '--status', 'done', '--json'], { ...fx.env, QUILL_HANDOFF_ID: 'x' });
  assert.equal(json.code, 2);
  assert.equal(JSON.parse(json.out).error.code, 'cli-in-run');
});

test('QUILL_HANDOFF_ID=x quill status still works', async () => {
  const fx = makeHome();
  const r = await cli(['status'], { ...fx.env, QUILL_HANDOFF_ID: 'x' });
  assert.notEqual(r.code, 2);
  assert.doesNotMatch(r.err, /cli-in-run/);
  const t = await cli(['ticket', 'list'], { ...fx.env, QUILL_HANDOFF_ID: 'x' });
  assert.equal(t.code, 0, t.err);
});

// Every command the dispatcher knows, with every subcommand HELP names for it plus a ticket-key
// shaped word, a made-up word and none at all: all refuse unless the read list names them.
test('every registered mutating command refuses inside a run (enumerated from the command table)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-inrun-'));
  const env = { QUILL_HOME: home, QUILL_HANDOFF_ID: 'run-1' };
  let refused = 0;
  try {
    assert.ok(COMMAND_NAMES.length >= 20, 'the command table is exported');
    for (const command of COMMAND_NAMES) {
      const named = [...HELP.matchAll(new RegExp(`(?:^|\\s)${command} ([a-z][a-z-]*)`, 'gm'))].map((m) => m[1]);
      for (const sub of [...new Set([...named, 'PROJ-1', 'zzz-made-up', null])]) {
        const argv = sub ? [command, sub] : [command];
        if (isReadInRun(command, sub)) continue;
        const r = await cli(argv, env);
        assert.equal(r.code, 2, `${argv.join(' ')} exited ${r.code}: ${r.err}`);
        assert.equal(r.err.trim(), REFUSAL, argv.join(' '));
        refused += 1;
      }
    }
    assert.deepEqual(fs.readdirSync(home), [], 'nothing was written to the Quill home');
    assert.ok(refused >= 40, `refused ${refused} invocations`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('isReadInRun: the read list and nothing else', () => {
  for (const [c, s] of [['status', null], ['status', 'x'], ['doctor', null], ['ticket', 'show'], ['ticket', 'list'], ['ticket', 'children'], ['agent', 'list'], ['agent', 'show'], ['agent', 'suggestions'], ['handoff', 'list'], ['repo', 'list']]) assert.equal(isReadInRun(c, s), true, `${c} ${s}`);
  for (const [c, s] of [['ticket', null], ['ticket', 'set'], ['agent', null], ['agent', 'run'], ['agent', 'accept'], ['handoff', 'result'], ['handoff', 'cancel'], ['handoff', 'PROJ-1'], ['repo', 'add'], ['approve', null], ['dismiss', null], ['hook', 'PreToolUse'], ['worker', 'status'], ['ui', null], ['mirror', 'status'], ['export', null], ['publish', 'list'], ['memory', 'approve']]) assert.equal(isReadInRun(c, s), false, `${c} ${s}`);
});
