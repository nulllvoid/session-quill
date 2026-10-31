# Quill Afterhours workspace implementation plan

**Goal:** Implement the approved Cloudscape shell and main workspace with ink/lilac branding and simple Atlassian-style hierarchy.

**Architecture:** Use actual Cloudscape React components for the live application shell. Preserve existing renderer islands and delegated actions for ticket workflows, polling, dialogs, and evidence. Build browser assets locally with esbuild. Keep standalone exports independent of React and the live bundle.

**Scope:** Shell, navigation, workspace hierarchy, readable controls, coordinated light/dark themes. No invented Runs backend, permission changes, service installation, or real-store mutations.

**Authorization:** The user's October 30 request approves implementation and the staged Cloudscape migration discussed above; it supersedes the older Fieldnotes-only/no-framework guidance.

- [x] Add build pipeline and shell integration; verify standalone export excludes live assets.
- [x] Implement Cloudscape AppLayout, SideNavigation, breadcrumbs, workspace header and container. Retain stable DOM islands across updates so focus and pending edits survive polling.
- [x] Refine recommendation layout, controls and themes with a readable ink/lilac palette, restrained brand details, and responsive spacing.
- [x] Run UI/export/server checks, asset build/check, and browser interaction checks against an isolated seed store.
- [x] Update design and development documentation with migration scope and verification evidence.

## Review focus

Navigation must preserve filters and close selected details. Offline controls and proposal approval must remain honest. Mobile navigation and detail dialogs must remain operable. Theme changes must apply to both Cloudscape and legacy views. Exports must not depend on the live bundle.
