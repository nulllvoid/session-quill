#!/usr/bin/env node
// Stand-in for the `claude` CLI in handoff tests. The prompt arrives on stdin, as with the real
// CLI. Behaviour is driven by environment variables:
//   FAKE_CLAUDE_SLEEP_MS  — how long to run before answering (default 50)
//   FAKE_CLAUDE_MODE      — 'ok' (default) | 'crash' | 'garbage' | 'malformed' (a reply without a
//                           JSON block, wrapped like a real result so it can be resumed) | 'no-result'
//                           (init and assistant text, then exit 0 without a result event)
//   FAKE_CLAUDE_EDIT      — path of a file to modify inside the cwd before answering
//   FAKE_CLAUDE_REPAIR_EDIT — path of a file to mark "repaired" when a --resume turn is asked to fix
//                           failing tests (the worker's test gate repair turn)
//   FAKE_CLAUDE_RESULT    — JSON to answer with instead of the default structured result
//   FAKE_CLAUDE_RESUME_RESULT — JSON to answer a --resume turn with (default: FAKE_CLAUDE_RESULT
//                           or the default result); 'malformed' answers it without a JSON block
//   FAKE_CLAUDE_COST      — total_cost_usd each result event reports (default 0.01)
//   CLAUDE_CONFIG_DIR     — when set, session transcripts are kept and required as Claude Code
//                           does (see transcript() below)
//   FAKE_CLAUDE_SESSION   — session id to report (default 'fake-session'; a --resume turn keeps its id)
//   FAKE_CLAUDE_CAPTURE   — file to write { prompt, args } to; --resume turns append to
//                           <capture>.resume as one JSON line each. With --settings <file> the
//                           capture also holds that file's JSON (`settings`) and the text of the
//                           grant.json beside it (`grant_text`); `add_dir_files` holds the text
//                           of every file under each --add-dir directory
//   FAKE_CLAUDE_ENV_PROBE — comma-separated variable names whose values (or null) the capture
//                           records as `env_probe`; tests set only fake values
//   FAKE_CLAUDE_VERSION   — what `--version` prints (default '2.1.296 (Claude Code)')
//   FAKE_CLAUDE_VERSION_DELAY_MS — how long `--version` takes to answer (default 0)
//   FAKE_CLAUDE_INIT_VERSION — claude_code_version in the init event (default: the version's number)
//   FAKE_CLAUDE_MCP_SERVERS — JSON list for the init event's mcp_servers (default [])
//   FAKE_CLAUDE_CRITIC_RESULT — JSON a critic prompt (ADR 0040, "You are the Session Quill critic")
//                           is answered with (default: a clean review); FAKE_CLAUDE_CRITIC_MODE 'crash'
//                           exits 3, 'malformed' answers without a JSON block, 'hang' never answers.
//                           A critic turn never edits, and its { prompt, args } go to <capture>.critic
//   FAKE_CLAUDE_GUARD_CALLS — JSON list of { tool_name, tool_input } the fake "calls": each runs the
//                           PreToolUse hook from --settings (the real guard) with that input, in
//                           order, and the capture records each decision as `guard_decisions`
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const VERSION = process.env.FAKE_CLAUDE_VERSION ?? '2.1.296 (Claude Code)';
if (args.includes('--version')) {
  const delay = Number(process.env.FAKE_CLAUDE_VERSION_DELAY_MS ?? 0);
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 50);
const resumeIdx = args.indexOf('--resume');
const resumed = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
const mode = resumed ? 'ok' : process.env.FAKE_CLAUDE_MODE ?? 'ok';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', run);

// stream-json, as `claude -p --output-format stream-json --verbose` writes it: the init event as
// soon as the run starts, then the assistant's reply, then the final result event.
const SESSION = resumed ?? process.env.FAKE_CLAUDE_SESSION ?? 'fake-session';
const line = (obj) => `${JSON.stringify(obj)}\n`;
function wrap(text) {
  return line({ type: 'assistant', session_id: SESSION, message: { role: 'assistant', content: [{ type: 'text', text }] } })
    + line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: SESSION, num_turns: 3, total_cost_usd: Number(process.env.FAKE_CLAUDE_COST ?? 0.01) });
}

