// Ticket-key recognition and tracker links for zero-command tracking (ADR 0005). Pure functions:
// hooks run them on every prompt, so the pattern is validated once at config load and every scan
// is bounded.
import { deterministicId } from '../lib/ids.js';
import { TrackerError } from '../lib/errors.js';

export const TRACKER_SYSTEMS = ['jira', 'linear', 'github', 'custom'];
// commit and pr are reserved for a later release; v1 acts on prompt and branch only.
export const KEY_SOURCES = ['prompt', 'branch', 'commit', 'pr'];
export const ON_NEW_KEY = ['switch', 'add', 'ignore'];
export const DEFAULT_KEY_PATTERN = '\\b([A-Z][A-Z0-9]+-\\d+)\\b';
export const MAX_SCAN_CHARS = 4000;
export const MAX_KEYS = 10;
// Keys never contain whitespace, so patterns run per whitespace-separated token; tokens longer
// than this are skipped, which bounds even polynomial backtracking on long uppercase runs.
export const MAX_TOKEN_CHARS = 100;
// Without a prefix allowlist these uppercase-dash-number tokens are never treated as ticket keys.
export const NON_TICKET_PREFIXES = new Set([
  'UTF', 'SHA', 'ISO', 'RFC', 'GPT', 'HTTP', 'TLS', 'SSL', 'AES', 'RSA', 'MD', 'PEP', 'ES', 'ECMA', 'IPV', 'WIN', 'COVID', 'CVE', 'CWE', 'ARM', 'UTC', 'GMT', 'CP', 'AV', 'PR', 'TS', 'IE',
  'X86', 'BASE', 'LATIN', 'LLAMA', 'IEEE', 'MPEG', 'ERC', 'BIP', 'EIP', 'USB', 'DDR', 'WPA', 'PCIE', 'LTE', 'GPL', 'LGPL', 'AGPL', 'CC', 'OAUTH', 'TCP', 'UDP', 'SMB', 'HDMI', 'BT',
]);
const DEFAULT_TEMPLATES = { jira: '{domain}/browse/{key}', linear: '{domain}/issue/{key}', github: '{domain}/{repo}/issues/{number}', custom: '' };
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const PREFIX_RE = /^[A-Z][A-Z0-9_]*$/;
const DOMAIN_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~/-]*)?$/;
const REPEAT_RE = /^(?:[+*]|\{\d*,?\d*\})/;

// Catastrophic backtracking needs a repeated group whose body can match in more than one way. This
// rejects every repeated group that contains a quantifier, an alternation or another group, at any
// nesting depth: (a+)+, ((a+))+, (a|aa)+, (?:x*){2,}. Character classes and escapes are skipped.
export function repeatsComplexGroup(pattern) {
  const stack = [];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[') {
      i += 1;
      if (pattern[i] === '^') i += 1;
      if (pattern[i] === ']') i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '(') {
      if (top()) top().complex = true;
      stack.push({ complex: false });
      i += 1;
      if (pattern[i] === '?') {
        const next = pattern[i + 1];
        if (next === '<' && pattern[i + 2] !== '=' && pattern[i + 2] !== '!') {
          while (i < pattern.length && pattern[i] !== '>') i += 1;
          i += 1;
        } else {
          i += next === '<' ? 3 : 2;
        }
      }
      continue;
    }
    if (ch === ')') {
      const group = stack.pop();
      i += 1;
      if (group && group.complex && REPEAT_RE.test(pattern.slice(i))) return true;
      continue;
    }
    if ((ch === '|' || ch === '+' || ch === '*' || (ch === '{' && REPEAT_RE.test(pattern.slice(i)))) && top()) top().complex = true;
    i += 1;
  }
  return false;
}

function invalid(message) {
  return new TrackerError('config-invalid', message);
}

function stringList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw invalid(`tracker.${field} must be an array of strings`);
  return value;
}

