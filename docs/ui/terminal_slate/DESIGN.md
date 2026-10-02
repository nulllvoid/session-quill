---
name: Terminal Slate
colors:
  surface: '#161b22'
  surface-dim: '#0b141c'
  surface-bright: '#313a43'
  surface-container-lowest: '#060f16'
  surface-container-low: '#141c24'
  surface-container: '#182028'
  surface-container-high: '#222b33'
  surface-container-highest: '#2d363e'
  on-surface: '#dae3ee'
  on-surface-variant: '#c1c6d6'
  inverse-surface: '#dae3ee'
  inverse-on-surface: '#29313a'
  outline: '#8b909f'
  outline-variant: '#414754'
  surface-tint: '#acc7ff'
  primary: '#acc7ff'
  on-primary: '#002f68'
  primary-container: '#498fff'
  on-primary-container: '#00285b'
  inverse-primary: '#005bbf'
  secondary: '#d5bbff'
  on-secondary: '#41008b'
  secondary-container: '#5a21ab'
  on-secondary-container: '#c6a5ff'
  tertiary: '#67df70'
  on-tertiary: '#00390d'
  tertiary-container: '#27a640'
  on-tertiary-container: '#00320a'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d7e2ff'
  primary-fixed-dim: '#acc7ff'
  on-primary-fixed: '#001a40'
  on-primary-fixed-variant: '#004492'
  secondary-fixed: '#ecdcff'
  secondary-fixed-dim: '#d5bbff'
  on-secondary-fixed: '#270058'
  on-secondary-fixed-variant: '#5a21ab'
  tertiary-fixed: '#83fc89'
  tertiary-fixed-dim: '#67df70'
  on-tertiary-fixed: '#002105'
  on-tertiary-fixed-variant: '#005317'
  background: '#0b141c'
  on-background: '#dae3ee'
  surface-variant: '#2d363e'
  bg: '#0d1117'
  surface-raised: '#21262d'
  border: '#30363d'
  border-strong: '#484f58'
  text: '#f0f6fc'
  text-muted: '#8b949e'
  text-faint: '#6e7681'
  accent: '#2f81f7'
  status-todo: '#8b949e'
  status-active: '#2f81f7'
  status-review: '#a371f7'
  status-deploy: '#d29922'
  status-blocked: '#f85149'
  status-done: '#3fb950'
  freshness-fresh: '#3fb950'
  freshness-ageing: '#d29922'
  freshness-stale: '#f0883e'
  freshness-critical: '#f85149'
  focus-ring: '#2f81f7'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 22px
    fontWeight: '600'
    lineHeight: 30.8px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 17px
    fontWeight: '600'
    lineHeight: 23.8px
    letterSpacing: -0.005em
  headline-sm:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '600'
    lineHeight: 21px
    letterSpacing: 0em
  body-lg:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 21px
  body-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18.2px
  body-sm:
    fontFamily: Inter
    fontSize: 11.5px
    fontWeight: '400'
    lineHeight: 16.1px
  label-lg:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '600'
    lineHeight: 18.2px
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16.8px
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 15.4px
    letterSpacing: 0.02em
  code-key:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16.8px
    letterSpacing: -0.02em
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 15.4px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-sm: 0.5rem
  margin: 1rem
  margin-mobile: 0.75rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.5rem
---

## Brand & Style

The design system establishes a high-density, focused developer workspace tailored for local session management, real-time ticket triage, and deployment tracking. Borrowing deeply from terminal ergonomics and classic developer IDE aesthetics, the visual language prioritizes utility, rapid scannability, and explicit status provenance over ornamental flair.

### Target Audience & Personality
Built for software engineers, systems programmers, and devops practitioners operating side-by-side with a terminal. The aesthetic is calm, authoritative, restrained, and precise. It rejects marketing hype, noisy animations, and bloated spacing, creating an environment that minimizes cognitive load while juggling intense technical context.

### Design Movement: Technical Brutalism Meets Calm Terminal
- **Subdued Canvas:** Layered neutral surfaces ranging from obsidian to charcoal provide clear containment without glare.
- **Explicit Functional Tokens:** Visual indicators are never ambiguous; color always reinforces semantic text labels rather than acting in isolation.
- **Utilitarian Rigor:** 1px crisp architectural dividers, sharp data alignments, strict 4px grid rhythm, and dedicated monospace hierarchy for verifiable hashes, revisions, and ticket identifiers.

