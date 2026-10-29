import { markedLibrary } from '../vendor/marked.js';

const markdownEscape = (text) => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// No HTML or remote embeds from ticket/provider/agent text may enter the workspace.
function markdownLink(href, label, title) {
  const destination = String(href ?? '').trim();
  if (!/^(https?:\/\/|mailto:)/i.test(destination)) return label;
  try {
    const url = new URL(destination);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return label;
    return `<a href="${markdownEscape(url.href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${markdownEscape(title)}"` : ''}>${label}</a>`;
  } catch { return label; }
}

const markdownEngine = new markedLibrary.Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) { return markdownEscape(text); },
    link({ href, tokens, title }) { return markdownLink(href, this.parser.parseInline(tokens), title); },
    image({ href, text, title }) { return markdownLink(href, markdownEscape(text || 'View image'), title); },
    heading({ depth, tokens }) { const level = Math.min(depth + 2, 6); return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`; },
    table(token) { return `<div class="markdown-table" tabindex="0" role="region" aria-label="Markdown table">${markedLibrary.Renderer.prototype.table.call(this, token)}</div>`; },
    code({ text, lang }) {
      return `<div class="markdown-code"><div class="code-toolbar"><span class="code-language">${markdownEscape(lang?.split(/\s/)[0] || 'Code')}</span><button type="button" class="btn small ghost" data-copy="${markdownEscape(text)}" data-copy-label="code">Copy</button></div><pre><code>${markdownEscape(text)}</code></pre></div>`;
    },
  },
});

export function renderMarkdown(text = '') {
  // Large logs stay readable without running an unbounded Markdown parse on every poll.
  if (String(text ?? '').length > 100000) return `<pre class="markdown-fallback">${markdownEscape(text)}</pre>`;
  try { return `<div class="markdown">${markdownEngine.parse(String(text ?? ''))}</div>`; }
  catch { return `<pre class="markdown-fallback">${markdownEscape(text)}</pre>`; }
}