// Runs the settings' PreToolUse hook once per call, as Claude Code would, and returns each decision.
function guardCalls(settings) {
  const hook = settings && settings.hooks && settings.hooks.PreToolUse && settings.hooks.PreToolUse[0] && settings.hooks.PreToolUse[0].hooks[0];
  if (!hook) return [];
  return JSON.parse(process.env.FAKE_CLAUDE_GUARD_CALLS).map((call, i) => {
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SESSION, cwd: process.cwd(), tool_use_id: `toolu_fake_${i}`, ...call });
    const r = spawnSync(hook.command, hook.args, { input, env: process.env, encoding: 'utf8', timeout: (hook.timeout ?? 10) * 1000, windowsHide: true });
    try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; } catch { return 'no-decision'; }
  });
}

// With CLAUDE_CONFIG_DIR set, sessions behave as Claude Code keeps them: a transcript per session
// under <config>/projects/<cwd, every character outside [A-Za-z0-9] as "-">/<id>.jsonl, written by
// every turn; a --resume whose transcript is not under the current cwd's folder is not found.
function transcript() {
  const config = process.env.CLAUDE_CONFIG_DIR;
  if (!config) return true;
  const file = path.join(config, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), `${SESSION}.jsonl`);
  if (resumed && !fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line({ type: 'user', session_id: SESSION, cwd: process.cwd() }));
  return true;
}

// The critic (ADR 0040): a fresh process with its own prompt; it never edits and never resumes.
function critic() {
  const capture = process.env.FAKE_CLAUDE_CAPTURE;
  if (capture) {
    // As the run's capture: the --settings file and the grant beside it, and the probed variables.
    const out = { prompt, args };
    const settingsAt = args.indexOf('--settings');
    if (settingsAt >= 0) {
      const file = args[settingsAt + 1];
      try { out.settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { out.settings = null; }
      try { out.grant_text = fs.readFileSync(path.join(path.dirname(file), 'grant.json'), 'utf8'); } catch { out.grant_text = null; }
    }
    if (process.env.FAKE_CLAUDE_ENV_PROBE) out.env_probe = Object.fromEntries(process.env.FAKE_CLAUDE_ENV_PROBE.split(',').map((k) => [k, process.env[k] ?? null]));
    fs.writeFileSync(`${capture}.critic`, JSON.stringify(out));
  }
  process.stdout.write(line({ type: 'system', subtype: 'init', session_id: 'fake-critic-session', tools: ['Read'], mcp_servers: [] }));
  const how = process.env.FAKE_CLAUDE_CRITIC_MODE ?? 'ok';
  if (how === 'hang') { setTimeout(() => {}, 600_000); return; }
  setTimeout(() => {
    if (how === 'crash') process.exit(3);
    const reply = process.env.FAKE_CLAUDE_CRITIC_RESULT ?? JSON.stringify({ summary: 'The change does what the ticket asks.', review_findings: [] });
    const text = how === 'malformed' ? 'I reviewed it but forgot the JSON block.' : `Review done.\n\n\`\`\`json\n${reply}\n\`\`\`\n`;
    process.stdout.write(line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'fake-critic-session', num_turns: 2, total_cost_usd: Number(process.env.FAKE_CLAUDE_COST ?? 0.01) }));
    process.exit(0);
  }, sleep);
}

