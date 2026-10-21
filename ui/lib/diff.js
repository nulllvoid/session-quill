// The run detail's grouped diff (ADR 0040). Pure: it parses the patch a fix run left (the text of its
// `patch_ref` blob, `git diff --cached --binary`) into files and hunks, and groups the files by a
// fixed path table. Every string it returns is repository or agent text: the caller escapes it.
// Binary files are listed without their content.

export const DIFF_GROUPS = ['Core logic', 'Schema and state', 'CLI, routes and UI', 'Tests'];
// The Run dialog's note field takes at most this many characters (src/handoff/permissions.js NOTE_MAX).
export const NOTE_MAX = 280;
const SECTION_MAX = 200;
const LINE_MAX = 2000;

const HUNK_RE = /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@ ?(.*)$/;
// Control, bidi and zero-width characters: never part of a one-line note.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

// A C-quoted git path ("a/sp ace\"q.js", octal escapes for UTF-8 bytes) without its quotes.
function unquote(s) {
  if (!s.startsWith('"')) return s;
  const bytes = [];
  const enc = new TextEncoder();
  for (let i = 1; i < s.length; i += 1) {
    const c = s[i];
    if (c === '"') break;
    if (c !== '\\') { bytes.push(...enc.encode(c)); continue; }
    const n = s[i + 1];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(s.slice(i + 1, i + 4), 8) & 0xff); i += 3; continue; }
    bytes.push(...enc.encode({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', a: '\x07', v: '\v' }[n] ?? n));
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// The two paths of a `diff --git` line, used only until a ---/+++, rename or Binary line names them.
function gitLinePaths(rest) {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+(.+)$/.exec(rest);
    if (m) return [unquote(m[1]).replace(/^a\//, ''), unquote(m[2]).replace(/^b\//, '')];
  }
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && half > 0) {
    const p = rest.slice(2, 2 + half);
    if (rest === `a/${p} b/${p}`) return [p, p];
  }
  const at = rest.lastIndexOf(' b/');
  return at > 0 ? [rest.slice(0, at).replace(/^a\//, ''), rest.slice(at + 3)] : [rest, rest];
}

const sidePath = (s, prefix) => { const p = unquote(s.trim()); return p === '/dev/null' ? null : p.startsWith(prefix) ? p.slice(2) : p; };
const capText = (s, max) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** The patch as files: { path, oldPath, status (added|deleted|renamed|modified), binary, additions, deletions, hunks: [{ header, oldStart, oldLines, newStart, newLines, section, lines: [{ kind: add|del|context|meta, text }] }] }. */
export function parseDiff(text) {
  if (typeof text !== 'string' || !text) return [];
  const files = [];
  let file = null;
  let hunk = null;
  let remOld = 0;
  let remNew = 0;
  let binary = false;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      const [a, b] = gitLinePaths(line.slice(11));
      file = { path: b, oldPath: a, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      binary = false;
      continue;
    }
    if (!file || binary) continue;
    if (hunk && (remOld > 0 || remNew > 0) && /^[+\- ]/.test(line)) {
      const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'context';
      if (kind !== 'add') remOld -= 1;
      if (kind !== 'del') remNew -= 1;
      if (kind === 'add') file.additions += 1;
      if (kind === 'del') file.deletions += 1;
      hunk.lines.push({ kind, text: capText(line.slice(1), LINE_MAX) });
      continue;
    }
    if (hunk && line.startsWith('\\')) { hunk.lines.push({ kind: 'meta', text: capText(line, LINE_MAX) }); continue; }
    const m = HUNK_RE.exec(line);
    if (m) {
      const n = (v) => (v === undefined ? 1 : Number(v));
      hunk = { header: `@@ -${m[1]}${m[2] !== undefined ? `,${m[2]}` : ''} +${m[3]}${m[4] !== undefined ? `,${m[4]}` : ''} @@`, oldStart: Number(m[1]), oldLines: n(m[2]), newStart: Number(m[3]), newLines: n(m[4]), section: capText(m[5].trim(), SECTION_MAX), lines: [] };
      remOld = hunk.oldLines;
      remNew = hunk.newLines;
      file.hunks.push(hunk);
      continue;
    }
    hunk = null;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) { file.oldPath = unquote(line.slice(12)); file.status = 'renamed'; }
    else if (line.startsWith('rename to ')) { file.path = unquote(line.slice(10)); file.status = 'renamed'; }
    else if (line.startsWith('--- ')) { const p = sidePath(line.slice(4), 'a/'); if (p === null) file.status = 'added'; else file.oldPath = p; }
    else if (line.startsWith('+++ ')) { const p = sidePath(line.slice(4), 'b/'); if (p === null) { file.status = 'deleted'; file.path = file.oldPath; } else file.path = p; }
    else if (line === 'GIT binary patch' || /^Binary files .* differ$/.test(line)) { file.binary = true; binary = line === 'GIT binary patch'; }
  }
  return files;
}

const TEST_DIR = /^(?:__tests__|tests?|specs?)$/i;
const TEST_FILE = /(?:^|[._-])(?:test|spec)s?\.[a-z0-9]+$|^test_/i;
const SCHEMA = /^(?:reduc(?:e|er|ers)|states?|migrat\w*|schemas?|events?)$/;
const SURFACE = /^(?:cli|servers?|ui|routes?)$/;

/** Which group of DIFF_GROUPS a path belongs to: by whole path segment (or a part of one between . _ -), tests first. */
export function diffGroup(filePath) {
  const segments = String(filePath ?? '').toLowerCase().split('/').filter(Boolean);
  const name = segments[segments.length - 1] ?? '';
  if (segments.slice(0, -1).some((s) => TEST_DIR.test(s)) || TEST_FILE.test(name)) return 'Tests';
  const words = segments.flatMap((s) => s.split(/[._-]+/)).filter(Boolean);
  if (words.some((w) => SCHEMA.test(w))) return 'Schema and state';
  if (words.some((w) => SURFACE.test(w))) return 'CLI, routes and UI';
  return 'Core logic';
}

/** [{ name, files }] in DIFF_GROUPS order, groups without files left out, files in patch order. */
export function groupFiles(files) {
  const by = new Map(DIFF_GROUPS.map((g) => [g, []]));
  for (const f of files ?? []) by.get(diffGroup(f.path)).push(f);
  return DIFF_GROUPS.filter((g) => by.get(g).length).map((name) => ({ name, files: by.get(name) }));
}

const oneLine = (s) => String(s ?? '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
// The middle of a long path gives way first, so its file name stays readable.
function fitPath(p, room) {
  if (p.length <= room) return p;
  if (room < 8) return p.slice(-Math.max(1, room));
  const tail = Math.ceil((room - 1) * 0.6);
  return `${p.slice(0, room - 1 - tail)}…${p.slice(-tail)}`;
}

/**
 * The note a per-hunk "Retry as new run" pre-fills: the file and the hunk's line range, at most
 * NOTE_MAX characters. The hunk's section text (the function line git shows after @@) is source
 * the run wrote, so it is never carried into the next run's note.
 */
export function hunkRetryNote(file, hunk) {
  const header = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@$/.test(hunk && hunk.header) ? hunk.header : '';
  const before = 'Rework the change to ';
  const after = `${header ? ` at ${header}` : ''} from the earlier run; keep the rest of the change as it was.`;
  const p = fitPath(oneLine(file && file.path) || 'the file', NOTE_MAX - before.length - after.length);
  return `${before}${p}${after}`.slice(0, NOTE_MAX);
}
