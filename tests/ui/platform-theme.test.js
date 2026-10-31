import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { theme } from '../../ui/platform/theme.mjs';
import { contrastRatio } from '../../ui/lib/color.js';

const css = fs.readFileSync(new URL('../../ui/styles.css', import.meta.url), 'utf8');
const pairs = {
  colorBackgroundLayoutMain: 'bg', colorBackgroundContainerContent: 'surface',
  colorBackgroundContainerHeader: 'surface', colorTextBodyDefault: 'text',
  colorTextBodySecondary: 'text-muted', colorTextHeadingDefault: 'text',
  colorTextAccent: 'accent', colorTextLinkDefault: 'accent',
  colorBackgroundButtonPrimaryDefault: 'accent-fill', colorTextButtonPrimaryDefault: 'accent-fg',
  colorBackgroundItemSelected: 'accent-soft', colorBorderItemSelected: 'accent',
};

for (const mode of ['light', 'dark']) {
  test(`Cloudscape and renderer islands share the ${mode} palette`, () => {
    const block = (mode === 'light' ? /(?:^|\n):root\s*\{([^}]*)\}/ : /:root\[data-theme="dark"\][^{]*\{([^}]*)\}/).exec(css)[1];
    const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/g)].map((match) => [match[1], match[2]]));
    for (const [cloudscape, quill] of Object.entries(pairs)) assert.equal(theme.tokens[cloudscape][mode], tokens[quill], `${cloudscape} matches --${quill}`);
    const t = theme.tokens;
    for (const [fg, bg] of [
      ['colorTextButtonPrimaryDefault', 'colorBackgroundButtonPrimaryDefault'],
      ['colorTextButtonPrimaryHover', 'colorBackgroundButtonPrimaryHover'],
      ['colorTextBodyDefault', 'colorBackgroundItemSelected'],
      ['colorTextBodySecondary', 'colorBackgroundContainerContent'],
    ]) assert.ok(contrastRatio(t[fg][mode], t[bg][mode]) >= 4.5, `${fg} on ${bg} passes AA`);
  });
}
