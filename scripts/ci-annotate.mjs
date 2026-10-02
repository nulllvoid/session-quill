#!/usr/bin/env node
// Turns failed tests in a node:test TAP file into GitHub Actions error annotations, which are
// readable without signing in (job logs are not):  node scripts/ci-annotate.mjs test-results.tap
import fs from 'node:fs';

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// node:test's TAP reporter escapes backslashes and '#' in names and diagnostics.
const untap = (s) => String(s).replace(/\\([\\#])/g, '$1');

export function annotationsFromTap(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  // '#' diagnostics since the previous test line: a file that crashes while loading prints its
  // error here and reports only 'test failed' in its YAML block.
  let diagnostics = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(not )?ok \d+/.test(lines[i]) === false) {
      const d = /^\s*# ?(.*)$/.exec(lines[i]);
      if (d && !/^Subtest: /.test(d[1])) diagnostics.push(untap(d[1]));
      continue;
    }
    const before = diagnostics;
    diagnostics = [];
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    if (/(^|[^\\]) # (TODO|SKIP)\b/i.test(m[2])) continue;
    const indent = m[1].length;
    const yaml = [];
    if (lines[i + 1] && lines[i + 1].trim() === '---') {
      for (let j = i + 2; j < lines.length && lines[j].trim() !== '...'; j += 1) yaml.push(lines[j].slice(indent + 2));
    }
    const field = (name) => {
      const l = yaml.find((y) => y.startsWith(`${name}:`));
      return l ? l.slice(name.length + 1).trim().replace(/^'|'$/g, '') : null;
    };
    if (field('failureType') === 'subtestsFailed') continue;
    let message = '';
    const at = yaml.findIndex((y) => /^error:/.test(y));
    if (at >= 0) {
      const head = yaml[at].slice('error:'.length).trim();
      if (head && head !== '|-' && head !== '|') {
        message = head.replace(/^'|'$/g, '');
      } else {
        const body = [];
        for (const y of yaml.slice(at + 1)) {
          if (y !== '' && !/^\s{2}/.test(y)) break;
          body.push(y.replace(/^\s{2}/, ''));
        }
        message = body.join('\n').trim();
      }
    }
    if ((message === '' || message === 'test failed') && before.length) message = before.join('\n').trim();
    const location = untap(field('location') ?? '');
    out.push(`::error title=${escProp(untap(m[2]))}::${esc(`${message || 'test failed'}${location ? `\n    at ${location}` : ''}`)}`);
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('ci-annotate.mjs')) {
  const file = process.argv[2] ?? 'test-results.tap';
  if (fs.existsSync(file)) for (const line of annotationsFromTap(fs.readFileSync(file, 'utf8')).slice(0, 25)) console.log(line);
  else console.log(`::warning::no TAP file at ${file}`);
}
