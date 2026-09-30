Live checks for **VERSION**, on the packaged build installed like a user would, not a dev run. Tick each box with a short note of what you saw; an unchecked box means "not tested yet", not "broken".

### Before tagging

- [ ] **Extension, fresh user:** in a browser profile without the extension's token, the extension pairs with the app by itself, and an installed older build updates itself to this one.
- [ ] **Connector:** a message in ChatGPT that calls a CoS tool (for example `exec_command`) runs and is attributed to the right chat.
- [ ] **Goal and Loop:** a small Goal from the app finishes and stops by itself; a Loop sends its next message.
- [ ] **Compact & resume:** the new chat opens in the same browser, continues, and shows no note from the old chat.
- [ ] **Sub-agents:** one worker starts, runs a command and reports back.
- [ ] **Every shipped list item:** install and remove every recommended skill, every catalog plugin and every pet, not only one example.
- [ ] **UI sweep:** every page and panel in every language, with no console errors and no `{0}` or `undefined` in the text; `npm run verify:ui` passes.
- [ ] **Changed controls:** each control this release changes, tried with real data (for example the model menu with an Instant, a Thinking and a Pro model). Does it make sense, not only work?
- [ ] **Release notes:** `docs/release-notes/VERSION.md` is written for users and thanks every contributor.

### After publishing

- [ ] **Published files:** the "Verify published release" run is green (checksums, extension build stamp and version).
- [ ] **Intel macOS:** if "Package macOS x64" failed on timing, rerun only that job.
