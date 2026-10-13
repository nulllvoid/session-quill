// Reads `claude -p --output-format stream-json --verbose` line by line (spec §5.4): the init event
// hands the session id over as soon as it arrives, the run's result comes only from the final
// `result` event, every tool call goes to a redacted per-run ledger, and the log keeps assistant
// text and tool names but never tool result bodies. Memory stays bounded: init, the last result
// and a rolling window of other lines.
import fs from 'node:fs';
import path from 'node:path';
import { redactText } from '../export/sanitize.js';
import { writeMcpServersFile } from './mcp-sources.js';

export const EXCERPT_BYTES = 2048;
// The reason codes bin/quill-guard.js puts first in a refusal, as the host shows them.
// Anchored to the start of the result text: Claude Code puts the hook error first, and a command's
// own output can never come first (a failed command's result starts "Exit code N").
const GUARD_REFUSAL = /^\s*(?:PreToolUse:\S{1,200} hook error: )?(?:QUILL_(?:DENIED|CRITICAL_CHANGE)\b|QUILL-GUARD\b)/;
// The host's tool_use_id, kept on ledger lines so one call's lines can be matched up.
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const idOf = (id) => (typeof id === 'string' && TOOL_USE_ID.test(id) ? { tool_use_id: id } : {});
const SUMMARY_CHARS = 300;
const LOG_TEXT_BYTES = 65_536;
// A single line longer than this many UTF-8 bytes (no newline in sight) is dropped rather than
// held in memory. The pending line sits outside the rolling window, so this is its own bound.
const MAX_LINE_BYTES = 16 * 1_048_576;
// Text is cut to this before it is redacted, so redaction cost never scales with a huge result.
const PRECAP_BYTES = 4 * EXCERPT_BYTES;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SESSION_RE = /^[\w-]{1,100}$/;

// Provider tokens, cloud keys, private keys, URL credentials and `secret=value` pairs, on top of
// the export path redaction. Every quantifier is bounded or anchored on a literal, so the cost is
// linear in the input (a long run of word characters must not go quadratic).
const R = '[secret redacted]';
const PEM_BEGIN = /-----BEGIN ([A-Z ]{0,40})PRIVATE KEY-----/y;
const TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_\w{20,255}|glpat-[\w-]{20,255}|xox[abprs]-[\w-]{10,255}|xapp-[\w-]{10,255}|npm_[A-Za-z0-9]{30,255}|sk-[A-Za-z0-9_-]{20,255}|AKIA[0-9A-Z]{16})\b/g;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,1000}/gi;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:]{1,200}:[^\s/@]{1,200}@/gi;
// The key starts at the keyword (any prefix such as GH_ stays in place), may carry a short suffix
// and a closing quote (JSON), then `=` or `:`. Purely numeric values (max_tokens=4096) are kept.
const SECRET_ASSIGN = /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[\w.-]{0,40}["']?\s{0,10}[=:]\s{0,10})(?!["']?\d+["']?(?:[\s,;})\]]|$))("[^"\n]{0,1000}"|'[^'\n]{0,1000}'|[^\s,;})\]]{1,1000})/gi;

// Private key blocks, found with indexOf rather than a lazy regex: each BEGIN either finds its END
// further on (scanning resumes after it) or has none, and then everything after it goes, as for a
// key cut off by a length cap. Each character is scanned a bounded number of times.
function redactPem(text) {
  let out = '';
  let pos = 0;
  for (;;) {
    const at = text.indexOf('-----BEGIN ', pos);
    if (at < 0) return out + text.slice(pos);
    PEM_BEGIN.lastIndex = at;
    const m = PEM_BEGIN.exec(text);
    if (!m) { out += text.slice(pos, at + 11); pos = at + 11; continue; }
    const endMark = `-----END ${m[1]}PRIVATE KEY-----`;
    const end = text.indexOf(endMark, PEM_BEGIN.lastIndex);
    if (end < 0) return `${out}${text.slice(pos, at)}${R}`;
    out += `${text.slice(pos, at)}${R}`;
    pos = end + endMark.length;
  }
}

// A secret-looking fragment left at the very end of a cut (its rest fell past the cut). Only the
// last 300 characters are examined, so this stays cheap on long text.
const TRAILING_SECRET = /(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|xapp-|npm_|sk-|AKIA|-----BEGIN )\S*$/;
function dropTrailingSecret(text) {
  const tail = text.slice(-300);
  const m = TRAILING_SECRET.exec(tail);
  return m ? text.slice(0, text.length - tail.length + m.index) : text;
}

