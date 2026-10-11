// Dev tool: verifies on this machine how the claude CLI behaves under the autonomous-run setup
// (spec docs/superpowers/specs/2026-10-12-autonomous-runs-design.md §3, §4.1, §4.4, §6.3).
//
//   node scripts/probe-autonomous.mjs
//
// Every probe asks haiku for one harmless action in a temp dir under os.tmpdir(); nothing touches
// prod, MCP write tools, or the owner's credential/settings files. Credential probes print only
// "real context visible: yes/no". Exits 0 and prints a verdict table.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ts = Date.now();
const root = path.join(os.tmpdir(), `quill-probe-${ts}`);
fs.mkdirSync(root, { recursive: true });
const verdicts = {};
const notes = {};
const set = (k, v, note = '') => { verdicts[k] = v; if (note) notes[k] = note; console.log(`  ${k}: ${v}${note ? `  (${note})` : ''}`); };

const version = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout.trim();
console.log(`claude ${version}; probe dir ${root}`);

// Inline probe hook: logs stdin JSON, then acts per QUILL_PROBE_MODE.
const hookScript = path.join(root, 'probe-hook.mjs');
fs.writeFileSync(hookScript, `
import fs from 'node:fs';
const raw = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.QUILL_PROBE_LOG, raw.replace(/\\s+/g, ' ') + '\\n');
const mode = process.env.QUILL_PROBE_MODE || 'allow';
if (mode === 'crash') process.exit(1);
if (mode === 'sleep') await new Promise((r) => setTimeout(r, 15000));
const decision = mode === 'deny' ? 'deny' : 'allow';
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: 'PROBE-DENY-REASON-4417' } }));
`);

const MATCHER = 'Bash|PowerShell|Monitor|mcp__.*|Read|Glob|Grep|Edit|Write|MultiEdit|NotebookEdit|Task|Agent';
function writeSettings(name, { onFailure = true, timeout = 10 } = {}) {
  const file = path.join(root, name);
  const hook = { type: 'command', command: `node "${hookScript}"`, timeout };
  if (onFailure) hook.onFailure = 'block';
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: MATCHER, hooks: [hook] }] } }));
  return file;
}

function freshCwd(label, git = false) {
  const d = path.join(root, label);
  fs.mkdirSync(d, { recursive: true });
  if (git) spawnSync('git', ['init', '-q'], { cwd: d });
  return d;
}

