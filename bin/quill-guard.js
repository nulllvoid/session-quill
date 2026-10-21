#!/usr/bin/env node
// Per-run guard hook (spec §4.1). Claude Code starts this process for every tool call of an
// autonomous run (wired in by <runDir>/run-settings.json, src/handoff/run-settings.js). It reads
// the PreToolUse JSON on stdin and the run's QUILL_HANDOFF_* env, decides the call with the run's
// frozen grant, appends one `guard` line to <runDir>/ledger.jsonl and prints exactly one JSON
// decision on stdout. It always exits 0: the decision is in the JSON. Fail closed: when anything
// throws, the call is denied unless it is a Read/Glob/Grep inside the run's readable roots. The one
// exception is full access (observe mode with a verified full grant), which never denies.
//
// Start-up cost is most of the hook's latency, so this loads only what decide() needs, the
// grant reader, the log redaction, the git HEAD reader and the MCP sources reader; no CLI, no config.
import fs from 'node:fs';
import path from 'node:path';
import { decide, readableUnder } from '../src/gate/run-guard.js';
import { readGrant, GRANT_FILE } from '../src/handoff/grant.js';
import { redactCapped, summarizeInput } from '../src/handoff/stream.js';
import { handoffRunDir } from '../src/lib/paths.js';
import { currentBranch } from '../src/lib/git-head.js';
import { sourceOfTool, MCP_SERVERS_FILE } from '../src/handoff/mcp-sources.js';
import { driftOfCall } from '../src/core/planned-paths.js';

const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const EXCERPT_BYTES = 2048;
const LEDGER_FILE = 'ledger.jsonl';
const FALLBACK_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const OVERSIZE = Symbol('oversize');
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const REASONS = {
  error: 'QUILL_DENIED guard-error: the guard could not check this call, so it is refused. Try a simpler form of the call once; if that is refused too, record the step in attempts and continue with the rest of the task.',
  tooLarge: `QUILL_DENIED unparseable: this tool call is larger than the guard reads (${MAX_STDIN_BYTES / 1024 / 1024} MB). Split it into smaller calls.`,
  fallbackAllow: "guard error: a Read, Glob or Grep inside the run's readable roots is still allowed",
  observeError: 'full access (observe only): the guard could not check this call; it is allowed and recorded in the ledger',
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);
const nonEmpty = (v) => (typeof v === 'string' && v ? v : undefined);

function output(decision, reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });
}

function runDirOf(env) {
  try { return env.QUILL_HANDOFF_ID ? handoffRunDir(env, env.QUILL_HANDOFF_ID) : null; } catch { return null; }
}

// readGrant's result, or null when it throws (missing, tampered, invalid, or no hash in env).
function grantOf(runDir, env) {
  if (!runDir) return null;
  try { return readGrant(path.join(runDir, GRANT_FILE), env.QUILL_HANDOFF_GRANT_SHA256); } catch { return null; }
}

// A Glob pattern or Grep glob the fallback can trust to stay below its search directory.
const staysBelow = (p) => typeof p === 'string' && !p.includes('..') && !p.startsWith('~') && !path.isAbsolute(p) && !/^[\\/]|^[A-Za-z]:/.test(p);

// The exception fallback: true only for a Read/Glob/Grep whose target decide's read rule allows
// under these roots: the grant's when it could be read, else only the checkout (hook cwd) and the
// run dir. Links are resolved, and the unreadable carve-outs (credentials, Claude's settings, the
// Quill home outside deeper roots) win over a broader root. Anything unexpected means deny.
function readableAfterError(s) {
  try {
    const input = s.input;
    const tool = input && input.tool_name;
    const ti = input && input.tool_input;
    if (!FALLBACK_TOOLS.has(tool) || !isPlainObject(ti)) return false;
    let target;
    if (tool === 'Read') {
      target = ti.file_path;
    } else {
      if (tool === 'Glob' && !staysBelow(ti.pattern)) return false;
      if (tool === 'Grep' && ti.glob !== undefined && !staysBelow(ti.glob)) return false;
      target = ti.path === undefined || ti.path === null ? s.cwd : ti.path;
    }
    if (typeof target !== 'string' || !target) return false;
    const roots = s.grant ? [...strings(s.grant.readableRoots), ...strings(s.grant.writableRoots)] : [s.cwd, s.runDir];
    return readableUnder(path.resolve(s.cwd, target), roots, s.env) === true;
  } catch {
    return false;
  }
}

