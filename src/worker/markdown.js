// Minimal YAML subset emitter/parser for generated frontmatter, plus text escaping helpers.
// The subset is exactly what the tracker writes; it is not a general YAML implementation.

const PLAIN_RE = /^[A-Za-z0-9_][A-Za-z0-9 _./+()@-]*$/;
const RESERVED = new Set(['null', 'true', 'false', 'yes', 'no', 'on', 'off', '~', '']);

function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  const s = String(value);
  if (PLAIN_RE.test(s) && !RESERVED.has(s.toLowerCase()) && !/^-?\d+(\.\d+)?$/.test(s) && s.trim() === s) return s;
  return JSON.stringify(s);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function emit(value, indent, out) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) { out[out.length - 1] += ' []'; return; }
    for (const item of value) {
      if (isObj(item)) {
        const keys = Object.keys(item);
        if (!keys.length) { out.push(`${pad}- {}`); continue; }
        let first = true;
        for (const k of keys) {
          const prefix = first ? `${pad}- ` : `${pad}  `;
          first = false;
          emitEntry(k, item[k], prefix, indent + 2, out);
        }
      } else if (Array.isArray(item)) {
        out.push(`${pad}-`);
        emit(item, indent + 2, out);
      } else {
        out.push(`${pad}- ${scalar(item)}`);
      }
    }
    return;
  }
  if (isObj(value)) {
    const keys = Object.keys(value);
    if (!keys.length) { out[out.length - 1] += ' {}'; return; }
    for (const k of keys) emitEntry(k, value[k], pad, indent, out);
  }
}

function emitEntry(key, value, prefix, indent, out) {
  if (Array.isArray(value) || isObj(value)) {
    out.push(`${prefix}${key}:`);
    emit(value, indent + 2, out);
  } else {
    out.push(`${prefix}${key}: ${scalar(value)}`);
  }
}

export function stringifyYaml(obj) {
  const out = [];
  emit(obj, 0, out);
  return out.join('\n') + '\n';
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if (s.startsWith('"')) return JSON.parse(s);
  return s;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function splitKey(text) {
  // key: rest  (key is plain, no quotes needed in our subset)
  const m = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(text);
  if (!m) return null;
  return { key: m[1], rest: m[2] ?? '' };
}

export function parseYaml(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  let pos = 0;

  function parseBlock(indent) {
    if (pos >= lines.length) return null;
    const line = lines[pos];
    if (indentOf(line) < indent) return null;
    if (line.trimStart().startsWith('- ') || line.trim() === '-') return parseSequence(indentOf(line));
    return parseMapping(indentOf(line));
  }

  function parseMapping(indent) {
    const obj = {};
    while (pos < lines.length) {
      const line = lines[pos];
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`yaml: unexpected indent at line: ${line}`);
      const kv = splitKey(line.trim());
      if (!kv) throw new Error(`yaml: expected key at line: ${line}`);
      pos += 1;
      if (kv.rest === '') {
        const next = lines[pos];
        if (next !== undefined && indentOf(next) > indent) obj[kv.key] = parseBlock(indentOf(next));
        else if (next !== undefined && indentOf(next) === indent && next.trimStart().startsWith('- ')) obj[kv.key] = parseSequence(indent);
        else obj[kv.key] = null;
      } else {
        obj[kv.key] = parseScalar(kv.rest);
      }
    }
    return obj;
  }

  function parseSequence(indent) {
    const arr = [];
    while (pos < lines.length) {
      const line = lines[pos];
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`yaml: unexpected indent in sequence: ${line}`);
      const trimmed = line.trim();
      if (!(trimmed.startsWith('- ') || trimmed === '-')) break;
      const rest = trimmed === '-' ? '' : trimmed.slice(2);
      pos += 1;
      if (rest === '') {
        const next = lines[pos];
        arr.push(next !== undefined && indentOf(next) > indent ? parseBlock(indentOf(next)) : null);
        continue;
      }
      if (rest === '{}') { arr.push({}); continue; }
      const kv = splitKey(rest);
      if (kv) {
        // mapping item: first key on the dash line, remaining keys indented by 2
        const item = {};
        if (kv.rest === '') {
          const next = lines[pos];
          item[kv.key] = next !== undefined && indentOf(next) > indent + 2 ? parseBlock(indentOf(next)) : null;
        } else {
          item[kv.key] = parseScalar(kv.rest);
        }
        while (pos < lines.length && indentOf(lines[pos]) === indent + 2 && !lines[pos].trimStart().startsWith('- ')) {
          const sub = splitKey(lines[pos].trim());
          if (!sub) break;
          pos += 1;
          if (sub.rest === '') {
            const next = lines[pos];
            item[sub.key] = next !== undefined && indentOf(next) > indent + 2 ? parseBlock(indentOf(next)) : null;
          } else {
            item[sub.key] = parseScalar(sub.rest);
          }
        }
        arr.push(item);
      } else {
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  }

  const result = parseBlock(0);
  return result ?? {};
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Markdown-safe inline text: escape HTML and neutralize executable URL schemes.
export function safeInline(text) {
  return escapeHtml(text).replace(/javascript:/gi, 'javascript&#58;').replace(/\r?\n/g, ' ');
}
