// Validates site/dist: every page's local references resolve from its own folder, anchors exist,
// no root-relative paths (project Pages lives at a subpath), no em or en dashes in copy, and the
// theme and reduced-motion fallbacks are present.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const pages = fs.readdirSync(root, { recursive: true }).map((f) => String(f).split(path.sep).join('/')).filter((f) => f.endsWith('.html'));
assert.ok(pages.includes('index.html') && pages.some((p) => p.startsWith('docs/')), 'landing page and docs pages built');

const anchorsOf = new Map();
for (const page of pages) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, new Set(ids).size, `${page}: duplicate page IDs`);
  anchorsOf.set(page, new Set(ids));
}
for (const page of pages) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  const dir = path.dirname(page);
  assert.ok(!/[—–]/.test(html), `${page}: copy contains an em/en dash`);
  assert.ok(!/\p{Extended_Pictographic}/u.test(html), `${page}: copy contains an emoji`);
  assert.ok(!/\{\{(title|description|base|head|bodyClass|docsCurrent|content|scripts)\}\}/.test(html), `${page}: unfilled template placeholder`);
  assert.match(html, /<title>[^<]+<\/title>/, `${page}: missing title`);
  for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^https?:/.test(reference) || reference === '#') continue;
    assert.ok(!reference.startsWith('/'), `${page}: root-relative path breaks project Pages: ${reference}`);
    const [file, hash] = reference.split('#');
    const target = file === '' ? page : path.normalize(path.join(dir, file.endsWith('/') || file === '' ? `${file}index.html` : file));
    const resolved = path.join(root, target);
    assert.ok(resolved.startsWith(root), `${page}: reference escapes dist: ${reference}`);
    if (file !== '') assert.ok(fs.existsSync(resolved), `${page}: missing asset ${reference}`);
    if (hash !== undefined && target.endsWith('.html')) assert.ok(anchorsOf.get(target.split(path.sep).join('/'))?.has(hash), `${page}: missing anchor ${reference}`);
  }
}
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
for (const [, reference] of css.matchAll(/url\('([^']+)'\)/g)) assert.ok(fs.existsSync(path.join(root, reference)), `Missing CSS asset ${reference}`);
assert.ok(css.includes('prefers-reduced-motion'), 'Reduced-motion fallback missing');
assert.ok(css.includes('[data-theme=light]') && css.includes('[data-theme=dark]'), 'Light and dark themes missing');
assert.ok(css.includes('prefers-color-scheme:dark'), 'OS colour scheme fallback missing');
assert.ok(fs.existsSync(path.join(root, '.nojekyll')));
console.log(`Checked ${pages.length} pages: asset references, anchors, subpath compatibility, copy rules and accessibility fallbacks verified.`);
