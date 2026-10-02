import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadContext, latestSnapshot, workerStatus } from '../context.js';
import { hashSecret } from '../../server/auth.js';
import { endpointPath, secretsDir } from '../../server/extension.js';
import { readJsonIfExists, writeJsonAtomic, ensureDir } from '../../lib/atomic-fs.js';
import { writeStaticHtml } from '../../export/static.js';
import { nowIso, addMs, MINUTE } from '../../lib/time.js';
import { TrackerError } from '../../lib/errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function openInBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

// Issues a one-use bootstrap secret: only its hash reaches the worker; the raw secret lives in the
// URL the browser opens and is redirected away immediately (TRD §Local dashboard).
export async function issueOwnerUrl(ctx, { ttlMs = 10 * MINUTE } = {}) {
  const endpoint = readJsonIfExists(endpointPath(ctx.env));
  if (!endpoint || !workerStatus(ctx).healthy) throw new TrackerError('worker-unavailable', 'the worker is not serving the dashboard; start it with `quill worker start`');
  const secret = randomBytes(32).toString('hex');
  const nonce = randomBytes(8).toString('hex');
  ensureDir(secretsDir(ctx.env));
  writeJsonAtomic(path.join(secretsDir(ctx.env), `${nonce}.json`), { hash: hashSecret(secret), expires_at: addMs(nowIso(), ttlMs) });
  const started = Date.now();
  while (Date.now() - started < 5000 && fs.existsSync(path.join(secretsDir(ctx.env), `${nonce}.json`))) await sleep(100);
  if (fs.existsSync(path.join(secretsDir(ctx.env), `${nonce}.json`))) throw new TrackerError('worker-unavailable', 'the worker did not accept the bootstrap secret within 5 s');
  return { url: `http://${endpoint.host}:${endpoint.port}/auth?secret=${secret}`, base: `http://${endpoint.host}:${endpoint.port}/`, ttlMs };
}

export async function run({ flags, io, env }) {
  const ctx = loadContext(env);
  if (flags.static) {
    const out = flags.static === true ? path.join(process.cwd(), `session-quill-snapshot-${nowIso().replace(/[:]/g, '-')}.html`) : String(flags.static);
    const snapshot = latestSnapshot(ctx);
    if (!snapshot) throw new TrackerError('no-snapshot', 'no published generation yet; start the worker once to publish projections');
    const result = writeStaticHtml(snapshot, out, { exportedAt: nowIso(), fields: flags.fields, projects: flags.projects, includeLinks: flags['include-links'] === true, includeCheckpoints: flags['include-checkpoints'] === true });
    io.println(`wrote read-only snapshot ${result.path} (${result.ticket_count} tickets, ${result.bytes} bytes). It will not update and cannot be revoked once shared.`);
    if (flags.open) openInBrowser(result.path);
    return 0;
  }
  const { url, base, ttlMs } = await issueOwnerUrl(ctx);
  io.println(`Dashboard: ${base}`);
  io.println(`One-use owner link (valid ${Math.round(ttlMs / 60000)} min, loopback only):`);
  io.println(url);
  if (flags['no-open'] !== true) {
    const opened = openInBrowser(url);
    io.println(opened ? 'opened in your default browser' : 'could not launch a browser; paste the link manually');
  }
  return 0;
}
