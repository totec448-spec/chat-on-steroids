# French UI follow-up — 22 September 2026

PR #369 appeared after the initial 71-issue/19-PR inventory. Its exact head,
`504c6173de6c99208516a2ea1b1ae28e4d629ee6`, was reviewed, including the complete
French catalog and all seven changed files. The contribution predates the Turkish
integration in #370 and cannot be merged by replacing the current selectors.

The adaptation retains PourrezJ's 1,431 translations with one wording correction,
adds 21 newer catalog entries, and registers French alongside Turkish in the
existing language owner, Setup flags and Appearance selector. There is no new
locale framework, dependency, preference store or background process. The current
styles already wrap the seven flags at narrow widths.

The French regression suite checks current catalog coverage and argument preservation,
both selectors, reload persistence, authored drafts, focus and selection, literal
arguments, and unavailable preference storage. Existing language suites now include
French. The native Setup fixture checks French at normal, enlarged and narrow sizes,
plus real keyboard activation through Turkish and French before reload.

## Validation

The five focused language suites passed all 22 tests. On the isolated public tree,
`npm run verify` passed 5,820 tests plus 26 desktop/shutdown tests, with 47 existing
platform/opt-in skips. Privacy, dependency notices, pinned native sources and TypeScript
checks passed. `npm run build` passed. The real Electron Setup fixture passed all
90 layouts, native keyboard selection and reload persistence; narrow dark and
150%-zoom light French headers were also inspected visually. On the shared working
tree, all six language suites passed 28 tests. No production changes followed these
checks; only this validation record and the review disposition were updated.

## Credit and scope

Translation credit: [PourrezJ](https://github.com/PourrezJ), PR
[#369](https://github.com/totec448-spec/chat-on-steroids/pull/369).
The public adaptation is based on the #370 merge `93573d836b2b6feac02f6a5fc584995b10cb48ee`.
No installation, release or native macOS interaction is claimed.
