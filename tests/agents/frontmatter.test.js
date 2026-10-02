import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../../src/agents/frontmatter.js';

test('frontmatter: scalars, quoted strings, inline lists and maps, block lists and comments', () => {
  const { data, body } = parseFrontmatter([
    '---',
    'name: deploy-check            # trailing comment',
    'description: "Verify stage/prod # not a comment"',
    "literal: 'it''s here'",
    'timeout_min: 10',
    'enabled: true',
    'nothing: null',
    'permissions: { read_source: true, edit_source: false, commit: false }',
    'tools: [Read, Grep, "Bash(git log:*)"]',
    'outputs:',
    '  - deploy_evidence',
    '  - next_action',
    '# a full-line comment',
    '---',
    'For {{ticket.key}}: check it.',
    '',
  ].join('\n'));
  assert.deepEqual(data, {
    name: 'deploy-check', description: 'Verify stage/prod # not a comment', literal: "it's here", timeout_min: 10, enabled: true, nothing: null,
    permissions: { read_source: true, edit_source: false, commit: false }, tools: ['Read', 'Grep', 'Bash(git log:*)'], outputs: ['deploy_evidence', 'next_action'],
  });
  assert.equal(body, 'For {{ticket.key}}: check it.\n');
});

test('frontmatter: CRLF files parse; missing fences, duplicate keys, nesting and unterminated quotes are errors', () => {
  assert.equal(parseFrontmatter('---\r\nname: a\r\n---\r\nbody\r\n').data.name, 'a');
  assert.throws(() => parseFrontmatter('name: a\n'), /must start with ---/);
  assert.throws(() => parseFrontmatter('---\nname: a\n'), /closing ---/);
  assert.throws(() => parseFrontmatter('---\nname: a\nname: b\n---\n'), /duplicate key "name"/);
  assert.throws(() => parseFrontmatter('---\npermissions: { a: { b: true } }\n---\n'), /line 2/);
  assert.throws(() => parseFrontmatter('---\nname: "open\n---\n'), /unterminated/);
  assert.throws(() => parseFrontmatter('---\n  indented: x\n---\n'), /line 2/);
});
