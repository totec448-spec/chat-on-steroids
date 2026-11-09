# Workspace docks — local integration log

## Part 1 — `feat/ui-dock-shell`

- Added a single renderer owner for the right dock frame, tabs, launcher, `+` menu,
  expand/restore and two top-right panel toggles. Existing Files and Sub-agents
  keep their own data and security boundaries; the existing bottom terminal keeps
  its PTY owner and receives the grouped bottom toggle.
- Hidden Files retires its watches; the dock does not create a filesystem or
  terminal IPC path. The right dock starts empty and disabled launchers cannot
  open tools without their exact project/session scope.
- Checks: `npm run typecheck`, five focused Vitest files (82 assertions), and
  `npm run build` passed. Isolated Electron terminal acceptance reached the
  appearance-color assertion after validating shell creation and terminal reuse;
  the detached connection popover reported transparent instead of the expected
  black in that fixture, so full runtime acceptance is not claimed yet.

### PR preparation — remove obsolete chat-edge toggles

- Files and Agents no longer mount legacy toggle buttons inside the chat. The dock
  derives availability from the selected project/session and remains the only
  visible control owner. Escape returns focus to the right-dock control.
- Typecheck, the focused chat regression, 36 adjacent dock/File tests, and the
  production bundle build passed. The full renderer-timeline suite was stopped
  after a long silent run; its new regression passed in isolation.

## Part 2 — `feat/ui-dock-tools`

- Extended the single dock owner to a right tool frame and bottom terminal frame. Files
  and Sub-agents open on the right; the bottom frame owns only Terminal. Right terminal
  sessions appear in the dock's single tab strip, while the bottom has its own terminal
  tabs. Both keep live PTYs when their panel is hidden; closing a tab ends that PTY.
- Moved bottom height control to the dock frame. Ctrl+backtick toggles bottom Terminal;
  Ctrl+Shift+2/3/4 open right Terminal/Files/Sub-agents. Files drafts survive a hidden
  panel while its watches retire. A projectless terminal starts in the main-owned home
  directory without weakening exact project validation for selected projects.
- Checks: typecheck, focused renderer/terminal suites, production renderer build and
  isolated Electron terminal scenario. Electron exercised hidden-panel continuity,
  independent right and bottom PTYs, additional tabs, Ctrl+C, exit and sizing.
  The Electron fixture now compares the detached connection popover to the sidebar
  surface under a non-translucent test theme; the old assertion incorrectly equated
  sidebar and page background colors.

### PR preparation — terminal and Files ownership

- Corrected the dock controls and placement to the final right-tools/bottom-Terminal
  contract. Removed nested right terminal tabs, allowed projectless terminal creation
  through the existing fixed IPC, and kept Files actions horizontally scrollable with
  Refresh fixed at the edge. Dock tabs retain keyboard focus and hover as one capsule.
- Typecheck, 90 focused renderer/terminal tests, the real Electron PowerShell fixture,
  and the isolated Chromium workspace fixture passed. The latter checks Files drafts,
  PDF/editor views and responsive layouts; no provider or installed app was involved.

### CI follow-up — terminal test doubles

- Upstream PR #489 failed on Linux, Windows and macOS with the same
  `rightWorkspaceTerminal?.tabs is not a function` error. Three renderer suites
  still mocked the pre-dock terminal shape. Updated those test doubles to expose
  the terminal tab methods used by the dock; application code is unchanged.
- Typecheck and production build passed. The three focused suites passed 257 of
  258 tests together; one unrelated renderer-state test hit its 30-second limit
  under that combined run, then passed alone (51 other tests skipped). A full
  CI pass is not claimed until the upstream checks rerun.
- After the test-double fix, upstream Linux and macOS checks passed. Windows
  passed 6,097 tests but failed one unrelated `bridge.test.ts` unattributed
  recovery assertion; that exact case passed alone on Windows. The contributor
  account cannot rerun an upstream Actions job directly, so a documentation
  update triggers a fresh PR check without changing bridge behavior.

## Part 3 — `feat/ui-dock-review`

- Consolidated the read-only Git Changes adaptation and dock integration into
  one focused change, retaining the original PR/author and co-author credit.
  Review is a separate singleton view on the right alongside Files.
- Review shows current bounded Git changes and exact recorded `apply_patch` edit
  assets. It exposes no file-write toolbar or second file watcher. The Files
  toolbar's Changes action opens Review; historical edit buttons target Review
  and return to its list. No stage, commit, push, branch comparison or Ask agent.
- Checks on the feature branch: typecheck, 135 focused Git/renderer/IPC tests,
  the recorded-edit timeline case, and synthetic Electron Chromium inspection
  passed. The Electron fixture exercises the independent Review tab, working
  tree diff, return to Files, editor draft, PDF and responsive layouts. Final
  `dev` and package evidence are recorded separately below.
## Follow-up — dedicated bottom Terminal and working right actions

