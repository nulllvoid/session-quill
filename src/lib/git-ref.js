// Branch names as git accepts them (`git check-ref-format --branch`), without running git, so the
// reducer can check a branch the CI watch observed the same way on every replay. Pure.
//
// git's rules for a ref, applied to `refs/heads/<name>`:
//   - no component begins with "." or ends with ".lock"; no ".." anywhere;
//   - no ASCII control character, space, "~", "^", ":", "?", "*", "[" or "\";
//   - does not begin or end with "/", no "//"; does not end with ".";
//   - no "@{"; not "@" alone.
// And for a branch: not starting with "-" (git refuses it as a branch, and it would read as an
// option), and not "HEAD". Narrower than git on two counts, never wider: at most 255 characters,
// and no Unicode control, format or separator character (a bidi override would make a branch read
// as another in the UI and in a run's prompt).

export const BRANCH_NAME_MAX = 255;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000- \u007f~^:?*[\\]|[\p{Cc}\p{Cf}\p{Z}]/u;

/** Whether git would accept `name` as a branch name (and it is at most 255 characters). */
export function branchNameOk(name) {
  if (typeof name !== 'string' || !name || name.length > BRANCH_NAME_MAX) return false;
  if (name === '@' || name === 'HEAD' || name.startsWith('-')) return false;
  if (FORBIDDEN.test(name) || name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  return name.split('/').every((c) => c && !c.startsWith('.') && !c.endsWith('.lock'));
}
