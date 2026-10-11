# Background chats in a tab group instead of a separate window

Status: design, approach approved in chat 2026-10-11. For review before the plan.
Roadmap: #128.

## Goal

Today the app puts the ChatGPT tabs it opens in the background (workers, recovered chats, model
catalog and plugin-refresh helpers, successor chats) into its own minimized browser window. Some
people dislike the extra window. This adds an opt-in mode that puts those tabs into a collapsed tab
group named "Chat On Steroids" in one of the user's own browser windows instead.

Success:
- With the mode on, every tab the app opens in the background lands in that group, inactive and
  collapsed.
- Sending, receiving, Goal, Loop, workers and Compact & Resume behave exactly as in window mode.
- The user's own tabs, windows and current selection are never changed by the app.
- Nothing is left behind in Chrome's saved tab groups in normal use.
- With the mode off (the default), behavior is byte-for-byte today's.

## Measured facts (VM 141, Chrome 154, 2026-10-11)

- `tabGroups` in an unpacked extension's manifest is granted silently on reload. It carries no
  install warning, so packed builds are unaffected too.
- Chrome 154 saves open tab groups automatically ("Your tab groups are now saved automatically").
  Closing the group's last tab with `chrome.tabs.remove` deletes the group *and* its saved entry.
- Send timing:
  - collapsed-group inactive tab: 12–13 s fresh, 25 s after 6 min idle;
  - minimized-window tab: 8 s fresh, 25 s after 6 min idle.
  - One 188 s outlier happened right after grouping, while a probe ran `executeScript` on that
    tab. It is to be reproduced during implementation (see Tests).

## Design

### 1. Setting

- New config value `ui.backgroundPlacement: 'window' | 'group'`, default `'window'`, saved the way
  `ui.backgroundChats` is: config schema, IPC pick and renderer apply.
- Settings → Browser, directly under "Background chats", there is a select "Background tabs open
  in" with two options: "Their own minimized window" / "A tab group in your browser window".
