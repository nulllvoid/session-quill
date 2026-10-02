#!/usr/bin/env node
// Stand-in for `claude -p` executing a Session Quill artifact plan (ADR 0010). It reads plan.json in
// its working directory and applies it to a JSON file that simulates a claude.ai artifact and its db:
//   FAKE_ARTIFACT_STORE — path of the simulated artifact { url, page, capabilities, publishes, docs }
//   FAKE_ARTIFACT_FAIL  — an op name to fail ("publish", "read", "batch")
import fs from 'node:fs';
import path from 'node:path';

const storePath = process.env.FAKE_ARTIFACT_STORE;
const fail = process.env.FAKE_ARTIFACT_FAIL ?? '';
const plan = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'plan.json'), 'utf8'));
const store = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, 'utf8')) : { url: null, page: null, capabilities: null, publishes: 0, docs: {} };
let url = plan.url ?? store.url;
const steps = [];
for (const step of plan.steps) {
  if (step.op === fail) { steps.push({ op: step.op, ok: false, error: `the ${step.op === 'publish' ? 'Artifact' : 'ArtifactData'} tool is not available in this session` }); break; }
  if (step.op === 'publish') {
    if (url && url !== store.url) { steps.push({ op: 'publish', ok: false, error: 'not the artifact in the store' }); break; }
    url = url ?? `https://claude.ai/artifact/fake-${Date.now().toString(36)}`;
    Object.assign(store, { url, page: fs.readFileSync(path.join(process.cwd(), step.file), 'utf8'), capabilities: step.capabilities, publishes: store.publishes + 1 });
    steps.push({ op: 'publish', ok: true, url });
  } else if (step.op === 'read') {
    const documents = [];
    for (const [key, doc] of Object.entries(store.docs)) {
      const [collection, id] = key.split('/');
      if (collection !== step.collection) continue;
      const file = path.join(process.cwd(), step.out_dir, collection, `${id}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(doc.data));
      documents.push({ doc_id: id, version: doc.version });
    }
    steps.push({ op: 'read', collection: step.collection, ok: true, documents });
  } else if (step.op === 'comments') {
    steps.push({ op: 'comments', ok: true, threads: store.threads ?? [] });
  } else if (step.op === 'batch') {
    const writes = Array.isArray(step.writes) ? step.writes.map((w) => ({ ...w, data: JSON.parse(fs.readFileSync(path.join(process.cwd(), w.file), 'utf8')) })) : JSON.parse(fs.readFileSync(path.join(process.cwd(), step.file), 'utf8'));
    const stale = writes.find((w) => store.docs[`${w.collection}/${w.doc_id}`] && store.docs[`${w.collection}/${w.doc_id}`].version !== w.if_version);
    if (stale) { steps.push({ op: 'batch', ok: false, error: `document ${stale.doc_id} changed (now version ${store.docs[`${stale.collection}/${stale.doc_id}`].version})` }); break; }
    for (const w of writes) {
      const key = `${w.collection}/${w.doc_id}`;
      const prev = store.docs[key];
      const merge = (a, b) => { const out = { ...a }; for (const [k, v] of Object.entries(b)) { if (v && v.__delete__ === true) { delete out[k]; continue; } out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' ? merge(a[k], v) : v; } return out; };
      const data = w.op === 'set' ? w.data : merge(prev ? prev.data : {}, w.data);
      store.docs[key] = { version: (prev ? prev.version : 0) + 1, data };
    }
    steps.push({ op: 'batch', ok: true, written: writes.length });
  }
}
store.url = url;
fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
const result = { url, steps };
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: `Done.\n\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n` }));
