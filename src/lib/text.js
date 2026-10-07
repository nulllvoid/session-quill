// Prompt text arrives wrapped in harness markup (slash-command tags, <scheduled-task …> and the
// like). Titles keep the words, never the tags.
const TAG = /<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/g;

export function stripMarkupTags(text) {
  const raw = String(text ?? '');
  // A slash-command prompt reads best as the command and its arguments.
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(raw);
  if (name && name[1]) {
    const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(raw);
    return `${name[1]}${args && args[1] ? ` ${args[1]}` : ''}`;
  }
  return raw.replace(TAG, ' ');
}
