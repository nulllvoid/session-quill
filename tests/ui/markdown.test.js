import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../ui/lib/markdown.js';
import { renderDetail } from '../../ui/views/detail.js';
import { contentViewer } from '../../ui/components.js';
import { snapshot } from './fixtures.js';

test('Markdown supports nested lists, task lists, emphasis, code, quotes and tables', () => {
  const html = renderMarkdown('# Release notes\n\n**Ready** with _evidence_ and `batch_id`.\n\n- [x] Tested\n- [ ] Ship\n  - Verify the release\n\n> Keep the checkpoint.\n\n```sql\nSELECT * FROM batches WHERE id < 4;\n```\n\n| Check | Result |\n| --- | --- |\n| Rows | 4 |');
  for (const pattern of [/<h3>Release notes<\/h3>/, /<strong>Ready<\/strong>/, /<em>evidence<\/em>/, /<code>batch_id<\/code>/, /checked="" disabled="" type="checkbox"/, /<ul>[\s\S]*<ul>[\s\S]*Verify the release/, /<blockquote>/, /class="code-language">sql</, /id &lt; 4/, /<table>/, /<td>Rows<\/td>/]) assert.match(html, pattern);
});

test('untrusted HTML stays text and cannot impersonate workspace actions', () => {
  const input = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<button data-action="handoff" data-ticket="secret">Run</button>\n\n<svg><a xlink:href="javascript:alert(1)">Click</a></svg>';
  const html = renderMarkdown(input);
  assert.doesNotMatch(html, /<(?:script|img|button|svg|iframe|style)\b/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;button data-action=&quot;handoff&quot;/);
});

test('only explicit safe external links are actionable and images never load automatically', () => {
  for (const url of ['javascript:alert(1)', 'jav&#x61;script:alert(1)', 'javascript&#58;alert(1)', 'data:text/html,evil', 'file:///etc/passwd', '//evil.test', '/v1/requests', '#view=runs', 'vbscript:evil']) {
    assert.doesNotMatch(renderMarkdown(`[link](${url})`), /<a\b/, url);
  }
  const safe = renderMarkdown('[Docs](https://example.com/a?x=1&y=2 "Read this") and <https://example.com> and [Mail](mailto:owner@example.com).');
  assert.match(safe, /href="https:\/\/example.com\/a\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer" title="Read this"/);
  assert.match(safe, /href="mailto:owner@example.com"/);
  const image = renderMarkdown('![Diagram](https://example.com/tracking.png)');
  assert.doesNotMatch(image, /<img\b/);
  assert.match(image, />Diagram<\/a>/);
  assert.doesNotMatch(renderMarkdown('![x](javascript:evil)'), /href=/);
});

test('code fence contents and language labels are escaped without formatting code', () => {
  const html = renderMarkdown('```\"onmouseover=\"bad\n<img src=x> **literal**\n```');
  assert.doesNotMatch(html, /<img|<strong>|<[^>]* onmouseover=/);
  assert.match(html, /&lt;img src=x&gt; \*\*literal\*\*/);
  assert.match(html, /data-copy="&lt;img src=x&gt; \*\*literal\*\*" data-copy-label="code"/);
});

test('large logs fall back to escaped source without dropping any content', () => {
  const text = 'x'.repeat(100001) + '<script>tail</script>';
  const html = renderMarkdown(text);
  assert.ok(html.startsWith('<pre class="markdown-fallback">'));
  assert.ok(html.endsWith('&lt;script&gt;tail&lt;/script&gt;</pre>'));
  assert.ok(html.includes('x'.repeat(100001)));
});

test('ticket descriptions and loaded text use Markdown and retain an escaped source view', () => {
  const s = snapshot(), t = { ...s.tickets[0], description: { valid: true, goal: '**Safer** batches', context: 'Use `batch_id`.', done: ['Tests **pass**'] } };
  const html = renderDetail(t, s, { now: '2026-10-30T00:00:00Z' });
  assert.match(html, /<strong>Safer<\/strong>/);
  assert.match(html, /<code>batch_id<\/code>/);
  assert.ok(html.indexOf('<h3>Description') < html.indexOf('<h3>Completion</h3>'));
  const loaded = contentViewer('ref', { content: { ref: '## Result\n<script>bad()</script>' } });
  assert.match(loaded, /<h4>Result<\/h4>/);
  assert.match(loaded, /data-disclosure="source-ref"/);
  assert.match(loaded, /<pre class="full">## Result\n&lt;script&gt;/);
  assert.doesNotMatch(loaded, /<script>/);
});
