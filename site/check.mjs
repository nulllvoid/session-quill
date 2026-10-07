import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
assert.equal(ids.length, new Set(ids).size, 'Duplicate page IDs');
for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^https?:/.test(reference) || reference === '#') continue;
  if (reference.startsWith('#')) assert.ok(ids.includes(reference.slice(1)), `Missing anchor ${reference}`);
  else { assert.ok(!reference.startsWith('/'), `Root-relative path breaks project Pages: ${reference}`); assert.ok(fs.existsSync(path.join(root, reference)), `Missing asset ${reference}`); }
}
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
for (const [, reference] of css.matchAll(/url\('([^']+)'\)/g)) assert.ok(fs.existsSync(path.join(root, reference)), `Missing CSS asset ${reference}`);
assert.ok(!/[—–]/.test(html), 'Marketing copy contains an em/en dash');
assert.ok(css.includes('prefers-reduced-motion'), 'Reduced-motion fallback missing');
assert.ok(css.includes('[data-theme=light]'), 'Light theme missing');
assert.ok(fs.existsSync(path.join(root, '.nojekyll')));
console.log('Static asset references, anchors, subpath compatibility, and accessibility fallbacks verified.');