const DELIMITER = /[\s,;"'<>()[\]{}]/;
// Cut to `max` bytes, then back to the last delimiter within 1 KB, so the cut never splits a
// secret (a split token is too short to be recognised and would leak its prefix).
function cutAtBoundary(text, max) {
  if (Buffer.byteLength(text) <= max) return text;
  const s = capBytes(text, max);
  for (let i = s.length - 1; i >= Math.max(0, s.length - 1024); i--) if (DELIMITER.test(s[i])) return s.slice(0, i + 1);
  return dropTrailingSecret(s);
}

export function redactLog(text) {
  return redactText(redactPem(String(text ?? ''))
    .replace(URL_USERINFO, `$1${R}@`)
    .replace(TOKENS, R)
    .replace(AUTH_SCHEME, `$1 ${R}`)
    .replace(SECRET_ASSIGN, `$1${R}`));
}

// Redact a bounded slice of `text`, then cut it to `max` bytes; neither cut leaves part of a
// secret behind.
export function redactCapped(text, max) {
  const red = redactLog(cutAtBoundary(String(text ?? ''), Math.max(max, PRECAP_BYTES)));
  return Buffer.byteLength(red) <= max ? red : dropTrailingSecret(capBytes(red, max));
}

// Cut to at most `max` UTF-8 bytes without splitting a character.
export function capBytes(text, max) {
  if (Buffer.byteLength(text) <= max) return text;
  let s = Buffer.from(text).subarray(0, max).toString('utf8');
  while (Buffer.byteLength(s) > max || s.endsWith('�')) s = s.slice(0, -1);
  return s;
}

// Log text (and the window handed back by end()): redacted and capped, marked when it was cut.
function logText(s) {
  const out = redactCapped(s, LOG_TEXT_BYTES);
  return Buffer.byteLength(s) > LOG_TEXT_BYTES ? `${out} … [truncated]` : out;
}

const oneLine =(s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : c && c.type ? `[${c.type}]` : '')).filter(Boolean).join('\n');
}