function run({ label, prompt, mode = 'allow', settings = 'run-settings.json', cwd, extra = [], env = {}, flags = true }) {
  const dir = cwd || freshCwd(label);
  const log = path.join(root, `${label}.hooklog`);
  fs.writeFileSync(log, '');
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--permission-mode', 'dontAsk',
    ...(flags ? ['--permission-prompts', 'none'] : []), '--max-turns', '4', '--model', 'haiku',
    ...(settings ? ['--settings', path.join(root, settings)] : []), ...extra];
  const r = spawnSync('claude', args, {
    cwd: dir, input: prompt, encoding: 'utf8', shell: false, timeout: 180000,
    env: { ...process.env, QUILL_PROBE_MODE: mode, QUILL_PROBE_LOG: log, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const events = [];
  for (const line of (r.stdout || '').split('\n')) { try { events.push(JSON.parse(line)); } catch { /* not json */ } }
  const hooks = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const results = []; // tool_result blocks
  const uses = [];
  for (const e of events) {
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_result') results.push({ id: b.tool_use_id, error: !!b.is_error, text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
      if (b.type === 'tool_use') uses.push({ id: b.id, name: b.name });
    }
  }
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const result = events.find((e) => e.type === 'result');
  return { status: r.status, stderr: r.stderr || '', events, hooks, results, uses, init, result, dir };
}
const toolOk = (r, name) => {
  const u = r.uses.find((x) => x.name === name);
  if (!u) return { ran: false, why: `no ${name} call made` };
  const res = r.results.find((x) => x.id === u.id);
  return { ran: !!res && !res.error, why: res ? (res.error ? `error: ${res.text.slice(0, 120)}` : 'ok') : 'no result', text: res?.text || '' };
};

console.log('\n[Step 1] hook probes');
try {
  fs.writeFileSync(path.join(root, 'noop'), '');
  writeSettings('run-settings.json');

  let r = run({ label: 'bash', prompt: 'Use the Bash tool to run exactly: echo probe. Do nothing else, then reply done.' });
  let t = toolOk(r, 'Bash');
  set('hookAllowBash', t.ran && /probe/.test(t.text), t.why);
  set('permissionPromptsNoneFlag', r.status === 0 && !!r.init, `exit ${r.status}; flag accepted by this CLI`);
  const srcs = (r.init?.mcp_servers || []).map((s) => s.source ?? null);
  set('initHasMcpSource', (r.init?.mcp_servers || []).length > 0 && srcs.some((s) => s != null), `sources: ${[...new Set(srcs.map(String))].join(',') || 'none'}; ${(r.init?.mcp_servers || []).length} servers`);
  // settings merge: our hook fired AND a session-quill plugin hook is present
  const hookEvts = r.events.filter((e) => e.type === 'system' && /^hook_/.test(e.subtype || ''));
  const quillHook = hookEvts.some((e) => /quill/i.test(JSON.stringify(e)) && !/probe-hook/.test(JSON.stringify(e)));
  set('settingsMergeWithPlugin', r.hooks.length > 0 && quillHook, `injected hook fired ${r.hooks.length}x; plugin hook events seen: ${quillHook}`);

  r = run({ label: 'ps', prompt: 'Use the PowerShell tool to run exactly: Write-Output probe. Do nothing else, then reply done.' });
  t = toolOk(r, 'PowerShell');
  set('hookAllowPowerShell', t.ran && /probe/.test(t.text), t.why);

  const editCwd = freshCwd('edit');
  r = run({ label: 'edit', cwd: editCwd, prompt: 'Use the Write tool to create probe.txt in the current directory with the content "probe". Do nothing else, then reply done.' });
  set('hookAllowEdit', fs.existsSync(path.join(editCwd, 'probe.txt')), r.uses.map((u) => u.name).join(','));

  r = run({ label: 'monitor', prompt: 'Use the Monitor tool to run the command: echo probe. Do nothing else, then reply done.' });
  t = toolOk(r, 'Monitor');
  const monAvail = (r.init?.tools || []).includes('Monitor');
  set('hookAllowMonitor', t.ran, `${t.why}; Monitor in tools: ${monAvail}; hook saw: ${r.hooks.some((h) => h.tool_name === 'Monitor')}`);

  r = run({ label: 'deny', mode: 'deny', prompt: 'Use the Bash tool to run exactly: echo probe. If it fails, quote the error text verbatim in your reply.' });
  t = toolOk(r, 'Bash');
  const denyRes = r.results.find((x) => x.error && /PROBE-DENY-REASON-4417/.test(x.text));
  set('hookDenyHonoured', !t.ran && !!denyRes, denyRes ? 'deny reason reached the model as tool error' : t.why);

  // onFailure: crash hook on a call dontAsk would otherwise permit (Read inside cwd)
  const rd = freshCwd('onfail'); fs.writeFileSync(path.join(rd, 'a.txt'), 'hello');
  const readPrompt = 'Use the Read tool to read a.txt in the current directory. Do nothing else, then reply done.';
  writeSettings('settings-block.json', { onFailure: true });
  writeSettings('settings-noblock.json', { onFailure: false });
  const ctl = run({ label: 'onfail-ctl', cwd: rd, mode: 'crash', settings: 'settings-noblock.json', prompt: readPrompt });
  const blk = run({ label: 'onfail-blk', cwd: rd, mode: 'crash', settings: 'settings-block.json', prompt: readPrompt });
  const ctlOk = toolOk(ctl, 'Read'); const blkOk = toolOk(blk, 'Read');
  set('onFailureBlock', !blkOk.ran && blk.uses.some((u) => u.name === 'Read'), `crash w/o onFailure: Read ran=${ctlOk.ran}; with block: Read ran=${blkOk.ran}`);
  writeSettings('settings-timeout.json', { onFailure: true, timeout: 2 });
  const to = run({ label: 'onfail-timeout', cwd: rd, mode: 'sleep', settings: 'settings-timeout.json', prompt: readPrompt });
  const toOk = toolOk(to, 'Read');
  notes.timeoutBlock = `hook sleep 15s, timeout 2, onFailure block: Read ran=${toOk.ran}`;
  console.log(`  (extra) timeoutBlock: Read ran=${toOk.ran} -> ${toOk.ran ? 'timeout does NOT block' : 'timeout blocks'}`);
  verdicts.timeoutBlock = !toOk.ran;

  // Subagents: parent told to delegate; any Bash call logged by the hook that the parent itself did not make
  r = run({ label: 'subagent', prompt: 'Use the Agent tool to launch a subagent whose only job is to run `echo probe` with its Bash tool and report the output. Do not use Bash yourself. Reply with what the subagent reported.', extra: [] });
  const parentBash = r.events.some((e) => e.type === 'assistant' && !e.parent_tool_use_id && e.message?.content?.some?.((b) => b.type === 'tool_use' && b.name === 'Bash'));
  const hookBash = r.hooks.filter((h) => h.tool_name === 'Bash');
  const agentCalled = r.uses.some((u) => u.name === 'Agent' || u.name === 'Task');
  set('subagentsCarryGuard', agentCalled && !parentBash && hookBash.length > 0, `agent called: ${agentCalled}; parent Bash: ${parentBash}; hook saw subagent Bash: ${hookBash.length}x`);
} catch (e) { console.log(`  step 1 error: ${e.message}`); }

console.log('\n[Step 2] credential probes (only "real context visible: yes/no")');
const stubs = path.join(root, 'cred-stubs'); fs.mkdirSync(path.join(stubs, 'gcloud'), { recursive: true }); fs.mkdirSync(path.join(stubs, 'azure'), { recursive: true });
for (const f of ['kubeconfig', 'aws-config', 'aws-credentials', 'pgpass', 'gitconfig']) fs.writeFileSync(path.join(stubs, f), f === 'gitconfig' ? '[credential]\n\thelper =\n' : '');
const redirected = {
  KUBECONFIG: path.join(stubs, 'kubeconfig'), AWS_CONFIG_FILE: path.join(stubs, 'aws-config'), AWS_SHARED_CREDENTIALS_FILE: path.join(stubs, 'aws-credentials'),
  AWS_PROFILE: 'quill-none', AWS_EC2_METADATA_DISABLED: 'true', CLOUDSDK_CONFIG: path.join(stubs, 'gcloud'), AZURE_CONFIG_DIR: path.join(stubs, 'azure'),
  PGPASSFILE: path.join(stubs, 'pgpass'), GIT_CONFIG_GLOBAL: path.join(stubs, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
};
for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS']) delete redirected[k];
const credCmds = {
  kubectl: [['config', 'current-context'], (o) => o.trim().length > 0 && !/current-context is not set/i.test(o)],
  aws: [['configure', 'list'], (o) => /access_key.*\*{4}/i.test(o)],
  gcloud: [['config', 'list'], (o) => /account\s*=/.test(o)],
  az: [['account', 'show'], (o) => /"id"/.test(o)],
  psql: [['--version'], () => fs.existsSync(redirected.PGPASSFILE) && fs.statSync(redirected.PGPASSFILE).size > 0],
  git: [['config', '--get', 'credential.helper'], (o) => o.trim().length > 0],
};
const present = {};
for (const [cli, [args, seesReal]] of Object.entries(credCmds)) {
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cli], { encoding: 'utf8' });
  if (found.status !== 0) { set(`credRedirectHonoured.${cli}`, 'n/a', 'CLI not installed on this machine'); continue; }
  present[cli] = true;
  const normal = spawnSync(cli, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  const redir = spawnSync(cli, args, { encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, ...redirected } });
  const normalSees = seesReal((normal.stdout || '') + (normal.stderr || ''));
  const redirSees = seesReal((redir.stdout || '') + (redir.stderr || ''));
  console.log(`  ${cli}: real context visible (owner env): ${normalSees ? 'yes' : 'no'}; (redirected env): ${redirSees ? 'yes' : 'no'}`);
  set(`credRedirectHonoured.${cli}`, !redirSees, normalSees ? 'owner env had one; redirect hid it' : 'owner env had none either, so inconclusive but nothing leaks');
}
verdicts.credRedirectHonoured = Object.keys(present).length ? Object.entries(verdicts).filter(([k]) => k.startsWith('credRedirectHonoured.') && verdicts[k] !== 'n/a').every(([, v]) => v === true) : 'n/a';

