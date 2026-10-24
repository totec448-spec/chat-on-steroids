# cos-browser-control

Direct browser control (unit E2.8). The Desktop surface's `browser_*` tools act on the person's
browser through the companion extension. It ports `src/main/browser-control.ts`,
`src/main/mcp/tools-browser.ts`, `src/shared/browser-control.ts`, the `/browser-control` and
`/cos-browser/sign-in` handlers of `bridge.ts`, and `src/main/cos-browser/sign-in-transfer.ts`.
The extension side (`extension/browser-control.js`) is unchanged.

`cos-core` builds one `BrowserControl`. It registers `tools()` on the Desktop surface, hands the
same owner to the bridge family `cos_bridge::families::browser_control`, and runs
`BrowserControl::follow_bridge` on the bridge status.

## How a call runs

1. The kernel validates the arguments against the recorded schema, with the `tabId` pattern's
   `i` flag and `pageId`'s own message (`STRING_CHECKS`), then `Tool::refine` adds each tool's
   refinements.
2. The tool checks the permission (`browser_tabs` needs "Control" for `new` and `close`), then
   the owner. A call proven to come from a chat is owned by `session:<id>`. Without proof, and
   only with "Allow unattributed calls" on, it is owned by `request:<id>` or `unattributed`.
   Otherwise it is refused with `BROWSER_IDENTITY_REQUIRED`.
3. `Broker::execute` picks the browser (the one named by `tabId` or `browserId`, or the only
   one connected), queues one command and signals `browser-control` on the wake socket.
4. The extension polls `POST /browser-control`, claims the command once, asks `check` before
   page input, and reports `result`. The claim and the check both run the command's late
   check: the permission is still on, and the owning chat may still act (its session holds it
   as the current conversation), or, for an unproven call, a page has since proved its request
   id or unattributed calls are still allowed.
5. The call answers with the browser's value as JSON text and `structuredContent.value`, and a
   screenshot as one image block after the full pixel check (`cos_fs::validate_image_bytes`).
   After 25 s it answers `BROWSER_NOT_DISPATCHED` (never claimed) or
   `BROWSER_RESULT_UNCONFIRMED` (claimed, result lost). A claimed command is never handed out
   again.

A stopped, moved or disconnected bridge resets the broker: waiting calls end, known browsers
are forgotten and a new epoch makes every old claim and receipt stale. Disconnect also revokes
the sign-in offer.

## Sign-in transfer

`SignInTransfer` is the offer state machine and the strict cookie check of
`sign-in-transfer.ts`. The TypeScript host that began offers was the Electron built-in browser,
which the Rust app drops (standing order 12). Its replacement launches the system browser with
a dedicated profile and the unchanged extension. That host does not exist yet, so nothing calls
`begin`, and the route answers what TypeScript answers with no offer open:
`409 transfer_expired` unless `ui.chatBrowser` is `cos`, then `{"offer": null}` for `GET`,
`405`, `400 invalid_browser_request`, `400 bad_request`, `400 invalid_session` and
`409 transfer_expired` in the same order. The host implements `CookieWriter` for its dedicated
profile (for example `Storage.setCookies` over the DevTools pipe of the browser it launched).

## Differences from TypeScript

- A call that is cancelled (its future dropped) withdraws its command at once. TypeScript has no
  cancellation and keeps the command queued until its 25 s deadline.
- Chat liveness reads the session store and the blocked chats. No continuation or worker
  ledger exists in the Rust app yet; `cos-core`'s `ChatProof` adds each when it lands.
- `BrowserCommand` serializes `ownerAliases` after `owner`, not last. The extension reads keys.

## Tests

- `tests/broker.rs`: the custody cases of `test/browser-control.test.ts`, with paused time for
  the deadline.
- `tests/tools.rs`: the cases of `test/tools-browser.test.ts` through the real kernel.
- `tests/golden.rs`: replays `desktop` cases 20 to 31 and compares each whole result with the
  corpus.
- `tests/routes.rs`: `/browser-control` answers, the sign-in route, and the cases of
  `test/cos-browser-sign-in.test.ts`.
- `tests/lifecycle.rs`: a port change and a Disconnect end waiting calls and the offer.
- `rust/scripts/e2e-browser-control.mjs` runs the release `cos-headless` with the unchanged
  extension in a throwaway headless Chromium behind a proxy, and drives a local test page with
  every browser tool over the Desktop MCP endpoint.

```sh
node rust/scripts/e2e-browser-control.mjs --binary rust/target/release/cos-headless.exe --chromium <chrome.exe> --out <new dir>
```
