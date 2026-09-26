# Shell panel motion

The workspace shell now explains panel ownership through direction instead of snapping between layouts. Chats open from the left, Files and Sub-agents open from the right, and Terminal rises from the bottom. The app and chat canvases retain stable grid tracks so their content reflows during the transition; short surface motion reinforces the same direction without adding a motion dependency.

Panel state remains authoritative. `hidden`, `inert`, `aria-expanded` and terminal processes keep their existing owners. An outgoing Files, Sub-agents or Terminal surface is painted only during its bounded exit; switching between the mutually exclusive right panes is immediate at the old pane so they never overlap. Reduced-motion users get immediate transitions, while drag resize disables the grid transition.

Mainstream validation passed typecheck, 276 focused panel/sidebar/file/agent/terminal/layout tests, and `scripts/verify-panel-motion.cjs`, which measures intermediate Chromium grid geometry for all three directions and captures the combined shell in `outputs/panel-motion/` (ignored by git).
