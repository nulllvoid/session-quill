#!/usr/bin/env node
// Stand-in for the `claude` CLI in handoff tests. Behaviour is driven by environment variables:
//   FAKE_CLAUDE_SLEEP_MS  — how long to run before answering (default 50)
//   FAKE_CLAUDE_MODE      — 'ok' (default) | 'crash' | 'garbage'
//   FAKE_CLAUDE_EDIT      — path of a file to modify inside the cwd before answering
//   FAKE_CLAUDE_RESULT    — JSON to answer with instead of the default structured result
//   FAKE_CLAUDE_CAPTURE   — file to write { prompt, args } to
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 50);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
const promptIdx = args.indexOf('-p');
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : '';
if (process.env.FAKE_CLAUDE_CAPTURE) fs.writeFileSync(process.env.FAKE_CLAUDE_CAPTURE, JSON.stringify({ prompt, args: args.filter((a) => a !== prompt) }));
process.stderr.write(`fake-claude cwd=${process.cwd()} args=${args.filter((a) => a !== prompt).join(' ')}\n`);

setTimeout(() => {
  if (process.env.FAKE_CLAUDE_EDIT) {
    const file = path.join(process.cwd(), process.env.FAKE_CLAUDE_EDIT);
    fs.writeFileSync(file, `${fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''}\n// edited by fake-claude\n`);
  }
  if (mode === 'crash') process.exit(3);
  if (mode === 'garbage') { process.stdout.write('not json at all'); process.exit(0); }
  const structured = process.env.FAKE_CLAUDE_RESULT ? JSON.parse(process.env.FAKE_CLAUDE_RESULT) : {
    summary: 'Analysed the ticket notes. The retry flake comes from a shared timer.',
    next_action: 'Use fake timers in the retry tests',
    blocker: null,
    children: [
      { title: 'Add fake timers to retry tests', category: 'bugfix', priority: 'P2', next_action: 'Replace setTimeout with jest fake timers' },
      { title: 'Document retry timing contract', category: 'research', priority: 'P3', next_action: '' },
    ],
    test_results: ['node --test: 12 passed'],
  };
  const text = `Here is my analysis.\n\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\`\n`;
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'fake-session', num_turns: 3, total_cost_usd: 0.01 }));
  process.exit(0);
}, sleep);
