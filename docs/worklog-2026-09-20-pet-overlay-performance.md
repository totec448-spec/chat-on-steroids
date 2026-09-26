# Desktop Pets overlay performance — 2026-09-20

## Root cause

The deadline scheduler from `d398318` was still working: hidden and reduced-motion
pets had no animation frame loop. The remaining host cost came from a separate
boundary. On Windows, main sampled the native cursor every 50 ms even though
Electron can forward mouse movement through an ignored transparent window. A
stationary cursor still produced four IPC messages per second. Each message made
the renderer read pet geometry. During movement, pet position changed `left/top`,
and every pet also owned a transparent props element covering the entire desktop.

The former performance fixture loaded only the renderer in an 1100×850 window, so
it could not measure the native poll, fullscreen transparent host, always-on-top
composition, IPC, or an underlying owner window.

A later live Windows reproduction exposed a second host boundary: proximity changed
the entire desktop-sized transparent `BrowserWindow` from ignored/non-focusable to
interactive/focusable. Windows then treated that rectangle as an occluding window.
The main renderer, elapsed-time indicator and video surfaces behind the pet could
pause or disappear even though the overlay pixels remained transparent.

## Repair

- macOS uses Electron's forwarded mouse-move path. Windows and Linux use the bounded native
  cursor poll; unchanged positions do not publish IPC.
- The overlay remains non-focusable during hover and drag. Before native hit-testing
  is enabled on Windows/Linux, main applies a validated window shape containing only
  the pets, visible props, task tray and context menu. The platform proximity owner also detects
  leaving that shaped region and restores click-through.
- The renderer calculates ordinary pet proximity from `PetMachine.position`
  instead of forcing a layout read. Tray and menu geometry are read only while
  those surfaces are open.
- Pet travel uses `translate3d`; each 160×160 pet is layout-contained without
  paint clipping. Prop roots are zero-sized coordinate origins instead of
  fullscreen transparent layout boxes.
- Main suppresses unchanged overlay snapshots and control-state IPC. With no
  active pet it clears task expiry work and does not recompute activity snapshots.
- The performance verifier gained `--full-host`, primary-work-area sizing,
  always-on-top/click-through behavior, an underlying owner renderer, pointer
  rates, and per-renderer process labels.

No atlas, authored frame duration, autonomous decision, task reaction, drag,
click, context-menu, visibility, favorite, imported-pet, or library contract was
changed.

## Cursor-region follow-up — 2026-09-21

Physical Windows sampling reproduced 553 `hand`↔`arrow` changes during 856 real mouse moves while
`WindowFromPoint` remained owned by the CoS window. Electron's `forward: true` sent each ignored
overlay move to a second Chromium renderer, so the overlay's `cursor: grab` raced the underlying
control's cursor. Synthetic movement did not reproduce that native route. Windows no longer uses
ignored-mouse forwarding; its existing 50 ms native cursor sample is now the sole proximity owner
until the bounded overlay becomes interactive. Click-through still precedes restoration of the
full visual shape, so the fullscreen rectangle never becomes an interactive occluder. macOS keeps
forwarding and Linux keeps polling. The Electron smoke rejects any forwarded ignored-mouse call on
Windows. Physical post-fix cursor behavior still needs user confirmation from the rebuilt package.

## Task indicator follow-up — 2026-09-21

Three projection errors explained why the badge could disappear at completion or remain non-green:

- Prime used the broker's long-lived `active` lifecycle instead of its canonical session result.
- Review expiry was anchored only to final assistant prose, so a completed tool-only turn had no
  green review interval.
- Sleeping workers outranked completed review in the aggregate badge color.

Prime now projects from its exact session while workers retain their AgentInfo lifecycle. A
worker left as the recorder's last session resolves the Prime through its durable
`origin.fromSessionId` after the family parks; an unlinked worker grants no parent task. A
`turn_end: completed` anchors the same 45-second review interval even without final prose, and the
aggregate order is failed, running, review, waiting, idle. The existing one-shot expiry timer owns
removal after the review interval; no additional watcher or mirrored task state was introduced.
The review badge now uses the semantic green surface, text and border tokens; the previous CSS
changed only its border, so the numbered circle still appeared neutral despite the correct state.

## Measured evidence

Both runs used Electron 44.3.0 on the same Windows machine with 12 logical
processors. CPU is total measured app-process CPU time normalized across those
processors. It is fixture evidence, not installed-payload or whole-system proof.

| Phase | Before CPU | After CPU | Before layouts/s | After layouts/s |
| --- | ---: | ---: | ---: | ---: |
| Idle | 0.393% | 0.232% | 0 | 0 |
| Autonomous | 0.664% | 0.564% | 4.88 | 0 |
| OpenAI action | 1.052% | 0.894% | 7.63 | 1.18 |
| Anthropic action | 2.004% | 1.833% | 15.53 | 0.23 |
| Static reduced motion | 0.240% | 0.028% | 0 | 0 |

The final Windows run recorded zero cursor samples/messages per second after the
one initial seed. Static visible cost matched the hidden sample within measurement
noise (0.028% versus 0.029%). The underlying owner renderer used effectively zero
CPU during sustained pet actions in this fixture.

## Validation

- Five focused Pet suites passed: 15/15 tests.
- Typecheck and production build passed.
- The earlier `optimized-full-host` run passed its then-current forwarded-pointer and
  zero-static-RAF assertions. The Windows polling budget must be rerun after visual approval.
- The built Electron overlay smoke passed. It measured a native 160×160 body and
  visible atlas pixels, exercised proximity and click-through state,
  verified the overlay stayed non-focusable and an owner timer kept advancing during hover,
  dragged and persisted the pet, opened the task tray and context menu, temporarily
  hid/restored the active pet, minimized the owner, and restored the same owner
  screen on click.
- The Impeccable diff detector completed without findings.

Packaging, installer behavior, unrelated desktop applications, and a long-running
real provider task remain separate evidence levels.
