# Astra Goal and Loop delivery

## Requested behavior

GPT-6 Pro/Astra must support ordinary Goal completion decisions as well as Loop. With
the finish tool enabled, both modes offer Only finish or After this turn + finish.
With it disabled, both use verified turn completion and the timing selector is hidden.
The saved preference survives so enabling finish again restores the user's choice.

## Changes

`session/finish.ts` previously forced every decision to Loop. It now captures the selected
mode and objective, uses that mode's existing backend/model/prompt, and releases the exact
finish hold when Goal returns no further work. It does not fabricate a native final or
enqueue an empty continuation. Provider errors still remain errors, not completion.

Mode/objective changes revoke in-flight decisions before publication. Generated finish
inputs retain their originating mode through the existing durable outbox and restore
schema. A pending instruction for the other mode cannot be delivered; legacy unlabelled
finish instructions retain their historical Loop interpretation.

`goal.ts` derives effective after-turn delivery from the existing per-chat preference
and live finish setting. `shared/finish.ts` supplies common model/mode eligibility to
the renderer and bridge. The desktop delivery handler now preserves Goal instead of
silently setting Loop. The extension displays the current mode and invalidates its
existing menu repaint key when delivery availability/preference changes. The timing
label uses the existing Spanish, Simplified/Traditional Chinese and Japanese catalogs.

The existing reply ledger, recovery path, native send receipts, queue priority and
per-task checkpoint controls remain their owners. Failed/unfinished responses use
Continue recovery; verified finals use Goal/Loop. User inputs still precede automatic
decisions, and automatic Loop still requires its existing exact source-turn MCP proof.

## Validation

Regression tests reproduced the forced Loop decision, missing after-turn behavior,
mode-switch race and stale extension menu before their respective fixes. Tests cover
both modes, finish enabled/disabled, preference restoration, genuine Goal completion,
Goal/Loop/Goal while a decision is running, queued instruction cancellation and exact
user-queue priority on GPT-6 Pro and the ordinary model path.

Production build completed. `scripts/verify-dropdown-layout.cjs` passed in real Electron
for dark/light themes at 100%/150% zoom, native keyboard selection and translated
options. Its screenshot was inspected at `outputs/dropdown-layout/dark-1-loopDelivery.png`.

Full verification log: `outputs/astra-goal-2026-09-20-verify.log`.
The complete repository check is still running at this point; its final result will be
recorded below. No installed app or extension was replaced, and no provider conversation
was sent for this task. Other concurrent working-tree changes were preserved.
