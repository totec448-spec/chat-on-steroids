# Desktop Pets — implementation and acceptance

Desktop Pets run in a transparent always-on-top Electron overlay, independently
from the main CoS window. The overlay keeps each character as one 160×160 CSS
surface backed by its native-size spritesheet; it does not use a canvas or scale
the full atlas into a preview.

## Package contract

Imported packages contain `pet.json`, `atlas.png`, and `animations.json`.
The atlas is a transparent 1280×1920 PNG arranged as 8 columns × 12 rows of
160×160 cells. All 96 frame slots and the declared animation ranges are required.
Frames 69–84 carry validated hand anchors for grab/carry/throw choreography.

`src/main/pet-library.ts` validates and installs packages, and owns enabled and
favorite membership. `src/renderer/pet-machine.ts` uses the imported manifest as
the timing and frame authority; imported pets never inherit Tur Tur's timings.

## Runtime behavior

- Multiple enabled pets remain visible when the main window is hidden or minimized.
- A click pokes a pet and restores/focuses CoS without changing the current screen.
  Dragging moves the pet without raising CoS and persists its overlay position.
- Context actions retain OpenAI → ClosedAI and Anthropic → trash choreography.
  Hide pet temporarily dismisses only the selected pet; its library Active state
  remains unchanged. Turning View > Desktop pets on restores all active pets.
- The favorite enabled pet anchors the compact task badge and bounded task tray.
  Task transitions trigger spawn/look/angry/celebrate without replacing ordinary
  idle, walk, poke, drag, carry, throw, and autonomous behavior.
- The overlay uses one scheduler for every active pet. Authored frames and
  autonomous decisions use a timer; only travel and interpolated props request
  display frames. Hidden and reduced-motion static states have no running RAF.
- Main owns library membership and task/activity snapshots. The overlay renderer
  owns only visual position, animation, pointer interaction, and presentation.
- macOS forwards ignored mouse movement to drive renderer proximity. Windows and
  Linux use one bounded native cursor poll; Windows must not forward ignored mouse
  movement because two Chromium cursor owners visibly flicker over the main app.
  Pet position uses compositor transforms and props do not allocate another
  desktop-sized layout box.

## Evidence

- Unit and renderer coverage: `test/pet.test.ts`,
  `test/pet-overlay-renderer.test.ts`, `test/pet-controller.test.ts`,
  `test/pet-library.test.ts`, `test/pets-renderer.test.ts`, and
  `test/pet-activity.test.ts`.
- `scripts/verify-pet-overlay-electron.cjs` exercises the built main, preload, and
  renderer with isolated userData. It checks native 160×160 mapping, visible alpha
  bounds, task UI, pointer drag, owner restoration, independent overlay visibility,
  and restart position persistence.
- `scripts/verify-pet-performance.cjs <label> --full-host --check` builds the
  production overlay renderer in an isolated Electron fixture and adds the real
  desktop-sized transparent host plus an underlying owner window. It records
  process CPU, pointer samples, renderer work, and actual animation callbacks.
  Its checks require no macOS polling loop, the bounded Windows polling rate with
  unchanged-pointer IPC suppression, low idle wake frequency, and
  zero RAF activity for hidden and reduced-motion static states.

Source tests and isolated Electron runs do not establish packaged or installed-app
behavior. Packaging, installer, click-through over unrelated desktop applications,
and real session/swarm task projection remain separate acceptance gates.
