// Static site generator for the product website. Node built-ins only: every page in pages/ is a
// fragment with a leading `<!-- page: {...} -->` header, rendered into layout.html; docs pages also
// get the docs shell. Output goes to site/dist, ready for GitHub Pages at a project subpath.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(site);
const out = path.resolve(site, 'dist');
if (path.dirname(out) !== site || path.basename(out) !== 'dist') throw new Error('Invalid build destination');

const DOCS = [
  { slug: 'quickstart', title: 'Quickstart' },
  { slug: 'recipes', title: 'Recipe authoring' },
  { slug: 'configuration', title: 'Configuration' },
];

const layout = fs.readFileSync(path.join(site, 'layout.html'), 'utf8');
const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
  if (!(key in values)) throw new Error(`Template placeholder {{${key}}} has no value`);
  return values[key];
});

function readPage(file) {
  const source = fs.readFileSync(file, 'utf8');
  const header = /^<!--\s*page:\s*(\{[\s\S]*?\})\s*-->\n?/.exec(source);
  if (!header) throw new Error(`${path.relative(site, file)} has no page header`);
  return { meta: JSON.parse(header[1]), content: source.slice(header[0].length) };
}

function docsShell(meta, content, base) {
  const links = DOCS.map((d) => `<a href="${base}docs/${d.slug}.html"${d.slug === meta.nav ? ' aria-current="page"' : ''}>${d.title}</a>`).join('');
  const more = `<a class="sub" href="https://github.com/nulllvoid/session-quill/blob/main/docs/ARCHITECTURE.md">Architecture guide</a><a href="https://github.com/nulllvoid/session-quill/tree/main/docs/decisions">Decision records</a><a href="https://github.com/nulllvoid/session-quill#readme">Full README</a>`;
  return `    <div class="docs-page container">\n      <nav class="docs-nav" aria-label="Documentation"><span class="eyebrow">Documentation</span>${links}${more}</nav>\n      <article class="docs-body">\n${content}\n      </article>\n    </div>`;
}

function render(relative) {
  const { meta, content } = readPage(path.join(site, 'pages', relative));
  const depth = relative.split('/').length - 1;
  const base = '../'.repeat(depth);
  const scripts = [`<script src="${base}site.js" defer></script>`, ...(meta.scripts ?? []).map((s) => `<script src="${base}${s}" defer></script>`)];
  const html = fill(layout, {
    title: meta.title,
    description: meta.description,
    base,
    head: '',
    bodyClass: meta.bodyClass ?? (meta.nav ? 'docs' : ''),
    docsCurrent: meta.nav ? 'aria-current="page"' : '',
    content: meta.nav ? docsShell(meta, content, base) : content,
    scripts: scripts.map((s) => `  ${s}`).join('\n') + '\n',
  });
  const target = path.join(out, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html);
  return relative;
}

function listPages(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? listPages(path.join(dir, entry.name), `${prefix}${entry.name}/`)
    : entry.name.endsWith('.html') ? [`${prefix}${entry.name}`] : []);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
const pages = listPages(path.join(site, 'pages')).map(render);
for (const file of ['styles.css', 'site.js', 'app.js', 'theme.js']) fs.copyFileSync(path.join(site, file), path.join(out, file));
for (const file of ['thread-art.jpg', 'quill.svg']) fs.copyFileSync(path.join(site, 'assets', file), path.join(out, 'assets', file));
for (const file of ['Geist-Variable.woff2', 'GeistMono-Variable.woff2', 'OFL.txt']) fs.copyFileSync(path.join(repo, 'ui/fonts', file), path.join(out, 'assets', file));
for (const file of ['gsap.min.js', 'ScrollTrigger.min.js']) fs.copyFileSync(path.join(site, 'node_modules/gsap/dist', file), path.join(out, 'vendor', file));
fs.copyFileSync(path.join(site, 'node_modules/gsap/README.md'), path.join(out, 'vendor/GSAP-README.txt'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`Built static site: ${out} (${pages.length} pages: ${pages.join(', ')})`);