- Root cause of inert right shortcuts/`+` entries: Files, Review and Agents
  availability was inferred from their deliberately hidden legacy toggle
  buttons. The dock now uses the selected local project or chat identity.
- Removed the bottom generic launcher, tool tabs and `+` menu. Its control
  toggles the Terminal directly; right-side Terminal actions create a new
  bottom terminal tab. The top-right controls are ordered bottom, right,
  expansion, with expansion visible only while the right dock is open.
- Checks: typecheck, focused dock/File/Timeline tests, isolated Electron
  workspace UI and real PowerShell PTY scenarios passed. Electron exercised
  right Review/Agents/Files shortcuts, the Review `+` entry, right Terminal
  shortcut and `+` entry, bottom hide/reopen continuity and terminal tab close.
  `npm run verify` again passed privacy, notices and typecheck but reported the
  same two Windows UI Automation failures and PowerShell parser-recovery
  assertion; the broad run was stopped after those known failures. No
  full-suite pass is claimed. This follow-up was not packaged or installed.

## Follow-up — terminal in both docks and tab-adjacent actions

- Supersedes the previous bottom-only Terminal placement. Right Terminal opens a
  right tool tab with its own PTYs; bottom Terminal keeps separate PTYs and opens
  directly when its panel is shown. Bottom `+` creates another bottom tab, while
  right `+` opens Terminal on the right. Closing the last bottom tab also hides
  the bottom panel; toggling a panel still preserves any surviving processes.
- Moved each `+` immediately after its tab strip instead of stretching the strip
  across the header. Raised the terminal bar above its body so the bottom `+`
  popover is clickable. Removed the redundant right-dock close button and put
  the Codex-style expand/restore icon first in the top control group.
- Checks on the feature branch: typecheck, five dock tests, 42 Files tests,
  the exact recorded-edit timeline case and production build passed. The full
  timeline file was stopped after prolonged high memory use without a result.
  Isolated Electron workspace inspection and real PowerShell PTY acceptance passed,
  including visible bottom menu, independent right/bottom shells, hidden-panel
  continuity and last-tab close. One PTY fixture run returned exit code 1 after
  all assertions; the immediate repeat completed with exit code 0. Final `dev`
  merge, broader verification and package evidence are recorded separately.

## Follow-up — clickable right menu and terminal-first bottom panel

- Reproduced the right `+` failure with an actual Electron pointer click: its
  visible Terminal menu item hit the underlying Terminal tab because that tool's
  header had a higher stacking order. Raised the right tab bar above the tool
  header; the same pointer action now activates the menu item.
- With no right tabs, hide the tab bar/`+` and leave the launcher shortcuts.
  Bottom opening always shows the Terminal view, starts its shell when a selected
  project is available (including if the project arrives after opening), and has
  a right-aligned X that hides the panel without ending its process. The last
  terminal tab's X still closes the shell and the bottom panel.
- Feature-branch checks: dock/File Vitest 47/47, typecheck, build, isolated
  Electron PowerShell PTY and full workspace renderer fixture passed. The Electron test
  physically clicks right and bottom menus and the bottom X; it also exercises
  delayed project selection and no-tab right layout. `npm run verify` passed
  privacy, notices and typecheck but again reported the known Windows browser
  UIA, Windows accessibility and MCP parser-recovery failures; the broad test
  run was stopped after those failures, so no full-suite pass is claimed.
  A packaged/install test was not run for this follow-up.

## Follow-up — remove obsolete chat-edge panel buttons

- The dock migration still appended legacy Files, Agents and Review toggle buttons
  directly to the chat panel. Project/session updates could unhide them, leaving
  clickable controls below the composer. The dock header and tabs now remain the
  only mounted controls; standalone panel tests can still supply their toggle.
- Added a renderer regression for the stray controls and preserved the dock
  toggles. On the feature branch, that regression, 51 adjacent panel tests and
  TypeScript typecheck passed. Package and installed-app behavior were not
  checked at this point.

## Follow-up — compact dock headers and horizontal controls

- Removed Review's refresh-only toolbar and placed Refresh in its existing
  Changes/Diff header. Files actions remain in one horizontally scrollable row,
  while Files actions and dock tabs hide their scrollbars without clipping the
  controls. Removed the extra text grid item from the accessible Chats refresh
  icon so it centers vertically in its sidebar heading.
- Feature-branch checks: 89 focused renderer tests, TypeScript typecheck, and
  the isolated Chromium workspace fixture passed. The fixture checked the
  Review header, Chats refresh alignment, and actual horizontal Files toolbar
  scrolling at 820px with hidden scrollbars. No installed-app result is claimed.

## Follow-up — fixed Review refresh and unified tab hover

- Split the Review header into a locally scrollable title/back area and a fixed
  right refresh control. Long localized labels no longer move the refresh action.
- Moved dock-tab hover feedback to the whole tab capsule, suppressing separate
  button hover fills while retaining independent keyboard focus outlines and
  actions for selecting and closing a tab.
