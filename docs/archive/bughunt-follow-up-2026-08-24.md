# Manual bug hunt follow-up — 2026-08-24

This is the follow-up manual audit requested after the larger same-day architecture pass in
`docs/archive/bug-audit-2026-08-24.md`. The checkout was already heavily modified, so this pass did not
reset, reformat, or take ownership of unrelated work. Candidate findings from parallel read-only
reviews were treated as leads; production changes below were made only after tracing the live path
and adding or strengthening a regression.

## Verification baseline and final gate

Before this follow-up, typecheck, all 49 test files (1,400 passed, 1 skipped), and the production
bundle passed. After the fixes below:

- `npm run verify`: 49 files passed, 1,411 tests passed, 1 skipped.
- `npm run build`: main (73 modules), preload (1), and renderer (8) bundles passed.
- TypeScript now permanently enables `noUnusedLocals` and `noUnusedParameters`.

No installer, packaged-runtime smoke, live Chrome session, tunnel-provider connection, or desktop
input action was run in this follow-up. Those remain separate release/live proof.

## Confirmed findings fixed

### 1. An apply-patch move onto itself deleted the file

`apply_patch` writes a move destination and then removes the source. Equivalent source/destination
spellings such as `source.txt` and `./source.txt` therefore wrote the new contents and immediately
deleted them. Verification now compares resolved identities (case-insensitively on Windows) and
rejects the whole patch before any mutation. The regression proves the original file is unchanged.

### 2. A workspace-relative glob beginning with `*` was silently made absolute

The glob walker substituted `/` when no literal prefix preceded the first wildcard. Thus `*.ts`
and `**/*.ts` ignored the proven chat workspace and looked for a virtual root instead. The empty
prefix now remains relative unless the original pattern explicitly began with `/`. The HTTP MCP
regression proves `**/*.ts` expands under an exact request-correlated workspace.

### 3. `read` charged compressed image bytes instead of the emitted base64 payload

An image up to the standalone `view_image` ceiling could bypass `read`'s 512 KiB aggregate output
cap because only its smaller compressed byte count was subtracted. `read` now charges the actual
base64 characters plus its header to the aggregate budget. Small images still work without the
64 KiB text-section default; a large image gets an explicit `use view_image` fallback, and the same
file succeeds through that tool.

### 4. A malformed Goal SSE record could turn a truncated sentence into a ready reply

After valid deltas, non-JSON `data:` records were ignored. EOF then promoted the partial text to a
message the extension could type as the user. A non-empty malformed data record is now a protocol
failure, the stream is cancelled, and no reply is exposed. Comments, blank lines, role-only events,
and `[DONE]` retain their existing behavior.

### 5. Three bridge routes used the capped UI list as an ownership index

Manual Compact & Resume, automatic compaction, and Goal draft startup searched `listSessions()`.
That API is intentionally capped for display, so an older valid conversation became
`session_not_recorded`. All three now use the durable attachment catalog through
`findSessionByConversation(..., { requireUnique: true })`. A regression puts the target behind 65
newer sessions and proves the Goal route still finds it.

### 6. Unsolicited state pushes erased focused Chat-settings edits

Home controls had a focused-dirty guard; the Chat settings sheet bypassed it and repainted every
field from persisted state. A connection/status push could erase a compaction threshold, worker
count, or Goal setting while it was being edited. Chat controls now receive the prior persisted
config and apply the same focused-and-different rule. A regression proves the in-progress value is
kept and a later clean push still paints normally.

### 7. `shell.openPath` failure was reported as success

Electron resolves `shell.openPath()` with an error string instead of rejecting. The IPC handler
discarded that string and the renderer toasted “Extension folder opened.” It now turns any non-empty
result into an IPC error; the test drives the real return contract.

### 8. Agent ids crossed IPC unbounded and unvalidated

