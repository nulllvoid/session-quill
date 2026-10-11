// Dev tool: verifies on this machine how the claude CLI behaves under the autonomous-run setup
// (spec docs/superpowers/specs/2026-10-12-autonomous-runs-design.md §3, §4.1, §4.4, §6.3).
//
//   node scripts/probe-autonomous.mjs [--keep]
//
// Every probe asks haiku for one harmless action in a temp dir under os.tmpdir(); the probe hook
// denies every mcp__* call so no connector tool can run. Credential probes print only
// "real context visible: yes/no". The child env gets QUILL_HOME=<temp> so the session-quill plugin
// cannot capture probe sessions into the owner's store. Probe transcripts and memory files that
// claude writes under ~/.claude/projects for the probe dirs are removed at the end. The temp dir
// is removed unless --keep is passed. Exits 0 and prints a verdict table.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const KEEP = process.argv.includes('--keep');
const ts = Date.now();
const tag = `quill-probe-${ts}`;
const root = path.join(os.tmpdir(), tag);
fs.mkdirSync(root, { recursive: true });
const verdicts = {};
const notes = {};
const set = (k, v, note = '') => { verdicts[k] = v; if (note) notes[k] = note; console.log(`  ${k}: ${v}${note ? `  (${note})` : ''}`); };
const win = process.platform === 'win32';
const projectsRoot = path.join(os.homedir(), '.claude', 'projects');

const version = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: win }).stdout.trim();
console.log(`claude ${version}; probe dir ${root}`);

