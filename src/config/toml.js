// Restricted TOML subset used for quill-written configuration.
// Supported: comments, `key = value` with string/integer/boolean/array-of-strings values,
// and `[dotted.table]` headers. Anything else is rejected with a diagnostic rather than
// parsed lossily (TRD §Configuration and packaging).
import { TrackerError } from '../lib/errors.js';

const KEY_RE = /^[A-Za-z0-9_-]+$/;

function unsupported(line, lineNo, why) {
  return new TrackerError('toml-unsupported', `config line ${lineNo}: ${why}: ${line.trim()}`);
}

function parseString(raw, line, lineNo) {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) throw unsupported(line, lineNo, 'expected a double-quoted string');
  let out = '';
  for (let i = 1; i < raw.length - 1; i += 1) {
    const ch = raw[i];
    if (ch === '\\') {
      const next = raw[i + 1];
      i += 1;
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === '"') out += '"';
      else if (next === '\\') out += '\\';
      else throw unsupported(line, lineNo, `unsupported escape \\${next}`);
    } else if (ch === '"') {
      throw unsupported(line, lineNo, 'unexpected quote inside string');
    } else {
      out += ch;
    }
  }
  return out;
}

// TOML literal strings ('...') carry no escapes, which keeps regular expressions readable.
function parseLiteral(raw, line, lineNo) {
  if (raw.length < 2 || !raw.endsWith("'")) throw unsupported(line, lineNo, 'expected a single-quoted literal string');
  const inner = raw.slice(1, -1);
  if (inner.includes("'")) throw unsupported(line, lineNo, 'unexpected quote inside literal string');
  return inner;
}

function splitArray(inner, line, lineNo) {
  const items = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === '\\') { cur += inner[i + 1] ?? ''; i += 1; } else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch; cur += ch;
    } else if (ch === ',') {
      if (cur.trim()) items.push(cur.trim());
      cur = '';
    } else if (ch === '[' || ch === '{') {
      throw unsupported(line, lineNo, 'nested arrays and inline tables are not supported');
    } else {
      cur += ch;
    }
  }
  if (quote) throw unsupported(line, lineNo, 'unterminated string in array');
  if (cur.trim()) items.push(cur.trim());
  return items;
}

function parseValue(raw, line, lineNo) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('"')) return parseString(raw, line, lineNo);
  if (raw.startsWith("'")) return parseLiteral(raw, line, lineNo);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return splitArray(raw.slice(1, -1), line, lineNo).map((item) => {
      if (item.startsWith('"')) return parseString(item, line, lineNo);
      if (item.startsWith("'")) return parseLiteral(item, line, lineNo);
      throw unsupported(line, lineNo, 'only arrays of strings are supported');
    });
  }
  throw unsupported(line, lineNo, 'unsupported value');
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

export function parseToml(text) {
  const root = {};
  let table = root;
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = stripComment(rawLine).trim();
    if (!line) return;
    if (line.startsWith('[[')) {
      if (!line.endsWith(']]')) throw unsupported(rawLine, lineNo, 'malformed array table header');
      const name = line.slice(2, -2).trim();
      if (!KEY_RE.test(name)) throw unsupported(rawLine, lineNo, 'array tables must have a simple top-level name');
      if (root[name] === undefined) root[name] = [];
      if (!Array.isArray(root[name]) || root[name].some((x) => !isTable(x))) throw unsupported(rawLine, lineNo, 'array table name collides with a value');
      table = {};
      root[name].push(table);
      return;
    }
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw unsupported(rawLine, lineNo, 'malformed table header');
      const parts = line.slice(1, -1).split('.').map((p) => p.trim());
      if (parts.some((p) => !KEY_RE.test(p))) throw unsupported(rawLine, lineNo, 'unsupported table name');
      table = root;
      for (const part of parts) {
        if (table[part] === undefined) table[part] = {};
        if (typeof table[part] !== 'object' || Array.isArray(table[part])) throw unsupported(rawLine, lineNo, 'table name collides with a value');
        table = table[part];
      }
      return;
    }
    const eq = line.indexOf('=');
    if (eq < 0) throw unsupported(rawLine, lineNo, 'expected key = value');
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!KEY_RE.test(key)) throw unsupported(rawLine, lineNo, 'unsupported key');
    table[key] = parseValue(value, rawLine, lineNo);
  });
  return root;
}

function quote(str) {
  return `"${String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

function formatValue(value) {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'string') return quote(value);
  if (Array.isArray(value)) return `[${value.map((v) => quote(v)).join(', ')}]`;
  throw new TrackerError('toml-unsupported', `cannot serialize value of type ${typeof value}`);
}

function isTable(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isTableArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isTable);

function emitTable(obj, prefix, out) {
  const scalars = Object.entries(obj).filter(([, v]) => !isTable(v) && !isTableArray(v) && v !== undefined && v !== null);
  const tables = Object.entries(obj).filter(([, v]) => isTable(v));
  const arrays = Object.entries(obj).filter(([, v]) => isTableArray(v));
  if (prefix.length) out.push(`[${prefix.join('.')}]`);
  for (const [k, v] of scalars) out.push(`${k} = ${formatValue(v)}`);
  if (prefix.length || scalars.length) out.push('');
  for (const [k, v] of tables) emitTable(v, [...prefix, k], out);
  for (const [k, items] of arrays) {
    if (prefix.length) throw new TrackerError('toml-unsupported', 'array tables are only supported at the top level');
    for (const item of items) {
      out.push(`[[${k}]]`);
      for (const [ik, iv] of Object.entries(item)) {
        if (iv === undefined || iv === null) continue;
        if (isTable(iv) || isTableArray(iv)) throw new TrackerError('toml-unsupported', 'nested tables inside array tables are not supported');
        out.push(`${ik} = ${formatValue(iv)}`);
      }
      out.push('');
    }
  }
}

export function stringifyToml(obj, { preserve } = {}) {
  const out = [];
  if (preserve) {
    const leading = [];
    for (const line of preserve.split(/\r?\n/)) {
      if (line.trim().startsWith('#')) leading.push(line);
      else if (line.trim() === '' && leading.length) leading.push(line);
      else break;
    }
    while (leading.length && leading[leading.length - 1].trim() === '') leading.pop();
    if (leading.length) { out.push(...leading); out.push(''); }
  }
  emitTable(obj, [], out);
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}
