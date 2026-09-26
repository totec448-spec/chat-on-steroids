# Agents & automation Settings UI — 2026-09-18

## Outcome

Agents & automation now follows the same centered 940px, one-column Settings rhythm as
Workspace and Usage. The existing settings, storage owners and control IDs are unchanged.

## Change

- Reused the shared page heading, section header and surface styles. Search sits at the right
  on wide windows and stacks under the title when space is limited. Its icon, pill surface and
  focus treatment reuse the Pets/Skills/Plugins search component.
- Added a short explanatory line beneath each of the seven section titles, with ES/ZH locales.
- Moved ChatGPT model Refresh into its section header; kept Clear swarm in the worker-list
  footer. Refresh and clear actions use the app's existing Phosphor icons.
- Updated section search to hide each header and its complete surface together. Conditional
  model, credential and prompt editors retain their own visibility state.
- Added an isolated Chromium geometry check for desktop and narrow layouts, card alignment,
  search style parity, section copy, overflow, action icons and closed conditional editors.

## Validation

- `npm test -- --run test/renderer-layout.test.ts test/renderer-state.test.ts test/renderer-chat-models.test.ts` — 107 passed.
- `node scripts/verify-agents-automation-ui.cjs` — passed at 1400px and 900px.
- `npm run typecheck` and `npm run build` — passed.
- The existing `verify-settings-focus.cjs` did not reach Agents: its first Appearance picker
  at 1.17 zoom retained a 30-pixel repaint difference after blur. No Appearance code changed.
