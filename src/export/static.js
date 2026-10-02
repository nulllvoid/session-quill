// Standalone read-only HTML: the live UI modules concatenated into one inline module, the stylesheet
// inlined, and a sanitized snapshot embedded. No service dependency, request code or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeSnapshot } from './sanitize.js';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const MODULE_ORDER = ['lib/time.js', 'components.js', 'views/header.js', 'views/picknext.js', 'views/board.js', 'views/tree.js', 'views/sessions.js', 'views/deployments.js', 'views/detail.js', 'views/handoff-form.js', 'views/dialogs.js'];
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

function stripModuleSyntax(source) {
  return source
    .split('\n')
    .filter((line) => !/^import\s[^;]*;\s*$/.test(line))
    .map((line) => line.replace(/^export\s+(async\s+function|function|const|let|class)\b/, '$1'))
    .join('\n');
}

export function bundleUiModules({ staticMode = true, uiDir = UI_DIR } = {}) {
  const files = [...MODULE_ORDER, staticMode ? 'lib/api-static.js' : 'lib/api.js', 'app.js'];
  const parts = files.map((rel) => `// ---- ${rel} ----\n${stripModuleSyntax(fs.readFileSync(path.join(uiDir, rel), 'utf8'))}`);
  return `'use strict';\n${parts.join('\n')}\n`;
}

// Prevent `</script>` and the U+2028/U+2029 separators from breaking the inline script.
function embedJson(obj) {
  return JSON.stringify(obj)
    .split('<').join('\\u003c')
    .split(LINE_SEP).join('\\u2028')
    .split(PARA_SEP).join('\\u2029');
}

export function buildStaticHtml(snapshot, options = {}, { uiDir = UI_DIR } = {}) {
  const sanitized = sanitizeSnapshot(snapshot, options);
  const css = fs.readFileSync(path.join(uiDir, 'styles.css'), 'utf8');
  let html = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
  html = html.replace(/<link rel="stylesheet" href="\/ui\/styles.css">/, `<style>\n${css}\n</style>`);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>Session Quill snapshot — ${sanitized.meta.exported_at}</title>`);
  const bundle = bundleUiModules({ staticMode: true, uiDir });
  const scripts = `<script>window.__SNAPSHOT__ = ${embedJson(sanitized)};</script>\n<script type="module">\n${bundle}\n</script>`;
  html = html.replace(/<script type="module" src="\/ui\/app.js"><\/script>/, scripts);
  html = html.replace('<body ', `<body data-static="true" data-exported-at="${sanitized.meta.exported_at}" `);
  return html;
}

export function writeStaticHtml(snapshot, outPath, options = {}) {
  const html = buildStaticHtml(snapshot, options);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, html);
  return { path: path.resolve(outPath), bytes: Buffer.byteLength(html), ticket_count: snapshot.tickets.length };
}