function run() {
  if (prompt.startsWith('You are the Session Quill critic')) { critic(); return; }
  if (!transcript()) {
    process.stderr.write(`No conversation found with session ID: ${SESSION}\n`);
    process.exit(1);
  }
  const capture = process.env.FAKE_CLAUDE_CAPTURE;
  if (capture && resumed) fs.appendFileSync(`${capture}.resume`, `${JSON.stringify({ prompt, args })}\n`);
  // Whether a provider token reached the agent, for credential tests; never a real value.
  else if (capture) {
    const out = { prompt, args, gh_token: !!process.env.GH_TOKEN };
    const settingsAt = args.indexOf('--settings');
    if (settingsAt >= 0) {
      const file = args[settingsAt + 1];
      try { out.settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { out.settings = null; }
      try { out.grant_text = fs.readFileSync(path.join(path.dirname(file), 'grant.json'), 'utf8'); } catch { out.grant_text = null; }
    }
    // Every --add-dir directory as the run saw it: { dir: { relative/path: text } }.
    out.add_dir_files = {};
    args.forEach((a, i) => {
      if (a !== '--add-dir') return;
      const dir = args[i + 1];
      const files = {};
      const walk = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files[path.relative(dir, f).split(path.sep).join('/')] = fs.readFileSync(f, 'utf8'); } } catch { /* missing */ } };
      walk(dir);
      out.add_dir_files[dir] = files;
    });
    if (process.env.FAKE_CLAUDE_ENV_PROBE) out.env_probe = Object.fromEntries(process.env.FAKE_CLAUDE_ENV_PROBE.split(',').map((k) => [k, process.env[k] ?? null]));
    if (process.env.FAKE_CLAUDE_GUARD_CALLS) out.guard_decisions = guardCalls(out.settings);
    fs.writeFileSync(capture, JSON.stringify(out));
  }
  process.stderr.write(`fake-claude cwd=${process.cwd()} args=${args.join(' ')}\n`);
  const initVersion = process.env.FAKE_CLAUDE_INIT_VERSION ?? (/\d+\.\d+\.\d+/.exec(VERSION) ?? [null])[0];
  const mcpServers = process.env.FAKE_CLAUDE_MCP_SERVERS ? JSON.parse(process.env.FAKE_CLAUDE_MCP_SERVERS) : [];
  if (mode !== 'garbage') process.stdout.write(line({ type: 'system', subtype: 'init', session_id: SESSION, tools: ['Bash', 'Read'], mcp_servers: mcpServers, ...(initVersion ? { claude_code_version: initVersion } : {}) }));
  setTimeout(() => {
    if (process.env.FAKE_CLAUDE_EDIT && !resumed) {
      const file = path.join(process.cwd(), process.env.FAKE_CLAUDE_EDIT);
      fs.writeFileSync(file, `${fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''}\n// edited by fake-claude\n`);
    }
    if (process.env.FAKE_CLAUDE_REPAIR_EDIT && resumed && /tests failed/i.test(prompt)) {
      const file = path.join(process.cwd(), process.env.FAKE_CLAUDE_REPAIR_EDIT);
      fs.appendFileSync(file, '\n// repaired by fake-claude\n');
    }
    if (mode === 'crash') process.exit(3);
    if (mode === 'no-result') { process.stdout.write(line({ type: 'assistant', session_id: SESSION, message: { content: [{ type: 'text', text: 'working' }] } })); process.exit(0); }
    if (mode === 'garbage') { process.stdout.write('not json at all'); process.exit(0); }
    if (mode === 'malformed' || (resumed && process.env.FAKE_CLAUDE_RESUME_RESULT === 'malformed')) { process.stdout.write(wrap('I looked at the ticket but forgot the JSON block.')); process.exit(0); }
    const source = resumed && process.env.FAKE_CLAUDE_RESUME_RESULT ? process.env.FAKE_CLAUDE_RESUME_RESULT : process.env.FAKE_CLAUDE_RESULT;
    const structured = source ? JSON.parse(source) : {
      summary: 'Analysed the ticket notes. The retry flake comes from a shared timer.',
      next_action: 'Use fake timers in the retry tests',
      blocker: null,
      children: [
        { title: 'Add fake timers to retry tests', category: 'bugfix', priority: 'P2', next_action: 'Replace setTimeout with jest fake timers', description: '**Goal:** Make the retry tests deterministic with fake timers.\n\n**Context:** The flake comes from a shared real timer.\n\n**Done when:**\n- retry tests pass 50 runs in a row' },
        { title: 'Document retry timing contract', category: 'research', priority: 'P3', next_action: '', description: '**Goal:** Document how retry timing behaves for callers.\n\n**Context:** Callers rely on the backoff schedule.\n\n**Done when:**\n- the README describes the schedule' },
      ],
      test_results: ['node --test: 12 passed'],
    };
    process.stdout.write(wrap(`Here is my analysis.\n\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\`\n`));
    process.exit(0);
  }, sleep);
}
