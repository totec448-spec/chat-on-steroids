# Composer toolbar type and alignment

Base: `4e51a04`, branch `fix/composer-toolbar-type`. Renderer CSS only.

## Findings

- The context meter value used the old token chip's `10px var(--mono)` and its button fell back
  to the browser's Arial (13.33px), so "38%" sat smaller and in another face beside the 12px
  Mode, Plan and Model labels.
- The attachments `+` was the toolbar's only 20px glyph (the other icons are 17px). Geometry was
  centred everywhere, but at fractional scales the glyph baseline rounds per font size. A user
  screenshot at 75% zoom on a 125% display measured the `+` ink centre at 25.5 device px against
  24.5 for the labels and 23.5–24.0 for the other icons.

## Change

- `#contextMeterButton` inherits the toolbar font; `#contextMeterCompact` uses 12px with
  `tabular-nums`, so the value keeps the row's face without shifting as it changes.
- The `+` is drawn at 17px like its neighbours and scaled about its centre to 20px, so it rounds
  on the same line and keeps its size.

## Validation

- Context meter, layout and icon font tests: 55 passed. `verify-composer-ui.cjs`: 28 checks,
  including toolbar fit at 1440 and 900px.
- Ink measured in Electron at 80–100% zoom; the fractional-scale case was confirmed by the user
  at 75% zoom on a 125% display. The harness capture is downscaled and cannot show that rounding.
