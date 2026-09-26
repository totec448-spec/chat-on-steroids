# Composer height motion — 2026-09-19

## Intent

Make the message composer expand and contract continuously as text, Skill pills or attachments
change its native layout, without replacing Chromium's `field-sizing: content` ownership.

## Change

- Added a composer-local height transition that observes the resulting border-box size.
- The transition animates only between the prior and next native heights, then releases height
  back to CSS; it never persists `scrollHeight` or another draft/layout authority.
- Grid rows stay bottom-anchored during that temporary height bridge, so removing content cannot
  stretch the empty row space or make the toolbar controls jump.
- Hidden views reset the baseline, rapid changes converge to the latest native size, and
  `prefers-reduced-motion` keeps resizing immediate.
- Added focused regressions for ordinary growth, interrupted growth, hidden views and reduced
  motion.

## Validation

- 4 focused composer-motion regressions passed.
- 62 composer/layout/Skills renderer tests passed in each repository.
- Typecheck and production build passed in each repository.
- Existing real-Electron composer layout and context fixtures passed at 1000/640/430 px.
- Live Internal Chromium CDP sampling observed intermediate monotonic heights for text growth,
  text removal and a wrapped seven-pill row; each settled at its native target after 220 ms.
- Manual Internal Chromium smoke confirmed that repeated deletion no longer makes the options,
  model or send controls jump while the composer contracts.

## Dock seam follow-up — 2026-09-20

- Plan, Goal, Compact and recovery rows retain their existing 38–40px content height in both
  empty and populated conversations.
- The dock and composer now share only a one-pixel border seam. The previous 15px overlap let
  the later composer paint over the dock's lower content when the normal conversation grid was
  active, making otherwise correctly sized rows look compressed.
