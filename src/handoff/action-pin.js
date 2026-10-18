// Action pins (spec §7, ADR 0028; ruling R40). A done run's critical_changes[] entry names the one
// write it could not make; its `action` becomes a pin. Each pin carries two forms:
//   - `normalized`: order-insensitive (options before or after the verb, `--opt v` or `--opt=v`),
//     used by pinMatches and by the reducer to check a critical-proposal against the run's result;
//   - `guard`: what the run guard (Task 7) enforces in the approved run's grant: a shell pin is the
//     exact command as written, an MCP pin is `<tool name> <canonical JSON of the whole input>`.
// A pin is ONE plain command (the shape scope-commands.js `plainCommand` checks, ruling R25):
// an environment prefix, wrapper, chain, redirect or expansion pins nothing and matches nothing.
// Free-form values (image tags, --set values, URLs) are kept exact; repeated options keep their
// order; a tool or option the built-in tables do not know keeps the exact word order (fail-safe).
import { canonicalJson } from './grant.js';
import { plainCommand, BUILTIN_COMMANDS } from '../gate/scope-commands.js';

const SHELLS = { Bash: 'bash', Monitor: 'bash', PowerShell: 'powershell' };
const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_.-]{1,200}$/;
// Arguments that say which thing an MCP call acts on (issue key, app name, channel …), for display.
const ID_KEY_RE = /^(?:id|key|name|app|appname|app_name|application|channel|channel_id|issue|issuekey|issue_key|issueidorkey|project|projectkey|project_key|page|pageid|page_id|space|spacekey|space_key|repo|repository|owner|cloudid|environment|env|namespace|cluster|context|service|database|host)$/i;
const ID_SUFFIX_RE = /[a-z0-9](?:Id|ID|Key|_id|_key)$/;
// Options whose value is the namespace, surfaced on their own (spec §7.1).
const NAMESPACE_OPTIONS = { kubectl: ['-n', '--namespace'], helm: ['-n', '--namespace'] };

// Control (Cc), format (Cf: zero-width, bidi marks, embeddings, overrides and isolates, soft hyphen,
// BOM) and line/paragraph separator characters. An action holding one is never pinned: what the
// owner reads must be what the guard enforces, and nothing is ever stripped from an action (R45).
export const HIDDEN_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ID_VALUE_MAX = 200;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isOption = (t) => t.length > 1 && t.startsWith('-') && !/^-\d/.test(t);

// The built-in tool spec of a binary (the first scope that lists it), or null.
function specOf(bin) {
  for (const tools of Object.values(BUILTIN_COMMANDS)) if (Object.hasOwn(tools, bin)) return tools[bin];
  return null;
}

// The order-free reading of a known tool's arguments, or null when any word is outside its table.
function structured(bin, spec, args) {
  const ps = spec.ps === true;
  const key = (n) => (ps ? n.toLowerCase() : n);
  const options = Object.fromEntries(Object.entries(spec.options ?? {}).map(([k, kind]) => [key(k), kind]));
  const targetOpts = new Set((spec.target && spec.target.options ? spec.target.options : []).map(key));
  const nsOpts = new Set((NAMESPACE_OPTIONS[bin] ?? []).map(key));
  const positionals = [];
  const flags = [];
  const values = [];
  const targets = [];
  const namespaces = [];
  const urls = [];
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if (t === '--' || t === '--%') return null;
    if (!isOption(t)) { positionals.push(t); continue; }
    const sep = ps ? t.indexOf(':', 1) : t.indexOf('=');
    const name = key(sep > 0 ? t.slice(0, sep) : t);
    let val = sep > 0 ? t.slice(sep + 1) : undefined;
    const kind = targetOpts.has(name) ? 'target' : Object.hasOwn(options, name) ? options[name] : null;
    if (!kind) return null;
    if (kind === 'flag') { if (val !== undefined) return null; flags.push(name); continue; }
    if (kind === 'bool') {
      if (val === undefined) val = 'true';
      else if (!/^(true|false)$/.test(val)) return null;
      values.push([name, val]);
      continue;
    }
    if (val === undefined) {
      val = args[i + 1];
      if (val === undefined || isOption(val)) return null;
      i += 1;
    }
    if (kind === 'url') urls.push(val);
    if (kind === 'target') targets.push(val);
    else if (nsOpts.has(name)) namespaces.push(val);
    else values.push([name, val]);
  }
  if (targets.length > 1 || namespaces.length > 1) return null;
  let verb = '';
  let rest = positionals;
  const verbs = Array.isArray(spec.verbs) ? spec.verbs : [];
  if (verbs.length) {
    const hit = verbs.map((x) => x.split(' ')).filter((w) => w.length <= positionals.length && w.every((x, j) => positionals[j] === x)).sort((a, c) => c.length - a.length)[0];
    if (!hit) return null;
    verb = hit.join(' ');
    rest = positionals.slice(hit.length);
  }
  // Sorted by option name only: a stable sort keeps repeated options (helm --set) in their order.
  const ordered = values.slice().sort((a, c) => (a[0] < c[0] ? -1 : a[0] > c[0] ? 1 : 0)).map(([n, v]) => `${n}=${v}`);
  return { verb, args: rest, context: targets[0] ?? null, namespace: namespaces[0] ?? null, flags: flags.slice().sort(), values: ordered, target: targetOf(spec, targets, rest, urls) };
}

