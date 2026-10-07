import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripMarkupTags } from '../../src/lib/text.js';
import { sanitizeTitle } from '../../src/hooks/payload.js';

test('prompt markup never becomes a title: tags go, words stay, slash commands read as the command', () => {
  assert.equal(sanitizeTitle('<scheduled-task name="nightly" id="7">Check ASKIT-5026 deploy</scheduled-task>'), 'Check ASKIT-5026 deploy');
  assert.equal(sanitizeTitle('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 12</command-args>'), '/review PR 12');
  assert.equal(sanitizeTitle('<command-name>/clear</command-name>'), '/clear');
  assert.equal(sanitizeTitle('compare a < b and c > d'), 'compare a < b and c > d', 'comparisons are not tags');
  assert.equal(stripMarkupTags('<scheduled-task/>').trim(), '');
});
