import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from '../../src/worker/worker.js';
import { createStoreMeta, writeStoreMeta } from '../../src/config/store.js';
import { defaultUserConfig } from '../../src/config/config.js';
import { createExtension as serverExt, endpointPath } from '../../src/server/extension.js';

const MACHINE = '22222222-2222-4222-8222-222222222222';

function home(uiPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-endpoint-'));
  const storePath = path.join(dir, 'Quill');
  fs.mkdirSync(storePath, { recursive: true });
  const meta = createStoreMeta({ store_name: 'Quill', owner_machine_id: MACHINE, timezone: 'UTC' });
  writeStoreMeta(storePath, meta);
  const config = { ...defaultUserConfig(), store_path: storePath, ui_port: uiPort };
  const env = { QUILL_HOME: dir };
  return { env, config, meta };
}

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function boot(h) {
  const w = new Worker({ config: h.config, storeMeta: h.meta, env: h.env });
  const sext = serverExt({ env: h.env, config: h.config, storeMeta: h.meta });
  w.use(sext);
  await w.start();
  return { w, sext };
}

test('the server takes the configured port when it is free and records it in ui-endpoint.json', async () => {
  const port = await freePort();
  const h = home(port);
  const { w, sext } = await boot(h);
  try {
    assert.equal(sext.address().port, port);
    const ep = JSON.parse(fs.readFileSync(endpointPath(h.env), 'utf8'));
    assert.equal(ep.port, port);
    assert.equal(ep.host, '127.0.0.1');
    assert.equal(ep.pid, process.pid);
  } finally { await w.stop(); }
});

test('a taken port falls back to a random one instead of failing the worker', async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  const h = home(taken);
  const { w, sext } = await boot(h);
  try {
    const port = sext.address().port;
    assert.notEqual(port, taken);
    assert.ok(port > 0);
    assert.equal(JSON.parse(fs.readFileSync(endpointPath(h.env), 'utf8')).port, port);
  } finally {
    await w.stop();
    await new Promise((r) => blocker.close(r));
  }
});
