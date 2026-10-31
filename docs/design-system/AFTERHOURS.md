# Quill Studio: Cloudscape platform shell

Approved direction, 30 October 2026. Based on main v2.3.0 (`c29f6e2`).

Quill is a developer platform. Its live shell uses Cloudscape AppLayout, SideNavigation, BreadcrumbGroup, Header, Badge and StatusIndicator, with graphite and paper surfaces and iris accents. The workspace follows the existing v2.3 hierarchy: Work, Runs, Daily update, Sessions; Activity, Deployments and Memory under Insights. No workflow, backend capability or owner-only view is invented by the shell.

## Visual rules

- Ink canvas `#18191b`, dark content `#202123`, dark accent `#c1a7ff`.
- Pale canvas `#f6f5f2`, white content, light accent `#6941c6`.
- Geist UI type, Geist Mono for technical values. The bundled fonts work offline.
- Lilac identifies selection and primary actions. Warning/failure/success retain independent semantic colors and labels.
- Keep the platform legible: flat content regions, readable rows, compact filters, no ornamental graphs or animated backgrounds.
- Brand expression is limited to the Quill mark, clear copy and considered interaction feedback. Operational messages stay precise.
- The main Work workspace preserves the v2.3 lenses, task hierarchy, bulk selection, inline status/priority controls, completion evidence and run actions.

## Integration boundaries

`ui/platform/shell.jsx` owns the Cloudscape shell. It moves the existing header, filter and layout elements into stable React islands. React does not reconcile their children; `ui/app.js` still owns polling, workflow rendering, dialogs, permissions, revisions, drafts and API requests.

Navigation calls the existing view transition through local DOM events, preserving filters and closing stale ticket/run detail. All seven current destinations remain available in Cloudscape's mobile drawer. Existing 1–8 keyboard shortcuts remain supported.

`ui/platform/theme.mjs` contains supported Cloudscape theme overrides. `ui/styles.css` owns legacy renderer tokens and styles. `tests/ui/platform-theme.test.js` guards matching brand tokens and text contrast across both engines. Generated `ui/assets` files mirror the renderer tokens; do not edit them manually.

The static exporter removes live-shell assets. Standalone exports retain the lightweight legacy layout and its read-only capability restrictions, with updated brand tokens. They do not load React or call a CDN. The full Cloudscape layout is currently live-app only.

## Build and preview

```sh
npm ci
npm run build:ui
npm run check:ui
npm run dev:ui
```

`dev:ui` builds the assets and starts the existing isolated seed worker. It does not use the real Quill store. Open its one-use owner URL locally. The `ui/dist` bundle is checked in so plugin users can run the dashboard without installing frontend dependencies. Contributors changing the shell must rebuild and check generated assets. Keep the generated license notice with the bundle.

Theming uses Cloudscape's supported build-time token API. Browser dependencies are bundled locally; the worker/CLI remain Node ES modules and do not import React.

## Migration note

The initial in-progress redesign targeted the October 11 checkout. The user requested the latest UI before completion. That work was saved in a named Git stash, main v2.3.0 was fast-forwarded, and the shell was adapted to its new Work navigation. Older Pick next/Board/Relationships routes continue through the existing compatibility routing.
