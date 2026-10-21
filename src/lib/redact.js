// Secret redaction shared by the journal's producers and the run ledger (ADR 0029): provider
// tokens, cloud keys, private keys, URL credentials, `secret=value` pairs, `.env` lines with a
// secret-looking name and long high-entropy strings. Secrets only: path redaction belongs to
// exports (src/export/sanitize.js) and is never applied here. Every quantifier is bounded or
// anchored on a literal, so the cost is linear in the input (a long run of word characters must
// not go quadratic). Loaded on the hook path, so it imports nothing.

export const REDACTED = '[secret redacted]';
const R = REDACTED;

// The generic secret-name rule (spec §4.4), shared with src/handoff/cred-env.js: any variable name
// that looks like it holds a secret.
export const SECRET_NAME = /(token|secret|password|passwd|api_?key|credential|auth)/i;

const PEM_BEGIN = /-----BEGIN ([A-Z ]{0,40})PRIVATE KEY-----/y;
const TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_\w{20,255}|glpat-[\w-]{20,255}|xox[abprs]-[\w-]{10,255}|xapp-[\w-]{10,255}|npm_[A-Za-z0-9]{30,255}|sk-[A-Za-z0-9_-]{20,255}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g;
// A credential after the scheme word (in any case); a plain lower-case or capitalised word ("a
// basic understanding", "Bearer tokens") is prose, not a credential.
const AUTH_SCHEME = /\b([Bb][Ee][Aa][Rr][Ee][Rr]|[Bb][Aa][Ss][Ii][Cc])\s+(?![A-Z]?[a-z]{1,1000}(?![A-Za-z0-9._~+/=-]))[A-Za-z0-9._~+/=-]{8,1000}/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:]{1,200}:[^\s/@]{1,200}@/gi;
// The key starts at the keyword (any prefix such as GH_ stays in place), may carry a short suffix
// and a closing quote (JSON), then `=` or `:`. Purely numeric values (max_tokens=4096) are kept, and
// so is a value already redacted, so a second pass changes nothing.
const SECRET_ASSIGN = /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[\w.-]{0,40}["']?\s{0,10}[=:]\s{0,10})(?!["']?\d+["']?(?:[\s,;})\]]|$))(?!["']?\[secret redacted\])("[^"\n]{0,1000}"|'[^'\n]{0,1000}'|[^\s,;})\]]{1,1000})/gi;
// A `.env` line (optionally `export`ed, the name in upper case as `.env` files write it, so code
// such as `auth = auth.trim()` is left alone) whose name matches SECRET_NAME loses the rest of its
// line.
const ENV_LINE = /^([ \t]{0,20}(?:export[ \t]{1,10})?([A-Z_][A-Z0-9_]{0,100})[ \t]{0,10}=[ \t]{0,10})([^\r\n]{1,1000})/gm;
const KEPT_ENV_VALUE = /^(?:["']?\d+["']?[ \t]*|["']?\[secret redacted\].*)$/;
// High-entropy candidates: runs of base64/base64url characters with optional padding. The
// lookbehind starts a match only where a run starts, so a short run is scanned once, not once per
// character.
const ENTROPY_RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}/g;
const HEX = /^[0-9a-fA-F]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function envLine(match, head, name, value) {
  return SECRET_NAME.test(name) && !KEPT_ENV_VALUE.test(value) ? `${head}${R}` : match;
}

// Shannon entropy in bits per character of an ASCII candidate.
function entropy(s) {
  const counts = new Uint32Array(128);
  for (let i = 0; i < s.length; i++) counts[s.charCodeAt(i)] += 1;
  let h = 0;
  for (const n of counts) if (n) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

const mixedClasses = (s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);

// Random base64 of 32 characters measures about 4.6 bits a character and rises with length; paths,
// identifiers and camelCase names stay near 4.1 at any length. The bar rises with length to keep
// them apart. Hex up to 64 characters (SHAs, sha256) and UUIDs are identifiers, not secrets. A
// candidate also needs a part between separators (- _ / +) with upper case, lower case and a digit:
// random text nearly always has one (about 0.6% of 32-character strings miss either test), while a
// slug such as a ticket key (`LOCAL-unknown-status-record-57c8291c`) or a path has none.
function highEntropy(m) {
  const core = m.replace(/=+$/, '');
  if (HEX.test(core)) return core.length > 64 ? R : m;
  if (UUID.test(core)) return m;
  if (!core.split(/[-_/+]/).some(mixedClasses)) return m;
  return entropy(core) >= Math.min(4.6, 4.1 + (core.length - 32) * 0.025) ? R : m;
}

// Secret redaction of free text. Deterministic and idempotent: the same input always gives the
// same output, and redacting redacted text changes nothing.
export function redactText(text) {
  return redactPem(String(text ?? ''))
    .replace(URL_USERINFO, `$1${R}@`)
    .replace(TOKENS, R)
    .replace(AUTH_SCHEME, `$1 ${R}`)
    .replace(ENV_LINE, envLine)
    .replace(SECRET_ASSIGN, `$1${R}`)
    .replace(ENTROPY_RUN, highEntropy);
}

// A secret-looking fragment left at the very end of a cut (its rest fell past the cut). Only the
// last 300 characters are examined, so this stays cheap on long text.
const TRAILING_SECRET = /(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|xapp-|npm_|sk-|AKIA|ASIA|-----BEGIN )\S*$/;
function dropTrailingSecret(text) {
  const tail = text.slice(-300);
  const m = TRAILING_SECRET.exec(tail);
  return m ? text.slice(0, text.length - tail.length + m.index) : text;
}

// Cut to at most `max` UTF-8 bytes without splitting a character.
export function capBytes(text, max) {
  if (Buffer.byteLength(text) <= max) return text;
  let s = Buffer.from(text).subarray(0, max).toString('utf8');
  while (Buffer.byteLength(s) > max || s.endsWith('�')) s = s.slice(0, -1);
  return s;
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

// Text is cut to this before it is redacted, so redaction cost never scales with a huge input.
const PRECAP_BYTES = 8192;

// Redact a bounded slice of `text` with `redact`, then cut it to `max` bytes; neither cut leaves
// part of a secret behind.
export function capRedacted(text, max, redact = redactText) {
  const red = redact(cutAtBoundary(String(text ?? ''), Math.max(max, PRECAP_BYTES)));
  return Buffer.byteLength(red) <= max ? red : dropTrailingSecret(capBytes(red, max));
}

export function redactCapped(text, max) {
  return capRedacted(text, max, redactText);
}

// Payload keys whose values are identities, not text: ids, ticket keys, hashes, SHAs, blob refs,
// paths, branch names and URLs. They are kept byte for byte so source identities, blob references,
// key lookups and dedupe still hold; producers put only identifiers under these names. A name that
// says it holds a credential (`api_key`, `access_key_id`, `token_hash`) is never one: it is redacted
// like text, so a secret cannot ride through under an identifier-shaped name.
// Filesystem paths (`path`, `dir`, `root`, `file_path`, `*_path`, `*_dir`) are identifiers too: macOS temp
// folders (`/var/folders/<random>/T/…`) look high-entropy, and a redacted path is no longer a path.
// Tool names (`tool_name`, `tool`) are the host's identifiers: the entropy rule would take a long MCP
// name such as `mcp__s3v2__putObjectV2InBucket4Region9` for a secret and break matching by name.
const IDENTIFIER_NAMES = new Set(['id', 'ids', 'key', 'sha', 'hash', 'ref', 'write_paths', 'paths', 'files', 'source_identity', 'cwd', 'branch', 'url', 'pr_url', 'tool_name', 'tool', 'path', 'dir', 'root', 'file_path']);
const IDENTIFIER_SUFFIX = /_(?:id|ids|key|sha|hash|ref|paths|path|dir)$/;
const CREDENTIAL_NAME = /(token|secret|password|passwd|api_?key|credential|access_?key|private_?key)/i;
export const IDENTIFIER_KEYS = Object.freeze([...IDENTIFIER_NAMES, '*_id', '*_ids', '*_key', '*_sha', '*_hash', '*_ref', '*_paths', '*_path', '*_dir']);

export function isIdentifierKey(key) {
  return (IDENTIFIER_NAMES.has(key) || IDENTIFIER_SUFFIX.test(key)) && !CREDENTIAL_NAME.test(key);
}

// URLs are identifiers, but the user-info part of one (`https://user:token@host`) is a credential, never
// part of what identifies it: that part alone is replaced.
const URL_KEYS = new Set(['url', 'pr_url']);
function stripUserinfo(v) {
  if (typeof v === 'string') return v.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]+@/i,'$1[secret redacted]@');
  return structuredClone(v);
}

function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = isIdentifierKey(k) ? (URL_KEYS.has(k) ? stripUserinfo(v) : structuredClone(v)) : redactValue(v);
    return out;
  }
  return value;
}

// A copy of `ev` whose payload's string leaves are redacted, except under identifier keys at any
// depth. The envelope (event_id, session_id, source_identity …) is never touched.
export function redactEvent(ev) {
  if (!ev || typeof ev !== 'object') return ev;
  const payload = ev.payload && typeof ev.payload === 'object' && !Array.isArray(ev.payload) ? redactValue(ev.payload) : ev.payload;
  return { ...ev, payload };
}
