# One Phosphor icon system, drawn from the font — 2026-09-27

## Evidence and decision

#535 moved the interface to Phosphor Regular by copying each glyph's path into the inline
SVG sprite. The maintainer's fork draws the same family from the bundled Phosphor font and
reads clearer at the same place. Enlarged side-by-side captures of both builds showed the
difference is optical size, not rasterisation: Phosphor leaves wide padding inside each
glyph, and the sprite shrank the drawing with every compact box (14–15px in the sidebar and
top bar), while the font kept it at 17px.

The captures also showed that the sprite was not the only icon system. The sidebar toggle,
both select carets, the Add plugin mark, Reload models, the attachment tile and the Send
arrow were separate hand-drawn SVGs with their own stroke weights.

## Narrow implementation

- `@phosphor-icons/web` 2.1.2 is a dev dependency. Vite bundles only the regular and fill
  WOFF2 files that `renderer/icons.css` references, so the package never ships inside the
  app. The existing Phosphor license entry from #535 still covers the notices.
- `icons.css` maps only the 47 regular and 1 filled glyphs the renderer draws. The
  codepoints are copied from the package's own `style.css`.
- Call sites keep naming icons by meaning (`i-*`). `dom.ts` `ICONS` is the single map to
  glyphs, and `setIcon()` replaces the old `<use href>` swap for the dock expand toggle.
- `--ico` is the layout box and `--glyph` the drawing (17px by default). Disclosure carets,
  small dismiss marks and places that already chose an optical size set both.
- Entries without an earlier font mapping: the right and bottom dock toggles turn the
  sidebar glyph toward the edge they open; dock expand/restore use corners-out/corners-in;
  Sub-agents and Agents & automation use robot; Usage uses chart-line; warnings use warning;
  the favourite uses the filled star. Plugins now uses puzzle-piece instead of plus, and the
  chat and file Refresh buttons use arrow-clockwise instead of the activity pulse.
- The hand-drawn SVG icons above are replaced. The sprite keeps only the product mark.
  Language flags, the context ring and the setup-guide connector are not icons and stay SVG.
- The activity group copied its latest tool icon with `querySelector('svg')`. It now copies
  `.ico`, so grouped activity keeps its symbol.

## Regression evidence

`test/icon-font.test.ts` replaces the sprite test. It checks that:

- every renderer `i-*` name resolves in `ICONS`;
- `icons.css` maps exactly the drawn glyphs;
- each codepoint equals the package's; a deliberately altered codepoint failed the test;
- no hand-drawn SVG icon remains in the markup or renderer code;
- the sprite holds only the product mark.

Renderer tests that read `<use href>` now assert the glyph class.

Checks run: `npm run typecheck`; Vitest `icon-font`, `renderer-workspace-docks`,
`pet-controller`, `renderer-file-panel`, `renderer-layout`, `renderer-timeline`,
`pets-renderer` and `renderer-state` (362 passed). `npm run verify:notices` passed.
A Windows x64 installer was built. It packages exactly the two Phosphor WOFF2 files, and the
maintainer inspected it installed. The full suite is left to CI.

## Credit

Builds on Maximapple's #535, which chose Phosphor and added its license. The font approach
follows the maintainer's fork (Haz4rdovisk/chat-on-steroids-mainstream).