function relative(p, cwd) {
  if (typeof p !== 'string') return '';
  if (cwd && path.isAbsolute(p)) {
    const rel = path.relative(cwd, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return p;
}

// What the call was about, in one short redacted line: the command for a shell, the file for a
// file tool, the pattern for a search, the URL for a fetch, otherwise the input JSON.
export function summarizeInput(tool, input, cwd = null) {
  const i = input && typeof input === 'object' ? input : {};
  let s;
  if (SHELL_TOOLS.has(tool)) s = i.command;
  else if (FILE_TOOLS.has(tool)) s = relative(i.file_path ?? i.notebook_path, cwd);
  else if (tool === 'Grep' || tool === 'Glob') s = [i.pattern, i.path ? relative(i.path, cwd) : null].filter(Boolean).join(' in ');
  else if (tool === 'WebFetch') s = i.url;
  else if (tool === 'WebSearch') s = i.query;
  else if (tool === 'Task' || tool === 'Agent') s = i.description ?? i.subagent_type;
  if (typeof s !== 'string' || !s) { try { s = JSON.stringify(i); } catch { s = ''; } }
  return oneLine(redactCapped(s, PRECAP_BYTES), SUMMARY_CHARS);
}

// The exit code a shell tool result exposes, else null (never a guess from is_error alone).
// Claude Code reports a non-zero exit as an error starting "Exit code N"; a command that finished
// with 0 comes back as a non-error with a structured tool_use_result (stdout, stderr,
// interrupted…) — verified on claude 2.1.296. An interrupted or backgrounded command has no exit
// code yet, so it stays null.
function exitCodeOf(item, event, text, tool) {
  const raw = event && event.tool_use_result;
  const extra = raw && typeof raw === 'object' ? raw : {};
  for (const v of [extra.exitCode, extra.exit_code, extra.returnCode, extra.code]) if (Number.isInteger(v)) return v;
  // "Exit code N" is read only from an error result: a successful command's own output may start so.
  const m = item.is_error === true ? /^\s*Exit code (-?\d+)\b/.exec(text) : null;
  if (m) return Number(m[1]);
  // Only the Bash tool's finished shape was verified (claude 2.1.296); a PowerShell result keeps
  // what its structured field or its error text says, never an inferred 0.
  if (tool !== 'Bash') return null;
  const finished = raw && typeof raw === 'object' && item.is_error !== true && extra.interrupted === false
    && !('backgroundTaskId' in extra) && !('backgroundTaskID' in extra) && !('shellId' in extra);
  return finished ? 0 : null;
}

// `mcpServersPath`: where the init event's MCP server sources go ({ name: source }), written as
// soon as init arrives so the guard can tell a claude.ai, user or plugin server from a project one
// (ruling R20). A later init (a follow-up turn) replaces it.
export function createStreamCollector({ logPath = null, ledgerPath = null, mcpServersPath = null, onInit = null, maxWindowBytes = 1_048_576, cwd = null, now = () => new Date().toISOString() } = {}) {
  let pending = '';
  let pendingBytes = 0; // UTF-8 bytes of `pending`, bounded by MAX_LINE_BYTES (outside the window)
  let skipping = false; // inside an over-long line, dropping until its newline
  let init = null;
  let result = null;
  let truncated = false;
  const window = [];
  let windowBytes = 0;
  const toolCalls = new Map(); // tool_use_id -> { tool, summary }
  const denied = new Set(); // tool_use_ids already recorded as denials
  let logFd = null;
  let ledgerFd = null;

  const open = (p, fd) => {
    if (fd !== null || !p) return fd;
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); return fs.openSync(p, 'a'); } catch { return -1; }
  };
  function log(line) {
    logFd = open(logPath, logFd);
    if (logFd >= 0 && logFd !== null) { try { fs.writeSync(logFd, `${line}\n`); } catch { /* ignore */ } }
  }
  function ledger(entry) {
    ledgerFd = open(ledgerPath, ledgerFd);
    // One write per line, so a crash tears at most the last line (readLedger skips it).
    if (ledgerFd >= 0 && ledgerFd !== null) { try { fs.writeSync(ledgerFd, `${JSON.stringify({ t: now(), ...entry })}\n`); } catch { /* ignore */ } }
  }
  function keep(line) {
    const bytes = Buffer.byteLength(line);
    window.push({ line, bytes });
    windowBytes += bytes;
    while (windowBytes > maxWindowBytes && window.length) { windowBytes -= window.shift().bytes; truncated = true; }
  }
  function denial(tool, toolUseId, input, outcome) {
    if (toolUseId && denied.has(toolUseId)) return;
    if (toolUseId) denied.add(toolUseId);
    ledger({ kind: 'denial', tool: tool ?? null, ...idOf(toolUseId), input_summary: summarizeInput(tool, input, cwd), decision: 'deny', outcome: outcome ?? null });
    log(`[denied] ${tool ?? 'unknown tool'}`);
  }

  function handle(obj, line) {
    if (obj.type === 'system' && obj.subtype === 'init') {
      if (!init) init = obj;
      const mcp = Array.isArray(obj.mcp_servers) ? obj.mcp_servers.map((s) => `${s && s.name}:${s && s.status}`).join(', ') : '';
      log(`[init] session=${obj.session_id ?? '?'} model=${obj.model ?? '?'} version=${obj.claude_code_version ?? '?'} tools=${Array.isArray(obj.tools) ? obj.tools.length : 0} mcp=[${mcp}]`);
      if (mcpServersPath) { try { writeMcpServersFile(mcpServersPath, obj); } catch { /* the guard then trusts no server by source */ } }
      if (onInit) { try { onInit(obj); } catch { /* the stream carries on */ } }
      return;
    }
    if (obj.type === 'result') {
      result = obj;
      log(`[result] ${logText(line)}`);
      for (const d of Array.isArray(obj.permission_denials) ? obj.permission_denials : []) if (d) denial(d.tool_name, d.tool_use_id, d.tool_input, 'listed in permission_denials');
      return;
    }
    keep(line);
    if (obj.type === 'system' && obj.subtype === 'permission_denied') {
      denial(obj.tool_name ?? obj.tool ?? null, obj.tool_use_id ?? null, obj.tool_input ?? obj.input ?? null, obj.decision_reason_type ?? obj.reason ?? null);
      return;
    }
    const content = obj.message && Array.isArray(obj.message.content) ? obj.message.content : [];
    if (obj.type === 'assistant') {
      for (const c of content) {
        if (!c) continue;
        if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) log(`[assistant] ${logText(c.text)}`);
        if (c.type === 'tool_use') {
          const tool = typeof c.name === 'string' ? c.name : null;
          const summary = summarizeInput(tool, c.input, cwd);
          if (c.id) toolCalls.set(c.id, { tool, summary });
          log(`[tool] ${tool ?? 'unknown'}`);
          ledger({ kind: 'tool_use', tool, ...idOf(c.id), input_summary: summary });
        }
      }
      return;
    }
    if (obj.type === 'user') {
      for (const c of content) {
        if (!c || c.type !== 'tool_result') continue;
        const call = toolCalls.get(c.tool_use_id) ?? { tool: null, summary: '' };
        const { tool } = call;
        const text = contentText(c.content);
        const isError = c.is_error === true;
        // A guard hook's deny reaches the model as a tool error carrying the guard's reason:
        // 'PreToolUse:<tool> hook error: QUILL_DENIED …' on claude 2.1.296 (task 8 fix round 1
        // probe). QUILL-GUARD is the wording research 03 E3 recorded.
        const guard = isError && GUARD_REFUSAL.test(text);
        const entry = { kind: guard ? 'guard' : 'tool_result', tool, ...idOf(c.tool_use_id), input_summary: call.summary, is_error: isError, result_excerpt: redactCapped(text, EXCERPT_BYTES) };
        if (guard) Object.assign(entry, { decision: 'deny' });
        if (SHELL_TOOLS.has(tool)) entry.exit_code = exitCodeOf(c, obj, text, tool);
        ledger(entry);
      }
    }
  }

  function line(raw) {
    const s = raw.replace(/\r$/, '');
    if (!s.trim()) return;
    let obj;
    try { obj = JSON.parse(s); } catch { obj = null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      keep(s);
      log(`[stdout] ${s.slice(0, 500)}`);
      return;
    }
    handle(obj, s);
  }

  return {
    push(chunk) {
      let text = String(chunk ?? '');
      for (;;) {
        const nl = text.indexOf('\n');
        if (nl < 0) break;
        const head = text.slice(0, nl);
        text = text.slice(nl + 1);
        if (skipping) { skipping = false; pending = ''; pendingBytes = 0; continue; }
        const full = pending + head;
        pending = '';
        pendingBytes = 0;
        try { line(full); } catch { /* one bad line never stops the stream */ }
      }
      if (skipping || !text) return;
      pending += text;
      pendingBytes += Buffer.byteLength(text);
      if (pendingBytes > MAX_LINE_BYTES) { pending = ''; pendingBytes = 0; skipping = true; truncated = true; }
    },
    // A last line without a newline counts only if it is complete JSON; a line cut off by a crash
    // or a kill is ignored, so it can never pose as the result.
    end() {
      if (pending && !skipping) {
        try {
          const obj = JSON.parse(pending.replace(/\r$/, ''));
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) handle(obj, pending);
        } catch { /* partial line */ }
      }
      pending = '';
      pendingBytes = 0;
      for (const fd of [logFd, ledgerFd]) if (fd !== null && fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      logFd = null;
      ledgerFd = null;
      return { init, result, truncated, tail: window.map((w) => logText(w.line)) };
    },
  };
}

// What `--output-format json` used to carry, taken from the final result event only.
export function resultFromStream(collected) {
  const r = collected && collected.result;
  if (!r || typeof r !== 'object') throw new Error('no-result');
  const sid = typeof r.session_id === 'string' && SESSION_RE.test(r.session_id) ? r.session_id : null;
  return {
    text: typeof r.result === 'string' ? r.result : '',
    is_error: r.is_error === true,
    session_id: sid,
    num_turns: Number.isFinite(r.num_turns) ? r.num_turns : null,
    total_cost_usd: Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : null,
    subtype: typeof r.subtype === 'string' ? r.subtype : null,
  };
}

// A session id from init that is safe to record and to pass to --resume.
export function sessionIdOf(event) {
  return event && typeof event.session_id === 'string' && SESSION_RE.test(event.session_id) ? event.session_id : null;
}

// The ledger as written so far; a line torn by a crash mid-append is skipped.
export function readLedger(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o && typeof o === 'object') out.push(o); } catch { /* torn line */ }
  }
  return out;
}
