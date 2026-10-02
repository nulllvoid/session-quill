// Exclusive per-store ownership lock: a listening local socket / named pipe released by the OS on
// exit. A competing worker refuses to start; ownership is never stolen on a timer (TRD §Durability 2).
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runDir } from '../lib/paths.js';
import { ensureDir } from '../lib/atomic-fs.js';
import { TrackerError } from '../lib/errors.js';

export function lockEndpoint(storeId, machineId, env = process.env) {
  const digest = createHash('sha256').update(`${storeId}:${machineId}`).digest('hex').slice(0, 24);
  if (process.platform === 'win32') return `\\\\.\\pipe\\session-quill-${digest}`;
  return path.join(runDir(env), `${digest}.sock`);
}

function tryConnect(endpoint) {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    let settled = false;
    const done = (alive) => { if (settled) return; settled = true; socket.destroy(); resolve(alive); };
    socket.on('connect', () => done(true));
    // Errors can arrive before connect (nobody listening) or after (reset while we tear down).
    socket.on('error', () => done(false));
    setTimeout(() => done(false), 500).unref();
  });
}

export async function isLocked(storeId, machineId, env = process.env) {
  return tryConnect(lockEndpoint(storeId, machineId, env));
}

export async function acquireLock(storeId, machineId, env = process.env) {
  const endpoint = lockEndpoint(storeId, machineId, env);
  if (await tryConnect(endpoint)) {
    throw new TrackerError('lock-held', `another worker owns store ${storeId} (${endpoint})`);
  }
  if (process.platform !== 'win32') {
    ensureDir(runDir(env));
    try { fs.unlinkSync(endpoint); } catch { /* no stale socket */ }
  }
  const server = net.createServer((socket) => {
    // Owner probe: reply with a tiny banner and close. The prober destroys its end as soon as it
    // connects, so this write can race a reset (ECONNRESET on Windows named pipes); swallow it.
    socket.on('error', () => {});
    socket.end('session-quill-owner\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') reject(new TrackerError('lock-held', `another worker owns store ${storeId} (${endpoint})`));
      else reject(err);
    });
    server.listen(endpoint, () => resolve());
  });
  server.unref();
  return {
    endpoint,
    server,
    release: () => new Promise((resolve) => {
      server.close(() => {
        if (process.platform !== 'win32') { try { fs.unlinkSync(endpoint); } catch { /* ignore */ } }
        resolve();
      });
    }),
  };
}
