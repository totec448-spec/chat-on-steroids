# Workspace Settings UI — 2026-09-18

## Outcome

Workspace now follows the visual system already used by Plugins, Skills and Pets: the same
centered 940px canvas, page-heading hierarchy, section rhythm, bounded surfaces and responsive
padding. The operational order is Permissions, Folders, Health and Activity.

The final layout is deliberately one column. Approved folders are an unbounded user-owned list;
placing that list beside another section made the second column's position depend on folder
count. A single semantic flow keeps every section aligned and behaves predictably at every
supported width.

## Changed

- Replaced the legacy generic card grid with Workspace-specific page, section and surface
  structure while preserving every existing control ID and event owner.
- Kept permissions visually primary without creating a separate authority or state path.
- Added truncation for long folder labels and paths, clear focus rings, bounded Activity
  scrolling and narrow-window padding.
- Added `scripts/verify-workspace-ui.cjs`, which renders the real HTML and CSS in offscreen
  Chromium with twelve representative folders.

## Validation

- `node scripts/verify-workspace-ui.cjs`
  - passed at 1400px and 900px;
  - verified one-column order, common section width and no horizontal overflow;
  - exercised a twelve-folder list.
- `npm run typecheck`
- focused renderer layout test for the scrollable Workspace panel
- live Electron inspection with the canonical development profile
- `git diff --check`

## Follow-up: empty Folders alignment

The generic empty-state rule had 4 px of top padding and 14 px at the bottom, placing the Folders
guidance visibly above the center of its bounded surface. `#rootsEmpty` now owns a zero paragraph
margin, symmetric 10 px vertical padding and an explicit 1.5 line-height. The workspace Chromium
fixture checks equal padding and a sub-pixel center delta before populating its long-folder case.
