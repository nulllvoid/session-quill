// The small YAML subset recipe frontmatter uses (ADR 0008): `key: value` lines whose values are
// scalars, quoted strings, inline lists `[a, b]`, inline maps `{ k: v }` of scalars, or a block
// list of `- item` lines. Anything else is an error naming the line, never a guess.

function fail(line, message) {
  throw new Error(`recipe frontmatter line ${line}: ${message}`);
}

// Reads one scalar starting at s[i]; returns [value, nextIndex]. `stops` ends a bare scalar.
function readScalar(s, i, line, stops) {
  while (s[i] === ' ' || s[i] === '\t') i += 1;
  if (s[i] === '"') {
    let j = i + 1;
    let raw = '';
    for (; j < s.length && s[j] !== '"'; j += 1) {
      if (s[j] === '\\') { raw += s[j] + (s[j + 1] ?? ''); j += 1; } else raw += s[j];
    }
    if (j >= s.length) fail(line, 'unterminated double-quoted string');
    try { return [JSON.parse(`"${raw}"`), j + 1]; } catch { fail(line, 'invalid escape in a double-quoted string'); }
  }
  if (s[i] === "'") {
    let j = i + 1;
    let out = '';
    for (;;) {
      if (j >= s.length) fail(line, 'unterminated single-quoted string');
      if (s[j] === "'") {
        if (s[j + 1] === "'") { out += "'"; j += 2; continue; }
        return [out, j + 1];
      }
      out += s[j];
      j += 1;
    }
  }
  let j = i;
  while (j < s.length && !stops.includes(s[j]) && !(s[j] === '#' && (j === i || s[j - 1] === ' ' || s[j - 1] === '\t'))) j += 1;
  const text = s.slice(i, j).trim();
  if (text.startsWith('[') || text.startsWith('{')) fail(line, 'nested lists and maps are not supported');
  return [bare(text), j];
}

function bare(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~' || text === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function rest(s, i, line) {
  const tail = s.slice(i).trim();
  if (tail && !tail.startsWith('#')) fail(line, `unexpected text "${tail}"`);
}

function readValue(s, line) {
  let i = 0;
  while (s[i] === ' ') i += 1;
  if (s[i] === '[') {
    const out = [];
    i += 1;
    for (;;) {
      while (s[i] === ' ') i += 1;
      if (s[i] === ']') { rest(s, i + 1, line); return out; }
      if (i >= s.length) fail(line, 'unterminated list');
      const [v, j] = readScalar(s, i, line, ',]');
      out.push(v);
      i = j;
      while (s[i] === ' ') i += 1;
      if (s[i] === ',') i += 1;
      else if (s[i] !== ']') fail(line, 'expected , or ] in a list');
    }
  }
  if (s[i] === '{') {
    const out = {};
    i += 1;
    for (;;) {
      while (s[i] === ' ') i += 1;
      if (s[i] === '}') { rest(s, i + 1, line); return out; }
      const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(s.slice(i));
      if (!m) fail(line, 'expected key: value in a map');
      if (Object.hasOwn(out, m[1])) fail(line, `duplicate key "${m[1]}"`);
      const [v, j] = readScalar(s, i + m[0].length, line, ',}');
      out[m[1]] = v;
      i = j;
      while (s[i] === ' ') i += 1;
      if (s[i] === ',') i += 1;
      else if (s[i] !== '}') fail(line, 'expected , or } in a map');
    }
  }
  const [v, j] = readScalar(s, i, line, '');
  rest(s, j, line);
  return v;
}

export function parseFrontmatter(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('a recipe must start with --- frontmatter');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('recipe frontmatter has no closing ---');
  const data = {};
  let listKey = null;
  for (let n = 1; n < end; n += 1) {
    const raw = lines[n];
    const line = n + 1;
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item) {
      if (!listKey) fail(line, 'a list item must follow a key with no value');
      data[listKey].push(readValue(item[1], line));
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/.exec(raw);
    if (!m) fail(line, 'expected key: value');
    if (Object.hasOwn(data, m[1])) fail(line, `duplicate key "${m[1]}"`);
    const value = m[2].trim();
    if (value === '' || value.startsWith('#')) { data[m[1]] = []; listKey = m[1]; continue; }
    listKey = null;
    data[m[1]] = readValue(m[2], line);
  }
  return { data, body: lines.slice(end + 1).join('\n') };
}
