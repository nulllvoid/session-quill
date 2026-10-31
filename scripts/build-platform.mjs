import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { theme } from '../ui/platform/theme.mjs';

// Cloudscape publishes bundler-oriented imports; resolve them through esbuild for Node.
const themingModule = await build({ stdin: { contents: 'export { generateThemeStylesheet } from "@cloudscape-design/components/theming";', resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { generateThemeStylesheet } = await import(`data:text/javascript;base64,${Buffer.from(themingModule.outputFiles[0].text).toString('base64')}`);
const check = process.argv.includes('--check');
const result = await build({
  entryPoints: ['ui/platform/shell.jsx'], outfile: 'ui/dist/platform.js',
  bundle: true, minify: true, format: 'esm', target: ['es2022'],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'linked', loader: { '.woff2': 'file' }, write: false,
});
for (const output of result.outputFiles) {
  const content = output.path.endsWith('.css') ? output.text + '\n' + generateThemeStylesheet({ theme, selector: 'body' }) : output.text;
  if (check) {
    if (!fs.existsSync(output.path) || fs.readFileSync(output.path, 'utf8') !== content) throw new Error(`Stale platform asset: ${path.relative(process.cwd(), output.path)}. Run npm run build:ui.`);
  } else {
    fs.mkdirSync(path.dirname(output.path), { recursive: true });
    fs.writeFileSync(output.path, content);
  }
}
console.log(`${check ? 'Verified' : 'Built'} local Cloudscape shell: ui/dist/platform.js + platform.css`);