console.log('\n[Step 3] memory, add-dir, budget');
try {
  const slugRoot = path.join(os.homedir(), '.claude', 'projects');
  const memoryFilesFor = (needle) => {
    const out = [];
    if (!fs.existsSync(slugRoot)) return out;
    for (const d of fs.readdirSync(slugRoot)) {
      if (!d.includes(needle)) continue;
      const mem = path.join(slugRoot, d, 'memory');
      if (fs.existsSync(mem)) for (const f of fs.readdirSync(mem, { recursive: true })) out.push(path.join(d, 'memory', String(f)));
    }
    return out;
  };
  const memPrompt = 'Remember that probe=1 by saving it to your memory. Then reply done.';
  const mOff = freshCwd('mem-off', true);
  run({ label: 'mem-off', cwd: mOff, prompt: memPrompt, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, settings: 'run-settings.json' });
  const offFiles = memoryFilesFor('mem-off');
  const mOn = freshCwd('mem-on', true);
  run({ label: 'mem-on', cwd: mOn, prompt: memPrompt, settings: null });
  const onFiles = memoryFilesFor('mem-on');
  set('disableAutoMemory', offFiles.length === 0, `with flag: ${offFiles.length} memory files; control without flag: ${onFiles.length}${onFiles.length === 0 ? ' (control wrote none, so weakly conclusive)' : ''}`);

  const extra = path.join(root, 'extra-ctx'); fs.mkdirSync(extra, { recursive: true });
  fs.writeFileSync(path.join(extra, 'context.md'), 'The probe token is PROBE-TOKEN-7731.\n');
  const ctxFile = path.join(extra, 'context.md');
  const ad = run({ label: 'adddir', settings: null, extra: ['--add-dir', extra, '--allowedTools', 'Read'], prompt: `Read the file ${ctxFile} and reply with only the probe token it contains.` });
  set('addDirReadable', /PROBE-TOKEN-7731/.test(ad.result?.result || ''), `result: ${(ad.result?.result || '').slice(0, 80)}`);

  let bud = run({ label: 'budget', settings: null, extra: ['--max-budget-usd', '0.01'], prompt: 'Count from 1 to 40, one number per line, then say done.' });
  let sub = bud.result?.subtype || '';
  let used = '0.01';
  if (!/budget/i.test(sub)) {
    bud = run({ label: 'budget2', settings: null, extra: ['--max-budget-usd', '0.0005'], prompt: 'Count from 1 to 40, one number per line, then say done.' });
    sub = bud.result?.subtype || ''; used = '0.0005';
  }
  set('maxBudgetFlag', bud.status !== null && /budget/i.test(sub), `flag accepted; cap ${used}; result subtype "${sub}"${used === '0.01' ? '' : ' (0.01 was not exceeded by one short haiku reply)'}`);
} catch (e) { console.log(`  step 3 error: ${e.message}`); }

console.log(`\n=== Verdict table (claude ${version}) ===`);
const wanted = ['hookAllowBash', 'hookAllowPowerShell', 'hookAllowEdit', 'hookAllowMonitor', 'hookDenyHonoured', 'onFailureBlock', 'settingsMergeWithPlugin', 'subagentsCarryGuard', 'initHasMcpSource', 'credRedirectHonoured', 'disableAutoMemory', 'addDirReadable', 'maxBudgetFlag', 'permissionPromptsNoneFlag'];
console.log('| probe | verdict | note |\n| --- | --- | --- |');
for (const k of wanted) console.log(`| ${k} | ${verdicts[k] ?? 'not-run'} | ${notes[k] || ''} |`);
for (const k of Object.keys(verdicts).filter((x) => x.startsWith('credRedirectHonoured.') || x === 'timeoutBlock')) console.log(`| ${k} | ${verdicts[k]} | ${notes[k] || ''} |`);
console.log(`\nprobe dir kept at ${root}`);
process.exit(0);