- Help text (the user's choice 1): "The group stays collapsed in the window you used last. Chrome
  saves open tab groups automatically; the app's group closes with its last chat, so it does not
  stay saved. If you close that window while app chats are open, Chrome may keep the group in its
  saved groups, where you can delete it. Browsers without tab groups use a window."
- The select applies to every tab the app opens in the background, including helper tabs that are
  background even when "Background chats" is off (the model catalog and successor chats). It is
  therefore always enabled.
- Texts are translated in all 12 catalogs.

### 2. Transport

- `/status` gets `backgroundPlacement` next to `background`.
- The extension keeps the last value in a module variable and in `chrome.storage.local`
  (`backgroundPlacement`). It restores the value on worker start, so a wake that arrives before the
  first status pass already uses the right mode.
- An extension older than the app ignores the field and keeps window mode.
- An app older than the extension sends no field, so the extension uses window mode.

### 3. Where the group lives ("first window, then stay")

The worker uses group mode only when all of these hold:
- the value is `'group'`;
- `chrome.tabGroups` and `chrome.tabs.group` exist;
- a target window exists.

Otherwise it uses window mode for that tab, unchanged. This covers the built-in browser, older
Chromium builds and incognito-only sessions.

**Target window**, when no live group exists:
- `chrome.windows.getLastFocused({ windowTypes: ['normal'] })`.
- The app's own background window (see `storedBackgroundWindow`) and incognito windows are never
  targets.
- If the last-focused window is excluded (Chrome on macOS can report the app's own window), the
  eligible window whose tab was used most recently, then the lowest id, among the normal, non-incognito windows that are not
  the background window is used. If there is none, window mode is used.
- A minimized target is fine: a collapsed group in a minimized window is still invisible.

**Creation:**
1. `chrome.tabs.create({ windowId, url, active: false })`.
2. `chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } })`.
3. `chrome.tabGroups.update(groupId, { title: 'Chat On Steroids', color: 'grey', collapsed: true })`.

The group then stays where it is. It does not follow later window focus. If the user drags it to
another window, the app uses the group's current `windowId`.

**Adding:** with a live group, the new tab is created inactive in the group's window, directly
after the group's last tab, and joined with `chrome.tabs.group({ groupId, tabIds })`. The group's
collapsed or expanded state is left as the user set it. Collapsing a group that holds the window's
active tab would switch the user's tab, so the app collapses only a group it has just created.

**Identity:**
- The group ID is stored in `chrome.storage.session` (`chatBackgroundGroup`) and mirrored to
  `chrome.storage.local`, because self-updates reload the worker and clear session storage. This
  matches the window mirror.
- A stored ID is valid only while `chrome.tabGroups.get(id)` resolves.
- A mirrored ID (after an extension reload) must also still carry the title "Chat On Steroids";
  otherwise the mirror is dropped.
- `onStartup` drops the mirror, as it does for the window, because group IDs are per browser
  session.

**Re-adoption after a browser restart:** when restore brings the group back under a new ID, the
reconcile pass adopts it if all of these hold:
- the title is exactly "Chat On Steroids";
- it is in a normal, non-incognito window;
- every tab in it is app-owned by the same `owns(tab)` rule the window reconcile uses.

The lowest ID wins. A group holding any tab the app does not own is never adopted, because it is
the user's now. If no group qualifies, the next background tab creates a new one.

**Serialization:** all group work runs inside the existing `inBackgroundWindow` queue. Two chats
opening at once therefore create one group, not two.

### 3a. Keep-awake (added after the live round, user decision 2026-10-11)

Chrome freezes the tabs of a collapsed group, and a frozen page neither sends nor records. On VM
141 (Chrome 154), 2 of 7 first sends into a collapsed group stalled for minutes; the frozen tab's
send completed within 6 s of expanding the group. A tab holding a Web Lock is never frozen (Chrome's
[freezing opt-outs](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/performance_manager/docs/freezing_opt_out_opt_in.md));
a lock taken from the content script's isolated world counts. With it, 10 of 10 collapsed-group
sends took 11–14 s.

- `register_document` answers `keepAwake: true` when the tab sits in the app's group; the content
  script then holds a Web Lock under a unique name (`chat-on-steroids-keep-awake-<random>`).
- `clf-keep-awake { on }` turns it on or off. The worker sends it from every maintenance pass and at
  once on Chrome's `groupId` change, only when the wanted state differs from what it last told that
  document (remembered in session storage).
- A tab that leaves the group, or every tab when the placement switches back to the window, is told
  to let go. The user's own groups and tabs are never told anything.
- Safety net: a grouped page Chrome froze before it could take the lock cannot hear the worker, so
  the worker expands the group (which unfreezes it). Once every grouped page holds its lock, a group
  expanded that way is collapsed again, unless the window's active tab is in it.

### 4. Failure handling during placement

- If `tabs.group` fails for an existing group (gone or moving), the ID is dropped and the
  placement retried once from target selection.
- If the retry also fails, the already created tab is moved to window mode:
  `chrome.windows.create({ tabId, focused: false, …bounds })`, then minimized. That is the same
  window `createChatTab` would have made. Moving a tab keeps its document, so a send that started
  is unaffected.
- If the tab itself vanished in between, the error propagates as today. The caller's existing retry
  or repair logic handles it.
- The app never leaves an app-owned tab ungrouped and visible in the user's tab strip as a result
  of its own failure.

### 5. Behavior in group mode, case by case

| Case | Behavior |
| --- | --- |
| First background tab | A group is created collapsed in the last-focused normal window. The user's active tab and window focus are unchanged. |
| More background tabs | They join the same group, inactive. |
| User expands the group or clicks a chat in it | Allowed. The app never re-collapses an existing group and never changes which tab is active. |
| Follow (the chat selected in the app) | Does nothing (user decision). The app sends no follow in group mode, and the extension's `followChat` also returns early. |
| "Show in browser" (`revealChats`) | Unchanged: it activates the tab, which expands the group, and focuses its window. The user asked to see it. |
| Compaction repair with `focus` | With the group setting, it selects the tab only when the tab sits in the app's background window. A tab elsewhere, including in the group, is not selected, since that would switch the user's view. With the window setting, nothing changes. A tab it has to create in group mode is created inactive. |
| Idle closing | Unchanged rules (`pruneManagedTabs`): quiet ≥ 5 min, not recently read, no unsent draft, no journal. When the last app tab closes, Chrome deletes the group and its saved entry (user choice 2). The next background chat creates a new group. |
| User drags an app tab out of the group | Respected. It is never pulled back, and idle rules still close it. |
| User drags their own tab into the group | It is never closed by the app. The group therefore outlives the app's tabs and stays saved by Chrome; that is the user's group then, and it is not re-adopted after a restart. |
| User renames or recolors the group | It keeps being used during this browser session. After an extension reload it is no longer recognized by title, so a new group is started; the renamed one is left alone. |
| User ungroups it | The group ID is invalid, so the next background tab creates a new group. The former tabs stay where they are and close by the idle rules. |
| User closes the group or its window | The tabs close, which counts as a user close, exactly as closing the background window does today. Chrome may keep the group saved (help text). The next background chat creates a new group. |
| Group moved to another window | Followed by group ID. |
| Browser restart with session restore | Re-adoption, see §3. |
| Browser restart without restore | Nothing to adopt. The mirror is dropped on startup, and a new group is created on demand. |
| Switch window → group while app tabs exist | Existing tabs stay in the background window until they close by the idle rules; only new tabs go to the group. The reconcile pass never moves tabs into the user's window. |
| Switch group → window while app tabs exist | New tabs go to the background window. The window-mode reconcile already moves owned tabs into an existing background window, so group tabs move there once it exists. That is the intended migration away from the user's window. |
| Only the background window is open (no user window) | Window mode for this tab. |
| Incognito windows only | Window mode. |
| Browser without tab groups (built-in browser, old Chromium) | Window mode, silently. The help text says so. |
| Extension reloaded mid-session (self-update) | The group is re-found through the local mirror plus the title check. |
| Several chats open at once | One serialized queue, so one group. |
| Memory Saver / discarding | Unchanged: `protectCreatedTab` sets `autoDiscardable: false`, and the existing frozen/discarded repair applies. |
| Compact & Resume successor of a grouped chat | Opened right after its home tab, inactive, and joined to the app's group (found in the live round: it opened active and outside the group). |
| A grouped page asks to be focused (`focus_tab`) | Answered `focused: false` without selecting it. |
| Worker revival with no open tab | Opened through the group placement (window mode unchanged: inactive in the current window). |
| Chrome pausing collapsed-group tabs | Every page in the app's group holds a keep-awake Web Lock (§3a); a page frozen before it could take one gets the group expanded until it does. |
| User collapses the group while chats work | The pages already hold their locks, so nothing pauses; the group stays as the user left it. |
| Extension self-update | The old content script's lock stays with its document until the page navigates; the new script is told again by the next pass. Harmless: an awake page is what window mode has anyway. |
| Background chats off | App chats open in the foreground as today. Helper tabs that are always background follow the placement. |

### 6. Code changes (outline)

- `extension/manifest.json`: add `"tabGroups"` to `permissions`.
- `extension/background.js`:
  - group storage helpers (`rememberBackgroundGroup` / `forgetBackgroundGroup` /
    `storedBackgroundGroup`);
  - `groupTarget()` and `placeInGroup(url)` inside `createChatTab`;
  - reconcile in group mode: adopt, never move;
  - `followChat` returns early in group mode;
  - with the group setting, the compaction focus selects a tab only inside the background window;
  - `onStartup` also drops the group mirror;
  - `backgroundPlacement` is read from status and restored from storage.
- `src/main/config.ts`, `src/main/ipc.ts`, `src/shared/types.ts`: `backgroundPlacement`.
- `src/main/bridge.ts`:
  - status field;
  - the follow gate (`followChatInBackground` and `takeFollow`) also requires window placement.
- `src/renderer/index.html`, `src/renderer/main.ts`: the select and help text, plus 12 locale
  catalogs.
- `docs/setup.md` (or the settings doc that covers Background chats) and AGENTS.md: a short note.

## Tests

**Unit (vitest, fail-first). The extension tests use the existing fake `chrome` with
`tabGroups`/`tabs.group` fakes added:**
- Window mode: unchanged. Existing tests stay green, and no `tabGroups` calls are made.
- Group mode, creation:
  - first tab: target is the last-focused normal window;
  - the tab is created inactive, then grouped;
  - the title, color and collapsed state are set;
  - the ID is stored in session and local storage.
- Adding: a second tab joins the stored group in the group's current window; `collapsed` is not
  touched.
- Target exclusion:
  - the background window and incognito windows are skipped;
  - the fallback is the eligible window whose tab was used most recently, then the lowest id;
  - with none, window mode is used.
- No `tabGroups` API: window mode.
- Group gone between calls:
  - recreated once;
  - a second failure moves the tab to a new minimized window;
  - the user's windows are never focused.
- Concurrency: two simultaneous `createChatTab` calls produce one group.
- Mirror:
  - extension reload with a valid mirror and title: adopted;
  - title changed: dropped;
  - `onStartup` drops it.
- Re-adoption: an all-owned titled group is adopted; a group with a foreign tab is not.
- Reconcile in group mode never calls `tabs.move` or `tabs.ungroup`.
- `followChat`: no `tabs.update` in group mode.
- Compaction focus with the group setting: a tab in the background window is activated; a tab in the group or a user window is not. With the window setting: unchanged.
- App:
  - config default `'window'`, schema and IPC round trip;
  - `/status` carries `backgroundPlacement`;
  - no follow in group mode;
  - the renderer select reflects and saves the value.

**Live, on both platforms (VM 141 Chrome and the Mac's Chrome, dev build, then the canary):**
1. Switch to group mode and start a worker: the group appears collapsed in the last-focused
   window, the user's active tab is unchanged, and the worker sends and answers.
2. A Goal run end to end, plus Compact & Resume, in group mode.
3. Two workers at once: one group with two tabs.
4. Expand the group and read a chat; a new worker joins without collapsing or switching tabs.
5. Idle: after the chats finish and 5 min pass, the tabs close, the group disappears, and Chrome's
   tab-groups menu shows no saved "Chat On Steroids" group.
6. Drag a tab out; drag a personal tab in. Behavior as in the table.
7. Close the group's window during a run: a user close, as today, and a new group on the next chat.
8. Extension self-update mid-session: the same group keeps being used.
9. Browser restart with restore: the group is re-adopted, not duplicated.
10. A collapsed group idle for ≥ 10 min: a wake still sends (frozen-tab path).
11. The 188 s outlier: 10 consecutive first sends right after group creation, all within the
    window-mode range or the cause found and fixed.
12. Switch back to window mode: new tabs go to the minimized window, as today.

Before/after screenshots of the settings select go to the user before merge (in English).

## Out of scope

- Showing a running count in the group title.
- Moving the user's existing tabs into or out of the group.
- Managing Chrome's saved groups (there is no extension API for them).
