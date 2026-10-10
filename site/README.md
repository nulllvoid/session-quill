# Session Quill product website

Static HTML and CSS rendered by a small generator on Node built-ins (`build.mjs`), with
locally bundled GSAP for the landing page motion. No application backend, analytics,
external fonts or runtime CDN. The Quill application is not served by this site.

## Layout of this folder

| Path | What |
| --- | --- |
| `layout.html` | The shell every page is rendered into: head, navigation, footer, scripts. `{{placeholders}}` are filled by the build. |
| `pages/index.html` | The landing page fragment. Each page starts with a `<!-- page: {...} -->` header (title, description, scripts, body class). |
| `pages/docs/*.html` | The docs pages (quickstart, recipes, configuration). A `nav` key in the header wraps them in the docs shell with the side navigation. |
| `styles.css` | Graphite Ink, ported from `ui/styles.css`: the same colour tokens in both themes, radius scale, hairlines and vendored Geist fonts, plus the marketing layout. |
| `site.js` | Shared behaviour: theme toggle, copy buttons, live region. |
| `app.js` | Landing page only: the hero dispatch sequence and scroll reveals (GSAP). |
| `theme.js` | Runs before first paint; follows the OS like the dashboard unless a choice was saved. |
| `build.mjs`, `check.mjs`, `serve.mjs` | Build to `dist/`, validate it, preview it. |

## Local preview

```sh
npm ci --prefix site
npm run dev --prefix site
```

Open http://127.0.0.1:4173/session-quill/. The project subpath deliberately matches
GitHub Pages. `npm run build --prefix site` produces `site/dist`; `npm run check
--prefix site` validates every page: asset references resolved from each page's own
folder, anchors, subpath-safe references, no em or en dashes and no emoji in copy (the
same rules as the dashboard), and the theme and reduced-motion fallbacks.

## GitHub Pages

In the repository's **Settings > Pages > Build and deployment**, select **GitHub
Actions** as the source. Merge the website into `main`, or run the **Product
website** workflow from `main`. Pull requests build and check without deploying.
The expected project URL is https://nulllvoid.github.io/session-quill/.

The workflow uploads only `site/dist`, never the repository or private Quill data.
All runtime assets use relative paths, so the same output can be hosted at another
subpath. Update the `og:image` URL in `layout.html` when hosting under a different domain.

## Copy rules

The site follows the reviewed 1.0 delivery plan (`docs/superpowers/plans/2026-10-11-orchestration-1.0.md`),
not the earlier PRD drafts: clones are previewed and confirmed, there is no pre-warmed
worktree pool, the test gate is worker logic with one repair turn, remote page edits
become proposed runs the owner approves, the dashboard port defaults to 47321. Keep the
Graphite Ink voice: sentence case, no dashes in copy, mono only for keys, commands and
numbers, outcomes stated with their evidence ("Tests passed (worker)").

## Design and assets

Graphite Ink (`docs/ui/graphite_ink/DESIGN.md`): warm graphite neutrals, one accent,
hairlines over boxes, Geist and Geist Mono. The hero and feature visuals are built
from the dashboard's own component rules (cards, chips, buttons, status line, the 1.0
bulk action bar) rather than screenshots, so they stay current with the tokens. Motion
is feedback only: the hero sequence plays once, reveals play once, and everything
switches off under `prefers-reduced-motion`.

Fonts and their OFL license are copied from `ui/fonts`. GSAP and its license notices
and README are bundled from the pinned npm dependency.

`assets/thread-art.jpg` is original generated artwork made with the built-in
image generation tool, optimized as JPEG. Prompt:

> Create a premium abstract 3D brand artwork for Session Quill, a developer tool
> that preserves connected work across coding sessions. No text, no lettering,
> no UI, no logos. A single sculptural ribbon made of many fine parallel
> mint-green luminous filaments curves in a precise flowing loop like a loosely
> folded strip of brushed glass. The overall silhouette subtly recalls a quill
> feather without depicting a literal feather. Beautiful physical material,
> narrow pale-mint edge highlights, deep forest inner reflections, matte graphite
> background (#101512), restrained silver reflections. Asymmetric sculptural
> object occupying the center-right with generous negative space around it,
> wide landscape 3:2 composition. Sophisticated architectural studio render,
> soft directional lighting, tangible depth, very crisp fine strands, dramatic
> but not sci-fi, no blue or purple, no gradient blobs, no random particles.
> This will be a large hero visual in a high-design developer product landing page.