export function normalizeTracker(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('[tracker] must be a table');
  const system = raw.system ?? 'custom';
  if (!TRACKER_SYSTEMS.includes(system)) throw invalid(`tracker.system must be one of ${TRACKER_SYSTEMS.join(', ')}`);
  const key_pattern = raw.key_pattern ?? DEFAULT_KEY_PATTERN;
  if (typeof key_pattern !== 'string' || !key_pattern || key_pattern.length > 200) throw invalid('tracker.key_pattern must be a non-empty regular expression of at most 200 characters');
  if (repeatsComplexGroup(key_pattern)) throw invalid('tracker.key_pattern must not repeat a group that contains a quantifier, alternation or another group (catastrophic backtracking risk)');
  try {
    new RegExp(key_pattern, 'g');
  } catch (err) {
    throw invalid(`tracker.key_pattern does not compile: ${err.message}`);
  }
  const prefixes = stringList(raw.prefixes, 'prefixes').map((p) => p.trim().toUpperCase());
  if (prefixes.some((p) => !PREFIX_RE.test(p))) throw invalid('tracker.prefixes must contain key prefixes such as PROJ');
  const sources = raw.sources === undefined ? ['prompt', 'branch'] : stringList(raw.sources, 'sources');
  if (sources.some((s) => !KEY_SOURCES.includes(s))) throw invalid(`tracker.sources may contain ${KEY_SOURCES.join(', ')}`);
  const on_new_key = raw.on_new_key ?? 'switch';
  if (!ON_NEW_KEY.includes(on_new_key)) throw invalid(`tracker.on_new_key must be one of ${ON_NEW_KEY.join(', ')}`);
  if (raw.domain !== undefined && typeof raw.domain !== 'string') throw invalid('tracker.domain must be a string');
  const domain = typeof raw.domain === 'string' ? raw.domain.trim().replace(/\/+$/, '') : '';
  if (domain && !DOMAIN_RE.test(domain)) throw invalid('tracker.domain must be an https:// origin such as https://example.atlassian.net');
  const url_template = raw.url_template ?? DEFAULT_TEMPLATES[system];
  if (typeof url_template !== 'string' || url_template.length > 300) throw invalid('tracker.url_template must be a string of at most 300 characters');
  const repo = raw.repo ?? '';
  if (typeof repo !== 'string' || !/^[A-Za-z0-9._/-]*$/.test(repo)) throw invalid('tracker.repo must look like owner/name');
  return { system, domain, url_template, key_pattern, prefixes, sources, on_new_key, repo };
}

export function keyPrefix(key) {
  const i = key.lastIndexOf('-');
  return (i > 0 ? key.slice(0, i) : key).toUpperCase();
}

function acceptKey(key, tracker) {
  if (!KEY_RE.test(key) || key.includes('..')) return false;
  const prefix = keyPrefix(key);
  return tracker.prefixes.length ? tracker.prefixes.includes(prefix) : !NON_TICKET_PREFIXES.has(prefix);
}

export function findKeys(text, tracker, { uppercase = false } = {}) {
  if (!tracker || typeof text !== 'string' || !text) return [];
  const head = text.slice(0, MAX_SCAN_CHARS);
  const scan = uppercase ? head.toUpperCase() : head;
  const re = new RegExp(tracker.key_pattern, 'g');
  const keys = [];
  for (const token of scan.split(/\s+/)) {
    if (!token || token.length > MAX_TOKEN_CHARS) continue;
    re.lastIndex = 0;
    for (let m = re.exec(token); m !== null; m = re.exec(token)) {
      if (m[0] === '') { re.lastIndex += 1; continue; }
      let key = String(m[1] ?? m[0]).trim();
      if (tracker.prefixes.length) key = key.toUpperCase();
      if (acceptKey(key, tracker) && !keys.includes(key)) keys.push(key);
      if (keys.length >= MAX_KEYS) return keys;
    }
  }
  return keys;
}

export function branchTitle(branch, key) {
  if (typeof branch !== 'string' || typeof key !== 'string') return '';
  const i = branch.toUpperCase().indexOf(key.toUpperCase());
  const tail = i >= 0 ? branch.slice(i + key.length) : '';
  return tail.replace(/[-_/.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function isSafeExternalUrl(url) {
  return typeof url === 'string' && url.length <= 500 && /^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/.test(url) && !/[<>"'`\\]/.test(url);
}

export function renderUrl(key, tracker) {
  if (!tracker || !tracker.url_template || typeof key !== 'string') return null;
  const number = (/(\d+)$/.exec(key) ?? [])[1] ?? '';
  const values = { domain: tracker.domain, key, repo: tracker.repo, number };
  let missing = false;
  const url = tracker.url_template.replace(/\{(domain|key|repo|number)\}/g, (_, name) => {
    if (!values[name]) missing = true;
    return values[name];
  });
  return !missing && isSafeExternalUrl(url) ? url : null;
}

export function externalTicketId(storeId, key) {
  return deterministicId(`external-ticket:${storeId}:${key}`);
}

export function keyExample(tracker) {
  return `${tracker && tracker.prefixes.length ? tracker.prefixes[0] : 'PROJ'}-123`;
}
