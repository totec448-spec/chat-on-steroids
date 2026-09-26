# Sidebar refresh alignment

The Chats refresh control retained its 26px circular hover target, but its 17px Phosphor glyph was painted through a 15px icon box. In the rendered Windows capture, the visible glyph center sat 1px right and 2.5px above the hover center.

The refresh icon now uses a matching 16px box and font size with a bounded optical correction on the generated glyph. The control semantics, hit target, and surrounding sidebar rhythm are unchanged.

Validation: 45 renderer-layout tests, typecheck, the Chromium panel-motion probe, and production build passed in both projects. The rendered hover center measured `(268.5, 456)` and the visible glyph center `(268, 457)`. `git diff --check` passed. No package or installation was made.