`swarm:clearAgent` accepted any string, including enormous or control-character payloads, before
handing it to the global broker. It now requires 1–64 alphanumeric/hyphen characters at the IPC
boundary. Oversized and newline-bearing inputs are regression-tested.

### 9. Renderer redirects were not vetoed

Both the window-specific and global Electron guards blocked `will-navigate` but not
`will-redirect`. A redirect is now denied at both layers as part of the same no-navigation
invariant.

### 10. Fiber skipped readable assistant sections without `data-turn-id`

The extractor's selector required the attribute even though its own state machine and test claimed
to support `turnId: null`. The test fixture was stale: it installed an empty attribute instead of
omitting it, so it never exercised the selector. The selector now admits every ChatGPT turn section,
and the fixture truly omits the attribute.

### 11. A second Fiber logical-id collision could swallow a distinct message

When creation time collided, Fiber fell back to the parent/turn tuple. Two authored blocks could
also share that tuple, leaving the collision intact. The final collision fallback now uses the raw
message id and marks it unstable. This sacrifices reload durability only for the ambiguous row and
never drops either message.

### 12. Virtual app paths inside shell text ran against the wrong filesystem dialect

The sandbox already had a carefully bounded `strayVirtualPath()` detector, but nothing called it.
PowerShell interprets `/workspace/file` as a drive-root path, not the app's approved virtual root.
`exec_command` now refuses only approved virtual-root tokens and explains the two valid fallbacks:
use `workdir` plus a relative path, or a native approved path. URLs, language fragments, regex-like
text, and unapproved `/name` tokens remain untouched. A stale test that explicitly required the
wrong pass-through behavior was removed and replaced by unit and real-MCP regressions.

### 13. A post-start desktop-helper process error released the queue before retirement

Malformed replies, write failures, and timeouts already waited for the helper process tree to die;
the child's post-start `error` event rejected immediately. A replacement could therefore start
while the broken helper still had desktop-input authority. This path now shares the retirement
barrier. The regression holds termination, proves the first call and the queue remain unsettled,
then releases it and observes the replacement.

### 14. Tunnel children inherited ambient connector credentials

OpenAI tunnel-client used a raw `process.env` spread and cloudflared inherited the environment
implicitly. Starting Electron from a credential-bearing terminal could pass unrelated provider
secrets into both children. Both launch paths now use the shared `childEnv()` scrubber; the OpenAI
path adds back only its deliberate control-plane key, local MCP URL, and discovery headers.

### 15. Dead code and stale assertions survived because unused checks were optional

The strict compiler pass found unused production imports, an unused summary local, dead editable
text snapshot/encoding helpers, a dead line-count wrapper, two dead MCP formatting exports, and
multiple stale test helpers/imports. They were removed. `execRecoveryHints` now uses the command to
avoid blaming backslash quoting, glob expansion, or `&&`/`||` when the command did not contain that
cause. A false-positive regression was added.

The stale double-space output `Command failed  a command` and the test that enshrined it were fixed.
`AGENTS.md` now reports 49 suites, removes a nonexistent `agent-secrets.ts`, and describes the live
per-message shard store rather than presenting legacy `messages.json` as canonical.

## Unresolved leads

This pass also produced a list of credible boundary risks that were reviewed but **not** promoted
to fixed, because none had a deterministic reproduction and an implementation that preserved the
existing crash and security contract. Consistent with `SECURITY.md` and the documentation rule in
`AGENTS.md`, that list is tracked privately rather than published: it is a detailed map of
unresolved weaknesses in a tool that runs commands on the user's machine. Suspected security
issues belong through the private process in `SECURITY.md`.

Two leads were checked and closed as not defects: the packaged-runtime preflight does verify
`conpty.dll` and `OpenConsole.exe`, and the extension manifest/content-script ordering and bridge
protocol values matched their current declarations. A broad removal of the remaining legacy
low-level exec/fsops APIs was also declined here — some are deliberate parity primitives with
direct regression suites, and architectural deletion should be its own compatibility decision.
