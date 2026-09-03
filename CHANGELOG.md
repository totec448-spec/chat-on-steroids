# Changelog

All notable changes to this project are documented here.

This project is in **beta** despite its version number. Behavior may still change between
releases.

The app and the `extension/` companion are versioned together. **Reload the
extension after updating the app**. If their bridge protocols are incompatible,
the app refuses the extension and asks you to reload the matching copy.

## [Unreleased]

### Fixed
- **A closed agent tab comes straight back.** Closing a Prime's or worker's tab, or typing another
  ChatGPT address into it, now reopens that chat at once while a turn is still running in it. The
  extension did not report a tab that was navigated to another ChatGPT page as gone, the app judged
  "still running" only by the page's parting word (which is always "done" while a tab is torn
  down), and a reopen waited up to three minutes behind a floor meant for pages still loading.
  Every close now logs whether the chat was reopened and, if not, why.
- **A worker chat stays a worker chat after it finishes.** Two workers that crossed the context
  ceiling were treated as ordinary chats over the compaction line: the app filed compaction tickets
  their pages can never act on and reloaded each working page five times before giving up.
- **A worker whose chat will not answer is replaced, not retried.** The second failed wake in a row
  with nothing heard from that chat in between now tells the prime to spawn a replacement instead
  of trying again; a ChatGPT conversation that answered every load with "This content is
  unavailable" cost four wakes and thirty minutes before the prime gave up on it.
- **A reload no longer ends the turn it came back into.** The page bound the resumed turn to
  the newest assistant section on screen even when that section sat above the newest question,
  so the previous answer's end-turn bit closed the live turn seconds after every reload while
  the same request went on calling tools. The resumed turn is now bound only to a section
  below its question, and the hydration flicker of the Stop control no longer counts as
  having seen it run.
- **Large chats no longer freeze the tab.** The page script read the whole transcript six to
  eight times a second, taking the text of every message each time; a 300k-token chat spent
  most of every second on that and sat unresponsive for minutes after each reload. Each section
  is now read once and re-read only when it changes. On a 300-turn transcript the one-second
  tick fell from about 880 ms to about 115 ms in the test harness.
- **No second reload on a page that is still loading.** A large chat takes minutes to come
  back from a reload, and the silence watchdog reloaded it again 23 seconds after an
  unattributed reload had, starting the load over. A chat that has not shown a sign of life
  since its last reload now gets the three-minute recovery floor before silence may reload it.

### Changed
- **Session cursors are short tokens.** A cursor used to be base64 JSON, up to a thousand
  characters with four unfinished messages in it, and every refused session read in the fifty
  most recent recordings was such a cursor the model had re-typed with a letter transposed. A
  cursor is now a checksummed token of a few dozen characters; a damaged copy is refused as
  damaged, a cursor from another recording as belonging to it, and quotes, backticks, an
  `update_cursor:` label or trailing punctuation around a pasted cursor are ignored.
- **`read` takes a range per path.** `path:12-40` or `path:12` reads that range of that one path,
  so several ranges of one file fit in one call; the sandbox used to refuse the colon. A path
  that does not exist now lists the nearest folder that does, which was the model's next call
  every time.
- **A refused path suggests its approved spelling.** `C:\marscraft\src\ui\Hud.js` or
  `/totec/marscraft/src/ui/Hud.js` is refused with the approved `/marscraft/src/ui/Hud.js` it
  probably meant; the suggestion resolves nothing by itself.
- **exec_command says which command in a batch failed** when the exit codes are mixed, and
  explains `git diff` falling into `--no-index` outside a repository and a backslash-quote that
  split a PowerShell argument into stray positional parameters.
- **`agents status` prints each worker's recording id**, so a prime reads a worker with
  `session action=read` instead of searching recordings by the task text; `finish` without a
  result says what the result is for.
