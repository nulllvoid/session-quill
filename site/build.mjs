import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(site);
const out = path.resolve(site, 'dist');
if (path.dirname(out) !== site || path.basename(out) !== 'dist') throw new Error('Invalid build destination');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'theme.js']) fs.copyFileSync(path.join(site, file), path.join(out, file));
for (const file of ['thread-art.jpg', 'quill.svg']) fs.copyFileSync(path.join(site, 'assets', file), path.join(out, 'assets', file));
for (const file of ['Geist-Variable.woff2', 'GeistMono-Variable.woff2', 'OFL.txt']) fs.copyFileSync(path.join(repo, 'ui/fonts', file), path.join(out, 'assets', file));
for (const file of ['dashboard-pick-next.jpg', 'dashboard-board-detail.jpg']) fs.copyFileSync(path.join(repo, 'docs/images', file), path.join(out, 'assets', file));
for (const file of ['gsap.min.js', 'ScrollTrigger.min.js']) fs.copyFileSync(path.join(site, 'node_modules/gsap/dist', file), path.join(out, 'vendor', file));
fs.copyFileSync(path.join(site, 'node_modules/gsap/README.md'), path.join(out, 'vendor/GSAP-README.txt'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`Built static site: ${out}`);
