# Session Quill product website

Static HTML, CSS, and locally bundled GSAP. No application backend, analytics,
external fonts, or runtime CDN. The Quill application is not served by this site.

## Local preview

```sh
npm ci --prefix site
npm run dev --prefix site
```

Open http://127.0.0.1:4173/session-quill/. The project subpath deliberately matches
GitHub Pages. `npm run build --prefix site` produces `site/dist`; `npm run check
--prefix site` validates assets, links, and subpath-safe references.

## GitHub Pages

In the repository's **Settings > Pages > Build and deployment**, select **GitHub
Actions** as the source. Merge the website into `main`, or run the **Product
website** workflow from `main`. Pull requests build and check without deploying.
The expected project URL is https://nulllvoid.github.io/session-quill/.

The workflow uploads only `site/dist`, never the repository or private Quill data.
All runtime assets use relative paths, so the same output can be hosted at another
subpath. Update the `og:image` URL when hosting under a different domain.

Official setup reference:
https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages

## Design and assets

Design variance 7/10, motion intensity 8/10, visual density 4/10. Native CSS with
Geist and Geist Mono, the existing Quill mark, graphite surfaces and mint accents.
The brand defaults to graphite; the Light mode control switches the entire page.
Reduced motion skips entry choreography, parallax, and moving connection paths.
Pause motion also disables the motion layer. Content remains readable without JS.

Dashboard images are real sample-workspace captures from `docs/images`, copied
at build time. Fonts and their OFL license are copied from `ui/fonts`. GSAP and
its license notices and README are bundled from the pinned npm dependency.

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
