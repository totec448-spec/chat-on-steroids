# Local shell runtime repair, issue 311

The September 20 diagnostic report and original archives were compared with the helper-18
merge 8f76ccc7, issue 311, the earlier PR 318 adaptation, and the shared development tree.
The maintainer subsequently requested local-only completion. This change is left in the shared
dirty tree; it does not authorize publication, merge, installation or a browser-profile reset.

## Evidence and boundaries

The newest NetLog SHA-256 is d46582ee5bbbf9ef46ec2ac59c19bf9907b0550f801e44280726e529a7cb0b1a.
It contains 388,193 events over 322.485 seconds. Events 63663 and 186152 are the two marked
worker root navigations reported at 09:59:55.649Z and 10:02:45.387Z. It is Default capture:
transport activity does not provide application SSE/WebSocket bodies or live React state.
The matching page archive SHA-256 is 3d8f30e5df11c2029d1db5e3349917e6733127c5c27d1289e287b82fb54c9010.
Its 850,432-byte HTML has one shell exchange and the already supported composer. The local
HTML parser counts nine script elements, unlike the report's stated zero; no script was run.

The older project-page archive supplies the public client code missing from that newer DOM-only
archive. Static parsing of 144961.24ab54ff0d.js and 774702.16835237c4.js establishes a separate
live render snapshot containing renderedConversation and renderedTurns, with the same turn
object passed into mounted entries. The published compiler memo/hook values can therefore
provide exact live mapping evidence without depending on a later history query. The typed
reasoning renderer uses the actual item object, which also supplies a precise DOM ownership
relation. Files were parsed as text/AST only, never executed or inserted into a signed-in page.

@redzrush101 retains credit for the report, fresh originals and retests. @ehkogh retains credit
for PR 318's original shell structures and fixtures. No third-party client implementation,
private capture, prompt, cookie, signed URL or account identifier is a publication input.

## Changes

Fresh minimized worker/resume pages now join the existing rendering policy through created-tab
custody plus the app's current command publication. Initial pendingUrl custody survives loading;
load completion wakes existing maintenance. The first document pins the scope. Replacement,
foreign-route/marker, expired or retired commands cannot retain it. Bound conversations use
the ordinary live-chat policy. The 12-second composer deadline and Send/ACK ownership stay intact.

The shell reader locates only a published native snapshot for its exact mounted turn object
and conversation/user identity. It reads metadata only for explicitly selected messages; the
newest turn can additionally read request ids along the explicit current-node parent chain
ending at that actual user. Child selection and cached answer reconstruction remain excluded.
Conflicting snapshots, histories, ids, malformed paths and exhausted bounds abstain.

Public thought summaries and preambles join actual source ids to unique public typed items.
Raw/hidden analysis and tool arguments are excluded. Existing assistant identity rules preserve
streaming preambles across raw-id rotation. Text and scan budgets include these new projections.
The existing Overwrite renderer now accepts shell exchanges, using one exact anchor per native
message and object-proven preamble anchors. Tool-only chunks remain after the user message.
Native prose nodes, event handlers and drafts are retained; no independent shell renderer exists.

The passive observer accepts the native f/conversation/resume endpoint with unchanged complete-
event identity requirements. Version 2 supplies refresh/dispose/current receipts, cancels old
readers and retires old listeners when a versioned instance is replaced. Existing MAIN helper
restoration refreshes it alongside Fiber. An older boolean observer cannot be disposed safely
in place and explicitly requires a fresh document; no automatic reload grant is invented.
The matching recorder/helper/restoration version is 19; the app release label remains 2.1.14.

## Verification

Red-to-green regressions cover missing worker rendering, lost initial pendingUrl custody,
live shell metadata before cache hydration, public activity, and previously absent shell tool
placement. Negative cases cover source conflicts, unselected branches, private content,
recycled DOM ownership, observer duplication, command retirement and document replacement.

The native Chromium rendering fixture demonstrates delayed editor hydration in a genuinely
minimized separate window, followed by hydration after focus emulation while the window remains
minimized and the foreground tab stays selected. The native shell fixture checks actual HTML
editing, picker operations, successive Send receipts, exact finals and live public-message
anchors using synthetic page/bridge data. These are not a live retest on the reporter's account.

Verification logs and source/hash receipts are under ignored outputs/shell-runtime-20260920.
The original report contains no active fresh Goal/Loop reproduction, historical CPU trace, or
controlled same-turn pre/post-reload runtime capture. Tests preserve those boundaries rather
than presenting synthetic fixtures as missing account evidence.

Final shared-tree verification completed on September 20: `npm run verify` passed 5,648
main-suite tests and six isolated shutdown tests; 45 tests were skipped. TypeScript, public-
history privacy, dependency notices and native-source checks passed. The production build
passed, as did nine native shell checks and eight native rendering checks. Earlier complete
runs recorded a fixture type error and then twelve Goal/finish failures during concurrent
edits; the current focused rerun and complete rerun passed without weakening those guards.

`final-local-proof.json` confirms that all 544 captured source/test/script/configuration files
were unchanged during the final verification. The source digest is
`de590c4d15464190639ee8e5033403f53c4d968eafed32d1e6947c897b038342`.
The shared branch remains `codex/work-2.0.8` at its original local HEAD `996aa4a4`; this repair
is uncommitted working-tree content. No PR, merge, installation, configuration reset, app
restart or signed-in provider test message was performed in this local-only completion.
