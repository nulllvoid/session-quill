#!/usr/bin/env node
// Per-run guard hook (spec §4.1). Claude Code starts this process for every tool call of an
// autonomous run (wired in by <runDir>/run-settings.json, src/handoff/run-settings.js). It reads
// the PreToolUse JSON on stdin and the run's QUILL_HANDOFF_* env, decides the call with the run's
// frozen grant, appends one `guard` line to <runDir>/ledger.jsonl and prints exactly one JSON
// decision on stdout. It always exits 0: the decision is in the JSON. Fail closed: when anything
// throws, the call is denied unless it is a Read/Glob/Grep inside the run's readable roots.
//
// Start-up cost is most of the hook's latency, so this loads only what decide() needs, the
// grant reader, the log redaction and the git HEAD reader; no CLI, no config.
import fs from 'node:fs';
import path from 'node:path';
import { decide, canonicalPath, isWithin } from '../src/gate/run-guard.js';
import { readGrant, GRANT_FILE } from '../src/handoff/grant.js';
import { redactCapped } from '../src/handoff/stream.js';
import { handoffRunDir } from '../src/lib/paths.js';
import { currentBranch } from '../src/lib/git-head.js';

const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const EXCERPT_BYTES = 2048;
const LEDGER_FILE = 'ledger.jsonl';
const FALLBACK_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const OVERSIZE = Symbol('oversize');

const REASONS = {
  error: 'QUILL_DENIED guard-error: the guard could not check this call, so it is refused. Try a simpler form of the call once; if that is refused too, record the step in attempts and continue with the rest of the task.',
  tooLarge: `QUILL_DENIED unparseable: this tool call is larger than the guard reads (${MAX_STDIN_BYTES / 1024 / 1024} MB). Split it into smaller calls.`,
  fallbackAllow: "guard error: a Read, Glob or Grep inside the run's readable roots is still allowed",
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

// The exception fallback: true only for a Read/Glob/Grep whose target resolves inside the readable
// roots: the grant's when it could be read, else only the checkout (hook cwd) and the run dir.
// Anything unexpected, including a throw here, means deny.
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
    const real = canonicalPath(path.resolve(s.cwd, target));
    if (!real) return false;
    const roots = s.grant ? [...strings(s.grant.readableRoots), ...strings(s.grant.writableRoots)] : [s.cwd, s.runDir];
    return roots.some((r) => {
      if (typeof r !== 'string' || !path.isAbsolute(r)) return false;
      const root = canonicalPath(r);
      return !!root && isWithin(real, root);
    });
  } catch {
    return false;
  }
}

// Decides one call. Returns { decision, reason, runDir, line } where `line` is the ledger entry: only
// classified, redacted summaries; never the raw tool input, argv, path specs or env values.
function check(raw, env) {
  const s = { input: null, cwd: process.cwd(), runDir: runDirOf(env), grant: null };
  const line = { kind: 'guard', ts: new Date().toISOString() };
  const done = (decision, reason) => ({ decision, reason, runDir: s.runDir, line });
  try {
    if (raw === OVERSIZE) {
      Object.assign(line, { tool_name: null, decision: 'deny', reason: REASONS.tooLarge, error: 'stdin-too-large' });
      return done('deny', REASONS.tooLarge);
    }
    const input = JSON.parse(raw);
    if (!isPlainObject(input)) throw new TypeError('the hook input is not a JSON object');
    s.input = input;
    if (typeof input.cwd === 'string' && path.isAbsolute(input.cwd)) s.cwd = input.cwd;
    s.grant = grantOf(s.runDir, env);
    if (env.NODE_ENV === 'test' && env.QUILL_GUARD_TEST_THROW === '1') throw new Error('QUILL_GUARD_TEST_THROW');

    const call = { tool_name: input.tool_name, tool_input: input.tool_input };
    const ctx = { cwd: s.cwd, vars: env, currentBranch: currentBranch(s.cwd) ?? undefined, defaultBranch: nonEmpty(s.grant && s.grant.defaultBranch) };
    const r = decide(call, s.grant, ctx);
    if (!r || (r.decision !== 'allow' && r.decision !== 'deny') || typeof r.reason !== 'string') throw new Error('decide returned no decision');
    // Observe mode allows everything; the ledger still says what enforce would have decided. That
    // second opinion is for the ledger only, so its failure cannot change the decision.
    let enforced = null;
    if (r.decision === 'allow' && env.QUILL_HANDOFF_GUARD === 'observe' && s.grant && s.grant.access === 'full') {
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
      tool_name: summary(input.tool_name, 200),
      decision: r.decision,
      reason: summary(r.reason, EXCERPT_BYTES),
      class: summary(cls.class, 40),
      ...(scope ? { scope: summary(scope, 200) } : {}),
      ...(target ? { target: summary(target, 300) } : {}),
      ...(change ? { critical: true } : {}),
      ...(enforced ? { enforce_decision: enforced.decision, enforce_reason: summary(enforced.reason, EXCERPT_BYTES) } : {}),
      input_excerpt: excerpt(input.tool_input),
    });
    return done(r.decision, r.reason);
  } catch (err) {
    const allow = readableAfterError(s);
    const reason = allow ? REASONS.fallbackAllow : REASONS.error;
    const input = s.input;
    Object.assign(line, {
      tool_name: input ? summary(input.tool_name, 200) : null,
      decision: allow ? 'allow' : 'deny',
      reason,
      error: errorName(err),
      ...(input ? { input_excerpt: excerpt(input.tool_input) } : {}),
    });
    return done(allow ? 'allow' : 'deny', reason);
  }
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