// Inline probe hook: logs stdin JSON, always denies MCP, then acts per QUILL_PROBE_MODE.
const hookScript = path.join(root, 'probe-hook.mjs');
fs.writeFileSync(hookScript, `
import fs from 'node:fs';
const raw = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.QUILL_PROBE_LOG, raw.replace(/\\s+/g, ' ') + '\\n');
let tool = '';
try { tool = JSON.parse(raw).tool_name || ''; } catch {}
const out = (d, reason) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d, permissionDecisionReason: reason } }));
if (tool.startsWith('mcp__')) { out('deny', 'PROBE-MCP-DENIED: probes never call MCP tools'); process.exit(0); }
const mode = process.env.QUILL_PROBE_MODE || 'allow';
if (mode === 'crash') process.exit(1);
if (mode === 'sleep') await new Promise((r) => setTimeout(r, 15000));
out(mode === 'deny' || (mode === 'denybash' && tool === 'Bash') ? 'deny' : 'allow', 'PROBE-DENY-REASON-4417');
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

// Child env for claude: owner env plus QUILL_HOME in a temp dir (no plugin capture into the real store).
const quillHome = path.join(root, 'quill-home'); fs.mkdirSync(quillHome, { recursive: true });

function run({ label, prompt, mode = 'allow', settings = 'run-settings.json', cwd, extra = [], env = {}, sources = 'project' }) {
  const dir = cwd || freshCwd(label);
  const log = path.join(root, `${label}.hooklog`);
  fs.writeFileSync(log, '');
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none', '--max-turns', '4', '--model', 'haiku',
    ...(sources ? ['--setting-sources', sources] : []),
    ...(settings ? ['--settings', path.join(root, settings)] : []), ...extra];
  const r = spawnSync('claude', args, {
    cwd: dir, input: prompt, encoding: 'utf8', shell: false, timeout: 180000,
    env: { ...process.env, QUILL_HOME: quillHome, QUILL_PROBE_MODE: mode, QUILL_PROBE_LOG: log, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const events = [];
  for (const line of (r.stdout || '').split('\n')) { try { events.push(JSON.parse(line)); } catch { /* not json */ } }
  const hooks = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const results = []; const uses = [];
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
  return { status: r.status, events, hooks, results, uses, init, result, dir };
}
// Did tool `name` run successfully? `attempted` = the model called it at all.
const toolOk = (r, name) => {
  const u = r.uses.find((x) => x.name === name);
  if (!u) return { attempted: false, ran: false, why: `no ${name} call made`, text: '' };
  const res = r.results.find((x) => x.id === u.id);
  return { attempted: true, ran: !!res && !res.error, why: res ? (res.error ? `error: ${res.text.slice(0, 100)}` : 'ok') : 'no result', text: res?.text || '' };
};

const NODE_CMD = `node -e "console.log('probe-ok-5521')"`; // not in dontAsk's built-in read-only command set
const hookSaw = (r, name) => r.hooks.some((h) => h.tool_name === name);

try {
  console.log('\n[Step 1] hook probes (settings sources limited to project; hook denies all mcp__*)');
  writeSettings('run-settings.json');

  // allow-vs-control for a tool family: hook run must run and be seen by the hook; no-hook control must be denied.
  const familyProbe = (key, tool, promptFor, ok) => {
    const withHook = run({ label: `${key}-hook`, prompt: promptFor });
    const control = run({ label: `${key}-ctl`, settings: null, prompt: promptFor });
    const a = toolOk(withHook, tool); const c = toolOk(control, tool);
    const pass = a.ran && ok(withHook, a) && hookSaw(withHook, tool) && c.attempted && !c.ran;
    set(key, pass, `hook run: ran=${a.ran}, hook saw=${hookSaw(withHook, tool)}; no-hook control: attempted=${c.attempted} ran=${c.ran}${c.attempted && c.ran ? ' (control NOT denied; inconclusive)' : ''}`);
    return withHook;
  };

  const bashRun = familyProbe('hookAllowBash', 'Bash', `Use the Bash tool to run exactly: ${NODE_CMD} . Do nothing else, then reply done.`, (r, a) => /probe-ok-5521/.test(a.text));
  set('permissionPromptsNoneFlag', bashRun.status === 0 && !!bashRun.init, `flag accepted (run exits 0, init seen); not a claim about prompt behaviour`);

  familyProbe('hookAllowPowerShell', 'PowerShell', `Use the PowerShell tool to run exactly: ${NODE_CMD} . Do nothing else, then reply done.`, (r, a) => /probe-ok-5521/.test(a.text));

  // Edit: Write creating probe.txt
  const editPrompt = 'Use the Write tool to create probe.txt in the current directory with the content "probe". Do nothing else, then reply done.';
  const eCwd = freshCwd('edit-hook'); const eCtlCwd = freshCwd('edit-ctl');
  const eh = run({ label: 'edit-hook', cwd: eCwd, prompt: editPrompt });
  const ec = run({ label: 'edit-ctl', cwd: eCtlCwd, settings: null, prompt: editPrompt });
  const hookWrote = fs.existsSync(path.join(eCwd, 'probe.txt')); const ctlWrote = fs.existsSync(path.join(eCtlCwd, 'probe.txt'));
  set('hookAllowEdit', hookWrote && !ctlWrote && hookSaw(eh, 'Write') && ec.uses.some((u) => u.name === 'Write'), `hook run wrote file=${hookWrote}, hook saw Write=${hookSaw(eh, 'Write')}; no-hook control wrote file=${ctlWrote}`);

  // Monitor
  const mh = run({ label: 'monitor-hook', prompt: `Use the Monitor tool to run the command: ${NODE_CMD} . Do nothing else, then reply done.` });
  const mc = run({ label: 'monitor-ctl', settings: null, prompt: `Use the Monitor tool to run the command: ${NODE_CMD} . Do nothing else, then reply done.` });
  const ma = toolOk(mh, 'Monitor'); const mcc = toolOk(mc, 'Monitor');
  set('hookAllowMonitor', ma.ran && hookSaw(mh, 'Monitor') && mcc.attempted && !mcc.ran, `hook run ran=${ma.ran} saw=${hookSaw(mh, 'Monitor')}; Monitor in tools=${(mh.init?.tools || []).includes('Monitor')}; control attempted=${mcc.attempted} ran=${mcc.ran}`);

  const dn = run({ label: 'deny', mode: 'deny', prompt: `Use the Bash tool to run exactly: ${NODE_CMD} . If it fails, quote the error text verbatim in your reply.` });
  const dt = toolOk(dn, 'Bash');
  const denyRes = dn.results.find((x) => x.error && /PROBE-DENY-REASON-4417/.test(x.text));
  set('hookDenyHonoured', dt.attempted && !dt.ran && !!denyRes, denyRes ? 'deny reason reached the model as tool error' : dt.why);

  // onFailure: crash/timeout hook on a call dontAsk would otherwise permit (Read inside cwd)
  const rd = freshCwd('onfail'); fs.writeFileSync(path.join(rd, 'a.txt'), 'hello');
  const readPrompt = 'Use the Read tool to read a.txt in the current directory. Do nothing else, then reply done.';
  writeSettings('settings-block.json', { onFailure: true });
  writeSettings('settings-noblock.json', { onFailure: false });
  const ctl = run({ label: 'onfail-ctl', cwd: rd, mode: 'crash', settings: 'settings-noblock.json', prompt: readPrompt });
  const blk = run({ label: 'onfail-blk', cwd: rd, mode: 'crash', settings: 'settings-block.json', prompt: readPrompt });
  const ctlOk = toolOk(ctl, 'Read'); const blkOk = toolOk(blk, 'Read');
  set('onFailureBlock', ctlOk.ran && blkOk.attempted && !blkOk.ran, `crash w/o onFailure: Read ran=${ctlOk.ran}; with block: attempted=${blkOk.attempted} ran=${blkOk.ran}`);
  writeSettings('settings-timeout.json', { onFailure: true, timeout: 2 });
  const to = run({ label: 'onfail-timeout', cwd: rd, mode: 'sleep', settings: 'settings-timeout.json', prompt: readPrompt });
  const toOk = toolOk(to, 'Read');
  set('timeoutBlock', toOk.attempted && !toOk.ran, `hook sleeps 15s, timeout 2, onFailure block: attempted=${toOk.attempted} ran=${toOk.ran}`);

  // Subagents: parent told to delegate; hook must see the subagent's Bash (allow) and be able to deny it
  const subPrompt = `Use the Agent tool to launch a subagent whose only job is to run ${NODE_CMD} with its Bash tool and report the output verbatim, including any error. Do not use Bash yourself. Reply with what the subagent reported.`;
  const parentBash = (r) => r.events.some((e) => e.type === 'assistant' && !e.parent_tool_use_id && e.message?.content?.some?.((b) => b.type === 'tool_use' && b.name === 'Bash'));
  const sa = run({ label: 'subagent', prompt: subPrompt });
  const sd = run({ label: 'subagent-deny', mode: 'denybash', prompt: subPrompt });
  const allowOk = sa.uses.some((u) => u.name === 'Agent' || u.name === 'Task') && !parentBash(sa) && sa.hooks.some((h) => h.tool_name === 'Bash') && sa.results.some((x) => !x.error && /probe-ok-5521/.test(x.text));
  const denyOk = sd.hooks.some((h) => h.tool_name === 'Bash') && !sd.results.some((x) => !x.error && /probe-ok-5521/.test(x.text)) && sd.results.some((x) => x.error && /PROBE-DENY-REASON-4417/.test(x.text));
  set('subagentsCarryGuard', allowOk && denyOk, `subagent Bash reached hook and ran on allow=${allowOk}; hook deny blocked it=${denyOk}`);

  // settings merge: our --settings hook fires AND the session-quill plugin's own hook is present. Needs user settings, so no source limit.
  const mg = run({ label: 'merge', sources: null, prompt: `Use the Read tool to read a.txt in the current directory. Do nothing else, then reply done.`, cwd: rd });
  const hookEvts = mg.events.filter((e) => e.type === 'system' && /^hook_/.test(e.subtype || ''));
  const pluginHook = hookEvts.some((e) => { const j = JSON.stringify(e); return !/probe-hook/.test(j) && /session-quill|quill-hook|quill\.js/i.test(j); });
  const srcs = (mg.init?.mcp_servers || []).map((s) => s.source ?? null);
  set('initHasMcpSource', (mg.init?.mcp_servers || []).length > 0 && srcs.some((s) => s != null), `sources: ${[...new Set(srcs.map(String))].join(',') || 'none'}; ${(mg.init?.mcp_servers || []).length} servers (init only; hook denies every mcp__ call)`);
  set('settingsMergeWithPlugin', mg.hooks.length > 0 && pluginHook, `injected hook fired ${mg.hooks.length}x; session-quill plugin hook event seen=${pluginHook}`);

  console.log('\n[Step 2] credential probes (only "real context visible: yes/no")');
  const stubs = path.join(root, 'cred-stubs'); fs.mkdirSync(path.join(stubs, 'gcloud'), { recursive: true }); fs.mkdirSync(path.join(stubs, 'azure'), { recursive: true });
  for (const f of ['kubeconfig', 'aws-config', 'aws-credentials', 'pgpass', 'gitconfig']) fs.writeFileSync(path.join(stubs, f), f === 'gitconfig' ? '[credential]\n\thelper =\n' : '');
  const REMOVED = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'GOOGLE_APPLICATION_CREDENTIALS'];
  const redirectedEnv = () => {
    const env = { ...process.env };
    for (const k of REMOVED) delete env[k];
    return Object.assign(env, {
      KUBECONFIG: path.join(stubs, 'kubeconfig'), AWS_CONFIG_FILE: path.join(stubs, 'aws-config'), AWS_SHARED_CREDENTIALS_FILE: path.join(stubs, 'aws-credentials'),
      AWS_PROFILE: 'quill-none', AWS_EC2_METADATA_DISABLED: 'true', CLOUDSDK_CONFIG: path.join(stubs, 'gcloud'), AZURE_CONFIG_DIR: path.join(stubs, 'azure'),
      PGPASSFILE: path.join(stubs, 'pgpass'), GIT_CONFIG_GLOBAL: path.join(stubs, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    });
  };
  const credCmds = {
    kubectl: [['config', 'current-context'], (o) => o.trim().length > 0 && !/current-context is not set/i.test(o)],
    aws: [['configure', 'list'], (o) => /access_key.*\*{4}/i.test(o)],
    gcloud: [['config', 'list'], (o) => /account\s*=/.test(o)],
    az: [['account', 'show'], (o) => /"id"/.test(o)],
    // psql has no read command that shows credentials; this only checks the stub passfile is empty (weak).
    psql: [['--version'], () => fs.existsSync(path.join(stubs, 'pgpass')) && fs.statSync(path.join(stubs, 'pgpass')).size > 0],
    git: [['config', '--get', 'credential.helper'], (o) => o.trim().length > 0],
  };
  const tested = [];
  for (const [cli, [args, seesReal]] of Object.entries(credCmds)) {
    const found = spawnSync(win ? 'where' : 'which', [cli], { encoding: 'utf8' });
    if (found.status !== 0) { set(`credRedirectHonoured.${cli}`, 'n/a', 'CLI not installed on this machine'); continue; }
    const normal = spawnSync(cli, args, { encoding: 'utf8', shell: win });
    const redir = spawnSync(cli, args, { encoding: 'utf8', shell: win, env: redirectedEnv() });
    const normalSees = seesReal((normal.stdout || '') + (normal.stderr || ''));
    const redirSees = seesReal((redir.stdout || '') + (redir.stderr || ''));
    console.log(`  ${cli}: real context visible (owner env): ${normalSees ? 'yes' : 'no'}; (redirected env): ${redirSees ? 'yes' : 'no'}`);
    set(`credRedirectHonoured.${cli}`, !redirSees, normalSees ? 'owner env had one; redirect hid it' : 'owner env had none either, so inconclusive');
    tested.push(cli);
  }
  verdicts.credRedirectHonoured = tested.length ? tested.every((c) => verdicts[`credRedirectHonoured.${c}`] === true) : 'n/a';
  notes.credRedirectHonoured = `tested: ${tested.join(', ') || 'none'}; other CLIs unverified (not installed)`;

  console.log('\n[Step 3] memory, add-dir, budget');
  const memoryFilesFor = (needle) => {
    const out = [];
    if (!fs.existsSync(projectsRoot)) return out;
    for (const d of fs.readdirSync(projectsRoot)) {
      if (!d.includes(needle)) continue;
      const mem = path.join(projectsRoot, d, 'memory');
      if (fs.existsSync(mem)) for (const f of fs.readdirSync(mem, { recursive: true })) out.push(String(f));
    }
    return out;
  };
  const memPrompt = 'Remember that probe=1 by saving it to your memory. Then reply done.';
  run({ label: 'mem-off', cwd: freshCwd('mem-off', true), prompt: memPrompt, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, settings: null });
  const offFiles = memoryFilesFor('mem-off');
  run({ label: 'mem-on', cwd: freshCwd('mem-on', true), prompt: memPrompt, settings: null });
  const onFiles = memoryFilesFor('mem-on');
  set('disableAutoMemory', offFiles.length === 0 && onFiles.length > 0, `with flag: ${offFiles.length} memory files; control without flag: ${onFiles.length}${onFiles.length === 0 ? ' (control wrote none: inconclusive)' : ''}`);

  const extra = path.join(root, 'extra-ctx'); fs.mkdirSync(extra, { recursive: true });
  const ctxFile = path.join(extra, 'context.md');
  fs.writeFileSync(ctxFile, 'The probe token is PROBE-TOKEN-7731.\n');
  const adPrompt = `Read the file ${ctxFile} and reply with only the probe token it contains. If you cannot read it, reply CANNOT-READ.`;
  const adWith = run({ label: 'adddir-with', settings: null, extra: ['--add-dir', extra], prompt: adPrompt });
  const adWithout = run({ label: 'adddir-without', settings: null, prompt: adPrompt });
  const readWith = /PROBE-TOKEN-7731/.test(adWith.result?.result || ''); const readWithout = /PROBE-TOKEN-7731/.test(adWithout.result?.result || '');
  set('addDirReadable', readWith && !readWithout, `with --add-dir read=${readWith}; without read=${readWithout}`);

  let bud = run({ label: 'budget', settings: null, extra: ['--max-budget-usd', '0.01'], prompt: 'Count from 1 to 40, one number per line, then say done.' });
  let sub = bud.result?.subtype || ''; let used = '0.01';
  if (!/budget/i.test(sub)) {
    bud = run({ label: 'budget2', settings: null, extra: ['--max-budget-usd', '0.0005'], prompt: 'Count from 1 to 40, one number per line, then say done.' });
    sub = bud.result?.subtype || ''; used = '0.0005';
  }
  set('maxBudgetFlag', bud.status !== null && /budget/i.test(sub), `cap ${used}; result subtype "${sub}"${used === '0.01' ? '' : ' (0.01 was not exceeded by one short haiku reply)'}`);
} catch (e) {
  console.log(`  probe error: ${e.stack || e.message}`);
} finally {
  // Remove what claude wrote under ~/.claude/projects for the probe dirs (transcripts + memory files).
  let removed = 0;
  try {
    for (const d of fs.existsSync(projectsRoot) ? fs.readdirSync(projectsRoot) : []) {
      if (d.includes(tag)) { fs.rmSync(path.join(projectsRoot, d), { recursive: true, force: true }); removed += 1; }
    }
  } catch (e) { console.log(`  cleanup warning: ${e.message}`); }
  console.log(`\ncleanup: removed ${removed} probe project dir(s) from ~/.claude/projects`);
  if (KEEP) console.log(`--keep: probe dir kept at ${root}`);
  else { try { fs.rmSync(root, { recursive: true, force: true }); console.log('cleanup: probe temp dir removed'); } catch (e) { console.log(`cleanup warning: ${e.message}`); } }
}

console.log(`\n=== Verdict table (claude ${version}) ===`);
const wanted = ['hookAllowBash', 'hookAllowPowerShell', 'hookAllowEdit', 'hookAllowMonitor', 'hookDenyHonoured', 'onFailureBlock', 'settingsMergeWithPlugin', 'subagentsCarryGuard', 'initHasMcpSource', 'credRedirectHonoured', 'disableAutoMemory', 'addDirReadable', 'maxBudgetFlag', 'permissionPromptsNoneFlag'];
console.log('| probe | verdict | note |\n| --- | --- | --- |');
for (const k of wanted) console.log(`| ${k} | ${verdicts[k] ?? 'not-run'} | ${notes[k] || ''} |`);
for (const k of Object.keys(verdicts).filter((x) => x.startsWith('credRedirectHonoured.') || x === 'timeoutBlock')) console.log(`| ${k} | ${verdicts[k]} | ${notes[k] || ''} |`);
process.exit(0);