## Colors

The color palette centers on a dark-first environment calibrated to reduce fatigue and deliver high visual contrast across deeply nested technical surfaces.

### Core Architecture & Neutrals
- **Background (`#0d1117`):** Base canvas framing the full viewport.
- **Surface (`#161b22`):** Primary container tier for board columns, docked panels, tables, and views.
- **Surface Raised (`#21262d`):** Cards, interactive buttons, modal layers, and elevated headers.
- **Border (`#30363d`):** Standard structural hairline borders separating components and layout zones.
- **Border Strong (`#484f58`):** Emphasized borders, hover states, and active control boundaries.
- **Text (`#f0f6fc`):** High-contrast primary reading layer meeting WCAG AAA across dark tiers.
- **Text Muted (`#8b949e`):** Supporting metadata, labels, and secondary context meeting WCAG AA.
- **Text Faint (`#6e7681`):** De-emphasized structural hints, icons, and timestamp delimiters.

### Semantic Workflow Statuses
Each status maps to a dedicated hex value applied via background tints, borders, and foreground text tokens:
- **Todo (`#8b949e`):** Unscheduled, quiet backlog work.
- **Active (`#2f81f7`):** Primary working state with focused terminal attribution.
- **Review (`#a371f7`):** PR inspection, approval gates, and draft checks.
- **Deploy (`#d29922`):** Merged code awaiting verification across production/staging.
- **Blocked (`#f85149`):** Explicit impediments requiring mandatory blocker attribution.
- **Done (`#3fb950`):** Reconciled, verified, and complete work.

### Freshness & Health Tokens
- **Fresh (`#3fb950`):** Synced < 2 hours ago.
- **Ageing (`#d29922`):** Synced 2–6 hours ago.
- **Stale (`#f0883e`):** Synced > 6 hours ago; derived indicator that never mutates ticket status.
- **Critical / Error (`#f85149`):** Capture backlog gaps, failed syncs, or broken worker connectivity.

## Typography

The typographic engine balances rapid UI comprehension with developer-grade data precision. 

### Font Family Allocation
- **Proportional UI (Inter / system-ui):** Used for view titles, card descriptions, labels, form controls, and next-action summaries. Calibrated with a universal 1.4 line-height ratio.
- **Monospace Stack (JetBrains Mono / system monospace):** Reserved for technical identifiers, ticket keys (e.g., `LOCAL-session-capture-a1b2c3d4`), Git commit SHAs, filesystem paths, shell instructions, and raw score diagnostics.

### Scale & Hierarchy Rules
- High-density view hierarchy relies on subtle font size shifts (22px down to 11.5px) and weight modulation (400 vs 600) rather than sprawling vertical gaps.
- All numbers, counts, and table cells align using tabular figures (`font-variant-numeric: tabular-nums`) to ensure strict visual columnar rhythm.

## Layout & Spacing

A strictly bounded 4px baseline rhythm controls all empty space (`4px`, `8px`, `12px`, `16px`, `24px`, `32px`). Density is tight and predictable, designed to keep critical work context visible above the fold.

### Viewport Layout Modes
- **Wide Workstation (>= 1280px):** 
  - Kanban Board uses fixed 240px wide status columns contained in a single horizontal scroll container.
  - Ticket Detail opens as a docked, non-modal 420px panel on the right side without trapping focus or displacing underlying navigation.
- **Standard Laptop & Split-Window (900px – 1279px):**
  - Board switches to vertical grouped sections with column pagination.
  - Detail opens in a 420px contextual flyout modal.
- **Compact & Mobile (< 900px):**
  - Single-column flow with persistent top header and compact bottom navigation tabs.
  - Ticket detail renders as a full-screen focus-trapped dialog.
  - Mutation actions remain fully accessible to local owners down to 390px.

### Internal Spacing Rhythm
- **Component Padding:** Standard card interior padding is fixed to 12px (`space-md`), creating a compact envelope for high card volume.
- **Row Gaps:** 8px (`space-sm`) between grouped ticket cards or session rows.
- **Outer Canvas Margins:** 16px (`margin`) on desktop, 12px (`margin-mobile`) on mobile viewports.

## Elevation & Depth

