# Marked

Marked 17.0.5, MIT: https://github.com/markedjs/marked/tree/v17.0.5

`marked.js` is the published `lib/marked.umd.js` wrapped in a local ES module export so the existing standalone HTML bundler can include it without a build step. No CDN or network is required. Only `ui/lib/markdown.js` should consume it; that module escapes HTML, permits only explicit HTTP(S) / mailto links and renders images as links.

To upgrade, replace the UMD payload with the published release, retain the wrapper and license, and run the Markdown security and standalone export tests.