// Decides one call. Returns { decision, reason, runDir, line } where `line` is the ledger entry: only
// classified, redacted summaries; never the raw tool input, argv, path specs or env values.
function check(raw, env) {
  const s = { input: null, cwd: process.cwd(), runDir: runDirOf(env), grant: null, observe: false, env };
  const line = { kind: 'guard', ts: new Date().toISOString() };
  const done = (decision, reason) => ({ decision, reason, runDir: s.runDir, line });
  try {
    // Read first: with full access (observe mode and a verified full grant) even the guard's own
    // failures allow, since a full-access run is never refused; the ledger still records them.
    s.grant = grantOf(s.runDir, env);
    s.observe = env.QUILL_HANDOFF_GUARD === 'observe' && !!s.grant && s.grant.access === 'full';
    if (raw === OVERSIZE) {
      const decision = s.observe ? 'allow' : 'deny';
      const reason = s.observe ? REASONS.observeError : REASONS.tooLarge;
      Object.assign(line, { tool_name: null, decision, reason, error: 'stdin-too-large' });
      return done(decision, reason);
    }
    const input = JSON.parse(raw);
    if (!isPlainObject(input)) throw new TypeError('the hook input is not a JSON object');
    s.input = input;
    if (typeof input.cwd === 'string' && path.isAbsolute(input.cwd)) s.cwd = input.cwd;
    if (env.NODE_ENV === 'test' && env.QUILL_GUARD_TEST_THROW === '1') throw new Error('QUILL_GUARD_TEST_THROW');

    // An MCP call's server source comes from the run's init inventory (R20): a server the file
    // does not list, or no file, is 'unknown', which decide trusts only by name from the grant.
    const mcp = typeof input.tool_name === 'string' && input.tool_name.startsWith('mcp__');
    const call = { tool_name: input.tool_name, tool_input: input.tool_input, ...(mcp ? { mcp_server_source: s.runDir ? sourceOfTool(input.tool_name, path.join(s.runDir, MCP_SERVERS_FILE)) : 'unknown' } : {}) };
    const ctx = { cwd: s.cwd, vars: env, currentBranch: currentBranch(s.cwd) ?? undefined, defaultBranch: nonEmpty(s.grant && s.grant.defaultBranch) };
    const r = decide(call, s.grant, ctx);
    if (!r || (r.decision !== 'allow' && r.decision !== 'deny') || typeof r.reason !== 'string') throw new Error('decide returned no decision');
    // Observe mode allows everything; the ledger still says what enforce would have decided. That
    // second opinion is for the ledger only, so its failure cannot change the decision.
    let enforced = null;
    if (r.decision === 'allow' && s.observe) {
      try {
        enforced = decide(call, s.grant, { ...ctx, vars: { ...env, QUILL_HANDOFF_GUARD: 'enforce' } });
      } catch (err) {
        enforced = { decision: 'unknown', reason: `the enforce check failed (${errorName(err)})` };
      }
    }
    const cls = isPlainObject(r.classification) ? r.classification : {};
    const change = isPlainObject(r.criticalChange) ? r.criticalChange : null;
    const scope = change ? change.scope : cls.scope;
    const target = change ? change.target : cls.target ?? cls.host;
    Object.assign(line, {
      ...callFields(s),
      decision: r.decision,
      reason: summary(r.reason, EXCERPT_BYTES),
      class: summary(cls.class, 40),
      ...(scope ? { scope: summary(scope, 200) } : {}),
      ...(target ? { target: summary(target, 300) } : {}),
      ...(change ? { critical: true } : {}),
      ...(change && change.ambiguous === true ? { ambiguous: true } : {}),
      ...(enforced ? { enforce_decision: enforced.decision, enforce_reason: summary(enforced.reason, EXCERPT_BYTES) } : {}),
      // Planned files (ADR 0037): marked after the decision and never fed back into it.
      ...(r.decision === 'allow' && plannedDrift(input, s) ? { drift: true } : {}),
    });
    return done(r.decision, r.reason);
  } catch (err) {
    const allow = s.observe || readableAfterError(s);
    const reason = s.observe ? REASONS.observeError : allow ? REASONS.fallbackAllow : REASONS.error;
    Object.assign(line, { ...callFields(s), decision: allow ? 'allow' : 'deny', reason, error: errorName(err) });
    return done(allow ? 'allow' : 'deny', reason);
  }
}

// What the ledger keeps about the call itself: its tool, the host's tool_use_id, the stream's
// one-line summary (so reconcile can match this line with the stream's lines of the same call)
// and a capped excerpt of the input, all redacted.
function callFields(s) {
  const input = s.input;
  if (!input) return { tool_name: null };
  let input_summary = null;
  try { input_summary = summarizeInput(input.tool_name, input.tool_input, s.cwd); } catch { input_summary = null; }
  return {
    tool_name: summary(input.tool_name, 200),
    ...(typeof input.tool_use_id === 'string' && TOOL_USE_ID.test(input.tool_use_id) ? { tool_use_id: input.tool_use_id } : {}),
    input_summary,
    input_excerpt: excerpt(input.tool_input),
  };
}

// Whether an allowed file write lands outside the grant's planned files. A failure here only
// leaves the mark off: it can never change the decision already made.
function plannedDrift(input, s) {
  try { return driftOfCall(input.tool_name, input.tool_input, s.grant, s.cwd); } catch { return false; }
}

function summary(v, max) {
  if (v === undefined || v === null) return null;
  try { return redactCapped(String(v), max); } catch { return null; }
}

function excerpt(toolInput) {
  try { return redactCapped(JSON.stringify(toolInput ?? null), EXCERPT_BYTES); } catch { return null; }
}

function errorName(err) {
  const name = err && typeof err.code === 'string' ? err.code : err && typeof err.name === 'string' ? err.name : 'Error';
  return name.slice(0, 60);
}

// One append per line, so the worker's stream writer and this hook never interleave partial
// lines. A failed write never changes the decision.
function appendLedger(runDir, line) {
  if (!runDir) return;
  try { fs.appendFileSync(path.join(runDir, LEDGER_FILE), `${JSON.stringify(line)}\n`, { mode: 0o600 }); } catch { /* the decision stands */ }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  let bytes = 0;
  for await (const c of process.stdin) {
    bytes += c.length;
    if (bytes <= MAX_STDIN_BYTES) chunks.push(c);
  }
  return bytes > MAX_STDIN_BYTES ? OVERSIZE : Buffer.concat(chunks).toString('utf8');
}

process.stdout.on('error', () => { /* the host went away; nothing left to tell it */ });
let text;
try {
  let raw;
  try { raw = await readStdin(); } catch { raw = ''; }
  const { decision, reason, runDir, line } = check(raw, process.env);
  appendLedger(runDir, line);
  text = output(decision, reason);
} catch {
  text = output('deny', REASONS.error);
}
process.stdout.write(text);
process.exitCode = 0;
