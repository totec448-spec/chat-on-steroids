# Recovery inventory

Every way Chat On Steroids tries to get a stuck chat working again, in one place (#1402). It describes the code as of 2.1.37 and changes nothing. AGENTS.md §14 holds the full contracts; this page is the overview: what starts each path, its clock, its budget, who owns it and how the paths interact.

All browser-side repairs go through one function, `queueBrowserRecovery` in `src/main/bridge.ts`. It refuses every reason for a chat the user blocked, a chat with a pending Stop, a chat known to have no page, and a worker whose recovery is not allowed. It also keeps at most one repair per chat in flight (`repairsInFlight`). The browser extension carries out the repair (a reload, a reopen, or leaving the page as it is) and confirms what it did.

## Repairs

| Reason | Starts when | Clock | Budget | Owner | Supersedes / is superseded by |
| --- | --- | --- | --- | --- | --- |
| `silence` | A turn with exactly attributed local tool work shows no activity for its silence window. | 2 min (`CHAT_SILENCE_MS`); Pro 10 min (`PRO_SILENCE_MS`, 5 min after "thinking failed"); non-Pro above High effort 20 min (`DELIBERATE_SILENCE_MS`). A page that still shows ChatGPT generating gets one extra wait of 1 min (Pro 5 min, `recoveryBusyMs`). | One reload per silence episode. After a confirmed reload with no fresh work, an automatic Continue is filed (when Automatic Continue or Goal/Loop applies). | `bridge.ts` silence sweep (`armSilenceSweep`, every 30 s) | Supersedes a stuck `assistant-error` or `unattributed` repair. Exempt from the 3-minute reload cooldown. |
| `assistant-error` | The page reports ChatGPT's own stream error for a turn ("Connection interrupted", delivery timeout, resume unavailable). | Shared reload cooldown: 3 min after the chat's last app reload (`BROWSER_RECOVERY_COOLDOWN_MS`). | One per turn (`turnRepairSpent`), refunded only when an attributed tool call happened after the last one. When a Continue will follow, the extension leaves the page as it is and the Continue presses Stop first (#1399), instead of reloading. | `bridge.ts` (`queueBrowserRecovery`, `turnRepairSpent`); `extension/background.js` (`preserved`) | Superseded by `silence` and `no-tab`. |
| `no-tab` | A chat that still owes work has no tab (closed, crashed, never opened after a restart). Ordinary chats need recorded tool work; workers use their broker state; other chats only with **Recover other chats' tabs** on. | Immediate (exempt from the cooldown). | One reopen per departure. A user's deliberate close (`manual: true`) pauses all recovery for that chat until its page returns. | `bridge.ts` (`browserRecoveryDismissedAt`, missing-tab decision) | Supersedes a stuck `assistant-error` or `unattributed` repair. |
| `stalled` | The extension reports the tab discarded (Memory Saver) or frozen (Energy Saver). | Shared 3-minute cooldown. | One reload, retired by the first real activity. An idle chat with nothing owed stays asleep. | `extension/background.js` (`stalledConversations`), `bridge.ts` | Same decision as `no-tab`, without the close side effects. |
| `unattributed` | Tool calls arrive that no chat can be proven to own while chats show Active. | First attempt after 15 s with one candidate, 60 s with several (`UNATTRIBUTED_*_WINDOW_MS`); the final one 5 min after the incident began. | Two attempts per unresolved request id; the second only if new unattributed work on that request started after the first. | `bridge.ts` (`unattributedIncidents`) | Exempt from the cooldown; superseded by `silence` and `no-tab`. |
| `goal` (queue / Goal / Loop pickup) | A queued message, automatic Continue or Goal/Loop step is due, but the page does not collect it. | After the initial silence/busy wait: reloads after 2, 5 and 10 min (`BROWSER_PICKUP_BACKOFF_MS`). | Three reloads in total (`BROWSER_PICKUP_MAX_ATTEMPTS`), stored durably with the obligation so restarts and reordering cannot refund them. Then the chat shows **Recovery stopped** and the obligation stays queued for a manual return. The episode lives at most 12 h (`PICKUP_WATCH_LIFETIME_MS`). | `bridge.ts` (`inspectOwedPickups`, `pickupWatch`), `session/input.ts`, `goal.ts` | Exempt from the cooldown. Waits while the run's own workers are busy (**Wait for sub-agents**). |
| `compaction` | A Compact & Resume ticket is waiting for the source page (asking for the brief, writing it) or for the new chat (opening). While asking, it waits for a working turn to stop, except for the one pickup a transport failure brings forward. | `asking`: every 2 min, 5 times; an automatic ticket then pauses 10 min and gets 2 more bursts (`AUTOMATIC_ASKING_RETRY_*`). `writing`: every 5 min, 3 times. `opening`: every 15 min, 3 times. | Per phase; a phase change resets the count. A manual request may be abandoned after its `asking` burst; `writing` never fails the ticket. | `bridge.ts` (`inspectOwedCompactions`, `COMPACTION_PICKUPS`) | Takes over another repair's slot unless the browser already holds a claim. Exempt from the cooldown. |

## Other recovery the page and broker do

| Path | Starts when | Clock | Budget | Owner |
| --- | --- | --- | --- | --- |
| Page stall notice | A turn shows no visible progress. | 10 min (`STALL_MS` in `extension/content.js`), not while a deliberate thinking turn is live. | Once per turn: records `turn_end` `stalled` and a recoverable `chat_error`, which the app may answer with `assistant-error`. | `extension/content.js` |
| Worker wake | A sleeping worker gets a message from its prime. | The browser has 3 min to type the wake (`REVIVAL_DEADLINE_MS`); the woken worker then has 3 more min plus its silence window for a first tool call (`REVIVAL_ACTIVITY_MS`). | One wake attempt per deadline; expiry does not authorize another send. At most 16 wakes per browser reply. | `bridge.ts`, `agents.ts` |
| Automatic Continue | A silence or error repair is confirmed and the turn has no final answer. | Filed at confirmation; delivered as a queued message. | One per repair. It is held while the chat's own tool calls still run, and up to 3 min (`UNKNOWN_CALL_HOLD_MS`) for calls of no known chat. | `bridge.ts`, `session/input.ts` |

## Holds that delay every path

| Hold | Effect | Length | Owner |
| --- | --- | --- | --- |
| ChatGPT history limit | No repair is handed out while ChatGPT limits the chat's history reads. It starts only from a blocking `chat_error` carrying ChatGPT's `Retry-After` (the page reads it from a 429 on the conversation); each newer one moves the deadline. | Until `Retry-After`, at most 24 h after the notice. | `bridge.ts` (`noteProviderHistoryBackoff`, `providerHistoryBackoff`) |
| Access-limit notice | A Goal/Loop chat, or one whose unfinished work should continue, keeps its recovery deadline but has it deferred past the limit. | `Retry-After`, or 5 min without one (`ACCESS_LIMIT_HOLD_MS`). | `bridge.ts` |
| Wake from sleep | After a gap of 2 min or more in the 30-second sweep (the computer slept), every working chat gets a fresh deadline before any recovery. | 90 s (`WAKE_GRACE_MS`) | `bridge.ts` (`noteRecoverySweepTick`) |
| Approval card | A tool call waiting behind ChatGPT's approval card is the chat's own work: silence and Continue wait for the user. | Until the user allows or denies. | `bridge.ts` (`approvalCardWaiting`) |
| Old open turn | A turn left open by a page that went away counts as current work only for a while. | 1 h after its start (`OPEN_TURN_RECOVERY_MS`); activity inside the silence window always counts. | `bridge.ts` |
| User settings | **Automatically recover unfinished answers** off: no automatic Continue. **Recover other chats' tabs** off: only Goal/Loop chats and chats with recorded tool work are reopened. | While off. | `config.ts`, `bridge.ts` |

## How the paths interact: one night, 2026-10-13

A long Goal chat on macOS (2.1.35), in UTC:

1. 22:43:28: ChatGPT limited reads of the account's conversation history (a bulk maintenance job on the same account had used it up). The page recorded the blocking `chat_error` with a 28 s `Retry-After`, and the history-limit hold began.
2. 22:45:52: two minutes after the turn's last tool call (22:43:52) the hold had ended, so `silence` reloaded the tab once and filed an automatic Continue.
3. 22:47, 22:52, 23:02: the page never collected that Continue, so the `goal` pickup reloaded it after 2, 5 and 10 min and then stopped: **Recovery stopped**, Continue still queued. (ChatGPT's "Unable to load history" notice seen on that page the next morning belongs to its sidebar's chat list, not to the chat.)
4. 23:13: the page's 10-minute stall notice ended the turn as `stalled`; its `assistant-error` repair left the page as it was.
5. The chat waited until the user reloaded it. History reads had worked again for hours.

What this shows: the pickup budget was spent on reloads that did not get the Continue collected, after the history-limit hold had already ended. Why the page did not collect it is still open. Only a blocking `chat_error` with ChatGPT's `Retry-After` starts that hold; any other reason a page cannot collect spends pickups like any other.

## Not covered here

- Compaction's own transport (brief, marker, opening the new chat): AGENTS.md §15.
- Tool-call identity, refusals and blocked chats: AGENTS.md §7; workers and wakes: §16; Goal and Loop: §17.
- What the renderer shows for each countdown: `src/renderer/recovery.ts`.
