# Arabic (ar) / RTL — paired visual and language review

**For:** [Chat On Steroids PR #2156](https://github.com/totec448-spec/chat-on-steroids/pull/2156). Screenshots use the actual Electron production renderer or the standalone packaged Windows preview, **not a recreated design**. All app states are synthetic or a dedicated QA workspace; none use the owner's real accounts, chats, credentials, or data. The official installed COS application was not altered.

## English / Arabic side-by-side evidence

Every pair uses the same data, surface, theme and screenshot dimensions. On the left is English LTR; on the right Arabic RTL. English user-authored chat/project/file names intentionally remain unchanged in Arabic.

| Surface | Normal-width proof | Narrow-width proof |
| --- | --- | --- |
| Chat timeline / composer | [Dark, 1440](paired-proof/chat-dark-1440-en-ar.jpg) | [Light, 820](paired-proof/chat-light-820-en-ar.jpg) |
| Settings / layout | [Dark, 1440](paired-proof/settings-dark-1440-en-ar.jpg) | [Light, 820](paired-proof/settings-light-820-en-ar.jpg) |
| Composer / model menu | [Dark, 1440](paired-proof/menu-dark-1440-en-ar.jpg) | [Light, 820](paired-proof/menu-light-820-en-ar.jpg) |
| Chat Search dialog | [Dark, 1440](paired-proof/dialog-dark-1440-en-ar.jpg) | [Light, 820](paired-proof/dialog-light-820-en-ar.jpg) |
| Right dock / worker agents | [Dark, 1440](paired-proof/right-dock-dark-1440-en-ar.jpg) | [Dark, 820](paired-proof/right-dock-dark-820-en-ar.jpg) |
| Files tree / preview / toolbar | [Dark, 1100](paired-proof/files-dark-1100-en-ar.jpg) | [Dark, 820](paired-proof/files-dark-820-en-ar.jpg) |
| Extension popup | [Dark, 410](paired-proof/extension-dark-410-en-ar.jpg) and [Light, 410](paired-proof/extension-light-410-en-ar.jpg) | [Dark, 370](paired-proof/extension-dark-370-en-ar.jpg) and [Light, 370](paired-proof/extension-light-370-en-ar.jpg) |
| High-contrast representative | [General, dark 1280](paired-proof/contrast-general-dark-1280-en-ar.jpg) and [light 1280](paired-proof/contrast-general-light-1280-en-ar.jpg) | [Chat, dark 760](paired-proof/contrast-chat-dark-760-en-ar.jpg) and [light 760](paired-proof/contrast-chat-light-760-en-ar.jpg) |
| **Real Windows PowerShell terminal** | [Same isolated desktop preview, English and Arabic](paired-proof/terminal-live-en-ar.jpg) | Full window view from the same live shell session; no real shell project data |

Terminal evidence was created by opening an actual isolated COS project terminal in a separate preview application, executing **only** `Write-Output` with harmless test strings and setting the temporary PowerShell prompt to `QA>`. Then the app's language was switched Arabic → English while the **same PTY session stayed open**. The LTR command output and fake `C:\demo\file.txt` pathname are visible in both. [Original English screenshot](paired-proof/terminal-real-en.png) · [Original Arabic screenshot](paired-proof/terminal-real-ar.png).

## Test-backed scope

- **Primary desktop:** 11 sections × 3 viewport widths (1280/900/760) × dark/light = **66 real synthetic renderer screenshots**. Also tested the five primary pages at 125%/150% zoom, menu inward opening, and LTR code/draft content.
- **Paired comparisons:** 10 core app cases, 4 popup cases, 4 high-contrast fixture cases, 2 Files cases, and 1 real PowerShell terminal case, with full-window source shots available in the local QA output.
- **Extension:** `verify-arabic-extension-ui.cjs` sets Chromium native theme in the isolated test process, asserts RTL/LTR and popup width, checks IDs remain LTR-isolated, and captures EN/AR at 410 and 370px in light/dark. A 340px popup is **below** the fixed 348px CSS layout width and is not claimed as supported.
- **Files:** `verify-pr-workspace.cjs` uses a synthetic real project tree, genuine renderer/editor UI, loaded icon fonts and runtime assertions on visible panel geometry. English and Arabic comparisons at 1100 and 820px.
- **High contrast:** screenshots demonstrate the RTL geometry under the high-contrast fixture flag; existing `verify-appearance` remains the separate source of truth for color/contrast calculations. These images alone are not a substitute for WCAG color-ratio verification.
- **Keyboard/focus:** `test/renderer-i18n.test.ts` verifies focused draft, selection and node identity survive language switches; `test/sidebar-resize.test.ts` covers mirrored mouse/arrow resize; `test/renderer-timeline.part2.test.ts` and `test/renderer-row-menu-place.test.ts` cover keyboard submenu direction, focus restoration and screen-edge placement. A full live **Tab order** walkthrough with assistive technology is still a requested follow-up; no such walkthrough is claimed.

## Arabic editorial QA and limitations

App translation includes 3,913 base strings plus 420 Arabic plural forms; extension has 494 entries. Sensitive strings covering trust/release permissions, destructive actions, restoration/Trash, setup, scheduling, agent roles and mixed-direction technical identifiers received a technical/editorial review. Automated placeholder and catalog checks passed. Arabic plural groups were reviewed and number-heavy phrases were corrected to avoid ungrammatical 3–10/11–99 and other cases. Recent regression fixes cover `100`, `101`, and `102` events in the extension.

**Independent human native-speaker approval is still missing.** AI/agent-assisted editorial checks and the product owner's partial visual review are not an independent qualified Arabic review. The checklist below is ready for a human reviewer, who should sign off (or request revisions) before the maintainer merges.

### Human reviewer sign-off form — currently **PENDING**

- Reviewer name/handle and Arabic proficiency: **[awaiting reviewer]**
- Date and reviewed commit SHA: **[awaiting reviewer]**
- Verified all permissions/consent/destructive/recovery labels: **[pending]**
- Verified Arabic plural grammar and keyboard/accessibility copy: **[pending]**
- Verified visual pairs, punctuation, technical LTR islands and narrow layouts: **[pending]**
- Result PASS or specific requested changes, with exact key/file: **[pending]**

## CI / platform limitations and request for maintainers

The fork PR's **CI**, **PR checklist** and **CodeQL** runs have status `action_required`: **a maintainer must approve workflow execution for the external fork**. [CI](https://github.com/totec448-spec/chat-on-steroids/actions/runs/43251267517) · [PR checklist](https://github.com/totec448-spec/chat-on-steroids/actions/runs/43251267216) · [CodeQL](https://github.com/totec448-spec/chat-on-steroids/actions/runs/43251267270). Neither Draft nor local tests can grant that approval.

Locally on Windows, focused localization/RTL TypeScript, tests and isolated UI checks passed. The full parallel `npm run verify:ci` run before the last fixes reported **12,084 passed, 13 failed, 179 skipped**. One failure was an extension plural assertion that was updated and subsequently passed in focused verification; other heavy-shell/renderer timeout failures need a fresh reliable CI run. Do **not** treat this as a full green monorepo CI.

Once the fork workflows are approved, the maintainer's CI covers Windows, macOS and Linux test runners. A cross-platform native packaging/release-candidate run is not part of the fork PR and would need a maintainer-run non-publishing release-candidate workflow. Live macOS/Linux UI, NVDA Arabic screen reader, and the independent human language review remain external sign-off steps.

**Ready for maintainer review of the implementation and evidence; not a claim that the merge checks have already passed.**
