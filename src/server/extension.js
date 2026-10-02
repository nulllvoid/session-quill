// Worker extension: hosts the loopback API, applies due requests each tick, accepts bootstrap
// secret hashes dropped by `tracker ui`, and recovers `applying` requests after a restart.
import path from 'node:path';
import { createAuth } from './auth.js';
import { createServer, listen } from './http.js';
import { applyDueRequests, recoverApplying } from './requests.js';
import { stateDir } from '../lib/paths.js';
import { listFiles, readJsonIfExists, removeIfExists, writeJsonAtomic } from '../lib/atomic-fs.js';

export function endpointPath(env) {
  return path.join(stateDir(env), 'ui-endpoint.json');
}

export function secretsDir(env) {
  return path.join(stateDir(env), 'control', 'ui-secrets');
}

export function createExtension(ctx, { port, exportHandler = null } = {}) {
  let auth = null;
  let server = null;
  let address = null;
  const configuredPort = port ?? ctx.config.ui_port ?? 0;

  function acceptPendingSecrets(worker) {
    const dir = secretsDir(ctx.env);
    for (const name of listFiles(dir, (f) => f.endsWith('.json'))) {
      const file = path.join(dir, name);
      const rec = readJsonIfExists(file);
      if (rec && rec.hash && rec.expires_at) auth.acceptSecretHash(rec.hash, Date.parse(rec.expires_at));
      removeIfExists(file);
    }
  }

  return {
    name: 'server',
    address: () => address,
    acceptSecretHash: (hash, expiresAtMs) => auth && auth.acceptSecretHash(hash, expiresAtMs),
    async onStart(worker) {
      auth = createAuth({ clock: worker.clock });
      recoverApplying(worker);
      const exporter = exportHandler ?? await loadExportHandler();
      server = createServer(worker, { auth, exportHandler: exporter });
      address = await listen(server, { port: configuredPort });
      writeJsonAtomic(endpointPath(ctx.env), { host: '127.0.0.1', port: address.port, pid: process.pid, started_at: worker.now() });
    },
    tick(worker) {
      if (!auth) return;
      acceptPendingSecrets(worker);
      applyDueRequests(worker, worker.now());
    },
    async onStop() {
      if (server) await new Promise((resolve) => server.close(() => resolve()));
      server = null;
      removeIfExists(endpointPath(ctx.env));
    },
  };
}

async function loadExportHandler() {
  try {
    const mod = await import('../export/handler.js');
    return mod.exportHandler ?? null;
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}
