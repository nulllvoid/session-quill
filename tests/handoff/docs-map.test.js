import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDocsMap, renderDocsMap } from '../../src/handoff/docs-map.js';

const put = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

test('docs map lists the entry docs with title and first headings and skips node_modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-docs-'));
  put(root, 'README.md', '# Demo project\n\nhello\n');
  put(root, 'CLAUDE.md', '# Rules\n## a\n');
  put(root, 'AGENTS.md', '# Agents\n');
  put(root, 'docs/a.md', '# A\n## x\ntext\n## y\n');
  put(root, 'docs/deep/b.md', 'no title here\n');
  put(root, 'docs/notes.txt', '# not markdown\n');
  put(root, 'runbooks/deploy.md', '# Deploy\n## Steps\n');
  put(root, 'RUNBOOK-db.md', '# DB runbook\n');
  put(root, 'node_modules/x.md', '# Vendored\n');
  put(root, 'docs/node_modules/y.md', '# Vendored too\n');
  const map = buildDocsMap(root);
  const byPath = Object.fromEntries(map.map((e) => [e.path, e]));
  assert.deepEqual(Object.keys(byPath).sort(), ['AGENTS.md', 'CLAUDE.md', 'README.md', 'RUNBOOK-db.md', 'docs/a.md', 'docs/deep/b.md', 'runbooks/deploy.md']);
  assert.equal(byPath['README.md'].title, 'Demo project');
  assert.deepEqual(byPath['docs/a.md'], { path: 'docs/a.md', title: 'A', headings: ['x', 'y'] });
  assert.equal(byPath['docs/deep/b.md'].title, '');
});

test('docs map keeps at most 8 headings per file and caps the entry count', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-docs-'));
  put(root, 'README.md', `# R\n${Array.from({ length: 12 }, (_, i) => `## h${i}`).join('\n')}\n`);
  for (let i = 0; i < 400; i += 1) put(root, `docs/f${String(i).padStart(3, '0')}.md`, `# F${i}\n`);
  const map = buildDocsMap(root, { maxEntries: 300 });
  assert.equal(map.length, 300);
  assert.equal(map[0].path, 'README.md', 'entry docs come first');
  assert.equal(map[0].headings.length, 8);
  assert.equal(buildDocsMap(root).length, 300, 'the default cap is 300');
});

test('renderDocsMap is plain text, one line per doc, and capped at 16 KB with a note', () => {
  const text = renderDocsMap([{ path: 'docs/a.md', title: 'A', headings: ['x', 'y'] }, { path: 'b.md', title: '', headings: [] }]);
  assert.match(text, /^- docs\/a\.md - A \(x; y\)$/m);
  assert.match(text, /^- b\.md$/m);
  const many = Array.from({ length: 300 }, (_, i) => ({ path: `docs/file-${i}.md`, title: 'T'.repeat(120), headings: ['h'.repeat(40), 'k'.repeat(40)] }));
  const big = renderDocsMap(many);
  assert.ok(Buffer.byteLength(big) <= 16 * 1024 + 100);
  assert.match(big, /\.\.\. \d+ more document/);
});

import { buildPrompt } from '../../src/handoff/runner.js';

test('the prompt carries the docs map and the checkout base label as data', () => {
  const ticket = { key: 'PROJ-1', title: 't', status: 'active', timeline: [], plans: [], conclusions: [] };
  const h = { id: 'h', mode: 'analyse', note: '', permissions: {} };
  const p = buildPrompt(h, ticket, { context: { docs: '- docs/a.md - A (x)', base_label: 'checkout based on branch feat/x' } });
  assert.match(p, /Checkout: checkout based on branch feat\/x\./);
  assert.match(p, /Repository docs[^\n]*\n- docs\/a\.md - A \(x\)/);
  const narrow = buildPrompt(h, ticket, { recipe: { name: 'n', legacy: false, inputs: ['ticket'], outputs: ['summary'], body: 'Go.' }, context: { docs: '- docs/a.md' } });
  assert.doesNotMatch(narrow, /Repository docs/, 'a recipe that does not declare docs does not get them');
});