- Feature-branch checks: 89 focused renderer tests, TypeScript typecheck,
  production bundle build, and the isolated Electron workspace fixture passed.
  `npm run verify` passed privacy, notices and typecheck, then again reported
  the known Windows browser UIA and accessibility failures; the broad run was
  stopped after those failures, so no full-suite pass is claimed. No package or
  installed-app check is claimed.

## Follow-up — fixed Files refresh

- Split Files' one-row toolbar into a horizontally scrollable action group and
  a fixed refresh button at the right edge. The existing icon, label, action
  and keyboard order are unchanged; only the action group scrolls.
- Feature-branch checks: 89 focused renderer tests, TypeScript typecheck and
  the Electron workspace fixture passed. The fixture confirmed at 820px that
  the actions scroll while Refresh stays anchored. `npm run verify` passed
  privacy, notices and typecheck, then reproduced the known Windows browser
  UIA and accessibility failures; the broad run was stopped, so no full-suite
  pass is claimed. Package and installed-app checks are recorded separately.

## Follow-up — restore the Review back glyph

- The Review navigation and previous-edited-file controls referenced `#i-back`,
  but the renderer sprite did not define it. Their empty 14px icon slot and
  existing gap appeared as unexplained space before the Changes label. Added
  the missing left-arrow glyph without changing button semantics or sizing.
- Feature-branch checks: 84 focused renderer tests, TypeScript typecheck and
  the Electron workspace fixture passed; its diff screenshot visibly shows the
  arrow. `npm run verify` passed privacy, notices and typecheck, then reproduced
  the known Windows browser UIA and accessibility failures; the broad run was
  stopped after those failures. No installed-app result is claimed.

## Follow-up — localize terminal exit status before PR

- The docked terminal branch still rendered hard-coded English exit text in its
  tab and process output. Use the renderer's existing translation keys for both,
  preserving the dock tab-change notification and the current terminal lifecycle.
- Feature-branch checks: TypeScript typecheck and 58 focused renderer/terminal
  tests passed. Package and installed-app behavior are checked separately.

## PR history consolidation

- Replaced the review branch's experimental merge chain with one review-only
  commit on `feat/ui-dock-tools`. The resulting application, test and packaging
  files match the previous review tip; only this worklog describes the new history.
  The Git Changes adaptation retains its original PR/author and co-author credit.
- TypeScript typecheck, 103 focused Git/dock/File/terminal/preload tests,
  public-history privacy and third-party notices checks passed. The prior full
  `npm run verify` on the identical application tree had two Windows UIA failures
  and one MCP PowerShell parser assertion failure; no full-suite pass is claimed.

## Follow-up — read-only branch comparison in Review

- Review now displays the checked-out branch and offers a searchable local/ref-tracking
  branch selector alongside the existing Working tree choice. The selector does not run
  fetch, checkout, stage or any write operation. Remote-tracking names describe locally
  cached refs, not current network state.
- The main Git owner validates selections against its bounded ref catalog, then compares
  merge-base to current HEAD within the selected Local Project. Its bounded status, line
  counts and file blobs use the same commits; a diff request checks the snapshot revision.
  Working tree edits and untracked files remain in their original separate mode.
- The single Review header retains its fixed Refresh control and the branch menu opens
  above dock content. Search, keyboard navigation, empty results, comparison reset and
  project-change retirement are covered by renderer tests. Git tests cover local edits,
  divergent history, subtree scope and stale comparison revisions.
- Feature-branch validation: 164 focused Git/renderer/IPC/locale tests passed, TypeScript
  typecheck passed, the production bundle built, and the isolated Electron workspace
  fixture passed with captured branch-search and branch-comparison screens. `npm run verify`
  passed privacy, notices and typecheck, then reproduced the previously known two Windows
  UIA/accessibility failures and the MCP parser-recovery assertion; the long broad suite
  was stopped after those failures, so no full-suite pass is claimed. No installed-app
  behavior is claimed.

## Integration with upstream 2.1.16

- Rebased the shell, tools and Review branches in order on upstream `main` at `62fccc4`.
  Kept upstream's newer renderer behavior and tests, the terminal tab-exit notification,
  and the read-only Review attribution while resolving the overlapping changes.
- European Portuguese arrived in upstream after these branches diverged. Added only each
  branch's own UI labels to that locale: nine shell labels, two bottom-panel labels and
  the Review/Git labels in the Review branch. The preload IPC test and isolated Electron
  fixture now model the newer IPC/config contracts without changing production authority.
- On the final Review branch, 277 focused Git/dock/File/terminal/IPC/locale tests,
  TypeScript typecheck and the isolated Electron workspace fixture passed. The shell
  branch's 196 timeline tests and the tools branch's 87 focused tests also passed.
  Privacy, notices and the production bundle passed. The broad `npm run verify` again
  reported two Windows UIA/accessibility failures and the MCP parser-recovery assertion;
  the already-failing long run was stopped, so no full-suite pass is claimed. Source,
  bundle, package and installed-app evidence remain separate.
