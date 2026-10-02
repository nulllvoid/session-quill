import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { contrastRatio } from '../../ui/lib/color.js';

const css = fs.readFileSync(path.resolve('ui/styles.css'), 'utf8');

function tokens(selectorRe) {
  const block = selectorRe.exec(css);
  assert.ok(block, `block ${selectorRe} present`);
  const out = {};
  for (const m of block[1].matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}

const STATUSES = ['todo', 'active', 'review', 'deploy', 'blocked', 'done'];
const LIGHT_RE = /(?:^|\n):root\s*\{([^}]*)\}/;
const DARK_RE = /:root\[data-theme="dark"\][^{]*\{([^}]*)\}/;

for (const [label, selector] of [['light', LIGHT_RE], ['dark', DARK_RE]]) {
  test(`${label} theme tokens meet WCAG AA (4.5:1) on their actual backgrounds`, () => {
    const t = tokens(selector);
    const pairs = [];
    for (const fg of ['text', 'text-muted', 'text-faint']) for (const bg of ['bg', 'surface', 'surface-raised']) pairs.push([fg, bg]);
    for (const s of STATUSES) pairs.push([`status-${s}`, `status-${s}-bg`]);
    pairs.push(['stale', 'stale-bg'], ['accent-fg', 'accent-fill'], ['accent', 'surface'], ['accent', 'surface-raised'], ['good', 'surface'], ['warning', 'surface'], ['critical', 'surface'], ['text', 'accent-soft']);
    for (const [fg, bg] of pairs) {
      assert.ok(t[fg], `token ${fg} defined`);
      assert.ok(t[bg], `token ${bg} defined`);
      const ratio = contrastRatio(t[fg], t[bg]);
      assert.ok(ratio >= 4.5, `${label}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1`);
    }
    assert.ok(contrastRatio(t.border, t.surface) >= 1.2, 'borders are visible');
    assert.ok(contrastRatio(t.focus, t.bg) >= 3, 'focus ring meets 3:1 against the page');
  });
}

test('contrastRatio is symmetric and known values hold', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
  assert.equal(contrastRatio('#777777', '#ffffff').toFixed(2), contrastRatio('#ffffff', '#777777').toFixed(2));
});

test('reduced motion and dark-mode media queries are present and no emoji are used in UI sources', () => {
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /prefers-color-scheme: dark/);
  const dir = path.resolve('ui');
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(js|html|css)$/.test(f));
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(/\p{Extended_Pictographic}/u.test(text), false, `${f} contains emoji`);
  }
});
