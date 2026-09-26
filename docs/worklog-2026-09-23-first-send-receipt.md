# First-send receipt and private draft safety — 2026-09-23

## Failure

On a cold New Chat, a large first input could be accepted by ChatGPT while the local outbox
remained in browser delivery. The native user row mounted before ChatGPT assigned the concrete
conversation route, so the receipt observer saw valid text without a route and was not retriggered
when the route appeared. On the reproduced large request, ChatGPT also serialized the native row by
escaping Markdown punctuation in the private prefix and turning a bare URL into an equivalent
Markdown autolink. Strict byte comparison therefore rejected the accepted row. If the exact prepared
text remained in the native composer, the ambiguous send path preserved its private `COS_CONTEXT`
frame as though it were a user draft.

## Repair

- Route reconciliation now wakes the existing Send evidence observer. Acceptance still requires
  the exact fresh native user row, route, document lifetime and app ACK; a click alone remains
  insufficient and no retry was added.
- Browser claims project a non-persistent `draftText` from the main-owned authored input.
- An unresolved dispatched send may replace only its exact untouched prepared composer lease with
  that authored text, removing its owned staged attachments. Trusted edits, replacement editors,
  attachment changes and navigation fail closed.
- Provider readback equivalence is accepted only for a complete length-delimited app frame under the
  existing Send receipt. The accepted row is cached under its conversation (or fresh-page epoch) and
  native message id. Historical recovery unescapes only the private prefix; authored bytes are never
  rewritten. Incomplete private frames remain concealed and are not recorded.
- The common implementation was mirrored to mainstream and Internal Chromium. No Internal
  Chromium, continuation or compaction owner was changed.

## Validation

- Mainstream: focused `chatgpt-dom-input`, `content-script` and `input-delivery-integration`
  suites: 1,083 passed; typecheck passed; reserved-opening bridge test passed.
- Internal Chromium: the same focused suites: 1,083 passed; typecheck passed; reserved-opening
  bridge test passed.
- Regression coverage includes a long first message whose native row precedes its route, rejected
  app ACK sanitization, reversible provider serialization, a changed-link rejection, incomplete
  private-frame quarantine, and the negative case where a user edit revokes the composer lease.
- Both `npm run verify` invocations finished their broad parallel suites and preliminary privacy,
  notices, native-source, Electron and typecheck gates. Under that load, Mainstream
  reported three process-output timing cases after 5,999 passes; each exact case passed alone.
  Internal Chromium reported four process/queue timing cases after 5,984 passes; each exact case
  (including all matched parameter variants) passed alone. The broad commands therefore exited 1;
  the isolated reruns distinguish those concurrency-sensitive failures from this repair. Because
  that exit stopped the command chain, the final serialized `computer` and `mcp-shutdown` suites
  were run explicitly and passed 26/26 in each repository.

Live signed-in reproduction and installation remain separate acceptance checks.

## Turn feedback reconciliation

A later live run kept the authored prompt private and recorded a completed final, but exposed two
presentation bugs. The renderer deliberately hid a confirmed input receipt when later model work
arrived, and the bridge retired its runtime activity grant only after the recorder's final session
notification. With no later event, the sidebar could retain the old activity deadline.

- Confirmed delivery checks now remain with their user message as durable delivery evidence. The
  provisional offered clock may still retire after later work; thinking feedback remains transient.
- Runtime activity retirement now publishes a narrow session refresh only when a real grant was
  removed. It does not create another activity owner or change turn, recovery or Browser Use state.
- Mainstream passed all 214 renderer-timeline tests, all 527 bridge tests and typecheck. Internal
  Chromium passed the focused receipt/activity regressions and typecheck with the same common
  implementation; its internal-browser owners were not touched.
