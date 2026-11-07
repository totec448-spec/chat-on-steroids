# Proposal: standalone task activity badge

This draft is intentionally proposal-only so the behavior can be agreed before implementation, per CONTRIBUTING.md. The file should be removed/replaced by the actual implementation before the PR is marked ready.

## Problem

The desktop task activity count/tray is currently useful only through an enabled pet. The badge is created inside a `.pet-shell`, and the tray is positioned from that pet's `PetMachine` position. Users who want the task overview but not an animated desktop character cannot keep the task count visible without also running the pet's autonomous movement and interaction surface.

An all-transparent pet is not a good substitute: the `PetMachine` still walks/reacts and the 160x160 pet shell still participates in interaction even though the sprite is invisible.

## Proposed behavior

Add an optional standalone task activity badge that reuses the existing `PetOverlaySnapshot.activities`, task cards, activity-opening behavior, and status styling without creating a pet or `PetMachine`.

- Default position: top-right of the usable desktop area.
- The badge can be dragged anywhere on screen and remembers its position.
- It stays visible at zero activities and shows `0`, `1`...`9+`.
- Clicking it opens/closes the existing Tasks tray; task rows behave exactly as they do today.
- It has no sprite, animation states, autonomous walking, comedy actions, invisible 160x160 pet hitbox, or pet context menu.
- Existing pets keep their current behavior when standalone mode is off.
- When standalone mode is on, it becomes the single task-count anchor so a pet does not show a duplicate activity badge.
- No provider traffic or task semantics change; this is only a different desktop projection of the existing activity snapshot.

## Intended implementation shape

Keep one owner for task activity. Reuse the current renderer tray/card path rather than creating a second task UI or polling path. The standalone badge should have its own small hit region and persisted UI position, while pet movement/state remains owned only by `PetMachine`.

The current seams appear to be `src/renderer/pet-overlay.ts` (`renderBadges`, `renderCards`, `setTray`, `placeTray`) and `src/renderer/pet-overlay.css`. The exact settings surface/persistence key can be chosen after behavior agreement.
