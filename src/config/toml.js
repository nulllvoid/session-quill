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

function splitArray(inner, line, lineNo) {
  const items = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inStr) {
      cur += ch;
      if (ch === '\\') { cur += inner[i + 1] ?? ''; i += 1; } else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true; cur += ch;
    } else if (ch === ',') {
      if (cur.trim()) items.push(cur.trim());
      cur = '';
    } else if (ch === '[' || ch === '{') {
      throw unsupported(line, lineNo, 'nested arrays and inline tables are not supported');
    } else {
      cur += ch;
    }
  }
  if (inStr) throw unsupported(line, lineNo, 'unterminated string in array');
  if (cur.trim()) items.push(cur.trim());
  return items;
}

function parseValue(raw, line, lineNo) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('"')) return parseString(raw, line, lineNo);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return splitArray(raw.slice(1, -1), line, lineNo).map((item) => {
      if (!item.startsWith('"')) throw unsupported(line, lineNo, 'only arrays of strings are supported');
      return parseString(item, line, lineNo);
    });
  }
  throw unsupported(line, lineNo, 'unsupported value');
}

function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
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
    if (line.startsWith('[[')) throw unsupported(rawLine, lineNo, 'array tables are not supported');
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

function emitTable(obj, prefix, out) {
  const scalars = Object.entries(obj).filter(([, v]) => !isTable(v) && v !== undefined && v !== null);
  const tables = Object.entries(obj).filter(([, v]) => isTable(v));
  if (prefix.length) out.push(`[${prefix.join('.')}]`);
  for (const [k, v] of scalars) out.push(`${k} = ${formatValue(v)}`);
  if (prefix.length || scalars.length) out.push('');
  for (const [k, v] of tables) emitTable(v, [...prefix, k], out);
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