- **`computer` accepts punctuation keys** (`-`, `=`, `[`, `]`, `;`, `'`, `,`, `.`, `/`, `\`,
  backquote) and the common aliases, and an unknown key name lists what is accepted. A capture
  of a closed window is `WINDOW_NOT_FOUND` rather than a generic helper error, a stale UI ref
  says to observe the window again, and the keypress description says that browser tab, window
  and address-bar chords are refused.
- **Goal waits for a quiet chat.** A reloaded page, or a "Message delivery timed out" error, can
  report a turn as finished while the same request is still calling tools; the loop then wrote
  the next message into a chat that was still working and the chat ran two requests at once. The
  app now refuses to draft while its own record still has the turn open or a local tool ran
  within the last minute, files the obligation for later, and withdraws it when a call proves
  the turn never ended; the page keeps asking every 15 seconds until the chat has finished. The
  silence ticket — two minutes without a call, one reload, one more minute of nothing — is the
  one route that writes the next message without the page ever reporting an end. After a silence reload,
  the minute of listening is cancelled by any sign of life — a tool call, an interim row, a
  message — and re-armed for the next stop.
- **Goal reads the decision behind a thinking block.** A routed provider answered with its
  reasoning in front of the JSON three drafts in a row; each failed as unreadable and was asked
  again at once. The decision is now read out from behind reasoning blocks, code fences and
  surrounding prose, an unreadable answer is logged with a sample, and page-side retries double
  their wait per failure of the same turn, from 15 seconds up to 4 minutes.
- **Goal writes after text already in the composer.** One stray character held a finished reply
  at "sending" until the user deleted it. The reply now goes in on a new line after whatever is
  there and is sent at once.
- **Automatic Compact & Resume is the app's decision.** The ticket is filed on the evidence that
  a working chat has crossed the line — an attributed call, a current-turn observation — so a
  page that has frozen mid-turn is still compacted; the page resumes the ticket and raises its
  own tab first. Pickups follow the ticket's phase: while the prompt is unsent, a reload in front
  every two minutes, five times, then the ticket is abandoned and the next working turn opens a
  fresh one; while the brief is being written, every five minutes, three times; once it lands,
  the replacement opens at once.

## [2.0.3] — 2026-09-02

**A small step towards the infinite loop.**

- **The Loop.** Goal with the exit removed: every finished turn gets its next message until you switch it off.
- **Improved stability and reliability through auto reloads.** A chat that goes silent, shows an error or loses its tab is reloaded or reopened on its own evidence, and a turn that is still running is never closed early.
- **macOS computer use.** The optional Desktop connector now ships on macOS, off by default.
- **Auto update.** Windows and Linux AppImage installs fetch the next release and apply it on the next quit.
- **Small things.** UI polish, blocked chats, worker recovery, session timeline fixes.

<details>
<summary>Full list of changes</summary>

### Added
- **A blocked chat says so in its composer.** Block is set in the app, and from the ChatGPT page
  nothing said so: the model kept answering with tool refusals. The composer now carries "Chat
  blocked" beside the gear, and hovering it says where the block is undone: the app's Chat tab,
  hover the chat in the sessions list, press its block symbol.
- **The chat page shows why the app reloaded it.** The session log already carried one row per
  browser repair, "Trying to reload chat to recover an interrupted response…" rewritten in place
  to "Reloaded chat to recover …", but the page dropped it because the row names no turn. It is
  now painted between the turns it happened between, with the time, whether or not Overwrite is
  on, so a tab that reloads under you says what happened and why in the chat itself.
- **macOS now publishes the optional Desktop connector.** Architecture-matched Swift code implements
  window/display capture through ScreenCaptureKit, snapshot-scoped semantic controls through
  AXUIElement, and physical mouse/keyboard input through CGEvent while preserving the existing
  `observe` / `computer` schemas, frame identity and partial-batch contract.
- **On macOS the Desktop permissions start off.** The backend is there, but a fresh Mac install
  publishes Core only; switch on "See the screen", "Control mouse and keyboard" or a clipboard
  permission in the Home panel, grant Screen Recording and Accessibility in System Settings, and
  the Desktop connector appears. Windows keeps starting with the Desktop permissions on.
- **macOS packaging and smoke checks cover the in-process Desktop boundary and screen-capture purpose
  string.** Each x64/arm64 package ships a thin Swift dylib plus N-API addon outside asar. A Node
  Worker invokes that backend inside the responsible Electron process, and packaged-runtime smoke
  exercises this real addon/dylib path rather than the standalone development CLI protocol probe.

### Changed
- **macOS builds now require macOS 13 Ventura or newer.** The bundled OpenAI `tunnel-client` v0.0.14,
  which the publish pipeline pins to OpenAI's current release, is built for macOS 13; the 12.0 floor
  of 2.0.2 would have shipped a Connect button that cannot start it. The packaging audit refuses any
  payload whose deployment target is above the declared minimum, which is how this was caught.
- **The model is told not to spam browser instances.** A prime that could not get a foreground
  reading out of the browser window it controlled launched a fresh debug instance on a new port
  and profile for every retry. The exec_command description, which every turn
  re-reads, now says it plainly: keep to one or two browser windows you actually use, reuse the one already
  open, and stop and say so when control becomes ambiguous rather than launching a replacement.
- **Each browser recovery stands on its own evidence, and nothing else.** Silence reloads a chat
  after two minutes with no tool call and no page change, full stop. An error ChatGPT shows
  reloads the chat once per user message, whatever the error says and whether or not the page
  could tell which turn it belongs to. Unattributed activity reloads the chats that are working
  once per server turn: a later unattributed call under the same request id is the same broken
  turn and buys nothing, the next request id is the next turn and gets its own reload. None of
  the three is refused because another one already fired.
- **Goal and Loop chats always come back; everything else is a switch, off by default.** Silence
  and a missing tab reopen or reload a chat the Goal/Loop switch is driving whatever the settings
  say. Workers, primes and plain chats that have called tools are recovered only when "Recover
  other chats' tabs" is on, and it now starts off.

### Fixed
- **A worker chat that opens and never starts is opened once more, not waited on.** The tab the
  app opened for a worker loaded as an empty New chat and never picked up its instruction. The
  app held that page's ninety-second lease to the end, then failed the worker, and only then
  opened the two workers queued behind it, which is why they appeared two minutes after the
  prime asked. A fresh worker page now has twenty seconds to redeem its marker; past that the
  same command is opened again, once, and a second silence fails the slot immediately so the
  line moves. The command is single-owner, so the page that redeems first is the only one that
  types. The old "never handed to a page" retry, a leftover from before every ending advanced
  the queue, is gone.
- **A reload no longer ends a turn that is still running.** The page reloaded in the middle of a
  prime's turn — once for a foreign unattributed call, once for a lost stream — adopted the open
  turn from the app, saw the interim prose ChatGPT had committed and no Stop control, and four
  seconds later reported the turn completed. The same request id then called tools for another
  twenty-four minutes, and Goal wrote the next user message against an answer that had never been
  given. Two changes, one from each side. The page's visible-prose rule now applies only to a
  turn the document has seen running; an adopted turn waits for ChatGPT's own end-of-turn, an
  error, a stop, a new send or the ten-minute stall. And the app treats the server turn as the
  authority: a call under the ended turn's request id that starts after the reported end reopens
  the turn durably, hands it back to the page, and withdraws the Goal decision drafted for it.
- **A stopped turn ends the `active` badge.** The badge went dark only on the model's final answer,
  so a chat whose turn the user stopped — the blocked prime of 2026-09-02, stopped right after a
  refused call — read `active` for three more minutes. Any turn end now ends it, the user's stop
  included; a refused call in a blocked chat still lights it, so a chat that keeps trying can be
  found in the list, and it goes dark the moment its turn is stopped.
- **A page retrying a rate-limited Goal draft is no longer reloaded for it.** OpenRouter answered
  ten drafts in a row with 429 while the page retried every fifteen seconds, alive the whole
  time; the owed-reply watchdog only saw a decision still owed after two minutes and reloaded
  the chat twice for a page that was never dead. Each draft request now counts as the pickup it
  is and pushes the reload out. Provider refusals are also written to app.log, which until now
  held nothing about them.
- **A reload of an open turn is painted inside that turn.** The row names the turn it is
  repairing, so Overwrite lists it among the turn's tool calls, in order, with the ↻ and the
  time. Only a reload with no turn open — a Goal reply nothing collected, a missing tab — still
  sits between turns.
- **A New chat opened in a worker's tab is no longer mistaken for that worker.** The page kept
  the worker label and command id across the move, so every event of the user's own chat went
  out as the worker's, the app bound the slot to it and stamped a worker origin on its session,
  and the user's first message was folded as "the instruction this app gave the worker". A tab
  that leaves the worker's chat now drops the identity with it.
- **A resumed chat no longer inherits the reloads of the chat it replaced.** The session keeps
  its identity across Compact & Resume, so the replacement chat's feed was cut from a log that
  also held the old chat's "Reloaded chat to recover …" rows, and the page stacked them above
  the handoff as if the new chat had been reloaded before it existed. The bootstrap this app
  types is the boundary: reloads before it stay with the old chat, reloads after it are painted
  where they happened.
- **Blocking a chat also stops its Goal, Loop and auto-compaction.** Block refused the chat's
  tools but left the loop typing the next message into it and the threshold free to compact and
  resume it, so a blocked prime or solo chat could carry on, or reopen as a replacement chat the
  block did not cover, with every one of those turns answered by tool refusals. A blocked chat
  now reports Goal, Loop and compaction off with the reason in the composer sheet, refuses to
  take a new goal or turn any of them on, and gets them all back exactly as stored when it is
  released. Worker chats were already fenced.
- **A Compact & Resume whose marker the new chat never redeemed no longer strands the session.**
  The replacement chat was opened, the brief sent, and the prime in it went to work on the
  predecessor session — but the app committed the continuation only from the marked message the
  page had to find, and once it did not, the session stayed on the old chat, the new one was
  refused as a stranger running someone else's swarm, and the loop was dead. The new chat now
  also reports the id ChatGPT gave it, and the app commits from that report exactly as it does
  from the marker.
- **A Goal or Loop chat that stops with no final answer gets its next message anyway.** Two
  minutes of silence earn the reload as before; if the fresh page shows the same dead turn for
  one more minute — no tool call, no page change — the loop treats it as a finished answer and
  files the next message. A stop you pressed yourself never triggers this.
- **A call the app cannot place no longer tells the model to ask you to clear a worker.** The
  message now says the app reloads the affected chat shortly because of the unattributed
  activity, and to try once more.
- **A closed Loop chat is reopened after Chrome restarts.** The app asked for the reload two
  minutes after the chat went silent, but the extension only polled for recovery work while it
  still held tabs or queues. After a browser restart it held neither, so the request was never
  collected and the Loop prime stayed closed. The extension now asks the app on every pass and on
  browser startup as long as it is paired.
- **A worker that reported its finished task shows "sleeping" straight away.** The report parks
  the run when it was the last working worker, and a parked run has no agent view for the session
  list to read, so the row fell back to the activity heuristic and said "active" for three minutes,
  then nothing. The finish is now recorded on the session itself and the row reads it.
- **Blocking a worker's chat frees its swarm slot at once, restart or not.** A worker whose chat
  the user had blocked was slept only when its in-memory silence grant expired. After a restart
  there was no grant, so the restored run carried the blocked worker as active with no tab for an
  hour, the next prime was refused with "another conversation is already running the swarm", and
  the slot came free only when the tab finally closed and the detached clock ran out. The sweep
  now sleeps every slot-holding worker whose chat is blocked from the durable block alone, and
  pressing Block runs that sweep immediately.
- **A goal started from an empty New Chat keeps retrying through a provider rate limit, with the
  same "Retrying Goal in 15 seconds" card an in-chat turn shows.** The opening request asked
  three times with a one- and two-second pause between them, which is shorter than any real rate
  limit, and then painted "The goal loop stopped" over a run that had not started. It now waits
  on the same quarter-minute clock as the in-chat loop with no attempt limit, and stops only when
  the app refuses for a settled reason, the composer is no longer that empty New Chat, or a
  different goal is saved over it.
- **A chat in a background tab reports its answer the moment it lands, not when you click the
  tab.** Chrome slows a hidden tab's timers to one wake-up a minute once the tab has been hidden
  for five minutes, and the extension's transcript scan, activity poll and every wait in its retry
  loops were exactly the chained timers that rule applies to. With the prime testing its game in
  a tab beside its chats, each worker chat took two to three minutes to report an answer that had
  long finished, the prime waited for reports that never came, and nothing moved until the tabs
  were clicked through by hand. Every wait in the recorder now goes through a scheduler Chrome
  keeps on its ordinary once-a-second schedule, and a tab brought back in front re-reads its
  transcript at once.
- **A tab or window shortcut is refused in a browser window.** The prime, driving its game in a
  tab beside its ChatGPT chats, closed its own chat mid-turn with ctrl+w and later walked the
  worker chats with ctrl+tab and typed a URL into one. A keyboard chord cannot see which tab it
  lands on, so the `computer` tool now refuses the chords that close, open or switch tabs or
  windows, or take the address bar, whenever the keys would reach a browser, and the desktop
  instructions say to open the page under test in a browser window of its own. The macOS spellings — command+w, command+shift+], command+l and the rest —
  and macOS application names such as "Google Chrome" and "Safari" count too.
- **A compacting chat whose stream dies is reloaded on the next sweep, not after five minutes.**
  While an automatic Compact & Resume owned a chat's recovery clock, the page's own "Connection
  interrupted" was ignored entirely, and the prime sat on that error for nine minutes while its
  model went on calling tools behind the dead page. The failure now brings the ticket's next
  pickup forward — the same reload, under the same three-attempt bound.
- **A brief lost from the composer before Send is offered to a fresh chat, and the chat it was
  lost from records what you type next.** With the replacement chat open and the brief just
  landed, an Escape in the same instant emptied the composer. The armed ticket then sat for its
  six hours, the run could not move on, and the chat — waiting for a marked message that would
  never come — journalled nothing typed into it afterwards. The page now proves the brief never
  left it (an empty composer in a chat that still has no id), the app takes the armed dispatch and
  the claim back and opens a fresh chat for the same brief at once, and the old page journals
  normally.
- **A chat whose answer stream died is reloaded, every time.** Three separate rules left the prime
  chat dead on "Connection interrupted" for twenty minutes while its answer was long finished on
  the server. The once-per-turn reload budget was charged when the reload landed, against a turn
  that had already failed, so it stuck to the *next* turn and refused that turn's own error as
  already spent. The failed turn's end then took the chat off the two-minute silence watch, exactly
  as a completed answer would, so nothing was left to ask. Now the budget is charged only to a turn
  actually running when the reload lands, a failed turn restarts the silence watch instead of
  spending it, and a reload gives the chat a fresh two minutes before it is judged dead — a worker
  writing a long answer used to be put to sleep, and its prime told to wake it, twenty-seven
  seconds after its own reload.
- **A woken worker is awake when its turn starts, and nothing can put it back to sleep on the
  way.** Waking two sleeping workers at once, the browser typed both messages within a second
  and both pages reported "turn started", yet both stayed *waking* because only a tool call
  counted as proof, and those calls' page evidence was late. In the same second the page
  re-reported the settled answer that had put each worker to sleep, and the app took that as a
  fresh finish: the worker went back to *sleeping* and its wake command was retired, while the
  message the browser had just typed ran as a turn the app did not own. A turn that begins after
  the delivered wake now ends the wake like a call does, and no stop observed from outside — a
  re-reported answer, a late finish call, a quiet sweep — applies while a worker is waking.
- **A refused call from a replaced chat says what it is.** After Compact & Resume, ChatGPT can keep
  running the old chat's stopped turn for a while, and every tool call it makes is refused as
  superseded and filed under Unattributed activity. Those rows now carry a line explaining that
  the request id proved exactly which chat it came from and that nothing needs repairing, instead
  of reading like the attribution chain had broken.
- **The bootstrap fold names the worker and no longer lurches.** The folded opening message of a
  worker chat now says "This is worker-3 — …", from the session's durable origin so a reloaded tab
  still knows, and keeps the first two lines of the text visible while closed so the bubble is the
  same width open and closed.
- **A Compact & Resume is one timeline row again, and it says where it stands.** The card keyed
  its fold on the brief request's own turn id, but the app types that request, so the live
  recorder writes it without one; the answer turn, the brief, the handoff line and the turn end
  then fell out of the card as loose rows. The card now takes the turn that opens right after the
  request. Its three overlapping step pills — which shared a class name with the setup wizard's
  steps and inherited that layout — are replaced by one sentence: what happened, what is still
  happening, or what failed and why. Green once the new chat opened, red once a step cannot come.
  When the app abandons a continuation it records the reason into the session, and the row shows
  it ("Failed — the handover never landed and was given up on").
- **A compaction stuck writing its brief is reloaded every five minutes, for a quarter of an hour
  at most.** The automatic pickup used to wait fifteen minutes before its first reload and
  fifteen between each of the three, so one glitched page cost forty-five minutes of nothing.
  While the brief is still being written the checkpoint is now five minutes; once the brief has
  landed the five-minute clock stops and opening the replacement chat keeps the quarter-hour
  cadence its command is leased for.
- **Reopening an old resumed chat no longer silences the tab.** The marked resume message raised
  the content script's journal gate, and only a committed continuation ever released it. Once the
  app had forgotten that token — after a restart, or simply later — its `no_such_continuation`
  refusal left the gate shut for the life of the document, and the gate followed the tab into the
  New Chat opened next. That chat lost its first user message, its ChatGPT title and its
  `turn_start`, so the app never saw it working: no automatic compaction, no unattributed-call
  recovery, no reload repair, until the tab was refreshed by hand. A definitive app answer now
  releases the gate, and moving to another chat drops the previous chat's gate outright.
- **A reloaded tab records a turn the app never heard of.** A reload mid-turn used to adopt the
  app's open turn or nothing: with no durable turn and no send receipt, the reloaded page filed
  the running question as history, and the chat stayed "idle" for the app while ChatGPT worked
  on. A document that has opened no generation of its own now claims the newest user message as
  the running turn once Stop has outlasted the settle window and the app reports no active turn.
- **A resumed chat is armed the moment Compact & Resume commits.** The new chat used to get its
  activity grant only after it had proved a turn of its own; when it never got its first tool call
  through, nothing knew it was mid-turn and nothing reloaded it. Its calls stayed Unattributed and
  the loop stalled on the first call after every automatic compaction. The commit now grants the
  replacement chat the same silence and unattributed recovery an ordinary working chat has.
- **A retired chat's late observations no longer mint a session of their own.** The old chat
  re-rendering the brief seconds after the commit created a second session consisting of nothing
  but the summary. Such observations are filed into the session lineage they came from, without any
  activity, turn or Goal effect.
- **The Activity log survives the run.** It was in-memory only, so a failed overnight run left
  nothing to read. It is now mirrored, redacted as before, to `app.log` in the app's data folder
  (4 MB, one rotation).

### Changed
- **One Compact & Resume is one timeline row.** The brief request, the brief, the "handoff saved"
  line and the bootstrap in the new chat fold into a single expandable card whose header shows the
  three steps as coloured chips — summary requested, summary received or not, new chat opened or
  not — so a failed handover is recognisable at a glance instead of being three long messages.
- **Unfolded tool rows stay put while a chat is running.** The timeline used to be rebuilt from
  scratch on every change, closing whatever the user had expanded and jumping the scroll position.
  Rows whose record did not change are now kept as the same nodes.

### Security
- macOS Screen Recording and Accessibility remain independent OS grants. The helper requests no
  privilege at startup, reports a typed error when a live operation lacks consent, and permission
  revocation remains effective without changing the connector schema cached by ChatGPT.

</details>

## [2.0.2] — 2026-08-26

2.0.2 is the native cross-platform release port. The already-published 2.0.1 release remains the
historical Windows hardening release; this patch moves the unreleased tree forward so the new
Windows/macOS/Linux build matrix can be published under a fresh tag instead of trying to replace it.

### Added
- **Native release jobs now cover six host/CPU combinations:** Windows x64 + ARM64, macOS Intel +
  Apple silicon, and Linux x64 + ARM64. Every package job verifies it is running on the requested
  native host before packaging and smoke-tests the packaged native runtime before upload.
- **macOS ships DMG and ZIP artifacts for both architectures.** CI verifies each ZIP, verifies and
  mounts each DMG, and checks the resulting `.app` bundle, executable and `Info.plist` before the
  release candidate is assembled.
- **Linux ships AppImage and DEB artifacts for both architectures.** The DEB is installed on the
  exact Ubuntu 24.04 runner that built it. The AppImage is launched normally under Xvfb with an
  isolated first-run profile, then launched again with the static launcher's user-namespace probe
  forced to fail so the documented `--no-sandbox` fallback is covered independently. Both launches
  must reach app, window and renderer-state readiness; native dependencies are executed separately
  from the unpacked package before either artifact smoke.
- **Target-native runtime payload staging now spans all release platforms.** Sharp/libvips,
  node-pty, tree-sitter, tunnel-client and ripgrep are selected and validated for the target OS/CPU
  instead of inheriting whatever native payload happened to be installed on the packaging host.

### Changed
- **Linux packaging is Noble-compatible and keeps stable public filenames.** DEB dependencies allow
  Ubuntu 24.04's time64 GTK/AT-SPI package names, AppImage uses electron-builder's static 1.0.3
  runtime rather than depending on legacy FUSE2, and public artifacts remain `x64`/`arm64` even
  though individual Linux packaging formats use different native architecture aliases internally.
- **Linux desktop identity is explicit.** `desktopName` and `StartupWMClass` now share the
  `com.chatonsteroids.app` identity so installed launchers can associate the running Electron window
  with the generated desktop entry.
- **The app packaging icon is generated at 1024×1024** for Retina-quality macOS ICNS conversion;
  the Chrome extension keeps its existing 16/32/48/128 icon set.
- **Release publication fails cheap.** Tag/version mismatch, missing reviewed notes, public-history
  privacy failure and an already-existing GitHub release are rejected before the six native package
  runners are allocated. Candidate artifact names are run-id based so branch names containing `/`
  cannot invalidate the final upload.

### Known release caveat
- **The macOS DMG/ZIP artifacts are currently publisher-unsigned (no Apple Developer ID) and
  unnotarized.** Apple-silicon Mach-O executables can still carry ad-hoc platform signatures; those
  do not identify a publisher or establish Gatekeeper trust. The native builds and archive/runtime
  checks are covered by CI, but Apple Developer ID signing/notarization is not configured in the
  release workflow yet, so Gatekeeper may warn when those artifacts are opened.

## [2.0.1] — 2026-08-25

This is the post-2.0 hardening pass. It is unusually broad because it combines the reusable-worker
rewrite, a live transcript/Goal investigation, session-store recovery work, the first Computer Use
overhaul tranche, and an adversarial restart/race audit. The detailed engineering log is in
`docs/bughunt-2026-08-25.md`.

### Added
- **Workers are reusable ChatGPT conversations.** A worker that finishes normally now sleeps,
  preserves its full conversation/history and frees its worker slot. `agents action=message` wakes
  a sleeping worker in that same chat. If the tab is still open the extension reuses/focuses it;
  if it was closed the app reopens the exact stored `/c/<conversation>` and types the prime's new
  instruction as a real user message. Waking requires a free worker slot and fails before queueing
  or typing when no slot is available. A worker becomes permanently non-revivable only after its
  recorded context reaches the 400k worker ceiling and it next stops.
- **Worker revival is crash-safe and durable.** Revival has its own browser command, exact
  conversation fence, durable lease, receipt replay, app-restart restoration and browser ACK
  recovery. Browser redemption is now the arbitration cut: once a page owns the durable wake,
  concurrent MCP liveness cannot steal or duplicate it.
- **Worker ownership now survives the active run itself.** When the final slot-holding worker
  sleeps, the global run is parked immediately so another prime chat can start workers, while the
  original prime retains its complete worker history, exact conversation bindings and revival
  authority. `agents status` is caller-scoped, fresh workers can be spawned without consuming old
  sleepers, same-named workers from different primes stay isolated, and Compact & Resume transfers
  the complete dormant/active history to the resumed child chat. Turning Multi-agent off now parks
  live execution and withdraws worker browser commands without deleting those histories; disabled
  restarts preserve them, and only explicit Clear swarm discards the retained ownership.
- **Specific Goals are durable per-chat state.** Reopening a finished chat restores its goal text
  without auto-firing stale work; Compact & Resume transfers the same objective to its child,
  including crash-recovery repair, so an unattended chain of resumptions keeps pursuing one goal.
  A Goal completion decision stops the current loop without silently deleting the user's saved
  objective; it remains until explicitly cleared or replaced.
- **`exec_command` accepts `cmds`** for up to 20 related commands in one shell session, preserving
  variables/cwd between items and returning labeled per-command exit codes. `max_output_tokens`
  controls the model-facing output budget, and `write_stdin` keeps the same bounded semantics.
- **Desktop observations keep immutable recent screenshot frames and UIA snapshots.** Semantic
  refs point at cached AutomationElement handles scoped to helper generation/snapshot identity,
  coordinate actions require retained frame identity, and batches expose exact partial-completion
  and route evidence. Same-call verification can wait for foreground/window/UI conditions and
  optionally capture the resulting state.
- **Retained session history is paged in the Chat UI.** The session list now reports the real
  retained total, loads older pages on scroll and uses cursor deltas for live detail refresh
  instead of repeatedly resending the same large tail.
- **Approved roots can be renamed from the Home UI.** The editor survives unrelated renderer
  pushes, keeps failed drafts for retry and cancels if authoritative state removes or renames the
  target.

### Changed
- **Desktop automation's hot path was overhauled without expanding the public two-tool surface.**
  The helper is prewarmed only when native Desktop capabilities are published, fixed sleeps were
  removed from common focus/action paths, window/UI/pixel acquisition can use one internal
  snapshot request, UIA traversal is bounded with TreeWalker + CacheRequest, and read-only window
  capture tries a background path before any visible-screen fallback.
- **The tested bundled `tunnel-client` now wins by default.** An explicit configured binary still
  wins; PATH/common-install copies are fallback only. Tunnel discovery/version checks are cached,
  and the development bundled path now resolves the repository resource correctly.
- **Windows command startup is cheaper and more deterministic.** Explicit short yields are honored
  instead of being clamped to ten seconds, default PowerShell starts without the user profile,
  shell discovery is memoized, and Java/Go PATH reachability checks are cached against the exact
  environment while explicit `JAVA_HOME` / `GOROOT` keep priority.
- **Browser setup now follows actual feature dependency.** The extension is required only when
  recording or multi-agent is enabled. Durable pairing and live browser presence are separate
  states, so a stored token alone no longer makes Setup claim the extension is currently connected.
- **Filesystem-root setup uses the capability set that really needs a root.** Mixed Core/Desktop
  configurations cannot skip folder approval merely because Desktop is enabled, while genuine
  screen/control/clipboard-only setups remain allowed without a filesystem root.
- **The main window adapts to the current Windows work area** instead of forcing a fixed 1080x700
  non-resizable surface that can exceed small or DPI-scaled displays.
- **Session retention is continuous rather than startup-only.** It runs immediately, then on a
  coarse six-hour singleflight interval, honors the current retain-days setting and scans the
  uncapped attachment catalog instead of an arbitrary first 5,000 directories.
- **Goal configuration is internally consistent.** Recording-off forces Goal off instead of
  persisting a combination that cannot ever supply a transcript. A specific goal can still open a
  New Chat and become its first user message, but an unsent opening goal is never attached to an
  unrelated existing chat navigated to while the provider request is in flight.
- **The stock Goal continuation prompt is slightly more persistent.** It now continues while a
  concrete requested task or question remains unreported/unanswered and stops only when ChatGPT
  clearly presents the whole requested job as complete. It still treats an explicit all-done claim
  as authoritative and does not invent extra testing, polish or follow-up. Existing installs whose
  saved prompt is byte-for-byte the old stock default migrate automatically; edited prompts do not.

### Fixed
- **Quitting always quits.** Quit could hang forever: the app kept running with its window and
  tray already gone, still holding the single-instance lock, so every later attempt to start Chat
  On Steroids silently did nothing and the only way out was Task Manager. Two independent faults
  produced it. The first was logging: Electron keeps a `BrowserWindow` object after destroying the
  window, so the renderer push read `webContents` off a corpse and threw — and because log
  listeners run synchronously on the writer's stack, every teardown log line threw into the
  teardown step that wrote it. The MCP drain's force-close timer died on its own warning before it
  could force anything, leaving the app draining a half-closed tunnel socket with no deadline left
  to save it. The second was the quit itself. Teardown ended by calling `app.quit()` from the
  promise continuation that finished it, and Electron drops a quit raised from there: measured on
  Windows, that call returns without even emitting `before-quit`, while the identical call one
  macrotask later quits normally — so a clean, fully drained teardown still ended in a process that
  would not leave. Renderer pushes now check for a destroyed window, a failing log listener can no
  longer break the code that logged, the two force-close paths act before they report, and teardown
  is both bounded and terminal: each phase has its own budget, and the sequence always ends in
  `app.exit(0)`, which has no such veto.
- **Quit no longer pauses for fifteen seconds on the extension's own connection.** The bridge
  swept for idle connections once when it stopped, which cannot see the request that is in flight
  at that instant — and the extension polls constantly, so on a real quit there almost always was
  one. That socket returned to keep-alive idle when its response finished and nothing looked
  again, so every quit waited out the full 15s force timeout. The drain now keeps sweeping, and
  retires the socket the moment its request is done.
- **Terminal sessions no longer outlive the app on Windows.** node-pty's ConPTY backend reports a
  pid of `0` until its console pipe connects, well after the spawn path recorded it, so every tty
  session carried pid `0` for life: `list_processes` advertised a pid nobody could act on, and
  termination skipped `terminateProcessTree` under its own `pid > 0` guard — leaving the shell and
  its console host alive whenever node-pty had deferred its internal `kill()`. The pid is now read
  live, and terminating every session at once skips the ones already gone, runs the rest
  concurrently and no longer abandons the queue behind a single rejection.
- **Crash recovery no longer trusts stale `meta.json` over newer durable history.** Read-only
  session listing, handoff lookup and normal reopen paths reconcile event/message high-water state
  without incorrectly marking historical sessions live.
- **Request-correlation freshness now behaves like LRU rather than FIFO.** Re-observing a still
  active request id refreshes its bounded-map order as well as its timestamp, preventing exact
  ownership from being evicted behind genuinely stale ids.
- **Expired continuations and worker revivals cannot manufacture a fresh lifetime on restart.**
  Recovery settles the durable broker/continuation half before pruning transport state and uses a
  plan -> reconcile -> one durable rewrite -> publish transaction so overlapping traffic cannot
  persist a half-restored generation. Duplicate same-worker revival rows select the newest valid
  transport before expiry is applied.
- **Bridge stop/start no longer leaves stale singleton callbacks active.** Spawn/revive/swarm-end
  listeners are disposed with the bridge; workers created or woken while the bridge is stopped are
  replayed only after a fresh start owns the callback again. Retained leased commands also have
  their original deadline re-armed after restart.
- **A worker wake cannot be duplicated by browser/MCP overlap.** Existing-tab reuse claims the
  command before the fallback tab is removed; in-flight MCP calls across the revival ACK cannot
  consume/re-offer the wake text; wrong-chat and stale-run ACKs fail closed; lost ACKs replay from
  durable receipts rather than typing a second user message.
- **Worker finalization retires the right delivery state and preserves final reports.** A settled
  reusable worker sleeps instead of becoming terminal, stale offered inbox rows do not reinject on
  the next wake, detached silent workers are maintained periodically even without another MCP
  ingress, and the run is not released while a final worker report still needs delivery.
- **App-side browser Disconnect now means disconnect.** The extension cannot silently pair itself
  again on the next request; only an explicit browser Connect/Retry clears the durable intent latch.
- **Recovery extension downloads are pinned to the installed app version** instead of following
  `releases/latest` and potentially manufacturing an app/extension protocol mismatch.
- **Historical Overwrite no longer fights ChatGPT virtualization while the user scrolls.** Scroll
  input temporarily freezes presentation rewrites and the first idle repaint anchors/compensates
  the actual transcript scroller, keeping the visible historical turn stable.
- **Final assistant turns are recorded and noticed more reliably.** Hidden/background tabs react
  immediately to the generating -> quiet edge instead of depending on a throttled transcript
  debounce; Stop removal outside the transcript wakes the recorder; and when healthy Fiber omits
  `end_turn`, a fresh completed-message action may close the exact terminal sibling only after the
  quiet window, settled calls and generation ownership all agree. Old Copy buttons, Retry/reused
  turn ids and earlier siblings cannot certify newer prose.
- **A transient `interrupted` marker no longer holds a separately proven final response open until
  the user types again.** The recorded outcome remains interrupted, but exact terminal action
  evidence can provide the missing boundary. User-pressed Stop remains excluded from Goal.
- **Only the exact terminal Fiber message is promoted to final.** Commentary or other interim
  assistant rows remain streaming when a turn ends without terminal evidence, and live assistant
  chronology uses the local observation clock rather than a skewed ChatGPT `create_time`.
- **Image/file attachment ids no longer make a real user-text anchor ambiguous.** Overwrite joins
  only against durable authored user-message ids, preventing attachment objects in the same turn
  from splitting or misrouting reconstructed activity.
- **Recorder takeover now removes every ownership channel.** In addition to DOM/window listeners
  and MutationObservers, the predecessor unregisters `chrome.runtime.onMessage` and
  `chrome.storage.onChanged`; an `alive=false` recorder cannot answer a health/revival message or
  repaint after its successor owns the document.
- **Browser journal loss markers keep exact routing identity.** Queue pressure/rejection gaps retain
  the source conversation/provisional/agent/command route instead of borrowing another entry's
  identity, and losses are bucketed per route rather than collapsed across chats/workers.
- **`view_image` no longer serializes the same base64 twice.** Native MCP image content is the one
  transported copy, allowing the full bounded image budget without redundant structured output.
- **Desktop output is bounded where it previously was not.** Clipboard reads are capped per action
  and in aggregate; `observe what=windows` uses bounded `max_elements`; partial action batches
  report the exact completed count and failing index.
- **Ordinary MCP Disconnect cannot force-close an already accepted mutation before its response.**
  Endpoint stop drains gracefully by default; only final application shutdown opts into the
  bounded force-close deadline.
- **Renderer secret/settings races no longer erase newer user input.** API-key fields clear only
  after successful storage and only if they still contain the submitted snapshot; whitespace-only
  OpenRouter input cannot remove a stored key; rapid read-only/theme toggles derive from the latest
  requested settings snapshot rather than stale acknowledged state.
- **Setup and Chat history no longer pay repeated full metadata scans.** A process-lifetime summary
  catalog, bounded initial detail tail and sequence cursor deltas keep live refresh proportional to
  new work while preserving chronological paging across bursts.
- **Dead/unfinished paths were cleaned up.** The stale `--connect-on-start` self-update handoff was
  removed because no updater produces it, and seven file-local extension helpers with no normal or
  reflective caller were deleted.
- **`exec_command.cmds` no longer trusts command-authored text as batch framing.** Each batch now
  carries a fresh random framing id, so a command printing text that looks like an exit marker
  cannot close its section early and corrupt per-command failure classification.
- **A transient session-root filesystem error cannot poison the process-lifetime session index.**
  Only a genuinely missing sessions directory is treated as empty; `EBUSY`, `EACCES` and other
  scan failures fail closed and retry on the next lookup instead of making ownership, retention and
  latest-handoff discovery blind until restart.

### Validation
- Release-index gate on 2026-08-25: public-history privacy check and TypeScript typecheck passed,
  **50 committed Vitest files passed with 1580 passed / 1 skipped**, and `npm run build` produced
  the main, preload and renderer production bundles successfully. A broader local run that also
  included intentionally uncommitted standalone regression files passed as well.

### Known compatibility debt
- `exec_command` / `write_stdin` still represent command output in both the ordinary text content
  and the required structured Codex-compatible `output` field. Both copies are bounded, but
  removing either is an end-to-end contract change rather than a safe local optimization.

## [2.0.0] — 2026-08-24

The first release to carry the goal loop, and the release where the compiler stopped treating
unused code as a matter of taste. 2.0 supersedes 1.9.9, which was tagged in the repository but
never published.

The version number moves to 2.0 because of what changed underneath rather than what appears on
screen: three modules that production no longer reached were deleted outright, `exec_command`
started refusing shell text it previously ran against the wrong filesystem dialect, and two
process launchers stopped handing connector credentials to their children. An integration built
against the removed internals, or against the old pass-through behaviour, will notice.

### Added
- **`noUnusedLocals` and `noUnusedParameters` are on permanently.** They were what surfaced the
  dead code below, and leaving them optional is what let it accumulate.

### Removed
- **`patch.ts`, `patch-files.ts` and `process-manager.ts` are gone**, with their suites. Codex's
  applier and the desktop helper's retirement barrier had already taken over both jobs; what
  remained was a second implementation nothing called, which is the kind of thing that gets
  edited during an incident because it looks live.
- Unused production imports, dead editable-text snapshot and encoding helpers, a dead line-count
  wrapper, and two dead MCP formatting exports.

### Fixed
Full write-up, defect by defect, in `docs/bughunt-follow-up-2026-08-24.md`. Credible leads that
were reviewed but not reproducible enough to fix are tracked privately rather than published, as
`SECURITY.md` and the documentation rule in `AGENTS.md` require.

- **A patch that moved a file onto itself deleted it.** `apply_patch` writes the destination and
  then removes the source, so equivalent spellings — `source.txt` and `./source.txt` — wrote the
  new contents and immediately unlinked them. Move verification now compares resolved identities,
  case-insensitively on Windows, and refuses the whole patch before anything is mutated.
- **A workspace-relative glob starting with `*` searched a virtual root instead of the chat's
  workspace.** With no literal prefix before the first wildcard, the walker substituted `/`, so
  `*.ts` and `**/*.ts` quietly asked a different question and answered it successfully. An empty
  prefix now stays relative unless the pattern itself began with `/`.
- **`read` charged compressed image bytes against its output budget instead of the base64 it
  actually emitted**, so an image under the `view_image` ceiling could slip past the 512 KiB
  aggregate cap. It now charges the real payload, and a large image gets an explicit `use
  view_image` fallback rather than a truncated answer.
- **A malformed Goal SSE record could be typed into the composer as a finished reply.** Non-JSON
  `data:` records after valid deltas were ignored, and EOF then promoted the partial sentence to
  a message. A non-empty malformed record is now a protocol failure: the stream is cancelled and
  no draft is exposed. Comments, blank lines, role-only events and `[DONE]` are unaffected.
- **Three bridge routes used the capped UI list as an ownership index.** Manual Compact & Resume,
  automatic compaction and Goal draft startup all searched `listSessions()`, which is capped for
  display, so a valid older conversation came back `session_not_recorded`. All three now go
  through the durable attachment catalog.
- **Unsolicited state pushes erased Chat settings while they were being edited.** Home controls
  had a focused-dirty guard and the Chat sheet did not, so a connection or status push could wipe
  a half-typed compaction threshold, worker count or Goal setting. The Chat controls now apply the
  same focused-and-different rule.
- **`shell.openPath` failure was reported as success.** Electron resolves it with an error string
  rather than rejecting; the handler discarded the string and the renderer said the folder had
  opened. Any non-empty result is now an IPC error.
- **Virtual app paths inside shell text ran against the wrong filesystem dialect.** The sandbox
  had a bounded detector for this and nothing called it — PowerShell reads `/workspace/file` as a
  drive-root path, not the app's approved virtual root. `exec_command` now refuses approved
  virtual-root tokens and names the two fallbacks that work. URLs, language fragments and
  unapproved `/name` tokens are left alone.
- **A post-start desktop-helper error released the input queue before the helper was retired.**
  Malformed replies, write failures and timeouts already waited for the process tree to die; the
  child's `error` event rejected immediately, so a replacement could start while a broken helper
  still held desktop-input authority. That path now shares the retirement barrier.
- **Renderer redirects were not vetoed.** Both Electron guards blocked `will-navigate` and
  neither blocked `will-redirect`.
- **`swarm:clearAgent` accepted any string** — arbitrary length, control characters — before
  handing it to the global broker. The IPC boundary now requires 1–64 alphanumeric or hyphen
  characters.
- **Fiber skipped readable assistant sections that had no `data-turn-id`.** The selector required
  the attribute although the state machine handled `turnId: null`; the fixture installed an empty
  attribute instead of omitting it, so the gap was never exercised. A second logical-id collision
  could also swallow a distinct message, and now falls back to the raw message id marked
  unstable — trading reload durability on that one ambiguous row rather than dropping a message.
- **`execRecoveryHints` blamed causes the command did not contain**, suggesting backslash quoting,
  glob expansion or `&&`/`||` fixes for commands with none of them, and printed `Command failed  a
  command` with a doubled space.

### Security
- **Tunnel children inherited ambient connector credentials.** The OpenAI tunnel client spread raw
  `process.env` and cloudflared inherited the environment implicitly, so starting Electron from a
  credential-bearing terminal passed unrelated provider secrets into both. Both launch paths now
  use the shared `childEnv()` scrubber, and the OpenAI path adds back only its own control-plane
  key, the local MCP URL and its discovery headers.

## [1.9.9] — 2026-08-24

### Added
- **The goal loop.** A second model reads each finished ChatGPT answer and writes your next
  message for you, until it decides the thing you asked for is done — at which point it writes
  nothing at all. Off by default, and it needs an OpenRouter API key, which is the one
  credential in this app a *model* can cause to be spent.

  The work is split where the trust boundary is. The page owns the one judgement only a browser
  can make: that the turn is really over. It is the same four-signal barrier a compaction brief
  waits on — the stop control gone, the answer no longer growing, the tool rail still, and the
  app reporting no local call open — held for eight seconds, because a reply that fires early
  types "what about the tests" into a chat that is still in the middle of writing them, and the
  model then answers it as if it were a correction. Everything after that is the app's: the
  context, the key, the request, and one draft per generation.

  What leaves this machine is only the user's messages and ChatGPT's final answers. Not tool
  calls, not their results, not the interim commentary a turn produces while it works — a
  recorded session holds file contents and command output, and none of that is anybody's next
  chat message. The model is asked to write the way you write: lowercase, casual, one message.
  When the goal is met it answers `NO_REPLY` and nothing is sent.

  The reasoning level is selectable (default/minimal/low/medium/high) and the model is chosen
  from OpenRouter's own catalogue, newest release first, twenty at a time — fetched when you
  open the picker rather than when you open the settings.

- **A settings sheet on the ChatGPT composer.** The compaction button is a gear now. Hovering
  still says what is on in one line — `Auto-compaction on, from 300k tokens` / `Goal on` — and
  clicking opens a small sheet in ChatGPT's own type, hairline and radius, with a switch each
  for automatic compaction and the goal loop, and *Compact & resume now* as the sheet's single
  action. The switches write to the app and paint what the app answers back, never optimistically,
  because the app's own settings window can change the same two. With no key stored, the goal
  row reads `OpenRouter API key essential for goal feature`.

- **The panel above the composer says what the loop is doing** — checking the answer is
  finished, sending it to OpenRouter, the model's reply streaming in as it is written, then
  either the message about to be sent or `Goal reached · nothing was sent`. A failure shows its
  code (`out_of_credit`, `auth_rejected`, `rate_limited`, `http_502` …) rather than going quiet.

- **`ultrathink` on the worker bootstrap.** A worker is the one agent here that gets a task with
  no conversation in front of it and no chance to ask a clarifying question, so the one thing
  worth spending a token on is asking it to think before it starts.

### Fixed
Full write-up, with what each defect actually did, in `docs/bug-audit-2026-08-23.md` and
`docs/bug-audit-2026-08-24.md` — the second pass audited the merged tree for ordering at the
crash, reload and navigation boundaries, where several of these were correct a second later and
wrong at the moment a caller decides whether its operation happened.

- **A patch that touched one file twice was refused, though the applier behind it would have
  taken it.** `apply_patch` runs Codex's verifier as a pre-flight gate in front of Codex's
  applier, and the two disagree about a patch whose hunks name one path more than once. The
  verifier keys its preview by path and rejects the repeat outright with `multiple operations
  target …`; `apply_hunks_to_files` walks the hunks in order and writes each one before it reads
  the next, so a file updated twice — or rewritten as a delete followed by an add — applies
  exactly as written. Upstream never has to reconcile them because that verifier was built for an
  approval UI, where a repeat would silently drop an entry from the list shown to the user.
  Nothing here shows that list; the gate just refuses. Three of seven hundred and two recorded
  patch calls died that way: one test file carrying two `*** Update File:` headers where one
  header with both `@@` chunks was required, and two documents the model meant to replace
  wholesale.
- The gate itself earns its place — it is what makes a patch whose last hunk has stale context
  fail before the earlier hunks have been written, which is the difference between a refusal and
  a half-patched tree — so it now stops disagreeing with the thing it gates rather than being
  removed. Verification carries what each earlier hunk would have left at a path, and every later
  hunk on that path reads from there instead of from disk: the dry-run equivalent of the write the
  applier does in between. A repeat is refused only where the applier would also have failed, with
  the reason it would have failed — an update after the patch deleted the file, or a second hunk
  whose context is stale against the first one's result, both of which are now reported as what
  they are. This is sequential and not a merge: the second update may edit a line the first one
  inserted, and may sit earlier in the file than the first, both of which the single forward cursor
  shared by chunks under one header would refuse.
- **A diff capped with `Select-Object -First` was reported as a failed command.** The stage stops
  the pipeline the moment it has its N objects, which kills the program still writing into it and
  leaves a non-zero status behind — `git diff | Select-Object -First 5` exits 1 where the same
  `git diff` exits 0, and whether it bites at all depends on how much the program had left to
  write. One worker capped a four-file diff at 220 lines, got 383 lines of correct diff under
  `Process exited with code 1`, and ran it again. The exit is now called what it is, but only
  where nothing else could have caused it: the pipeline has a truncating stage and no stage that
  could have set the status itself, the generator is a git subcommand that only reports and
  carries no `--exit-code`, `--quiet` or `--check`, and the run printed something without printing
  a `fatal:`. Rule out the cut and there is no way left for that command to have exited 1. A test
  run capped the same way is untouched, which is the case this must never get wrong, and the note
  hands over `-Wait` as the way to keep the status meaningful.
- **A search that named one missing path threw away the answer for the others.** ripgrep given
  three files where one does not exist prints `os error 2` for that one, prints every match from
  the two that do, and exits non-zero. A prime agent read the status, dropped the matches, and
  went looking again — for a file it had misspelled by one directory. The output now carries a
  note saying which path was missing and that the rest is a complete answer for the paths that
  exist. Distinct from the unexpanded-glob note above it, which is `os error 123`: a path that
  could not exist, rather than one that merely does not.
- **A bash-style escaped quote made PowerShell refuse the whole line.** A backslash escapes
  nothing in PowerShell, so `rg -n "a|state === \"starting" src` ends its argument at the
  backslash and the shell rejects the line with `TerminatorExpectedAtEndOfString` — running none
  of it, including the `git diff` two statements earlier on the same line. In one recorded
  session that was two of a worker's forty-six calls, each returning 49 tokens of parser error
  that never mentioned the escape character. Such an argument is now re-quoted with single
  quotes before it runs, but only where the line provably does not parse as PowerShell, does
  parse under bash's rules, and parses again once repaired. The backslash itself is kept: the
  two escapes PowerShell does accept both parse and then hand the program the quote stripped and
  the following argument swallowed into the first, which was verified against the shell — a
  wrong answer reported as a successful one is the thing this must never do. A body holding
  `$`, a backtick or a doubled backslash is left for the shell to refuse, with a new hint that
  names the cause.
- **A search that found nothing still read as a failure.** The classifier that knows exit 1 from
  `rg` is a result and not an error was spent only on the session's error count, so the model
  still saw `Process exited with code 1` under an empty body and re-ran searches that had
  already answered. It now says so in the result itself, for both shapes that produce it: no
  matches, and a pipeline stopped early by `Select-Object -First`.
- **The settings sheet pushed its own controls off the right edge.** `.pane` is a grid, and a
  grid with no explicit column gets an implicit `auto` track — which is floored by the widest
  child's min-content width. The settings rows carry `white-space: nowrap` hints, so that floor
  was the whole sentence: measured at the window's own 1080px the track came out 724px inside a
  674px content box, and the card clips rather than scrolls sideways. Every row overhung by 50px,
  which ate the compaction switch, the goal switch, the units and the end of "Select model". The
  column is `minmax(0, 1fr)` now, so the rows yield the way they were always written to.
- **"Default" was a 708px dropdown.** The Reasoning select inherited the `width: 100%` written
  for the stacked fields in `.field`, and in a flex row that made a five-word menu as wide as the
  sheet with its own label squeezed to nothing. A dropdown in a settings row is now as wide as
  the word it holds, and the row's button no longer shrinks ahead of the explanation beside it.
- **Two buttons that opened nothing.** `link:open` is an allowlist, so a URL missing from it does
  not open the wrong page — it throws in a handler nobody watches and the button is simply dead.
  "Open OpenRouter keys" had never been added, and "Open Apps" broke when ChatGPT renamed that
  page from Connectors and the markup followed while the allowlist did not. Both work; a test now
  holds every `data-link` in the window against the allowlist, which is what caught the second.
- **The model picker stopped at twenty.** Scrolling the catalogue to the bottom loaded
  nothing: paging was only ever on the "Load 20 more" button below the list, which is not
  where anyone looks when a scrollable list runs out. The list pages itself now, a screenful
  before the end, and the button still works for anyone who prefers it. The repaint was the
  other half of it — the list is rebuilt whole on every page, and emptying an element scrolls
  it back to the top, so even once it paged it threw the reader back to the newest model.

- **The goal loop armed itself in worker chats.** The switch is one setting, but it is the
  prime's. A spawned worker already has an author for its user turns — the prime, through the
  agents tool — so a second model typing into it as well made the worker answer a question its
  prime never asked and finish against that instead, with every worker in the run spending
  OpenRouter credit in parallel on drafts about to be overridden. The loop is now on for the
  prime and for an ordinary chat that is no part of a run, and off for every worker.

- **The default model was a snapshot from April, and the newest ones could not be saved.**
  OpenRouter publishes twelve ids beginning with `~` — family aliases that always resolve to
  the newest model in a family — and the picker lists them because the catalogue does. The
  validator behind *Save* did not allow the character, so the one kind of entry most worth
  choosing was the one kind that reported an error and left the model where it was. The
  shipped default was `deepseek/deepseek-v4-flash`, which reads like "the flash model" but is
  published as V4 Flash 0423; two newer revisions existed by August that the default could
  never have reached. It is now `~deepseek/deepseek-v4-flash-latest`, which cannot rot the
  same way and is the cheaper of the two at $0.04/M prompt against $0.057/M.

- **One ChatGPT answer could be drawn twice, one copy per section.** Overwrite reconstructs a
  response from the user message that caused it, so every assistant section between that
  message and the next one resolves to the same reconstruction. Sections that carry a turn id
  are folded into one logical turn first; sections ChatGPT renders *without* one — which some
  builds do permanently — were not, and each of them painted the whole answer into itself,
  stacked down the page with ChatGPT's own copy hidden underneath each. The first section to
  claim a reconstruction now owns it, and the rest of the response stays behind it.

- **The settings popup and the hover bubble had no fade at all.** Both asked for a
  `clf-pop-in` animation by name and nothing ever defined it. A CSS `animation` naming
  keyframes that do not exist is not an error — it is simply nothing — so the two surfaces
  snapped into place at full opacity beside a page whose own popovers fade. Nothing in a
  browser will ever report this, so a test now asks the stylesheet instead: everything it
  animates, it defines.

- **The goal loop went quiet instead of saying it had given up.** Two of the watch's dead ends
  — an answer with no text in it to continue from, and a turn that never stopped changing
  inside the five-minute ceiling — simply removed the panel, which from the outside is
  indistinguishable from a loop that never ran. Both now say what happened. The failing paths
  also keep the step they failed in rather than collapsing into one `failed`, so a run that
  stopped is drawn where it stopped.

- **A second chat inherited the first one's goal state.** None of the loop's state was cleared
  on navigation, so opening another chat drew the previous one's phase and error above its
  composer — "The goal loop stopped", about a conversation no longer on screen — and carried a
  finished turn's id across as the id the new chat must not draft twice.

- **A retired swarm's worker command could be adopted by the next run.** Worker bootstraps were
  identified by `worker:<agent>`, and `worker-1` is what every run calls its first worker — so a
  durable command left over from run A matched run B exactly, and run B inherited A's task, A's
  command id and A's lease. Commands now carry the broker's run id, dedupe on it, retire when
  their run stops being current, and refuse to be queued outside a run at all. Worker rows from
  the older journal versions are dropped on restore rather than migrated: nothing on disk says
  which run owned them, and the restored broker re-requests anything it is genuinely owed.
- **Lost-ACK worker recovery trusted a label the page chose.** Binding a conversation to
  `worker-1` on the page's own say-so is authority handed to anything that can say `worker-1`.
  The page must now also present the exact command id it redeemed, honoured only against a
  still-leased command of the current run.
- **`session` told a model its history did not exist.** When this app could not place a call in
  a conversation — a request id that never resolved inside the evidence window — `action=history`
  answered *No recorded session is available*, which is false and a dead end: the model concludes
  there is no history and rebuilds the work from the filesystem, which is what happened on
  2026-08-23 against a recording hundreds of events long. It now says what actually happened and
  lists the recordings, so the next call can name one. `action=status` does the same, and a
  history search that matches nothing names the other recordings too — a search that finds
  nothing here is often aimed at the wrong session, since a compacted chat's work lives under the
  id it inherited.
- **`exec_command` could hand a recycled process id to its previous owner.** Process ids are
  small and reusable and ownership lives in a separate registry, so an evicted process could
  leave its owner row behind and let the old chat write to or interrupt the new chat's process
  during the new call's first yield. The row is cleared at the allocation boundary now.
- **A desktop click could land on a screen nobody had looked at.** `frameId` was "strongly
  recommended"; without it, coordinates were applied to whatever the latest global frame happened
  to be — and another chat or agent can replace that frame between the screenshot a caller saw
  and the click it sends. Coordinate actions now require it (`FRAME_REQUIRED`). Semantic refs
  resolve the real control at action time and are unaffected.
- **One unknown reasoning level would have wiped every root and permission.** A rejected enum
  fails the whole settings parse, which collapses the file to conservative recovery. The set of
  levels is a provider's vocabulary, so a config written by a newer build is a case this app will
  meet; it falls back now, exactly as a blank model id is repaired rather than refused.
- **The goal loop would never stop waiting for a composer somebody was using.** Its two-minute
  patience was measured from a timestamp that every retry reset, so it could not expire and the
  draft would have retried for as long as a half-written message sat in the box.

- **A worker's message could reach disk before its sender was told it had been accepted.** The
  broker stages a message and hides it from the recipient until the immediate write succeeds, but
  `changed()` also kicks the ordinary debounced snapshot, and that snapshot still contained the
  staged entry. Its 300ms writer could therefore land while the acceptance write was still held or
  about to fail, so a crash in that window restored a message whose sender had been told nothing —
  or had been told it failed. The broker has two structurally separate views now: the public
  debounced snapshot excludes unpublished messages, and only the private one behind the immediate
  write includes them. A failed write rolls the staging back and emits a committed-only revision,
  so the writer's own generation ordering supersedes the rejected work rather than resurrecting it
  on a later retry.
- **A worker's bootstrap command could be retired before the binding it created was durable.** The
  page redeemed its command, bound its conversation in memory, and ACKed — and a crash between the
  receipt and the swarm fsync left neither a command to replay nor a binding to recover from.
  Persistence comes first now: the ACK may replace a leased worker command with its receipt only
  after the critical snapshot succeeds, and if that write fails the ACK is retryable and the
  command stays redeemable.
- **A worker's final report could be acknowledged before the state carrying it was durable.**
  `/events` recorded a worker's last message, finished the conversation, queued the exact
  worker→prime report and answered 200 — while the terminal broker state behind it was still on
  the debounced writer. The extension retired its observation on that 200, and a crash restored
  the worker as active with the exact result gone, leaving the orphan path to manufacture generic
  completion text in its place. The barrier is crossed before the browser is acknowledged; a
  failure is a retryable 503, which keeps the observation available for replay.
- **A reused worker id could inherit the previous run's project folder.** Worker workspaces are
  keyed by a stable short name like `agent:worker-1`, and `inheritWorkspace()` did nothing at all
  when the new prime had not learned a workspace yet — so the old value under that reused key
  survived into the next run, and a relative path resolved against the previous run's project.
  Inheritance has replacement semantics now: reusing an id clears that worker's old workspace
  first, and the prime's is copied only when there is one.
- **A restored worker could be opened twice, or reopened after it had finished.** Two crash
  windows survived in the journal: a worker bound to a conversation but still recorded `invited`,
  which restore treated as owing a fresh chat, and a once-detached worker persisted as `finished`
  while it still carried `revivable`, which let terminal work reopen. Restore repairs the first,
  a finished worker is never revivable, and binding and activation are one persistence transition
  rather than two.
- **A run could be released while a message was still committing.** Staged worker messages are
  deliberately invisible to the ordinary pending counts until their durability barrier succeeds,
  and `releaseQuiescentRun()` consulted exactly that visible count. In a parallel finish and report
  ACK the visible work could reach zero and destroy the run while a staged `agents action=message`
  was still waiting to commit — and its sender would then be handed success for a message attached
  to a broker that no longer existed. Unpublished messages count as outstanding work for release
  while staying hidden from delivery.
- **An upgrade could restore the weak run fence it had just replaced.** Run identity moved from
  short random hex to a UUID without a snapshot version bump, and restore trusted any `runId` it
  found — so the obsolete 32-bit incarnation id came back and was used to fence fresh durable
  worker commands. A restored run id must satisfy the current UUID-v4 shape; a legacy snapshot is
  re-keyed to a fresh one with its agents, queues and unfinished bootstrap obligations intact.
- **Handoff recovery stopped looking after 5,000 sessions.** `latestHandoff()` promises to search
  every recording, but it reused a directory scanner whose 5,000-entry cap exists for bounded
  maintenance work. Past that count the newest handoff could sit outside the scan, and recovery
  answered with an older one or with nothing. Recovery has its own uncapped summary scan; the cap
  stays where it belongs, on pruning.
- **One state file that failed to write took every later one down with it.** `flushDurable()`
  rejected on the first named file that failed, so at shutdown a broken `swarm.json` write could
  stop an unrelated continuation, correlation or bridge snapshot queued behind it from being
  attempted at all. A shutdown pass now attempts every pending file, preserves failed generations
  for the retry machinery, and surfaces the first real error after the independent writes have run.
- **A restart could answer a completed command's retry with "gone".** The bridge snapshot is
  version 3 and carries the command receipts that resolve a lost HTTP acknowledgement, but restart
  recovery accepted receipts only from version 2. A command whose operation and receipt were both
  durable therefore answered an exact post-restart retry as though it had never happened, instead
  of replaying its committed result. Recovery accepts the current shape as well as the compatible
  older one.
- **Compaction work could follow the tab into a different chat.** Settle and watch work waits on
  tools and browser state, and the browser can navigate A → B, or A → B → A, while it waits. The
  conversation id alone cannot see the second case — the id is the same again while the document
  is not — so stale work could continue against the new document and submit a handoff into the
  wrong navigation. Compaction is fenced by conversation id *and* navigation epoch; navigation
  clears stale capture state, and a cancellation retires its capture before crossing any later
  wait rather than leaving something able to complete after it was abandoned.
- **A rejected handoff was already published as the latest one.** `createHandoff()` wrote the
  handoff file and appended the session `handoff` event before the continuation WAL moved from
  `awaiting-summary` to `awaiting-chat`. When that WAL write failed the continuation correctly
  stayed retryable — but `meta.lastHandoffId` had already exposed the rejected brief to every
  unrelated recovery caller, and the retry could then write a second one. Capture is a two-store
  transaction with explicit ordering now: prepare the file, durably publish the continuation state
  carrying its id, then publish the session event. The opposite crash window — WAL committed,
  session event missing — is repaired idempotently at restart.
- **Goal could send a draft after the switch was off.** The page checked the setting before
  starting a draft, but an OpenRouter request already in flight could come back ready after the
  user switched the feature off, and the send path typed it in anyway. The send boundary rechecks
  the current setting before touching the composer, and the app acknowledging an in-progress draft
  now aborts its request so a cancelled draft stops spending the key.
- **A lost acknowledgement could send the same message twice.** ChatGPT accepting a message is
  irreversible; `/goal/ack` is a fallible local hop. If the send landed and the ACK did not, the
  app correctly re-offered its unacknowledged draft after a reload — and the browser had no record
  that it had already spent that token. The content script writes the conversation and draft token
  into a small bounded `sessionStorage` receipt the moment ChatGPT accepts the send, before it
  tries to ACK, so a reoffered token retries only its acknowledgement. The other half was the
  ten-minute expiry, which deleted the whole draft and with it the key that made this safe: expiry
  retires the visible payload but keeps the turn and token as an acknowledged tombstone until a
  genuinely newer generation supersedes it.
- **Goal could pay for a decision that did not include the answer it was reacting to.** The
  content script accepting an observation means it is durable in the extension's journal, not that
  the app has it. With `/events` mid-retry, a finished answer could trigger a draft and the
  background worker would call `/goal/draft` straight away, against a session still missing that
  answer. Goal joins any in-flight drain and gives its conversation priority until the worker can
  prove there are no accepted-but-undelivered rows for it; if delivery cannot be established it
  returns a retryable `transcript_not_delivered` and never calls the route.
- **A cancellation could retire the wrong generation.** `/goal/ack` also took `cancel:true`, and
  that branch ignored the draft token it was given and cancelled whichever draft happened to
  occupy the conversation — so a delayed cancel from one generation could retire the next. No
  current content code used it. The unkeyed branch is deleted; retirement has one protocol, the
  conversation plus the exact token, which already aborts in-flight provider work and keeps the
  tombstone.
- **A provider could hand this app an unbounded body.** Goal read error responses with
  `response.text()` and the model catalogue with `response.json()`, buffering whatever arrived
  before reducing it to a short status or a picker list. Both go through a streaming byte-bounded
  reader now, enforcing the declared length *and* the actual bytes — 64KiB for a diagnostic
  failure, 8MiB for the catalogue. The cache holds at most 5,000 models, an id over 500 characters
  is refused rather than truncated into a different identity, and display names are capped.
- **The model catalogue outlived the key it was fetched with.** The cache was not scoped to the
  credential, so replacing a restricted key kept the previous key's catalogue for the rest of the
  TTL. It is keyed by a one-way fingerprint of the credential now.
- **A stream that ended without a trailing newline lost its last record.** SSE parsing could drop
  the final record, or split a UTF-8 tail, when the connection closed on a boundary it did not
  expect. EOF flushes the decoder and the last buffered record.
- **A long answer's own revisions could crowd the conversation out of Goal's context.** Canonical
  recordings replace stable messages in place, but older ones can hold many append-only snapshots
  of a single ChatGPT message id, and `readRecentEvents()` counted every revision against its row
  cap — so enough revisions of one long assistant answer filled the whole recent window before it
  ever reached the user turn that answer belonged to. Newest-first scanning counts a stable legacy
  identity once and keeps walking back until it has the number of logical rows it was asked for,
  and Goal collapses same-kind, same-id legacy rows defensively, keeping first chronology with
  newest content and leaving id-less rows distinct.
- **Connect and Connecting could describe resources that were not running.** Four lifecycle
  defects, one surface: after a disconnect a connector card could keep the dead tunnel's `live`
  state and public URL; a terminal report such as `tunnel-unavailable` left the card reading
  "Connecting" forever; changing the active Core transport while connected could leave the old Core
  running while settings and Desktop had already moved to the new one; and the pre-connect folder
  gate disagreed with surface availability, refusing a clipboard-only Desktop setup that needs no
  filesystem root at all. Presentation is rebuilt from the endpoint actually running, terminal
  reports map to a surface error, a Core-affecting change performs a serialized reconnect while a
  Desktop-only tunnel change stays hot-swappable, and the gate uses the same usefulness predicate
  as publication. Connect, disconnect and applySettings are serialized and tunnel callbacks are
  fenced by a connection generation, so a late report from a stopped tunnel cannot repaint the
  connection that replaced it — and the button's own label and action read the same running states
  as the lifecycle owner, so a fast double click cannot become two tunnel stacks.
- **Desktop discovery could freeze Core's tool shape before Core had been asked.** The two share a
  loopback listener but are separate discovery units, and one global exposure snapshot let a
  Desktop discovery fix Core's mutually exclusive `find`-versus-exec choice on Core's behalf.
  Exposed capabilities, features and that choice are monotonic per surface now, which is the
  boundary ChatGPT actually caches.
- **A chunked request had no size limit before it was parsed.** The Content-Length guard did not
  cover chunked or length-less POSTs, so the adapter could concatenate an arbitrarily large body
  and then hand it to the JSON parser. Those requests go through an explicit 8MiB bounded
  collector; bytes past the limit are drained without being retained and answered 413, and
  malformed bounded JSON is answered 400.
- **A history search could report a match and then not show it.** The selector built a small
  neighbourhood around every hit by walking forward from two events before it, and stopped as soon
  as the presentation cap was full — so with `limit: 1` a real hit at event 7 could be answered as
  "1 match" while the response contained event 5 and not event 7 at all. Direct matches reserve
  the budget first; what is left is filled with nearest context in rings and sorted back into
  chronological order.
- **`session` declared itself a writer, and capped recovery below what it can store.** It exposes
  `history` and `status`, both inspection, but advertised `readOnlyHint: false`, so a client could
  reasonably apply write or confirmation semantics to reading this app's own recording. The second
  was arithmetic: a recorded call can legitimately spill around 16MiB across argument and result
  overflow, while the schema stopped `history(call_id)` at part 200 — a valid part 200 could
  instruct the model to ask for 201 and the schema would refuse it. It is marked read-only, and
  the maximum part is derived from the real overflow ceilings rather than a constant that had
  drifted away from them.
- **A migrated root could collide with the reserved namespace.** Legacy and migrated roots could
  land on a reserved virtual name — `/skills` notably — or on another root once names were
  normalized, leaving an ambiguous virtual path. Migration and live rename preserve unique safe
  names, and a live rename into the reserved namespace is refused.
- **`exec_command` rebuilt only PATH.** It started from the raw parent environment with PATH
  replaced, rather than from the sanitized child environment every other spawn here uses, so
  connector and API secrets were not stripped from it. It starts from the shared sanitized
  environment now, which also keeps the bundled ripgrep path and the system paths intact.
- **A read that touched nothing counted as a read that worked.** Multi-read telemetry counted
  targets it never attempted once the output cap was exhausted, and an explicit read whose every
  target failed came back as a successful response full of `ERROR` sections. Only paths actually
  attempted successfully are counted, and the all-failed case is an error.
- **Relative paths could resolve against another chat's root.** Identity-sensitive relative and
  default-workspace operations fell back to another root or chat when the exact calling
  conversation could not be proven. In an active swarm they fail closed instead.
- **A dying page could reopen its navigation lease while its replacement was loading.** Direct
  navigation marks the old document terminal before the new one registers, and the old page can
  still emit a delayed message on the way out. The recovery heuristic read any mismatch with the
  registered document as proof that the terminal prediction had been wrong — even while Chrome was
  reporting a `pendingUrl` for a new ChatGPT document — which let the dying A document reopen its
  lease in the middle of A → B. A terminal prediction is overturned only once Chrome proves the
  original document is settled again; a genuinely speculative one still recovers when the tab is
  stable.

### Changed
- **The compaction window defaults to 400k estimated tokens**, up from 300k, with the red line
  following it to 533k. 300k was set as the point with comfortable room left to compact, and in
  use it turned out to be early: chats sat amber and compacted themselves while nothing was
  wrong with them, and every one of those cost a fresh conversation. 400k is the figure the
  ceiling has actually been observed near, and the trigger has been edge-based since 1.8, so the
  turn that crosses the line still finishes and still writes its handoff.

  It reaches existing installs, not just fresh ones. `auto: true` at 300k is what 1.8 wrote for
  itself, so a config still carrying exactly that moves; the meter's own 300k/400k pair moves
  with it. Any threshold somebody typed stays exactly where they put it, and nothing moves back
  down — a config already at 400k keeps it, however it came to be there.

- **The panel above the composer has a progress bar with named stages.** *Answer settling ·
  Reading the chat · Writing the reply · Sending*, one segment each, filled up to where the
  run is and with the segment being worked on the only one that moves. A caption on its own
  answers "what now" and never "how far", which is exactly the distinction between a run that
  is slow and a run that has stopped — and where a stopped run stopped is now visible rather
  than inferred from which sentence it froze on. Built to ChatGPT's own measurements: a 3px
  track, the accent already used by the switches, labels at low contrast until they are the
  one running. Reduced motion fills the active segment instead of animating it.

- **The goal loop's messages are typed, not written.** Two things give a composed message away,
  and neither survives being asked nicely in a system prompt. The em dash is the first: it is
  not on a keyboard, and one of them in a lowercase two-line follow-up is the whole tell on its
  own. Every one is now replaced by what somebody typing that sentence would have reached for
  instead — a comma, usually; nothing at all when it opened a bullet; a hyphen between two
  digits, because that was a range. The second is that the message is *clean*, and real ones in
  a conversation like this are not, so one or two slips go in: a dropped apostrophe, a collapsed
  double letter, a transposed pair in the middle of a word. Never more than three in a message,
  spread so two never land in the same breath, and never inside backticks, a path, a URL or a
  file name, where a typo is a different instruction rather than a slip.

  None of it is random. One finished turn is one message, and that only holds if a retried
  request, a second observer and a reloaded tab are all handed back the identical string — so
  the choices are seeded from the draft itself and never from a clock. The `NO_REPLY` check
  still runs against what the model actually said, before any of this touches it.

- **The two legacy-heavy suites no longer carry 35 skipped tests.** Thirty of them asserted
  mechanisms that no longer own truth — DOM-row progress ownership, retired commentary
  reconstruction, old local generation heuristics, recorder behaviour that moved into the
  canonical session and Fiber layers — and were deleted rather than cosmetically re-enabled,
  because a skipped test for a dead architecture preserves neither coverage nor a specification.
  The five that still described live invariants were rewritten against the current Fiber and
  navigation-epoch model: a STOP before a new assistant section must not attach the new generation
  to the old one, commentary-only activity may bind the right section while Fiber supplies
  identity, extension-owned rendering must never feed back into canonical recording, an
  unexplained Stop-control dropout must not manufacture an `unknown` turn end, and work arriving
  after Stop reappears stays on the same local generation. The continuation suite was also built
  on synchronous helpers whose mutations were merely debounced, so it could stay green without
  ever exercising the WAL path production uses; it constructs and claims through the durable APIs
  now, and the dead synchronous exports are gone.

## [1.9.8] — 2026-08-23

1.9.7 was tagged and its installers were built and checksummed, but it was never published:
review found four more ways the same two mechanisms could still be wrong. The tag and its
artifacts stay where they are as the record of that commit, and this is the release.

### Fixed
- **Glob and brace expansion actually reach ripgrep again.** Binding a bare `rg` to the bundled
  binary and expanding its globs are two rewrites of the same command, and they were run in the
  order that cancels one out: binding replaced the leading `rg` with `& 'C:\…\rg.exe'`, and the
  normalizer, which recognises ripgrep by that leading token, then saw a command it had no
  opinion about. Every ordinary `rg pattern *.ts` went out unexpanded — the exact failure the
  normalizer exists to prevent — while both halves looked correct in isolation, which is how
  the unit tests missed it: each function was only ever called on its own. Expansion now runs
  first and binding composes on top of it, and the regression exercises the pair together.
- **`JAVA_HOME` is never pointed at a runtime that cannot compile.** Discovery accepted any
  directory holding `bin\java.exe`, and a JRE has one. `C:\Program Files\Java` with `jdk-21`
  beside a leftover `jre1.8.0_411` is what an ordinary Oracle install leaves behind, and name
  ranking falls back to text once two names stop sharing a digit run — so the JRE won, JAVA_HOME
  named it, and its `bin` went to the front of PATH. That is not a worse JDK, it is a broken
  Gradle build on a machine that had a working one. The probe is now for the compiler, so the
  answer is a JDK by construction, and a machine whose only Java is a JRE gets nothing rather
  than a confident wrong answer.
- **A failed command is quoted back in a form that can be run again.** The command echoed in
  `exec_command failed for …` escapes an apostrophe the way shlex does. It had been written as
  a double-quoted JavaScript `"'\''"`, which is three apostrophes rather than the intended
  quote-escape-quote, and three leaves the quoting unbalanced: `'it'''s'`. Glob expansion quotes
  every name it substitutes, so apostrophes in that string are routine rather than exotic.
- **The PowerShell native-search normalizer now fails closed whenever its parser cannot prove
  the command shape.** Backtick escapes are no longer split as if their escaped `;`, `|`, newline
  or whitespace were real syntax; bracket classes such as `a[12]*.ts` are not "expanded" with
  the brackets treated literally; and a leading dot follows shell glob rules instead of letting
  `*.ts` silently include `.hidden.ts`. Ripgrep option arity is no longer guessed from a hand
  table either: the known option set comes from the bundled binary's own help, and an unknown
  option leaves the command untouched rather than risking a pattern/path swap such as
  `rg --engine pcre2 foo.* src`.
- **The exit-1 "no search matches" exemption no longer guesses through shell syntax or profile
  shadowing.** A PowerShell backtick makes the lightweight status parser decline the exemption;
  downstream pipeline stages are skipped only for a very small set of exact passive shapes,
  rather than merely because their names are known cmdlets; and a profile-enabled shell no
  longer treats bare `rg` / `rg.exe` as proof that ripgrep ran. PowerShell can define a function
  under either name — `-NoProfile` included, since a function defined in the command text
  shadows the executable regardless — so a path-qualified executable is the only thing the
  command text can prove, and the only thing that earns the benign-exit classification. The
  ordinary case is preserved rather than surrendered: a bare `rg` is first rewritten to the
  bundled binary by absolute path, which is the same build the option table is read from and
  was already first on the child PATH.
- **A conditional chain no longer donates ripgrep's exit code to whatever actually failed.**
  `&&` and `||` were read as ordinary separators and the last statement taken as the command
  that set the exit code. On PowerShell 7, where those operators work, `cmd /c exit 1 && rg foo`
  never reaches ripgrep at all — and the exit 1 it really came from was filed as a search that
  found nothing. Which branch ran is decided at run time and nothing in the text says which,
  so a command line holding a top-level chain now names no program and keeps no exemption.
- **A wrapper script named after a search program is no longer treated as one.** The program
  name had `.cmd`, `.bat` and `.ps1` stripped along with `.exe`, so `rg.cmd`, `rg.bat` and
  `.\rg.ps1` all answered to ripgrep's contract that exit 1 means "no matches". They are local
  scripts free to exit 1 for their own reasons. Only the program itself — spelled `rg` or
  `rg.exe` — is still a candidate for the exemption, and it still has to be path-qualified
  to actually earn it.
- **A brace group that still needs a glob stage is left alone instead of half-expanded.** bash
  expands braces and *then* expands the wildcards in what came out. Only the first half happens
  here, and what it produces is quoted so it reaches the program verbatim — so `{*.ts,*.js}`
  became two quoted wildcards ripgrep cannot open, a worse failure than the untouched group.
  Any alternative still holding `*`, `?` or a `[…]` class is now refused outright.
- **One chat's tool call no longer holds another chat's compaction open.** The barrier that
  waits for local work to settle before a handoff is written read a count of every call running
  in the process. A swarm runs every chat through that one process, so a worker's long build
  kept the prime's finished brief waiting until the watch expired and aborted the compaction —
  blocked by work it has nothing to do with and cannot see. The count is per conversation now.
  A call whose chat is not yet proven still counts against every chat, which is the same
  conservative answer as before and the only safe one while its owner is unknown.
- **Compact & Resume now fails closed on an unsettled or unobservable local machine, without
  waiting on recorder bookkeeping that cannot mutate it.** If the chat's local request count is
  still non-zero at the settle deadline, or the app cannot provide a valid count after bounded
  retries, no handoff is submitted. A finished unattributed call may still spend the recorder's
  correlation grace window waiting to be filed; `/activity` now exposes that separately as
  `settlingTools` while `pendingTools` means requests still inside dispatch. This removes an
  accidental ~15-second cross-chat compaction tax without turning "could not verify zero" into
  success.
- **Explicit shell requests execute the shell that was actually named or fail before running
  anything.** An unknown/missing explicit shell no longer falls back to `cmd.exe`, and an
  explicit `powershell` is never silently upgraded to `pwsh` (or vice versa). Path-like shell
  values mean that exact file, including relative paths resolved against the command's own
  `workdir`, so shell-language changes cannot hide behind fallback behavior.
- **`read` now reports zero successful explicit targets as a failed call and records the count
  it really read.** Partial multi-read remains useful, but two missing requested files are not a
  healthy read merely because their `ERROR` sections were returned. Targets skipped after the
  aggregate output cap are no longer counted as successful telemetry either.
- **Unified `exec_command` uses the same child-environment contract as the other process paths.**
  Connector/control-plane secrets are scrubbed before the model-run child inherits its
  environment, the bundled ripgrep directory and irreducible Windows PATH entries are present,
  and the existing dev-toolchain discovery extends that repaired environment instead of
  rebuilding a subtly different one.

## [1.9.7] — 2026-08-23

1.9.6 was tagged but never published: its CI run failed and the release job failed with it, so
nothing in that section has reached anyone yet. It ships here, together with the fixes below.

### Fixed
- **A real failure could be recorded as a search that found nothing.** 1.9.6 exempted exit 1 from
  `rg`, `grep` and `findstr`, and decided which program set it by walking the pipeline from the
  right and skipping anything that looked like a PowerShell cmdlet. "Looked like" was any bare
  `verb-noun` token, and external executables are hyphenated too — so in `rg foo | docker-compose
  up`, the real failing stage was skipped, ripgrep was named as the status-determining program,
  and a build failure was stored as a result. Name shape cannot prove what a token is, so the
  inference is gone: an exact list of known cmdlets and aliases is treated as non-native and
  everything else is assumed to be a program. Not knowing a real cmdlet now costs an exemption,
  which is the safe direction to be wrong in.
- **A command the shell refused to run could be recorded as a search that found nothing.** The
  same exemption looked only at whether the output began with `rg:` or `grep:`. Windows
  PowerShell 5.1 answers `Write-Output hi && rg foo` with a parser error and exit 1 — nothing ran
  at all — and that was stored as a successful empty search. Shell and parser failures, missing
  commands and binding errors can no longer take the benign-exit path, whatever program the line
  would have ended in.

### Added
- **`{a,b}` brace groups are expanded the way bash would have expanded them.** PowerShell has no
  brace expansion, so `rg TODO src/{main,shared}` reached ripgrep with the braces intact and
  failed on a path that does not exist. The expansion is textual and needs no directory listing,
  so unlike glob expansion it applies to every statement of a command line rather than only the
  first. It is deliberately narrow: quoted tokens, flags, nested braces and anything holding a
  `|` or `;` are left exactly as written, and a script block `{ ... }` is never mistaken for one.
- **PowerShell 5.1 says what to write instead of `&&` and `||`.** These are not translated. `A;
  B` is not what `A && B` means — it runs B even when A failed, which can be a destructive
  follow-up that should have been gated — so the shell's own refusal is answered with the
  guarded forms instead: `A; if ($?) { B }` for `A && B`, and `A; if (-not $?) { B }` for
  `A || B`. The hint fires only on the parser error itself, so it stays silent on a shell where
  the operators work.
- **Two habits that fail without explaining themselves are stated up front.** The server
  instructions now say that `2>&1` on a native program leaves `$?` false even when the program
  exited 0, and give both chain-operator rewrites. Neither can be normalised away — stripping the
  redirect changes what the command returns — so they are said once rather than repaired after
  the fact.

### Internal
- Pending-call accounting now spans the whole MCP request rather than only the handler body.
  Calls waiting for late durable attribution remain observable in a dedicated recorder-settling
  count after their result is released, while the compaction machine barrier consumes only the
  still-dispatching count. This preserves the evidence needed to debug attribution gaps without
  coupling a browser handoff deadline to `REQUEST_ID_GRACE_MS`.
- The MCP shutdown test synchronises inside the PowerShell process it already started, instead of
  spawning a second `node` to write the file it waits for. 1.9.6 reintroduced that cold spawn and
  raised the wait to 15 seconds; on a hosted Windows runner the spawn outran the whole budget and
  failed the release. The early diagnostic that reports what the server actually answered is back
  with it, so a request that finishes before the command starts says so instead of timing out.
- The real-console test drives `cmd.exe` instead of a cold `powershell.exe`. The subject is
  ConPTY, not any one shell, and on a hosted runner PowerShell took longer to produce its first
  byte than the whole wait allowed — while the console tests either side of it passed in about a
  second. `mode con` asks the console for its own size, which a pipe cannot answer at all, so the
  proof is unchanged and the cold start is gone. `mode con` translates its labels, so the
  assertions read the number the console reported rather than the English word in front of it.
- The three window-state tests find a window before asking for its state, the way the window
  tests beside them already do. A hosted runner can have no visible desktop window at all, and
  `WINDOW_NOT_FOUND` is the correct production answer to that — asserting the runner has a
  desktop was the test's mistake, not the helper's.

## [1.9.6] — 2026-08-23

### Fixed
- **A compaction turn is no longer declared finished while it is still working.** The end of a
  turn was decided by one signal — the stop control staying gone for four seconds — and a long
  agentic turn makes that control flicker between phases. On 2026-08-23 that closed a compaction
  turn 28 characters into its brief, stored `TASK\nContinue implementing ` as the whole handoff
  for a session holding 455 events and 318,422 tokens, and opened the replacement chat with it
  while the original went on making tool calls for another seven minutes. The brief is now held
  until four things agree and keep agreeing: the stop control is gone, the answer has stopped
  growing, the turn's tool rail has stopped moving, and the app reports no local call still
  running. An app that cannot be asked counts as busy rather than as idle.
- **A brief too short to have carried the session is refused instead of stored.** Nothing
  downstream can tell a truncated handoff from a complete one, so the check happens before it is
  written. A refused compaction leaves the session exactly where it was and says why.
- **A resume no longer races the recorder for its own replacement chat.** The recorder invents a
  session for any conversation it has not seen; the commit moves the existing session onto that
  same chat. The recorder won by 302 ms, the commit found its destination already owned and
  refused to rebind, and the session stayed behind while the swarm's prime role moved on without
  it. New chats now wait, briefly and boundedly, while a replacement chat is expected — including
  after a restart that recovered a continuation still holding its claim.
- **`rg pattern *_test.go` works on PowerShell without silently widening.** PowerShell does not
  expand globs for native programs, so the pattern reached ripgrep literally and the call failed.
  The glob is now expanded against the working directory the way the shell would have, rather
  than rewritten to `-g`, which is a recursive filter that would also have matched
  `sub/nested_test.go`. Only the first statement of a command line is touched, because anything
  after it may have changed the directory or the files in it.
- **A search that found nothing is no longer recorded as a failed tool call.** `rg`, `grep` and
  `findstr` spend exit 1 on "no matches" and reserve other codes for real errors. The exemption
  applies only when the program that set `$LASTEXITCODE` — the rightmost native stage of the
  pipeline, not its generator — is one of those, and only when it printed no error of its own.
- **`read` accepts several paths and a line range in one call**, and says outright when a file
  has no lines in that range, so a short file can never read as a complete one.
- **A child process inherits the environment it was given**, and `JAVA_HOME` / `GOROOT` are
  filled in from an installed toolchain when — and only when — the tool would otherwise be
  unreachable. Versioned install directories are now compared as version numbers, so `jdk-21`
  outranks `jdk-9`.
- **git run outside a repository says so**, and names how to find the root, instead of returning
  a bare failure.

## [1.9.5] — 2026-08-23

### Added
- **The extension requirement is explicit where sub-agents are configured.** Setup now says
  worker chats require the companion extension to be loaded and connected, Chat settings repeats
  that requirement, and Setup includes a direct download link for the standalone extension ZIP.

### Fixed
- **Sub-agents can be enabled without restarting Chat On Steroids.** Swarm persistence hooks are
  now wired for the lifetime of the main process instead of only when multi-agent was enabled at
  startup, so the first `spawn` after enabling the feature can cross its durable acceptance
  barrier normally.

## [1.9.4] — 2026-08-22

### Added
- **Native Windows x64 and ARM64 release packaging.** Release candidates build and smoke-test
  each architecture on a matching Windows runner, bundle the matching tunnel/search assets and
  Chrome extension, and assemble explicit installers plus an extension zip and SHA-256 manifest.

### Changed
- **Fresh installs start fully enabled.** All file, command and desktop permissions begin on,
  read-only mode begins off, and multi-agent starts enabled with the existing two-worker
  default. Existing configs keep their explicit choices, and a corrupt config still recovers
  conservatively rather than treating damage as permission consent.
- **The Home activity log starts shorter**, leaving more vertical room for permissions,
  folders and health without changing the activity view itself.
- **Public setup and security guidance was refreshed for release.** The landing page now calls
  out the separate x64/ARM64 installers, bundled-extension install path, unsigned SmartScreen
  warning, current ChatGPT MCP access limits, and the experimental browser-automation terms risk.

### Fixed
- **Compact & Resume and browser-command recovery are durable across failures and restarts.**
  Continuation transitions now persist before publication, queued/leased browser commands and
  final receipts survive restart, and a committed resume cannot be cancelled by a late timeout
  or lost HTTP response.
- **Multi-agent finish and recovery paths are deterministic.** Terminal worker retries can
  recover their final result without reviving the worker, critical broker state has an awaited
  durability barrier, and resume transfers repair only from durable recovery evidence.
- **The extension no longer drops recoverable work on transient/protocol failures.** 426 keeps
  the observation journal for retry, command acknowledgements use a storage-backed outbox, and
  retry alarms are kept stable until durable work drains.
- **Browser/Fiber attribution is stricter under navigation and reused UI state.** Scan identity,
  request ownership and chronology stay fail-closed when ChatGPT reuses rows, ids or documents.
- **Session/catalog races no longer resurrect stale ownership.** Conversation attachment lookup,
  first-sight initialization and asset accounting now preserve the durable session as authority.

### Performance
- Reduced repeated filesystem scans and metadata calls in `read`, glob expansion and fallback
  search; reused already-read bytes for binary/encoding detection and reduced ripgrep buffer
  copying.
- Removed repeated browser journal/chronology scans and batched request-correlation persistence;
  streaming session messages now compare their fixed stored-text shape without repeatedly
  serializing large prose.

## [1.9.3] — 2026-08-21

### Changed
- **The app is now called Chat On Steroids.** The installer, the window, the connector
  names and the extension all use the new name. Two consequences on upgrade: the new
  build installs alongside the old one rather than over it, and settings live in a new
  folder (`%APPDATA%\chat-on-steroids\`), so the stored API key and recorded sessions
  do not carry across. **Reload the extension** — the bridge handshake changed with the
  name, and an old extension is refused with a visible error rather than failing quietly.
- **`spawn` takes a shared `context`.** The repository, the conventions file, what not to
  touch, how to validate, what to report — written once for the batch, and put in front
  of every worker's own task. Each `task` now carries only that worker's objective.
- **`message` sends a batch.** `action='message'` accepts a `messages` array as well as a
  single `to`/`text`: three redirected workers are one tool call instead of three, and
  the batch is delivered in full or not at all.
- **Every `agents` reply carries machine-readable state** beside its sentence of prose —
  the run, the caller, each agent and anything queued — so the model reads state rather
  than parsing English.
- **Workers are asked for a structured handoff**: RESULT, CHANGES, VALIDATION, BLOCKERS.
- **The preamble typed into a worker's chat is three lines shorter**, saying only who it
  is and how to report.
- **A closed tab no longer ends a worker.** A ChatGPT turn runs on OpenAI's servers, so
  closing the tab loses this app's view of the worker rather than stopping it. Such a
  worker shows as *no tab*, keeps its slot, and rejoins the moment it calls again; it is
  given up on only once it has also gone quiet.

### Removed
- **`agents(action='join')` and its recovery key, entirely.** It was the last credential
  in the app and the only field a model could present as identity. A worker is the chat
  the app opened for it; a binding that goes missing is restored by the extension
  reporting the chat, not by pasting a key. The desktop window's recovery-key button is
  gone with it.

## [1.9.2] — 2026-08-21

Pre-public beta milestone.

### Fixed
- Harvest the request id before ChatGPT's safety check releases it. The id used to
  correlate a tool call with the turn that caused it could be gone by the time it
  was read, which surfaced as calls landing under the wrong turn or under
  *Unattributed activity*.

## [1.9.1] — 2026-08-21

### Fixed
- Attribute MCP calls that arrive without a `data-turn-id`. ChatGPT does not always
  stamp the attribute; those calls previously fell through to *Unattributed*.

## [1.9.0] — 2026-08-21

### Fixed
- Live transcript ownership and chronology. Turn identity could leak from an older
  generation into a newer one, progress ids could be reused across generations, and
  the same semantic tool row could be recorded two or three times under
  index-derived ids. Identity is now scoped per generation rather than trusting a
  DOM attribute that survives React node reuse.

## [1.8.9] — 2026-08-21

### Changed
- Hardening pass across MCP lifecycle, path handling and process control.
- The test suite terminates reliably instead of leaving stray workers behind.

## [1.8.4] — 2026-08-20

### Added
- Refreshed application icon.
- Current Codex-derived base tools ported to Core.

### Fixed
- Turn-killer bug; session identity now survives a reload.
- Live transcript capture and attribution repair.

## [1.7.6] — 2026-08-18

### Changed
- Reduced model-facing tool surface from 45 tools / ~60 kB to 12.5 kB across six
  core tools and 7.9 kB across two desktop tools, with those sizes held as test
  budgets. See [`docs/tool-surface.md`](docs/tool-surface.md).

## [1.5.1] — 2026-08-15

### Changed
- Hardened MCP workflows and process control.
- Corrected the documented Electron user-data path.

## [1.5.0] — 2026-08-15

### Added
- Transactional batch edits and process output cursors.

[1.9.5]: https://github.com/totec448-spec/chat-on-steroids/releases/tag/v1.9.5
[1.9.4]: https://github.com/totec448-spec/chat-on-steroids/releases/tag/v1.9.4
