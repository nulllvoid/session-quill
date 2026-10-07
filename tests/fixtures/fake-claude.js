#!/usr/bin/env node
// Stand-in for the `claude` CLI in handoff tests. The prompt arrives on stdin, as with the real
// CLI. Behaviour is driven by environment variables:
//   FAKE_CLAUDE_SLEEP_MS  — how long to run before answering (default 50)
//   FAKE_CLAUDE_MODE      — 'ok' (default) | 'crash' | 'garbage' | 'malformed' (a reply without a
//                           JSON block, wrapped like a real result so it can be resumed)
//   FAKE_CLAUDE_EDIT      — path of a file to modify inside the cwd before answering
//   FAKE_CLAUDE_RESULT    — JSON to answer with instead of the default structured result
//   FAKE_CLAUDE_RESUME_RESULT — JSON to answer a --resume turn with (default: FAKE_CLAUDE_RESULT
//                           or the default result); 'malformed' answers it without a JSON block
//   FAKE_CLAUDE_CAPTURE   — file to write { prompt, args } to; --resume turns append to
//                           <capture>.resume as one JSON line each
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 50);
const resumeIdx = args.indexOf('--resume');
const resumed = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
const mode = resumed ? 'ok' : process.env.FAKE_CLAUDE_MODE ?? 'ok';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', run);

function wrap(text) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: resumed ?? 'fake-session', num_turns: 3, total_cost_usd: 0.01 });
}

function run() {
  const capture = process.env.FAKE_CLAUDE_CAPTURE;
  if (capture && resumed) fs.appendFileSync(`${capture}.resume`, `${JSON.stringify({ prompt, args })}\n`);
  else if (capture) fs.writeFileSync(capture, JSON.stringify({ prompt, args }));
  process.stderr.write(`fake-claude cwd=${process.cwd()} args=${args.join(' ')}\n`);
  setTimeout(() => {
    if (process.env.FAKE_CLAUDE_EDIT && !resumed) {
      const file = path.join(process.cwd(), process.env.FAKE_CLAUDE_EDIT);
      fs.writeFileSync(file, `${fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''}\n// edited by fake-claude\n`);
    }
    if (mode === 'crash') process.exit(3);
    if (mode === 'garbage') { process.stdout.write('not json at all'); process.exit(0); }
    if (mode === 'malformed' || (resumed && process.env.FAKE_CLAUDE_RESUME_RESULT === 'malformed')) { process.stdout.write(wrap('I looked at the ticket but forgot the JSON block.')); process.exit(0); }
    const source = resumed && process.env.FAKE_CLAUDE_RESUME_RESULT ? process.env.FAKE_CLAUDE_RESUME_RESULT : process.env.FAKE_CLAUDE_RESULT;
    const structured = source ? JSON.parse(source) : {
      summary: 'Analysed the ticket notes. The retry flake comes from a shared timer.',
      next_action: 'Use fake timers in the retry tests',
      blocker: null,
      children: [
        { title: 'Add fake timers to retry tests', category: 'bugfix', priority: 'P2', next_action: 'Replace setTimeout with jest fake timers' },
        { title: 'Document retry timing contract', category: 'research', priority: 'P3', next_action: '' },
      ],
      test_results: ['node --test: 12 passed'],
    };
    process.stdout.write(wrap(`Here is my analysis.\n\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\`\n`));
    process.exit(0);
  }, sleep);
}
