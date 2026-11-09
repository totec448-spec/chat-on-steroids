# Agents & automation corner

Base: `4e51a04`, branch `fix/settings-corner`. One CSS rule.

## Finding

The rounded workspace corner is painted by the sidebar's pseudo-elements. Every settings page is
its own static panel, except Agents & automation, which is a view of the chat card
(`openChatView('settings')`). That card is `position: relative` for the chat's composer and
overlays, and positioned it painted over the corner, so only that page lost it.

## Change

While Settings is open the chat card is `position: static`, like every other settings page.
Settings already hides the composer, dock, timeline and the overlays that rely on the card's
positioning; the chat keeps it as before.

## Validation

- Electron captures of Home, Agents & automation and Appearance show the same corner.
- Layout tests: 47 passed. `verify-settings-layout.cjs` (six pages, two themes, two widths, two
  zooms) and `verify-composer-ui.cjs` (28 checks) passed.
- The full suite was not run locally; relying on CI.
