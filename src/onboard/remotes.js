// Git remote addresses for onboarding (ADR 0024): one parser for the forms Quill accepts, a key to
// compare remotes written differently (https or ssh, with or without .git), and the checks a
// remote must pass before anything is cloned from it.
import { TrackerError } from '../lib/errors.js';

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
// git@host:owner/repo.git, the scp-like form git accepts for ssh.
const SCP_RE = /^([^@/:\s]+)@([^@/:\s]+):(.+)$/;
const MAX_URL = 300;

const refuse = (code, message) => new TrackerError(code, message);

function pathSegments(raw) {
  const segments = String(raw).replace(/\/+$/, '').split('/');
  if (segments[0] === '') segments.shift();
  const last = segments.length - 1;
  if (last >= 0) segments[last] = segments[last].replace(/\.git$/i, '');
  return segments;
}

// { protocol: 'https'|'ssh', host, user, port, segments, name } for an address of the accepted
// shapes, or { error: { code, message } } saying why it is not one. Nothing is fetched.
export function parseRemote(input) {
  const url = typeof input === 'string' ? input.trim() : '';
  const bad = (code, message) => ({ error: { code, message } });
  if (!url) return bad('clone-url-invalid', 'no remote address');
  if (url.length > MAX_URL) return bad('clone-url-invalid', `a remote address is at most ${MAX_URL} characters`);
  if (url.startsWith('-')) return bad('clone-url-invalid', 'a remote address cannot start with "-" (it would be read as an option)');
  if (/[\s\x00-\x1f\x7f"'`\\<>|;&$]/.test(url)) return bad('clone-url-invalid', 'a remote address cannot contain spaces, quotes or shell characters');
  if (/::/.test(url)) return bad('clone-transport-refused', 'transport::address remotes (such as ext::) are refused');
  if (/^file:/i.test(url)) return bad('clone-transport-refused', 'file: remotes are refused; clone over https or ssh');
  let protocol;
  let host;
  let user = null;
  let port = null;
  let rawPath;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== 'https' && name !== 'ssh') return bad('clone-transport-refused', `${name}:// remotes are refused; clone over https or ssh`);
    let u;
    try { u = new URL(url); } catch { return bad('clone-url-invalid', 'the remote address does not parse'); }
    if (u.password || (name === 'https' && u.username)) return bad('clone-credentials', 'the remote address carries credentials; remove them and let git use your credential helper or ssh key');
    if (u.search || u.hash) return bad('clone-url-invalid', 'a remote address has no query or fragment');
    protocol = name;
    host = u.hostname;
    user = u.username || null;
    port = u.port || null;
    rawPath = decodeURIComponent(u.pathname);
  } else {
    const m = SCP_RE.exec(url);
    if (!m) return bad('clone-url-invalid', 'use an https://host/owner/repo or git@host:owner/repo.git address');
    protocol = 'ssh';
    [, user, host, rawPath] = m;
    if (rawPath.startsWith('/')) return bad('clone-url-invalid', 'an ssh address names a path relative to the account, such as git@host:owner/repo.git');
  }
  host = String(host).toLowerCase();
  if (!HOST_RE.test(host)) return bad('clone-url-invalid', `${host || 'the host'} is not a host name`);
  if (user !== null && !USER_RE.test(user)) return bad('clone-credentials', 'the remote address names an unusual user; use git@host:owner/repo.git');
  const segments = pathSegments(rawPath);
  if (segments.length < 2 || segments.length > 6) return bad('clone-url-invalid', 'the remote must name an owner and a repository, such as owner/repo');
  if (segments.some((s) => !SEGMENT_RE.test(s) || s === '..')) return bad('clone-url-invalid', 'the repository path may contain letters, digits, dots, dashes and underscores, and no part may start with "-" or be ".."');
  return { protocol, host, user, port, segments, name: segments[segments.length - 1] };
}

// host/owner/repo in lower case: https://github.com/Acme/App.git and git@github.com:acme/app match.
// Accepts any address git reports for a local clone (http too); null when it is not a forge address.
export function remoteKey(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return null;
  const parsed = parseRemote(/^http:\/\//i.test(raw) ? `https://${raw.slice(7)}` : raw.replace(/^(https:\/\/)[^@/]*@/i, '$1'));
  if (parsed.error) return null;
  return `${parsed.host}/${parsed.segments.join('/')}`.toLowerCase();
}

export function normalizeHosts(hosts) {
  return [...new Set((hosts ?? []).map((h) => String(h).trim().toLowerCase()).filter((h) => HOST_RE.test(h)))];
}

// Throws unless `url` may be cloned: https or ssh, no credentials, a host on the allowlist.
export function checkCloneUrl(url, hosts) {
  const parsed = parseRemote(url);
  if (parsed.error) throw refuse(parsed.error.code, parsed.error.message);
  const allowed = normalizeHosts(hosts);
  if (!allowed.includes(parsed.host)) throw refuse('clone-host-refused', `${parsed.host} is not in [tracker] clone_hosts (${allowed.join(', ') || 'empty'}); add it there to clone from it`);
  return parsed;
}

// The repository a tracker link points into, as an https remote: a pull request, commit or file
// page on an allowed forge names its repository in the first path segments. GitLab separates the
// project path from the rest with "/-/". Returns null for anything else.
export function repoUrlFromLink(link, hosts) {
  let u;
  try { u = new URL(String(link)); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!normalizeHosts(hosts).includes(host)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const dash = parts.indexOf('-');
  const repoParts = dash > 0 ? parts.slice(0, dash) : parts.slice(0, 2);
  if (repoParts.length < 2 || repoParts.some((s) => !SEGMENT_RE.test(s))) return null;
  const last = repoParts.length - 1;
  repoParts[last] = repoParts[last].replace(/\.git$/i, '');
  return `https://${host}/${repoParts.join('/')}.git`;
}

// The folder name a clone of `parsed` gets: its repository name, made safe for every platform.
export function cloneFolderName(parsed) {
  return safeFolderName(parsed.name);
}

// Letters, digits, `.`, `_` and `-`, at most 64 characters, cleaned again after the cut so it never
// ends in `.`, `-` or a space, and never a Windows device name, with or without an extension.
export function safeFolderName(raw) {
  const clean = (s) => s.replace(/^[-. ]+|[-. ]+$/g, '');
  const name = clean(clean(String(raw ?? '').replace(/[^A-Za-z0-9._-]+/g, '-')).slice(0, 64));
  const reserved = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
  if (!name || reserved.test(name)) throw refuse('clone-url-invalid', 'the repository name cannot be used as a folder name');
  return name;
}

// The address to keep and show: rebuilt from its parts, so it carries no password, no user in an
// https address, and no trailing slash; ssh keeps its (non-secret) login name, which git needs.
export function normalizeRemote(input) {
  const p = parseRemote(input);
  if (p.error) return null;
  const repoPath = `${p.segments.join('/')}.git`;
  if (p.protocol === 'https') return `https://${p.host}${p.port ? `:${p.port}` : ''}/${repoPath}`;
  if (/^ssh:\/\//i.test(String(input).trim())) return `ssh://${p.user ? `${p.user}@` : ''}${p.host}${p.port ? `:${p.port}` : ''}/${repoPath}`;
  return `${p.user}@${p.host}:${repoPath}`;
}