// What the tool's own table says the command acts on (spec §7.5 target binding): the target
// option's value (kubectl/helm context, cloud profile, DB host, stack), the first argument (the
// Argo CD app) or the host of the one http(s) URL. Null when the table names none or it is unclear.
function targetOf(spec, targets, args, urls) {
  const t = spec.target ?? null;
  if (!t) return null;
  if (t.options) return targets[0] ?? null;
  if (t.positional) return args[0] ?? null;
  if (t.url) {
    const all = [...urls, ...args.filter((a) => /^https?:\/\//i.test(a))];
    if (all.length !== 1) return null;
    try { return new URL(all[0]).hostname.toLowerCase().replace(/\.$/, '') || null; } catch { return null; }
  }
  return null;
}

// Whether any key or string value of a JSON value holds a hidden character.
function hasHidden(value, depth = 0) {
  if (depth > 20) return true;
  if (typeof value === 'string') return HIDDEN_CHAR_RE.test(value);
  if (Array.isArray(value)) return value.some((v) => hasHidden(v, depth + 1));
  if (isPlainObject(value)) return Object.entries(value).some(([k, v]) => HIDDEN_CHAR_RE.test(k) || hasHidden(v, depth + 1));
  return false;
}

function shellPin(command, dialect) {
  if (typeof command !== 'string' || HIDDEN_CHAR_RE.test(command)) return null;
  const plain = plainCommand(command, dialect);
  if (plain.why || plain.argv.some((w) => HIDDEN_CHAR_RE.test(w))) return null;
  const binary = plain.bin;
  const args = plain.argv.slice(1);
  const guard = command.trim();
  const spec = specOf(binary);
  const s = spec ? structured(binary, spec, args) : null;
  if (!s) {
    return { kind: 'bash', binary, exact: true, values: args, flags: [], normalized: canonicalJson({ kind: 'bash', binary, exact: args }), guard };
  }
  const pin = { kind: 'bash', binary };
  if (s.verb) pin.verb = s.verb;
  if (s.args.length) pin.resource = s.args.join(' ');
  if (s.context !== null) pin.context = s.context;
  if (s.namespace !== null) pin.namespace = s.namespace;
  if (s.target !== null) pin.target = s.target;
  pin.flags = s.flags;
  pin.values = s.values;
  pin.normalized = canonicalJson({ kind: 'bash', binary, verb: s.verb, args: s.args, context: s.context, namespace: s.namespace, flags: s.flags, values: s.values });
  pin.guard = guard;
  return pin;
}

function mcpPin(tool, action) {
  let input = action;
  if (typeof input === 'string') {
    if (HIDDEN_CHAR_RE.test(input)) return null;
    try { input = JSON.parse(input); } catch { return null; }
  }
  if (!isPlainObject(input) || hasHidden(input)) return null;
  const ids = {};
  for (const k of Object.keys(input).sort()) {
    const v = input[k];
    if ((ID_KEY_RE.test(k) || ID_SUFFIX_RE.test(k)) && (typeof v === 'string' || typeof v === 'number')) ids[k] = String(v).slice(0, ID_VALUE_MAX);
  }
  const json = canonicalJson(input);
  return { kind: 'mcp', tool_name: tool, ids, normalized: canonicalJson({ kind: 'mcp', tool_name: tool, input: JSON.parse(json) }), guard: `${tool} ${json}` };
}

/**
 * The pin of one action, or null when it is not one plain shell command or an MCP call with a JSON
 * object input.
 * @param {{ tool: string, action: string|object }} a  tool: `Bash`, `PowerShell` or an `mcp__…`
 *   tool name; action: the command text, or the MCP input (an object or its JSON text)
 * @returns {{ kind: 'bash'|'mcp', binary?, verb?, resource?, context?, namespace?, flags?: string[],
 *   values?: string[], exact?: true, tool_name?, ids?: Record<string,string>, normalized: string,
 *   guard: string }|null}
 */
export function pinAction({ tool, action } = {}) {
  if (typeof tool !== 'string') return null;
  if (Object.hasOwn(SHELLS, tool)) return shellPin(action, SHELLS[tool]);
  if (MCP_TOOL_RE.test(tool)) return mcpPin(tool, action);
  return null;
}

/**
 * Whether a tool call is exactly the pinned action: normalised equality, so the context, namespace,
 * app and every value must match exactly; a call that is not one plain command never matches.
 * @param {object} pin  a pinAction() result
 * @param {{ tool_name: string, tool_input: object }} call  the guard's call shape
 */
export function pinMatches(pin, call) {
  if (!isPlainObject(pin) || typeof pin.normalized !== 'string' || !isPlainObject(call)) return false;
  const tool = call.tool_name;
  const input = isPlainObject(call.tool_input) ? call.tool_input : null;
  let got = null;
  if (typeof tool === 'string' && Object.hasOwn(SHELLS, tool)) got = pinAction({ tool, action: input ? input.command : null });
  else if (typeof tool === 'string' && MCP_TOOL_RE.test(tool) && input) got = pinAction({ tool, action: input });
  return !!got && got.kind === pin.kind && got.normalized === pin.normalized;
}

/**
 * The pin of a critical_changes entry: `<mcp tool name> <JSON input>` is an MCP call, anything else
 * is read as one shell command (Bash). Null when the action cannot be pinned.
 */
export function pinOfChange(change) {
  const action = isPlainObject(change) && typeof change.action === 'string' ? change.action.trim() : '';
  if (!action) return null;
  if (action.startsWith('mcp__')) {
    const m = /^(\S+)\s+([\s\S]+)$/.exec(action);
    return m ? pinAction({ tool: m[1], action: m[2] }) : null;
  }
  return pinAction({ tool: 'Bash', action });
}
