/**
 * Version constants shared by the app, the bridge and the Chrome extension.
 *
 * `APP_VERSION` is written here rather than imported from package.json so the bundled
 * main process does not have to reach outside its own build. A test asserts that this
 * constant, package.json and extension/manifest.json all agree, so a release cannot ship
 * an extension that silently disagrees with the app it pairs to.
 *
 * `BRIDGE_PROTOCOL` is what actually has to match. It moves only when the request or
 * response shape between app and extension changes in a way an older peer cannot handle,
 * which is far less often than the app's own version moves — and it is what turns "the
 * extension does nothing" into a diagnosable mismatch.
 */

export const APP_VERSION = '2.0.4';

/**
 * Standalone extension recovery must stay on the app's own release. Using GitHub's moving
 * `latest` asset can pair an older installed app with a newer, incompatible bridge protocol.
 */
export function extensionDownloadUrl(version = APP_VERSION): string {
  return `https://github.com/totec448-spec/chat-on-steroids/releases/download/v${encodeURIComponent(version)}/Chat-On-Steroids-Extension.zip`;
}

/**
 * 1 — original observations/activity bridge.
 * 2 — leased commands: /commands hands out a claim, /commands/ack reports the outcome.
 * 3 — browser-triggered compaction via /compact and worker bootstrap completion semantics.
 * 4 — targeted open: the app opens the chat itself with a ?clf=<id> marker and the page
 *     redeems that one id through /commands/redeem, /commands also reports which ids are
 *     still active, /activity carries the resume job and compaction progress, and /pair
 *     provisions silently.
 * 5 — canonical Fiber message/request observations, exact request-id attribution metadata,
 *     automatic-compaction edge/claim state, and the 1.8 activity payload contract.
 * 6 — 1.8.8 reshaped the wire in ways a 1.8.7 peer mishandles silently rather than loudly:
 *     /activity carries resetActivity and truncatedFrom so a page that merged from a cursor
 *     predating the truncated window resyncs instead of projecting stale turns, /activity
 *     carries retiredWorker, /commands/ack answers 404 no_such_command when the caller names
 *     a client, and observations carry authoredTime, which now drives message ordering. None
 *     of those degrade gracefully, so the 426 gate has to be able to see the mismatch.
 * 7 — the app renamed itself to Chat On Steroids, and the `app` field every bridge response
 *     is stamped with renamed along with it. A 6 extension reads that field to decide the
 *     reply came from this app at all, so against a 7 app it silently discards every answer
 *     and reports nothing — which looks exactly like a bridge that is down. The bump turns
 *     that into the 426 the user can act on.
 * 8 — explicit app-side browser disconnect became a durable pairing state. /hello reports
 *     `disconnected`, protected routes distinguish that revocation from a stale token, and
 *     /pair accepts `reconnect: true` only for an explicit browser-side reconnect. An older
 *     extension would otherwise silently undo the user's app-side Disconnect on its next 401.
 * 9 — automatic compaction no longer spends a separate pre-send `/compact/claim-auto` wire
 *     claim. The live page owns retryable preflight and the existing continuation transaction
 *     remains the only durable post-send authority.
 * 10 — worker revival identity is returned by /status and /activity so the extension can scan
 *      Chrome before routing to an existing exact conversation or opening one proven absent.
 * 11 — two additions to the goal projection, both of which a 10 peer reads as absent and then
 *      acts wrongly on rather than loudly. `pending.acceptedAt` names the pickup episode, so a
 *      stable final reply deliberately re-armed by an Off -> On is a new claim rather than the
 *      turn id the page has already spent. `own` says whether this chat has moved its own
 *      Goal/Loop switch, which is the only way to tell an Off somebody chose in the composer
 *      from an Off merely inherited from the app-wide setting — without it a 10 extension goes
 *      on letting a saved goal speak over the user's Off.
 *
 * 12 — `/status` answers with `repairs`, every repair now due, in place of the single `repair`.
 *      An 11 peer reads the new field as absent and quietly stops repairing anything at all,
 *      which is exactly the silent failure this fence exists to turn into a 426.
 */
export const BRIDGE_PROTOCOL = 12;
