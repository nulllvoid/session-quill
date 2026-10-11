# Quill UI assets

Reusable Fieldnotes assets for the existing Quill dashboard and future orchestration surfaces. This is a Quill-owned kit for Claude/coding agents, not Anthropic branding.

## Contents

- `brand/`: existing feather in light, dark and monochrome variants.
- `icons/`: 27 existing glyphs plus 8 orchestration extensions, and a combined SVG sprite.
- `illustrations/`: four small empty/error-state illustrations, with light and dark variants.
- `tokens.css`: theme values exported from `ui/styles.css`, shared tokens and additive `q-*` primitives.
- `tokens.json`: the same values as a documented plain JSON token map; not a DTCG interchange document.
- `components.css`: opt-in reference components, all namespaced `q-*`.
- `manifest.json`: generated file inventory and provenance. This README and manually maintained component stylesheet are not generated entries.

Preview: run `node scripts/preview-design-system.mjs` and open its printed URL. Use `--port 0` for an available port. This serves only design-related files over loopback and does not start the real worker.

## Generate and check

```sh
node scripts/build-ui-assets.mjs
node scripts/build-ui-assets.mjs --check
```

The generator reads the existing theme definitions, icon function and header logo. The new orchestration glyphs and illustrations are defined in the generator. Do not edit generated output directly. Font files remain in `ui/fonts/` rather than being copied.

## Use an icon

For shipped glyphs in existing renderers, keep using `icon('clock')` from `ui/components.js`. The new asset files do not extend that function's registry.

For an opt-in new surface, use the sprite with the URL appropriate to the host:

```html
<button class="q-button" type="button">
  <svg class="q-icon" aria-hidden="true">
    <use href="/ui/assets/icons/sprite.svg#quill-runs"></use>
  </svg>
  View runs
</button>
```

Or copy the trusted SVG markup inline from the reference catalog. Inline SVG inherits `currentColor`. An SVG loaded through `<img>` does not inherit the parent's text color; use it only where its standalone appearance is suitable.

Before production integration, check the worker's asset-routing allowlist and static-export bundler. This kit does not modify either. An externally referenced sprite may not work from `file://`; serve it over the same origin or inline the glyph.

## Use a mark

```html
<img src="/ui/assets/brand/quill-mark-light.svg" width="32" height="32" alt="">
<span>Session Quill</span>
```

Use the dark mark on dark surfaces; a monochrome mark can inherit text color when inlined. Do not stretch, rotate or decorate the mark. Keep roughly 8px clear space around a 32px mark; use at least 16px for favicons and 28–40px in the app shell.

## Use empty-state art

```html
<section class="q-empty">
  <img src="/ui/assets/illustrations/empty-queue.svg" alt="" width="160" height="90">
  <h3>No runs queued</h3>
  <p>Select a ticket and choose a recipe to prepare a run.</p>
</section>
```

Use the `-dark.svg` counterpart when the application theme is dark. For inline SVG, the `--art-ink` and `--art-accent` custom properties can override the fallback colors. Do not use a success illustration for unknown/loading data, or imply a workflow action exists merely because it appears in a visual example.

## Tokens and component styles

```html
<link rel="stylesheet" href="/ui/assets/tokens.css">
<link rel="stylesheet" href="/ui/assets/components.css">
```

The standalone token stylesheet defaults to the system preference; explicit `data-theme="light"` or `"dark"` on `<html>` overrides it. The reference page starts in light mode for a repeatable preview. These styles are opt-in and are not loaded by the production dashboard. Avoid loading duplicate token sources there without a deliberate migration.

The current app contains some legacy radii/control sizes. `q-*` primitives describe the reference components' effective values; they do not claim every existing element has been migrated.

## License and provenance

SVGs, generator and component styles use the repository's [MIT license](../../LICENSE). Existing marks/glyphs come from this repository; new glyphs and illustrations were authored for Quill and require no external icon service. Geist and Geist Mono remain under [SIL OFL](../fonts/OFL.txt). No new fonts, remote images, tracking resources or runtime packages are required.