Visual hierarchy is expressed via tonal layer stepping and crisp 1px borders rather than blur-heavy drop shadows. This preserves a lightweight, terminal-adjacent feel.

### Surface Hierarchy
1. **Base Layer (`#0d1117`):** The application canvas and outer framing.
2. **Container Tier (`#161b22`):** Primary content zones, board lanes, table bodies, and filter bars. Delimited by a 1px solid `#30363d` outline.
3. **Elevated Elements (`#21262d`):** Cards, dropdown popovers, tooltips, and interactive buttons. 
4. **Overlay Panels:** Floating modals, detail drawers, and the handoff form use `#161b22` backed by a 1px `#484f58` border and an ambient shadow: `box-shadow: 0 12px 32px -4px rgba(1, 4, 9, 0.85)`.

### Focus Elevation
Interactive focus overrides elevation with an accessible, high-contrast outline: a solid 2px `#2f81f7` ring offset by 2px `#0d1117`.

## Shapes

Shapes communicate technical precision through controlled radii, balancing structural rectangularity with comfortable pill targets.

### Radius Spectrum
- **Cards & Panels:** 8px (`rounded-md` equivalent in standard 8px scale) for ticket cards, detail panels, forms, and dialogs.
- **Interactive Controls:** 6px for buttons, inputs, filter dropdowns, and pagination controls.
- **Status, Freshness & Category Chips:** 999px pill shapes (`rounded-full`), visually distinguishing metadata tags from rectangular cards and actionable buttons.
- **Monospace Code Snippets & Key Pills:** 4px radius with 1px inset border for hashes, keys, and revisions.

## Components

### Buttons & Interactive Triggers
- **Primary:** Solid `#2f81f7` background, `#ffffff` text, 6px radius, font weight 600. Hover: `#388bfd`. Active: `#1f6feb`.
- **Secondary / Ghost:** Transparent background, 1px `#30363d` border, `#f0f6fc` text. Hover: `#21262d` surface with `#484f58` border.
- **Destructive:** `#21262d` surface, 1px `#f85149` border, `#f85149` text. Hover: `#f85149` solid with `#ffffff` text.
- **Handoff Trigger:** Dedicated accent button displaying a 16px terminal line-icon. Must never be nested inside an unisolated card click-target. Minimum tap dimension: 32 × 32px.

### Status & Category Chips
- **Chips:** 999px radius pill shape, height 22px, padding 0 8px, font size 11px, weight 500.
- **Dual Visual Encoding:** Status chips use a low-opacity tinted background (15% opacity), a matching border (40% opacity), a solid foreground text token, and an explicit text label (never color alone).
- **Stale Indicator:** Independent 999px badge (`#f0883e`) displaying exact elapsed time (e.g., `stale 7h`). Displayed alongside, never replacing, the core workflow status.

### Ticket Cards
- **Container:** `#21262d` surface, 1px `#30363d` border, 8px radius, 12px internal padding.
- **Header Line:** Displays the monospaced ticket key (e.g., `LOCAL-session-capture-a1b2c3d4`) on the left and the status chip on the right.
- **Body:** Proportional UI font (13px, weight 600) for the ticket title.
- **Next Action Strip:** Highlighted nested row with a muted terminal prompt symbol (`>`) preceding the next actionable step.
- **Metadata Footer:** Priority indicator (P0–P3 in bold text, no color dependencies), relative timestamp with tooltip absolute UTC RFC 3339 time, and PR/deployment state tokens.

### Form Inputs & Handoff Forms
- **Input Fields:** `#0d1117` inset background, 1px `#30363d` border, `#f0f6fc` text, 6px radius, height 32px, 8px horizontal padding. Focus: 2px `#2f81f7` outline.
- **Next Action Inline Editor:** Enter submits revision; Shift+Enter creates newline; Escape cancels. Displays "Sending" indicator for acknowledgement, then provides a 10s cancellation window.
- **Handoff Dialog:** Explicit permission checkboxes (read source, edit source, commit, push branch, open PR) with clear prerequisite warnings before submission.

### Tables & Timeline Rows
- **List / Row Items:** Alternate hover highlight (`#161b22` to `#21262d`), separated by 1px hairline `#30363d` dividers.
- **Timeline Coverage:** Event nodes display explicit badges for `complete`, `partial`, or `unknown` data coverage alongside UTC timestamps.