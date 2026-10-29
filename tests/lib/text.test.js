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

test('inferred titles reject tool envelopes and standalone temporary paths without rejecting technical requests', () => {
  for (const text of ['{"tool_name":"Read","tool_input":{"file_path":"/tmp/task"}}', '<tool_result>done</tool_result>', '/private/var/folders/abc/T/agent-result.txt', '/tmp/agent-123.json']) assert.equal(sanitizeTitle(text), '');
  assert.equal(sanitizeTitle('Fix cleanup for /tmp/cache in worker.js'), 'Fix cleanup for /tmp/cache in worker.js');
  assert.equal(sanitizeTitle('Implement tool_result parsing'), 'Implement tool_result parsing');
});
