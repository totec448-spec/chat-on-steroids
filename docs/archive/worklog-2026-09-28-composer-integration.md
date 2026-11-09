# Composer integration

Base: `d0d4c85` (upstream 2.1.20; started on `2738e8c`, 2.1.19), branch `feat/composer-polish`.

## Scope and ownership

Integrated the approved composer layout into the production renderer. The isolated
preview remains a frozen reference. No main-process, extension, transport, Internal
Chromium or Browser Use behavior was changed.

- Kept native send, Stop, planning, queue, skills, attachment and automation handlers.
  Plan is a toolbar toggle; Goal/Loop's dock row opens the original objective editor,
  including in a new chat. Mode-menu closing retains its contents through the exit.
- Moved the original Compact/Cancel controls into the context dialog. It switches
  toolbar percentage/token values, with estimates identified in the dialog and
  accessible description. Unavailable session controls remain hidden.
- Listed every observed model, including GPT-5.5, with a slider scoped to that
  model's observed efforts. Existing hidden selects and admission checks remain
  authoritative. Catalog refresh, unavailable selections, Pro identities and
  explicit current-model fallback retain their existing rules.
- Adapted the existing surface entrance and composer height motion. The dock's
  inner body supplies natural size; no fixed height persists after animation.
  Native plan completion owns its green effect and collapse. Surviving rows keep
  their geometry and opacity; removing the final occupant removes the entire edge.
- Kept the original SVG disclosure chevron on both menus. Opening a details menu
  exposes its content immediately so the objective editor can receive focus;
  the visibility transition applies only when closing.
- Aligned controls and retained separate rows for simultaneous files and skills.
  The welcome title keeps its resting position while the draft grows. Added the
  new interface strings to all nine translation catalogs.

## Validation

- Typecheck passed; production `npm run build` passed. No installer was generated.
- Focused motion, context, model, layout, icon and source-translation tests: 91 passed.
- Timeline suite: 203 passed initially; the remaining assertion expected the old
  visible `Create plan` label. Updated it to check `Plan` plus accessible `Create plan`;
  that exact case passed individually, including its cancellation/late-result checks.
- `scripts/verify-composer-ui.cjs`: 27 real Electron checks passed against production
  HTML/CSS/controllers with in-memory IPC. Covered model/effort and send arguments,
  Compact/Cancel, Goal editing, native Plan/queue/Stop, skills plus attachments,
  empty-dock retirement, the open right work panel and 1440/900px layouts.
- `scripts/verify-plan-collapse.cjs`: passed at 100% and 150% zoom. Green completion,
  zero sibling displacement, opacity 1 for surviving rows, empty height/border 0,
  and a new panel's subsequent entrance were checked.
- The focused Electron flow reported Chromium ResizeObserver delivery notifications
  during resizing. The same notification was independently reproduced in the frozen
  reference preview. The probe reports their count separately and still fails on
  other renderer console errors; it does not suppress production errors.
- `git diff --check` passed. Local full verify was stopped at the user's request;
  its process tree was terminated. Full CI belongs on GitHub. This is not a claim
  that the full suite is green.

These checks validate renderer integration and IPC calls, not live ChatGPT execution,
an installed package, or hosted CI. No commit, push or PR change was made in this block.

## Plan toggle follow-up

- Rebased the uncommitted work onto upstream 2.1.20 (`d1b1518`) without conflicts.
- The toolbar Plan button only arms plan mode, even when the composer already has text;
  Send/Enter generates from the draft. Clearing the draft keeps the mode armed; clearing
  during generation still cancels it. Timeline plan tests now arm, then submit, and a
  regression case covers the toggle. Focused plan tests (17) and the source i18n test passed.
- Queued plan stages and prepared stages wrap to three lines (full text stays in the
  tooltip); the finish queue scrolls past 300px like the stage preview. The Electron
  composer probe still passed all 27 checks.
- Plan now has the toolbar hover (its own rule outranked the shared one). Goal and Loop
  rows in the mode menu carry the shared pencil (`pencil-simple`): it selects that mode
  and opens the objective editor; the whole row carries hover/selection. The editor view
  is a compact form (label, bordered field, right-aligned Save). The Electron probe now
  checks the pencil path and captures the editor and the Goal menu (28 checks passed).
- The pencil no longer switches automation (that started Goal/Loop immediately). It
  opens the editor for that mode; Save applies objective and mode through the existing
  `setSessionObjective` / new-chat opening path. Reopening the menu or changing mode
  discards the pending edit mode. Covered by a timeline test and the Electron probe.
- Mode-menu pencils share the dock edit action's hover. Save closes the editor; progress
  and failures stay in the dock lifecycle row. Removed four catalog strings that no longer
  have a source (`Write a message in the composer first`, `Model and thinking effort`,
  `Choose a level`, `Chat options`).
