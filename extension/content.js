/**
 * What runs on the ChatGPT page.
 *
 * Three jobs. Observation never changes the conversation; presentation may replace the
 * visible live activity stream when the user has Overwrite enabled:
 *
 *  1. Observe. Messages, turn boundaries, live progress lines and visible errors are
 *     reported to the local app. Nothing is inferred that the page does not show, and
 *     a turn that stops for no visible reason is reported as exactly that.
 *
 *  2. Relabel. The app knows what every MCP tool call actually did, because it ran it.
 *     Each recorded call is matched to one "Called tool" block and given the real thing.
 *     Matching is per call and incremental: a block that cannot be matched confidently
 *     keeps ChatGPT's own label, and — this is the part that used to be wrong — it no
 *     longer suppresses the blocks around it that *can* be matched.
 *
 *  3. Offer Compact & resume, as a control beside ChatGPT's own composer buttons that
 *     says what the job is doing rather than vanishing on the next React render.
 *
 * Every selector lives in chatgpt-dom.js. This file only deals in the shapes that
 * module returns, so a ChatGPT redesign cannot reach past it.
 */

(() => {
  'use strict';

  // Static content scripts are not re-run in an already-open tab when an unpacked
  // extension is reloaded/updated. background.js deliberately re-injects this file into
  // those tabs from runtime.onInstalled. The normal static injection can race that recovery
  // on a freshly loaded page, so one live isolated-world recorder stays the invariant.
  //
  // What that used to be, and why it was wrong: a bare `__CLF_CONTENT_RECORDER_ACTIVE__`
  // boolean with the note that "a real extension reload invalidates the old isolated world,
  // so its marker disappears with it". It does not. Chrome keys the isolated world by
  // extension id and leaves that JS context standing when the extension reloads; what it
  // invalidates is `chrome.runtime`. The orphan therefore keeps its globals — including
  // this marker — and the recovery injection from runtime.onInstalled returned at this very
  // line. The document was then left with a recorder that can never send again, which is
  // precisely the state that produces a healthy MCP tunnel, a visibly alive MAIN-world
  // fiber.js, and every single call filed under `Unattributed activity`.
  //
  // So: publish a handle instead of a flag and let a replacement supersede a dead one. A
  // *healthy* incumbent still wins, so the ordinary static/recovery race is unchanged.
  const RECORDER_VERSION = 11;
  const recorderHandle = {
    version: RECORDER_VERSION,
    healthy: () => false,
    stop: () => undefined
  };
  {
    const incumbent = globalThis.__CLF_CONTENT_RECORDER__ || null;
    let incumbentHealthy = false;
    try {
      incumbentHealthy =
        !!incumbent && typeof incumbent.healthy === 'function' && incumbent.healthy() === true;
    } catch {
      // A handle that throws is not a working recorder.
      incumbentHealthy = false;
    }
    if (incumbentHealthy && (incumbent.version || 0) >= RECORDER_VERSION) return;
    if (incumbent && typeof incumbent.stop === 'function') {
      try {
        incumbent.stop();
      } catch {
        // Best effort. The orphan's loops are inert once its `chrome.runtime` is gone.
      }
    }
    globalThis.__CLF_CONTENT_RECORDER__ = recorderHandle;
    // Kept only so a recorder from before this handle existed is still visible as "a script
    // ran here". It is never read as a reason to bail out any more.
    globalThis.__CLF_CONTENT_RECORDER_ACTIVE__ = true;
  }

  const OBSERVE_MS = 1000;
  /** Streaming mutations are bursty; never run a transcript-wide pass per token. */
  const TRANSCRIPT_OBSERVE_MS = 250;
  /**
   * How long the stop button must stay gone before a turn is called finished.
   *
   * Measured on the clock and deliberately *not* counted in observations. observe() is not
   * only the OBSERVE_MS loop: watchTranscript() also runs it from a MutationObserver, via a
   * microtask, on every relevant transcript mutation. A React rerender that unmounts the
   * stop button is itself a burst of such mutations, so a counter of quiet observations can
   * run out inside the same millisecond as the dropout it exists to filter — measuring the
   * one thing that cannot be inflated by rerender churn is the whole point.
   *
   * Four seconds covers the dropouts the live sessions show — 400 ms to 2.7 s, see
   * `quietSince` — with headroom, while delaying an honest `turn_end` by a few seconds,
   * which nothing downstream reads as anything but the turn having taken that much longer.
   */
  const TURN_SETTLE_MS = 4000;
  // While ChatGPT is generating, keep the app-owned transcript close enough to feel like a
  // stream rather than a two-second slideshow. This does not create duplicate rows: /activity
  // is cursor-based, streamBySeq is keyed by canonical seq, and assistant messages additionally
  // supersede their previous revision through streamMessageSeq. Session reloads are therefore
  // allowed to make us poll sooner without being treated as new transcript content.
  const LIVE_ACTIVITY_MS = 750;
  const ACTIVITY_MS = 2000;
  const IDLE_ACTIVITY_MS = 10_000;
  const HIDDEN_ACTIVITY_MS = 30_000;
  /** Keep previously proven activity ownership through brief Fiber/feed disagreement. */
  const REPLACEMENT_GRACE_MS = 8000;
  /**
   * User-driven scrolling and ChatGPT's historical virtualization happen in the same burst.
   * Never change a turn's layout inside that burst; let the viewport settle first.
   */
  const PRESENTATION_SCROLL_IDLE_MS = 240;
  const STATUS_MS = 15_000;
  /** Longer than any honest tool call: past this a silent turn is called stalled. */
  const STALL_MS = 10 * 60 * 1000;
  /** How long the button says "Starting…" before believing something went wrong. */
  const PRESS_GRACE_MS = 12_000;
  /** Persistent popup preference. On by default as of 1.7.4; the popup can turn it off. */
  const RENDER_STREAM_KEY = 'renderStreamEnabled';
  /** Timestamps are useful for debugging, but too noisy for the normal transcript. */
  const SHOW_TIMES_KEY = 'showStreamTimes';
  /**
   * Production now starts with transcript overwrite enabled. Tests deliberately start off
   * and opt in case-by-case so renderer regressions do not contaminate unrelated capture
   * tests. The storage preference is loaded before the first production paint, avoiding a
   * one-frame flash when somebody has explicitly switched Overwrite off.
   */
  const TEST_MODE = typeof globalThis.CLF_TEST_HOOK === 'function';
  let RENDER_STREAM = TEST_MODE ? false : true;
  let SHOW_TIMES = false;
  let renderPreferenceReady = TEST_MODE;
  const renderStreamAllowed = () => RENDER_STREAM && renderPreferenceReady;
  let lastPresentationScrollInputAt = -Infinity;

  function editableScrollTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    const element = target;
    return Boolean(
      element.isContentEditable ||
      (element.closest && element.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
    );
  }

  function notePresentationScrollInput(event) {
    if (!alive || !event) return;
    if (event.type === 'keydown') {
      if (editableScrollTarget(event.target)) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'].includes(event.key)) return;
    }
    lastPresentationScrollInputAt = Date.now();
  }

  function presentationScrollActive() {
    return Date.now() - lastPresentationScrollInputAt < PRESENTATION_SCROLL_IDLE_MS;
  }

  async function loadRenderPreference() {
    if (TEST_MODE || !globalThis.chrome || !chrome.storage || !chrome.storage.local) {
      renderPreferenceReady = true;
      return;
    }
    try {
      const stored = await chrome.storage.local.get([RENDER_STREAM_KEY, SHOW_TIMES_KEY]);
      if (typeof stored[RENDER_STREAM_KEY] === 'boolean') RENDER_STREAM = stored[RENDER_STREAM_KEY];
      SHOW_TIMES = stored[SHOW_TIMES_KEY] === true;
    } catch {
      // A storage failure must not leave the renderer permanently waiting. The explicit
      // production default is ON; the popup can write the preference again on its next use.
    }
    renderPreferenceReady = true;
  }
  /** Whether any tool row currently wears a label from this app. See unpaint(). */
  let painted = false;

  let alive = true;
  /** DOM/window bindings owned by this recorder instance and removed on takeover. */
  const stopCleanups = [];
  function rememberCleanup(cleanup) {
    stopCleanups.push(cleanup);
  }
  function listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    rememberCleanup(() => target.removeEventListener(type, listener, options));
  }
  let status = { connected: false, paired: false, disconnected: false };

  /**
   * Counters the popup reads and nothing else does.
   *
   * Deliberately inert: every field is written after the fact by code that would behave
   * identically if this object did not exist. It is here so the popup can say "this chat
   * is being observed, here is the last thing seen and the request id it carried" without
   * anyone having to read the app's log to find out.
   */
  const observed = {
    events: 0,
    lastKind: null,
    lastAt: 0,
    requestId: null,
    calls: 0,
    sends: 0,
    failures: 0,
    session: null,
    pulledAt: 0,
    lastError: null,
    /**
     * Why the service worker last refused to take anything from this document, or null.
     *
     * The popup's queue counter only ever showed the worker's own journal, so a document the
     * worker was rejecting outright reported "0 held" and the drawer concluded "Delivered —
     * the app has not opened a session for this chat yet". Everything was in fact still in
     * this script's own queue, and the one layer that knew said nothing.
     */
    blocked: null
  };

  /**
   * Where each ChatGPT request id got to, for the popup's pipeline view.
   *
   * A tool call has to survive four hand-offs before the app can label its row: this
   * script has to read the request id off the page, the service worker has to accept and
   * journal the observation carrying it, the app has to receive that observation, and the
   * app has to resolve the id to this conversation. Until now a failure at any one of them
   * looked identical from the browser — the row simply never got relabelled — so the only
   * way to tell them apart was to read the app's log beside the browser's. Each stage
   * stamps its own time here as it happens, which is enough to name the hand-off that did
   * not complete.
   *
   * Inert by construction: ids and timestamps only, written after the fact by code that
   * would behave identically if this map did not exist.
   */
  const TRACE_MAX = 12;
  const trace = new Map();

  function traceStage(requestId, stage, value) {
    if (!requestId) return;
    let row = trace.get(requestId);
    if (!row) {
      if (trace.size >= TRACE_MAX) trace.delete(trace.keys().next().value);
      row = { requestId, tool: null, read: 0, sent: 0, app: null, appAt: 0 };
      trace.set(requestId, row);
    }
    if (stage === 'tool') row.tool = value || row.tool;
    else if (stage === 'app') {
      row.app = typeof value === 'string' ? value : 'unattributed';
      row.appAt = Date.now();
    } else if (!row[stage]) row[stage] = Date.now();
  }

  let conversationId = null;
  let agent = null;
  // Exact command paired with `agent`. Friendly worker ids are reused by later swarms, so the
  // app will only accept lost-ACK recovery when this full random id still names the leased worker
  // command that opened this document. It comes only from the extension's redeemed command.
  let agentCommandId = null;

  const queue = [];
  const queueSizes = new WeakMap();
  let queueBytes = 0;
  /** Keep page-local outage buffering small enough that it cannot crash the ChatGPT tab. */
  const MAX_PAGE_QUEUE_BYTES = 8 * 1024 * 1024;
  /** Page-local overflow markers, one per chat/agent bucket currently waiting for the worker. */
  const queueGaps = new Map();
  const queueGapKeys = new WeakMap();
  let flushing = false;
  let flushWork = null;

  /**
   * Which conversation this tab is on, counted rather than named.
   *
   * Every asynchronous thing this script starts belongs to the conversation that was
   * current when it started. ChatGPT is a single-page app, so `location.pathname` can
   * name a different chat before that work comes back, and a reply applied afterwards is
   * applied to the wrong chat. Comparing ids is not enough on its own — A → B → A returns
   * to the same id — so the counter is what makes "still the same conversation" exact.
   */
  let epoch = 0;

  /**
   * Messages already reported from this page load — each as an id *and what it said*.
   *
   * Not the id alone, and this is the producer half of a bug whose consumer half the app
   * already fixes. ChatGPT gives streaming assistant prose no id of its own, so an id is
   * derived from the section's turn id — and the page reuses those. Worse, the mapping
   * that would make the derived id unique (`settledGenerations`) lives in memory and is
   * empty after this content script reloads, which is exactly when the whole visible
   * transcript is offered again. Several genuinely different historical answers then
   * arrive under one id, and an id-only filter emitted the first and silently dropped the
   * rest *here*, before the recorder had anything to de-duplicate.
   *
   * Bounded, because a tab left open for days keeps reporting the same transcript.
   */
  const seenMessages = new Set();
  let reportedConversationTitle = '';
  const MAX_SEEN_MESSAGES = 2000;

  /**
   * One reported occurrence: this id having said this.
   *
   * Four independent lanes, so the identity is 128 bits wide rather than 32. That is not
   * cryptographic and does not need to be — nobody is choosing these strings adversarially
   * — but the width matters, because of what a collision costs here. Two different answers
   * that hashed alike would make the second one look like the first already reported, and
   * this filter runs *before* the app sees anything: the message would not be de-duplicated,
   * it would be destroyed, and the log would be silently missing an answer with nothing to
   * say one was lost. A 32-bit hash reaches even odds of that at a few tens of thousands of
   * messages, which a long-lived tab genuinely produces. Length is kept alongside, so a
   * collision has to survive that too.
   */
  const HASH_LANES = [
    [0x811c9dc5, 0x01000193],
    [0x01234567, 0x01000197],
    [0xdeadbeef, 0x0100019d],
    [0x9e3779b9, 0x010001a5]
  ];

  function occurrenceKey(id, value) {
    const body = String(value || '');
    const lanes = [];
    for (const [offset, prime] of HASH_LANES) {
      let hash = offset;
      for (let i = 0; i < body.length; i++) {
        hash ^= body.charCodeAt(i);
        hash = Math.imul(hash, prime) >>> 0;
      }
      lanes.push(hash.toString(36));
    }
    return `${id} :: ${body.length}.${lanes.join('.')}`;
  }

  /** Records an occurrence as reported, oldest evicted first. */
  function markSeen(key) {
    seenMessages.add(key);
    if (seenMessages.size > MAX_SEEN_MESSAGES) {
      seenMessages.delete(seenMessages.values().next().value);
    }
  }
  /**
   * Turn ids observed while on the current conversation.
   *
   * Kept so that, at the moment the URL changes, this script can tell which of the
   * sections still on screen were rendered by the chat it is leaving. See retireVisible().
   */
  const seenTurns = new Set();
  /**
   * Nodes proven to belong to a conversation this tab has already left.
   *
   * A WeakSet, so holding onto them cannot keep detached DOM alive: once ChatGPT drops a
   * section, the entry goes with it.
   */
  const staleNodes = new WeakSet();
  /** Message ids of those nodes, bounded, for messages whose section is replaced but id reused. */
  const retiredMessages = new Set();
  /**
   * Error occurrences already emitted: which texts have been reported for which node.
   *
   * Per node rather than per text, because that is what an occurrence is. Weak, so a
   * dismissed banner stops being tracked when the page drops it.
   */
  const seenErrors = new WeakMap();
  /** The generation an error node was first seen in, so an old banner cannot fail a later turn. */
  const errorFirstSeen = new WeakMap();
  /** The last label sent for each identified ChatGPT-native tool row of this generation. */
  const pageToolsReported = new Map();

  let generating = false;
  /**
   * When the stop button was first found missing while a turn was open. 0 while it is there.
   *
   * The stop button is the only signal ChatGPT gives for "a turn is running", and it is not
   * continuous: the page tears it down and remounts it across tool phases, streaming
   * reconnects and plain rerenders. Ending the turn on the first sample that misses it is
   * what session `2026-08-17-d1354db2` records again and again — `turn_start` at seq 342 and
   * `turn_end` at 343 four hundred milliseconds later with `outcome: "unknown"`, then the
   * same run reopened at 347 under a fresh generation id; the same shape at 357/358/360 with
   * a 2.7 s gap, and at 249/251. `unknown` is the signature: endOutcome() found no answer, no
   * error and no stall, because nothing had actually ended.
   *
   * The cost is not just a split log. The app clears `turnStartedAt`, the pending sightings
   * and the named-call evidence at `turn_end` (recorder.ts), so every connector call made in
   * the gap grades as `inferred` and is filed into "Unattributed activity" — 54 of that
   * session's own calls, the first of them 194 ms after a `turn_end` that closed a turn still
   * in flight.
   *
   * So a missing stop button opens a settle window instead of ending the turn, and the button
   * coming back closes the window with the generation intact. Anything stronger — the user
   * pressing stop — still ends the turn at once.
   */
  let quietSince = 0;
  /**
   * How the turn looked when its stop button first went missing, and the turn it described.
   *
   * The outcome is read on the first quiet observation rather than at the close, because the
   * evidence endOutcome() reads is perishable: an error banner dismissed during the settle
   * window would turn a failed turn into an `unknown` one, and the assistant section can be
   * replaced under the turn entirely. Held here, the recorded outcome is exactly the one the
   * unsettled code would have recorded — only published later, and only if the turn really
   * did end.
   */
  let quietTurn = null;
  let quietOutcome = null;
  /**
   * Assistant sections that already had a completed-message action before this generation.
   *
   * Section ownership is deliberately stronger than remembering one HTMLElement. Retry can
   * reuse an assistant section and React can remount its old Copy button as a new DOM node; node
   * identity would call that stale action "fresh". Sampled from the previous observation, like
   * baselineSections below, so a genuinely new section/action mounted on the same tick Stop first
   * appears is not accidentally classified as history.
   */
  /**
   * The identity every event of the turn in flight carries.
   *
   * This is a *local* key — `g-<run>-<epoch>-<n>` — and not ChatGPT's `data-turn-id`, which is
   * what it used to be. The live page settled that question: `data-turn-id` on a streaming
   * turn has the form `request-<conversation>-<n>`, and the page reuses `…-0` for turn after
   * turn as it virtualises earlier ones out of the DOM. One recorded session has a
   * `turn_start` for `…-0` after the turns numbered 1 through 4 had all finished, tool rows
   * from three turns filed under `…-0`, and commentary from four turns folded into one row
   * because they all carried the same derived id. Nothing downstream could put that back in
   * order, because the information had already been destroyed at the point of observation.
   *
   * A counter minted here cannot go backwards and does not depend on the page agreeing with
   * itself. ChatGPT's own id is still read — as `pageTurnId`, a hint for later
   * reconciliation — but nothing is identified by it.
   *
   * The counter alone is not enough to make the key unique, which is the trap a first
   * version fell into. Both counters live in this document, so reinjecting the content
   * script into the same conversation — a reload, an extension update — restarts them at
   * zero and mints `gen-0-1` a second time for a different turn, recreating the reused-id
   * collision under a new name. `RUN_ID` is a random per-document namespace, so two
   * injections of the same page can never name the same generation.
   */
  const RUN_ID = (() => {
    try {
      const bits = new Uint32Array(2);
      (globalThis.crypto || window.crypto).getRandomValues(bits);
      return `${bits[0].toString(36)}${bits[1].toString(36)}`;
    } catch {
      return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    }
  })();
  let turnId = null;
  let genCount = 0;
  /**
   * What the last activity pull said this chat has open in the app.
   *
   * Read once, at boot, by resumeOpenTurn(). Reloading a ChatGPT page in the middle of an
   * assistant turn kills this script and every piece of state in it, `RUN_ID` included — and
   * `RUN_ID` is the random per-document namespace that makes a generation id unique, so the
   * new document cannot reconstruct the id the old one was using. Left alone it sees a stop
   * button, finds no generation of its own, and opens a second one: one assistant run
   * recorded as two, its progress and prose ids keyed off a name the first half never used,
   * and the app's live-turn evidence reset underneath the calls still in flight. Session
   * `2026-08-17-d1354db2` has that at seq 367/368.
   *
   * The app holds the durable half of that identity, so the new document asks for it before
   * it observes anything.
   */
  let appActiveTurnId = null;
  /**
   * This document has adopted an identified chat whose durable state the app has not answered
   * for yet: neither "is one of my turns still open?" nor "which user messages do I already
   * have?". Both boot and an SPA move into another chat land here — in each the transcript on
   * screen is entirely unknown to this document, so nothing in it can be told apart from a
   * send that has just happened. While true, observe() does not read the transcript at all —
   * not "reads it and declines to open a turn", which is what the first version did and which
   * is worse than useless: consuming a message marks it seen forever, so the one send that
   * really did just happen is spent before the answer that could have recognised it arrives,
   * and its turn can never be opened. Withholding the reading costs one observation and keeps
   * every message classifiable. The next successful /activity response resolves it exactly
   * once; no timeout guesses identity.
   */
  let resumeIdentityPending = false;
  /**
   * The assistant section this generation is writing into, held as a node.
   *
   * A node, not an id, for the reason above: the node is the thing with a lifecycle. React
   * reparenting it keeps it; React replacing it is exactly the event that should force a
   * rebind, and an id that is reused across turns can signal neither.
   */
  let genNode = null;
  /**
   * Assistant sections already on screen when this generation began.
   *
   * Sampled from the *previous* observation, never from the DOM at the moment the stop
   * button is first seen. By then ChatGPT has usually already mounted the new turn's
   * section, so enumerating the page here files the generation's own section under "was
   * already there" and the generation can then never bind to anything. That is not a
   * theoretical ordering: it is the common one, and it costs exactly the fast tool turns
   * whose activity this is all here to place.
   */
  let priorSections = new WeakSet();
  /**
   * What each of those sections said at that moment, as [node, mark] pairs.
   *
   * The evidence for the one case freshness cannot decide: ChatGPT writing a new turn into
   * a section that already existed. A prior section whose text has changed since the
   * generation began is demonstrably being written into now, which is a fact about the page
   * rather than a timer expiring, and a timer is what this replaced — the old fallback took
   * the newest assistant section after four seconds whether or not it had moved, which is
   * false attribution with a delay on it.
   */
  let priorMarks = [];
  /** Assistant sections present at the end of the last observation. See priorSections. */
  let baselineSections = [];
  /** Sections from the previous observation which already exposed a completed-message action. */
  /** What the newest of those said then, so a reused section can prove it has moved. */
  let baselineMarks = [];
  /**
   * Assistant section node → the local generation that finished writing into it.
   *
   * How a settled turn's prose gets the same identity as the rest of that turn, without
   * asking the page for an id it does not keep stable. Weak, so a section ChatGPT drops
   * takes its entry with it.
   */
  const settledGenerations = new WeakMap();
  /**
   * Local generation key → ChatGPT's own turn id for it, when the page had one.
   *
   * A hint, never an identity. Kept so a later reconciliation pass has something to line
   * the two models up by; bounded, because a tab left open all day would otherwise grow it.
   */
  const pageTurnIds = new Map();
  let turnStartedAt = 0;
  let lastChangeAt = 0;
  let stallReported = false;
  let userStopped = false;
  /**
   * Final public ChatGPT message that already terminalised the local turn while the page's
   * Stop control was still mounted. A stale Stop must not reopen the same finished turn on
   * the next observer tick. Cleared only by concrete next-turn evidence (a new user message)
   * or the Stop control genuinely going away.
   */
  let fiberTerminalMessageId = null;

  /**
   * Recorded tool calls, keyed by the app's sequence number.
   *
   * A map rather than a list because /activity is asked for everything *from* `since`,
   * and `since` used to be set to the last sequence number seen rather than the one after
   * it. Every poll therefore re-delivered the final entry, the turn ended up with more
   * recorded calls than it had blocks, and the old one-block-per-call check then refused
   * to relabel anything at all. That off-by-one is why relabelling never appeared. The
   * fix is the `+ 1` below; the map is the belt to its braces, because a feed that ever
   * repeats itself again must not be able to break the page a second time.
   */
  const bySeq = new Map();
  /** App-owned render events, including calls ChatGPT never gave a native row. */
  const streamBySeq = new Map();
  /**
   * Stable render key -> app-owned visible stream.
   *
   * The stream is a sibling of ChatGPT's React-owned assistant sections. Keeping this map is
   * what lets a replacement/remounted section reclaim the exact same visible node without
   * moving it merely because React transiently moved the native host across a user boundary.
   */
  const streamRootsByKey = new Map();
  /** Latest delivery seq for each canonical ChatGPT assistant message. */
  const streamMessageSeq = new Map();
  /**
   * One exact final website revision that has crossed the extension journal but has not yet
   * returned from the app-owned activity feed. Until that happens Overwrite is still showing
   * an older durable revision, so this is active presentation work even after generation ends.
   *
   * Bounded on purpose, in two independent ways, because this latch buys the live 750ms cadence
   * and an unreleasable one buys it for the life of the tab. The app releases it by echoing the
   * exact revision back, and that echo is not guaranteed: `upsertMessageEvent` answers an
   * unchanged observation with `changed:false`, which writes no new seq and therefore puts
   * nothing on the feed this page reads. A re-scan that re-emits an already durable final answer
   * is not rare — `resetConversation()` and the `messagesReported` overflow clear both make the
   * page re-report the whole visible transcript — so the unreleased case was reachable in
   * ordinary use, and every chat that hit it kept polling four times a minute at the live rate,
   * hidden or not, with a full Fiber walk and a 1200-event app read on every pass.
   *
   * So: `until` is the deadline, after which the obligation is simply over — one round trip is
   * all it was ever for — and the revision key is remembered past its release, so re-observing
   * the same exact answer can never re-arm it. A genuinely newer revision still arms a new one.
   */
  let pendingPresentation = null;
  /** One expedited round trip, and no more, for one final revision. */
  const PRESENTATION_GRACE_MS = 10_000;

  /** Whether an armed presentation obligation is still owed. Expiry is a fact about time. */
  function presentationPending(now = Date.now()) {
    return Boolean(pendingPresentation && pendingPresentation.until > now);
  }

  /**
   * Arms the obligation for one exact revision, or refuses because it is not a new one.
   *
   * Returns whether it armed, so the caller only expedites for a revision the app has not
   * already been told about. Settling and expiring both leave the key behind precisely so that
   * a later identical observation is refused rather than restarting the fast cadence.
   */
  function notePresentation(messageId, text, now = Date.now()) {
    if (pendingPresentation && pendingPresentation.messageId === messageId && pendingPresentation.text === text) {
      return false;
    }
    pendingPresentation = { messageId, text, until: now + PRESENTATION_GRACE_MS };
    return true;
  }

  /** The app is holding this exact revision. Kept, rather than dropped, as a settled key. */
  function settlePresentation() {
    if (pendingPresentation) pendingPresentation.until = 0;
  }
  /** Stable user-message id → durable event position, used only to anchor page responses. */
  const userAnchorByMessage = new Map();
  let since = 0;
  let entries = [];
  let streamEntries = [];
  /** Exact request id -> one durable local turn, null when the retained stream conflicts. */
  const streamRequestTurnOwners = new Map();
  let pulling = false;

  /**
   * `'resume' | 'worker' | null` — whether this chat was opened by the app, and how.
   *
   * From the session record, so it survives a reload of a chat opened days ago.
   */
  let bootstrap = null;

  /** The live state of this chat's Compact & resume job, straight from the app. */
  let job = null;
  /** Local tool calls the app still has running. Only ever a hint from /activity. */
  let pendingTools = 0;
  let pressedAt = 0;
  let localError = '';
  let retirementHandledFor = null;

  /**
   * The one proof a zero-anchor conversation needs before its newest rendered user row may
   * open a turn.
   *
   * A durable anchor normally distinguishes a new send from transcript hydration. With no
   * anchors, an old chat opened for the first time and a genuinely new first send look the
   * same after rendering. The composer submission is the missing boundary: remember its exact
   * text and conversation before ChatGPT mutates either, then spend it on the matching newest
   * user row. Merely mounting history or a transient Stop control can never mint this receipt.
   *
   * Compared with the whitespace squeezed out entirely, which is the same normalization
   * `CLF_DOM.send()`, `insertPrompt` and `clearPromptExact` already use against this exact
   * composer, and for the same reason: it is a rich-text editor, a blank line in the text
   * becomes a paragraph break, and `textContent` stitches the paragraphs back together with
   * no separator at all. Collapsing runs to a single space instead left the receipt for every
   * multi-paragraph send unable to match the message it had just sent — so a Compact & Resume
   * bootstrap, which is always multi-paragraph and always lands in a brand-new zero-anchor
   * chat, opened no turn in the replacement chat. With no live generation there is no owned
   * page turn, the fresh chat's provisional client thread is then the only conversation its
   * Fiber branch names, and the request-id handshake that owns every tool call of that turn
   * never runs: the whole resumed turn's work fell into Unattributed activity.
   */
  const USER_SEND_RECEIPT_MS = 30_000;
  let userSendReceipt = null;
  const sendText = (value) => String(value || '').replace(/\s+/g, '');
  function rememberUserSend() {
    const text = sendText(CLF_DOM.composer()?.textContent);
    if (!text) return;
    userSendReceipt = { text, conversationId: CLF_DOM.conversationId(), at: Date.now() };
  }
  document.addEventListener('click', (event) => {
    const button = CLF_DOM.sendButton?.();
    if (button && event.target && button.contains(event.target)) rememberUserSend();
  }, true);
  document.addEventListener('submit', (event) => {
    const composer = CLF_DOM.composer();
    if (composer && event.target && typeof event.target.contains === 'function' && event.target.contains(composer)) {
      rememberUserSend();
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    const composer = CLF_DOM.composer();
    if (
      composer &&
      event.target &&
      composer.contains(event.target) &&
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.isComposing
    ) rememberUserSend();
  }, true);

  /**
   * How full this conversation is, and what the app intends to do about it.
   *
   * `tokens` is the recorder's estimate of what has been said and returned so far;
   * `context` carries the lines it is measured against — the two the app already draws in
   * its own session view, and the automatic threshold with the provider that would write
   * the brief. All of them come from /activity rather than being decided here, so the bar
   * the user is watching and the number that acts are the same number.
   */
  let tokens = 0;
  let context = null;
  /**
   * The app's answer to "may this chat compact itself right now?", refreshed every poll.
   *
   * True while the chat is over the configured threshold and has a turn open. It is a live
   * reading rather than a remembered edge, so
   * it goes false again on its own the moment the answer lands.
   */
  let autoCompactReady = false;

  /**
   * The goal loop, as this page sees it.
   *
   * `goalConfig` is the app's answer to "is it on, and can it work" — the switch plus
   * whether an OpenRouter key exists at all, because the second is the difference between a
   * feature that is off and one that is broken, and only the app knows it.
   *
   * `goalDraft` is whatever draft the app currently holds for this chat: its stage, the text
   * as it streams in, and — once, at `ready` — the message to type. Both arrive on the same
   * /activity poll as everything else.
   */
  let goalConfig = null;
  let goalDraft = null;
  /**
   * The generation the goal loop has already acted on.
   *
   * One draft per finished turn, decided here rather than by the app alone: a page that asked
   * twice for one turn would be asking the app to be idempotent about a message it has
   * already sent. The app is idempotent anyway — that is what `turnId` is for on /goal/draft —
   * and this is the near-side half of the same rule.
   */
  let goalTurnId = null;
  // The durable pickup episode currently claimed by this document. A stable assistant reply
  // may deliberately be picked up again after Off -> On, so its turn id alone is not the
  // once-key. The app renews acceptedAt for every such episode and publishes it with pending.
  let goalTicketId = null;
  /** What this tab is doing about the goal loop right now. '' when it is doing nothing. */
  let goalPhase = '';
  /** Why the loop is where it is, in the app's own words. Empty unless something stopped. */
  let goalError = '';
  /**
   * Moves the goal loop to a step, says why, and shows it. The only way to do any of the three.
   *
   * The panel is drawn from these two fields, and the reason outranks the step: any non-empty
   * `goalError` draws "The goal loop stopped", whatever the phase says. So they are one fact
   * and not two, and starting a step clears the reason the previous one ended with - by
   * construction, rather than by every caller remembering to. Assigning them apart is what
   * froze the panel on a retryable OpenRouter failure: the retry did run and did set
   * `requesting`, but the stale reason kept the stopped card up until a message appeared
   * fifteen seconds later, so the loop looked dead while it was working.
   *
   * Redrawing here rather than at the call sites is the other half of that. A phase nobody can
   * see is a phase nobody has, and "remember to repaint" is a rule that need only be forgotten
   * once, at any one of twenty-odd assignments, to strand the user in front of a stale card.
   */
  function setGoalPhase(phase, reason = '') {
    if (goalPhase === phase && goalError === reason) return;
    goalPhase = phase;
    goalError = reason;
    injectStage();
    renderControl();
  }

  /** Guards the settle watch and the send, so one finished turn produces one message. */
  let goalBusy = false;
  /** When this tab started trying to type a ready draft, so a held composer eventually gives up. */
  let goalTypingSince = 0;
  /** Terminal Goal card the user dismissed. Keyed to its chat + finished turn across repaints. */
  let dismissedGoalStage = null;
  /**
   * A goal saved for a chat ChatGPT has not named yet.
   *
   * The app keys a specific goal by conversation, and a New Chat has no conversation until
   * its first message has been sent. That first message is the one this very goal is about
   * to produce, so the goal waits here across exactly one gap — from Save until the id
   * arrives — and is handed to the app the moment there is something to key it to. See the
   * "same chat has just learned its own id" branch in observe().
   */
  let pendingObjective = '';
  /**
   * The mode that goal was written in, waiting across the same gap.
   *
   * It has to travel with the text and cannot be re-derived at the other end: the chat this
   * is about to become has no switch of its own yet, so anything asking "goal or loop?" once
   * the id arrives would be asking the app-wide default — which is exactly the answer that
   * turned an unattended Loop into a Goal that stopped at the second turn.
   */
  let pendingObjectiveMode = 'goal';
  // Whether the opening message written from that goal actually reached ChatGPT. Only a sent
  // one survives the conversation reset below, because only a sent one is the reason the id
  // this tab is about to adopt exists at all.
  let pendingObjectiveSent = false;
  /** Set while a specific goal is being saved or its opening message written. */
  let objectiveBusy = false;
  /** The last specific-goal failure, in the app's words, until the next attempt replaces it. */
  let objectiveError = '';
  /**
   * Goal drafts that this tab has already sent to ChatGPT.
   *
   * Sending and acknowledging are two different network hops. If ChatGPT accepts the message
   * and the following `/goal/ack` misses the app, `/activity` quite correctly offers the same
   * unacknowledged draft again. Treating that as permission to type again duplicates the user's
   * message. Keep a small receipt journal in sessionStorage so the same browser tab also
   * survives a content-script reload between those two hops; a re-offered spent token retries
   * only its acknowledgement, never the send.
   */
  const GOAL_SPENT_STORAGE = 'clf-goal-spent-v1';
  const goalSpent = new Set();
  try {
    const restored = JSON.parse(sessionStorage.getItem(GOAL_SPENT_STORAGE) || '[]');
    if (Array.isArray(restored)) {
      for (const item of restored.slice(-64)) {
        if (typeof item === 'string' && item.length > 0 && item.length <= 500) goalSpent.add(item);
      }
    }
  } catch {
    // A corrupt/blocked sessionStorage entry costs only the reload receipt; normal ACK still works.
  }

  function goalSpentKey(conversation, token) {
    return `${conversation}\u0000${token}`;
  }

  function goalWasSpent(conversation, token) {
    return goalSpent.has(goalSpentKey(conversation, token));
  }

  function rememberGoalSpent(conversation, token) {
    const key = goalSpentKey(conversation, token);
    goalSpent.delete(key);
    goalSpent.add(key);
    while (goalSpent.size > 64) goalSpent.delete(goalSpent.values().next().value);
    try {
      sessionStorage.setItem(GOAL_SPENT_STORAGE, JSON.stringify([...goalSpent]));
    } catch {
      // The in-memory receipt still closes the ordinary lost-ACK window for this document.
    }
  }


  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const utf8Bytes = (value) => {
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
    try {
      return new Blob([text]).size;
    } catch {
      return text.length * 4;
    }
  };

  const entryBytes = (entry) => {
    try {
      return utf8Bytes(JSON.stringify(entry));
    } catch {
      return MAX_PAGE_QUEUE_BYTES + 1;
    }
  };

  function accountQueueEntry(entry) {
    const previous = queueSizes.get(entry) || 0;
    const next = entryBytes(entry);
    queueSizes.set(entry, next);
    queueBytes += next - previous;
  }

  function removeQueueEntry(index) {
    const [entry] = queue.splice(index, 1);
    if (entry) {
      queueBytes = Math.max(0, queueBytes - (queueSizes.get(entry) || 0));
      queueSizes.delete(entry);
    }
    return entry;
  }

  let documentReady = null;

  async function sendToWorker(message) {
    if (!alive) return null;
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      const text = String(err && err.message ? err.message : err);
      if (text.includes('Extension context invalidated')) alive = false;
      return null;
    }
  }

  /** Talks to the service worker. Returns null once the extension is reloaded. */
  async function ask(message) {
    // A new/reloaded document claims its browser-supplied MessageSender.documentId before
    // any observation or mutation. This is what lets the worker retain a terminal tombstone
    // across external navigation and still admit the genuinely new page, without accepting
    // delayed IPC from the dead one merely because both share a numeric tab id.
    if (!documentReady) documentReady = sendToWorker({ type: 'register_document', navigationEpoch: epoch });
    const registered = await documentReady;
    if (!registered || registered.ok !== true) {
      // A sleeping/reloading service worker is transient. Keep the document unregistered
      // (and therefore fail closed) for this call, but let the next observer tick retry.
      documentReady = null;
      observed.blocked = (registered && registered.error) || 'worker_unreachable';
      return registered;
    }
    observed.blocked = null;
    return sendToWorker({ ...message, navigationEpoch: epoch });
  }

  // ------------------------------------------------------------- observing

  /**
   * Records one observation, stamped with the conversation it was observed in.
   *
   * The conversation id is captured here rather than read at flush time. This tab can
   * navigate from chat A to chat B in the moment between the two, and labelling a
   * whole batch with whatever is current then files A's messages into B's history —
   * silently, permanently, and with no way to tell afterwards which entries were real.
   */
  function emit(observation) {
    const bounded = { ...observation };
    // One browser observation must fit the bridge's bounded HTTP body even when JavaScript
    // character counts badly understate UTF-8 (emoji/CJK). Share one byte budget between
    // prose and rendered HTML; otherwise a single 413 can never be halved and blocks every
    // later observation for this conversation.
    let wireBudget = 400 * 1024;
    const takeUtf8 = (value, budget) => {
      if (typeof value !== 'string') return value;
      if (utf8Bytes(value) <= budget) return value;
      const marker = '\n\n[Chat On Steroids: browser observation truncated to fit transport.]';
      const markerBytes = utf8Bytes(marker);
      let low = 0;
      let high = value.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (utf8Bytes(value.slice(0, middle)) + markerBytes <= budget) low = middle;
        else high = middle - 1;
      }
      return value.slice(0, low) + marker;
    };
    if (typeof bounded.text === 'string') {
      bounded.text = takeUtf8(bounded.text, wireBudget);
      wireBudget -= utf8Bytes(bounded.text);
    }
    if (typeof bounded.renderedHtml === 'string') {
      // Never a partial one: takeUtf8 cuts at a byte count and appends a plain-text notice,
      // which inside markup lands mid-tag — often inside a code block, whose chrome is far
      // larger than the code in it. The canonical text above is the message; this is only
      // ChatGPT's presentation of it, and half a presentation is worth less than none.
      const room = Math.max(0, wireBudget);
      bounded.renderedHtml = utf8Bytes(bounded.renderedHtml) <= room ? bounded.renderedHtml : '';
    }
    const queued = {
      conversationId,
      agent,
      agentCommandId,
      event: { time: Date.now(), ...bounded }
    };
    // Streaming canonical messages replace their older unsent snapshot. Keeping every
    // revision multiplies one growing answer into quadratic memory during an outage.
    const messageId = typeof queued.event.messageId === 'string' ? queued.event.messageId : '';
    if (queued.event.kind === 'assistant_message' && messageId) {
      const prior = queue.findIndex(
        (entry) =>
          !queueGapKeys.has(entry) &&
          entry.conversationId === queued.conversationId &&
          entry.agent === queued.agent &&
          entry.event?.kind === 'assistant_message' &&
          entry.event?.messageId === messageId
      );
      if (prior >= 0) removeQueueEntry(prior);
    }
    queue.push(queued);
    observed.events += 1;
    if (queued.event.kind === 'chat_error' && typeof queued.event.text === 'string') {
      observed.lastError = { text: queued.event.text.slice(0, 300), at: queued.event.time };
    }
    observed.lastKind = typeof queued.event.kind === 'string' ? queued.event.kind : null;
    observed.lastAt = queued.event.time;
    accountQueueEntry(queued);
    // The service-worker journal already records an explicit gap when *its* durable queue has
    // to evict data. Do the same one layer earlier. Silently splicing the oldest observation
    // here made a long service-worker outage look like a complete transcript even though item
    // 401 had already erased item 1 before the durable journal ever saw it.
    while (queue.length > 400 || queueBytes > MAX_PAGE_QUEUE_BYTES) {
      const index = queue.findIndex((entry) => !queueGapKeys.has(entry));
      if (index < 0) break;
      const dropped = removeQueueEntry(index);
      const key = `${dropped.conversationId || ''}\u0000${dropped.agent || ''}\u0000${dropped.agentCommandId || ''}`;
      let held = queueGaps.get(key);
      if (!held) {
        held = {
          entry: {
            conversationId: dropped.conversationId,
            agent: dropped.agent,
            agentCommandId: dropped.agentCommandId,
            event: {
              time: dropped.event.time,
              kind: 'chat_error',
              text: ''
            }
          },
          count: 0,
          kinds: Object.create(null)
        };
        queueGaps.set(key, held);
        queueGapKeys.set(held.entry, key);
        queue.splice(Math.min(index, queue.length), 0, held.entry);
        accountQueueEntry(held.entry);
      }
      held.count += 1;
      const kind = typeof dropped.event.kind === 'string' ? dropped.event.kind : 'observation';
      held.kinds[kind] = (held.kinds[kind] || 0) + 1;
      const detail = Object.entries(held.kinds)
        .map(([name, count]) => `${count} ${name}`)
        .join(', ');
      held.entry.event.text =
        `⚠ ${held.count} observation(s) (${detail}) were lost before the extension service worker accepted them ` +
        'because the page-local queue hit its count or byte budget. This part of the history is incomplete.';
      accountQueueEntry(held.entry);
    }
  }

  /**
   * Hands everything observed so far to the service worker, immediately.
   *
   * The worker journals it durably and owns delivery to the app from there. That split
   * matters: this script dies with the page, and ChatGPT virtualises old turns, so
   * anything still held here when the tab reloads is usually unrecoverable.
   *
   * Observations with no conversation id are handed over too, not held back. On a
   * brand new chat the first user message is observed *before* ChatGPT has assigned an
   * id, and holding it here until one arrived meant a reload in that window took the
   * opening message of the session with it. The worker files those under this tab and
   * renames them when bindConversation() reports the real id.
   */
  async function flush() {
    if (commandJournalGate) return false;
    if (queue.length === 0) return true;
    if (flushWork) return flushWork;
    flushing = true;
    const work = (async () => {
      const batch = queue.slice(0, 200);
      // Freeze overflow markers that enter this delivery attempt. New observations can
      // arrive while the service worker is answering. If they overflow too, they need a
      // new marker; mutating one already in flight and then removing that batch would erase
      // losses the service worker never received.
      for (const entry of batch) {
        const gapKey = queueGapKeys.get(entry);
        if (gapKey && queueGaps.get(gapKey)?.entry === entry) queueGaps.delete(gapKey);
      }
      const reply = await ask({
        type: 'events',
        entries: batch,
        conversationId: conversationId || undefined
      });
      // `ok` means the service worker handled the message, not necessarily that its journal
      // reached chrome.storage.session. Release page ownership only when the worker says the
      // batch is durable, or pending=0 proves the local app already accepted it all. Keeping
      // an ambiguous batch can replay it, which downstream is designed to tolerate; dropping
      // it here cannot be repaired after a service-worker restart.
      observed.sends += 1;
      if (!reply || reply.ok !== true) observed.failures += 1;
      if (reply && reply.ok === true && (reply.durable === true || reply.pending === 0)) {
        for (const entry of batch) {
          if (entry?.event?.kind !== 'tool_evidence') continue;
          for (const call of entry.event.calls || []) traceStage(call && call.requestId, 'sent');
        }
        const sent = new Set(batch);
        for (let index = queue.length - 1; index >= 0; index--) {
          if (sent.has(queue[index])) removeQueueEntry(index);
        }
        return true;
      }
      return false;
    })();
    const tracked = work.finally(() => {
      flushing = false;
      if (flushWork === tracked) flushWork = null;
      // A revival durability fence may be waiting for exact queue entries to leave. Wake it on
      // every flush completion; it inspects object identity and therefore cannot mistake an
      // unsuccessful transport attempt for durable custody.
      notifyCommandReadiness();
    });
    flushWork = tracked;
    return tracked;
  }

  /**
   * Tells the worker which conversation this tab turned out to be.
   *
   * Sent once per id, including after a reload, because the entries waiting to be
   * renamed may have been journalled by a previous page load of this same tab.
   */
  let boundId = null;
  let bindRetryAt = 0;
  async function bindConversation(id) {
    if (!id || boundId === id) return;
    // Latch on the worker's answer, never on the attempt. Marking the id bound up front made
    // a single refused `bind` permanent: the worker kept the tab pointed at the *previous*
    // conversation, and nothing ever asked again. That is what left the popup showing the
    // old chat's id beside the new chat's URL while the app had no session for either.
    const reply = await ask({ type: 'bind', conversationId: id });
    if (reply && reply.ok === true) boundId = id;
  }

  /**
   * Picks up a turn this conversation already had open, before anything is observed.
   *
   * The one thing a reloaded document cannot work out for itself. See `adoptTurnId` for why
   * the id has to come from the app, and note the ordering this depends on: the conversation
   * is adopted and *bound* here, ahead of the first observation, so nothing this page load
   * emits is journalled without an id and then filed as unattributed while the binding
   * catches up.
   *
   * What it deliberately does *not* do is decide, from this one moment, whether the turn is
   * still running. A reload lands mid-rerender as often as not, so a stop button missing at
   * the instant the script starts is the same unreliable sample the settle window exists to
   * discount — and here it would be worse than unreliable, because publishing the section
   * being written as the answer is what closes the turn on the app side. Against that, "the
   * app has this turn open" is real, durable evidence.
   *
   * So the generation is restored either way, with no `turn_start` — the app already has one
   * — and the ordinary lifecycle in observe() decides the rest from there. If the page is
   * still generating, work carries on under the same id. If it is not, the restored turn
   * enters the same quiet window as any other, its section stays live for the duration, and
   * only continuous silence closes it: one final answer under the resumed id, one `turn_end`.
   * A stop button that comes back inside the window simply cancels it.
   */
  function adoptOpenTurn(open) {
    if (!open || generating) return false;
    seedResumeBaseline();
    anchorAdoptedQuestion();
    generating = true;
    turnId = open;
    genNode = null;
    priorSections = new WeakSet(baselineSections);
    priorMarks = baselineMarks;
    turnStartedAt = Date.now();
    lastChangeAt = Date.now();
    quietSince = 0;
    quietTurn = null;
    quietOutcome = null;
    userStopped = false;
    stallReported = false;
    fiberTerminalMessageId = null;
    bindResumeGoalTurn(open);
    return true;
  }

  /**
   * The question the adopted turn is answering is, by construction, already asked.
   *
   * A turn the app holds open was opened by a send, and the newest user message on the page
   * *is* that send. Recording it as an anchor here says so, which closes the one race the
   * durable anchor set cannot: a reload that lands between ChatGPT accepting the message and
   * the app journalling it would otherwise find the message newest and unanchored, read the
   * question as freshly asked, and end the very turn this document just adopted in order to
   * keep. Only that one id, and only alongside an adoption — everything else on the page
   * still has to be recognised from what the app actually holds.
   */
  function anchorAdoptedQuestion() {
    let newest = null;
    for (const message of CLF_DOM.messages()) {
      if (message.role === 'user' && message.id && message.text) newest = message.id;
    }
    if (newest && !userAnchorByMessage.has(newest)) {
      userAnchorByMessage.set(newest, { seq: -1, time: Date.now(), messageId: newest });
    }
  }

  async function resumeOpenTurn() {
    const id = CLF_DOM.conversationId();
    // A chat with no id yet has no app-side record to resume: ChatGPT assigns the id when it
    // accepts the first message, so this is a fresh composer, not a reload into a live turn.
    if (!id) return;
    conversationId = id;
    // Set before either await. If the service worker/app is still waking up and this first
    // activity request fails, the ordinary 2s activity poll will resolve the same question
    // later. Until then observe() refuses to invent a replacement generation id.
    resumeIdentityPending = true;
    await bindConversation(id);
    // The boot pull, brought forward rather than added to: it is the request the start-up
    // sequence was going to make anyway, and it carries the answer.
    await pullActivity();
  }

  /**
   * Tells a resumed turn which of the sections on screen it did not write.
   *
   * `priorSections` is normally sampled from the previous observation, and on the first
   * observation of a page load there is no previous one — so every section on screen looks
   * new and the whole visible transcript would be treated as this generation's output.
   * Seeding it from the DOM here fixes that, with the live turn's own sections deliberately
   * left out: those are the ones still being written, and calling them history would publish
   * a half-written answer as the answer.
   */
  function seedResumeBaseline() {
    const liveTurn = currentAssistantTurn();
    const liveNodes = liveTurn ? liveTurn.nodes || [liveTurn.node] : [];
    baselineSections = assistantSections().filter((node) => liveNodes.indexOf(node) < 0);
    baselineMarks = baselineSections.slice(-3).map((node) => ({ node, mark: sectionMark(node) }));
  }

  /**
   * Forgets what belongs to the chat we just left.
   *
   * The observation queue is deliberately *not* cleared: every entry in it already
   * carries the conversation it was observed in, so anything still waiting for the app
   * is delivered to the right session rather than being thrown away because the tab
   * moved on.
   */
  /**
   * Marks what is on screen right now as belonging to the chat this tab is leaving.
   *
   * Called on a genuine move from chat A to chat B, before anything is attributed to B.
   * ChatGPT changes `/c/<id>` and replaces the transcript as two separate steps, and the
   * URL can win. In that window `resetConversation()` had cleared `seenMessages` while A's
   * messages were still rendered, so the very next pass through observe() — the same one,
   * in fact — saw them as unseen and emitted every one of them under B's id. A whole
   * conversation could be copied into the session of the chat the user opened next.
   *
   * The proof used here is neither a timeout nor an assumption about which step wins: a
   * section still on screen whose turn id this script already observed under A was, as a
   * matter of record, rendered by A. Those exact nodes are retired, and nothing else is.
   *
   * That also settles the opposite ordering safely. If ChatGPT had already replaced the
   * transcript before the URL changed, none of the visible turn ids would have been seen
   * under A, so nothing is retired and B's opening messages are recorded normally — which
   * is the behaviour that must not regress, since the first message of a fresh chat is the
   * one this whole pipeline exists to keep.
   */
  function retireVisible(turns = CLF_DOM.turns()) {
    for (const turn of turns) {
      if (!turn.id || !seenTurns.has(turn.id)) continue;
      for (const node of turn.nodes || [turn.node]) {
        if (node) staleNodes.add(node);
      }
      for (const message of CLF_DOM.messagesIn(turn)) {
        if (message.id) retiredMessages.add(message.id);
      }
    }
    // A tab that lives all day moving between chats must not grow without limit. Only the
    // ids matter here; the nodes themselves are held weakly.
    while (retiredMessages.size > 2000) retiredMessages.delete(retiredMessages.values().next().value);
  }

  /** True for anything rendered by a conversation this tab has already left. */
  function isStale(node) {
    for (let current = node; current; current = current.parentElement) {
      if (staleNodes.has(current)) return true;
    }
    return false;
  }

  function resetConversation() {
    seenMessages.clear();
    reportedConversationTitle = '';
    seenTurns.clear();
    bootstrap = null;
    bySeq.clear();
    streamBySeq.clear();
    for (const root of streamRootsByKey.values()) {
      if (root && root.remove) root.remove();
    }
    streamRootsByKey.clear();
    streamMessageSeq.clear();
    pendingPresentation = null;
    userAnchorByMessage.clear();
    entries = [];
    streamEntries = [];
    streamRequestTurnOwners.clear();
    since = 0;
    job = null;
    pendingTools = 0;
    autoCompactReady = false;
    // An SPA move into another identified chat leaves this document facing a full transcript
    // it has never seen, exactly as a reload does. Until the app has said which of those user
    // messages it already holds, none of them can be read as a send — see resumeIdentityPending.
    resumeIdentityPending = Boolean(conversationId);
    nativeBusy = false;
    nativePhase = '';
    pressedAt = 0;
    localError = '';
    retirementHandledFor = null;
    // The goal loop's state belongs to the chat it was watching. None of it was cleared
    // here, so opening a second chat inherited the first one's: its phase and its error were
    // drawn above the new composer — "The goal loop stopped", about a conversation that is no
    // longer on screen — and `goalTurnId` carried a finished turn's id across as the id this
    // chat must not draft twice. The watch loop itself notices the change on its own tick and
    // exits; what it leaves behind is what this clears.
    goalTurnId = null;
    goalTicketId = null;
    goalConfig = null;
    goalDraft = null;
    setGoalPhase('');
    goalTypingSince = 0;
    dismissedGoalStage = null;
    // A specific goal belongs to the chat it was written for. Carrying a pending one into a
    // different conversation would attach it to whichever chat happened to be opened next.
    pendingObjective = '';
    pendingObjectiveMode = 'goal';
    pendingObjectiveSent = false;
    objectiveBusy = false;
    objectiveError = '';
    removeStagePanel();
    generating = false;
    quietSince = 0;
    quietTurn = null;
    quietOutcome = null;
    turnId = null;
    genNode = null;
    priorSections = new WeakSet();
    priorMarks = [];
    baselineSections = [];
    baselineMarks = [];
    userStopped = false;
    stallReported = false;
    fiberTerminalMessageId = null;
    // The settle window names a turn in the conversation being left behind. Carrying it
    // across would re-read chat B's tree and attribute what it finds to chat A's turn.
    fiberSettleUntil = 0;
    fiberSettled = null;
    pageToolsReported.clear();
    callsReported.clear();
    requestOwnersConfirmed.clear();
    requestOwnersPending.clear();
    requestOwnerRetryAt.clear();
    requestOwnerAttempts.clear();
    messagesReported.clear();
    userAuthoredTimesReported.clear();
    // Fiber descriptors and per-call request evidence belong to the conversation whose
    // React tree they were read from. Never carry that cache across an SPA navigation.
    fiberRows = new Map();
    fiberTurns = new Map();
    fiberScanToken = null;
    fiberPresent = false;
  }

  function currentAssistantTurn(turns = CLF_DOM.turns()) {
    for (let index = turns.length - 1; index >= 0; index--) {
      if (turns[index].role === 'assistant') return turns[index];
    }
    return null;
  }

  /** The logical turn a given section node currently belongs to, or null once it is gone. */
  function turnForNode(node, turns = CLF_DOM.turns()) {
    if (!node) return null;
    for (const turn of turns) {
      for (const section of turn.nodes || [turn.node]) {
        if (section === node) return turn;
      }
    }
    return null;
  }

  /** Every assistant section on the page right now, in document order. */
  function assistantSections(turns = CLF_DOM.turns()) {
    const out = [];
    for (const turn of turns) {
      if (turn.role !== 'assistant') continue;
      for (const section of turn.nodes || [turn.node]) if (section) out.push(section);
    }
    return out;
  }

  /**
   * A cheap statement of what ChatGPT has put in a section.
   *
   * Compared, never stored or sent, and the only question it answers is "has *the page*
   * written into this section since the generation began". Which is why it cannot be the
   * section's raw text: this script rewrites tool-row labels inside assistant sections as
   * steps land, so a mark built from raw text let our own relabel of an old row look like
   * ChatGPT writing a new answer into it, and bound the new generation to a finished
   * section. See CLF_DOM.sectionSignature for what it is built from instead.
   */
  function sectionMark(node) {
    return CLF_DOM.sectionSignature(node);
  }

  /**
   * The assistant section this generation is writing into, or null while that is unknown.
   *
   * Two kinds of evidence, and nothing else. A section that was not on the page before the
   * generation began is this generation's — that is the ordinary case, and the reason the
   * baseline has to come from the previous observation rather than from the DOM as it
   * stands now. Otherwise, a section that *was* there but whose text has changed since is
   * also this generation's, which covers ChatGPT continuing to write into an existing
   * section.
   *
   * Null is a real answer. The version this replaced took the newest assistant section
   * after four seconds regardless, and a turn whose section genuinely had not appeared yet
   * then had the previous turn's commentary and tool rows recorded as its own. Recording
   * nothing for a turn is a gap; recording another turn's work under it is a lie, and the
   * whole point of this batch is that the local session log stops containing those.
   */
  function generationTurn(turns = CLF_DOM.turns()) {
    if (genNode) {
      const held = turnForNode(genNode, turns);
      if (held) return held;
      genNode = null;
    }
    const latest = currentAssistantTurn(turns);
    if (!latest) return null;
    // Any node of the logical turn, not just the first. ChatGPT splits one answer across
    // sibling sections, and a new sibling appended to a section that was already there is
    // still this generation writing.
    for (const node of latest.nodes || [latest.node]) {
      if (!node || priorSections.has(node)) continue;
      genNode = node;
      return latest;
    }
    for (const held of priorMarks) {
      if (!latest.nodes && held.node !== latest.node) continue;
      if (latest.nodes && latest.nodes.indexOf(held.node) < 0) continue;
      if (sectionMark(held.node) === held.mark) continue;
      genNode = held.node;
      return latest;
    }
    return null;
  }

  /**
   * What one turn actually answered.
   *
   * Scoped to the turn on purpose. This used to scan the whole conversation for the last
   * assistant message, which meant that once *any* answer existed anywhere above, every
   * later turn had evidence of completion whether or not it produced anything — a turn
   * that failed silently, or was cut off before it wrote a word, was recorded as
   * `completed`. That outcome is not cosmetic: it is what compaction and the resume
   * handoff read to decide whether the last turn's work needs redoing.
   */
  /**
   * The settled *final* answer of one turn — the last assistant prose it authored.
   *
   * Deliberately not `answerText`, which returns the first and only ever answers "did this
   * turn say anything at all". One logical turn routinely exposes several assistant-authored
   * messages: interim commentary while it works, then the answer. For an outcome those are
   * interchangeable; for a compaction they are not, and taking the first would hand the next
   * chat a line of "let me go through this" in place of the brief.
   */
  function finalAnswerText(turn) {
    if (!turn) return '';
    let last = '';
    for (const message of CLF_DOM.messagesIn(turn)) {
      if (message.role === 'assistant' && message.text) last = message.text;
    }
    return last;
  }

  function answerText(turn) {
    if (!turn) return '';
    for (const message of CLF_DOM.messagesIn(turn)) {
      if (message.role === 'assistant' && message.text) return message.text;
    }
    return '';
  }

  /** Whether an error rendered inside a turn belongs to the given one. */
  function sameTurn(error, turn) {
    if (error.turnId && turn.id) return error.turnId === turn.id;
    // Id-less sections cannot be compared by id without merging all of them, so fall back
    // to the only other thing that is actually true: the error is inside this turn's DOM.
    for (const node of turn.nodes || [turn.node]) {
      if (node && node.contains && node.contains(error.node)) return true;
    }
    return false;
  }

  /** An error occurrence this script has not already emitted for this node and turn. */
  function unreportedError(error, turnKey) {
    const reported = seenErrors.get(error.node);
    return !reported || !reported.has(`${turnKey}\u0000${error.text}`);
  }

  function markErrorReported(error, turnKey) {
    let reported = seenErrors.get(error.node);
    if (!reported) {
      reported = new Set();
      seenErrors.set(error.node, reported);
    }
    reported.add(`${turnKey}\u0000${error.text}`);
  }

  /**
   * Why a turn stopped.
   *
   * Deliberately conservative. "The model hit its output limit" is a claim this page
   * gives no evidence for, so it is never made: an unexplained stop stays unknown.
   */
  function endOutcome(turn) {
    if (userStopped) return { outcome: 'stopped' };
    if (turn && CLF_DOM.interrupted(turn)) {
      return { outcome: 'interrupted', detail: 'ChatGPT marked the turn interrupted' };
    }
    // Only this turn's failures. An error inside another turn's section is that turn's,
    // and a toast still on screen from an earlier failure was already on screen when this
    // turn began — neither says anything about how this one ended.
    const failures = CLF_DOM.errors().filter((error) => {
      if (isStale(error.node)) return false;
      if (error.turnId || error.turn) return turn ? sameTurn(error, turn) : false;
      // A node nothing has recorded yet can only have arrived on this tick, which is this
      // turn's — the same default the clock version had, without the tie.
      return (errorFirstSeen.get(error.node) ?? turnId) === turnId;
    });
    if (failures.length > 0) return { outcome: 'failed', detail: failures[0].text };
    // Degraded fallback only. If the MAIN-world Fiber helper has ever answered on this page,
    // its end_turn bit is the authority on successful completion and mere visible prose is
    // never enough to close a quiet turn: interim commentary is public assistant prose too.
    // A browser where Fiber genuinely is unavailable still needs a usable lifecycle, so the
    // old DOM rule remains there behind this capability check.
    if (!fiberPresent && answerText(turn).length > 0) return { outcome: 'completed' };
    if (turnStalled()) {
      return { outcome: 'stalled', detail: 'no visible output and no progress for ten minutes' };
    }
    return { outcome: 'unknown' };
  }

  /**
   * A generation that has stopped moving: one is open, and nothing has changed it in ten
   * minutes. `turnStartedAt` is set when a generation opens and cleared when it closes, so it
   * is what makes `lastChangeAt` mean anything.
   */
  function turnStalled() {
    return turnStartedAt > 0 && Date.now() - lastChangeAt > STALL_MS;
  }

  /** The turn section a node is rendered in, or null. */
  function sectionOf(node) {
    try {
      return node && node.closest ? node.closest(TURN_SECTION) : null;
    } catch {
      return null;
    }
  }

  /**
   * The local generation a rendered assistant turn belongs to, by node identity.
   *
   * Deliberately not a reverse lookup through `pageTurnIds`. That map runs generation →
   * page id, and ChatGPT reuses `data-turn-id` across turns, so inverting it is ambiguous
   * by construction: several generations can claim one page id and the newest entry is not
   * reliably the one on screen. The node is unambiguous — the live turn is whichever holds
   * `genNode`, and a settled section carries the generation that finished writing into it,
   * seeded for every node of the turn at `turn_end`. The page id stays a hint.
   */
  function localGenerationOf(turn) {
    if (!turn) return null;
    const nodes = turn.nodes || (turn.node ? [turn.node] : []);
    if (generating && genNode) {
      for (const node of nodes) {
        if (node === genNode || (node && node.contains && node.contains(genNode))) return turnId;
      }
    }
    for (const node of nodes) {
      const settled = node ? settledGenerations.get(node) : null;
      if (!settled) continue;
      // React may reuse the same section node for the next assistant turn. A tombstone is
      // valid only while the page-authored section signature is still the one that finished
      // under it; once ChatGPT changes that section, the old generation no longer owns the
      // node and renderer reconciliation must fall through to fresh Fiber identity/native.
      if (sectionMark(node) !== settled.mark) continue;
      return settled.turnId;
    }
    return null;
  }

  function currentGenerationOwner() {
    if (!generating || !turnId) return null;
    const pageTurn = generationTurn();
    return pageTurn ? { pageTurnId: pageTurn.id || null, localTurnId: turnId, pageTurn } : null;
  }

  /**
   * Records the messages on screen that are not still being written.
   *
   * Called before the generation transition, so what the page already had is journalled
   * ahead of anything this tick opens, and again the moment a turn settles, so its answer
   * lands before its `turn_end` rather than a tick later.
   *
   * Returns the id of a user message that was *authored just now*, or null. That is a much
   * narrower fact than "a user message this document had not journalled yet", and the
   * difference is the whole of two live bugs. `seenMessages` is per document, so after a
   * reload the entire transcript is unjournalled — including the prompt of the turn that is
   * still running — and on a fresh chat ChatGPT mounts the Stop control before it mounts the
   * user bubble that caused it. Both used to read as "the user has moved on", which closed a
   * turn that had not ended. See `authoredNow`.
   */
  function reportMessages(nowGenerating) {
    // See resumeIdentityPending: until the app has said what it already holds for this chat,
    // this transcript is unreadable rather than merely unopenable.
    if (resumeIdentityPending) return null;
    let newUserMessage = null;
    const rendered = CLF_DOM.messages();
    // The newest user message on screen, by document order. A send the user has just made is
    // always the last one; anything above it is transcript, however new it is to this
    // document — which is what makes scrolling an old turn back into a virtualized page
    // harmless while a turn is open.
    let newestUserId = null;
    for (const message of rendered) {
      if (message.role === 'user' && message.id && message.text) newestUserId = message.id;
    }
    /**
     * Whether this rendered user message is a send that has just happened.
     *
     * This is the only opening evidence in the script, so it is stated as facts about the
     * conversation rather than about this document's uptime: the message is the newest user
     * message on the page, and the app — which holds the durable record — does not have it.
     * A reloaded or renavigated document therefore recognises every message it is
     * rediscovering as history without needing to have seen it itself, which a per-document
     * set can never do and which no one-observation grace period ever approximated correctly:
     * the live page mounts its transcript seconds after boot.
     *
     * An empty anchor set used to be ambiguous: it describes both a genuinely new first send
     * and an old conversation opened for the first time after install. The composer receipt is
     * the deciding fact in that case. Existing recorded chats keep using the durable anchor
     * difference; zero-anchor chats require the exact recent submitted text as well.
     */
    const authoredNow = (message) => {
      if (message.id !== newestUserId || userAnchorByMessage.has(message.id)) return false;
      if (userAnchorByMessage.size > 0) return true;
      const receipt = userSendReceipt;
      if (!receipt || Date.now() - receipt.at > USER_SEND_RECEIPT_MS) return false;
      const conversationId = CLF_DOM.conversationId();
      if (receipt.conversationId && receipt.conversationId !== conversationId) return false;
      if (receipt.text !== sendText(message.text)) return false;
      userSendReceipt = null;
      return true;
    };
    for (const message of rendered) {
      if (!message.id || !message.text) continue;
      // Left over from a chat this tab has already navigated away from. Not "probably
      // old" — the section it is in was one this script watched under the previous
      // conversation, so filing it here would be filing chat A's transcript into chat B.
      if (retiredMessages.has(message.id) || isStale(message.node)) continue;
      if (message.role === 'user') {
        const key = occurrenceKey(message.id, message.text);
        if (seenMessages.has(key)) continue;
        // Presentation is not enough to commit a continuation, but it is enough to stop this
        // exact marked message from escaping as ordinary session history while Fiber supplies
        // the stable ChatGPT-authored identity. This is the reload path after the URL command
        // marker has already disappeared.
        const continuation = message.text.match(CONTINUATION_MARKER);
        if (continuation && continuation[1] === 'RESUME') {
          continuationJournalPending = true;
          commandJournalGate = true;
        }
        markSeen(key);
        const justAuthored = authoredNow(message);
        if (justAuthored) newUserMessage = message.id;
        emit({
          kind: 'user_message',
          text: message.text,
          messageId: message.id,
          turnId: message.turnId || undefined,
          ...(justAuthored ? { authoredNow: true } : {})
        });
      } else if (message.role === 'assistant') {
        // Assistant identity/content comes exclusively from the MAIN-world Fiber scan now.
        // Keeping this DOM fallback would recreate two competing message sources and is the
        // exact architecture 1.8 removes. User messages remain here because ChatGPT gives
        // them stable data-message-id values directly in the DOM.
        continue;
      }
    }
    return newUserMessage;
  }

  /**
   * Closes the local generation exactly once.
   *
   * `publishFinal` is false only when a new user message proves an otherwise-unknown quiet
   * turn is over while the next assistant turn may already be mounting. In that case a
   * whole-page `reportMessages(false)` could promote the next turn's half-written prose to a
   * final answer. The normal quiet-completion path still publishes the settled answer before
   * `turn_end` as before.
   */
  function finishGeneration(ended, result, publishFinal = true) {
    // Capture the durable identity before tearing local lifecycle state down. A generation
    // without one is not something the recorder can reconcile after reload, so it must never
    // publish a lifecycle boundary (or seed a settled-section mapping) that could close some
    // other named turn by accident. Modern generations always mint/adopt an id; this is the
    // fail-closed guard for stale/legacy/reinjected state.
    const endedTurnId = turnId;
    generating = false;
    quietSince = 0;
    quietTurn = null;
    quietOutcome = null;
    if (ended && endedTurnId) {
      for (const node of ended.nodes || [ended.node]) {
        if (node) settledGenerations.set(node, { turnId: endedTurnId, mark: sectionMark(node) });
      }
    }
    // Interrupted/stopped/failed turns can leave partial assistant prose visible. Publishing
    // that snapshot as `final:true` made a reload recovery synthesize a *completed* turn when
    // the explicit interrupted end was lost. Their prose is already captured as progress;
    // only a completed generation publishes a final answer.
    // Open the request-id settle window for every outcome, not only a completed one. The
    // publish below is about prose and stays gated; ownership evidence is not prose, and an
    // interrupted or failed turn is exactly the turn whose refused tool call most needs to be
    // placed in the chat that made it.
    if (endedTurnId) {
      // `pageTurn` is the live DOM node set, not an id. ChatGPT's virtualized renderer can
      // omit `data-turn-id` entirely, and the post-turn settle window still has to be able
      // to find this generation's Fiber descriptor; the node carries fiber.js's own
      // `data-clf-fiber-turn` stamp, which is present whether or not the page id is.
      fiberSettled = {
        pageTurnId: ended?.id || null,
        localTurnId: endedTurnId,
        pageTurn: ended || null
      };
      fiberSettleUntil = Date.now() + FIBER_SETTLE_MS;
    }
    if (endedTurnId && publishFinal && result.outcome === 'completed') {
      void refreshFiber({
        pageTurnId: ended?.id || null,
        localTurnId: endedTurnId,
        pageTurn: ended || null
      });
    }
    if (endedTurnId) emit({ kind: 'turn_end', turnId: endedTurnId, ...result });
    // Same moment, the other reader: the goal loop wants this turn's answer while `ended`
    // still names its section. It decides for itself whether the turn is one to answer —
    // and waits for it to hold still first. See noteGoalTurn.
    noteGoalTurn(ended, result.outcome, endedTurnId);
    turnStartedAt = 0;
    genNode = null;
  }

  function observe() {
    const id = CLF_DOM.conversationId();
    // One DOM turn snapshot per observation, created lazily because a transient id-less route
    // returns before transcript work. Everything below this stack frame that needs `turns()`
    // receives the same array explicitly; it is never cached across an await or another tick.
    // Besides avoiding repeated transcript walks, this prevents one observation from combining
    // section identity from two React frames if ChatGPT mutates synchronously through a hook.
    let turnSnapshot = null;
    const turnsNow = () => {
      if (turnSnapshot === null) turnSnapshot = CLF_DOM.turns();
      return turnSnapshot;
    };
    // A missing id is not a navigation signal. ChatGPT can transiently unmount the route/
    // transcript state during React churn while the same conversation and tab are still
    // alive. Treating that one-frame null as "closed" used to release the background tab
    // mapping and terminalise a bound worker even though its model kept running. Real tab
    // lifetime is owned by chrome.tabs.onRemoved in background.js; an SPA move is proven
    // here only when another concrete conversation id replaces the old one.
    if (id && id !== conversationId) {
      // A goal written into a chat that had no id yet, whose opening message is the reason
      // this id exists. It has to outlive the reset below — which exists to stop a goal
      // leaking into whatever chat is opened next, and this is the one case where the next
      // chat *is* the one the goal was written for. Only a message that actually reached
      // ChatGPT counts; an abandoned attempt is dropped with everything else.
      const abandonedOpening = Boolean(pendingObjective) && !pendingObjectiveSent;
      const carried = pendingObjectiveSent ? pendingObjective : '';
      // Read here, with the text, because resetConversation() below clears both and the mode
      // is the half that cannot be reconstructed afterwards from anything on this page.
      const carriedMode = pendingObjectiveMode === 'loop' ? 'loop' : 'goal';
      if (conversationId) {
        // A genuine move to another *identified* chat: close the old one out and start
        // clean. The order matters — what the old chat left on screen is retired before
        // the new id is adopted, because from the next line onwards everything emitted
        // carries that id.
        void ask({ type: 'closed', conversationId });
        retireVisible(turnsNow());
        epoch++;
        conversationId = id;
        resetConversation();
        // The same question boot asks, at the same moment boot asks it: which of this chat's
        // user messages does the app already hold? resetConversation() has just armed the
        // identity gate, and until it is answered this document reads no transcript at all,
        // so bring the pull forward instead of leaving the new chat unreadable until the
        // ordinary poll comes round.
        void pullActivity();
      } else {
        // An id-less tab can become concrete in two very different ways: our own proven
        // opening send created this conversation, or the user opened an already-existing chat.
        // Only the former owns a pending goal. Without that send receipt, carrying the goal here
        // would silently attach it to whichever sidebar chat happened to be opened next.
        conversationId = id;
        void bindConversation(id);
        if (abandonedOpening) {
          pendingObjective = '';
          pendingObjectiveMode = 'goal';
          pendingObjectiveSent = false;
          goalConfig = null;
          goalDraft = null;
          objectiveError = '';
          setGoalPhase('');
          removeStagePanel();
        }
      }
      // …and this is the moment a goal saved into a New Chat finally has something to be
      // saved against. The message that produced this id was written from that goal, so the
      // chat is already one turn into it; binding here is what lets the ordinary loop pick
      // it up from the next turn onwards. See pendingObjective.
      if (carried) {
        pendingObjective = '';
        pendingObjectiveMode = 'goal';
        pendingObjectiveSent = false;
        // The mode goes with it, and this is the only request that can carry it: from here on
        // the chat has an id, and anything that asks the app which mode to use gets the
        // standing switch's answer rather than the one the user actually chose.
        void ask({ type: 'goal_objective', conversationId: id, text: carried, mode: carriedMode }).then((reply) => {
          if (!alive || conversationId !== id) return;
          if (reply && reply.ok === true) {
            const stored = reply.data && typeof reply.data.objective === 'string' ? reply.data.objective : carried;
            const switched =
              reply.data && typeof reply.data.mode === 'string' && typeof reply.data.enabled === 'boolean'
                ? { enabled: reply.data.enabled, mode: reply.data.mode, own: true }
                : null;
            goalConfig = { ...(goalConfig || {}), ...(switched || {}), objective: stored };
          } else {
            objectiveError = replyError(reply) || 'the goal could not be saved to this chat';
          }
          injectStage();
        });
      }
    }

    // `/c/A` -> `/` is ambiguous by itself: ChatGPT uses that shape both for transient
    // router churn in A and while opening a genuinely fresh chat B. What is never safe is
    // continuing to *author* observations as A while the route has stopped proving A. Hold
    // the exact existing state until a concrete id comes back. If it is A, observation
    // resumes unchanged; if it is B, the branch above retires A and resets before anything
    // visible in B is recorded. No timeout and no DOM-position guess participates.
    if (!id && conversationId) {
      // The route no longer proves that the composer on screen belongs to this chat, and A's
      // presentation must not stay mounted over an unbound New Chat composer. That decision
      // belongs to injectStage() alone, which asks the same question every tick and knows the
      // one id-less case worth painting: a chat being opened on a goal, whose opening message
      // is being written right now. Tearing the panel down here as well made every tick
      // destroy and rebuild the node injectStage() had just put back — a fresh element once a
      // second, so its progress animation never survived long enough to play a single cycle.
      void flush();
      return;
    }

    // Every section on screen, not just the assistant's: this is the record of what this
    // script watched while on this conversation, and it is the whole basis on which
    // retireVisible() later decides which sections the tab is leaving behind.
    const observedTurns = turnsNow();
    for (const seen of observedTurns) {
      if (seen.id) seenTurns.add(seen.id);
    }
    if (seenTurns.size > 2000) seenTurns.delete(seenTurns.values().next().value);

    // ChatGPT commonly assigns the human title after the first answer, not with the route id.
    // Re-read it so the generic local fallback can be promoted later without using title as
    // identity or guessing from DOM position.
    const pageTitle = conversationId && CLF_DOM.conversationTitle ? CLF_DOM.conversationTitle() : '';
    if (pageTitle && pageTitle !== reportedConversationTitle) {
      reportedConversationTitle = pageTitle;
      emit({ kind: 'conversation_title', text: pageTitle });
    }

    const nowGenerating = CLF_DOM.generating();

    // The transcript that is already settled goes in first — before this tick can open a
    // new generation. The recorded order used to be the other way round: `turn_start` for
    // the live turn at sequence 2, the user message that asked for it at 3, and the
    // conversation's earlier history at 4 and 5. A log whose first assistant turn precedes
    // the question that caused it cannot be read back as a session, however complete it is.
    const newUserMessage = reportMessages(nowGenerating);
    if (newUserMessage) {
      fiberTerminalMessageId = null;
      // A terminal Goal card explains the answer immediately before this user message.
      // Once the user has continued manually it is history, not current composer state.
      // Remember its key just like an X click so the next activity repaint cannot revive it.
      dismissTerminalGoalStage();
    }
    if (!nowGenerating) fiberTerminalMessageId = null;

    // A user message the user has just authored is definitive evidence that the generation
    // before it is over, even if it never produced final prose or an error. This is the
    // interruption/follow-up shape that previously merged two user turns because the stop
    // button for the new generation came back before the old four-second window closed.
    //
    // "Just authored" is `reportMessages`'s judgement, not this document's memory. The
    // version that asked only whether *this page load* had journalled the message closed a
    // live turn on every reload, and split every chat's opening turn in two.
    if (generating && newUserMessage) {
      const ended = quietTurn || generationTurn(observedTurns);
      const fresh = endOutcome(ended);
      const result = quietOutcome && quietOutcome.outcome !== 'unknown' ? quietOutcome : fresh;
      // A new user message is an actual boundary, unlike a disappearing Stop control. Once
      // that boundary is proven, authored prose is enough to classify the old turn as a
      // completed answer when no stronger failure/interruption/stall outcome exists.
      const bounded = result.outcome === 'unknown'
        ? answerText(ended).length > 0
          ? { outcome: 'completed' }
          : { outcome: 'interrupted', detail: 'a new user message replaced the unfinished turn' }
        : result;
      finishGeneration(ended, bounded, false);
    }

    // A turn is opened by a send, and by nothing else.
    //
    // The Stop control used to be the opener, and it is not evidence that a turn began — it is
    // evidence that the page is busy, which is a different claim and one the browser makes on
    // its own account. Measured live, on every page load of a conversation: ChatGPT mounts
    // `data-testid="stop-button"` about 2.7 s in and holds it for roughly 1.2 s over an empty
    // transcript. Read as a generation, that hydration artifact opened a turn on the app side
    // for a chat that was doing nothing, and because `endOutcome()` can find no answer, error
    // or stall for a turn that never existed, the turn stayed open indefinitely and eventually
    // adopted the *previous* turn's final message as its own completion. Requiring a rendered
    // transcript alongside Stop only narrows that window; it leaves the same wrong premise in
    // place, and any later flicker of the control over a settled transcript reproduces it.
    //
    // The premise is replaced instead. `newUserMessage` is a conversation-level fact —
    // ChatGPT's own stable id for the newest user message, which the app has no durable record
    // of — so it is true exactly once per send and false for every reload, renavigation and
    // rehydration of that same send. It is also what the user means by a turn: the question
    // starts it. The two branches above and here are therefore one boundary read twice: a send
    // ends whatever generation was running and opens the one it asked for.
    //
    // Everything Stop still does is downstream of this, describing a turn that already exists:
    // its liveness, the quiet window that closes it, the flicker that cancels that window. A
    // turn a previous document opened arrives by adoptOpenTurn() from the app's `activeTurnId`,
    // which is adoption and not opening — no second `turn_start` for one generation.
    if (newUserMessage && !generating) {
      generating = true;
      quietSince = 0;
      quietTurn = null;
      quietOutcome = null;
      userStopped = false;
      stallReported = false;
      genCount++;
      turnId = `g-${RUN_ID}-${epoch}-${genCount}`;
      bindResumeGoalTurn(turnId);
      genNode = null;
      // What was already there is what this generation must not adopt — as it stood at the
      // *previous* observation. Reading the DOM here instead is what the first version of
      // this did, and by this point ChatGPT has usually already mounted the section it is
      // about to write into, so the generation disowned its own section.
      priorSections = new WeakSet(baselineSections);
      priorMarks = baselineMarks;
      turnStartedAt = Date.now();
      lastChangeAt = Date.now();
      // "Wait for this turn to finish" was about a turn that has now been replaced. Keeping
      // it would make the composer explain, after the fact, a refusal that no longer applies.
      localError = '';
      pressedAt = 0;
      // Unconditional, unlike before. The old code only announced a turn once it had a
      // ChatGPT turn id to name it by, so a generation whose section had not mounted yet
      // was never reported at all — and the app, which places a tool call by asking which
      // conversation is mid-turn, therefore could not place the calls of exactly the turns
      // that call tools fastest.
      //
      // A turn resumed at boot never reaches this branch: resumeOpenTurn() restores
      // `generating` before the first observation, so there is no transition to open. That is
      // what keeps the app's `turn_start` the only one — repeating it would clear the very
      // state the resume exists to keep, since recorder.ts empties `progress`, `pageTools`
      // and the pending sightings on every turn_start.
      emit({ kind: 'turn_start', turnId });

      // The compaction binding is made here and only here: the first generation to open
    }

    // Which generation an error first came into view during, recorded before anything reads
    // it and after this tick has opened its generation, so a banner arriving with a turn is
    // that turn's and one already on screen belongs to whatever was running when it
    // appeared. By generation and not by clock: the previous version stored `Date.now()`
    // and endOutcome compared it against `turnStartedAt`, two stamps taken microseconds
    // apart in the same tick. At millisecond resolution they tie, and a tie read as "this
    // turn's" — so an undismissed banner from an earlier failure could fail the next turn,
    // which is the exact thing that comparison exists to prevent.
    const visibleErrors = CLF_DOM.errors();
    for (const error of visibleErrors) {
      if (!errorFirstSeen.has(error.node)) errorFirstSeen.set(error.node, turnId);
    }

    const turn = generating ? generationTurn(observedTurns) : currentAssistantTurn(observedTurns);
    if (generating && turn && turn.id) {
      pageTurnIds.set(turnId, turn.id);
      if (pageTurnIds.size > 500) pageTurnIds.delete(pageTurnIds.keys().next().value);
    }

    // Progress lines are only meaningful while they are moving. Captured live they
    // give the one thing a page reloaded from history can never reconstruct: the
    // order things happened in.
    if (turn) CLF_DOM.markProgress(turn);

    // Request ownership is a page-model fact, not a rendered-row fact. React can leave the
    // stop/generation state live while the assistant turn DOM is briefly absent or empty;
    // that was enough in 1.7.9 to miss metadata.request_id and dump otherwise valid prime /
    // worker calls into Unattributed. Scan whenever a generation is live. If ChatGPT's
    // message model is not available yet the helper simply returns no evidence, and the next
    // observation tries again while the exact MCP request waits in the recorder grace window.
    // A refused `bind` is not a decision, it is an outage — a sleeping worker, or a tab whose
    // ownership was wrongly retired. Keep asking until the worker agrees, throttled so a real
    // outage costs one message every few seconds rather than one per tick.
    if (conversationId && boundId !== conversationId && Date.now() - bindRetryAt >= 5000) {
      bindRetryAt = Date.now();
      void bindConversation(conversationId);
    }

    if (continuationJournalPending) {
      void refreshFiber();
    } else if (generating) {
      void refreshFiber();
    } else if (fiberTerminalMessageId && nowGenerating) {
      const terminalTurn = currentAssistantTurn(observedTurns);
      void refreshFiber({
        pageTurnId: terminalTurn?.id || null,
        terminalProbe: fiberTerminalMessageId
      });
    } else if (fiberSettleUntil > Date.now()) {
      // ChatGPT does not always have `metadata.request_id` on a connector request by the time
      // the turn it belongs to ends — sometimes it appears seconds later, sometimes only when
      // the conversation is next synced. Until 1.8.8 the only reader of that field ran while
      // `generating` was true, so an id that landed a second after the stop button vanished
      // was never read at all: the call stayed in Unattributed activity until the *next* turn
      // started, or the user reloaded. Keep scanning after the turn, but only while a call is
      // actually still missing its id, and never past the ceiling — see `fiberSettleUntil`.
      // Flushed straight away rather than on the idle 10-second cadence: the app is usually
      // already blocked waiting for exactly this id, and the wait is measured in seconds.
      void refreshFiber(fiberSettled).then(() => {
        if (!alive || !sameChat()) return;
        void flush();
      });
    }

    if (generating && turn) {
      // Stay on the generation we opened. ChatGPT can reorder/replace assistant sections
      // while a turn is running; re-reading the newest DOM turn here has reproduced
      // progress from request -7 being filed under the older request -5.
      // Authored commentary/prose is captured by refreshFiber() as canonical assistant
      // messages keyed by ChatGPT's own message id. Do not emit a second progress stream.
      // Native activity is emitted by refreshFiber() from ChatGPT's stable thought-message
      // identity. DOM rows alone are presentation and never mint durable page_tool ids.
      if (!stallReported && Date.now() - lastChangeAt > STALL_MS) {
        stallReported = true;
        emit({ kind: 'chat_error', text: 'No visible progress for ten minutes. The turn is still marked as generating.', turnId });
      }
    }

    if (generating && nowGenerating && quietSince > 0) {
      // The stop button came back, so it never went away in the sense that matters: this is
      // one turn that flickered, not two turns. Everything the generation holds — its id,
      // its baselines, its reported-progress map — is still the right state to carry on
      // with, so the settle window is simply abandoned.
      quietSince = 0;
      quietTurn = null;
      quietOutcome = null;
    }

    if (generating && !nowGenerating) {
      // The turn as it stood on the first quiet observation, read once. See quietOutcome.
      if (quietSince === 0) {
        quietSince = Date.now();
        quietTurn = turn || null;
        quietOutcome = endOutcome(turn);
      }
      const freshOutcome = endOutcome(quietTurn || turn);
      // Preserve a failure/interruption captured before its banner disappears, while still
      // allowing the common opposite transition: the stop control vanishes first and the
      // final answer appears a beat later. Freezing `unknown` at the first sample is what made
      // ordinary completed turns end as unknown.
      if (
        freshOutcome.outcome !== 'unknown' &&
        (!quietOutcome || quietOutcome.outcome === 'unknown' ||
          (quietOutcome.outcome === 'completed' && freshOutcome.outcome !== 'completed'))
      ) {
        quietOutcome = freshOutcome;
      }
      const quietFor = Date.now() - quietSince;
      // Explicit stop closes now: the user pressed the button, so there is nothing to wait
      // for and a composer that stays disabled for another four seconds is a bug of its own.
      // A user stop also overrides the outcome captured on the first quiet observation.
      if (userStopped) quietOutcome = { outcome: 'stopped' };
      const result = quietOutcome || endOutcome(quietTurn || turn);
      // `unknown` means exactly "nothing proves the turn ended". A real
      // answer/error/interrupt closes after the settle window, and ten minutes of genuine
      // silence upgrades itself to `stalled` through endOutcome().
      // ChatGPT also flips `data-interrupted=true` transiently between tool/reasoning phases.
      // Session 2026-08-19-86fa06c9 proved it: that marker closed a turn as interrupted and
      // the same website turn emitted commentary 9 ms later, followed by MCP calls for almost
      // two minutes. The marker is therefore an *outcome* if a terminal boundary is proven,
      // never a terminal boundary on its own. User stop is already explicit; a new user
      // message is handled above, and Fiber end_turn closes independently in refreshFiber().
      const markerOnlyInterrupted = result.outcome === 'interrupted' && !userStopped;
      if (
        userStopped ||
        (result.outcome !== 'unknown' && !markerOnlyInterrupted && quietFor >= TURN_SETTLE_MS)
      ) {
        // The turn the end is about is the one that was on screen when it went quiet.
        // Re-reading it here would pick up whatever ChatGPT has rendered since, which during
        // a settle window can be a different section entirely.
        const ended = quietTurn || turn;
        finishGeneration(ended, result);
      }
    }

    /**
     * One rendered occurrence, one record.
     *
     * The identity is the node the error is rendered in plus its text — never the text on
     * its own, which was the bug: the same wording failing on turn nine was taken for the
     * banner already recorded on turn three and dropped, so a repeated failure left no
     * trace and, because endOutcome() consulted the same filter, was written down as a
     * completed turn instead.
     *
     * Deliberately not scoped by turn for a toast. A banner ChatGPT leaves on screen keeps
     * its node, and scoping by turn would republish that one banner on every turn that
     * followed it. A banner that is dismissed and shown again is a new node, which is
     * exactly the difference between the same failure still being displayed and the same
     * failure happening a second time. Errors rendered inside a turn carry that turn's id
     * as well, so two turns failing identically stay distinct even in the markdown case.
     */
    const fallbackTurn = turnId || (turn && turn.id) || '';
    for (const error of visibleErrors) {
      if (isStale(error.node)) continue;
      // The DOM adapter names ChatGPT's page turn. The recorder timeline is keyed by the
      // local generation this document minted, so putting that page id on a live error leaves
      // the row outside its turn group and chronology renders it after every later call. Resolve
      // through the same node ownership used by messages/tools; a top-level banner belongs to
      // the generation in which it first appeared.
      const pageTurn = error.turn || (turn && sameTurn(error, turn) ? turn : null);
      const recordedTurn =
        localGenerationOf(pageTurn) ||
        (!error.turnId ? errorFirstSeen.get(error.node) : null) ||
        error.turnId ||
        fallbackTurn;
      const scope = recordedTurn || '';
      if (!unreportedError(error, scope)) continue;
      markErrorReported(error, scope);
      emit({
        kind: 'chat_error',
        text: error.text,
        turnId: recordedTurn || undefined,
        recoverable: error.recoverable === true
      });
    }

    // Last, so the next generation's idea of "what was already on the page" is this tick's
    // page rather than the one it is about to change. Marks are kept only for the newest
    // few sections: they exist to answer "has ChatGPT written into this since", and no
    // generation ever binds to a section further back than that.
    baselineSections = assistantSections(observedTurns);
    baselineMarks = baselineSections.slice(-3).map((node) => ({ node, mark: sectionMark(node) }));
    maybeRecoverResumeGoalTurn();
    // A revival can be waiting outside the command lease while this exact turn settles. Its
    // readiness depends partly on recorder state (`generating`, pending tools/native work), not
    // only DOM mutations, so wake those waiters whenever an observation publishes a new view of
    // the lifecycle. They still re-check the exact conversation and every readiness predicate.
    notifyCommandReadiness();
    void flush();
  }

  const turnIdOf = (section) =>
    section && section.getAttribute ? section.getAttribute('data-turn-id') : null;

  /**
   * Watches for connector rows as ChatGPT inserts them, rather than waiting for a tick.
   *
   * The poll cannot carry this on its own. A tool call the app answers immediately can be
   * consumed, answered and the whole turn finished inside one observe interval, and the
   * next tick then sees a page that is no longer generating and reports nothing — so the
   * chat's own call is filed as if it came from another device. Insertion is the moment
   * the evidence exists, so that is when it is taken.
   *
   * Rows that are merely *drawn* are not evidence, and this is where that line is held.
   * Opening an old chat, reloading one, or scrolling back through history all insert
   * connector rows that were rendered days ago, and reporting those would let yesterday's
   * work vouch for a call happening right now. The two are told apart by where the row
   * arrived: ChatGPT creates a turn's section when the turn starts and appends rows into it
   * as they happen, so a row appended into a section that was already on the page is this
   * chat working, while a whole section arriving with its rows inside it is history being
   * drawn. Only that second case has to ask whether the page is generating, and it is the
   * uncommon one — which matters, because the stop button that answers it is a selector
   * like any other and a page that stops matching it must not take attribution with it.
   */
  function watchToolRows() {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    try {
      seededPath = location.pathname;
    } catch {
      seededPath = null;
    }
    const observer = new MutationObserver((records) => {
      // Recorder takeover cannot disconnect observers created by the predecessor's isolated
      // world, so `alive` is the ownership fence. Without it every extension reload leaves a
      // watcher behind that still scans connector mutations and starts a MAIN-world Fiber
      // round-trip even though sendToWorker() has correctly gone inert.
      if (!alive || !sameChat()) {
        return;
      }
      let sawConnector = false;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          if (!CLF_DOM.hasConnectorRow(node)) continue;
          sawConnector = true;
          break;
        }
        if (sawConnector) break;
      }
      if (!sawConnector) return;
      void refreshFiber().then(() => {
        if (!alive || !sameChat()) return;
        void flush();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    rememberCleanup(() => observer.disconnect());
  }

  /**
   * React also changes visible commentary without inserting a connector row. Observe those
   * turn-local mutations immediately so the recorder sees short-lived updates instead of
   * waiting up to a second for the polling tick. Mutations caused by our own stream are
   * ignored to avoid feeding the renderer back into itself.
   */
  function watchTranscript() {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    let timer = null;
    let urgentQueued = false;
    const observer = new MutationObserver((records) => {
      if (!alive || !sameChat()) return;
      // Stop is mounted under the composer, outside TURN_SECTION. In a background tab the final
      // prose can arrive while Stop still exists (scheduling the throttled debounce below), and
      // Stop removal can then be the *only* terminal mutation. Check the local->page generation
      // edge before filtering to transcript mutations so that composer-side Stop removal wakes
      // the recorder in a microtask. observe() still owns every completion rule and therefore
      // remains conservative on transient tool-phase dropouts.
      if (generating && !CLF_DOM.generating()) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (!urgentQueued) {
          urgentQueued = true;
          void Promise.resolve().then(() => {
            urgentQueued = false;
            if (!alive || !sameChat()) return;
            observe();
          });
        }
        return;
      }
      const relevant = records.some((record) => {
        const target = record.target && record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (!target || (target.closest && target.closest('.clf-stream'))) return false;
        if (target.closest && target.closest(TURN_SECTION)) return true;
        for (const node of record.addedNodes || []) {
          if (!node || node.nodeType !== 1) continue;
          if (node.matches(TURN_SECTION) || node.querySelector(TURN_SECTION)) return true;
        }
        return false;
      });
      if (!relevant) return;
      // Background tabs are allowed to throttle setTimeout aggressively. The ordinary 250 ms
      // debounce below is therefore not a reliable way to notice the one mutation that matters
      // most: ChatGPT has just dropped its Stop control and the final transcript mutation has
      // landed. If this document already believed a generation was open, inspect that terminal
      // candidate in a microtask immediately. `observe()` still fails closed on transient Stop
      // dropouts, and Fiber `end_turn` remains the exact early-completion proof, so this does not
      // revive the old interrupted-marker false positive. It only removes a throttled timer from
      // the path that starts turn_end -> Goal in a hidden tab.
      if (timer !== null) return;
      // Streaming Markdown can mutate once per token and a virtualized history mount can
      // deliver hundreds of DOM records in one navigation. Running the full conversation
      // scan synchronously for every MutationObserver turn is what made clicking a large
      // chat freeze the tab. Coalesce the burst into one capture pass, and never repaint
      // Overwrite from the observer itself. Presentation catches up on its normal tick after
      // the app has durably accepted the transcript.
      timer = setTimeout(() => {
        timer = null;
        if (!alive) return;
        observe();
      }, TRANSCRIPT_OBSERVE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    rememberCleanup(() => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    });
  }

  const TURN_SECTION = 'section[data-testid^="conversation-turn"]';
  let seededPath = null;

  /**
   * Whether the page is still on the chat these counts were taken from.
   *
   * A brand-new chat being given its id — `/` to `/c/<id>` — is the same chat, not another
   * one. ChatGPT assigns the id only once the first turn is under way, so treating that as
   * a navigation banked the rows of the turn in flight as history and lost the evidence for
   * the first call a fresh chat makes. In an agent chat that call is the one that says who
   * the chat is, so this cost every worker its identity.
   */
  function sameChat() {
    try {
      const path = location.pathname;
      if (path === seededPath) return true;
      // Through the canonical parser, not a second `/c/` test of its own. In a Project the
      // route is `/g/<project>/c/<id>`, so the local test recognised no id there: a fresh
      // Project chat being given its id looked like a navigation to a different chat, which
      // banked the turn in flight as history and lost the evidence for the first call — the
      // call that says who the chat is.
      const named =
        CLF_DOM.conversationFromPath(path) !== null && CLF_DOM.conversationFromPath(seededPath) === null;
      seededPath = path;
      return named;
    } catch {
      // The document can disappear while an async Fiber refresh is settling. That is not
      // a navigation to attribute; it is simply a dead observer callback.
      return false;
    }
  }

  // ------------------------------------------------------------ relabelling

  const TOOL_ICON_PATHS = {
    edit: ['M4 20h4l11-11-4-4L4 16v4', 'M13.5 6.5l4 4'],
    create: ['M12 5v14', 'M5 12h14'],
    delete: ['M5 7h14', 'M9 7V5h6v2', 'M8 7l1 12h6l1-12'],
    move: ['M7 17 17 7', 'M10 7h7v7'],
    read: ['M5 4h14v16H5z', 'M8 8h8', 'M8 12h8', 'M8 16h5'],
    search: ['M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14', 'M16 16l4 4'],
    browse: ['M4 6h16v12H4z', 'M4 9h16'],
    run: ['M4 5h16v14H4z', 'M7 9l3 3-3 3', 'M12 15h5'],
    process: ['M4 5h16v14H4z', 'M7 9l3 3-3 3', 'M12 15h5'],
    screen: ['M3 5h18v12H3z', 'M8 21h8', 'M12 17v4'],
    input: ['M6 3l11 9-6 1 3 6-2 1-3-6-4 4z'],
    clipboard: ['M7 5h10v16H7z', 'M9 5V3h6v2', 'M10 10h4', 'M10 14h4'],
    session: ['M20 11a8 8 0 1 1-2.3-5.7', 'M20 4v7h-7'],
    agent: ['M12 3l7 4v10l-7 4-7-4V7z', 'M9 12h6'],
    thought: ['M9 18h6', 'M10 21h4', 'M8.5 14.5A6 6 0 1 1 15.5 14.5', 'M12 6v3', 'M12 12h.01'],
    other: ['M5 5h14v14H5z']
  };

  function toolIconKey(kind) {
    return TOOL_ICON_PATHS[kind] ? kind : 'other';
  }

  function setToolIcon(node, kind) {
    const key = toolIconKey(kind);
    if (node.dataset.clfIcon === key && node.firstElementChild) return;
    node.dataset.clfIcon = key;
    node.replaceChildren();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const d of TOOL_ICON_PATHS[key]) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    node.append(svg);
  }

  function labelText(entry) {
    return entry.summary.detail ? `${entry.summary.title} · ${entry.summary.detail}` : entry.summary.title;
  }

  /**
   * Metrics worth showing in the compact browser transcript.
   *
   * A successful exec can return while its child is still running. In that case the
   * recorder's `✓ 10.0s` is the duration of the initial wait/tool response, not the duration
   * of the command the user thinks the row represents. That number is useful forensic data
   * and stays in the session record, but presenting it as a completion badge is misleading.
   * Keep concrete output metrics (line deltas, hit counts, exit failures) and suppress only
   * the green success-duration shape in the extension. See TODO T-129.
   */
  function displayMetric(summary) {
    const metric = summary && typeof summary.metric === 'string' ? summary.metric.trim() : '';
    if (!metric) return '';
    if (summary.kind === 'run' && /^✓\s+\d+(?:\.\d+)?(?:ms|s|m)$/.test(metric)) return '';
    return metric;
  }

  // ----------------------------------------------------------- fiber evidence

  /**
   * What ChatGPT's own client state says about the connector rows on this page.
   *
   * Supplied by extension/fiber.js, which is the only code we run in the page's own
   * JavaScript context. Two things come from here that the DOM simply does not carry:
   * the tool a collapsed row actually ran, and how many further calls that one row is
   * standing in for.
   *
   * **This is untrusted input.** The page can post exactly these messages itself, so a
   * descriptor is never proof that a call happened — it may only change how a row that is
   * *already on the page* is labelled. It must never reach the app: nothing here writes a
   * recorded event, decides an agent's identity, or counts as evidence that a tool call in
   * the app belongs to this chat. `connectorRows()` remains the only thing that vouches
   * for that, and it reads the DOM. Everything below therefore re-validates shape, type
   * and length rather than trusting that our own helper is what replied.
   */
  const FIBER_ASK = 'clf-fiber-ask';
  const FIBER_REPLY = 'clf-fiber-reply';
  // 3: adds an exact turn-wide TobisComputer call count so folded api_tool metadata calls
  // are not mistaken for local MCP calls. Older descriptors are refused rather than mixed.
  // 4: adds a turn-level array naming each local connector request.
  // 5: adds the Fiber conversation id plus canonical rendered assistant messages.
  // 6: adds request-id ownership evidence used by deterministic MCP attribution.
  // 7: keys streaming commentary and native activity by ChatGPT thought/message identity,
  //    so React row replacement, raw text UUID rotation and refresh cannot mint duplicates.
  const FIBER_VERSION = 10;
  const FIBER_TIMEOUT_MS = 1500;
  const FIBER_MAX_ROWS = 400;
  /** Assistant turns whose per-call evidence is accepted from one scan. */
  const FIBER_MAX_TURNS = 6;
  /** Connector requests accepted for one turn. */
  const FIBER_MAX_CALLS = 200;
  const FIBER_MAX_MESSAGES = 200;
  const FIBER_MAX_ACTIVITIES = 200;
  const TOOL_NAME = /^[a-z0-9_.-]{1,64}$/i;
  const FIBER_BUSY_CAPTIONS = new Set(['thinking', 'thinking about it', 'reasoning', 'working', 'loading', 'done', 'called tool']);
  const FIBER_TIMER_CAPTION = /^(?:worked|thought|reasoned|thinking)\s+for\s+[\d.,]+\s*(?:s|m|h|sec|secs|seconds?|min|mins|minutes?|hours?)\b/;

  /** Descriptors from the last successful scan, keyed by the stamp on their row. */
  let fiberRows = new Map();
  /** Per-turn descriptors from the last scan, keyed by the ephemeral stamp on its section. */
  let fiberTurns = new Map();
  /** Exact scan frame those two descriptor maps came from. */
  let fiberScanToken = null;
  let fiberAsking = null;
  /** Off until the helper answers once, so a browser without it behaves exactly as before. */
  let fiberPresent = false;
  /** Avoid turning a missing MAIN-world helper into one script injection per observer tick. */
  let fiberRepairAt = -Infinity;
  let fiberRepairing = null;
  /**
   * How long a finished turn keeps being re-read for request ids that were not there yet.
   *
   * `metadata.request_id` is the only ownership evidence there is, and ChatGPT publishes it
   * on its own schedule — usually while the turn runs, sometimes seconds after it ends. The
   * window is a ceiling, not a schedule: scanning stops the moment every call on screen has
   * an id, so a normal turn pays nothing for it. Ninety seconds is chosen against the live
   * failures, where the id landed twenty seconds after the turn completed and, in one case,
   * only when the page was reloaded two minutes later; anything unresolved by then is not
   * coming without a reload, and the deterministic repair pass will place it if it ever does.
   */
  const FIBER_SETTLE_MS = 90_000;
  let fiberSettleUntil = 0;
  /** The turn identity to attribute a settled-window scan to, from finishGeneration. */
  let fiberSettled = null;
  /**
   * Message ids whose per-call evidence has already been reported. Every scan re-reads the
   * whole turn, so without this the same request would be re-sent on every poll.
   */
  const callsReported = new Map();
  /** Exact request ids the app has ACKed as owned by a concrete conversation. */
  const requestOwnersConfirmed = new Map();
  /** One in-flight ownership handshake per conversation/request id. */
  const requestOwnersPending = new Set();
  /** Failed handshakes back off briefly instead of retrying on every Fiber mutation. */
  const requestOwnerRetryAt = new Map();
  /** Failed handshake attempts per owner/request pair, so a permanently unplaceable id
   *  cannot turn refreshFiber() into a 2-second retry pump for the life of the tab. */
  const requestOwnerAttempts = new Map();
  /** Last canonical snapshot and strongest non-conflicting local owner per assistant message. */
  const messagesReported = new Map();
  /** ChatGPT-authored create_time already emitted for each stable user-message occurrence. */
  const userAuthoredTimesReported = new Map();

  const cap = (value, max) => (typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null);

  function fiberBusyCaption(label) {
    const plain = String(label || '').toLowerCase().replace(/[.…\s]+$/, '').trim();
    return FIBER_BUSY_CAPTIONS.has(plain) || FIBER_TIMER_CAPTION.test(plain);
  }

  /** One descriptor, rebuilt field by field. Anything unexpected makes the row null. */
  function readDescriptor(raw) {
    if (!raw || typeof raw !== 'object' || raw.v !== FIBER_VERSION) return null;
    const index = raw.index;
    if (!Number.isInteger(index) || index < 0 || index >= FIBER_MAX_ROWS) return null;
    // Checked, never capped. Everything else here is display text where a truncation is
    // harmless, but the tool name is an identity: shortening an over-long one until it
    // fits would turn a value that failed validation into one that passes it.
    const tool = typeof raw.tool === 'string' && raw.tool.length > 0 ? raw.tool : null;
    if (tool !== null && !TOOL_NAME.test(tool)) return null;
    const hidden = Number.isInteger(raw.hidden) ? Math.max(0, Math.min(999, raw.hidden)) : 0;
    const localCount = Number.isInteger(raw.localCount) ? Math.max(0, Math.min(999, raw.localCount)) : null;
    return {
      index,
      tool,
      path: cap(raw.path, 200),
      app: cap(raw.app, 200),
      resource: cap(raw.resource, 200),
      messageId: cap(raw.messageId, 200),
      turnId: cap(raw.turnId, 200),
      conversationId: cap(raw.conversationId, 200),
      createTime: typeof raw.createTime === 'number' && Number.isFinite(raw.createTime) ? raw.createTime : null,
      hidden,
      localCount,
      answered: raw.answered === true
    };
  }

  /**
   * One turn's per-call evidence, rebuilt field by field.
   *
   * Same trust posture as readDescriptor, and it matters more here: this evidence decides
   * which *session* a recorded call is written into, so a page that could forge it could
   * pull another chat's work into this one. Nothing is copied through — the tool name is
   * checked against its pattern and never trimmed to fit, every other field is rebuilt with
   * its own bound, and a message id reported twice is dropped rather than resolved, because
   * two calls sharing one identity is a contradiction and picking one would spend the same
   * evidence twice.
   *
   * What this may do is still bounded on the far side: it can say which conversation a call
   * this app already ran belongs to. It never writes an event, never names an agent, and
   * carries no argument value.
   */
  function readTurnCalls(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const index = Number.isInteger(raw.index) && raw.index >= 0 && raw.index < FIBER_MAX_TURNS ? raw.index : null;
    if (index === null) return null;
    const turnId = cap(raw.turnId, 200) || null;
    const calls = [];
    const seen = new Set();
    const duplicated = new Set();
    for (const entry of (Array.isArray(raw.calls) ? raw.calls : []).slice(0, FIBER_MAX_CALLS)) {
      if (!entry || typeof entry !== 'object') continue;
      const tool = typeof entry.tool === 'string' && entry.tool.length > 0 ? entry.tool : null;
      if (!tool || !TOOL_NAME.test(tool)) continue;
      const messageId = cap(entry.messageId, 200);
      if (!messageId) continue;
      if (seen.has(messageId)) {
        duplicated.add(messageId);
        continue;
      }
      seen.add(messageId);
      calls.push({
        messageId,
        tool,
        order: Number.isInteger(entry.order) ? Math.max(0, Math.min(FIBER_MAX_CALLS, entry.order)) : calls.length,
        answered: entry.answered === true,
        // ChatGPT's own id for the request, and its own creation time. The id is what lets
        // the app place the call in the chat that issued it; this script's own stamp is a
        // poll tick and cannot.
        requestId: cap(entry.requestId, 100) || null,
        createTime: typeof entry.createTime === 'number' && isFinite(entry.createTime) ? entry.createTime : null
      });
    }
    const kept = calls.filter((call) => !duplicated.has(call.messageId));

    // Bare request ids: every `metadata.request_id` in the turn, with no tool name attached.
    //
    // `calls` above is the *renderable* view and needs a tool name to be one; this is the
    // attribution view and needs nothing but the id. ChatGPT stamps the id on the plain
    // assistant message as soon as a connector request is issued and only materializes the
    // `api_tool` row once its safety check clears — up to a minute later, long past the app's
    // fifteen second evidence window. Those ids are readable the entire time, and every one of
    // them belongs to whatever conversation this document is pinned to.
    const requests = [];
    const requestSeen = new Set();
    for (const entry of (Array.isArray(raw.requests) ? raw.requests : []).slice(0, FIBER_MAX_CALLS)) {
      if (!entry || typeof entry !== 'object') continue;
      const requestId = cap(entry.requestId, 100);
      if (!requestId || requestSeen.has(requestId)) continue;
      requestSeen.add(requestId);
      requests.push({
        requestId,
        messageId: cap(entry.messageId, 200) || null,
        createTime: typeof entry.createTime === 'number' && isFinite(entry.createTime) ? entry.createTime : null
      });
    }

    const messages = [];
    const messageIndex = new Map();
    const conflictingMessages = new Set();
    for (const entry of (Array.isArray(raw.messages) ? raw.messages : []).slice(0, FIBER_MAX_MESSAGES)) {
      if (!entry || typeof entry !== 'object') continue;
      const messageId = cap(entry.messageId, 200);
      if (!messageId) continue;
      const rawText = typeof entry.rawText === 'string' ? entry.rawText.slice(0, 256_000) : '';
      // Whole markup or none, for the same reason the wire bound above drops it.
      const renderedHtml =
        typeof entry.renderedHtml === 'string' && entry.renderedHtml.length <= 120_000 ? entry.renderedHtml : '';
      if (!rawText && !renderedHtml) continue;
      const message = {
        messageId,
        rawMessageId: cap(entry.rawMessageId, 200),
        role: entry.role === 'user' ? 'user' : 'assistant',
        stable: entry.stable === true,
        order:
          Number.isInteger(entry.order) && entry.order >= 0 && entry.order < FIBER_MAX_MESSAGES * 4
            ? entry.order
            : null,
        createTime:
          typeof entry.createTime === 'number' && Number.isFinite(entry.createTime) && entry.createTime > 0
            ? entry.createTime
            : null,
        rawText,
        renderedHtml,
        sectionIndex:
          Number.isInteger(entry.sectionIndex) && entry.sectionIndex >= 0 && entry.sectionIndex < 64
            ? entry.sectionIndex
            : null
      };
      const priorAt = messageIndex.get(messageId);
      if (priorAt === undefined) {
        messageIndex.set(messageId, messages.length);
        messages.push(message);
        continue;
      }
      const prior = messages[priorAt];
      if (prior.rawText === rawText && prior.renderedHtml === renderedHtml) {
        if (message.stable) prior.stable = true;
        continue;
      }
      // A React replacement can expose the outgoing and incoming raw text messages in the
      // same model snapshot. They share the stable thought id but disagree on content, so
      // this scan is transitional. Drop that logical item and let the next scan reconcile it
      // rather than guessing which sibling is newer by order or text length.
      conflictingMessages.add(messageId);
    }
    const keptMessages = messages.filter((message) => !conflictingMessages.has(message.messageId));

    const activities = [];
    const activityIndex = new Map();
    const conflictingActivities = new Set();
    for (const entry of (Array.isArray(raw.activities) ? raw.activities : []).slice(0, FIBER_MAX_ACTIVITIES)) {
      if (!entry || typeof entry !== 'object') continue;
      const messageId = cap(entry.messageId, 200);
      const label = cap(entry.label, 300);
      if (!messageId || !label || fiberBusyCaption(label)) continue;
      const priorAt = activityIndex.get(messageId);
      if (priorAt === undefined) {
        activityIndex.set(messageId, activities.length);
        activities.push({
          messageId,
          label,
          order:
            Number.isInteger(entry.order) && entry.order >= 0 && entry.order < FIBER_MAX_MESSAGES * 4
              ? entry.order
              : null
        });
        continue;
      }
      if (activities[priorAt].label !== label) conflictingActivities.add(messageId);
    }
    const keptActivities = activities.filter((activity) => !conflictingActivities.has(activity.messageId));
    if (kept.length === 0 && requests.length === 0 && keptMessages.length === 0 && keptActivities.length === 0) {
      return null;
    }
    return {
      index,
      turnId,
      conversationId: cap(raw.conversationId, 200),
      conversationConflict: raw.conversationConflict === true,
      endMessageId: cap(raw.endMessageId, 200),
      calls: kept,
      requests,
      messages: keptMessages,
      activities: keptActivities
    };
  }

  /**
   * Asks the page-context helper what it can see, and waits a moment for an answer.
   *
   * One request in flight at a time, and a timeout that resolves rather than rejects: a
   * browser where the MAIN-world script never ran must degrade to the old behaviour, not
   * stall the paint loop.
   */
  function askFiber() {
    if (fiberAsking) return fiberAsking;
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    fiberAsking = new Promise((resolve) => {
      let done = false;
      const finish = (rows) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMessage);
        fiberAsking = null;
        resolve(rows);
      };
      const onMessage = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.source !== FIBER_REPLY || data.nonce !== nonce || data.v !== FIBER_VERSION) return;
        // A descriptor frame and its DOM stamps are one transaction. Refuse a reply that
        // cannot name that frame; legacy numeric-only helpers then time out/repair instead of
        // being accidentally interpreted against the current descriptor indexes.
        if (data.scanToken !== nonce) return;
        if (data.scanOk !== true) return finish(null);
        const turns = [];
        if (Array.isArray(data.turns)) {
          for (const raw of data.turns.slice(0, FIBER_MAX_TURNS)) {
            const turn = readTurnCalls(raw);
            if (turn) turns.push(turn);
          }
        }
        if (!Array.isArray(data.rows)) return finish({ rows: new Map(), turns, scanToken: data.scanToken });
        const rows = new Map();
        for (const raw of data.rows.slice(0, FIBER_MAX_ROWS)) {
          const row = readDescriptor(raw);
          // A duplicated index is a contradiction; keep neither rather than pick one.
          if (!row) continue;
          if (rows.has(row.index)) rows.set(row.index, null);
          else rows.set(row.index, row);
        }
        for (const [index, row] of rows) if (row === null) rows.delete(index);
        finish({ rows, turns, scanToken: data.scanToken });
      };
      window.addEventListener('message', onMessage);
      setTimeout(() => finish(null), FIBER_TIMEOUT_MS);
      try {
        window.postMessage({ source: FIBER_ASK, nonce }, location.origin);
      } catch {
        finish(null);
      }
    });
    return fiberAsking;
  }

  /**
   * Refreshes the cache. `null` means no answer — keep whatever was last known.
   *
   * The per-call evidence is reported onwards from here rather than being kept for the
   * renderer's own use. It is the only thing that can tell the app a call it just ran
   * belongs to this chat when ChatGPT drew no row for it, and reporting is cumulative and
   * idempotent by message id, so repeating a turn's evidence on every scan costs nothing.
   */
  /**
   * Which local generation a *settled* website turn belongs to, proved by its request id.
   *
   * Only the turn this document is currently generating gets its local id from the live
   * lifecycle. Everything else used to be recorded with no turn at all, and that is a real
   * gap rather than a tidy conservatism: ChatGPT does not always expose a turn's thinking
   * headline in its message model while the turn is running, so the headline is first seen
   * long afterwards — in session `2026-08-21-ce135bff`, three and a half minutes and one page
   * load after the turn it describes. A row with no turn belongs to no group, and a group
   * missing a row ChatGPT is visibly showing cannot be proven complete, so one late headline
   * dropped that entire response back to ChatGPT's native rendering.
   *
   * The join is ChatGPT's own `metadata.request_id` on the turn's connector calls, matched
   * against the calls the app has already recorded under a durable local turn. No time, DOM
   * position or "nearest turn" guess takes part: the answer is a single turn id or nothing.
   */
  function settledTurnOwner(turn) {
    const requests = new Set();
    for (const call of (turn && turn.calls) || []) if (call && call.requestId) requests.add(call.requestId);
    if (requests.size !== 1) return null;
    const requestId = requests.values().next().value;
    return streamRequestTurnOwners.get(requestId) || null;
  }

  /**
   * Makes request ownership an explicit acknowledged operation for the current live turn.
   *
   * Fresh-chat ordering is the reason this exists. Live 2026-08-21, the real chat session
   * `2026-08-21-e24b18f3` existed before the first call, while normalized request
   * `77186fb4-bdda-4849-8cd7-879bb08a1617` still never reached the correlation registry and
   * every call fell into `2026-08-21-9d5892a4` (Unattributed activity). ChatGPT can expose a
   * connector request and its metadata.request_id while its internal clientThreadId still names the provisional
   * thread, then assign the real /c/<conversation-id> a moment later. Transcript delivery can
   * safely wait for that convergence; MCP attribution cannot, because the recorder has a finite
   * evidence window. Once both facts are simultaneously true in this document — a concrete
   * current route and the request id inside the assistant section this local generation owns —
   * send the exact pair to the app and require a read-back ACK before considering it placed.
   *
   * This is intentionally live-turn-only. Historical/reloaded turns keep the stricter Fiber
   * conversation cross-check, so a stale mounted object from chat A can never be promoted into
   * chat B merely because B is the route currently open.
   */
  function backOffRequestOwner(key) {
    const attempts = (requestOwnerAttempts.get(key) || 0) + 1;
    requestOwnerAttempts.set(key, attempts);
    requestOwnerRetryAt.set(key, Date.now() + Math.min(2000 * attempts, 60000));
  }

  /**
   * The Fiber turn descriptor for a rendered page turn, resolved through fiber.js's own
   * scan stamp rather than through ChatGPT's `data-turn-id`.
   *
   * `data-turn-id` is presentation metadata and the current virtualized renderer omits it
   * from perfectly readable assistant sections (see the note in fiber.js turnsOf). Every
   * ownership decision keyed on it therefore evaluates, silently, to `no owned turn` —
   * which is exactly how a whole chat's exact request ids landed in `Unattributed
   * activity` while the popup showed them as read: with no owned turn there is no
   * request-id -> conversation handshake, and the Fiber-conversation fallback is then
   * stamped onto every call and rejected by the recorder as a disagreement.
   *
   * fiber.js marks each section it scanned with `data-clf-fiber-turn` = `scanToken:index`,
   * so the stamp is an exact, non-positional DOM<->Fiber anchor tied to one descriptor frame
   * whether or not the page id is present. Ambiguity (two nodes of one page turn pointing at
   * different descriptors, or an index shared by two descriptors) still answers null; no
   * positional or clock guess is involved. Ephemeral join only — the scan-qualified stamp is
   * never written into recorder evidence.
   */
  function stampedFiberTurn(pageTurn, turns, scanToken) {
    if (!pageTurn || !Array.isArray(turns) || turns.length === 0 || !scanToken) return null;
    const nodes = pageTurn.nodes || (pageTurn.node ? [pageTurn.node] : []);
    if (nodes.length === 0) return null;
    const byIndex = new Map();
    for (const turn of turns) {
      if (!turn || !Number.isInteger(turn.index)) continue;
      if (byIndex.has(turn.index)) byIndex.set(turn.index, null);
      else byIndex.set(turn.index, turn);
    }
    let found = null;
    for (const node of nodes) {
      if (!node || !node.getAttribute) continue;
      const stamp = node.getAttribute('data-clf-fiber-turn');
      if (stamp === null || stamp === '') continue;
      const split = stamp.lastIndexOf(':');
      if (split <= 0 || stamp.slice(0, split) !== scanToken) continue;
      const rawIndex = stamp.slice(split + 1);
      if (!/^\d+$/.test(rawIndex)) continue;
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 0) continue;
      const descriptor = byIndex.get(index) || null;
      if (!descriptor) continue;
      if (found && found !== descriptor) return null;
      found = descriptor;
    }
    return found;
  }

  async function confirmLiveRequestOwners(calls, ownerConversation) {
    if (!Array.isArray(calls) || calls.length === 0 || !ownerConversation) return;
    const byRequest = new Map();
    for (const call of calls) {
      if (!call || !call.requestId || byRequest.has(call.requestId)) continue;
      if (requestOwnersConfirmed.get(call.requestId) === ownerConversation) continue;
      const key = `${ownerConversation}\u0000${call.requestId}`;
      if (requestOwnersPending.has(key) || (requestOwnerRetryAt.get(key) || 0) > Date.now()) continue;
      byRequest.set(call.requestId, call);
      requestOwnersPending.add(key);
    }
    const batch = [...byRequest.values()];
    if (batch.length === 0) return;
    try {
      const reply = await ask({
        type: 'correlate',
        conversationId: ownerConversation,
        calls: batch
      });
      const data = reply && reply.ok === true && reply.data && typeof reply.data === 'object' ? reply.data : null;
      const confirmed = new Set(data && Array.isArray(data.confirmed) ? data.confirmed : []);
      for (const call of batch) {
        const key = `${ownerConversation}\u0000${call.requestId}`;
        // Judge each request id on its own read-back. This additionally required
        // `data.complete === true`, which is a *batch* verdict: a single id the app could
        // not place (a sticky conflict, or a call it has not ingested yet) threw away the
        // confirmation of every other id in the same message and re-queued them all.
        if (!data || data.conversationId !== ownerConversation || !confirmed.has(call.requestId)) {
          backOffRequestOwner(key);
          continue;
        }
        requestOwnerRetryAt.delete(key);
        requestOwnerAttempts.delete(key);
        requestOwnersConfirmed.set(call.requestId, ownerConversation);
        // `app` becomes green only after the app has read the exact mapping back. This is a
        // stronger diagnostic than the old "Fiber parser saw an id" indicator.
        traceStage(call.requestId, 'sent');
        traceStage(call.requestId, 'app', 'request_id');
      }
    } catch {
      for (const call of batch) backOffRequestOwner(`${ownerConversation}\u0000${call.requestId}`);
    } finally {
      for (const call of batch) requestOwnersPending.delete(`${ownerConversation}\u0000${call.requestId}`);
    }
  }
  async function refreshFiber(settled = null) {
    // A bound chat can briefly lose its /c/<id> route during React/router churn, and a real
    // navigation to a fresh composer has the exact same pathname until ChatGPT assigns the
    // new conversation id. While that identity is unresolved, fail closed: emitting Fiber
    // evidence under the old id is how the first turn of chat B was durably filed into chat
    // A. A fresh, never-bound composer still scans normally because `conversationId` is null.
    const routeConversation = CLF_DOM.conversationId();
    if (conversationId && routeConversation !== conversationId) return false;
    // The page-context round-trip can settle after ChatGPT navigates this tab. Capture the
    // logical chat before crossing that async boundary so an answer read from chat A can
    // never be emitted under chat B's conversation id.
    const askedEpoch = epoch;
    const askedConversation = conversationId;
    // A page-model scan belongs to the generation that requested it, not to whichever one is
    // current when its asynchronous reply returns. Live 2026-08-31: an old final answered after
    // a follow-up had opened the next generation; reading mutable `generating`/`turnId` below
    // emitted that exact final with no owner. Capture the node + durable id before the await.
    // If the lifecycle moves meanwhile, localGenerationOf() below accepts the claim only while
    // finishGeneration's exact node/signature tombstone still proves the old ownership.
    const requestedLiveOwner = !settled ? currentGenerationOwner() : null;
    const requestedOwner = settled || requestedLiveOwner;
    let answer = await askFiber();
    if (answer === null) {
      // One missed reply is not proof the helper is gone: a busy main thread can outlive this
      // bounded poll. Keep the last proven state while the worker attempts a repair. Only a
      // completed repair attempt that still cannot round-trip (or an explicit repair failure)
      // downgrades health; otherwise a transient timeout would flicker Overwrite and could
      // falsely complete interim prose through the degraded DOM fallback.
      const now = Date.now();
      if (!fiberRepairing && now - fiberRepairAt >= 5000) {
        fiberRepairAt = now;
        fiberRepairing = ask({ type: 'repair_fiber' }).finally(() => {
          fiberRepairing = null;
        });
      }
      const repair = fiberRepairing ? await fiberRepairing : null;
      if (repair && repair.ok === true) answer = await askFiber();
      if (answer === null) {
        // `unknown_message` is compatibility with an older service worker during extension
        // update. It has not actually tested the helper, so preserve the last proof until the
        // update recovery path installs the matching worker. Every current worker returns a
        // definitive success/failure for repair_fiber.
        if (repair && (repair.ok === true || repair.error !== 'unknown_message')) {
          fiberPresent = false;
          fiberRows = new Map();
          fiberTurns = new Map();
          fiberScanToken = null;
        }
        return false;
      }
    }
    if (epoch !== askedEpoch || conversationId !== askedConversation) return false;
    // The route can move before observe() has had a chance to update our local conversation
    // state. Epoch/conversation checks alone therefore are not enough: in that window they
    // still both say A while the Fiber tree already belongs to B.
    if (askedConversation && CLF_DOM.conversationId() !== askedConversation) return false;
    const concreteConversation = (value) =>
      typeof value === 'string' && /^[0-9a-f-]{8,64}$/i.test(value) ? value : null;
    // Capture the one page turn this document owns before filtering by Fiber's own conversation
    // field. Ownership can be live *or just settled*: a fresh chat may publish the request id,
    // finish, and only then receive its real /c/<id>. The local generation/settled tombstone is
    // exact document evidence, so this one turn may survive that temporary provisional mismatch.
    // Historical turns still get no exception.
    // Resolve it from the DOM node, not from `data-turn-id`: the node is what this document
    // actually owns, and its `data-clf-fiber-turn` stamp names the descriptor exactly even
    // when the virtualized renderer published no page turn id at all. The page-id match
    // stays as the fallback for a scan whose stamps have not been applied yet.
    const exactOwner = requestedLiveOwner && localGenerationOf(requestedLiveOwner.pageTurn) !== requestedLiveOwner.localTurnId
      ? null
      : requestedOwner;
    const ownedPageNode = exactOwner?.pageTurn || null;
    const ownedPageTurnId = exactOwner?.pageTurnId || null;
    let ownedPageTurn = stampedFiberTurn(ownedPageNode, answer.turns, answer.scanToken);
    if (!ownedPageTurn && ownedPageTurnId) {
      for (let index = answer.turns.length - 1; index >= 0; index--) {
        if (answer.turns[index].turnId === ownedPageTurnId) {
          ownedPageTurn = answer.turns[index];
          break;
        }
      }
    }
    if (askedConversation) {
      // Validate ownership per Fiber object, not per scan.
      //
      // Live failure, 2026-08-21: the popup showed the exact request id for every call in this
      // chat, yet all of those calls landed in `Unattributed activity`. readTurnCalls() had in
      // fact read the ids correctly. The loss happened here: one stale React object left mounted
      // from another conversation made this function reject the *entire* Fiber answer, including
      // the current conversation's exact request messages. The recorder then waited its bounded
      // request-id grace period for evidence we had deliberately thrown away and filed the call
      // as unattributed. A reload/navigation artifact was therefore stronger than exact identity.
      //
      // The URL is already pinned across the async round-trip above. A descriptor carrying a
      // different concrete conversation id is individually stale and is discarded, with one
      // narrow exception: the newest turn already bound to this document's live generation may
      // still carry the fresh chat's provisional client thread. That turn is retained only so
      // confirmLiveRequestOwners() can perform the explicit request-id -> real-route handshake;
      // historical mismatches are still discarded. An absent/non-concrete id keeps the old
      // conservative behaviour. No clock, active-tab or tool-name fallback enters the decision.
      answer = {
        scanToken: answer.scanToken,
        turns: answer.turns.filter((turn) => {
          if (turn?.conversationConflict === true && turn !== ownedPageTurn) return false;
          const pageConversation = concreteConversation(turn.conversationId);
          return !pageConversation || pageConversation === askedConversation || turn === ownedPageTurn;
        }),
        rows: new Map(
          [...answer.rows].filter(([, row]) => {
            const pageConversation = concreteConversation(row.conversationId);
            return !pageConversation || pageConversation === askedConversation;
          })
        )
      };
    }
    // Diagnostics begin only after the scan has passed route/epoch validation and stale
    // cross-conversation objects have been removed. readTurnCalls() is a validator, not proof
    // that an object belongs to this tab: marking `read` while parsing was the reason the popup
    // could show a request id as picked up even though refreshFiber() then discarded it before
    // the app ever saw it.
    const acceptedCalls = answer.turns.flatMap((turn) => turn.calls || []);
    observed.calls = acceptedCalls.length;
    for (const call of acceptedCalls) {
      if (!call.requestId) continue;
      observed.requestId = call.requestId;
      traceStage(call.requestId, 'read');
      traceStage(call.requestId, 'tool', call.tool);
    }
    fiberPresent = true;
    fiberRows = answer.rows;
    fiberScanToken = answer.scanToken;
    fiberTurns = new Map();
    // User messages have one normal owner: the DOM recorder above. Its stable
    // data-message-id is also the send receipt that opens the local turn. Publishing the
    // same visible row first from Fiber marked it seen while an SPA identity pull was still
    // gated; the later DOM pass then quite correctly treated it as already recorded and
    // never emitted turn_start. Keep Fiber only for the narrow thing it adds: page-model
    // messages whose stable id is not rendered in the DOM yet.
    const renderedUserMessageIds = new Set(
      CLF_DOM.messages()
        .filter((message) => message.role === 'user' && message.id)
        .map((message) => message.id)
    );
    for (const turn of answer.turns) {
      if (fiberTurns.has(turn.index)) fiberTurns.set(turn.index, null);
      else fiberTurns.set(turn.index, turn);
    }
    for (const [index, value] of fiberTurns) if (value === null) fiberTurns.delete(index);
    const markedTurns = markedContinuationTurns();
    const continuationReconciliation = reconcileContinuationMarkers(markedTurns);
    if (continuationReconciliation) await continuationReconciliation;
    if (epoch !== askedEpoch || conversationId !== askedConversation) return false;
    // Fiber names turns with ChatGPT's page `data-turn-id`, which the live page reuses. The
    // recorder, deliberately, names the live generation with our durable local `g-...` id.
    // Never write the recycled page id into recorder evidence as though it were that durable
    // identity. Only the *newest* Fiber turn matching the assistant section this local
    // generation is currently bound to may inherit `turnId`; historical/reused matches still
    // prove the conversation made the call, but carry no durable turn id.
    const activeLocalTurnId = exactOwner?.localTurnId || null;
    // ChatGPT represents a continuation prompt and its reply as adjacent Fiber turns. The
    // durable local generation was opened by that exact newest marked user message, so its
    // assistant/tool owner is `answerTurnFor(...)`, not the otherwise-empty prompt turn. This
    // is the same relation summary capture already trusts; reusing it closes the local turn,
    // stamps its partial/final revisions, and keeps chronology at the insertion point.
    if (activeLocalTurnId && markedTurns.length > 0) {
      const newestUser = [...CLF_DOM.messages()].reverse().find((message) => message.role === 'user');
      const marker = String(newestUser?.text || '').match(CONTINUATION_MARKER);
      const markedOwner = marker
        ? markedTurns.find(([, marked]) => marked.kind === marker[1] && marked.token === marker[2])?.[1]
        : null;
      if (markedOwner?.answer) ownedPageTurn = markedOwner.answer;
    }
    const activeTurnIndex =
      ownedPageTurn && activeLocalTurnId ? answer.turns.indexOf(ownedPageTurn) : -1;
    if (askedConversation) {
      // Ownership evidence is no longer gated on `activeTurnIndex`.
      //
      // Live failure, 2026-08-21: `activeTurnIndex` required a non-null page turn id, so on
      // a virtualized render it stayed -1 for the whole conversation and this handshake —
      // the only path that puts a request id into the app's durable correlation registry —
      // simply never ran. Every call in the chat then fell to `Unattributed activity`.
      //
      // The handshake's own safety does not come from the local turn binding; it comes from
      // `ownerConversation` being this document's pinned concrete route and from the app
      // reading the exact pair back. So confirm every call whose Fiber descriptor names
      // exactly this conversation, plus the one turn this document owns (which may still
      // carry a fresh chat's provisional client thread). A descriptor naming a *different*
      // concrete conversation is still never promoted. One batched message per scan.
      //
      // Both views of the turn feed it: the labelled connector rows, and the bare
      // `metadata.request_id` sightings that have no row yet. The tool name is not part of
      // the join — the app maps request id -> conversation and nothing else — so requiring
      // one only delayed the mapping until ChatGPT's safety check released the `api_tool`
      // message, which is precisely the window the app spends deciding the call is
      // unattributed. Labelled rows go first so the id carries its tool when both exist.
      const ownerCalls = [];
      const ownerSeen = new Set();
      for (const source of ['calls', 'requests']) {
        for (const turn of answer.turns) {
          const pageConversation = concreteConversation(turn.conversationId);
          if (turn !== ownedPageTurn && pageConversation !== askedConversation) continue;
          for (const call of turn[source] || []) {
            if (!call || !call.requestId || ownerSeen.has(call.requestId)) continue;
            ownerSeen.add(call.requestId);
            ownerCalls.push(call);
          }
        }
      }
      const ownerConfirmation = confirmLiveRequestOwners(ownerCalls, askedConversation);
      // `ownedPageTurn` has one deliberately narrow exception to the ordinary conversation
      // filter: on a fresh chat, the real /c/<id> can exist while that live turn's React branch
      // still carries a provisional client thread id. The explicit /correlations handshake is
      // what distinguishes that harmless race from a stale Fiber object belonging to another
      // chat. Do not let the ordinary fire-and-forget tool_evidence path race ahead of that
      // verdict: it would re-assert the URL conversation, bypass a rejected handshake and turn
      // an already-proven request owner into a sticky conflict.
      const ownedPageConversation = ownedPageTurn ? concreteConversation(ownedPageTurn.conversationId) : null;
      if (ownedPageTurn && ownedPageConversation && ownedPageConversation !== askedConversation) {
        await ownerConfirmation;
        // The ownership read-back added a new async boundary to this scan. Re-prove the same
        // document/route before any observation from the pre-await Fiber frame can be emitted.
        if (epoch !== askedEpoch || conversationId !== askedConversation) return;
        if (CLF_DOM.conversationId() !== askedConversation) return;
      }
    }
    // A terminal message can finish the local turn before ChatGPT removes a stale Stop
    // control. While that latch is active, observe() keeps Fiber probing the newest visible
    // page turn. If Retry/Regenerate produces a newer public website message, the descriptor's
    // endMessageId changes (or becomes null) and the old terminal object no longer blocks a
    // genuine new generation. Exact page-model identity only; no timer/DOM-position guess.
    if (!generating && settled?.terminalProbe && ownedPageTurn) {
      if (ownedPageTurn.endMessageId !== settled.terminalProbe) {
        fiberTerminalMessageId = null;
      }
    }
    for (let index = 0; index < answer.turns.length; index++) {
      const turn = answer.turns[index];
      const pageConversation = concreteConversation(turn.conversationId);
      const provisionalOwnedTurn = Boolean(
        turn === ownedPageTurn &&
        askedConversation &&
        pageConversation &&
        pageConversation !== askedConversation
      );
      const fresh = turn.calls.filter((call) => {
        // A mismatched owned turn is admissible only as a provisional-first-turn candidate.
        // Its request id must have survived the app's explicit owner read-back before the
        // transcript channel may repeat that evidence. A rejected/stale id is simply omitted;
        // the already-proven owner remains authoritative and no sticky conflict is manufactured.
        if (
          provisionalOwnedTurn &&
          (!call.requestId || requestOwnersConfirmed.get(call.requestId) !== askedConversation)
        ) return false;
        const owner = index === activeTurnIndex ? activeLocalTurnId || '' : '';
        const signature = `${call.tool}\u0000${call.requestId || ''}\u0000${call.answered ? '1' : '0'}\u0000${owner}`;
        if (callsReported.get(call.messageId) === signature) return false;
        callsReported.set(call.messageId, signature);
        return true;
      });
      if (fresh.length > 0) {
        if (generating && index === activeTurnIndex) lastChangeAt = Date.now();
        emit({
          kind: 'tool_evidence',
          ...(index === activeTurnIndex ? { turnId: activeLocalTurnId } : {}),
          ...(turn.conversationId && !(
            turn === ownedPageTurn &&
            askedConversation &&
            concreteConversation(turn.conversationId) &&
            concreteConversation(turn.conversationId) !== askedConversation
          ) ? { fiberConversationId: turn.conversationId } : {}),
          calls: fresh
        });
      }
    }
    // What the settle window is waiting for, decided from the scan itself rather than from a
    // timer: a connector request the page model has not yet stamped with its request id. When
    // every visible call has one there is nothing left to re-read, so the window closes now
    // and an ordinary turn costs no scans at all after it ends.
    if (fiberSettleUntil > Date.now()) {
      const awaitingRequestId = answer.turns.some((turn) =>
        (turn.calls || []).some((call) => !call.requestId)
      );
      const awaitingOwner = answer.turns.some((turn) =>
        (turn.calls || []).some((call) =>
          call && call.requestId && (!askedConversation || requestOwnersConfirmed.get(call.requestId) !== askedConversation)
        )
      );
      if (!awaitingRequestId && !awaitingOwner) fiberSettleUntil = 0;
    }
    // Assistant prose and ChatGPT-native thinking/activity are one interleaved page-model
    // stream. Fiber validates them separately, but each item carries its original model
    // ordinal so we can restore the exact order before recording. Keeping two independent
    // loops here was the first-interim corruption: a scan that discovered a thinking headline
    // and the paragraph after it always journalled the paragraph first.
    // Resolve settled-turn ownership across the whole scan before using any of it.
    //
    // `settledTurnOwner` claims a page turn for the local turn that recorded its request
    // id, which is exact only while an id names one request. ChatGPT reuses a single
    // `request_id` across the retries within a turn — live 2026-08-21, session
    // `2026-08-21-204027d1` had one id on three calls and a second on two — so after a
    // Retry several distinct page turns resolve to the same local turn, every one of them
    // emits its prose under that id, and the app paints one answer twice.
    //
    // A local turn can own exactly one page turn. When more than one claims it, none of
    // them is proven, so all of them drop to unowned — the same fail-closed answer
    // `settledTurnOwner` already gives for an ambiguous id. The live generation's own
    // binding is authoritative and is seeded first, so a settled turn can never take a
    // turn id out from under the turn currently being written.
    //
    // The seed is not conditional on that binding being *resolvable*. Live 2026-08-31,
    // session `2026-08-31-7c0253f2`: ChatGPT held a tool-heavy turn's whole output back and
    // released it in one burst at 12:00:41, while generation `…-0-3` was live and
    // `ownedPageTurn` unresolved. `activeTurnIndex` was therefore -1, the seed was skipped,
    // and a historical section — carrying prose authored at 11:28:07, two minutes before
    // `…-0-3` even started — claimed `…-0-3` unopposed through a reused request id. Its two
    // messages were journalled under a turn that had not begun when they were written, which
    // merges two responses into one group and paints both of them into the first section.
    // An unresolved live binding is not evidence that the live turn owns nothing; it is
    // exactly the case where a settled claim on that id cannot be proven.
    const settledOwners = new Map();
    const ownerClaims = new Map();
    if (activeLocalTurnId) ownerClaims.set(activeLocalTurnId, 1);
    for (let index = 0; index < answer.turns.length; index++) {
      if (index === activeTurnIndex) continue;
      const owner = settledTurnOwner(answer.turns[index]);
      if (!owner) continue;
      settledOwners.set(answer.turns[index], owner);
      ownerClaims.set(owner, (ownerClaims.get(owner) || 0) + 1);
    }
    for (const [turn, owner] of settledOwners) {
      if ((ownerClaims.get(owner) || 0) > 1) settledOwners.delete(turn);
    }
    for (let index = 0; index < answer.turns.length; index++) {
      const turn = answer.turns[index];
      // The live generation owns the turn it is writing; a settled one is claimed only by
      // ChatGPT's own request id. See settledTurnOwner().
      const localOwner = index === activeTurnIndex ? activeLocalTurnId : settledOwners.get(turn) || null;
      const items = [];
      let serial = 0;
      for (const message of turn.messages || []) {
        items.push({
          type: 'message',
          value: message,
          order: Number.isInteger(message.order) ? message.order : FIBER_MAX_MESSAGES + serial,
          serial: serial++
        });
      }
      for (const activity of turn.activities || []) {
        items.push({
          type: 'activity',
          value: activity,
          order: Number.isInteger(activity.order) ? activity.order : FIBER_MAX_MESSAGES * 2 + serial,
          serial: serial++
        });
      }
      items.sort((left, right) => left.order - right.order || left.serial - right.serial);

      for (const item of items) {
        if (item.type === 'activity') {
          const activity = item.value;
          const owner = localOwner || '';
          const signature = `${activity.label}\u0000${owner}`;
          if (pageToolsReported.get(activity.messageId) === signature) continue;
          pageToolsReported.set(activity.messageId, signature);
          if (generating && index === activeTurnIndex) lastChangeAt = Date.now();
          emit({
            kind: 'page_tool',
            text: activity.label,
            messageId: activity.messageId,
            turnId: localOwner || undefined
          });
          continue;
        }

        const message = item.value;
        if (message.role === 'user') {
          if (renderedUserMessageIds.has(message.messageId)) continue;
          const key = occurrenceKey(message.messageId, message.rawText);
          if (message.createTime) {
            if (userAuthoredTimesReported.get(key) === message.createTime) continue;
            userAuthoredTimesReported.set(key, message.createTime);
            markSeen(key);
          } else {
            if (seenMessages.has(key)) continue;
            markSeen(key);
          }
          emit({
            kind: 'user_message',
            messageId: message.messageId,
            text: message.rawText,
            ...(message.createTime ? { time: message.createTime, authoredTime: true } : {})
          });
          continue;
        }
        // `endMessageId` identifies the one public assistant message that actually ended the
        // turn. Earlier public updates remain partial even after the turn later completes;
        // upgrading every message in a completed turn to `final:true` made interim prose look
        // like a sequence of finished answers and could let recovery treat the wrong one as
        // completion evidence.
        const terminalMessageId = turn.endMessageId;
        const exactTerminal = Boolean(
          terminalMessageId &&
            (message.rawMessageId === terminalMessageId || message.messageId === terminalMessageId)
        );
        const state = terminalMessageId
          ? exactTerminal
            ? 'final'
            : 'streaming'
          : 'streaming';
        // The transcript is independent of MCP correlation and must be durable as soon as
        // ChatGPT exposes a public message id. A thought parent is a stronger logical anchor
        // when available, but it is not permission to record: waiting for it dropped the
        // first visible interim whenever ChatGPT replaced that native row with a tool block
        // before the parent became observable. Raw website ids therefore remain valid
        // canonical ids until/if Fiber can provide the stronger parent identity.
        // Ownership is part of the observation. A Fiber message can become visible a scan
        // before generationTurn() can bind the React section; if byte-identical content alone
        // were the dedupe key, that first unowned snapshot permanently prevented the later
        // exact local turn id from reaching the recorder. The recorder upsert is expressly
        // able to promote the same canonical message when stronger ownership arrives.
        const priorMessage = messagesReported.get(message.messageId);
        const ownerConflict = Boolean(
          priorMessage?.conflicted || (localOwner && priorMessage?.owner && priorMessage.owner !== localOwner)
        );
        let owner = ownerConflict ? '' : localOwner || (priorMessage && priorMessage.owner) || '';
        // Ownership may strengthen after an earlier scan saw the message before its DOM turn
        // was bound. It may never weaken merely because a concurrent later scan has no local
        // claim: that was the 2026-08-31 final-without-turnId race. A contradictory positive
        // claim is different and fails closed instead of choosing either generation.
        const signature =
          `${state}\u0000${message.rawText}\u0000${message.renderedHtml}\u0000${owner}` +
          `\u0000${message.createTime || ''}`;
        if (priorMessage?.signature === signature) continue;
        messagesReported.set(message.messageId, { signature, owner, conflicted: ownerConflict });
        if (state === 'streaming') lastChangeAt = Date.now();
        const liveAssistant =
          Boolean(localOwner) ||
          (generating && (index === activeTurnIndex || (activeTurnIndex < 0 && index === answer.turns.length - 1)));
        emit({
          kind: 'assistant_message',
          messageId: message.messageId,
          turnId: localOwner || undefined,
          text: message.rawText,
          renderedHtml: message.renderedHtml,
          // create_time is stamped by ChatGPT's server clock while turn/tool events use the
          // machine clock. They are not guaranteed to agree: the live 2026-08-25 turn recorded
          // this response 14 seconds before the user message that caused it. For a current or
          // locally-owned turn, first observation is the comparable clock. Historical backfill
          // has no local turn anchor, so it keeps authored create_time instead.
          ...(!liveAssistant && message.createTime ? { time: message.createTime, authoredTime: true } : {}),
          ...(liveAssistant ? { activeNow: true } : {}),
          state,
          final: state === 'final',
          ...(state === 'final' && localOwner && goalTerminalCandidate('completed', localOwner)
            ? { goalEligible: true }
            : {})
        });
        if (state === 'final' && localOwner && notePresentation(message.messageId, message.rawText)) {
          // The page has produced a newer exact revision than the app-owned renderer can
          // possibly hold. Reuse the one activity scheduler and bring its next pass forward;
          // the exact feed acknowledgement below releases this obligation, and its own deadline
          // ends it either way. Re-observing a revision already offered arms nothing.
          expediteActivityPull();
        }
      }
    }
    // ChatGPT's own message model is stronger completion evidence than the renderer's Stop
    // button. If the final assistant message says `end_turn:true`, close the exact local
    // generation even if a stale Stop control remains mounted. Final message/activity
    // revisions above have already been emitted, so do not trigger a second Fiber final pass.
    if (
      generating &&
      activeTurnIndex >= 0 &&
      activeLocalTurnId === turnId &&
      Boolean(answer.turns[activeTurnIndex]?.endMessageId)
    ) {
      fiberTerminalMessageId = answer.turns[activeTurnIndex].endMessageId;
      const ended = generationTurn();
      if (ended) {
        const local = endOutcome(ended);
        finishGeneration(ended, local.outcome === 'unknown' ? { outcome: 'completed' } : local, false);
      }
    }
    if (callsReported.size > 4000) callsReported.clear();
    if (messagesReported.size > 4000) messagesReported.clear();
    if (pageToolsReported.size > 4000) pageToolsReported.clear();
    if (userAuthoredTimesReported.size > 4000) userAuthoredTimesReported.clear();
    return true;
  }

  /** What the page says about this block, or null. */
  function fiberFor(block) {
    if (!fiberPresent) return null;
    const ref = CLF_DOM.fiberRef(block);
    if (!ref || ref.scanToken !== fiberScanToken) return null;
    return fiberRows.get(ref.index) || null;
  }

  /**
   * The Fiber turn descriptor attached to this rendered assistant turn, or null.
   *
   * This is an ephemeral DOM↔scan join only. Durable identity remains the ChatGPT website
   * ids inside `messages`/`activities`; the scan reference is never written to the recorder.
   */
  function fiberTurnFor(turn) {
    if (!fiberPresent || !turn) return null;
    const nodes = turn.nodes || (turn.node ? [turn.node] : []);
    let found = null;
    for (const node of nodes) {
      const descriptor = fiberTurnForNode(node);
      if (!descriptor) continue;
      if (found && found !== descriptor) return null;
      found = descriptor;
    }
    return found;
  }

  /** Fiber turn descriptor stamped onto exactly one rendered assistant section. */
  function fiberTurnForNode(node) {
    if (!fiberPresent || !node || !node.getAttribute) return null;
    const stamp = node.getAttribute('data-clf-fiber-turn');
    if (stamp === null || stamp === '') return null;
    const split = stamp.lastIndexOf(':');
    if (split <= 0 || stamp.slice(0, split) !== fiberScanToken) return null;
    const rawIndex = stamp.slice(split + 1);
    if (!/^\d+$/.test(rawIndex)) return null;
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) return null;
    return fiberTurns.get(index) || null;
  }

  /**
   * Decides which recorded call belongs to which block. Pure, so it can be tested.
   *
   * `blocks` is one `{ callId, original, hidden }` per rendered tool block, in DOM order;
   * `calls` is the app's recorded calls for the same turn, in the order they ran.
   * Returns `[blockIndex, call, hiddenCalls]` triples to apply.
   *
   * **A row is a group, not a call.** ChatGPT folds a run of calls into one row — observed
   * live as `4 earlier tool calls hidden` over a `collapsedSameToolCallCount: 4`, so five
   * calls behind one row. `hidden` is that count, from the page's own client state (see
   * fiberFor). It defaults to 0, which is the ordinary row and the behaviour everything had
   * before. The prop is named for a run of calls to the *same* tool and that name is not
   * reliable: the live page folded a `list_resources` call under an `agents` row. So
   * it is a count of what the row stands for and never evidence of which tools those were.
   *
   * That the row *represents* the last call of its group, not the first, is what the
   * "earlier … hidden" wording means, and it decides which call's label goes on the row.
   *
   * The rules, in the order they are tried:
   *
   *  · A block already bound to a call keeps that call, along with the `hidden` calls
   *    immediately before it — groups are contiguous in run order by construction, since
   *    ChatGPT only folds *consecutive* calls to the same tool. Labels must not move
   *    around between repaints, and a block whose call has scrolled out of the feed keeps
   *    what it has rather than being handed somebody else's.
   *  · If the unbound blocks and the unmatched calls come out even — counting each block
   *    as the `1 + hidden` calls it stands for — they pair up in order. This is the strong
   *    signal and it is what the old code required, except that the old code counted every
   *    block as one call and so fired on mismatched sets whenever anything was collapsed.
   *    That produced confidently wrong labels, which is worse than the wall of "Called
   *    tool" it replaced.
   *  · Otherwise only the blocks ChatGPT renders *identically* are matched, in order,
   *    as far as they go, and the run stops at the first folded row. That is the "wall of
   *    Called tool" case, where the page is saying nothing that could be overwritten, and
   *    where nothing has reconciled — so a fold count cannot be spent as if the calls it
   *    counts were the ones waiting in front of it. Blocks ChatGPT has named itself are
   *    left alone — and, crucially, no longer stop the rest of the turn being matched.
   *    A tie between two equally large groups is genuinely ambiguous, so nothing moves.
   *
   * Over all three, one veto: **a row never takes a call the page says it did not make.**
   * `block.tool` is the tool named by that row's own Fiber descriptor, and it is evidence
   * about that row and no other — it needs no counting, no ordering and no reconciliation
   * to be true. Every rule here is ultimately an argument from position, and position is
   * exactly what goes wrong when the recorder's view of a turn and the page's view of it
   * are not the same set of calls. Observed live on two separate chats: a row whose
   * descriptor said `screenshot` wearing a recorded `list_windows`, and a row whose
   * descriptor said `run_powershell` wearing a recorded `computer`, each one the single
   * bound row on its page and each one arrived at by a rule that "fit". A blank row is a
   * missing label; a wrong row is a lie about what this machine did.
   */
  /**
   * The app's recorded calls for one visible assistant turn.
   *
   * `data-turn-id` belongs to one page load and to nothing beyond it: a turn streams as
   * `g-1s6atlm1inbjf2-0-1` and the very same turn comes back as
   * `request-WEB:<load-uuid>-<n>` once the tab is refreshed. So after a reload the recorded
   * turn ids matched no visible turn, every block fell through to applyPageLabel, and a
   * chat that had been fully relabelled a second earlier came back wearing nothing but
   * ChatGPT's own quiet names. Nothing was switched off; the join had simply expired.
   *
   * ChatGPT's connector request id is the durable half of that join, and both sides already
   * hold it: the app records it from the `x-request-id` on the MCP request, and the page
   * carries the same value on the tool message's own metadata (see readTurnCalls). It is
   * ChatGPT's identifier for the request, not an observation of ours, so it means the same
   * thing before and after a refresh.
   *
   * Two conditions, both the ones anchoredRenderForTurn already relies on. The turn must
   * name exactly one request — several is a turn this cannot order — and the request must
   * not already have been claimed by an earlier turn in this pass, since one response's
   * calls cannot belong to two visible turns. Where either fails the turn keeps ChatGPT's
   * own labels, which is the same outcome it had before this fallback existed.
   */
  function recordedCallsFor(turn, byTurn, byRequest, spent) {
    const own = (turn.id && byTurn.get(turn.id)) || [];
    if (own.length > 0) return own;
    const descriptor = fiberTurnFor(turn);
    if (!descriptor) return [];
    const requestIds = new Set();
    for (const call of descriptor.calls || []) if (call && call.requestId) requestIds.add(call.requestId);
    if (requestIds.size !== 1) return [];
    const requestId = requestIds.values().next().value;
    if (spent.has(requestId)) return [];
    const recorded = byRequest.get(requestId) || [];
    if (recorded.length === 0) return [];
    spent.add(requestId);
    // Run order, which is the order planLabels pairs against. `seq` is the app's own
    // append-only sequence, so it says which call ran first without consulting the page.
    return [...recorded].sort((a, b) => a.seq - b.seq);
  }

  function planLabels(blocks, calls) {
    /** How many calls this row folded away behind the one it shows. */
    const hiddenOf = (block) => {
      const raw = block && block.hidden;
      return Number.isInteger(raw) && raw > 0 ? Math.min(raw, 999) : 0;
    };
    /** `[representative, hidden]` for a run of calls, which the row shows last-first. */
    const group = (run) => [run[run.length - 1], run.slice(0, -1)];
    /**
     * Whether the page's own name for this row rules this call out.
     *
     * Only when both are known and they differ. An absent descriptor — no helper, an
     * unreadable row, a truncated payload with no result yet — says nothing either way,
     * and must leave every rule exactly as it behaved before the helper existed.
     */
    const contradicts = (block, call) =>
      Boolean(block && block.tool && call && call.tool && block.tool !== call.tool);

    const order = new Map();
    calls.forEach((call, at) => order.set(call.callId, at));

    const plan = [];
    const consumed = new Set();
    const free = [];
    blocks.forEach((block, index) => {
      if (!block.callId) {
        free.push(index);
        return;
      }
      const at = order.get(block.callId);
      // Its call has scrolled out of the feed. Leave the block alone and, since the call
      // is not in `calls` either, let the rest of the turn match around it.
      if (at === undefined) return;
      if (contradicts(block, calls[at])) {
        // This row is already wearing a call the page says it did not make — matched in an
        // earlier paint, before the descriptor for it had arrived. "Never move a label"
        // exists so labels do not shuffle between repaints, not so a wrong one can outlive
        // the evidence against it. A null call is the plan's instruction to take it back
        // off; the call itself stays unconsumed, so it is free to land where it belongs.
        plan.push([index, null, []]);
        free.push(index);
        return;
      }
      const from = Math.max(0, at - hiddenOf(block));
      for (let position = from; position <= at; position++) consumed.add(position);
      plan.push([index, calls[at], calls.slice(from, at)]);
    });

    const pending = calls.filter((_call, at) => !consumed.has(at));
    if (pending.length === 0 || free.length === 0) return plan;

    const spans = free.map((index) => 1 + hiddenOf(blocks[index]));
    if (spans.reduce((total, span) => total + span, 0) === pending.length) {
      let at = 0;
      const runs = free.map((_index, which) => {
        const run = pending.slice(at, at + spans[which]);
        at += spans[which];
        return run;
      });
      // The counts coming out even is the strong signal, but it is still only arithmetic,
      // and one row whose descriptor names a different tool than the call this pairing
      // would hand it is proof that the two sequences are not the same sequence. The rest
      // of the pairing rests on the same assumption, so none of it is applied.
      if (!free.some((index, which) => contradicts(blocks[index], group(runs[which])[0]))) {
        free.forEach((index, which) => plan.push([index, ...group(runs[which])]));
        return plan;
      }
    }

    const groups = new Map();
    for (const index of free) {
      const key = blocks[index].original;
      groups.set(key, (groups.get(key) || []).concat(index));
    }
    const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
    const generic = sorted[0];
    if (!generic || (sorted.length > 1 && sorted[1].length === generic.length)) return plan;
    let at = 0;
    for (const index of generic) {
      // Reaching this branch means the two sets did not reconcile, and a folded row is
      // exactly where that stops being survivable: `hidden` says how many calls the page
      // shows this row in place of, and nothing here proves those calls are the entries
      // sitting in front of it in `pending` — the recorder may never have seen them at
      // all. Consuming them on that assumption shifts this row's label and every later
      // one. So stop at the first folded row instead. It does not go generic: it keeps
      // the name the page's own descriptor gave it, which is evidence about that row
      // alone and needs no reconciliation to be true.
      if (hiddenOf(blocks[index]) > 0) break;
      if (at >= pending.length) break;
      // Same reasoning one row at a time: this is the weakest rule in the file, so the
      // page naming a different tool ends the run rather than skipping an entry — every
      // row after this one would be walking at an offset nothing here can measure.
      if (contradicts(blocks[index], pending[at])) break;
      plan.push([index, pending[at], []]);
      at += 1;
    }
    return plan;
  }

  /** What ChatGPT itself called this block, before we touched it. */
  function originalLabel(block) {
    if (block.dataset.clfOriginal) return block.dataset.clfOriginal;
    const label = CLF_DOM.toolLabel(block);
    return label ? (label.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * Turns ChatGPT's generic tool header into the same semantic shape as the app:
   * icon + strong title + secondary input/detail + result metric. The app remains the
   * source of truth for the words; this page code only lays out the summary it receives.
   */
  function applyLabel(block, entry, hidden) {
    const label = CLF_DOM.toolLabel(block);
    if (!label) return;
    const folded = Array.isArray(hidden) ? hidden : [];
    const metric = block.querySelector('.clf-metric');
    const detail = block.querySelector('.clf-tool-detail');
    const icon = block.querySelector('.clf-tool-icon');
    const more = block.querySelector('.clf-folded');
    const when = block.querySelector('.clf-when');
    const who = block.querySelector('.clf-agent');
    const wantedDetail = entry.summary.detail || '';
    const wantedMore = folded.length > 0 ? `+${folded.length}` : '';
    const wantedWhen = SHOW_TIMES ? clockText(entry.time) : '';
    const wantedWho = agentText(entry);
    const wantedMetric = displayMetric(entry.summary);
    const metricOk = Boolean(wantedMetric) === Boolean(metric) && (!wantedMetric || metric.textContent === wantedMetric);
    const detailOk = Boolean(wantedDetail) === Boolean(detail) && (!wantedDetail || detail.textContent === wantedDetail);
    const moreOk = Boolean(wantedMore) === Boolean(more) && (!wantedMore || more.textContent === wantedMore);
    const whenOk = Boolean(wantedWhen) === Boolean(when) && (!wantedWhen || when.textContent === wantedWhen);
    const whoOk = Boolean(wantedWho) === Boolean(who) && (!wantedWho || who.textContent === wantedWho);
    const iconOk = icon && icon.dataset.clfIcon === toolIconKey(entry.summary.kind);
    if (
      block.dataset.clfCall === entry.callId &&
      label.textContent === entry.summary.title &&
      metricOk &&
      detailOk &&
      moreOk &&
      whenOk &&
      whoOk &&
      iconOk
    ) return;

    if (!block.dataset.clfOriginal) block.dataset.clfOriginal = label.textContent || '';
    block.dataset.clfCall = entry.callId;
    block.dataset.clfKind = entry.summary.kind || 'other';
    // The outcome is an attribute as well as a colour, so a failed call can be made to
    // look failed without depending on a tone class that also means other things.
    block.dataset.clfOutcome = entry.outcome || 'ok';
    label.textContent = entry.summary.title;
    label.classList.add('clf-tool-title');
    label.setAttribute(
      'data-clf-tip',
      `${entry.tool} — ${entry.outcome}${entry.durationMs ? ` in ${Math.round(entry.durationMs)} ms` : ''}` +
        `\nOriginally: ${block.dataset.clfOriginal}`
    );
    block.classList.remove('clf-good', 'clf-bad', 'clf-warn', 'clf-neutral');
    block.classList.add('clf-tool', `clf-${entry.summary.tone}`);

    const glyphNode = icon || document.createElement('span');
    glyphNode.className = 'clf-tool-icon';
    glyphNode.setAttribute('aria-hidden', 'true');
    setToolIcon(glyphNode, entry.summary.kind);
    if (!icon && label.parentElement) label.parentElement.insertBefore(glyphNode, label);

    // Which agent ran it. A run with a prime and two workers puts three streams of calls
    // into one chat, and until now the transcript said three tools ran and nothing about
    // who ran them — so a worker's mistake read as the prime's. Absent on an ordinary
    // chat, where there is only one possible answer and a tag saying so is noise.
    let whoNode = who;
    if (wantedWho) {
      whoNode = whoNode || document.createElement('span');
      whoNode.className = 'clf-agent';
      whoNode.textContent = wantedWho;
      whoNode.setAttribute('data-clf-tip', `Run by ${wantedWho}, not by the chat you are reading.`);
      block.dataset.clfAgent = wantedWho;
      if (!who) label.insertAdjacentElement('beforebegin', whoNode);
    } else if (whoNode) {
      whoNode.remove();
      whoNode = null;
      delete block.dataset.clfAgent;
    }

    let detailNode = detail;
    if (wantedDetail) {
      detailNode = detailNode || document.createElement('span');
      detailNode.className = 'clf-tool-detail';
      detailNode.textContent = wantedDetail;
      if (!detail) label.insertAdjacentElement('afterend', detailNode);
    } else if (detailNode) {
      detailNode.remove();
      detailNode = null;
    }

    let metricNode = metric;
    if (wantedMetric) {
      metricNode = metricNode || document.createElement('span');
      metricNode.className = 'clf-metric';
      metricNode.textContent = wantedMetric;
      if (!metric) (detailNode || label).insertAdjacentElement('afterend', metricNode);
    } else if (metricNode) {
      metricNode.remove();
      metricNode = null;
    }

    // The time the app ran the call, on this machine's clock — the one thing the appended
    // "Local timeline" block carried that the rows themselves did not. Now that it is here,
    // the rows are the transcript and the block is not needed (T-16).
    let whenNode = when;
    if (wantedWhen) {
      whenNode = whenNode || document.createElement('span');
      whenNode.className = 'clf-when';
      whenNode.textContent = wantedWhen;
      whenNode.setAttribute('data-clf-tip', new Date(entry.time).toLocaleString());
      if (!when) (metricNode || detailNode || label).insertAdjacentElement('afterend', whenNode);
    } else if (whenNode) {
      whenNode.remove();
      whenNode = null;
    }

    // ChatGPT draws one row for a run of calls to the same tool, so this row is the last
    // of several. The other four are not a footnote about this row, they are calls that
    // happened, so the chip opens them underneath it.
    setFolded(block, whenNode || metricNode || detailNode || label, folded, wantedMore);
  }

  /**
   * The agent to name on a row, or '' when there is only one possible answer.
   *
   * The app attributes this itself, having run the call, so unlike anything from the page
   * it is authoritative. It is still bounded before going on screen: an id long enough to
   * push the tool's own name out of the row would hide the thing the row is for.
   */
  function agentText(entry) {
    const value = typeof entry.agent === 'string' ? entry.agent.trim() : '';
    return value.length > 0 && value.length <= 40 ? value : '';
  }

  /** `HH:MM:SS` for a recorder timestamp, or '' if there isn't a usable one. */
  function clockText(time) {
    if (!Number.isFinite(time) || time <= 0) return '';
    try {
      return new Date(time).toLocaleTimeString();
    } catch {
      return '';
    }
  }

  /**
   * Puts the calls a row folded away underneath that row, opened in place.
   *
   * This is what is left of the appended "Local timeline". That block sat at the bottom of
   * the turn restating rows which were already on the page a few pixels above it, so it was
   * a second and worse transcript rather than more of the first one — and ChatGPT's own
   * progress captions, which made up its other half, are read straight out of the reasoning
   * box the page is already showing. Copying either back onto the page was duplication.
   *
   * The calls that genuinely had nowhere to appear are these ones: the calls ChatGPT
   * collapsed into a neighbour, which exist in the app's record and in no visible row. They
   * belong inside the row that swallowed them, so that is where they go.
   */
  function setFolded(block, anchor, folded, text) {
    const chip = block.querySelector('.clf-folded');
    const list = block.querySelector('.clf-fold-list');
    if (folded.length === 0) {
      if (chip) chip.remove();
      if (list) list.remove();
      return;
    }

    const open = chip ? chip.getAttribute('aria-expanded') === 'true' : false;
    const node = chip || document.createElement('span');
    node.className = 'clf-folded';
    node.textContent = text;
    node.setAttribute(
      'data-clf-tip',
      `${folded.length} earlier call${folded.length === 1 ? '' : 's'} folded into this row by ChatGPT. Show them.`
    );
    if (!chip) {
      // The chip sits inside ChatGPT's own header button, so its click would also open the
      // row's card. Ours is a separate control with a separate meaning, so it takes the
      // event: the alternative is a chip that cannot be clicked without doing something else.
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-expanded', 'false');
      const toggle = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const showing = node.getAttribute('aria-expanded') === 'true';
        node.setAttribute('aria-expanded', showing ? 'false' : 'true');
        const body = block.querySelector('.clf-fold-list');
        if (body) body.hidden = showing;
      };
      node.addEventListener('click', toggle);
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') toggle(event);
      });
      anchor.insertAdjacentElement('afterend', node);
    }

    const body = list || document.createElement('div');
    body.className = 'clf-fold-list';
    body.hidden = !open;
    body.replaceChildren(...folded.map((call) => foldedRow(call)));
    if (!list) {
      // Outside the header button, so the list is not inside a control that toggles the
      // row's own card, and a click on a line of it does nothing at all.
      const header = block.querySelector('button');
      if (header && header.parentElement) header.insertAdjacentElement('afterend', body);
      else block.append(body);
    }
  }

  /** One folded call, in the same shape as the row it is folded into. */
  function foldedRow(call) {
    const line = document.createElement('div');
    line.className = `clf-row clf-${call.summary.tone}`;
    const icon = document.createElement('span');
    icon.className = 'clf-row-icon';
    icon.setAttribute('aria-hidden', 'true');
    setToolIcon(icon, call.summary.kind);
    const label = document.createElement('span');
    label.className = 'clf-label';
    label.textContent = labelText(call);
    if (SHOW_TIMES) {
      const time = document.createElement('span');
      time.className = 'clf-time';
      time.textContent = clockText(call.time);
      line.append(time);
    }
    line.append(icon);
    // A folded run is where agents get mixed up most easily: ChatGPT collapses by tool
    // name, which says nothing about who called it, so one row can hide two agents' work.
    const who = agentText(call);
    if (who) {
      const tag = document.createElement('span');
      tag.className = 'clf-agent';
      tag.textContent = who;
      line.append(tag);
    }
    line.append(label);
    const wantedMetric = displayMetric(call.summary);
    if (wantedMetric) {
      const metric = document.createElement('span');
      metric.className = 'clf-metric';
      metric.textContent = wantedMetric;
      line.append(metric);
    }
    return line;
  }

  /**
   * Names a row from ChatGPT's own record of the chat, when the app has nothing to say.
   *
   * This is the case that made relabelling look broken in every chat but one: the local
   * recorder only ever holds the slice of a conversation it observed live, so a chat that
   * has been going for days shows connector rows for calls that were never recorded here.
   * No matching rule can fix that — there is nothing to match against.
   *
   * What it deliberately does *not* do is dress the result up as the app's own. There is
   * no result, no duration, no outcome and no summary, because the app did not run this
   * call; it gets the tool's name, a quieter treatment than a matched row, and a tooltip
   * that says where the name came from. If a recorded call turns up for this block later,
   * applyLabel replaces all of this — the recorder is authoritative wherever it has an
   * entry, and this block stays unbound precisely so that can happen.
   */
  function applyPageLabel(block, seen) {
    if (!seen || !seen.tool) return;
    const label = CLF_DOM.toolLabel(block);
    if (!label) return;
    if (block.dataset.clfPage === seen.tool) return;
    if (!block.dataset.clfOriginal) block.dataset.clfOriginal = label.textContent || '';
    block.dataset.clfPage = seen.tool;
    label.textContent = seen.tool;
    label.classList.add('clf-tool-title');
    label.title =
      `${seen.path || seen.tool}${seen.app ? ` — ${seen.app}` : ''}\n` +
      'Named from this chat’s own record. This app did not run the call, so it has no ' +
      'result or duration here.\n' +
      `Originally: ${block.dataset.clfOriginal}`;
    block.classList.add('clf-tool', 'clf-page');
  }

  /**
   * Takes a recorded call's label back off a row, leaving what ChatGPT drew.
   *
   * The one caller is a row whose own descriptor names a different tool than the call it
   * is wearing, so the label is known to be wrong rather than merely unproven. Leaving it
   * would be the single outcome worse than "Called tool": another call's name, in this
   * app's own styling, with a duration and an outcome, over work it did not describe.
   *
   * `clfOriginal` is deliberately kept. It is what ChatGPT said before anything here
   * touched the row, applyPageLabel wants it for the tooltip, and re-reading it from a
   * label this code has already overwritten would preserve the wrong name forever.
   */
  function releaseLabel(block) {
    const label = CLF_DOM.toolLabel(block);
    if (label) {
      if (block.dataset.clfOriginal) label.textContent = block.dataset.clfOriginal;
      label.classList.remove('clf-tool-title');
      label.removeAttribute('title');
    }
    for (const selector of [
      '.clf-tool-icon',
      '.clf-agent',
      '.clf-tool-detail',
      '.clf-metric',
      '.clf-when',
      '.clf-folded',
      '.clf-fold-list'
    ]) {
      const node = block.querySelector(selector);
      if (node) node.remove();
    }
    block.classList.remove('clf-tool', 'clf-page', 'clf-good', 'clf-bad', 'clf-warn', 'clf-neutral');
    delete block.dataset.clfCall;
    delete block.dataset.clfKind;
    delete block.dataset.clfOutcome;
    delete block.dataset.clfAgent;
    // Cleared too, so applyPageLabel treats this as a row it has never named and puts the
    // page's own tool name on it in this same pass.
    delete block.dataset.clfPage;
  }

  /**
   * Gives every row this app has named back to ChatGPT.
   *
   * The disabled half of paint(), and it runs the restore rather than merely skipping the
   * loop for the same reason renderStreams() does: a switch flipped off mid-session has to
   * undo what it did, or our labels stay frozen on the page for the life of the tab.
   */
  function unpaint() {
    for (const turn of CLF_DOM.turns()) {
      if (turn.role !== 'assistant') continue;
      for (const block of CLF_DOM.toolBlocks(turn)) {
        if (!block.dataset.clfCall && !block.dataset.clfPage) continue;
        releaseLabel(block);
      }
    }
    painted = false;
  }

  function paint() {
    // Presentation, all of it. applyLabel and applyPageLabel overwrite ChatGPT's own tool
    // name, add this app's classes, title and block styling — so they belong behind the
    // same user-controlled switch as the stream renderer, not merely alongside it. A
    // relabelled row is a visible claim about that record, so Overwrite OFF must release it
    // too. Capture is untouched: the identity stamps reportPageTools writes are
    // invisible and keep flowing with the renderer off.
    if (!(renderStreamAllowed() && status.connected === true && status.paired === true)) {
      if (painted) unpaint();
      return;
    }
    // With no recorded calls and no page evidence there is nothing any of this could say.
    if (entries.length === 0 && !fiberPresent) return;
    const byTurn = new Map();
    const byRequest = new Map();
    for (const entry of entries) {
      // ChatGPT's own request id, which unlike a turn id outlives the page load that saw
      // the call run. Indexed for every entry that has one, including the calls whose
      // local turn id was lost — those are exactly the ones a reload leaves stranded.
      if (entry.requestId) {
        const sharing = byRequest.get(entry.requestId) || [];
        sharing.push(entry);
        byRequest.set(entry.requestId, sharing);
      }
      // A call the app could not tie to a turn it can see. Attribution 'inferred' never
      // carries a turn id, so this one test covers both.
      if (!entry.turnId) continue;
      const list = byTurn.get(entry.turnId) || [];
      list.push(entry);
      byTurn.set(entry.turnId, list);
    }
    /** Requests already handed to a turn in this pass. One request, one turn. */
    const spentRequests = new Set();
    for (const turn of CLF_DOM.turns()) {
      if (turn.role !== 'assistant' || !turn.id) continue;
      const calls = recordedCallsFor(turn, byTurn, byRequest, spentRequests);
      const blocks = CLF_DOM.toolBlocks(turn);
      const named = new Set();
      if (blocks.length > 0 && calls.length > 0) {
        const shapes = blocks.map((block) => {
          const seen = fiberFor(block);
          return {
            callId: block.dataset.clfCall || null,
            original: originalLabel(block),
            // How many calls this row folded away. Only the page's own client state knows,
            // and only when the MAIN-world helper is there; 0 is the honest default and
            // is exactly the behaviour this had before that helper existed.
            hidden: seen ? seen.hidden : 0,
            // The tool this row's own descriptor names, which lets a match be refused on
            // evidence about the row rather than on where it sits. null whenever the page
            // did not say, which is the same as not asking.
            tool: seen ? seen.tool : null
          };
        });
        for (const [index, call, folded] of planLabels(shapes, calls)) {
          if (call === null) {
            releaseLabel(blocks[index]);
            continue;
          }
          applyLabel(blocks[index], call, folded);
          named.add(index);
          painted = true;
        }
      }
      // Rows the app cannot account for. In a chat older than this app's record of it —
      // which is most of a long-running chat — that is nearly all of them.
      blocks.forEach((block, index) => {
        if (named.has(index) || block.dataset.clfCall) return;
        applyPageLabel(block, fiberFor(block));
        if (block.dataset.clfPage) painted = true;
      });
    }
  }

  /** Keeps the newest recorded calls and forgets the rest, feed and index together. */
  function trimEntries() {
    entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    if (entries.length <= 2000) return;
    const drop = entries.splice(0, entries.length - 2000);
    for (const entry of drop) bySeq.delete(entry.seq);
  }

  /**
   * Pulls this chat's recorded activity from the app and paints it onto the page.
   *
   * Everything below the first `await` belongs to the conversation that was current when
   * the request went out, and to nothing else. Without that check a reply requested for
   * chat A could come back after the tab had moved to chat B and repopulate `entries`,
   * `job` and `bootstrap` from A, then fold what it took to be the bootstrap
   * instruction — which in chat B is the user's own first message — and paint A's tool
   * labels onto B's rows. `resetConversation()` cannot prevent this: it clears state, but
   * a request already in flight is not state, and it lands afterwards.
   *
   * Both the id and the epoch are checked. The id alone would pass for A → B → A, which is
   * one back button away and would apply a reply from a genuinely different visit.
   */
  /**
   * Reading order for one window of the app feed. Mirrors `src/shared/chronology.ts`; the
   * two must stay identical, because this stream and the desktop transcript are the same
   * record and may not disagree about its order. See that file for why the reordering is
   * turn-local and why sorting the whole feed by time would corrupt reloaded history.
   */
  function chronological(entries) {
    const position = (entry) => (Number.isFinite(Number(entry && entry.origin)) ? Number(entry.origin) : entry.seq);
    const bySeq = [...entries].sort((a, b) => position(a) - position(b) || a.seq - b.seq);
    const anchors = new Map();
    const ends = new Map();
    for (const entry of bySeq) {
      if (entry.kind === 'turn_start' && entry.turnId && !anchors.has(entry.turnId)) {
        anchors.set(entry.turnId, position(entry));
      }
      if (entry.kind === 'turn_end' && entry.turnId) {
        const anchor = anchors.get(entry.turnId);
        if (anchor !== undefined) ends.set(anchor, Math.max(ends.get(anchor) || 0, entry.time));
      }
    }
    // The message that ended a turn is the last thing in that turn by definition, so it is
    // placed there rather than by the `create_time` ChatGPT stamped when it *opened* the
    // message — which can precede a connector call the same turn still had to make. See the
    // long note on `closing()` in src/shared/chronology.ts; the two must not disagree.
    const rank = (entry, ends) =>
      entry.kind === 'turn_start' ? -1 : entry.kind === 'turn_end' ? 1 : entry === ends ? 0.5 : 0;
    const closing = (group) => {
      let found = null;
      for (const entry of group) {
        if (entry.kind !== 'assistant_message') continue;
        if (entry.final !== true && entry.state !== 'final') continue;
        if (!found || position(entry) > position(found)) found = entry;
      }
      return found;
    };
    const byTime = (a, b) => {
      const apart = a.time - b.time;
      return Number.isFinite(apart) && apart !== 0 ? apart : position(a) - position(b) || a.seq - b.seq;
    };
    const groups = new Map();
    // `bySeq` is already ordered. Carry the newest turn start forward instead of rescanning
    // the whole retained stream for every untagged row. Starts at the same canonical position
    // become active only when the position advances, matching the old strict-`<` boundary.
    let activeAnchor;
    let pendingAnchor;
    let currentPosition;
    for (const entry of bySeq) {
      const entryPosition = position(entry);
      if (currentPosition === undefined || entryPosition !== currentPosition) {
        if (pendingAnchor !== undefined) activeAnchor = pendingAnchor;
        pendingAnchor = undefined;
        currentPosition = entryPosition;
      }
      let inferredAnchor;
      if (!entry.turnId && activeAnchor !== undefined) {
        const end = ends.get(activeAnchor);
        if (end === undefined || entry.time <= end) inferredAnchor = activeAnchor;
      }
      const anchor = (entry.turnId ? anchors.get(entry.turnId) : inferredAnchor) ?? entryPosition;
      const held = groups.get(anchor);
      if (held) held.push(entry);
      else groups.set(anchor, [entry]);
      if (entry.kind === 'turn_start' && entry.turnId) pendingAnchor = anchors.get(entry.turnId);
    }
    const out = [];
    for (const anchor of [...groups.keys()].sort((a, b) => a - b)) {
      const group = groups.get(anchor);
      const ends = closing(group);
      group.sort((a, b) => rank(a, ends) - rank(b, ends) || byTime(a, b));
      out.push(...group);
    }
    return out;
  }

  /** Keeps the app-owned render feed bounded while preserving reading order. */
  function trimStream() {
    const bySequence = [...streamBySeq.values()].sort((a, b) => a.seq - b.seq);
    if (bySequence.length > 4000) {
      for (const entry of bySequence.slice(0, bySequence.length - 4000)) streamBySeq.delete(entry.seq);
    }
    streamEntries = chronological(bySequence.slice(-4000));
    // Fiber refresh runs every second while generating. Its settled-turn join used to scan
    // all 4,000 retained stream rows once per visible Fiber turn just to answer one request-id
    // ownership lookup. Build that exact fail-closed relation once when the stream changes.
    streamRequestTurnOwners.clear();
    for (const entry of streamEntries) {
      if (!entry || entry.kind !== 'tool_call' || !entry.requestId || !entry.turnId) continue;
      if (!streamRequestTurnOwners.has(entry.requestId)) {
        streamRequestTurnOwners.set(entry.requestId, entry.turnId);
      } else if (streamRequestTurnOwners.get(entry.requestId) !== entry.turnId) {
        streamRequestTurnOwners.set(entry.requestId, null);
      }
    }
  }

  /**
   * Groups the app feed by its own turn lifecycle, ignoring ChatGPT's reusable DOM ids.
   *
   * This is what makes a reload survivable: `settledGenerations` is a WeakMap owned by one
   * page lifetime, while the app's `turn_start` / `turn_end` events are durable. Visible
   * assistant turns and recorded app turns are both chronological lists, so the renderer can
   * align their newest tails even when no in-memory node→generation mapping survived.
   *
   * Turns are indexed by their durable id, not tracked with a pointer at the newest one. A
   * tool call is appended only once attribution has resolved, and the grace window for that
   * is 5 s — long enough for the user to have sent the next message already. A pointer at the
   * newest open turn would hand that call to the turn after the one that made it.
   */
  function streamTurnGroups(entries) {
    const groups = [];
    const byTurn = new Map();
    const timedRequestTools = [];
    for (const entry of entries) {
      if (entry.kind === 'turn_start') {
        const group = { id: entry.turnId || `seq:${entry.seq}`, entries: [entry], startedAt: Number(entry.time) || 0 };
        groups.push(group);
        if (entry.turnId) byTurn.set(entry.turnId, group);
        continue;
      }
      // Membership is by durable id and nothing else. An event naming a turn this feed
      // opened belongs to that turn however late it lands and whatever has started since;
      // an event this feed cannot name belongs to no group at all.
      //
      // The alternative — dropping an unowned event into whichever turn is open where it was
      // observed — is a guess, and it is the guess that made reloads swirl: backfill re-reports
      // historical answers under ChatGPT's own recycled request ids, and by position those land
      // in the live turn. An unattributed tool call has the same shape with no id at all. The
      // renderer falls back to ChatGPT's native rendering for a turn it has no group for, so
      // the cost of refusing is a row rendered natively; the cost of guessing is a wrong
      // transcript.
      const owner = entry.turnId ? byTurn.get(entry.turnId) : null;
      if (owner) owner.entries.push(entry);
      else if (entry.kind === 'tool_call' && entry.requestId) timedRequestTools.push(entry);
    }

    // Request-id proves which conversation owns a tool call. ChatGPT's own creation/start
    // timestamps then decide where that already-owned event sits in the conversation's
    // chronology when a local turn id was lost to reload/lifecycle churn. This is ordering,
    // not identity: calls with no exact request id stay ungrouped, and there is no seq/DOM/
    // "nearest turn" fallback. A call before the first known turn likewise stays ungrouped.
    for (const entry of timedRequestTools) {
      const at = Number(entry.time);
      if (!Number.isFinite(at)) continue;
      let owner = null;
      for (const group of groups) {
        if (group.startedAt > at) break;
        owner = group;
      }
      if (owner) owner.entries.push(entry);
    }

    // Same reading order as chronological(): the message that ended the turn closes it,
    // whatever `create_time` says, because a turn cannot continue past its own last message.
    const closing = (entries) => {
      let found = null;
      for (const entry of entries) {
        if (entry.kind !== 'assistant_message') continue;
        if (entry.final !== true && entry.state !== 'final') continue;
        const at = Number.isFinite(Number(entry.origin)) ? Number(entry.origin) : entry.seq;
        const held = found === null ? -Infinity : Number.isFinite(Number(found.origin)) ? Number(found.origin) : found.seq;
        if (at > held) found = entry;
      }
      return found;
    };
    const rank = (entry, ends) =>
      entry.kind === 'turn_start' ? -1 : entry.kind === 'turn_end' ? 1 : entry === ends ? 0.5 : 0;
    for (const group of groups) {
      const ends = closing(group.entries);
      group.entries.sort(
        (a, b) =>
          rank(a, ends) - rank(b, ends) || (Number(a.time) || 0) - (Number(b.time) || 0) || a.seq - b.seq
      );
    }
    return groups;
  }

  /** The one durable user-message boundary immediately preceding a visible assistant turn. */
  function userAnchorForTurn(turn, sourceTurns) {
    const at = sourceTurns.indexOf(turn);
    if (at < 0) return null;
    for (let index = at - 1; index >= 0; index--) {
      const prior = sourceTurns[index];
      if (!prior || prior.role !== 'user') continue;
      const ids = new Set();
      for (const message of CLF_DOM.messagesIn(prior)) {
        if (
          message &&
          message.role === 'user' &&
          message.id &&
          // Image/file attachments can expose their own page message object inside the same
          // user turn. The recorder intentionally stores only authored user text as a durable
          // anchor, so an attachment-only id is not a second conversation boundary and must
          // not make this response ambiguous. Intersect with the app's durable anchors first;
          // two *recorded* user messages in one visible turn remain ambiguous and fail closed.
          userAnchorByMessage.has(message.id)
        ) {
          ids.add(message.id);
        }
      }
      // A user turn with no stable id cannot anchor anything. More than one stable id is a
      // renderer transition/branch we also refuse to guess through. Attachment-only page ids
      // are excluded above because they are not authored-message boundaries in the recording.
      if (ids.size !== 1) return null;
      return userAnchorByMessage.get(ids.values().next().value) || null;
    }
    return null;
  }

  /**
   * Reconstruct one website response from the stable user message that caused it.
   *
   * The local lifecycle is intentionally allowed to be fragmented. Reloading mid-response,
   * a transient interrupted marker, or adopting an already-open turn can mint another local
   * turn_start even though ChatGPT is still answering the same user message. The page's
   * stable user-message id is the durable boundary the recorder already captured before any
   * of those local starts.
   *
   * One group between this user anchor and the next is unambiguous. With several groups we
   * additionally require the visible Fiber turn's single response request id, then union only
   * groups in this exact user interval that contain that request id. This handles the live
   * 2026-08-19 failure (one request split by reload/lifecycle churn) without merging a genuine
   * regenerate/retry, which gets a different response request while sharing the same user.
   */
  function anchoredRenderForTurn(turn, sourceTurns, groups, requiredGroup = null, requireRequest = false) {
    const anchor = userAnchorForTurn(turn, sourceTurns);
    if (!anchor || !Number.isFinite(Number(anchor.seq))) return null;
    const anchorSeq = Number(anchor.seq);
    let nextAnchorSeq = Infinity;
    for (const candidate of userAnchorByMessage.values()) {
      const seq = Number(candidate && candidate.seq);
      if (Number.isFinite(seq) && seq > anchorSeq && seq < nextAnchorSeq) nextAnchorSeq = seq;
    }
    const candidates = groups.filter((group) => {
      const start = (group.entries || []).find((entry) => entry.kind === 'turn_start');
      const seq = Number(start && start.seq);
      if (!Number.isFinite(seq) || seq <= anchorSeq || seq >= nextAnchorSeq) return false;
      // A generation that produced nothing is not a candidate reconstruction of a visible
      // response. ChatGPT re-mounting its stop control for a couple of seconds — which a page
      // load can do on its own — opens and closes a local generation with no message, no
      // activity and no call in it. Counting that as a second candidate forces the request-id
      // tie-break below, and a plain answer that called no tools has no request id to offer,
      // so a phantom two-second turn could veto the reconstruction of the real one.
      return (group.entries || []).some(
        (entry) => entry.kind !== 'turn_start' && entry.kind !== 'turn_end'
      );
    });
    if (candidates.length === 0) return null;

    let selected = candidates;
    if (candidates.length > 1 || requireRequest) {
      const descriptor = fiberTurnFor(turn);
      if (!descriptor) return null;
      const requestIds = new Set();
      for (const call of descriptor.calls || []) if (call && call.requestId) requestIds.add(call.requestId);
      if (requestIds.size !== 1) return null;
      const requestId = requestIds.values().next().value;
      selected = candidates.filter((group) =>
        (group.entries || []).some((entry) => entry.kind === 'tool_call' && entry.requestId === requestId)
      );
      if (selected.length === 0) return null;
    }
    // During a live turn, do not let an activity pull that has only part of the response hide
    // the section currently being written. Wait until the app feed includes the exact local
    // generation this document owns, then reconstruction can safely take over wholesale.
    if (requiredGroup && !selected.includes(requiredGroup)) return null;

    const bySequence = new Map();
    for (const group of selected) {
      for (const entry of group.entries || []) bySequence.set(entry.seq, entry);
    }
    const recovered = chronological([...bySequence.values()]);
    if (recovered.length === 0) return null;
    return {
      group: selected.length === 1 ? selected[0] : { id: `user:${anchor.messageId}`, entries: recovered },
      entries: recovered
    };
  }

  /** The store already supplies canonical logical items; rendering performs no dedupe. */
  function visibleStream(entries) {
    return entries;
  }

  /** The exact durable stream key carried by one stable website object. */
  function websiteKey(kind, value) {
    return value ? `${kind}\u0000${value}` : null;
  }

  function entryHasWebsiteKey(entry, key) {
    if (!entry || !key) return false;
    const split = key.indexOf('\u0000');
    const kind = key.slice(0, split);
    const value = key.slice(split + 1);
    if (kind === 'message') return entry.kind === 'assistant_message' && entry.messageId === value;
    if (kind === 'activity') return entry.kind === 'page_tool' && entry.messageId === value;
    return kind === 'request' && entry.kind === 'tool_call' && entry.requestId === value;
  }

  /** Stable turn-local website objects represented by one app-owned stream. */
  function strongStreamIdentityKeys(entries) {
    const keys = new Set();
    for (const entry of entries || []) {
      const key = entry && entry.kind === 'assistant_message'
        ? websiteKey('message', entry.messageId)
        : entry && entry.kind === 'page_tool'
          ? websiteKey('activity', entry.messageId)
          : null;
      if (key) keys.add(key);
    }
    return keys;
  }

  /**
   * Whether a reused native assistant section may keep pointing at its previous sibling root.
   *
   * React can move/reuse the same section across a newly-authored user row. The section keeps
   * `data-clf-stream-key`, but that attribute is only presentation ownership, not response
   * identity. If Fiber/canonical capture now names a disjoint stable website message/activity,
   * inheriting the old key rewrites the already-correct sibling *above* the user with the later
   * response. Request ids are deliberately excluded here because ChatGPT reuses them across
   * retries/turns; only turn-local website objects can prove continuity.
   */
  function priorStreamRootCompatible(priorKey, rendered) {
    if (!priorKey) return false;
    const root = streamRootsByKey.get(priorKey) || null;
    if (!root || !root.isConnected) return false;
    const current = strongStreamIdentityKeys(rendered);
    if (current.size === 0) return true;
    let previous = [];
    try {
      const parsed = JSON.parse(root.dataset.clfStrongKeys || '[]');
      if (Array.isArray(parsed)) previous = parsed.filter((value) => typeof value === 'string');
    } catch {
      previous = [];
    }
    // No stored stable identity means this root predates the guard or was tool-only. A current
    // stable website object is stronger than that stale section attribute, so fail closed and
    // let canonical identity mint/choose the correct sibling instead.
    if (previous.length === 0) return false;
    return previous.some((key) => current.has(key));
  }

  /**
   * One render-pass index over the local stream.
   *
   * `websiteRenderForTurn()` used to repeatedly filter all 4,000 retained stream entries for
   * every message/activity/request of every visible turn. A long chat with a few dozen items
   * per turn therefore turned one one-second repaint into millions of main-thread predicate
   * calls, exactly while ChatGPT was also trying to virtualize/navigate its own transcript.
   * Build the exact-id join once and keep each turn lookup proportional to the keys it owns.
   */
  function streamRenderIndex(entries, groups) {
    const byKey = new Map();
    const owners = new Map();
    const keysOf = (entry) => {
      const out = [];
      const message = websiteKey('message', entry && entry.kind === 'assistant_message' ? entry.messageId : null);
      const activity = websiteKey('activity', entry && entry.kind === 'page_tool' ? entry.messageId : null);
      const request = websiteKey('request', entry && entry.kind === 'tool_call' ? entry.requestId : null);
      if (message) out.push(message);
      if (activity) out.push(activity);
      if (request) out.push(request);
      return out;
    };
    for (const entry of entries) {
      for (const key of keysOf(entry)) {
        const held = byKey.get(key);
        if (held) held.push(entry);
        else byKey.set(key, [entry]);
      }
    }
    for (const group of groups) {
      const seen = new Set();
      for (const entry of group.entries || []) {
        for (const key of keysOf(entry)) {
          if (seen.has(key)) continue;
          seen.add(key);
          const held = owners.get(key);
          if (held) held.push(group);
          else owners.set(key, [group]);
        }
      }
    }
    return { byKey, owners };
  }

  /**
   * Exact app-stream reconstruction for one visible Fiber turn.
   *
   * Stable ChatGPT message/thought/request ids are the join. This deliberately has no time,
   * DOM-position or tail fallback. Broken 1.8.2 logs can contain canonical assistant/activity
   * rows with `turnId:null` after a premature local turn_end; those rows are still exact
   * website objects, so dropping them merely because lifecycle ownership was lost makes
   * Overwrite swallow text the recorder actually has.
   *
   * Safety against the historical replay bug is set-complete: without an already-proven
   * localGroup, *every* stable website key currently visible in the descriptor must exist in
   * the app stream. A React replacement that briefly exposes an old recorded object plus a
   * new not-yet-recorded object therefore fails closed instead of replaying the old turn.
   * When exact keys identify one durable group, orphan exact rows are promoted to that group
   * for rendering only so chronology can put a prematurely-recorded turn_end back at the end.
   */
  function websiteRenderForTurn(turn, groups, localGroup = null, index = null) {
    const descriptor = fiberTurnFor(turn);
    // Overwrite is presentation, never a reason to make ChatGPT disappear. Without the page
    // model descriptor we cannot prove that the local stream is complete for this visible
    // turn, so keep the native turn untouched rather than hiding it behind a partial group.
    if (!descriptor) return null;
    const lookup = index || streamRenderIndex(streamEntries, groups);
    // Website message/thought ids are turn-local objects. `metadata.request_id` is not: a
    // user can interrupt an in-flight response and ChatGPT can keep the same request id
    // across the next visible assistant turn. Session 2026-08-19-e1052dd7 captured exactly
    // that shape: one request id across three honest local turn groups plus null-turn calls.
    // Treating that response-level id as a turn-local join made every historical renderer
    // reject the turn as soon as a second group existed, which is why a fully reconstructed
    // turn could collapse back to mostly-native ChatGPT after the next user message.
    const strongKeys = [];
    const requestKeys = new Set();
    for (const message of descriptor.messages || []) {
      const key = websiteKey('message', message && message.messageId);
      if (key) strongKeys.push(key);
    }
    for (const activity of descriptor.activities || []) {
      const key = websiteKey('activity', activity && activity.messageId);
      if (key) strongKeys.push(key);
    }
    for (const call of descriptor.calls || []) {
      const key = websiteKey('request', call && call.requestId);
      if (key) requestKeys.add(key);
    }
    // One Fiber turn describing two different response requests is a React transition, not a
    // durable identity. Fail closed rather than choosing whichever request happens to be last.
    if (requestKeys.size > 1) return null;
    if (strongKeys.length === 0 && requestKeys.size === 0) {
      return localGroup ? { group: localGroup, entries: localGroup.entries } : null;
    }

    const matched = new Map();
    let found = localGroup;
    for (const key of strongKeys) {
      const exact = lookup.byKey.get(key) || [];
      // Missing one page-authored item means reconstruction is incomplete, even when an
      // in-memory local turn id is already known. The old exception for `localGroup` is what
      // let one tool call hide an assistant response that the recorder had not captured yet.
      if (exact.length === 0) return null;
      for (const entry of exact) matched.set(entry.seq, entry);

      const owners = lookup.owners.get(key) || [];
      if (owners.length > 1) return null;
      if (owners.length === 1) {
        if (found && found !== owners[0]) return null;
        found = owners[0];
      }
    }

    // A request id can prove a group only while it names exactly one group. If stable
    // message/thought identity (or this document's live/settled node ownership) already chose
    // a group, the request id is merely corroborating response metadata and must never veto
    // that stronger choice. In particular, do not add every exact request match to `matched`:
    // that would paint the next interrupted user turn's calls into this one. Orphan calls are
    // already recovered into the correct time window by streamTurnGroups(), so selecting the
    // chosen group's entries below keeps them without guessing here.
    const requestKey = requestKeys.values().next().value || null;
    if (requestKey && !found) {
      const exact = lookup.byKey.get(requestKey) || [];
      if (exact.length === 0) return null;
      const owners = lookup.owners.get(requestKey) || [];
      if (owners.length > 1) return null;
      if (owners.length === 1) found = owners[0];
      else for (const entry of exact) matched.set(entry.seq, entry);
    }

    // Exact orphan-only data is sufficient to reconstruct the website-authored rows even if
    // a broken old log has no surviving local lifecycle group at all.
    if (!found) {
      const entries = streamEntries.filter((entry) => matched.has(entry.seq));
      return entries.length > 0 ? { group: null, entries } : null;
    }

    // A stable website object recorded under a *different* explicit local turn contradicts
    // the chosen group. Null is recoverable; another durable id is not.
    for (const entry of matched.values()) {
      if (entry.turnId && entry.turnId !== found.id) return null;
    }
    const selected = new Map();
    for (const entry of found.entries || []) selected.set(entry.seq, entry);
    for (const entry of matched.values()) selected.set(entry.seq, entry);
    // Give exact orphan rows the chosen id only in this render copy. That lets the shared
    // chronology contract place a false-premature turn_end after the later website rows while
    // leaving the durable session data untouched and auditable as originally recorded.
    const recovered = [...selected.values()].map((entry) =>
      entry.turnId ? entry : { ...entry, turnId: found.id }
    );
    return { group: found, entries: chronological(recovered) };
  }

  /**
   * True only when local activity can be matched against every page-authored item we can identify.
   *
   * The native DOM stays visible on uncertainty. This is intentionally stricter than the old
   * renderer: an incomplete local transcript is useful in the app, but it is never sufficient
   * evidence to hide ChatGPT's native activity rows. Its answer DOM remains native either way.
   */
  /**
   * Whether Fiber has already exposed a connector call that the local replacement cannot show.
   *
   * This is different from an ordinary transient incomplete scan: an exact new request appears
   * in ChatGPT's page model before the MCP handler can return and before recordToolCall() can
   * append it to /activity. Keeping the previous overwrite mounted in that window hides the only
   * current representation of the call. A newly observed unidentifiable call is equally unsafe.
   */
  function hasUnrepresentedFiberCall(turn, entries) {
    const descriptor = fiberTurnFor(turn);
    if (!descriptor) return false;
    for (const call of descriptor.calls || []) {
      const key = websiteKey('request', call && call.requestId);
      if (!key) return true;
      if (!(entries || []).some((entry) => entryHasWebsiteKey(entry, key))) return true;
    }
    return false;
  }

  function completeReplacementForTurn(turn, entries) {
    const descriptor = fiberTurnFor(turn);
    if (!descriptor) return false;
    const expected = [];
    let assistantModelMessages = 0;
    for (const message of descriptor.messages || []) {
      if (!message || message.role === 'user') continue;
      assistantModelMessages += 1;
      const key = websiteKey('message', message.messageId);
      if (key) expected.push(key);
    }
    for (const activity of descriptor.activities || []) {
      const key = websiteKey('activity', activity && activity.messageId);
      if (key) expected.push(key);
    }
    for (const call of descriptor.calls || []) {
      // A call without ChatGPT request identity cannot be proven complete. Leave that turn
      // native instead of falling back to time/position/cardinality matching.
      const key = websiteKey('request', call && call.requestId);
      if (!key) return false;
      expected.push(key);
    }

    // If ChatGPT visibly has authored assistant prose but Fiber did not identify even one
    // model message, hiding the native prose would be destructive by definition.
    const nativeAssistant = CLF_DOM.messagesIn(turn).some(
      (message) => message && message.role === 'assistant' && message.text
    );
    if (nativeAssistant && assistantModelMessages === 0) return false;
    if (expected.length === 0) return false;
    for (const key of expected) {
      if (!(entries || []).some((entry) => entryHasWebsiteKey(entry, key))) return false;
    }
    return true;
  }

  function streamRow(entry) {
    const row = document.createElement('div');
    row.className = `clf-stream-row clf-stream-${entry.kind}`;
    row.dataset.clfSeq = String(entry.seq);

    const icon = document.createElement('span');
    icon.className = 'clf-stream-icon';
    icon.setAttribute('aria-hidden', 'true');
    if (entry.kind === 'tool_call') setToolIcon(icon, entry.summary && entry.summary.kind);
    else if (entry.kind === 'page_tool') setToolIcon(icon, 'thought');
    else icon.textContent = entry.kind === 'chat_error' ? '!' : entry.kind === 'agent_message' ? '↔' : '';
    row.append(icon);

    if (entry.agent) {
      const who = document.createElement('span');
      who.className = 'clf-agent';
      who.textContent = String(entry.agent).slice(0, 40);
      row.append(who);
    }

    const body = document.createElement('span');
    body.className = 'clf-stream-text';
    if (entry.kind === 'tool_call') {
      body.textContent = entry.summary && entry.summary.title ? entry.summary.title : `Ran ${entry.tool || 'tool'}`;
      if (entry.summary && entry.summary.detail) {
        const detail = document.createElement('span');
        detail.className = 'clf-tool-detail';
        detail.textContent = entry.summary.detail;
        body.append(' ', detail);
      }
    } else if (entry.kind === 'agent_message') {
      body.textContent = `${entry.from || 'agent'} → ${entry.to || 'agent'}: ${entry.text || ''}`;
    } else if (entry.kind === 'page_tool') {
      body.textContent = entry.label || 'ChatGPT tool';
    } else if (entry.kind === 'turn_start') {
      body.textContent = 'Turn started';
    } else if (entry.kind === 'turn_end') {
      const outcome = entry.outcome ? String(entry.outcome).replace(/_/g, ' ') : 'completed';
      body.textContent = `Turn ${outcome}${entry.detail ? ` · ${entry.detail}` : ''}`;
    } else {
      body.textContent = entry.text || '';
    }
    row.append(body);

    const wantedMetric = entry.kind === 'tool_call' ? displayMetric(entry.summary) : '';
    if (wantedMetric) {
      const metric = document.createElement('span');
      metric.className = 'clf-metric';
      metric.textContent = wantedMetric;
      row.append(metric);
    }
    if (SHOW_TIMES && !entry.dom) {
      const when = document.createElement('span');
      when.className = 'clf-when';
      when.textContent = clockText(entry.time);
      row.append(when);
    }
    return row;
  }

  /**
   * Whether a Fiber descriptor names one of *this* app's connectors.
   *
   * Kept in one place because getting it wrong is silent and total: 1.7.1 split the model
   * surface into a Core and a Desktop connector, and while this test still spelled the
   * single pre-1.7.1 name, no descriptor on any page matched it. Every call then looked
   * like a stranger's — so it produced no attribution evidence and, worse, local rows were
   * classified as ChatGPT-native activity and re-recorded as the assistant's own captions.
   * `app_name` comes from the protected-resource metadata this app serves, not from what
   * the user typed into ChatGPT, so these are this app naming itself.
   *
   * Exact names, never a prefix: `Chat On Steroids Backup` would be somebody else's
   * connector, and a prefix test would have this app vouch for its traffic.
   */
  const OUR_CONNECTORS = ['Chat On Steroids Core', 'Chat On Steroids Desktop', 'TobisComputer'];

  function ourConnectorApp(name) {
    return typeof name === 'string' && OUR_CONNECTORS.includes(name);
  }

  function ourConnectorSeen(seen) {
    if (!seen) return false;
    if (ourConnectorApp(seen.app)) return true;
    if (typeof seen.path !== 'string' || !seen.path.startsWith('/')) return false;
    const end = seen.path.indexOf('/', 1);
    return end > 1 && ourConnectorApp(seen.path.slice(1, end));
  }

  /**
   * One visible turn whose viewport position should survive an idle Overwrite repaint.
   *
   * Prefer a user turn: Overwrite mutates assistant sections only, so the user's question is
   * a stable ruler below any historical assistant height that changes. The fallback still
   * helps in a viewport containing only one long assistant response.
   */
  function presentationScrollContainer(node) {
    for (let parent = node && node.parentElement; parent; parent = parent.parentElement) {
      try {
        const style = globalThis.getComputedStyle ? globalThis.getComputedStyle(parent) : null;
        const overflow = style ? String(style.overflowY || '') : '';
        if (/(?:auto|scroll|overlay)/.test(overflow) && parent.scrollHeight > parent.clientHeight + 1) return parent;
      } catch {
        // Keep walking; the window/document fallback below needs no computed style.
      }
    }
    return null;
  }

  function presentationViewportAnchor(sourceTurns) {
    const viewport = Number(globalThis.innerHeight) || Number(document.documentElement && document.documentElement.clientHeight) || 0;
    const pick = (role) => {
      let best = null;
      for (const turn of sourceTurns || []) {
        if (role && turn.role !== role) continue;
        for (const node of turn.nodes || (turn.node ? [turn.node] : [])) {
          if (!node || !node.isConnected || typeof node.getBoundingClientRect !== 'function') continue;
          let rect;
          try {
            rect = node.getBoundingClientRect();
          } catch {
            continue;
          }
          const top = Number(rect && rect.top);
          const bottom = Number(rect && rect.bottom);
          if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue;
          if (bottom < 0 || (viewport > 0 && top > viewport)) continue;
          // Prefer the first fully/partly visible turn below the top edge. If every candidate
          // starts above it, choose the one whose top is closest to the viewport.
          const score = top >= 0 ? top : (viewport > 0 ? viewport : 100000) + Math.abs(top);
          if (!best || score < best.score) best = { node, top, score, scrollRoot: presentationScrollContainer(node) };
        }
      }
      return best;
    };
    return pick('user') || pick(null);
  }

  /** Counteracts only the layout delta caused synchronously by this presentation pass. */
  function restorePresentationViewport(anchor) {
    if (!anchor || !anchor.node || !anchor.node.isConnected || typeof anchor.node.getBoundingClientRect !== 'function') return;
    let after;
    try {
      after = Number(anchor.node.getBoundingClientRect().top);
    } catch {
      return;
    }
    if (!Number.isFinite(after)) return;
    const delta = after - anchor.top;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return;
    try {
      if (anchor.scrollRoot && anchor.scrollRoot.isConnected) anchor.scrollRoot.scrollTop += delta;
      else if (typeof globalThis.scrollBy === 'function') globalThis.scrollBy(0, delta);
    } catch {
      // Presentation compensation is best effort; never make rendering depend on scroll APIs.
    }
  }

  function renderStreams() {
    // Do not mount chat A's durable stream into a fresh-composer DOM while its future chat B
    // still has no route id (or after the route changed before observe() processed it).
    // Keeping the existing DOM untouched also preserves the harmless transient-null case.
    if (conversationId && CLF_DOM.conversationId() !== conversationId) return;
    // Overwrite owns activity ordering, while ChatGPT remains the sole renderer for the answer,
    // code/document blocks and response actions. Rebuilding that subtree from captured HTML lost
    // React behavior and site-specific structure by construction.
    const enabled = renderStreamAllowed() && status.connected === true && status.paired === true;
    // Historical sections are mounted/unmounted *because* a user is moving the viewport.
    // Mutating those fresh mounts during the same wheel/touch/key burst changes document
    // height underneath browser scroll anchoring and is the source of the live up/down jump.
    // Existing synthetic roots are frozen for the same reason: Fiber can fill in while the
    // gesture is active, but presentation waits until the reader has stopped moving.
    if (enabled && presentationScrollActive()) return;
    const sourceTurns = typeof CLF_DOM.presentationTurns === 'function' ? CLF_DOM.presentationTurns() : CLF_DOM.turns();
    const viewportAnchor = presentationViewportAnchor(sourceTurns);
    // A stable `data-turn-id` is not required for presentation. ChatGPT transiently and, in
    // some renderer builds, permanently exposes assistant sections without one. The preceding
    // user message id is a stronger durable boundary anyway, so an id-less response with an
    // exact user anchor must still be reconstructable instead of randomly falling back native.
    const assistantTurns = sourceTurns.filter((turn) => turn.role === 'assistant');
    const groups = streamTurnGroups(streamEntries);
    const renderIndex = streamRenderIndex(streamEntries, groups);
    const newest = assistantTurns[assistantTurns.length - 1] || null;
    // Which reconstructions have already been painted in this pass. See the dedupe below.
    const painted = new Set();
    const seenStreamKeys = new Set();
    for (let turnIndex = 0; turnIndex < assistantTurns.length; turnIndex++) {
      const turn = assistantTurns[turnIndex];
      if (turn.role !== 'assistant') continue;
      const nodes = turn.nodes || (turn.node ? [turn.node] : []);
      const priorKeys = new Set(
        nodes
          .map((node) => node && node.dataset ? node.dataset.clfStreamKey : '')
          .filter(Boolean)
      );
      const priorKey = priorKeys.size === 1 ? priorKeys.values().next().value : null;
      // Through the generation key, not the page's turn id. Everything this script reports
      // is now filed under a locally minted key, because ChatGPT reuses `data-turn-id` from
      // one turn to the next; comparing the DOM id against that key matches nothing, so the
      // live turn was never recognised as live and the reconstruction it is for — the page
      // ordering, the commentary in its own place — never ran at all.
      let localId = localGenerationOf(turn);
      if (generating && turn === newest) {
        const active = generationTurn();
        localId = active === turn ? turnId : null;
      }
      const localGroup = localId ? groups.find((group) => group.id === localId) || null : null;
      const activeNewest = generating && turn === newest;
      const anchorRender = anchoredRenderForTurn(
        turn,
        sourceTurns,
        groups,
        activeNewest ? localGroup : null,
        activeNewest && !localGroup
      );
      // The active newest turn is owned only by the local generation this document observed.
      // While generationTurn() cannot bind it yet, leave ChatGPT native. A stale Fiber stamp
      // or settled node tombstone can describe the previous turn during React reuse, so
      // website-id reconciliation is deliberately reserved for historical/reloaded turns.
      const identityRender = activeNewest
        ? websiteRenderForTurn(turn, groups, localGroup, renderIndex)
        : localId !== null
          ? websiteRenderForTurn(turn, groups, localGroup, renderIndex)
          : websiteRenderForTurn(turn, groups, null, renderIndex);
      // A user-message anchor is excellent at finding the right *window*, but it can include
      // an orphan website row that has not yet been re-homed into the local group. Conversely,
      // websiteRenderForTurn() deliberately promotes exact orphan rows into the chosen group's
      // render copy. Preferring anchorRender unconditionally threw that recovery away: one
      // late/reload-only thinking headline could make the anchor candidate incomplete and drop
      // the entire turn back to native even though the identity reconstruction was provably
      // complete. Pick the candidate that can actually replace every page-authored object.
      const anchorComplete = Boolean(anchorRender && completeReplacementForTurn(turn, anchorRender.entries));
      const identityComplete = Boolean(identityRender && completeReplacementForTurn(turn, identityRender.entries));
      const websiteRender = identityComplete && !anchorComplete
        ? identityRender
        : anchorRender || identityRender;
      const group = websiteRender ? websiteRender.group : null;
      // Fallback for old/unit feeds that predate turn_start/turn_end in /activity.
      const raw = websiteRender
        ? websiteRender.entries
        : streamEntries.filter(
            (entry) => localId !== null && entry.turnId === localId
          );
      const rendered = visibleStream(raw, group ? group.id : localId || turn.id);
      // The reconstruction this section is about to show, named by what it reconstructs
      // rather than by the section showing it. Deliberately not `turn.id`: a section with no
      // id of its own still reconstructs a specific response, and that is the thing that
      // must not be painted twice.
      const groupKey = group ? group.id : localId || null;
      // A reload/history reconstruction can be proven entirely by canonical ChatGPT message
      // ids even when no local lifecycle group survived. Those ids are already the authority
      // used by websiteRenderForTurn(); use them as the sibling-root key too so moving the
      // stream out of the React section does not throw away that identity.
      const renderedMessageIds = [...new Set(
        rendered.map((entry) => entry && entry.messageId).filter(Boolean)
      )];
      const canonicalKey = renderedMessageIds.length > 0 ? `messages:${renderedMessageIds.join(',')}` : null;
      // Once this exact native turn already points at a sibling stream, keep that render key.
      // Reload-only canonical capture may discover another assistant message on a later scan;
      // replacing `messages:a` with `messages:a,b` would manufacture a second visible sibling
      // for the same response until the old root aged out. A real local lifecycle group is
      // stronger and may replace the fallback key; otherwise prior ownership stays stable only
      // while the current stable website objects still overlap the root that key names. A React
      // section reused for the next response keeps its old data attribute, and letting that stale
      // attribute outrank a disjoint canonical message is the presentation-order bug that painted
      // a later transcription above the user's newest turn.
      const compatiblePriorKey = priorStreamRootCompatible(priorKey, rendered) ? priorKey : null;
      const streamKey = groupKey || compatiblePriorKey || canonicalKey;
      if (streamKey) seenStreamKeys.add(streamKey);
      let existing = streamKey ? streamRootsByKey.get(streamKey) || null : null;
      if (existing && !existing.isConnected) {
        streamRootsByKey.delete(streamKey);
        existing = null;
      }
      // Migration/extension-reload compatibility: adopt a stream created by an older content
      // script that still lives inside the native section, then the successful replacement
      // below will move it into the stable sibling slot once it is detached/recreated.
      if (!existing) {
        existing = nodes
          .map((node) => node && node.querySelector ? node.querySelector('.clf-stream') : null)
          .find(Boolean) || null;
      }

      if (!enabled) {
        if (existing) existing.remove();
        if (streamKey) streamRootsByKey.delete(streamKey);
        for (const node of nodes) if (node && node.dataset) delete node.dataset.clfStreamKey;
        CLF_DOM.replaceActivity(turn, null, false);
        CLF_DOM.hideProgress(turn, false);
        for (const block of CLF_DOM.toolBlocks(turn)) block.removeAttribute('data-clf-native-hidden');
        continue;
      }

      // One response, however many sections ChatGPT chose to split it into.
      //
      // `anchoredRenderForTurn` reconstructs from the user message that caused the answer,
      // so every assistant section between that message and the next one resolves to the
      // same render. Sections carrying a `data-turn-id` are already folded into one logical
      // turn by `presentationTurns`; sections rendered without one are not, and each of them
      // painted the whole reconstruction into itself — the same answer once per section,
      // stacked down the page under Overwrite, each hiding ChatGPT's own copy beneath it.
      //
      // The first section to claim a reconstruction owns it. The rest are the same answer:
      // they stay hidden behind it rather than repeating it, and specifically do not fall
      // back to native, which would put ChatGPT's copy of prose the stream above already
      // carries right back on the page.
      if (streamKey && painted.has(streamKey)) {
        for (const node of nodes) if (node && node.dataset) node.dataset.clfStreamKey = streamKey;
        CLF_DOM.hideProgress(turn, true);
        for (const block of CLF_DOM.toolBlocks(turn)) block.setAttribute('data-clf-native-hidden', '1');
        CLF_DOM.replaceActivity(turn, null, true);
        continue;
      }

      if (rendered.length === 0 || !completeReplacementForTurn(turn, rendered)) {
        const lastComplete = existing ? Number(existing.dataset.clfCompleteAt) : 0;
        // A one-second observer and a two-second activity pull race each other by design.
        // Once this exact section has already been proven complete, do not tear ownership
        // down just because one transient Fiber scan or feed page is a beat behind. That
        // produced the visible full-overwrite -> native -> full-overwrite snap on reload and
        // during tool phases. Persistent incompleteness still falls back after the grace.
        const currentCallMissing = hasUnrepresentedFiberCall(turn, rendered);
        if (
          !currentCallMissing &&
          existing &&
          Number.isFinite(lastComplete) &&
          Date.now() - lastComplete < REPLACEMENT_GRACE_MS
        ) {
          // Ownership is being held, not released: the stream mounted here is still on the
          // page, so it still claims this reconstruction against the sections below it.
          if (groupKey) painted.add(groupKey);
          continue;
        }
        if (existing) existing.remove();
        if (streamKey) streamRootsByKey.delete(streamKey);
        for (const node of nodes) if (node && node.dataset) delete node.dataset.clfStreamKey;
        CLF_DOM.replaceActivity(turn, null, false);
        CLF_DOM.hideProgress(turn, false);
        for (const block of CLF_DOM.toolBlocks(turn)) block.removeAttribute('data-clf-native-hidden');
        continue;
      }

      const activityRows = rendered.filter((entry) => entry.kind !== 'assistant_message');
      const root = existing || document.createElement('div');
      root.className = 'clf-stream';
      if (streamKey) {
        root.dataset.clfKey = streamKey;
        streamRootsByKey.set(streamKey, root);
        for (const node of nodes) if (node && node.dataset) node.dataset.clfStreamKey = streamKey;
      }
      root.dataset.clfCompleteAt = String(Date.now());
      root.dataset.clfTurn = turn.id || (group && group.id) || localId || 'anchored';
      // Commentary text is part of the signature: one caption grows in place under the same
      // seq, so a signature made of seq and kind alone would never notice it had changed.
      const signature = `${SHOW_TIMES ? 'times:1' : 'times:0'}|` + activityRows
        .map((entry) =>
          [
            entry.seq,
            entry.kind,
            entry.text || '',
            entry.label || '',
            entry.outcome || '',
            entry.detail || '',
            entry.summary && entry.summary.title ? entry.summary.title : '',
            entry.summary && entry.summary.detail ? entry.summary.detail : '',
            entry.summary ? displayMetric(entry.summary) : '',
            entry.agent || ''
          ].join(':')
        )
        .join('|');
      if (root.dataset.clfSignature !== signature) {
        root.dataset.clfSignature = signature;
        root.replaceChildren(...activityRows.map(streamRow));
      }
      root.dataset.clfStrongKeys = JSON.stringify([...strongStreamIdentityKeys(rendered)]);
      // Hide only the native activity that these exact rows replace. The assistant answer and
      // its React-backed controls remain mounted, visible and interactive.
      CLF_DOM.hideProgress(turn, true);
      for (const block of CLF_DOM.toolBlocks(turn)) block.setAttribute('data-clf-native-hidden', '1');
      CLF_DOM.replaceActivity(turn, root, true);
      if (streamKey) painted.add(streamKey);
    }
    // A virtualized historical turn can disappear from the DOM entirely while its sibling
    // stream remains. Retain it only for the same grace used for transient incomplete scans;
    // this is long enough for React's replace/reorder burst to settle, but does not defeat
    // ChatGPT's long-term history virtualization or leak an unbounded set of visible roots.
    const now = Date.now();
    for (const [key, root] of streamRootsByKey) {
      if (!root || !root.isConnected) {
        streamRootsByKey.delete(key);
        continue;
      }
      if (seenStreamKeys.has(key)) continue;
      const lastComplete = Number(root.dataset && root.dataset.clfCompleteAt);
      if (!Number.isFinite(lastComplete) || now - lastComplete >= REPLACEMENT_GRACE_MS) {
        root.remove();
        streamRootsByKey.delete(key);
      }
    }
    restorePresentationViewport(viewportAnchor);
  }

  /** Mutable structured page rows only. Canonical assistant messages update by messageId. */
  const UPSERT_KINDS = new Set(['page_tool']);

  /** What a stream entry currently says, whichever field its kind keeps it in. */
  const snapshotText = (entry) => (entry ? (entry.kind === 'page_tool' ? entry.label : entry.text) : undefined);

  let settingsPulling = false;

  /**
   * The two settings, read without a conversation to read them from.
   *
   * Only for the id-less case. Everywhere else /activity carries the same fields plus the
   * ones that are per chat — the objective, the block, the draft — and taking them from here
   * instead would quietly drop those. The goal typed into a New Chat is this tab's own until
   * ChatGPT issues an id, so it is layered back on rather than read from an app that has
   * nowhere to store it yet.
   */
  async function pullSettings() {
    if (settingsPulling) return;
    settingsPulling = true;
    try {
      const reply = await ask({ type: 'settings_get' });
      if (!alive || CLF_DOM.conversationId() || !reply || reply.ok !== true || !reply.data) return;
      context = readContext(reply.data.context) || context;
      if (reply.data.goal && typeof reply.data.goal === 'object') {
        goalConfig = {
          ...reply.data.goal,
          objective: pendingObjective,
          // A goal held here is a chat being opened right now, and the mode it was opened in
          // is this tab's to state: the app answered with the app-wide switch, which has no
          // opinion about a conversation that does not exist yet.
          ...(pendingObjective ? { enabled: true, mode: pendingObjectiveMode } : {})
        };
      }
      renderControl();
      renderMenu();
    } finally {
      settingsPulling = false;
    }
  }

  async function pullActivity() {
    if (!CLF_DOM.conversationId()) {
      // A New Chat has no feed: /activity is addressed by conversation, and this composer is
      // in none. The sheet above it still has to say what the settings are, because a goal
      // can be written here and the first message is what the goal produces. Deliberately
      // read off the route rather than the id this tab is holding — that id belongs to the
      // chat before this composer, and so does its goal. See composerChat().
      await pullSettings();
      return;
    }
    if (pulling || !conversationId || CLF_DOM.conversationId() !== conversationId) return;
    pulling = true;
    const forId = conversationId;
    const forEpoch = epoch;
    const current = () => alive && conversationId === forId && epoch === forEpoch;
    try {
      const reply = await ask({ type: 'activity', conversationId, since });
      if (!reply || reply.ok !== true || !reply.data) {
        // Keep waiting only for failures that can genuinely mean "the local app/worker is
        // not reachable yet". A structured application refusal is an answer to the identity
        // question, so it must release the gate rather than freezing this page forever.
        const retryableIdentityMiss =
          !reply ||
          reply.error === 'app_not_found' ||
          reply.error === 'not_paired' ||
          reply.error === 'disconnected';
        if (resumeIdentityPending && !retryableIdentityMiss) resumeIdentityPending = false;
        return;
      }
      if (!current()) return;
      const data = reply.data;
      // Popup-only. `sessionId` is the app saying it has a session for this exact chat,
      // which is the difference between "delivered" and "the app is actually recording it".
      observed.session = typeof data.sessionId === 'string' ? data.sessionId : null;
      observed.pulledAt = Date.now();
      if (data.retiredWorker && typeof data.retiredWorker === 'object') {
        const worker = String(data.retiredWorker.id || 'worker');
        const reason = String(data.retiredWorker.reason || 'its sub-agent run ended');
        autoCompactReady = false;
        localError = `${worker} was retired because ${reason}. This chat can no longer use local tools.`;
        if (retirementHandledFor !== forId) {
          retirementHandledFor = forId;
          const stop = CLF_DOM.stopButton();
          if (stop && typeof stop.click === 'function') stop.click();
          emit({ kind: 'chat_error', text: localError });
        }
        renderControl();
        return;
      }
      if (data.resetActivity === true) {
        // The app deliberately bounded an old/reload cursor to its newest presentation
        // window. Replace, never merge, or stale rows from before the gap would survive
        // beside the authoritative tail and appear to jump across turns.
        bySeq.clear();
        streamBySeq.clear();
        streamMessageSeq.clear();
        userAnchorByMessage.clear();
        const truncatedFrom = Number(data.truncatedFrom);
        if (Number.isFinite(truncatedFrom) && truncatedFrom >= 0) since = truncatedFrom;
      }
      for (const anchor of Array.isArray(data.userAnchors) ? data.userAnchors : []) {
        const seq = Number(anchor && anchor.seq);
        const messageId = typeof (anchor && anchor.messageId) === 'string' ? anchor.messageId : '';
        if (!Number.isFinite(seq) || !messageId) continue;
        userAnchorByMessage.set(messageId, { seq, time: Number(anchor.time) || 0, messageId });
      }
      if (userAnchorByMessage.size > 2000) {
        const oldest = [...userAnchorByMessage.values()]
          .sort((a, b) => Number(a.seq) - Number(b.seq))
          .slice(0, userAnchorByMessage.size - 2000);
        for (const anchor of oldest) userAnchorByMessage.delete(anchor.messageId);
      }
      const freshStream = Array.isArray(data.stream) ? data.stream : [];
      let streamAdded = 0;
      let exactTurnActivity = false;
      const isWork = (entry) =>
        entry &&
        entry.turnId === turnId &&
        (entry.kind === 'tool_call' ||
          entry.kind === 'page_tool' ||
          entry.kind === 'progress' ||
          entry.kind === 'assistant_message');
      for (const entry of freshStream) {
        const seq = Number(entry && entry.seq);
        if (!Number.isFinite(seq)) continue;
        if (seq >= since) since = seq + 1;
        // The app's own verdict on a request id, arriving on the feed this page already
        // polls. `request_id` means it resolved the call to this conversation; anything
        // else means the call reached the app but could not be placed by its id.
        if (entry.kind === 'tool_call' && entry.requestId) {
          traceStage(entry.requestId, 'app', entry.attribution);
          traceStage(entry.requestId, 'tool', entry.tool);
        }
        if (entry && entry.kind === 'assistant_message' && entry.messageId) {
          const messageId = String(entry.messageId);
          const priorSeq = streamMessageSeq.get(messageId);
          if (Number.isFinite(priorSeq)) streamBySeq.delete(priorSeq);
          streamMessageSeq.set(messageId, seq);
          streamBySeq.set(seq, entry);
          streamAdded++;
          if (
            pendingPresentation &&
            messageId === pendingPresentation.messageId &&
            (entry.final === true || entry.state === 'final') &&
            String(entry.text || '') === pendingPresentation.text
          ) {
            settlePresentation();
          }
          if (generating && isWork(entry)) exactTurnActivity = true;
          continue;
        }
        // Commentary and native tool rows arrive again as they change, under the seq they
        // first appeared at — that is what keeps one caption one row instead of a new row
        // per redraw, and one tool row instead of one per relabel. So a repeat of a seq we
        // hold replaces it rather than being discarded as already seen.
        //
        // Both kinds, not just progress. `page_tool` supersession was added on the app side
        // and then dropped here, because a held entry of any other kind fell straight
        // through this guard: `Inspecting files` could never become `Inspected files`.
        const held = streamBySeq.get(seq);
        if (held) {
          if (!entry || entry.kind !== held.kind || !UPSERT_KINDS.has(held.kind)) continue;
          if (snapshotText(held) === snapshotText(entry)) continue;
        }
        streamBySeq.set(seq, entry);
        streamAdded++;
        if (generating && isWork(entry)) exactTurnActivity = true;
      }
      if (streamAdded > 0) trimStream();
      if (exactTurnActivity) lastChangeAt = Date.now();

      const fresh = Array.isArray(data.entries) ? data.entries : [];
      let added = 0;
      for (const entry of fresh) {
        const seq = Number(entry && entry.seq);
        if (!Number.isFinite(seq)) continue;
        // Ask for what comes *after* this one next time. Asking from `seq` itself is the
        // bug that made the feed repeat its last entry forever.
        if (seq >= since) since = seq + 1;
        if (bySeq.has(seq)) continue;
        bySeq.set(seq, entry);
        added++;
      }
      if (added > 0) trimEntries();
      const nextSince = Number(data.nextSince);
      if (Number.isFinite(nextSince) && nextSince > since) since = nextSince;
      job = data.job || null;
      pendingTools = Number.isFinite(Number(data.pendingTools)) ? Number(data.pendingTools) : 0;
      // The generation this chat has open in the app, if any. Only ever *read* by
      // resumeOpenTurn(), on the boot pull, and only to work out whether this document is
      // standing in the middle of a turn a previous one opened. See adoptTurnId.
      appActiveTurnId = typeof data.activeTurnId === 'string' && data.activeTurnId ? data.activeTurnId : null;
      if (resumeIdentityPending) {
        resumeIdentityPending = false;
        if (appActiveTurnId) adoptOpenTurn(appActiveTurnId);
      }
      tokens = Number.isFinite(Number(data.tokens)) ? Number(data.tokens) : 0;
      context = readContext(data.context);
      autoCompactReady = data.autoCompactReady === true;
      // The goal loop's settings and, while one is running, the draft itself: its stage, the
      // text OpenRouter has streamed so far, and — once it is `ready` — the message to type.
      // Nothing is typed here; maybeSendGoalReply below owns that, after the pull has
      // finished and the page has been repainted with what the draft is doing.
      goalConfig = data.goal && typeof data.goal === 'object' ? data.goal : null;
      if (goalConfig) goalDraft = goalConfig.draft || null;
      bootstrap = data.bootstrap === 'resume' || data.bootstrap === 'worker' ? data.bootstrap : null;
      if (job && job.busy) pressedAt = 0;
      // The local phase describes this tab's part of a native compaction, which is over
      // the moment the app's job has moved past waiting for the handoff. Leaving it set
      // would make the button go on saying "ChatGPT is writing…" over a finished job.
      if (!job || job.stage !== 'handoff-pending') {
        nativePhase = '';
        if (!job || !job.busy) nativeBusy = false;
      }
      // Before painting, not after: a row's fold count decides which call goes on it, and
      // painting first would label from a stale count and then have to move it.
      await refreshFiber();
      // Push page observations immediately after the Fiber pass instead of waiting for the
      // normal recorder debounce. The next fast live pull can then consume them; emit/flush is
      // idempotent at the app boundary, so this tightens latency without manufacturing rows.
      void flush();
      // Checked again: refreshFiber() talks to the page context, so the tab can move
      // between the check above and the painting below.
      if (!current()) return;
      paint();
      renderStreams();
      foldBootstrap();
      renderControl();
      injectStage();
      // The activity snapshot is now authoritative and visible. Arm the next read before
      // compaction or Goal side effects below can wait on the page for tens of seconds.
      armNextActivityPull();
    } finally {
      pulling = false;
    }
    // Outside the guard, and last: startCompact runs for tens of seconds and polls this
    // same endpoint while it works, so firing it with `pulling` still set would deadlock
    // the run against the poll that started it.
    if (current() && CLF_DOM.conversationId() === forId) await maybeResumePendingCompaction(forId, forEpoch);
    if (current() && CLF_DOM.conversationId() === forId) maybeRecoverResumeGoalTurn();
    if (current() && CLF_DOM.conversationId() === forId) maybeRecoverDurableGoalTurn();
    if (current() && CLF_DOM.conversationId() === forId) await maybeAutoCompact(forId, forEpoch);
    // Same reason, same place: this types into the composer and can wait on the page, and it
    // needs the draft this pull just delivered.
    if (current() && CLF_DOM.conversationId() === forId) await maybeSendGoalReply();
  }

  // ------------------------------------------------------- composer control

  /**
   * What the Compact & resume control should say right now. Pure, so it can be tested.
   *
   * The app is the authority on all of it: `job` is this chat's own resume job. The local
   * fields cover only the seconds before the app has answered at all, so the button never
   * sits there looking idle immediately after being pressed.
   */
  function controlState(input) {
    const { job, connected, disconnected, conversationId, pressedAt, error, now, phase } = input;

    // The compaction turn has finished, but its exact brief has not crossed the app's durable
    // boundary yet. This is still one live transaction even when the activity feed has not
    // caught up enough to supply a `job`, so never paint an actionable idle/error state that
    // would invite a second press while the idempotent capture is being retried.
    if (phase === 'delivering') {
      return {
        mode: 'busy',
        label: NATIVE_PHASE_LABELS[phase] || 'Saving…',
        hint: error || 'The brief is finished; waiting for the app to store it.',
        action: 'cancel'
      };
    }

    if (job && job.busy && error && !phase) {
      // The ticket is alive but this page's checkpoint failed. Say the failure without
      // declaring the durable job failed; a later generation/reload may pick it up, and the
      // only immediate action offered here is the explicit cancel that closes the ticket.
      return { mode: 'error', label: 'Paused', hint: error, action: 'cancel' };
    }

    if (job && job.busy) {
      if (job.stage === 'opening') {
        return { mode: 'busy', label: 'Opening…', hint: 'Handoff saved, opening the fresh chat', action: 'cancel' };
      }
      if (job.stage === 'waiting-for-browser') {
        return {
          mode: 'waiting',
          label: 'Waiting…',
          hint: job.error || 'The app is trying to open the fresh chat.',
          action: 'cancel'
        };
      }
      // The progress of this is local — interrupting, waiting for tools, typing — and only
      // the last stretch is something the app can report. `phase` is what this tab is doing
      // right now; `handoff-pending` is the app saying it has asked and is waiting.
      return {
        mode: 'busy',
        label: NATIVE_PHASE_LABELS[phase] || 'Asking…',
        hint: 'ChatGPT is writing the handoff',
        action: 'cancel'
      };
    }
    /**
     * A live turn is not a reason to hide.
     *
     * This *interrupts* the turn on purpose: the case somebody actually presses it in is a
     * long turn they no longer want to wait out, and a button that disappears exactly then
     * is a button that is missing whenever it is wanted.
     */
    if (job && job.stage === 'done') {
      return { mode: 'done', label: 'Opened', hint: 'The fresh chat is open', action: 'start' };
    }
    if (job && job.stage === 'failed') {
      if (job.error === 'cancelled') {
        return { mode: 'idle', label: 'Compact', hint: 'Resume cancelled', action: 'start' };
      }
      return { mode: 'error', label: 'Failed', hint: job.error || 'Compaction failed', action: 'start' };
    }
    if (pressedAt > 0 && now - pressedAt < PRESS_GRACE_MS) {
      return { mode: 'busy', label: 'Starting…', hint: '', action: 'none' };
    }
    if (error) return { mode: 'error', label: 'Failed', hint: error, action: 'start' };
    if (disconnected) {
      return {
        mode: 'off',
        label: 'Compact',
        hint: 'Browser connection is disconnected in Chat On Steroids.',
        action: 'none'
      };
    }
    if (!connected) {
      return {
        mode: 'off',
        label: 'Compact',
        hint: 'Chat On Steroids is not running on this PC.',
        action: 'none'
      };
    }
    if (!conversationId) {
      // Off, not hidden: there is nothing to compact yet, and the sheet behind this button is
      // still where a goal is written — which is the one thing that can start the chat.
      return {
        mode: 'off',
        label: 'Compact',
        hint: 'Nothing to compact yet — send a message, or set a goal and it writes one.',
        action: 'none'
      };
    }
    return { mode: 'idle', label: 'Compact', hint: '', action: 'start' };
  }

  /**
   * What the settings sheet says. Pure, so the whole of it can be tested without a composer.
   *
   * One switch, one three-way slider and one action, and the reason they share a sheet is that
   * they are the same subject: what this app is allowed to do to this chat while nobody is
   * watching it. The hover line is the same information in one breath, for the far commoner
   * case of wanting to know rather than to change.
   *
   * `context` and `goal` both come from the app on every poll, so this never reports a
   * setting from memory — a change made in the app's own window shows up here within a tick.
   *
   * `scope` is which of the two composers this sheet is sitting above, and it is the route's
   * answer rather than the id this tab is holding — see composerChat(). Above a New Chat the
   * two switches are gone: they move the app-wide default there, having no chat to belong to,
   * while the goal written in the same sheet starts a chat immediately. Those two scopes read
   * as one control and are not, which is how an unattended run got started as a Goal by
   * somebody who had come to the sheet to start a Loop.
   */
  function settingsView(input) {
    const { context, goal, compact, editing, editingMode, scope } = input;
    // A composer with no chat behind it yet. Everything conversation-scoped is absent here by
    // construction, and the two switches are not conversation-scoped, which is the point.
    const fresh = scope === 'new';
    // `context.auto` is the global preference. Worker chats are a role-level exception: their
    // conversation id is the worker identity, so Compact & Resume is never available there.
    // Keep the sheet truthful even if a generic /settings refresh races the worker-scoped
    // /activity projection and briefly hands this page the global auto=true value.
    const blocked = goal && typeof goal.blocked === 'string' ? goal.blocked : '';
    const auto = Boolean(context && context.auto) && blocked !== 'worker';
    const threshold = context && context.threshold > 0 ? context.threshold : 0;
    // One setting, one control. The app sends the mode beside `enabled`, so there is a single
    // value to read and the slider can only ever be in one of its three positions.
    const mode = goal && goal.mode === 'loop' ? 'loop' : 'goal';
    const goalOn = Boolean(goal && goal.enabled) && mode === 'goal';
    const loopOn = Boolean(goal && goal.enabled) && mode === 'loop';
    // Whether this chat has moved its own switch, which is what tells an Off somebody chose
    // here from an Off inherited from the app-wide setting. Only the second lets a saved goal
    // speak for the chat — see goalArmedFor() in src/main/goal.ts, which this mirrors.
    const own = Boolean(goal && goal.own);
    const hasKey = Boolean(goal && goal.hasKey);
    const objective = goal && typeof goal.objective === 'string' ? goal.objective : '';
    // The app's own reason, rather than this tab's guess. Today there is exactly one: a
    // worker chat, where the prime already writes the user's turns.
    const from = threshold > 0 ? `from ${roundK(threshold)} tokens` : '';
    // Is anything driving this chat at all? A saved goal is enough on its own, but only for a
    // chat that has never moved its own switch — the same rule the app applies.
    const armed = own ? goalOn || loopOn : goalOn || loopOn || Boolean(objective);
    const running = armed && hasKey && !blocked;
    // Which instruction would actually drive this chat, which is not the same question as
    // which switch is on. A chat that runs only because it carries a goal, with the standing
    // switch off, is driven as a Goal and may therefore stop. This mirrors goalDrivingMode()
    // in src/main/goal.ts exactly, and it is what the task editor below is labelled from — a
    // sheet that named the mode differently from the app would be worse than naming none.
    const driving = loopOn ? 'loop' : 'goal';
    // The slider's position: the one word for everything above. Off is a real position and not
    // merely "neither switch", which is why `armed` and not `enabled` decides it.
    const position = blocked ? 'off' : !armed ? 'off' : loopOn ? 'loop' : 'goal';
    return {
      // Two short lines rather than a sentence: this is read while reaching for something
      // else, and the only questions it answers are "is it on" and "at what point".
      tip: [
        auto ? `Auto-compaction on${from ? `, ${from}` : ''}` : 'Auto-compaction off',
        blocked === 'worker'
          ? 'Goal off — the prime writes this chat'
          : fresh
            ? !hasKey
              ? 'No API key — Goal and Loop unavailable'
              : objective
                ? 'Opening this chat on its goal'
                : 'Add a goal or a loop to start this chat'
            : position === 'off'
              ? 'Goal and Loop off'
              : position === 'loop'
                ? hasKey
                  ? 'Loop on — never stops on its own'
                  : 'Loop on — no API key'
                : hasKey
                  ? objective
                    ? 'Goal on — chasing this chat’s goal'
                    : 'Goal on'
                  : 'Goal on — no API key'
      ].join('\n'),
      rows: [
        {
          key: 'autoCompact',
          label: 'Auto-compaction',
          note:
            blocked === 'worker'
              ? 'off here: worker chats never auto-compact'
              : auto
                ? from || 'threshold set in the app'
                : 'compact this chat by hand',
          on: auto,
          warn: false,
          disabled: blocked === 'worker'
        }
      ],
      /**
       * Off, Goal, Loop — one control, because it was always one setting.
       *
       * Drawn as two switches it was possible to read the sheet as offering two independent
       * things that happened to cancel each other, and an unattended run got started as a Goal
       * by somebody who had come here to start a Loop. A slider cannot say that: it has one
       * handle, three stops, and the stop it is at is the mode this chat runs in.
       *
       * Every note under it is a few words wide on purpose. The sheet is a fixed-size thing
       * hanging off a composer, and a note long enough to wrap made the whole panel change
       * height the moment somebody moved the handle.
       *
       * Absent above a New Chat: there is no chat for a mode to belong to, and the two links
       * below carry the mode with them there instead.
       */
      mode: fresh
        ? null
        : {
            value: position,
            options: [
              { value: 'off', label: 'Off', hint: 'Nothing is written here on its own.' },
              {
                value: 'goal',
                label: 'Goal',
                hint: `Replies as you until this chat’s goal is reached, then stops. Written with ${modelLabel(goal && goal.model)}.`
              },
              {
                value: 'loop',
                label: 'Loop',
                hint: `Replies as you for ever — only this slider ends it. Written with ${modelLabel(goal && goal.model)}.`
              }
            ],
            // The one line under the slider: what the position it is at actually does. The
            // missing key and the worker rule are said here too, because they are the answer
            // to the only question somebody reaching for this control has.
            note:
              blocked === 'worker'
                ? 'the prime writes here'
                : !hasKey
                  ? 'OpenRouter key required'
                  : position === 'loop'
                    ? 'replies for ever'
                    : position === 'goal'
                      ? 'replies until goal reached'
                      : 'no replies written here',
            warn: !hasKey || blocked === 'worker',
            disabled: blocked === 'worker'
          },
      /**
       * The one task, and — above a New Chat only — the mode it is written in.
       *
       * Goal and Loop share it. They are the same instruction read two ways: chase this, and
       * stop when it is reached, or chase this and never stop. So sliding from one to the other
       * keeps the sentence that was written; the slider above owns the mode, and this owns the
       * words, and neither can quietly answer for the other.
       *
       * A New Chat has no slider, because it has no chat for a mode to belong to. There the two
       * links are the whole decision, and they carry their mode with them into the chat they
       * are about to start.
       */
      objective: {
        text: objective,
        editing: Boolean(editing),
        /**
         * What Save is about to write this task as.
         *
         * In a chat the slider owns it, not the link that opened the editor — an editor left
         * open while the handle moves must not save into the mode the sheet has stopped being
         * in. Above a New Chat there is no slider, so there the link that was pressed is the
         * only thing that knows.
         */
        mode: fresh ? (editingMode === 'loop' ? 'loop' : 'goal') : driving,
        /**
         * May this editor save at all? Off is not a mode a task can be written into, and an
         * open editor is the one way a save could otherwise reach past an Off and switch the
         * chat back on behind the slider that had just turned it off.
         */
        savable: fresh || position !== 'off',
        /** Shown instead of the links once a goal exists, so it can be read without opening it. */
        summary: objective ? clampLine(objective, 120) : '',
        /** The mode this chat is being driven in right now, so the editor saves into it. */
        driving,
        actions: fresh
          ? [
              {
                mode: 'goal',
                label: 'add specific goal',
                hint: 'Write what this chat has to reach. It then prompts until it is reached, and stops there.'
              },
              {
                mode: 'loop',
                label: 'add specific loop',
                hint: 'Write what this chat has to reach. It then prompts for ever — nothing but the Loop slider ends it.'
              }
            ]
          : [
              {
                // One link in a chat, whatever the mode. The text and the mode have distinct
                // owners here: this editor changes the words, the slider changes how they run.
                // Two links would offer the mode a second time and let a text save masquerade
                // as a mode switch.
                mode: driving,
                label: objective ? 'edit task' : 'add task',
                // Off is not a mode this task could be saved into, so it is not offered as one.
                // Picking Goal or Loop first is the same order the slider reads in.
                disabled: position === 'off',
                hint:
                  position === 'off'
                    ? 'Pick Goal or Loop above first — Off writes nothing.'
                    : objective
                      ? `Change or clear what this chat has to reach. It runs as ${driving === 'loop' ? 'Loop' : 'Goal'}.`
                      : `Write what this chat has to reach. It runs as ${driving === 'loop' ? 'Loop' : 'Goal'}.`
              }
            ],
        available: hasKey && !blocked,
        unavailable:
          blocked === 'worker'
            ? 'A worker chat is already driven by its prime.'
            : !hasKey
              ? 'Add an OpenRouter API key in the app first.'
              : ''
      },
      // The button's old job, kept as a row rather than dropped: pressing the gear must not
      // have cost anybody the one thing it used to do.
      action: {
        label:
          blocked === 'worker'
            ? 'Compact & resume unavailable'
            : compact.action === 'cancel'
              ? 'Cancel compaction'
              : 'Compact & resume now',
        hint:
          blocked === 'worker'
            ? 'Worker chats stay in their existing conversation and are never manually compacted or resumed.'
            : compact.hint,
        action: blocked === 'worker' ? 'none' : compact.action
      }
    };
  }

  /** One line of somebody else's prose, cut to fit a menu without a mid-word break. */
  function clampLine(text, max) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    const cut = flat.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }

  /**
   * Tells our stylesheet which way ChatGPT is currently painted.
   *
   * Our hover bubble copies colours the page has no variable for, so it carries a light
   * and a dark set of its own and one of the two has to be chosen. The choice is the
   * page's: ChatGPT's appearance setting is independent of the operating system's, so a
   * `prefers-color-scheme` rule put the bubble on the opposite surface from the page for
   * anyone whose two settings disagree — a white pill on a dark conversation.
   *
   * Re-read on the observe tick rather than once at startup, because the setting can be
   * changed while the tab is open, and written only on a change so the common case costs
   * one string comparison.
   */
  let themeNow = null;

  function syncTheme() {
    const theme = CLF_DOM.pageTheme();
    if (theme === themeNow) return;
    themeNow = theme;
    // On the root, so it reaches both the control in the composer and the bubble and menu,
    // which live in the body's top layer rather than inside the control.
    document.documentElement.setAttribute('data-clf-theme', theme);
  }

  /**
   * ChatGPT's hover bubble, for this extension's own controls.
   *
   * Everything here used the `title` attribute, which the operating system draws: a pale
   * rectangle in the platform's font, on the platform's delay, looking nothing like the page
   * around it. This is the same text on the same trigger, drawn the way the page draws its
   * own — see `.clf-tip` for the measurements, which are the composer's.
   *
   * One bubble for the document, and the listeners are delegated, because the controls that
   * use it are rebuilt every time ChatGPT replaces the composer and per-control listeners
   * would accumulate one set per re-render for as long as the tab is open.
   */
  const TIP_DELAY_MS = 350;
  let tipNode = null;
  let tipTimer = null;
  let tipFor = null;

  function tipElement() {
    if (tipNode && tipNode.isConnected) return tipNode;
    tipNode = document.createElement('div');
    tipNode.className = 'clf-tip';
    tipNode.setAttribute('role', 'tooltip');
    tipNode.hidden = true;
    (document.body || document.documentElement).append(tipNode);
    return tipNode;
  }

  function hideTip() {
    if (tipTimer !== null) clearTimeout(tipTimer);
    tipTimer = null;
    tipFor = null;
    if (tipNode) tipNode.hidden = true;
  }

  /** Above the control and centred on it, clamped so a control near an edge still reads. */
  function placeTip(anchor) {
    const tip = tipElement();
    const at = anchor.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const left = Math.max(8, Math.min(at.left + at.width / 2 - width / 2, window.innerWidth - width - 8));
    const above = at.top - height - 8;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(above < 8 ? at.bottom + 8 : above)}px`;
  }

  function showTip(anchor) {
    const text = anchor.getAttribute('data-clf-tip');
    if (!text) return;
    const tip = tipElement();
    tip.textContent = text;
    // A name sits on one line; a sentence wraps. Deciding by length rather than by caller
    // keeps every call site to the one attribute.
    tip.dataset.clfTipWrap = text.length > 44 ? '1' : '0';
    tip.hidden = false;
    tipFor = anchor;
    placeTip(anchor);
  }

  function wireTips() {
    const open = (event) => {
      const at = event.target;
      const anchor = at && at.nodeType === 1 && at.closest ? at.closest('[data-clf-tip]') : null;
      if (!anchor || anchor === tipFor) return;
      hideTip();
      tipTimer = setTimeout(() => {
        if (anchor.isConnected) showTip(anchor);
      }, event.type === 'focusin' ? 0 : TIP_DELAY_MS);
    };
    const close = (event) => {
      const at = event.target;
      const anchor = at && at.nodeType === 1 && at.closest ? at.closest('[data-clf-tip]') : null;
      if (anchor && anchor !== tipFor && tipTimer === null) return;
      hideTip();
    };
    listen(document, 'pointerover', open, true);
    listen(document, 'focusin', open, true);
    listen(document, 'pointerout', close, true);
    listen(document, 'focusout', close, true);
    listen(document, 'pointerdown', hideTip, true);
    listen(window, 'scroll', hideTip, true);
  }

  /** The context settings out of /activity, or null if the app sent none. */
  function readContext(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    const warn = number(raw.warn);
    const limit = number(raw.limit);
    const threshold = number(raw.threshold);
    if (limit <= 0) return null;
    return { auto: raw.auto === true, threshold, warn, limit };
  }

  /**
   * What the meter shows: how full this conversation is, and of what.
   *
   * Two different questions depending on the settings, which is why the ceiling is not a
   * constant. With automatic compaction on, the number that matters is the threshold,
   * because that is where something will actually happen — a bar that filled towards a
   * limit while the chat was compacted at half of it would be measuring the wrong thing.
   * With it off, nothing acts, so the bar fills towards the limit the app already warns
   * about and turns amber at the advisory line on the way.
   *
   * Returns null when there is nothing honest to draw.
   */
  function meterView() {
    if (!context || tokens <= 0) return null;
    const auto = context.auto && context.threshold > 0;
    const ceiling = auto ? context.threshold : context.limit;
    if (ceiling <= 0) return null;
    const filled = Math.max(0, Math.min(1, tokens / ceiling));
    const level = auto
      ? filled >= 1
        ? 'full'
        : filled >= 0.8
          ? 'near'
          : 'ok'
      : tokens >= context.limit
        ? 'full'
        : context.warn > 0 && tokens >= context.warn
          ? 'near'
          : 'ok';
    // One compact line is enough in the composer. The meter itself already conveys the rest.
    const status = `${roundK(tokens)}/${roundK(ceiling)} · autocompact ${context.auto ? 'on' : 'off'}`;
    return { filled, level, status, tip: status };
  }

  /** A token count as a person would say it: 12k, 340k, 1.2M. */
  function roundK(count) {
    if (count >= 1_000_000) return `${Math.round(count / 100_000) / 10}M`;
    if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
    return String(count);
  }

  /**
   * Starts automatic compaction in the middle of the work, which is the only place it helps.
   *
   * The page does not compare `tokens >= threshold` itself — the app owns the number and
   * says, per poll, whether this chat is over it. What the
   * page adds is the half only it can see: ChatGPT is answering *right now*.
   *
   * That condition is the exact inverse of what this used to demand, and the inversion is
   * the point. Waiting for the turn to end meant every automatic compaction landed on a
   * finished answer — the one moment where a handoff carries nothing across, because the
   * job is already done. Interrupting is what the user is asking for at the threshold: stop here,
   * write the brief, carry on in a fresh chat. Mid-tool-call counts as mid-turn, and is
   * handled by the same settle barrier a manual press goes through.
   */
  async function maybeAutoCompact(expectedConversation = conversationId, expectedEpoch = epoch) {
    const current = () =>
      alive &&
      conversationId === expectedConversation &&
      epoch === expectedEpoch &&
      CLF_DOM.conversationId() === expectedConversation;
    if (!current()) return;
    // Belt-and-suspenders with the bridge role gate. A worker must never start automatic
    // compaction: its conversation is its durable agent identity and the 400k ceiling only
    // changes whether the next stop can be revived.
    if (goalConfig && goalConfig.blocked === 'worker') return;
    if (!conversationId || !context || !context.auto || !autoCompactReady) return;
    // Anything already running owns this chat, including a run started by hand.
    if (nativeBusy || pressedAt > 0 || localError) return;
    if (job && job.busy) return;
    // Three views of liveness, and any of them is enough. `CLF_DOM.generating()` flickers
    // false between phases of one answer, so demanding all three would miss long turns at
    // exactly their busiest moments; the local generation flag and the app's durable
    // activeTurnId cover that gap. An idle or stale chat has none of the three, which is
    // what lets an old 500k conversation be opened and read without being compacted.
    if (!generating && !appActiveTurnId && !CLF_DOM.generating()) return;

    // The continuation transaction is already the durable ticket. A page/barrier error stays
    // local to this document, blocking poll-driven retry churn; the app's 15-minute checkpoint
    // reloads this exact chat and lets the replacement page collect the same transaction.
    await startCompact(true);
  }

  /** Local phases of a ChatGPT-native compaction, as the button says them. */
  const NATIVE_PHASE_LABELS = {
    requested: 'Starting…',
    interrupting: 'Stopping…',
    settling: 'Settling…',
    prompting: 'Asking…',
    waiting: 'Writing…',
    delivering: 'Saving…'
  };

  /**
   * A gear, because the control is now a settings control.
   *
   * It used to be the compaction glyph — two arrows folding towards a line — from when
   * pressing it did exactly one thing. It opens a sheet of switches now, and a button whose
   * icon promises one action and delivers a menu is worse than either.
   *
   * Drawn rather than filled: ChatGPT's own composer icons are 20px, 1.7-weight, round-capped
   * outlines in `currentColor`, and this has to sit in a row of them without announcing that
   * it came from somewhere else.
   */
  const ICON =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3.1"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 ' +
    '1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8.6 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 ' +
    '0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 ' +
    '0 4.6 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 ' +
    '0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 ' +
    '2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
    '</svg>';

  /** The switch itself, one per settings row. Two nodes so the knob can slide. */
  function buildSwitch() {
    const track = document.createElement('span');
    track.className = 'clf-switch';
    track.setAttribute('aria-hidden', 'true');
    const knob = document.createElement('span');
    knob.className = 'clf-switch-knob';
    track.append(knob);
    return track;
  }

  let control = null;
  /** Local phase of a ChatGPT-native compaction this tab is driving. '' when idle. */
  let nativePhase = '';
  /** Guards the whole native run: one press, one interrupt, one injected prompt. */
  let nativeBusy = false;
  /**
   * Which native run is the live one. Bumped by a press and by a cancel.
   *
   * A press spends tens of seconds before it types anything — stopping the turn, then waiting
   * for local tools — and the Cancel offered throughout that window used to change nothing
   * but the durable ticket. The run itself carried on, reached the app with the ticket
   * already aborted, opened a *fresh* continuation for it and typed the prompt in anyway. So
   * the button did nothing that anybody could see, twice over: the pill went straight back to
   * "Asking…", and the second press was the one that appeared to work.
   *
   * Every await in the run rechecks this alongside the conversation and the epoch, which is
   * the same rule those two already enforce: a run whose world moved on under it must stop
   * rather than finish into it.
   */
  let nativeRun = 0;

  function buildControl() {
    const root = document.createElement('div');
    root.className = 'clf-composer';
    root.dataset.clfComposer = '1';

    const pill = document.createElement('span');
    pill.className = 'clf-pill';
    const spinner = document.createElement('span');
    spinner.className = 'clf-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'clf-pill-text';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'clf-cancel';
    cancel.textContent = '×';
    cancel.setAttribute('aria-label', 'Cancel Compact & resume');
    pill.append(spinner, text, cancel);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'clf-compact-btn';
    button.innerHTML = ICON;

    /**
     * The context meter: a bar around the button that fills as the conversation does.
     *
     * On the control rather than beside it, because it is the same subject — how full the
     * chat is, and the thing that does something about it. Composer width is scarce, and a
     * separate widget would have to earn its own space and then explain its relationship
     * to the button next to it.
     */
    const meter = document.createElement('span');
    meter.className = 'clf-meter';
    meter.setAttribute('aria-hidden', 'true');
    const meterFill = document.createElement('span');
    meterFill.className = 'clf-meter-fill';
    meter.append(meterFill);
    button.append(meter);

    // Every handler stops the event: the composer's own container turns a stray click into
    // "focus the textarea", and inside a form an unstopped click would try to submit.
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMenu();
    });
    cancel.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void cancelCompact();
    });

    root.append(pill, button);
    return { root, pill, text, button, cancel, meter, meterFill };
  }

  function currentState() {
    // Whose composer this is, on the same terms as the panel above it — see injectStage.
    // A run belongs to the chat it is running in, and this tab deliberately keeps holding
    // that chat's id across an id-less route because React unmounts one for a frame at a
    // time. New Chat is an id-less route too, so the pill went on spinning "Asking…" above
    // an empty composer, with a Cancel that would have cancelled a handoff in a conversation
    // no longer on screen. The panel already refused to paint there; the pill did not.
    const mine = composerChat().state === 'chat';
    return controlState({
      job: mine ? job : null,
      connected: status.connected && status.paired,
      disconnected: status.disconnected === true,
      conversationId: mine ? conversationId : '',
      pressedAt: mine ? pressedAt : 0,
      phase: mine ? nativePhase : '',
      error: mine ? localError : '',
      now: Date.now()
    });
  }

  /**
   * Puts the control in the composer and keeps it there.
   *
   * ChatGPT replaces the composer's subtree on its own schedule — switching chats, going
   * from empty to non-empty, finishing a turn — and the previous attempt at this lived in
   * the + menu precisely to avoid that fight. It also meant nobody ever found it. So the
   * node is re-attached whenever it has been detached, from both a MutationObserver and
   * the one-second tick, and it is never rebuilt while it is still connected so pressing
   * it cannot be interrupted by a repaint.
   */
  function injectControl() {
    // A brand-new ChatGPT tab used to have nothing to offer — nothing to compact, no feed to
    // read, and a disabled "send a message first" button is not worth half a composer. It has
    // something now: a goal written here is what writes the chat's first message, so the sheet
    // has to be reachable before there is a chat. Compaction stays unavailable and says why.
    const spot = CLF_DOM.composerActions();
    if (!spot || !spot.host) return;
    if (!control || !control.root.isConnected) {
      if (!control) control = buildControl();
      // A host that already holds one of ours (a stale node from a previous subtree)
      // gets cleaned up rather than accumulating copies.
      for (const stale of spot.host.querySelectorAll('[data-clf-composer]')) {
        if (stale !== control.root) stale.remove();
      }
      if (spot.before && spot.before.parentElement === spot.host) spot.host.insertBefore(control.root, spot.before);
      else spot.host.append(control.root);
    } else if (control.root.parentElement !== spot.host) {
      if (spot.before && spot.before.parentElement === spot.host) spot.host.insertBefore(control.root, spot.before);
      else spot.host.append(control.root);
    }
    renderControl();
  }

  /**
   * The settings sheet the gear opens.
   *
   * In the body rather than in the composer, and fixed rather than absolute, for the same
   * reason the hover bubble is: the composer's own subtree is clipped, re-rendered and
   * re-parented by ChatGPT at will, and a menu that lives inside it is a menu that gets cut
   * in half by an overflow rule nobody controls.
   *
   * Built once and re-filled, so an open sheet survives the polls happening underneath it.
   */
  let menuNode = null;
  let menuOpen = false;
  /** Set while a toggle is in flight, so a second click cannot race the first one's write. */
  let menuBusy = false;
  /**
   * The sheet that is on screen right now, as the exact input it was built from.
   *
   * The sheet is a function of that input, so a repaint whose input is unchanged has nothing
   * to draw and must not touch the DOM. It used to rebuild anyway, once a second on the
   * activity tick, and everything a rebuild destroys was destroyed with it: the node the
   * pointer was over — so the hover bubble blinked out and came back on its 350 ms delay,
   * for ever — and the selection, so text could not be selected in the sheet at all.
   */
  let menuPainted = '';

  function buildMenu() {
    const root = document.createElement('div');
    root.className = 'clf-menu';
    root.dataset.clfMenu = '1';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Chat On Steroids settings');
    root.hidden = true;
    (document.body || document.documentElement).append(root);
    return root;
  }

  function menuElement() {
    if (menuNode && menuNode.isConnected) return menuNode;
    menuNode = buildMenu();
    return menuNode;
  }

  function toggleMenu() {
    if (menuOpen) return void closeMenu();
    menuOpen = true;
    hideTip();
    renderMenu();
  }

  function closeMenu() {
    menuOpen = false;
    menuPainted = '';
    if (menuNode) menuNode.hidden = true;
    if (control) control.button.setAttribute('aria-expanded', 'false');
  }

  /**
   * Writes one switch to the app and shows the result, not the intent.
   *
   * The row is not painted from the click. The app owns these settings — its own window can
   * change them, and it is the thing that has to accept the change — so the click asks, and
   * the answer (or the next poll) is what moves the switch. A toggle that flips optimistically
   * and then flips back is how a user learns not to trust the control.
   */
  async function setSetting(key, on) {
    if (menuBusy) return;
    if (key === 'autoCompact' && goalConfig && goalConfig.blocked === 'worker') return;
    menuBusy = true;
    renderMenu();
    try {
      const reply = await ask({
        type: 'settings_set',
        ...(conversationId ? { conversationId } : {}),
        [key]: on
      });
      if (reply && reply.ok === true && reply.data) {
        context = readContext(reply.data.context) || context;
        if (reply.data.goal) goalConfig = { ...(goalConfig || {}), ...reply.data.goal };
      }
    } finally {
      menuBusy = false;
      renderMenu();
      renderControl();
    }
    void pullActivity();
  }

  /**
   * Moves the mode slider, which is still the two switches the app owns underneath.
   *
   * Goal and Loop are one write each and the app turns the other off. Off is the write that
   * used to have no button: whichever of the two is on goes off, and a chat that is running
   * only on its saved task names Goal, because that is the mode a task alone runs in. Either
   * way the write is chat-scoped, so the app records this chat's own answer — which is what
   * makes Off mean off here rather than deferring to the task still saved beside it.
   */
  async function setMode(next, now) {
    if (menuBusy || next === now) return;
    if (next === 'goal') return void setSetting('goal', true);
    if (next === 'loop') return void setSetting('loop', true);
    return void setSetting(now === 'loop' ? 'loop' : 'goal', false);
  }

  function menuView() {
    // The route, not the id this tab is still holding. Clicking New Chat leaves that id in
    // place on purpose (see composerChat), so a sheet drawn from it would keep offering the
    // previous chat's switches — and its goal — above a composer that belongs to no chat at
    // all. `moving` counts as a chat: the switches are drawn, and saving into it is refused
    // by name rather than by silently writing somewhere.
    const where = composerChat();
    const fresh = where.state === 'new';
    return settingsView({
      context,
      // Above a New Chat the only goal that exists is the one this tab is holding until
      // ChatGPT issues an id. Layered here as well as in pullSettings so the sheet is right
      // on the frame the route changes, rather than one activity poll later.
      goal: fresh && goalConfig ? { ...goalConfig, objective: pendingObjective, blocked: '' } : goalConfig,
      compact: currentState(),
      editing: menuEditing,
      editingMode: menuMode,
      scope: fresh ? 'new' : 'chat'
    });
  }

  /**
   * The specific-goal editor, open or closed, and what is in it while open.
   *
   * Held out here rather than read back off the textarea, because renderMenu() rebuilds the
   * sheet from scratch on every write and would otherwise throw away half a typed sentence
   * the moment anything else in the sheet changed.
   */
  let menuEditing = false;
  let menuDraft = '';
  /**
   * Which of the two links opened the editor, and therefore what Save will do.
   *
   * Held beside the draft rather than read back off the sheet for the same reason the draft
   * is: a change in what the sheet says rebuilds it, and the mode is the half of this
   * decision that cannot be recovered from the text.
   */
  let menuMode = 'goal';

  function openObjectiveEditor(current, mode) {
    menuEditing = true;
    menuDraft = current;
    menuMode = mode === 'loop' ? 'loop' : 'goal';
    objectiveError = '';
    renderMenu();
    const box = menuNode && menuNode.querySelector('[data-clf-goal-input]');
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
  }

  function closeObjectiveEditor() {
    menuEditing = false;
    menuDraft = '';
    renderMenu();
  }

  /**
   * Saves this chat's goal and, if it can, starts on it immediately.
   *
   * "Immediately" is the point of the feature. Somebody who has just written down where a
   * chat has to get to should not then have to write its first message as well, and in a
   * chat already under way they should not have to wait for a turn that may never come. So
   * saving is also a start signal, and the two shapes it takes are the two shapes a chat can
   * be in: one that ChatGPT has named, and one that it has not.
   *
   * `mode` travels with the text, all the way to the durable per-chat switch the app writes
   * before it stores the goal. It is not a preference being recorded on the side: it is the
   * difference between a run that may decide it is finished and one that may not, and the
   * only place that decision is unambiguously present is the button that was pressed.
   */
  async function saveObjective(text, mode) {
    if (objectiveBusy) return;
    const which = mode === 'loop' ? 'loop' : 'goal';
    const goal = String(text || '').trim();
    objectiveBusy = true;
    objectiveError = '';
    renderMenu();
    try {
      const where = composerChat();
      if (where.state === 'moving') {
        // The route names a chat this tab has not observed yet. Neither id is safe to write
        // into, and the next observation is a tick away.
        objectiveError = 'this chat is still opening — try again';
        return;
      }
      if (where.state === 'new') {
        // A New Chat. There is no id to save against yet, so the goal is held here and the
        // opening message is asked for directly; sending it is what makes ChatGPT issue the
        // id that the goal is then bound to. See the pendingObjective binding in observe().
        if (!goal) {
          pendingObjective = '';
          pendingObjectiveMode = 'goal';
          pendingObjectiveSent = false;
          return;
        }
        await openWithObjective(goal, which);
        return;
      }
      const reply = await ask({ type: 'goal_objective', conversationId: where.id, text: goal, mode: which });
      if (!reply || reply.ok !== true) {
        objectiveError = replyError(reply) || 'the app did not answer';
        return;
      }
      const stored = reply.data && typeof reply.data.objective === 'string' ? reply.data.objective : goal;
      // The switch the app just pinned, taken from its answer rather than assumed from the
      // button: what the sheet draws is what was actually written down.
      // Pinning the mode is this chat answering for itself, so the sheet stops reading the saved
      // task as the thing that speaks for it — which is what makes a clear here land on Off.
      const switched =
        reply.data && typeof reply.data.mode === 'string' && typeof reply.data.enabled === 'boolean'
          ? { enabled: reply.data.enabled, mode: reply.data.mode, own: true }
          : null;
      goalConfig = { ...(goalConfig || {}), ...(switched || {}), objective: stored };
      menuEditing = false;
      menuDraft = '';
      if (!stored) return;
      // A chat that is idle right now would otherwise sit on its new goal until ChatGPT
      // happened to finish a turn of its own — which, in a chat nobody is typing into, is
      // never. The turn key is the save, so a second save writes a second message and a
      // retried one does not.
      if (!generating && !CLF_DOM.generating() && !goalBusy && !nativeBusy && !(job && job.busy)) {
        goalTurnId = `objective-${Date.now().toString(36)}`;
        setGoalPhase('');
        const forId = conversationId;
        const forEpoch = epoch;
        const forTurn = goalTurnId;
        goalBusy = true;
        try {
          await requestGoalDraft(forTurn, () => alive && conversationId === forId && epoch === forEpoch && goalTurnId === forTurn);
        } finally {
          goalBusy = false;
        }
      }
    } finally {
      objectiveBusy = false;
      renderMenu();
      renderControl();
      injectStage();
    }
  }

  /**
   * Writes and sends the first message of a chat that has no id yet.
   *
   * The one goal draft that is not streamed onto the activity feed, because /activity is
   * addressed by conversation and this chat has no address. It is a plain awaited request,
   * and the panel above the composer is driven from here rather than from a polled draft —
   * the run is still visible, it is simply this tab reporting it rather than the app.
   */
  /**
   * Whether asking for this opening again could answer differently.
   *
   * The app says so itself for the refusals it owns, and a deadline says it by being one: the
   * request outlived the wait rather than being turned down. Everything else — no key, no
   * objective, a model that refused the goal — is a decision, and repeating it only spends
   * somebody's credit on the same answer.
   */
  function openRetryable(reply) {
    if (!reply || reply.ok === true) return false;
    if (reply.retryable === true || (reply.data && reply.data.retryable === true)) return true;
    return reply.status === 0 && reply.error !== 'app_not_found';
  }

  async function openWithObjective(goal, mode) {
    pendingObjective = goal;
    pendingObjectiveMode = mode === 'loop' ? 'loop' : 'goal';
    pendingObjectiveSent = false;
    // Enough of a config for the panel to draw: the model comes back with the reply, so
    // until then it says "the model", which is what modelLabel('') is for. The mode is this
    // tab's own claim until the app answers with what it stored — drawn from the button that
    // was pressed rather than from the standing switch, which is what the whole change is for.
    goalConfig = {
      ...(goalConfig || { hasKey: true, model: '' }),
      enabled: true,
      mode: pendingObjectiveMode,
      objective: goal
    };
    menuEditing = false;
    menuDraft = '';
    closeMenu();
    setGoalPhase('requesting');
    // Asked again on a retryable refusal, and only on one. A goal opening is a single request
    // holding a whole model completion, so the transient failures — the app still starting,
    // its worker asleep, a provider that stalled past the deadline — all land on the one
    // attempt the user made, and there is no later turn for the ordinary Goal loop to try
    // again from. Bounded, because a refusal that keeps repeating is an answer.
    let reply = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        setGoalPhase('requesting');
        await sleep(1_000 * attempt);
        if (!alive || composerChat().state !== 'new') break;
      }
      // The mode as well, because there is no chat yet to hold a switch: this request is the
      // only thing that knows which instruction the opening message is being written under.
      reply = await ask({ type: 'goal_open', text: goal, mode: pendingObjectiveMode });
      if (!alive || (reply && reply.ok === true) || !openRetryable(reply)) break;
    }
    if (!alive || composerChat().state !== 'new') {
      // This request never proved that *our* opening message was sent. The route may now be an
      // unrelated existing chat the user selected while generation was in flight, so discard the
      // pending ownership claim rather than letting a later observer bind it there.
      pendingObjective = '';
      pendingObjectiveMode = 'goal';
      pendingObjectiveSent = false;
      goalConfig = null;
      setGoalPhase('');
      return;
    }
    if (!reply || reply.ok !== true) {
      objectiveError = replyError(reply) || 'the app did not answer';
      setGoalPhase('requesting', objectiveError);
      return;
    }
    const opening = reply.data && typeof reply.data.reply === 'string' ? reply.data.reply : '';
    if (reply.data && typeof reply.data.model === 'string') goalConfig.model = reply.data.model;
    if (!opening) {
      setGoalPhase('requesting', 'the model wrote nothing to open with');
      return;
    }
    setGoalPhase('sending');
    if (!CLF_DOM.insertPrompt(opening, true)) {
      setGoalPhase('sending', 'ChatGPT would not replace the New Chat draft');
      return;
    }
    await sleep(200);
    // Programmatic sends do not reliably bubble the synthetic button click through the
    // document listener in every ChatGPT renderer. Mint the same receipt explicitly at the
    // irreversible boundary so the first user row can open its local generation.
    rememberUserSend();
    const sent = await CLF_DOM.send();
    if (!sent) {
      setGoalPhase('sending', 'ChatGPT would not send the message');
      return;
    }
    // From here the goal outlives this composer: ChatGPT is about to name the conversation,
    // and that name is what the goal is finally saved against. See observe().
    pendingObjectiveSent = true;
    setGoalPhase('');
  }

  function renderMenu() {
    if (!menuOpen) return void closeMenu();
    if (!control || !control.root.isConnected) return void closeMenu();
    const root = menuElement();
    const view = menuView();
    // Everything the sheet is drawn from: the view, and the three pieces of local state the
    // view does not carry because they are this tab's rather than the app's. The draft is
    // deliberately absent — the textarea already holds it, and Save is kept in step by the
    // input listener, so typing a goal repaints nothing.
    const painted = JSON.stringify([view, menuBusy, objectiveBusy, objectiveError]);
    // Unchanged, so the sheet on screen is already the right sheet. Only its position is
    // still worth re-deciding: the composer it hangs off moves as ChatGPT grows it.
    if (painted === menuPainted && root.firstChild) return void placeMenu(root, control.button);
    menuPainted = painted;
    // A rebuild can still land while somebody is halfway through typing a goal, because the
    // app can change what the sheet says at any moment. The text itself survives in menuDraft;
    // the caret and the focus have to be carried by hand, or the sentence being written jumps
    // to its end.
    const typing = root.querySelector('[data-clf-goal-input]');
    const caret =
      typing && document.activeElement === typing
        ? { start: typing.selectionStart, end: typing.selectionEnd }
        : null;
    // Where the box was scrolled to, kept whether or not it has the focus. A goal long enough
    // to scroll is exactly the one somebody reads back before saving, and a rebuilt textarea
    // starts at the top — so without this a rebuild threw the reader back to the first line,
    // whichever way they were scrolling.
    const scrolled = typing ? typing.scrollTop : 0;
    root.textContent = '';
    root.dataset.clfBusy = menuBusy || objectiveBusy ? '1' : '0';

    for (const row of view.rows) {
      const line = document.createElement('button');
      line.type = 'button';
      line.className = 'clf-menu-row';
      line.dataset.clfRow = row.key;
      line.setAttribute('role', 'switch');
      line.setAttribute('aria-checked', row.on ? 'true' : 'false');
      line.disabled = menuBusy || row.disabled === true;

      const label = document.createElement('span');
      label.className = 'clf-menu-label';
      const name = document.createElement('span');
      name.className = 'clf-menu-name';
      name.textContent = row.label;
      const note = document.createElement('span');
      note.className = 'clf-menu-note';
      note.textContent = row.note;
      if (row.warn) note.dataset.clfWarn = '1';
      label.append(name, note);

      const track = buildSwitch();
      track.dataset.clfOn = row.on ? '1' : '0';
      line.append(label, track);
      if (!row.disabled) {
        line.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          void setSetting(row.key, !row.on);
        });
      }
      root.append(line);
    }
    // Under the switch, and above the task it points at.
    if (view.mode) root.append(buildMode(view.mode));
    // Under the slider rather than between the modes: the task text is what either mode is
    // pointed at. Outside the loop, because above a New Chat there is no slider to hang it
    // off and it is then the only thing in the sheet that can start anything.
    root.append(buildObjective(view.objective));

    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'clf-menu-action';
    act.textContent = view.action.label;
    act.disabled = view.action.action === 'none' || menuBusy;
    if (view.action.hint) act.setAttribute('data-clf-tip', view.action.hint);
    act.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      if (view.action.action === 'start') void startCompact();
      else if (view.action.action === 'cancel') void cancelCompact();
    });
    root.append(act);

    root.hidden = false;
    control.button.setAttribute('aria-expanded', 'true');
    placeMenu(root, control.button);
    const box = root.querySelector('[data-clf-goal-input]');
    if (box) {
      if (caret) {
        box.focus();
        try {
          box.setSelectionRange(caret.start, caret.end);
        } catch {
          // A browser that will not take a selection on a freshly attached node keeps the
          // focus, which is the half that matters.
        }
      }
      // After the selection, never before it: restoring a caret scrolls it into view, so the
      // position taken above has to be the last word on where this box is looking.
      if (scrolled > 0) box.scrollTop = scrolled;
    }
  }

  /**
   * Off | Goal | Loop, as one handle with three stops.
   *
   * The three stops are drawn at a fixed width and the line under them is one line, always, so
   * that moving the handle changes what the sheet says and never how big it is. A sheet that
   * grew a row taller as somebody chose Loop moved everything under the cursor while they were
   * still looking at it.
   *
   * `aria-checked` rather than a `<select>` because this is what it looks like: three positions,
   * one of them true, all three readable without opening anything.
   */
  function buildMode(mode) {
    const box = document.createElement('div');
    box.className = 'clf-menu-mode';
    box.dataset.clfRow = 'mode';

    const track = document.createElement('div');
    track.className = 'clf-menu-mode-track';
    track.dataset.clfValue = mode.value;
    track.setAttribute('role', 'radiogroup');
    track.setAttribute('aria-label', 'Goal mode');

    // Behind the three labels, and the only thing that moves. Its position is the value, so
    // there is nothing to keep in step with the buttons in front of it.
    const fill = document.createElement('span');
    fill.className = 'clf-menu-mode-fill';
    fill.setAttribute('aria-hidden', 'true');
    track.append(fill);

    for (const option of mode.options) {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'clf-menu-mode-option';
      stop.dataset.clfMode = option.value;
      stop.setAttribute('role', 'radio');
      stop.setAttribute('aria-checked', option.value === mode.value ? 'true' : 'false');
      stop.textContent = option.label;
      stop.disabled = menuBusy || mode.disabled === true;
      if (option.hint) stop.setAttribute('data-clf-tip', option.hint);
      if (!mode.disabled) {
        stop.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          void setMode(option.value, mode.value);
        });
      }
      track.append(stop);
    }
    box.append(track);

    const note = document.createElement('span');
    note.className = 'clf-menu-mode-note';
    note.textContent = mode.note;
    if (mode.warn) note.dataset.clfWarn = '1';
    box.append(note);
    return box;
  }

  /**
   * The specific goal, and the mode it is written in.
   *
   * Closed it is a link — two only above a New Chat, where the mode is still to be chosen and
   * there is no slider to choose it on. Open it is a box, a Save that names the mode it is
   * about to save in, a Cancel, and a Clear once there is something to clear.
   */
  function buildObjective(objective) {
    const box = document.createElement('div');
    box.className = 'clf-menu-goal';
    box.dataset.clfGoalOpen = objective.editing ? '1' : '0';

    if (!objective.available) {
      const why = document.createElement('span');
      why.className = 'clf-menu-goal-note';
      why.textContent = objective.unavailable;
      box.append(why);
      return box;
    }

    if (!objective.editing) {
      if (objective.summary) {
        const text = document.createElement('span');
        text.className = 'clf-menu-goal-text';
        text.textContent = objective.summary;
        box.append(text);
      }
      // The failure belongs to the sheet, not to one of the two links: a save that was
      // refused was made in one mode and would read as that mode's own problem.
      if (objectiveError) {
        const failure = document.createElement('span');
        failure.className = 'clf-menu-goal-note';
        failure.dataset.clfWarn = '1';
        failure.textContent = objectiveError;
        box.append(failure);
      }
      // One row, because the two are alternatives rather than a list: stacked, the second one
      // reads as a further setting under the first instead of the other half of one choice.
      const links = document.createElement('div');
      links.className = 'clf-menu-goal-links';
      for (const action of objective.actions) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'clf-menu-goal-link';
        link.dataset.clfGoalMode = action.mode;
        // Off offers no editor, and says why in the tooltip rather than by disappearing: a
        // control that vanishes reads as a bug, and this one comes back on the next stop.
        link.disabled = objectiveBusy || menuBusy || action.disabled === true;
        // The reason hangs on the row, not on the button, whenever the button is the thing
        // that is off. A disabled control receives no pointer events at all, so a tooltip
        // put on it is a tooltip nobody can read — and this one is the whole explanation of
        // why the task cannot be opened here.
        if (action.disabled === true) links.setAttribute('data-clf-tip', action.hint);
        else link.setAttribute('data-clf-tip', action.hint);
        const plus = document.createElement('span');
        plus.className = 'clf-menu-goal-plus';
        plus.textContent = objective.summary ? '✎' : '+';
        plus.setAttribute('aria-hidden', 'true');
        const word = document.createElement('span');
        word.textContent = objectiveBusy ? 'working…' : action.label;
        link.append(word, plus);
        link.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openObjectiveEditor(objective.text, action.mode);
        });
        links.append(link);
      }
      box.append(links);
      return box;
    }

    const input = document.createElement('textarea');
    input.className = 'clf-menu-goal-input';
    input.dataset.clfGoalInput = '1';
    input.rows = 3;
    input.placeholder = 'What does this chat have to reach?';
    input.value = menuDraft;
    input.disabled = objectiveBusy;
    input.addEventListener('keydown', (event) => {
      // Enter sends, exactly as it does in the composer this sheet sits above. A goal that
      // genuinely needs paragraphs still has shift+enter.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        // Same gate as the Save button, because this is the same act: a keystroke must not be
        // the one way past an Off.
        if (objective.savable === false) return;
        void saveObjective(input.value, objective.mode);
      }
    });
    box.append(input);

    const buttons = document.createElement('div');
    buttons.className = 'clf-menu-goal-buttons';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'clf-menu-goal-save';
    save.dataset.clfGoalMode = objective.mode;
    // Named, not just "Save". This button is the moment the mode is decided, and the two
    // outcomes are a run that may stop and a run that may not.
    save.textContent = objectiveBusy ? 'Saving…' : objective.mode === 'loop' ? 'Save as loop' : 'Save as goal';
    save.disabled = objectiveBusy || !menuDraft.trim() || objective.savable === false;
    save.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void saveObjective(menuDraft, objective.mode);
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'clf-menu-goal-cancel';
    cancel.textContent = 'Cancel';
    cancel.disabled = objectiveBusy;
    cancel.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeObjectiveEditor();
    });
    // Typing does not repaint the sheet — it would take the caret with it — so the one thing
    // in it that depends on what has been typed is kept in step by hand.
    input.addEventListener('input', () => {
      menuDraft = input.value;
      save.disabled = objectiveBusy || !menuDraft.trim() || objective.savable === false;
    });
    // On the row rather than on Save, for the same reason as the link above: the button this
    // explains is disabled, and a disabled button is deaf to the pointer.
    if (objective.savable === false) {
      buttons.setAttribute('data-clf-tip', 'Pick Goal or Loop above first — Off writes nothing.');
    }
    buttons.append(save, cancel);
    if (objective.text) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'clf-menu-goal-clear';
      clear.textContent = 'Clear';
      // Deleting the task is an edit like any other, so Off stops it too. Reachable only from
      // an editor that was already open when the handle moved — and letting it through there
      // would delete the sentence from under a slider that says nothing is written here.
      clear.disabled = objectiveBusy || objective.savable === false;
      clear.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // The mode goes with the clear as well. Writing the goal switched this chat's mode
        // on; deleting it has to switch that same mode back off, or the chat keeps being
        // prompted with no finish line left anywhere to describe what for.
        void saveObjective('', objective.driving);
      });
      buttons.append(clear);
    }
    box.append(buttons);
    if (objectiveError) {
      const failure = document.createElement('span');
      failure.className = 'clf-menu-goal-note';
      failure.dataset.clfWarn = '1';
      failure.textContent = objectiveError;
      box.append(failure);
    }
    return box;
  }

  /** Above the gear and right-aligned to it, flipped below only when there is no room. */
  function placeMenu(root, anchor) {
    const at = anchor.getBoundingClientRect();
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    const left = Math.max(8, Math.min(at.right - width, window.innerWidth - width - 8));
    const above = at.top - height - 10;
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(above < 8 ? at.bottom + 10 : above)}px`;
  }

  /**
   * Closes the sheet on anything that means "I am doing something else now".
   *
   * Delegated to the document once, for the same reason the tips are: the control itself is
   * rebuilt every time ChatGPT replaces the composer, and per-instance listeners would
   * accumulate one set per re-render for as long as the tab is open.
   */
  function wireMenu() {
    const pointerdown = (event) => {
      if (!menuOpen) return;
      const at = event.target;
      if (at && at.nodeType === 1 && at.closest && (at.closest('[data-clf-menu]') || at.closest('.clf-compact-btn'))) return;
      closeMenu();
    };
    const keydown = (event) => {
      if (!menuOpen || event.key !== 'Escape') return;
      // One Escape at a time: the goal box first, the sheet after. Losing a half-written
      // goal because the sheet went with it is the mistake worth not making.
      if (menuEditing) closeObjectiveEditor();
      else closeMenu();
    };
    const scroll = (event) => {
      // Scrolling a long goal back into view inside the sheet is not "I am doing something
      // else now" — it is using the sheet. Only the page moving underneath closes it.
      const at = event.target;
      if (at && at.nodeType === 1 && at.closest && at.closest('[data-clf-menu]')) return;
      closeMenu();
    };
    const resize = () => closeMenu();
    listen(document, 'pointerdown', pointerdown, true);
    listen(document, 'keydown', keydown, true);
    listen(window, 'scroll', scroll, true);
    listen(window, 'resize', resize);
  }

  function renderControl() {
    if (!control || !control.root.isConnected) return;
    const state = currentState();
    const busy = state.mode === 'busy' || state.mode === 'waiting';
    control.root.hidden = state.mode === 'hidden';
    control.root.dataset.clfMode = state.mode;
    // Never disabled any more: it opens a sheet, and a sheet that explains why compaction is
    // unavailable is exactly what somebody clicking a dead button wanted to be told.
    control.button.disabled = false;
    control.button.setAttribute('aria-label', 'Chat On Steroids settings');
    control.button.setAttribute('aria-haspopup', 'dialog');
    if (!control.button.hasAttribute('aria-expanded')) control.button.setAttribute('aria-expanded', 'false');
    // The meter only while the button is a button. During a run the control is saying what
    // it is doing, and a fill level is neither the question nor the answer any more.
    const meter = state.action === 'start' ? meterView() : null;
    control.meter.hidden = meter === null;
    if (meter) {
      control.meterFill.style.width = `${Math.round(meter.filled * 100)}%`;
      control.meter.dataset.clfLevel = meter.level;
    }
    // The hover says what the settings are, because that is what the button is now. A run in
    // progress, or a failure, is the more urgent thing and takes the line back for as long as
    // it lasts — the pill beside it is already saying so in one word.
    const settings = menuView();
    const tip =
      state.mode === 'idle'
        ? settings.tip
        : state.hint
          ? `${state.label} — ${state.hint}`
          : state.label;
    control.button.setAttribute('data-clf-tip', meter ? `${tip}\n${meter.tip}` : tip);
    if (menuOpen) renderMenu();
    // The pill carries transient run state — progress, the opened chat, a failure. `idle` and
    // `off` are neither, and their label is the button's own name: a pill reading "Compact"
    // beside the Compact button said nothing and spent scarce composer width doing it. Why the
    // control is off is real information, but it is a sentence, so it lives on the hover tip.
    control.pill.hidden = state.mode === 'idle' || state.mode === 'off';
    control.cancel.hidden = state.action !== 'cancel';
    // One word, always. The pill sits inside ChatGPT's composer and has a button's width
    // to work with; `label · hint` spent all of it on a sentence that then got ellipsed
    // halfway through, so it read as neither. The hint is on the hover tip, in full.
    //
    // The one exception is a failure, where the identifying detail *is* the message and a
    // one-word "Failed" would send the reader hunting for a tooltip to find out why.
    const shown = state.mode === 'error' && state.hint ? state.hint : state.label;
    if (control.text.textContent !== shown) control.text.textContent = shown;
  }

  /**
   * Folds away the instruction this app typed to start the chat.
   *
   * A resumed chat opens with the whole handoff brief and a worker chat with "You are
   * worker agent worker-n …", and both of them arrive as an ordinary user message — a
   * screenful of machinery at the top of the transcript, sitting where the thing the user
   * actually asked for belongs. It has to be sent: ChatGPT needs it. It does not have to
   * be the first thing anybody reads.
   *
   * Folded, never removed. It is a real message that a real model was given, and a
   * transcript that quietly hides part of its own input is worse than a long one. The
   * summary says what it is and opens it in place.
   *
   * `bootstrap` comes from the session record rather than from this tab's memory of having
   * typed it, so it still holds when the chat is reopened days later.
   */
  function foldBootstrap() {
    if (!bootstrap) return;
    const node = CLF_DOM.firstUserMessage();
    if (!node) return;
    // Asks the DOM, not a flag. If React re-rendered this message and took our fold with
    // it, a remembered "already done" would leave the wall of text back on screen forever.
    if (node.querySelector(':scope > .clf-boot')) return;
    // Only ever the first user message of a chat the app opened. `runCommand` refuses to
    // run at all once a conversation exists, so by construction that message is ours.
    const box = document.createElement('details');
    box.className = 'clf-boot';
    const head = document.createElement('summary');
    head.className = 'clf-boot-head';
    head.textContent =
      bootstrap === 'worker'
        ? 'The instruction this app gave the worker — not something you typed'
        : 'The handoff brief this app carried over — not something you typed';
    box.append(head);

    node.dataset.clfBootstrap = bootstrap;
    // Moved into the fold rather than copied: two copies of a several-thousand-character
    // brief in one page is the problem again, one of them merely hidden.
    while (node.firstChild) box.append(node.firstChild);
    node.append(box);
  }

  /**
   * What the panel above the composer should show, or null for "not there at all".
   *
   * Pure, so the decision can be tested without a DOM. Deliberately narrow: the panel
   * answers "what is it doing right now", and the moment there is no answer it leaves
   * rather than sitting above the input as an empty box.
   *
   * Only ever this chat's own work: `job` is reported per conversation, so a tab sitting
   * idle beside a chat that is compacting shows nothing.
   */
  const COMPACT_STEPS = ['Preparing', 'Writing the handoff', 'Saving it', 'Opening the new chat'];

  function stageView(input) {
    const { job, goal, phase = nativePhase } = input;
    if (job && job.busy) {
      const stage =
        job.stage === 'opening'
          ? 'Opening a fresh chat'
          : job.stage === 'waiting-for-browser'
            ? 'Waiting for Chrome'
            : 'ChatGPT is writing the handoff';
      // The prompt's durable position, not this document's memory of typing it. A reload
      // during the compaction turn starts a page whose `phase` is empty while the marked
      // prompt has been with ChatGPT for minutes — and the bar then said "Preparing" about
      // work that was two steps further on, for as long as the answer took. The app's
      // checkpoint outlives the page, so the page reads its progress off that instead.
      const asked =
        job.sourceSend &&
        (job.sourceSend.state === 'dispatched-unresolved' || job.sourceSend.state === 'sent');
      const at =
        job.stage === 'opening' || job.stage === 'waiting-for-browser'
          ? 3
          : phase === 'delivering'
            ? 2
            : phase === 'prompting' || phase === 'waiting' || asked
              ? 1
              : 0;
      return { stage, detail: '', body: '', kind: 'compact', steps: COMPACT_STEPS, at, done: false };
    }
    return goalStageView(goal);
  }

  /**
   * The short name of an OpenRouter model id, for a caption a person reads at a glance.
   *
   * `deepseek/deepseek-v4-flash` is the id the API wants and not what anybody calls it. The
   * vendor prefix and the `:free`/`:nitro` variant suffix are both routing detail.
   */
  function modelLabel(id) {
    const name = String(id || '').trim();
    if (!name) return 'the model';
    const tail = name.slice(name.lastIndexOf('/') + 1);
    return tail.split(':')[0] || tail;
  }

  /**
   * The goal loop's half of the panel.
   *
   * Split out because it is the half with states in it, and because it is the half worth
   * testing on its own. The rule throughout: say what is happening in the words of the thing
   * that is happening, and show the message itself as it arrives — a loop that types into
   * somebody's chat unattended should never have a step nobody can see.
   *
   * `phase` is what this tab is doing and `draft.stage` is what the app is doing, and they
   * describe different halves of the same run, so the tab's own terminal states are read
   * first and the app's streaming states after.
   */
  /**
   * The stages of one goal run, in the order they happen, as the bar names them.
   *
   * Four, because four different things can be the one taking the time — ChatGPT finishing
   * its answer, the request opening, the model writing, the message going into the composer
   * — and a caption on its own only ever answered "what now". It never answered "how far",
   * so a run that had stopped and a run that was merely slow looked identical for minutes.
   */
  const GOAL_STEPS = ['Answer settling', 'Reading the chat', 'Writing the reply', 'Sending'];

  /**
   * Which of those a phase is.
   *
   * A run that stops is drawn where it stopped, which means the phase has to survive the
   * failure — so the failing paths keep their own phase and record the reason beside it
   * rather than collapsing everything into one `failed`. `failed` itself is the older shape
   * and still means the request, so a stale state does not draw a bar with nothing lit.
   */
  const GOAL_STEP_AT = { settling: 0, requesting: 1, drafting: 2, retrying: 2, sending: 3, failed: 1 };

  function goalStageView(goal) {
    if (!goal) return null;
    const draft = goal.draft || null;
    const who = modelLabel(goal.model);
    const bar = (at, done = false) => ({ steps: GOAL_STEPS, at, done });
    const failure = goal.error || (draft && draft.stage === 'failed' ? draft.error || 'OpenRouter did not answer' : '');
    if (failure) {
      const at = draft && draft.stage === 'failed' ? 2 : (GOAL_STEP_AT[goal.phase] ?? 1);
      if (goal.phase === 'retrying') {
        return { stage: 'Retrying Goal in 15 seconds', detail: failure, body: '', kind: 'goal', ...bar(at) };
      }
      return { stage: 'The goal loop stopped', detail: failure, body: '', kind: 'goal-error', ...bar(at) };
    }
    // A chat opening on a specific goal. There is no answer to read and no turn to settle,
    // so the first two steps of the ordinary run simply did not happen; saying "sending the
    // answer to OpenRouter" about a chat with no answer in it yet would be describing a
    // different run entirely.
    if (goal.opening) {
      if (goal.phase === 'sending') return { stage: 'Sending it to ChatGPT', detail: '', body: '', kind: 'goal', ...bar(3) };
      return { stage: `${who} is writing the first message`, detail: '', body: '', kind: 'goal', ...bar(2) };
    }
    if (goal.phase === 'done') {
      // The loop's own success condition, and the one state worth spelling out: nothing was
      // typed, and that is the answer rather than a failure to produce one. The bar stops at
      // the reply for the same reason — there was never anything to send.
      return { stage: 'Goal reached', detail: 'nothing was sent', body: '', kind: 'goal-done', ...bar(2, true) };
    }
    if (goal.phase === 'settling') {
      return { stage: 'Checking the answer is finished', detail: '', body: '', kind: 'goal', ...bar(0) };
    }
    if (goal.phase === 'sending' && draft && draft.reply) {
      return { stage: 'Sending it to ChatGPT', detail: '', body: draft.reply, kind: 'goal', ...bar(3) };
    }
    if (goal.phase === 'requesting' && !draft) {
      return { stage: 'Sending the answer to OpenRouter', detail: who, body: '', kind: 'goal', ...bar(1) };
    }
    if (!draft) return null;
    if (draft.stage === 'no-reply') {
      return { stage: 'Goal reached', detail: 'nothing was sent', body: '', kind: 'goal-done', ...bar(2, true) };
    }
    if (draft.stage === 'sending') {
      return { stage: 'Sending the answer to OpenRouter', detail: who, body: '', kind: 'goal', ...bar(1) };
    }
    if (draft.stage === 'answering') {
      // Streamed, so the wait has something in it. The text is the message being written for
      // the user, which is exactly the thing worth reading before it is sent.
      return { stage: `${who} is answering`, detail: '', body: draft.text || '', kind: 'goal', ...bar(2) };
    }
    if (draft.stage === 'ready') {
      // Written, not yet typed: the third segment is full and the fourth has not started.
      return { stage: `${who} wrote the next message`, detail: '', body: draft.reply || '', kind: 'goal', ...bar(2, true) };
    }
    return null;
  }

  let stagePanel = null;

  /** Removes the currently mounted stage without changing the work that produced it. */
  function removeStagePanel() {
    if (!stagePanel) return;
    stagePanel.root.remove();
    stagePanel = null;
  }

  /** Only terminal Goal cards linger long enough to need dismissal. */
  function goalStageDismissKey(view) {
    if (!view || (view.kind !== 'goal-done' && view.kind !== 'goal-error')) return '';
    return `${conversationId || 'unknown'}:${goalTurnId || 'terminal'}`;
  }

  /** Dismisses only a finished/stopped Goal run; active work is never hidden implicitly. */
  function dismissTerminalGoalStage() {
    const view = stageView({
      job,
      phase: nativePhase,
      goal: goalConfig
        ? {
            phase: goalPhase,
            error: goalError,
            model: goalConfig.model,
            draft: goalDraft,
            opening: composerChat().state === 'new' && Boolean(pendingObjective)
          }
        : null
    });
    const key = goalStageDismissKey(view);
    if (!key) return;
    dismissedGoalStage = key;
    removeStagePanel();
  }

  function buildStage() {
    const root = document.createElement('div');
    root.className = 'clf-stage';
    root.dataset.clfStage = '1';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');

    const head = document.createElement('div');
    head.className = 'clf-stage-head';
    const title = document.createElement('span');
    title.className = 'clf-stage-title';
    const detail = document.createElement('span');
    detail.className = 'clf-stage-detail';
    const close = document.createElement('button');
    close.className = 'clf-stage-close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Dismiss';
    close.setAttribute('aria-label', 'Dismiss Goal status');
    close.hidden = true;
    close.addEventListener('click', () => {
      // Removing the node alone is not enough: injectStage runs on every activity repaint
      // and would immediately put the same terminal card back. Remember this exact Goal turn;
      // the next turn has a different key and is shown normally.
      if (!stagePanel || stagePanel.root !== root || !stagePanel.dismissKey) return;
      dismissedGoalStage = stagePanel.dismissKey;
      removeStagePanel();
    });
    head.append(title, detail, close);

    const steps = document.createElement('div');
    steps.className = 'clf-stage-steps';

    const body = document.createElement('div');
    body.className = 'clf-stage-body';

    root.append(head, steps, body);
    return { root, title, detail, close, steps, body, dismissKey: '' };
  }

  /**
   * The bar under the caption: one named segment per stage, filled up to where the run is.
   *
   * Built once per set of names and then only re-stamped, because this repaints on every
   * activity pull and rebuilding four nodes a second is four nodes a second of layout for a
   * panel whose text has not changed.
   *
   * `now` is the segment being worked on and the only one that moves; `done` is behind it,
   * `next` ahead of it, and `stopped` is where a run ended. Nothing here is load-bearing —
   * the caption above still says the whole truth in a sentence — so reduced motion simply
   * fills the active segment instead.
   */
  function paintStageSteps(host, view) {
    const names = Array.isArray(view.steps) ? view.steps : [];
    host.hidden = names.length === 0;
    if (names.length === 0) {
      if (host.childElementCount > 0) host.textContent = '';
      host.dataset.clfStepNames = '';
      return;
    }
    const key = names.join(' | ');
    if (host.dataset.clfStepNames !== key) {
      host.dataset.clfStepNames = key;
      host.textContent = '';
      for (const name of names) {
        const step = document.createElement('div');
        step.className = 'clf-stage-step';
        const track = document.createElement('div');
        track.className = 'clf-stage-track';
        const label = document.createElement('div');
        label.className = 'clf-stage-name';
        label.textContent = name;
        step.append(track, label);
        host.append(step);
      }
    }
    const at = Number.isFinite(view.at) ? view.at : 0;
    const stopped = view.kind === 'goal-error';
    [...host.children].forEach((step, index) => {
      const state =
        index < at || (index === at && view.done === true)
          ? 'done'
          : index === at
            ? stopped
              ? 'stopped'
              : 'now'
            : 'next';
      if (step.dataset.clfStep !== state) step.dataset.clfStep = state;
    });
  }

  /**
   * The chat this composer is really sitting in.
   *
   * The route is the authority here, not the id this tab is still holding. Clicking New Chat
   * leaves that id in place on purpose — an id-less route is also ordinary React churn, and
   * dropping the conversation on it was its own bug — but a goal written into the composer
   * that follows belongs to the chat about to be created, not to the one before it. The third
   * state is the honest one: the route names a chat this tab has not observed yet, and
   * neither id is safe to write a message into.
   */
  function composerChat() {
    const routeId = CLF_DOM.conversationId();
    if (!routeId) return { id: '', state: 'new' };
    if (routeId === conversationId) return { id: routeId, state: 'chat' };
    return { id: '', state: 'moving' };
  }

  /**
   * Puts the panel above the composer and keeps it there, on the same terms as the
   * control beside it: ChatGPT replaces this subtree whenever it feels like it.
   */
  function injectStage() {
    // Stage state is conversation-scoped. A concrete different route is handled by
    // resetConversation(); an id-less route is the New Chat/transient-router gap. In both
    // cases the current composer is not proven to belong to the state we would paint.
    // A chat opening on a specific goal is the one id-less case worth painting: its opening
    // message is being written right now, and there is no conversation to key it to because
    // sending that message is what creates one.
    const opening = composerChat().state === 'new' && Boolean(pendingObjective);
    if (!opening && (!conversationId || CLF_DOM.conversationId() !== conversationId)) {
      removeStagePanel();
      return;
    }
    const view = stageView({
      job,
      goal: goalConfig
        ? { phase: goalPhase, error: goalError, model: goalConfig.model, draft: goalDraft, opening }
        : null
    });
    if (!view) {
      removeStagePanel();
      return;
    }
    const dismissKey = goalStageDismissKey(view);
    if (dismissKey && dismissedGoalStage === dismissKey) {
      removeStagePanel();
      return;
    }
    const spot = CLF_DOM.composerStack();
    if (!spot || !spot.host) return;
    if (!stagePanel) stagePanel = buildStage();
    if (stagePanel.root.parentElement !== spot.host) {
      for (const old of spot.host.querySelectorAll('[data-clf-stage]')) {
        if (old !== stagePanel.root) old.remove();
      }
      if (spot.before && spot.before.parentElement === spot.host) spot.host.insertBefore(stagePanel.root, spot.before);
      else spot.host.append(stagePanel.root);
    }

    // The panel is meant to read as a second composer standing behind the real one, which
    // only works if it is exactly as wide. Measured rather than assumed: ChatGPT's composer
    // width follows the window and the sidebar, and the parent centres its children instead
    // of stretching them, so a fixed `max-width` left this sized to its own caption.
    const box = spot.before && spot.before.getBoundingClientRect ? spot.before.getBoundingClientRect() : null;
    const width = box && box.width > 0 ? `${Math.round(box.width)}px` : '';
    if (width && stagePanel.root.style.width !== width) {
      stagePanel.root.style.width = width;
      stagePanel.root.style.maxWidth = 'none';
    }

    if (stagePanel.title.textContent !== view.stage) stagePanel.title.textContent = view.stage;
    if (stagePanel.detail.textContent !== view.detail) stagePanel.detail.textContent = view.detail;
    stagePanel.dismissKey = dismissKey;
    stagePanel.close.hidden = dismissKey === '';
    stagePanel.root.dataset.clfStageKind = view.kind;
    paintStageSteps(stagePanel.steps, view);
    if (stagePanel.body.textContent !== view.body) {
      // Measured before the text is replaced, not after: afterwards `scrollHeight` is
      // already the new content's, so the test would answer a question about the old
      // scroll position using the new document and follow even when the reader had
      // scrolled up to read something.
      const atEnd = stagePanel.body.scrollHeight - stagePanel.body.scrollTop - stagePanel.body.clientHeight < 40;
      stagePanel.body.textContent = view.body;
      if (atEnd) stagePanel.body.scrollTop = stagePanel.body.scrollHeight;
    }
    stagePanel.body.hidden = view.body === '';
  }

  async function startCompact(automatic = false) {
    const forId = conversationId;
    const forEpoch = epoch;
    const forRun = ++nativeRun;
    const current = () =>
      alive &&
      nativeRun === forRun &&
      conversationId === forId &&
      epoch === forEpoch &&
      CLF_DOM.conversationId() === forId;
    if (!forId || !current()) return;
    const workerCompactionBlocked = () =>
      Boolean(agent) || bootstrap === 'worker' || Boolean(goalConfig && goalConfig.blocked === 'worker');
    // A worker's conversation is its agent identity. Usually /activity has already projected
    // blocked:'worker', and the original worker document also knows `agent` immediately after its
    // bootstrap. A reloaded worker has a smaller race: checkStatus() can render the composer gear
    // before the first scheduled /activity (2s), leaving no local role fact yet. Never enter the
    // destructive stop-and-settle barrier on that uncertainty. Refresh the app's exact-chat role
    // first; the bridge remains the final authority and still rejects every worker /compact call.
    if (workerCompactionBlocked()) return;
    // One press, one run. The native path spends tens of seconds interrupting and typing,
    // and a second press inside that window would submit the instruction twice — which is
    // the one thing the app cannot fix afterwards, because the second prompt is a second
    // request the model will try to answer — and then two turns each claim to be the brief.
    if (nativeBusy) return;
    localError = '';
    pressedAt = Date.now();
    job = null;
    nativeBusy = true;
    nativePhase = 'requested';
    renderControl();

    const policy = await ask({ type: 'activity', conversationId: forId, since });
    if (!current()) return;
    const policyData = policy && policy.ok === true && policy.data ? policy.data : null;
    if (!policyData) {
      // Role authority is the prerequisite for the destructive barrier. If the app/service
      // worker is unavailable, interrupting first and discovering later that this was a worker
      // (or that no compaction could be accepted at all) is strictly worse than leaving the
      // current ChatGPT turn untouched and letting the user retry once authority is reachable.
      pressedAt = 0;
      nativeBusy = false;
      nativePhase = '';
      localError = replyError(policy) || 'Could not verify whether this chat may be compacted.';
      renderControl();
      return;
    }
    if (
      ((policyData.goal && policyData.goal.blocked === 'worker') || policyData.bootstrap === 'worker')
    ) {
      // Adopt just the role-bearing projection so the already-open menu/control becomes truthful
      // immediately. The normal activity loop will consume stream/cursor data on its own poll.
      if (policyData.goal && typeof policyData.goal === 'object') goalConfig = policyData.goal;
      if (policyData.context) context = readContext(policyData.context) || context;
      bootstrap = policyData.bootstrap === 'worker' ? 'worker' : bootstrap;
      autoCompactReady = false;
      pressedAt = 0;
      nativeBusy = false;
      nativePhase = '';
      renderControl();
      renderMenu();
      return;
    }

    // The ticket precedes every fallible page barrier. A reload after this 202 can therefore
    // resume the same work, while the app still hands out no prompt until this page has proved
    // the chat stopped and its local calls settled. `automatic` lets Auto Off cancel only work
    // the threshold created, never a manual Compact & Resume press.
    const filed = await ask({ type: 'compact', conversationId: forId, ticket: true, automatic });
    if (!current()) return;
    if (!filed || filed.ok !== true || !filed.data) {
      pressedAt = 0;
      nativeBusy = false;
      nativePhase = '';
      localError = replyError(filed) || 'The compaction ticket could not be stored.';
      renderControl();
      void pullActivity();
      return;
    }
    if (filed.data.job) job = filed.data.job;

    // The barrier, before the request rather than after it.
    //
    // What is being summarised is this conversation plus the local recording of the work
    // done in it, and the app takes its copy of that the moment it accepts this request.
    // Asking first and stopping afterwards would cut the brief from a conversation whose
    // last turn was still being written and whose tool calls were still running — a
    // summary of a machine state that had already moved on.
    // Automatic runs stop the turn exactly like a press does. They are *started* by a turn
    // being in flight, so refusing to interrupt one would refuse every automatic run.
    const barrier = await stopAndSettle(forId, forEpoch, forRun);
    // Every await above can span an SPA navigation. `conversationId` is mutable global
    // state, so continuing after A -> B would otherwise post B to /compact and type A's
    // handoff instruction into B's composer. The new chat's reset already owns its UI state;
    // a stale continuation must not repaint or cancel anything there.
    if (!current()) return;
    if (barrier) {
      pressedAt = 0;
      nativeBusy = false;
      nativePhase = '';
      localError = barrier;
      renderControl();
      void pullActivity();
      return;
    }

    const reply = await ask({ type: 'compact', conversationId: forId, resume: true });
    if (!current()) return;
    if (!reply || reply.ok !== true) {
      pressedAt = 0;
      nativeBusy = false;
      nativePhase = '';
      localError = replyError(reply) || 'The app did not answer.';
      renderControl();
      void pullActivity();
      return;
    }
    const data = reply.data || {};
    if (data.job) job = data.job;
    // No prompt means the app has already handed one out for this transaction — this tab
    // pressed twice, or reloaded, or its first request's answer was lost. There is nothing
    // to submit: submitting a second instruction would start a second turn, and then two
    // answers would each have a claim on being the brief. Whichever page armed it is
    // watching it; this one just reports what is already happening.
    if (!data.prompt) {
      nativeBusy = false;
      nativePhase = data.sourceSend && data.sourceSend.state !== 'not-attempted' ? 'waiting' : '';
      pressedAt = 0;
      localError =
        data.sourceSend && data.sourceSend.state === 'dispatched-unresolved'
          ? 'The handoff instruction was already submitted here. It will finish on its own, or cancel it.'
          : 'A compaction is already under way in this chat. Wait for it, or cancel it.';
      renderControl();
      void pullActivity();
      return;
    }
    await runNativeCompaction(String(data.prompt), String(data.token || ''), forId, forEpoch, forRun);
  }

  /**
   * Resumes the reversible half of the source fence after a document or app restart.
   *
   * `not-attempted` and `attempted-unresolved` are both reversible for the same reason: both are
   * written before the composer is submitted, so neither can have left a prompt with ChatGPT.
   * `dispatched-unresolved` is the one that cannot be replayed — it is taken immediately before
   * the click, and a document that died there may or may not have sent. That state ends at
   * ChatGPT's own marker or at an explicit cancel, never at a second Send.
   */
  async function maybeResumePendingCompaction(forId = conversationId, forEpoch = epoch) {
    const source = job && job.stage === 'handoff-pending' ? job.sourceSend : null;
    if (!source || nativeBusy || localError) return;
    if (source.state !== 'not-attempted' && source.state !== 'attempted-unresolved') return;
    if (!alive || conversationId !== forId || epoch !== forEpoch || CLF_DOM.conversationId() !== forId) return;
    await startCompact(job.automatic === true);
  }

  /**
   * Brings the conversation to a standstill so its recording can be copied.
   *
   * Returns an empty string when it is standing still, or the reason it would not — which
   * the caller reports and treats as a refusal to compact at all, because a brief cut from
   * a moving conversation is worse than no brief.
   *
   * Two halves, and the second is the one that is easy to forget: stopping ChatGPT stops
   * ChatGPT. A local call the app is already running — an edit half-written to disk — does
   * not hear about it, and the handoff would describe a machine that no longer exists by
   * the time the fresh chat reads it.
   */
  async function stopAndSettle(forId = conversationId, forEpoch = epoch, forRun = nativeRun) {
    const current = () =>
      alive &&
      nativeRun === forRun &&
      conversationId === forId &&
      epoch === forEpoch &&
      CLF_DOM.conversationId() === forId;
    if (!forId || !current()) return 'This chat changed before compaction could start.';
    // INTERRUPTING — stop the turn rather than wait it out. That is the whole request, by
    // hand or automatically: this happens because the turn is long, not because it is
    // nearly done.
    if (CLF_DOM.generating()) {
      nativePhase = 'interrupting';
      renderControl();
      const stop = CLF_DOM.stopButton();
      if (stop) stop.click();
      userStopped = true;
      const stopped = await waitUntil(() => !current() || !CLF_DOM.generating(), INTERRUPT_WAIT_MS);
      if (!current()) return 'This chat changed while compaction was stopping the turn.';
      if (!stopped) return 'ChatGPT would not stop the current turn. Nothing was compacted.';
    }

    // SETTLING — bounded and fail-closed. A call that is still running at the deadline is
    // exactly the state this barrier exists to keep out of a handoff: proceeding would copy
    // a description of a machine while an edit/command is still changing that machine.
    nativePhase = 'settling';
    renderControl();
    // An app that will not say how many calls are running is a different situation from a
    // busy one, and waiting the full budget for it buys nothing: the budget ends by going
    // ahead regardless, so the only thing the silence costs is twenty seconds of a control
    // that says "Finishing local tools…" about an app that is not listening. A couple of
    // retries covers a dropped answer; past that, refuse because "could not verify zero" is
    // not the same fact as zero.
    let unanswered = 0;
    let unavailable = false;
    const settled = await waitUntil(async () => {
      if (!current()) return true;
      const count = await peekPendingTools(forId);
      if (!current()) return true;
      if (count === null) {
        if (++unanswered >= SETTLE_UNKNOWN_TRIES) {
          unavailable = true;
          return true;
        }
        return false;
      }
      unanswered = 0;
      pendingTools = count;
      return count === 0;
    }, TOOL_SETTLE_MS);
    if (!current()) return 'This chat changed while compaction was waiting for local tools.';
    if (unavailable) {
      return 'Could not verify that local tools had stopped. Nothing was compacted.';
    }
    if (!settled) {
      return 'Local tools were still running after the settle timeout. Nothing was compacted.';
    }
    return '';
  }

  /** Submits the marked source prompt after the app durably grants this exact Send. */
  async function runNativeCompaction(prompt, token, forId = conversationId, forEpoch = epoch, forRun = nativeRun) {
    const current = () =>
      alive &&
      nativeRun === forRun &&
      conversationId === forId &&
      epoch === forEpoch &&
      CLF_DOM.conversationId() === forId;
    let attemptCrossed = false;
    const automaticTicket = job && job.automatic === true;
    const abandonBeforeSend = async (why) => {
      if (!current()) return;
      nativeBusy = false;
      nativePhase = '';
      pressedAt = 0;
      localError = why;
      // A page/DOM failure is not a verdict on an automatic ticket. Keep it on the
      // continuation WAL so the next 15-minute reload can collect the same work. A manual
      // press keeps its historical immediate-abort behaviour; the user is still present and
      // can retry it without leaving an invisible job behind.
      if (!automaticTicket) {
        job = null;
        await ask({ type: 'compact', conversationId: forId, cancel: true }).catch(() => undefined);
      }
      if (!current()) return;
      renderControl();
      void pullActivity();
    };

    if (!current()) return;
    if (!prompt) return void (await abandonBeforeSend('The app did not send the handoff instruction.'));
    if (!token) return void (await abandonBeforeSend('The app did not send a compaction token, so nothing could be tracked.'));

    try {
      nativePhase = 'prompting';
      renderControl();
      const squeeze = (value) => String(value || '').replace(/\s+/g, '');
      const existing = CLF_DOM.composer();
      if (squeeze(existing?.textContent) !== squeeze(prompt) && !CLF_DOM.insertPrompt(prompt)) {
        return void (await abandonBeforeSend(
          'ChatGPT would not accept the handoff instruction — clear the message box and try again.'
        ));
      }
      await Promise.resolve();
      if (!current()) return;
      const composer = CLF_DOM.composer();
      if (!composer || squeeze(composer.textContent) !== squeeze(prompt)) {
        return void (await abandonBeforeSend(
          'The message box changed before the handoff instruction could be sent. Its draft was preserved; nothing was compacted.'
        ));
      }
      // Claiming the prompt. Nothing has been submitted under this state, and the app knows
      // that because this write happens before the composer is submitted at all — so a
      // document that dies between here and the next line leaves the prompt claimable again.
      const permit = await ask({ type: 'compact', conversationId: forId, token, sourceAttempt: true });
      if (!current()) return;
      if (!permit || permit.ok !== true || !permit.data || permit.data.allowed !== true) {
        CLF_DOM.clearPromptExact(prompt);
        nativeBusy = false;
        nativePhase = 'waiting';
        pressedAt = 0;
        localError = replyError(permit) || 'The durable handoff attempt is already owned; reconciling ChatGPT’s marked message.';
        renderControl();
        return;
      }
      // The at-most-once cut, and the last thing before the click. Exactly one document takes
      // this transition; past it the prompt may be with ChatGPT already — send() clicks first
      // and only then watches for acceptance — so no page is ever offered it again.
      const armed = await ask({ type: 'compact', conversationId: forId, token, sourceDispatch: true });
      if (!current()) return;
      if (!armed || armed.ok !== true || !armed.data || armed.data.armed !== true) {
        CLF_DOM.clearPromptExact(prompt);
        nativeBusy = false;
        nativePhase = 'waiting';
        pressedAt = 0;
        // True of both answers this can get: a refusal because another page armed it first,
        // and a lost reply. Neither one clicked anything here.
        localError = 'Nothing was submitted: this handoff was not armed. Press it again.';
        renderControl();
        return;
      }
      attemptCrossed = true;
      rememberUserSend();
      if (!(await CLF_DOM.send())) {
        CLF_DOM.clearPromptExact(prompt);
        nativeBusy = false;
        nativePhase = 'waiting';
        pressedAt = 0;
        localError = 'The send result was ambiguous. Nothing will be sent twice; cancel explicitly if ChatGPT never accepted it.';
        renderControl();
        return;
      }
      nativePhase = 'waiting';
      renderControl();
      void pullActivity();
    } catch (err) {
      const why = `Could not ask ChatGPT for a handoff: ${(err && err.message) || 'unknown error'}`;
      if (!attemptCrossed) await abandonBeforeSend(why);
      else {
        CLF_DOM.clearPromptExact(prompt);
        nativePhase = 'waiting';
        localError = `${why}. The durable attempt will not be sent twice.`;
        renderControl();
      }
    } finally {
      // Cancelled while this was composing. Nothing was armed, so nothing was sent — but the
      // instruction may already be sitting in the composer, and leaving a wall of handoff
      // machinery in somebody's message box is not what pressing Cancel asked for.
      if (nativeRun !== forRun && !attemptCrossed) CLF_DOM.clearPromptExact(prompt);
      // The guard is released either way; `nativePhase` is cleared by the app's job
      // reaching a terminal stage, or by abandon() above.
      // A stale A continuation must not unlock a new B compaction that started after an SPA
      // navigation while A was asleep above. Only the epoch that acquired this guard may
      // release it.
      if (current()) nativeBusy = false;
    }
  }

  const CONTINUATION_MARKER = /^\s*\[\[CLF-(HANDOFF|RESUME):([A-Za-z0-9_-]{16,64})\]\](?:\s|$)/;
  const continuationReconciliations = new Map();
  const reconciledContinuations = new Set();
  let continuationJournalPending = false;

  /**
   * The turn that answered a marked prompt, or null while there is not one yet.
   *
   * ChatGPT's own turn model does not put a prompt and its reply in the same turn. The marked
   * user message lands in one turn — beside nothing but a `model_editable_context` record —
   * and the assistant's prose opens the next one. So a turn holding a user message has
   * `endMessageId === null` by construction, and reading the finished answer off the marked
   * message's own turn finds one only in the shape the page never produces.
   *
   * That is the whole of the reload failure: a compaction whose page was reloaded while
   * ChatGPT was still thinking left a durable ticket in `awaiting-summary` and a finished
   * brief on screen that no pass could ever capture, so no chat was ever opened.
   *
   * The prompt's own turn is still checked first, because a build (or a fixture) that does
   * group them must keep working. Otherwise the answer is the next turn along — and a later
   * *user* message means the reply this prompt opened is not on screen, which fails closed
   * rather than adopting somebody else's answer as the brief.
   */
  function answerTurnFor(turns, index) {
    const turn = turns[index];
    if (turn.endMessageId) return turn;
    for (let at = index + 1; at < turns.length; at++) {
      const next = turns[at];
      const messages = next.messages || [];
      if (messages.some((message) => message.role === 'user')) return null;
      if (messages.some((message) => message.role === 'assistant') || (next.calls || []).length > 0) return next;
    }
    return null;
  }

  /** Finds a unique ChatGPT-authored marked user message and the exact turn it opened. */
  function markedContinuationTurns() {
    const found = new Map();
    const turns = [...fiberTurns.values()];
    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index];
      for (const message of turn.messages || []) {
        if (message.role !== 'user' || message.stable !== true) continue;
        const match = String(message.rawText || '').match(CONTINUATION_MARKER);
        if (!match) continue;
        const key = `${match[1]}:${match[2]}`;
        const marked = {
          kind: match[1],
          token: match[2],
          turn,
          answer: answerTurnFor(turns, index),
          messageId: message.rawMessageId || message.messageId
        };
        found.set(key, found.has(key) ? null : marked);
      }
    }
    return [...found.entries()].filter(([, marked]) => marked && marked.messageId);
  }

  /**
   * Advances one continuation solely from durable app state and ChatGPT's stable message ids.
   * This runs before ordinary page journaling so a marked replacement commits its rebind before
   * the recorder could create a shadow session for that same conversation.
   */
  async function reconcileContinuationMarker(key, marked) {
    if (!conversationId || CLF_DOM.conversationId() !== conversationId) return false;
    if (marked.kind === 'RESUME') {
      continuationJournalPending = true;
      const reply = await ask({
        type: 'compact',
        conversationId,
        token: marked.token,
        destinationMessageId: marked.messageId
      });
      if (!reply || reply.ok !== true) return false;
      if (reply.data && typeof reply.data.commandId === 'string') {
        rememberResumeGoalPending(conversationId, reply.data.commandId);
      }
      continuationJournalPending = false;
      commandJournalGate = false;
      void flush();
      return true;
    }

    const bound = await ask({
      type: 'compact',
      conversationId,
      token: marked.token,
      sourceMessageId: marked.messageId
    });
    if (!bound || bound.ok !== true) return false;
    // The answer turn, not the prompt's — see answerTurnFor. Its calls are the ones that have
    // to be finished, too: a brief cut while the compaction turn is still running a tool
    // describes a machine that is still changing.
    const answer = marked.answer;
    if (!answer) return false;
    const terminalId = answer.endMessageId;
    if (!terminalId || (answer.calls || []).some((call) => !call || call.answered !== true)) return false;
    const terminal = (answer.messages || []).find(
      (message) =>
        message.role === 'assistant' &&
        message.stable === true &&
        (message.rawMessageId === terminalId || message.messageId === terminalId)
    );
    const summary = String(terminal?.rawText || '').trim();
    if (!summary) return false;
    const pending = await peekPendingTools();
    if (pending !== 0 || !conversationId || CLF_DOM.conversationId() !== conversationId) return false;
    nativePhase = 'delivering';
    renderControl();
    const delivered = await ask({ type: 'compact', conversationId, token: marked.token, summary });
    if (!delivered || delivered.ok !== true) return false;
    if (delivered.data && delivered.data.job) job = delivered.data.job;
    nativePhase = '';
    localError = '';
    renderControl();
    return true;
  }

  function reconcileContinuationMarkers(markedTurns = markedContinuationTurns()) {
    if (markedTurns.length === 0) return null;
    return (async () => {
      for (const [key, marked] of markedTurns) {
        if (reconciledContinuations.has(key) || continuationReconciliations.has(key)) continue;
        const work = reconcileContinuationMarker(key, marked)
          .then((done) => {
            if (done) reconciledContinuations.add(key);
          })
          .finally(() => continuationReconciliations.delete(key));
        continuationReconciliations.set(key, work);
        await work;
      }
    })();
  }

  /**
   * Everything this generation has written so far, re-read rather than remembered.
   *
   * The snapshot `finishGeneration` hands over is a set of DOM nodes, and ChatGPT can
   * remount the section it was writing into while it is still writing. That freezes the
   * snapshot at whatever it held at the remount, which would read as a brief that has
   * stopped growing. The transcript's newest assistant answer is the same answer when it
   * still begins with everything already read; nothing else on screen can satisfy that, so
   * the prefix is the identity proof and no separate id is needed.
   *
   * Never shrinks. A section torn down after the answer was complete would otherwise read
   * as the brief being retracted, and a shorter text is never the better evidence.
   */
  function briefSoFar(ended, known) {
    const held = finalAnswerText(ended);
    if (held.length > known.length) return held;
    const turns = CLF_DOM.turns();
    const latest = turns.length > 0 ? finalAnswerText(turns[turns.length - 1]) : '';
    if (known && latest.length > known.length && latest.startsWith(known)) return latest;
    return held.length >= known.length ? held : known;
  }

  /**
   * One reading of everything about this turn that moves while ChatGPT is still working.
   *
   * Prose is not the only thing a turn produces, and during the phase that caused all of this
   * it is the one thing that does *not* move: the model had written 28 characters and spent
   * the next seven minutes making tool calls. Watching the text alone would have found it
   * perfectly stable and handed over those 28 characters, so the tool rail is read too — how
   * many blocks the turn has, and how much each of them currently renders. A call starting, a
   * result streaming in, a block finishing: each of them changes this string.
   *
   * Read from the live transcript as well as from `ended`, because a remount detaches the
   * snapshot's nodes and a detached node stops changing for the least interesting reason.
   */
  function briefActivityMark(ended) {
    const turns = CLF_DOM.turns();
    const live = turns.length > 0 ? turns[turns.length - 1] : null;
    const seen = [];
    for (const turn of live && (!ended || live.node !== ended.node) ? [ended, live] : [ended]) {
      if (!turn) continue;
      const blocks = CLF_DOM.toolBlocks(turn);
      seen.push(blocks.length);
      for (const block of blocks) seen.push((block.textContent || '').length);
    }
    return seen.join(',');
  }

  // ---------------------------------------------------------------- goal loop

  /**
   * How long everything about a finished turn has to stay still before the goal loop
   * believes it.
   *
   * The same four-signal settling rule the page uses elsewhere. A goal reply that fires early
   * hands over half a brief, and a goal reply that fires early types "what about the tests"
   * into a chat that is still in the middle of writing them, which the model then answers as
   * if it were a correction. A turn that really did finish pays this once.
   *
   * Eight seconds is small beside the provider request it precedes, but long enough to reject
   * the page's short Stop-button flickers.
   */
  const GOAL_STABLE_MS = 8_000;
  /** How often the settling turn is re-read. */
  const GOAL_POLL_MS = 1_000;
  /** The ceiling on watching one turn settle before giving up on it quietly. */
  const GOAL_WATCH_MS = 5 * 60_000;
  /** How long a ready draft waits for a composer somebody else is using. */
  const GOAL_TYPING_WINDOW_MS = 2 * 60_000;
  /**
   * How long the loop waits before asking again about a turn whose draft failed.
   *
   * Long enough that a provider outage costs one small request every quarter minute rather
   * than a storm, short enough that a passing error is not felt. There is deliberately no
   * attempt limit: the loop is finished when the model answers, and until then the only
   * things that end it are the ones that end it anyway — Goal switched off, the user typing,
   * a new generation, this chat left behind.
   */
  const GOAL_RETRY_MS = 15_000;

  /** The turn endings worth writing a next message about. See noteGoalTurn for the rest. */
  // Goal answers a finished, non-partial reply and nothing else: `completed` carries Fiber's
  // `end_turn` bit, `stopped` is the user's own decision, and interrupted/failed/stalled/unknown
  // are turns with no final answer to continue from — those belong to recovery, not to Goal.
  const GOAL_CONTINUABLE = new Set(['completed']);

  /**
   * Browser-local terminal shape only. Goal config/key intentionally do not participate:
   * those are app authority and may arrive after a one-second answer has already ended.
   */
  function goalTerminalCandidate(outcome, localTurnId) {
    return Boolean(
      localTurnId &&
        GOAL_CONTINUABLE.has(outcome) &&
        !nativeBusy &&
        !(job && job.busy) &&
        bootstrap !== 'worker'
    );
  }

  /** The goal this chat is being driven towards, '' when it has none. */
  function currentObjective() {
    return goalConfig && typeof goalConfig.objective === 'string' ? goalConfig.objective : '';
  }

  /** Whether the goal loop could act in this chat at all, before any turn is considered. */
  function goalUsable() {
    return Boolean(
      conversationId &&
        goalConfig &&
        // Either the standing switch, or this chat's own goal — unless this chat has moved its
        // own switch, in which case that switch is the whole answer and Off means off. The app
        // applies the same rule to the request itself (goalArmedFor), and reports no goal at
        // all for a chat the loop may not drive.
        (goalConfig.enabled === true || (goalConfig.own !== true && currentObjective() !== '')) &&
        goalConfig.hasKey === true &&
        // A worker chat is already being driven — by the prime agent, through the agents
        // tool. A second author typing into it is two conversations in one composer.
        bootstrap !== 'worker'
    );
  }

  /**
   * A turn just ended. Decide whether the goal loop wants to answer it.
   *
   * Called from finishGeneration with that generation's own section and outcome, which is the
   * only place both are still known. Everything refused here is refused for a reason that
   * does not change a second later, so nothing retries.
   */
  function noteGoalTurn(ended, outcome, endedTurnId) {
    if (!endedTurnId || !goalUsable()) return;
    // Only a finished, non-partial answer. See GOAL_CONTINUABLE for why every other outcome —
    // including `interrupted` — belongs to recovery rather than to this loop.
    if (!GOAL_CONTINUABLE.has(outcome)) return;
    // A compaction owns this turn: its answer is the brief, not a message to reply to, and
    // the chat is about to be replaced anyway.
    if (nativeBusy || (job && job.busy)) return;
    // One draft per generation, and this is the near half of that rule; the app holds the
    // other half against a retried request. See /goal/draft.
    if (goalTurnId === endedTurnId) return;
    if (goalBusy) return;
    goalTurnId = endedTurnId;
    setGoalPhase('');
    // Goal is now authoritative for this exact completed turn. Raising the sender tab is a
    // courtesy after that decision, never an input to it: hidden tabs take this same path and a
    // failed focus request must not stop the draft. Claim goalTurnId first so the visibility
    // change caused by focusing cannot re-enter this turn and request/focus it twice.
    void ask({ type: 'goal_focus', conversationId, turnId: endedTurnId }).catch(() => undefined);
    void watchGoalTurn(ended, endedTurnId);
  }

  /**
   * Recovers exactly one resume-caused answer that the recorder never saw while it was live.
   *
   * Chrome may suspend/throttle a hidden replacement tab long enough for React to mount Stop,
   * render the whole first answer and remove Stop before this isolated world runs another
   * observation. There is then no local `turn_start`, so the ordinary `finishGeneration()` →
   * `noteGoalTurn()` edge can never happen. The resume command itself is the missing provenance:
   * this document sent the only user message in a fresh chat, and the app ACKed the continuation
   * into that exact conversation. That lets us recover this one new answer without ever treating
   * an arbitrary historical answer as fresh work.
   *
   * Goal policy is evaluated only after `/activity` has returned B's post-commit config. If Goal
   * was not usable at that boundary, consume the hint just like an ordinarily observed turn
   * would have been skipped; enabling it later must not replay history.
   */
  function maybeRecoverResumeGoalTurn() {
    const pending = resumeGoalPending;
    if (!pending || !conversationId) return;
    if (pending.conversationId !== conversationId) {
      // A concrete navigation away ends the one-tab provenance. Do not carry B's first answer
      // recovery into whichever chat happens to be opened next.
      if (CLF_DOM.conversationId() && CLF_DOM.conversationId() !== pending.conversationId) clearResumeGoalPending();
      return;
    }
    // A normally observed generation already entered Goal, or a draft restored from the app
    // proves another page-side trigger got there first. Either way the recovery hint is spent.
    if (goalTurnId || goalDraft) return void clearResumeGoalPending();
    // Null means B's post-commit policy has not arrived yet. That is the exact race this helper
    // exists to bridge, so keep the hint rather than deciding from stale/default settings.
    if (!goalConfig) return;
    if (!goalUsable()) return void clearResumeGoalPending();
    if (goalBusy || generating || CLF_DOM.generating() || nativeBusy || (job && job.busy)) return;

    // The resume bootstrap is the only user turn we are entitled to reason from. If somebody
    // manually continued before recovery ran, the conversation has moved on and the old first
    // answer must not generate another user message behind theirs.
    const users = CLF_DOM.messages().filter(
      (message) => message && message.role === 'user' && !retiredMessages.has(message.id) && !isStale(message.node)
    );
    if (users.length > 1) return void clearResumeGoalPending();
    if (users.length !== 1) return;

    const turns = CLF_DOM.turns();
    const ended = pending.turnId
      ? [...turns].reverse().find((candidate) => localGenerationOf(candidate) === pending.turnId) || null
      : currentAssistantTurn(turns);
    if (!ended || !finalAnswerText(ended).trim()) return;
    let result = endOutcome(ended);
    if (result.outcome === 'unknown') {
      // For a tracked turn refreshFiber() closes directly from endMessageId. This missed turn
      // has no local generation to close, so read the same exact terminal fact here instead.
      const fiber = fiberTurnFor(ended);
      if (fiber?.endMessageId && !(fiber.calls || []).some((call) => !call || call.answered !== true)) {
        result = { outcome: 'completed' };
      }
    }
    if (result.outcome === 'unknown') return;
    if (!GOAL_CONTINUABLE.has(result.outcome)) return void clearResumeGoalPending();

    // Stable across a content-script reload, and deliberately a local generation-style id rather
    // than a website message id. The app's /goal/draft idempotency therefore sees one turn even
    // if the activity wake/foreground event is delivered twice.
    const recoveredTurnId = pending.turnId || `g-resume-${pending.commandId}`.slice(0, 200);
    noteGoalTurn(ended, result.outcome, recoveredTurnId);
    // noteGoalTurn synchronously claims goalTurnId before its first await. Persist the spent
    // provenance immediately so a reload cannot synthesize a second id/request for this answer.
    if (goalTurnId === recoveredTurnId) clearResumeGoalPending();
  }

  /**
   * Reattaches Goal to the app's durable stable-reply cursor after refresh/config races.
   *
   * No transcript scan occurs here. The app has already accepted one exact final assistant
   * message under the Goal policy that was live at that moment; this document only waits for
   * ChatGPT's composer to be truly idle, then resumes that same turn id.
   */
  function maybeRecoverDurableGoalTurn() {
    const pending = goalConfig && goalConfig.pending;
    if (!pending || !pending.replyId || !pending.turnId || !conversationId) return;
    if (!goalUsable() || goalBusy || goalDraft || generating || CLF_DOM.generating()) return;
    if (nativeBusy || (job && job.busy)) return;
    const acceptedAt = Number(pending.acceptedAt);
    const ticketId = `${pending.replyId}:${Number.isFinite(acceptedAt) && acceptedAt > 0 ? acceptedAt : pending.eventSeq}`;
    if (goalTicketId === ticketId) return;
    goalTicketId = ticketId;
    goalTurnId = pending.turnId;
    setGoalPhase('');
    const forId = conversationId;
    const forEpoch = epoch;
    const forTurn = pending.turnId;
    const current = () =>
      alive &&
      conversationId === forId &&
      epoch === forEpoch &&
      goalTurnId === forTurn;
    void requestGoalDraft(forTurn, current, true);
  }

  /**
   * Waits for the finished turn to be finished, then asks the app for the next user message.
   *
   * `turn_end` is where this starts, not what it acts on. The stop control flickers between
   * phases of one answer, prose stops growing while
   * a three-minute build runs, and a tool rail goes still both between calls and during one.
   * So the answer text, the tool rail, the stop control and the app's own count of running
   * local calls all have to agree, and hold agreeing, before a word is typed into anybody's
   * chat. An app that cannot be asked counts as busy, exactly as it does for a brief.
   *
   * A new generation opening is not a delay — it is the answer: the conversation moved on by
   * itself, and the message this loop was about to write is about a turn that is no longer
   * the last one.
   */
  async function watchGoalTurn(ended, forTurn) {
    goalBusy = true;
    setGoalPhase('settling');
    const forId = conversationId;
    const forEpoch = epoch;
    const current = () => alive && conversationId === forId && epoch === forEpoch && goalTurnId === forTurn;
    try {
      const deadline = Date.now() + GOAL_WATCH_MS;
      let text = finalAnswerText(ended);
      let activity = briefActivityMark(ended);
      let stableSince = Date.now();
      while (Date.now() < deadline) {
        await sleep(GOAL_POLL_MS);
        if (!current()) return;
        // Somebody — the user, or a turn ChatGPT started on its own — is talking again.
        if (generating) return void setGoalPhase('');
        if (nativeBusy || (job && job.busy)) return void setGoalPhase('');
        if (!goalUsable()) return void setGoalPhase('');
        const nextText = briefSoFar(ended, text);
        const nextActivity = briefActivityMark(ended);
        const pending = await peekPendingTools();
        if (!current()) return;
        const busy = CLF_DOM.generating() || pending === null || pending > 0;
        if (busy || nextText !== text || nextActivity !== activity) {
          text = nextText;
          activity = nextActivity;
          stableSince = Date.now();
          continue;
        }
        if (Date.now() - stableSince < GOAL_STABLE_MS) continue;
        // An answer with nothing in it is not an answer to continue from, and asking a model
        // to write the user's next message about it would be asking it to invent one.
        // Two dead ends, and until now neither left a mark: the panel simply went away,
        // which from outside is indistinguishable from a loop that never ran at all. That is
        // most of "auto goal didn't fire" — it may well have fired, looked at this turn and
        // declined it without ever saying so. The three exits above stay silent because each
        // of them means the conversation moved on and there is nothing to report; these two
        // mean the loop gave up on a turn it was watching, and now say which.
        if (!text.trim()) {
          setGoalPhase('settling', 'that answer had no text to continue from');
          return;
        }
        await requestGoalDraft(forTurn, current);
        return;
      }
      setGoalPhase('settling', 'the answer never stopped changing, so nothing was written');
    } finally {
      goalBusy = false;
      renderControl();
      injectStage();
    }
  }

  /**
   * Asks again about a turn whose draft failed for a reason another request could answer.
   *
   * Deliberately re-entrant through nothing: it holds the same `goalTurnId` claim and re-reads
   * the same permissions `watchGoalTurn` reads, so a Goal switched off, a user typing, a fresh
   * generation or a move to another chat ends the loop here for the same reasons it would have
   * refused to start it.
   *
   * **The wait is taken outside the lock.** `goalBusy` is the one thing that makes
   * `noteGoalTurn` refuse a finished turn, and holding it across a fifteen-second sleep makes
   * every turn that finishes inside that window invisible — with no later edge to recover it,
   * because the only edge there is was the turn ending. A single retryable draft failure would
   * silently cost the next real answer its Goal run. The claim on this turn is `goalTurnId`,
   * which is what stops two retries of the same turn, and the lock is taken only for the
   * request it actually guards.
   */
  async function retryGoalDraft(forTurn) {
    if (goalTurnId !== forTurn) return;
    const forId = conversationId;
    const forEpoch = epoch;
    const current = () => alive && conversationId === forId && epoch === forEpoch && goalTurnId === forTurn;
    await sleep(GOAL_RETRY_MS);
    // A turn that finished during the wait has taken the claim, and this retry is about an
    // older one. It says nothing and touches nothing: the phase on screen is that turn's now.
    if (!current()) return;
    // Something else holds the loop while this turn is still the claimed one — a compaction
    // brief, say. It will not be interrupted for a retry.
    if (goalBusy) return;
    // The conversation moved on while we waited: whatever this loop was going to write is
    // about a turn that is no longer the last one, which is an answer of its own.
    if (generating || CLF_DOM.generating() || nativeBusy || (job && job.busy)) return void setGoalPhase('');
    if (!goalUsable()) return void setGoalPhase('');
    goalBusy = true;
    try {
      await requestGoalDraft(forTurn, current);
    } finally {
      goalBusy = false;
      renderControl();
      injectStage();
    }
  }

  /** Asks the app to draft the next user message. The answer arrives on the activity feed. */
  async function requestGoalDraft(forTurn, current, terminalRequired = false) {
    goalTypingSince = 0;
    setGoalPhase('requesting');
    const reply = await ask({
      type: 'goal_draft',
      conversationId,
      turnId: forTurn,
      ...(terminalRequired ? { terminalRequired: true } : {})
    });
    if (!current()) return;
    if (!reply || reply.ok !== true) {
      // The phase is kept rather than collapsed into `failed`: it names the step that
      // stopped, so the bar draws the run where it ended instead of back at the beginning.
      setGoalPhase('requesting', replyError(reply) || 'the app did not answer');
      // The app never heard the question, so nothing durable moved and the turn is still owed
      // its answer. Release this document's claim on it: holding the claim after a dropped
      // message parked the obligation until the next reload, which is the one thing a
      // transport failure must never be able to do to it. maybeRecoverDurableGoalTurn picks
      // the same durable pending row up again on the next pull.
      if (goalTurnId === forTurn) {
        goalTurnId = null;
        // The app still holds this exact pending episode. Releasing both parts of the claim
        // lets the next authoritative activity snapshot retry it without requiring a reload.
        goalTicketId = null;
      }
      return;
    }
    // From here the draft lives on /activity: its stage, its streaming text and — once — the
    // message to type. See maybeSendGoalReply, which runs on every pull.
    goalDraft = (reply.data && reply.data.goal) || null;
    setGoalPhase('drafting');
    void pullActivity();
  }

  /**
   * Types a ready draft into the composer and sends it, once.
   *
   * Called from the activity pull, because that is where the draft arrives. Every exit
   * acknowledges the draft: a message that was sent and one that will never be sent are the
   * same fact to the app — this draft is spent — and the difference between them is what the
   * user is told, not what the app holds.
   *
   * The composer belongs to the user. `insertPrompt` refuses one that already holds text, so
   * a half-written message is never overwritten; this waits a while for it to be free and
   * then gives up honestly rather than typing over somebody mid-sentence.
   */
  async function maybeSendGoalReply() {
    const draft = goalDraft;
    if (!draft || !conversationId || draft.conversationId !== conversationId) return;
    if (goalBusy) return;
    if (goalWasSpent(conversationId, draft.token)) {
      // The message already crossed the browser's irreversible boundary. A lost ACK may make
      // the app re-offer it, including after a content-script reload; only retry the receipt.
      goalDraft = null;
      await ask({ type: 'goal_ack', conversationId, token: draft.token }).catch(() => undefined);
      return;
    }
    if (!goalUsable()) {
      // Settings are live. Turning Goal Mode off (or removing its key) while OpenRouter is
      // drafting must revoke permission to type the result, even if that result becomes ready
      // on the very poll that carries the new setting.
      goalDraft = null;
      setGoalPhase('');
      await ask({ type: 'goal_ack', conversationId, token: draft.token }).catch(() => undefined);
      return;
    }
    if (draft.stage === 'failed') {
      goalDraft = null;
      const why = draft.error || 'OpenRouter did not answer';
      const pending = goalConfig && goalConfig.pending;
      let retrying = draft.retryable === true && goalTurnId === draft.turnId;
      // A reload loses the document-local claim while the app keeps both the failed attempt
      // and the durable obligation it was answering. Only that exact durable turn may restore
      // the claim: trusting an arbitrary old draft would let a stale tab answer after the chat
      // moved on. Active ChatGPT/native work is newer evidence and wins.
      if (
        !retrying &&
        draft.retryable === true &&
        !goalTurnId &&
        pending &&
        pending.turnId === draft.turnId &&
        !generating &&
        !CLF_DOM.generating() &&
        !nativeBusy &&
        !(job && job.busy)
      ) {
        goalTurnId = draft.turnId;
        retrying = true;
      }
      setGoalPhase(retrying ? 'retrying' : 'drafting', why);
      await ask({ type: 'goal_ack', conversationId, token: draft.token }).catch(() => undefined);
      // The two answers that end a Goal run are `[no reply]` and words to type. This is
      // neither, so the turn is still owed one and the loop keeps its claim on it — with the
      // reason on screen in the meantime, which is the only thing a failure was ever good for.
      if (retrying) void retryGoalDraft(draft.turnId);
      return;
    }
    if (draft.stage === 'no-reply') {
      // The model read the conversation and decided the thing the user asked for is done.
      // That is the loop ending the way it is meant to, not a failure.
      goalDraft = null;
      setGoalPhase('done');
      await ask({ type: 'goal_ack', conversationId, token: draft.token }).catch(() => undefined);
      return;
    }
    if (draft.stage !== 'ready' || !draft.reply) return;
    // A turn started while the draft was being written — the user typed, or ChatGPT began
    // something of its own. The draft is about a conversation that has moved on.
    if (generating || CLF_DOM.generating() || nativeBusy || (job && job.busy)) {
      goalDraft = null;
      setGoalPhase('');
      await ask({ type: 'goal_ack', conversationId, token: draft.token }).catch(() => undefined);
      return;
    }
    goalBusy = true;
    try {
      if (goalTypingSince === 0) goalTypingSince = Date.now();
      setGoalPhase('sending');
      if (!CLF_DOM.insertPrompt(draft.reply)) {
        // Somebody is writing in it. Keep the draft and try again on the next pull, until
        // the window runs out — at which point the message is dropped rather than queued
        // behind a draft the user may still be working on.
        if (Date.now() - goalTypingSince < GOAL_TYPING_WINDOW_MS) return;
        goalDraft = null;
        setGoalPhase('sending', 'the message box was in use, so nothing was sent');
        await ask({ type: 'goal_ack', conversationId, token: draft.token }).catch(() => undefined);
        return;
      }
      await sleep(200);
      rememberUserSend();
      const sent = await CLF_DOM.send();
      goalDraft = null;
      if (!sent) {
        await ask({ type: 'goal_ack', conversationId, token: draft.token }).catch(() => undefined);
        setGoalPhase('sending', 'ChatGPT would not send the message');
        return;
      }
      // Sending is the irreversible step. Record it before the fallible ACK hop so a lost
      // receipt can never turn the same ready draft into a second user message.
      rememberGoalSpent(conversationId, draft.token);
      await ask({ type: 'goal_ack', conversationId, token: draft.token }).catch(() => undefined);
      setGoalPhase('');
    } finally {
      goalBusy = false;
      // Only once the draft is spent. This marks when *this draft* first found the composer
      // in use, and the retry path above measures its two-minute patience against it — so
      // clearing it on every pull, as this used to, restarted the window each time and the
      // give-up could never arrive. A draft that is still waiting keeps its start time.
      if (!goalDraft) goalTypingSince = 0;
      renderControl();
      injectStage();
    }
  }

  /** How long to wait for ChatGPT to actually stop after the stop button is pressed. */
  const INTERRUPT_WAIT_MS = 15_000;
  /**
   * How long to wait for local tool calls and their recorder tail to settle before refusing.
   *
   * The app deliberately keeps an unattributed completed call visible as pending while its
   * request-id evidence can still land. That recorder grace is 15 seconds in production.
   * This browser-side deadline therefore must be comfortably larger than that grace or an
   * otherwise-finished call can deterministically turn a harmless attribution delay into a
   * refused compaction. Thirty seconds leaves the recorder its full window plus durable-write
   * headroom without making a genuinely stuck local call wait indefinitely.
   */
  const TOOL_SETTLE_MS = 30_000;
  /** How many silent answers about pending calls to sit through before refusing. */
  const SETTLE_UNKNOWN_TRIES = 3;

  /**
   * How many local calls are running right now, asked fresh.
   *
   * The stored `pendingTools` is only refreshed by the activity loop, which ticks on its
   * own schedule — far too coarse to wait on, and stalled entirely while a pull is already
   * in flight. This asks the same endpoint from the cursor the page already holds, which
   * returns whatever it would return anyway and advances nothing, and reads one number off
   * the answer. Null means the app could not be asked, which is not the same as zero.
   */
  async function peekPendingTools(forId = conversationId) {
    const reply = await ask({ type: 'activity', conversationId: forId, since });
    if (!reply || reply.ok !== true || !reply.data) return null;
    const count = Number(reply.data.pendingTools);
    return Number.isFinite(count) && count >= 0 ? count : null;
  }

  /** Polls a condition. Resolves true when it holds, false when the budget runs out. */
  async function waitUntil(test, budgetMs) {
    const until = Date.now() + budgetMs;
    for (;;) {
      let held = false;
      try {
        held = (await test()) === true;
      } catch {
        held = false;
      }
      if (held) return true;
      if (Date.now() >= until) return false;
      await sleep(250);
    }
  }

  async function cancelCompact() {
    const forId = conversationId;
    const forEpoch = epoch;
    const current = () =>
      alive &&
      conversationId === forId &&
      epoch === forEpoch &&
      CLF_DOM.conversationId() === forId;
    if (!forId || !current()) return;
    // Cancellation is one-way in the durable continuation. A later marker observation cannot
    // revive an aborted token.
    //
    // Retire the live run first, and before the await: a press that is still stopping the turn
    // or waiting for local tools must not come back from that with a prompt to type. It would
    // be typing it into a transaction the next line is about to abort, which the app can only
    // read as a fresh continuation — so the one thing Cancel is for would have started another.
    nativeRun++;
    pressedAt = 0;
    nativeBusy = false;
    nativePhase = '';
    const reply = await ask({ type: 'compact', conversationId: forId, cancel: true });
    if (!current()) return;
    if (reply && reply.ok === true && reply.data && reply.data.job) job = reply.data.job;
    else if (!reply || reply.ok !== true) localError = replyError(reply) || 'Could not cancel compaction.';
    renderControl();
    void pullActivity();
  }

  function replyError(reply) {
    if (!reply) return '';
    const data = reply.data || {};
    if (data.message) return String(data.message).slice(0, 160);
    if (data.error === 'session_not_recorded') return 'This chat has no recorded local session yet.';
    if (data.error === 'compaction_running') return 'Another chat is compacting right now.';
    if (data.error === 'turn_still_generating') return 'Wait for this ChatGPT turn to finish first.';
    if (data.error) return String(data.error).slice(0, 160);
    if (reply.error === 'app_not_found') return 'Chat On Steroids is not running on this PC.';
    return reply.error ? String(reply.error).slice(0, 160) : '';
  }

  // -------------------------------------------------------------- commands

  async function checkStatus() {
    const reply = await ask({ type: 'status' });
    if (reply) {
      status = {
        connected: reply.connected === true,
        paired: reply.paired === true,
        disconnected: reply.disconnected === true
      };
    }
    renderStreams();
    renderControl();
  }

  /**
   * The conversation this document was opened at, read once before ChatGPT rewrites anything.
   *
   * Null for the ordinary case — a chat with no id of its own yet — and set only when the app
   * pointed the browser at one exact conversation, which it does for exactly one reason: waking
   * a sleeping worker in the chat it already has. Read at script start rather than at send time
   * so that the SPA navigating this document afterwards cannot turn a stale marker into
   * permission to type into whatever chat the user ended up on.
   *
   * Through the canonical parser, because the app builds that url as `/c/<id>` and ChatGPT
   * redirects a Project chat to `/g/<project>/c/<id>` before this script ever runs. Read with a
   * `/c/` test of its own, the wake tab named no conversation and every revival into a Project
   * failed the target fence instead of typing into the worker's own chat.
   */
  const OPENED_CONVERSATION = CLF_DOM.conversationFromPath(location.pathname);

  /**
   * The command id this page was opened for, from ?clf= or #clf=.
   *
   * Both, because ChatGPT's router rewrites the query on its own and the fragment
   * survives that. It is a correlation id and nothing else: redeeming it needs the bearer
   * token that only the service worker holds, so a copied link is inert.
   */
  function markerId() {
    try {
      const fromQuery = new URLSearchParams(location.search).get('clf');
      if (fromQuery) return fromQuery;
      const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
      return new URLSearchParams(hash).get('clf');
    } catch {
      return null;
    }
  }

  /**
   * Picks up the instruction this tab was opened for. Once per document, and that is all.
   *
   * On a conversation that does not exist yet — a worker's own chat, or the replacement for
   * a compacted session — or, for a revival, in the one existing chat the app named when it
   * opened this page and nowhere else. A marked fresh worker/resume page may replace ChatGPT's
   * restored New Chat draft; an exact-chat revival still waits for a genuinely free composer.
   * No command ever types in a chat it did not name.
   *
   * One page, one marker, one attempt, and every exit reports its outcome. This used to be
   * three in-page attempts driven off the one-second observation tick, with a periodic
   * `working` ack renewing the app's lease in between; between them those turned one press
   * into an open-ended background process that could still be typing into a tab minutes
   * after the user had given up on it. The transaction is now flat: redeem the marker, wait
   * for the composer, insert, send, report which conversation it became. Anything that goes
   * wrong is reported as a failure straight away, and the app ends the worker slot or the
   * continuation rather than arranging for it to happen again somewhere else — which is
   * what the user can act on, and what nothing else in this file has to know about.
   *
   * A message this tab actually sent is reported as sent even if the conversation id never
   * turns up, because the alternative would be typing the same instruction twice.
  */
  const commandsHandled = new Set();
  /**
   * The current page-side command attempt, before or after the durable bridge ownership cut.
   *
   * A recovered deferred marker is intentionally weaker than a fresh app wake. It may wait here
   * for a final answer, durable recorder flush, or an existing user draft without owning the
   * bridge command yet. A later app wake for the same worker must be able to replace that inert
   * waiter; once redeem starts, however, ownership may already be changing durably and no local
   * preemption is safe.
   */
  let commandAttempt = null;
  /**
   * Existing-chat revivals must not race recorder recovery.
   *
   * On a reload the Stop control can be missing for one render even though the app still has
   * this turn open. `resumeOpenTurn()` restores that durable fact before the first observation;
   * only after that boot handshake is complete may a revival call the page idle.
   */
  let commandReadinessInitialized = false;
  const commandReadinessWaiters = new Set();

  function notifyCommandReadiness() {
    for (const check of [...commandReadinessWaiters]) {
      try {
        check();
      } catch {
        // A readiness waiter is advisory until it owns the bridge lease. One broken listener
        // must never disturb observation/recording of the turn whose completion it is waiting on.
      }
    }
  }

  /**
   * The one first answer a Compact & Resume bootstrap can make before this hidden page ever
   * observes a live generation.
   *
   * This is deliberately page provenance, not "the newest finished answer" recovery. Merely
   * opening an old resumed conversation must never restart Goal from transcript history. The
   * marker exists only after this document itself sent a resume bootstrap and the app ACKed the
   * A→B continuation commit. sessionStorage keeps that proof across a content-script reload in
   * the same tab without turning it into durable chat state that could fire days later.
   */
  const RESUME_GOAL_STORAGE = 'clf-resume-goal-v1';
  let resumeGoalPending = null;
  try {
    const restored = JSON.parse(sessionStorage.getItem(RESUME_GOAL_STORAGE) || 'null');
    if (
      restored &&
      typeof restored === 'object' &&
      typeof restored.conversationId === 'string' &&
      restored.conversationId.length > 0 &&
      restored.conversationId.length <= 256 &&
      typeof restored.commandId === 'string' &&
      restored.commandId.length > 0 &&
      restored.commandId.length <= 200
    ) {
      resumeGoalPending = {
        conversationId: restored.conversationId,
        commandId: restored.commandId,
        turnId: typeof restored.turnId === 'string' && restored.turnId ? restored.turnId.slice(0, 200) : null
      };
    }
  } catch {
    // A corrupt/blocked entry loses only this one recovery hint. Ordinary observed turns still
    // drive Goal exactly as before.
  }

  function clearResumeGoalPending() {
    resumeGoalPending = null;
    try {
      sessionStorage.removeItem(RESUME_GOAL_STORAGE);
    } catch {
      // In-memory ownership is enough for the live document.
    }
  }

  function persistResumeGoalPending() {
    try {
      sessionStorage.setItem(RESUME_GOAL_STORAGE, JSON.stringify(resumeGoalPending));
    } catch {
      // The live document can still recover the turn; reload recovery is best effort.
    }
  }

  function rememberResumeGoalPending(conversation, commandId) {
    resumeGoalPending = { conversationId: conversation, commandId, turnId: null };
    persistResumeGoalPending();
    // The generation this provenance is about may already be open: a turn now begins the
    // moment the bootstrap message is observed, which can land before the command finishes
    // redeeming. Binding only from the opener left that turn unclaimed and made the recovery
    // mint a synthetic `g-resume-<command>` id for a generation this document had watched
    // start. Both orderings reach the same binding from here.
    if (generating) bindResumeGoalTurn(turnId);
  }

  function bindResumeGoalTurn(localTurnId) {
    if (!resumeGoalPending || resumeGoalPending.conversationId !== conversationId || !localTurnId) return;
    if (resumeGoalPending.turnId && resumeGoalPending.turnId !== localTurnId) {
      // A second local generation means the conversation has already moved beyond the bootstrap
      // answer this marker was allowed to recover.
      clearResumeGoalPending();
      return;
    }
    if (!resumeGoalPending.turnId) {
      resumeGoalPending.turnId = localTurnId;
      persistResumeGoalPending();
    }
  }

  /**
   * The exact existing worker chat is genuinely safe for another user message.
   *
   * Broker terminality is intentionally absent from this predicate. `agents finish` says the
   * worker may be revived; it does not say ChatGPT has finished rendering the assistant turn
   * that contains that tool call. The recorder's conservative generation state is the latter.
   */
  function revivalSubmitReady(target) {
    if (!commandReadinessInitialized || !alive || CLF_DOM.conversationId() !== target) return false;
    if (generating || CLF_DOM.generating()) return false;
    if (pendingTools > 0 || nativeBusy || goalBusy || (job && job.busy)) return false;
    return Boolean(CLF_DOM.composerSubmitReady && CLF_DOM.composerSubmitReady());
  }

  /**
   * Waits without redeeming the per-document bridge lease and without touching the composer.
   *
   * That ordering is the durability property: if this tab reloads, the service worker restarts,
   * or the browser disappears while the final answer is still streaming, no dead RUN_ID owns the
   * command and no half-inserted revival text exists to recover. A replacement document can make
   * the same readiness proof and race for the one durable redeem later.
   */
  function waitForRevivalSubmitReady(target, attempt) {
    if (!target || attempt?.cancelled || !alive || CLF_DOM.conversationId() !== target) return Promise.resolve(false);
    return new Promise((resolve) => {
      let observer = null;
      let done = false;
      let flushingReadyBoundary = false;
      let boundaryEntries = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        commandReadinessWaiters.delete(check);
        if (observer) observer.disconnect();
        resolve(value);
      };
      const check = () => {
        if (attempt?.cancelled || !alive || CLF_DOM.conversationId() !== target) return finish(false);
        if (!revivalSubmitReady(target) || flushingReadyBoundary) return;
        // Snapshot exactly what this already-finished turn left in page custody. Later observations
        // are allowed to exist independently; they must not turn this into an unbounded "queue must
        // be globally empty" condition. Object identity is stable until the durable flush path
        // removes an entry, so this is a precise custody fence rather than a queue-length guess.
        if (!boundaryEntries) boundaryEntries = new Set(queue);
        const pendingBoundary = () => [...boundaryEntries].some((entry) => queue.includes(entry));
        if (!pendingBoundary()) return finish(true);
        flushingReadyBoundary = true;
        void (async () => {
          // One flush is capped at 200 entries. Keep draining immediately only after a proven
          // durable batch; on a non-durable/service-worker failure, leave the exact entries in
          // place and wait for a later observer/lifecycle signal to retry instead of busy-polling.
          while (
            !attempt?.cancelled &&
            alive &&
            CLF_DOM.conversationId() === target &&
            revivalSubmitReady(target) &&
            pendingBoundary()
          ) {
            const durable = await flush();
            if (!durable) break;
          }
        })()
          .then(() => {
            flushingReadyBoundary = false;
            if (attempt?.cancelled || !alive || CLF_DOM.conversationId() !== target) return finish(false);
            if (revivalSubmitReady(target) && !pendingBoundary()) finish(true);
          })
          .catch(() => {
            // A service-worker/app outage is not evidence that the chat is unsafe forever. Keep
            // the command outside the bridge lease; a later observation/lifecycle wake can retry.
            flushingReadyBoundary = false;
          });
      };
      commandReadinessWaiters.add(check);
      try {
        observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true
        });
      } catch {
        // Recorder observations still call notifyCommandReadiness(), so MutationObserver is a
        // latency optimization rather than the only path out of the wait.
      }
      check();
    });
  }

  /**
   * Establishes restart-safe browser custody of an inert revival marker before the page is
   * allowed anywhere near the bridge redeem boundary.
   *
   * `defer_revival` persists only command id + exact conversation id in extension-local storage.
   * A failed storage write is therefore a failed custody handoff, not permission to continue in
   * the current document and hope it survives. Keep retrying while this exact page remains alive;
   * no command text has been fetched and the composer is still untouched, so retry is safe.
   */
  async function waitForDeferredRevivalCustody(id, target, attempt) {
    while (!attempt?.cancelled && alive && CLF_DOM.conversationId() === target) {
      const reply = await ask({ type: 'defer_revival', id, conversationId: target });
      if (attempt?.cancelled) return false;
      if (reply && reply.ok === true && reply.deferred === true && reply.preferredElsewhere !== true) return true;
      if (attempt?.cancelled || !alive || CLF_DOM.conversationId() !== target) return false;
      await sleep(1000);
    }
    return false;
  }
  /**
   * Fresh app-opened chats do not journal their first observations until identity commits.
   *
   * For a resume, ChatGPT's marked destination message is the transaction commit that moves
   * durable session A→B. `observe()` starts in parallel with command delivery, so without this
   * gate B could flush that user message first, eagerly creating a second local session; the
   * later rebind then fails because B already has an owner. Hold the opening batch through the
   * first Fiber scan, and keep holding it while a RESUME marker is unresolved. Workers benefit
   * too: their slot binding lands before their first recorded event.
   */
  let commandJournalGate = false;

  /**
   * Waits for ChatGPT to expose a connected composer without putting bootstrap delivery
   * behind a chain of timer samples.
   *
   * The old readiness gate required `document.readyState === 'complete'` four times in a
   * row, 250 ms apart. That is unrelated to whether the composer can accept a prompt, and
   * Chrome deliberately throttles chained timers in background tabs. In practice an
   * app-opened blank chat could therefore sit there for tens of seconds before we even
   * tried to insert the handoff. DOM mutation is the event we actually care about: return
   * immediately when the composer already exists, otherwise wake the instant React mounts
   * one, with only a bounded timer as the failure deadline.
   */
  function waitForComposer(timeoutMs = 12_000) {
    const current = CLF_DOM.composer();
    if (current && current.isConnected) return Promise.resolve(current);
    return new Promise((resolve) => {
      let timer = null;
      let observer = null;
      const finish = (value) => {
        if (timer !== null) clearTimeout(timer);
        if (observer) observer.disconnect();
        resolve(value);
      };
      const check = () => {
        const composer = CLF_DOM.composer();
        if (composer && composer.isConnected) finish(composer);
      };
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      timer = setTimeout(() => finish(null), timeoutMs);
      // Close the tiny race between the first lookup and installing the observer.
      check();
    });
  }

  async function runCommand(id = markerId(), fromUrl = true, onClaim = null, options = {}) {
    // Once per command rather than once per document. A worker's tab is opened by a bootstrap
    // and then lives on, and the prime waking that worker later is a second command for the
    // same page: a document-wide latch would refuse every revival a worker ever gets.
    const source = fromUrl ? 'url' : options.deferredRecovery === true ? 'recovery' : 'handoff';
    const prior = commandAttempt;
    const maySupersede =
      Boolean(id) &&
      prior &&
      prior.id !== id &&
      prior.source === 'recovery' &&
      prior.phase === 'waiting' &&
      source !== 'recovery';
    if (maySupersede) {
      // No bridge redeem has started yet, so this is only cancellation of a browser-side waiter.
      // Wake its readiness observer immediately; its async finally block is identity-guarded and
      // cannot clear the newer attempt that takes over below.
      prior.cancelled = true;
      notifyCommandReadiness();
    }
    if (!id || (commandAttempt && !maySupersede) || commandsHandled.has(id)) {
      if (typeof onClaim === 'function') onClaim(false);
      return;
    }
    commandsHandled.add(id);
    const attempt = {
      id,
      source,
      phase: 'waiting',
      cancelled: false
    };
    commandAttempt = attempt;
    // Only a fresh worker/resume page needs the no-shadow-session journal gate: its first user
    // message creates/binds a brand-new conversation. A revival stays in the existing worker
    // session, and its *previous* assistant turn may still be finishing while this command waits.
    // Gating that existing chat would suppress exactly the final /events we need to durably close
    // the turn before the new user message is allowed through.
    const gateJournal = fromUrl && !OPENED_CONVERSATION;
    if (gateJournal) commandJournalGate = true;
    let claimReported = false;
    const reportClaim = (claimed) => {
      if (claimReported) return;
      claimReported = true;
      if (typeof onClaim === 'function') onClaim(claimed === true);
    };
    try {
      await deliverCommand(id, fromUrl, reportClaim, attempt);
    } finally {
      reportClaim(false);
      if (commandAttempt === attempt) commandAttempt = null;
      if (gateJournal && !continuationJournalPending) commandJournalGate = false;
      void flush();
    }
  }

  async function deliverCommand(id, fromUrl = true, reportClaim = () => undefined, attempt = null) {
    // Which conversation, if any, this delivery is entitled to type into.
    //
    // For a marker in this document's own URL it is the one the app opened the page at, read
    // before ChatGPT could rewrite anything: `/c/<id>` for a revival, nothing at all for the
    // two commands that open a chat which does not exist yet. A marker that turns up in an
    // existing chat with no conversation in its own opening URL is neither of those — a stale
    // marker carried in by history, a back button or a copied link — and is refused before the
    // redeem, so it neither types into somebody's chat nor claims a command a genuinely fresh
    // tab is still holding.
    //
    // A command handed over by the service worker has no marker in this URL and no useful
    // opening URL either: a worker's tab was opened at `/` and only became `/c/<id>` when its
    // own bootstrap was answered, so the page it was opened at says nothing about the chat it
    // has now. What fences that path instead is the pair of exact conversation checks around
    // it — the service worker only offers the job to a document already showing the chat the
    // command names, and the redeemed command's own `conversationId` is compared below.
    const openedConversation = fromUrl ? OPENED_CONVERSATION : CLF_DOM.conversationId();
    if (CLF_DOM.conversationId() && !openedConversation) return;

    // A same-chat command is a revival. Do not cross the per-document redeem boundary merely
    // because its composer exists: ChatGPT keeps that composer mounted while the worker's final
    // assistant answer is still streaming. Busy is a waiting state, not a failed revival, and
    // waiting must leave both the durable command and the user's composer untouched.
    if (openedConversation) {
      // Persist only the inert marker/conversation correlation before waiting. If this document,
      // its MV3 service worker, or the whole browser disappears, the replacement browser process
      // can put the same marker back in front of this exact chat. The prime's text stays solely in
      // the app-side command until the later redeem succeeds.
      if (!(await waitForDeferredRevivalCustody(id, openedConversation, attempt))) return;
      if (!(await waitForRevivalSubmitReady(openedConversation, attempt))) return;
    }
    if (attempt?.cancelled) return;

    // RUN_ID names this document. It is what makes the command single-owner: a second tab
    // on the same marker is a different document and is refused, while this one's own
    // request is answered.
    // From here onward a competing fresh wake must not supersede this attempt: the bridge may
    // persist this document as owner before the response gets back to us.
    if (attempt) attempt.phase = 'redeeming';
    const reply = await ask({
      type: 'redeem',
      id,
      client: RUN_ID,
      ...(openedConversation ? { conversationId: openedConversation } : {})
    });
    if (!reply || reply.ok !== true) {
      // The app could not be reached at all, so there is nothing to acknowledge and nothing
      // to acknowledge it to. Its own deadline ends the command; this page stops here.
      reportClaim(false);
      return;
    }
    const boot = reply.command;
    if (!boot) {
      // Cancelled, superseded, taken by another page, or from a previous run of the app.
      // A stale marker types nothing.
      if (openedConversation) void ask({ type: 'forget_revival', id, conversationId: openedConversation });
      reportClaim(false);
      return;
    }

    // `/commands/redeem` persists RUN_ID as the command owner before returning `boot`. This is
    // the exact boundary the service worker needs before it may close the app-opened fallback:
    // a response here means this document owns the durable lease, not merely that an async
    // attempt was started. If the fallback got there first, `boot` is null and the false path
    // above leaves that winning tab alive.
    if (attempt) attempt.phase = 'claimed';
    reportClaim(true);

    const fail = (why) => ask({ type: 'ack', id: boot.id, status: 'failed', error: why, client: RUN_ID });
    // What this command is for, as the app states it. A revival names the conversation and
    // will not be typed anywhere else; the two chat-opening commands name none, and their
    // precondition is the opposite one — that this page still has no conversation at all.
    const target = typeof boot.conversationId === 'string' && boot.conversationId ? boot.conversationId : null;
    if (fromUrl && openedConversation && !target) {
      // Current bridges reject this before leasing the command. Keep the page-side half too:
      // an older bridge (or a stale test fixture) must still never let a worker/resume marker
      // found in an existing chat terminalise the command that belongs to a fresh page.
      return;
    }
    if (!fromUrl && !target) {
      // Only a command that names a conversation is ever handed to an existing document.
      return void (await fail('it was offered to a chat that already exists and it does not name one'));
    }
    if (target && openedConversation !== target) {
      return void (await fail('the page that was opened for it was showing a different conversation'));
    }
    if (!target && CLF_DOM.conversationId()) {
      return void (await fail('the marked fresh chat changed before bootstrap send; nothing was sent'));
    }
    const onTarget = () => (target ? CLF_DOM.conversationId() === target : !CLF_DOM.conversationId());
    // Redeeming the command proves which *document* owns it, not which SPA route that
    // document will still be showing after the await. ChatGPT can navigate this same
    // document to an existing conversation while the worker/app answer is in flight. An
    // empty composer there looks exactly like the marked fresh one, so text checks cannot
    // fence the irreversible send. Keep proving both facts that made this page eligible:
    // the marker still names this command, and ChatGPT still has not assigned/opened a chat.
    // A command handed over by the service worker has no marker in this tab's URL to check;
    // the conversation fence above is the stronger half of the same proof and applies to it.
    const stillOnTarget = () => alive && (!fromUrl || markerId() === id) && onTarget();
    const failIfRetargeted = async () => {
      if (stillOnTarget()) return false;
      await fail(
        target
          ? 'the chat this message was for changed before it was sent; nothing was sent'
          : 'the marked fresh chat changed before bootstrap send; nothing was sent'
      );
      return true;
    };
    if (await failIfRetargeted()) return;

    // The composer is the readiness signal. Page-level `readyState` says whether every
    // resource finished loading, not whether this editing host is usable, and waiting on it
    // is what turned a fresh resume tab into a blank tab for a minute on a throttled page.
    const readyComposer = await waitForComposer();
    if (!readyComposer) return void (await fail('ChatGPT never exposed a usable composer for bootstrap'));
    if (await failIfRetargeted()) return;

    if (!CLF_DOM.insertPrompt(boot.text, true)) return void (await fail('ChatGPT refused the inserted text'));
    // Give synchronous React/input work one microtask turn to replace the editing host, then
    // re-prove the exact draft before the irreversible send. This used to sleep for 100 ms.
    // Long-hidden Chrome tabs throttle wall-clock timers, so that tiny "stability" delay became
    // a foreground dependency: the wake could own the durable bridge lease and have its text in
    // the exact worker composer, yet never reach Send until the user reopened the tab. A
    // microtask preserves the hydration guard without putting delivery behind tab visibility.
    await Promise.resolve();
    if (await failIfRetargeted()) return;
    let composer = CLF_DOM.composer();
    // Compared with whitespace squeezed out of both sides. The composer is a rich-text
    // editor: a blank line in the bootstrap becomes a paragraph break, and `textContent`
    // stitches the paragraphs back together with no separator at all. Compare the entire
    // whitespace-normalized value: a prefix proves insertion happened, but it would also
    // approve user text appended after focus moved into this tab.
    const squeeze = (value) => (value || '').replace(/\s+/g, '');
    const expectedText = squeeze(boot.text);
    if (!composer || squeeze(composer.textContent) !== expectedText) {
      if (composer && !(composer.textContent || '').trim() && CLF_DOM.insertPrompt(boot.text)) {
        await Promise.resolve();
        if (await failIfRetargeted()) return;
        composer = CLF_DOM.composer();
      }
      if (!composer || squeeze(composer.textContent) !== expectedText) {
        return void (await fail('ChatGPT replaced the composer while inserting the bootstrap'));
      }
    }
    // The browser opener can focus this fresh tab while the user is typing elsewhere. The
    // point-in-time empty check above is not enough: any edit after insertion must preserve
    // the user's draft and abort, never submit a bootstrap/user-text mixture as a worker task.
    composer = CLF_DOM.composer();
    if (!composer || squeeze(composer.textContent) !== expectedText) {
      return void (await fail('the composer changed before bootstrap send; the draft was preserved'));
    }
    if (await failIfRetargeted()) return;
    const resumeMarker = boot.type === 'resume' ? String(boot.text || '').match(CONTINUATION_MARKER) : null;
    if (boot.type === 'resume') {
      if (!resumeMarker || resumeMarker[1] !== 'RESUME') {
        return void (await fail('the resume bootstrap had no valid continuation marker'));
      }
      continuationJournalPending = true;
      const permit = await ask({ type: 'compact', token: resumeMarker[2], destinationAttempt: true });
      if (!permit || permit.ok !== true || !permit.data || permit.data.allowed !== true) {
        CLF_DOM.clearPromptExact(boot.text);
        return;
      }
      // As on the source side: the claim above promises nothing was submitted, and this second
      // write is the exclusive cut taken immediately before the click.
      const armed = await ask({ type: 'compact', token: resumeMarker[2], destinationDispatch: true });
      if (!armed || armed.ok !== true || !armed.data || armed.data.armed !== true) {
        CLF_DOM.clearPromptExact(boot.text);
        return;
      }
    }
    // The destination Resume prompt is the first authored evidence in a brand-new chat.
    // Record it before send() clicks so reportMessages can open B's turn immediately instead
    // of waiting until Fiber eventually exposes the first connector request.
    rememberUserSend();
    if (!(await CLF_DOM.send())) {
      CLF_DOM.clearPromptExact(boot.text);
      if (boot.type === 'resume') return;
      return void (await fail('ChatGPT did not accept the bootstrap send'));
    }
    agent = boot.agent || null;
    agentCommandId = agent && typeof boot.id === 'string' ? boot.id : null;

    // A resume is committed from its unique server-authored marker, not from this document's
    // survival long enough to notice a route change. refreshFiber() performs that commit before
    // ordinary journal events, which also prevents a shadow session from claiming chat B.
    if (boot.type === 'resume') {
      const found = CLF_DOM.conversationId();
      if (found) rememberResumeGoalPending(found, boot.id);
      return;
    }

    // A revival already names and repeatedly proved the exact conversation before the send.
    // Once ChatGPT accepts that user message there is nothing left to discover, and waiting on
    // a 500 ms timer creates a duplicate-delivery window in background tabs: the page can reload
    // or be suspended after the send but before the ACK, causing the app to roll the worker back
    // asleep and type the same prime instruction again on the next wake. Report the irreversible
    // send immediately with the already-proven target. Fresh worker/resume commands still need
    // the loop below because ChatGPT has not assigned their new conversation id yet.
    if (target) {
      await ask({ type: 'ack', id: boot.id, status: 'sent', conversationId: target, agent, client: RUN_ID });
      return;
    }

    // The conversation id only exists once ChatGPT has accepted the message, and it is the
    // whole point of the report: for a worker it is what binds the slot to this chat and
    // starts it, and for a resume it is what the session is moved onto. Bounded by the same
    // clock the app is running, so this page never outlives the command it is working on.
    for (let tries = 0; tries < 80; tries++) {
      await sleep(500);
      const found = CLF_DOM.conversationId();
      if (found) {
        await ask({ type: 'ack', id: boot.id, status: 'sent', conversationId: found, agent, client: RUN_ID });
        return;
      }
    }
    // Sent, but this tab never saw an id, so nothing can be bound to it. Reported honestly:
    // the app ends the slot or the continuation rather than waiting on a chat it cannot name.
    await ask({ type: 'ack', id: boot.id, status: 'sent', agent, client: RUN_ID });
  }

  // ----------------------------------------------------------------- start

  const noteStopClick = (event) => {
    const stop = CLF_DOM.stopButton();
    if (stop && event.target instanceof Node && stop.contains(event.target)) userStopped = true;
  };
  listen(document, 'click', noteStopClick, true);

  const notePageHide = (event) => {
    // Hand over anything still queued before this script stops existing. The worker
    // outlives the page, so this is the last chance for these observations to survive.
    void flush();
    // `persisted` means the page went into the back/forward cache: it is frozen, not
    // gone, and the same script resumes on pageshow. Reporting that as a close ended the
    // session and the next observation reopened it, which is where the flood of
    // "session … reopened" came from — several tabs each cycling with nothing changed.
    if (event.persisted) return;
    // Conversation lifetime is owned by the service worker's tab tracking. A document
    // pagehide also happens on reload, so closing here corrupts live turn identity.
  };
  listen(window, 'pagehide', notePageHide);

  function every(ms, fn) {
    const timer = setInterval(() => {
      if (!alive) {
        clearInterval(timer);
        return;
      }
      try {
        const result = fn();
        if (result && typeof result.catch === 'function') result.catch(() => undefined);
      } catch {
        // One bad tick must never stop the loop.
      }
    }, ms);
  }

  let activityTimer = null;
  function activityPullDelay(input = {}) {
    const hidden = input.hidden === true;
    if (input.drafting === true || input.presentationPending === true) return LIVE_ACTIVITY_MS;
    if (input.generating === true) return hidden ? ACTIVITY_MS : LIVE_ACTIVITY_MS;
    if (input.active === true) return ACTIVITY_MS;
    return hidden ? HIDDEN_ACTIVITY_MS : IDLE_ACTIVITY_MS;
  }

  function currentActivityPullDelay() {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const active = nativeBusy || Boolean(job && job.busy) || pendingTools > 0;
    // A goal draft lives entirely on this feed — its streamed text is what the stage panel
    // shows, and the finished message only arrives here — so it polls at the live cadence
    // even in a hidden tab, which is exactly the tab this feature runs in.
    const drafting =
      Boolean(goalDraft) || goalPhase === 'requesting' || goalPhase === 'drafting' || goalPhase === 'retrying';
    return activityPullDelay({
      hidden,
      generating,
      active,
      drafting,
      presentationPending: presentationPending()
    });
  }

  function scheduleActivityPull(delay = 0) {
    if (activityTimer !== null) return;
    activityTimer = setTimeout(async () => {
      activityTimer = null;
      if (!alive) return;
      try {
        await pullActivity();
      } catch {
        // The next scheduled pass retries after worker/app recovery.
      }
      // Re-arming is a periodic loop, and periodic loops belong to the live page, exactly as
      // for every(): the harness stubs setInterval out so every() never ticks, and drives each
      // behaviour through the test hook instead. This pull re-arms with setTimeout rather than
      // setInterval, so it walked straight past that seam — and the harness's setTimeout runs
      // its callback in a microtask, which turned one background poll into an unbroken
      // microtask chain that starved the event loop. The next test then waited forever for a
      // window 'load' event that no macrotask could ever deliver.
      armNextActivityPull();
    }, Math.max(0, delay));
  }

  function armNextActivityPull() {
    if (!TEST_MODE) scheduleActivityPull(currentActivityPullDelay());
  }

  function expediteActivityPull() {
    if (TEST_MODE) return;
    if (activityTimer !== null) {
      clearTimeout(activityTimer);
      activityTimer = null;
    }
    scheduleActivityPull(0);
  }

  // Re-attach immediately when React swaps the composer out, rather than up to a second
  // later. Cheap because it does nothing unless our node has actually been detached.
  function watchComposer() {
    try {
      const observer = new MutationObserver(() => {
        if (!alive) return;
        if (!control || !control.root.isConnected) injectControl();
        if (stagePanel && !stagePanel.root.isConnected) injectStage();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      rememberCleanup(() => observer.disconnect());
    } catch {
      // The one-second tick is the fallback, and it is enough on its own.
    }
  }

  /** Apply popup changes immediately in every open ChatGPT tab. */
  if (globalThis.chrome && chrome.storage && chrome.storage.onChanged) {
    const storageChanged = (changes, areaName) => {
      if (!alive) return;
      if (areaName !== 'local' || !changes) return;
      let changed = false;
      if (changes[RENDER_STREAM_KEY]) {
        const value = changes[RENDER_STREAM_KEY].newValue;
        RENDER_STREAM = value !== false;
        changed = true;
      }
      if (changes[SHOW_TIMES_KEY]) {
        SHOW_TIMES = changes[SHOW_TIMES_KEY].newValue === true;
        changed = true;
      }
      if (!changed) return;
      renderPreferenceReady = true;
      paint();
      renderStreams();
    };
    chrome.storage.onChanged.addListener(storageChanged);
    if (typeof chrome.storage.onChanged.removeListener === 'function') {
      rememberCleanup(() => chrome.storage.onChanged.removeListener(storageChanged));
    }
  }

  /** Popup commands target this tab directly; no bridge credential is involved. */
  if (globalThis.chrome && chrome.runtime && chrome.runtime.onMessage) {
    const runtimeMessage = (message, _sender, sendResponse) => {
      // Recorder takeover revokes every browser-facing control channel, not only observation.
      // A predecessor left registered in this same isolated world can otherwise win a ping or
      // revival response race against its successor even though sendToWorker() is already inert.
      if (!alive) return false;
      if (!message || typeof message.type !== 'string') return false;
      // background.js uses this only to distinguish a live isolated-world recorder from the
      // dead context Chrome leaves behind when an unpacked extension is reloaded while the
      // ChatGPT document stays open. No page/session data crosses in this health check.
      if (message.type === 'clf-recorder-ping') {
        sendResponse({ ok: true, recorderVersion: RECORDER_VERSION });
        return false;
      }
      // Popup diagnostics. Ids and counters only — no prose, no transcript, no page text.
      if (message.type === 'clf-page-status') {
        sendResponse({
          ok: true,
          recorderVersion: RECORDER_VERSION,
          runId: RUN_ID,
          conversationId,
          agent,
          epoch,
          generating,
          turnId,
          generations: genCount,
          queued: queue.length,
          queueBytes,
          trace: [...trace.values()].slice(-8).reverse(),
          overwrite: RENDER_STREAM === true,
          painted,
          bridge: { connected: status.connected === true, paired: status.paired === true },
          ...observed
        });
        return false;
      }
      if (message.type === 'clf-render-stream') {
        RENDER_STREAM = message.enabled !== false;
        renderPreferenceReady = true;
        paint();
        renderStreams();
        sendResponse({ ok: true, enabled: RENDER_STREAM });
        return false;
      }
      // A revival the service worker wants to hand to the document that already has this chat.
      // The response is deliberately delayed until `/commands/redeem` made this exact document
      // the durable owner. background.js may close the app-opened fallback only after that fact,
      // never merely because this listener managed to start an async function.
      if (message.type === 'clf-run-command') {
        const wanted = typeof message.id === 'string' ? message.id : '';
        const conversation = typeof message.conversationId === 'string' ? message.conversationId : '';
        if (!wanted || !conversation || CLF_DOM.conversationId() !== conversation) {
          sendResponse({ ok: false, error: 'wrong_conversation' });
          return false;
        }
        void runCommand(wanted, false, (claimed) => {
          sendResponse({ ok: true, claimed: claimed === true });
        }, { deferredRecovery: message.deferredRecovery === true });
        return true;
      }
      if (message.type === 'clf-overwrite-now') {
        if (!renderStreamAllowed()) {
          sendResponse({ ok: false, error: 'overwrite_disabled' });
          return false;
        }
        void pullActivity()
          .then(() => {
            paint();
            renderStreams();
            sendResponse({ ok: true, enabled: true });
          })
          .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
        return true;
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(runtimeMessage);
    if (typeof chrome.runtime.onMessage.removeListener === 'function') {
      rememberCleanup(() => chrome.runtime.onMessage.removeListener(runtimeMessage));
    }
  }

  // A marked page has exactly one job before ordinary page restoration: deliver the
  // bootstrap it was opened for. Do it first. Putting runCommand() behind ordinary restoration
  // made a fresh empty resume tab wait on completely
  // unrelated startup traffic before the handoff was even inserted. The command journal
  // gate stays closed until marker/identity commit, so beginning normal observation afterwards also
  // preserves the no-shadow-session ordering documented above.
  //
  // On an ordinary existing chat there is no marker and this resolves immediately, after
  // which the established reload handshake remains unchanged: resumeOpenTurn() is still
  // awaited before the first observe() so a reloaded live turn cannot be duplicated.
  const startupCommandId = markerId();
  // Fresh worker/resume pages still deliver before status restoration: they own an empty New
  // Chat and need no prior conversation lifecycle. A revival is the opposite. Let the recorder
  // restore this existing chat's durable open turn first, otherwise a reload during a Stop-button
  // flicker could call the page idle before it has learned that the previous turn is still open.
  const commandStartup = startupCommandId && !OPENED_CONVERSATION ? runCommand(startupCommandId) : Promise.resolve();
  void commandStartup
    .catch(() => undefined)
    .then(loadRenderPreference)
    .then(checkStatus)
    .then(() => resumeOpenTurn().catch(() => undefined))
    .then(() => {
      observe();
      commandReadinessInitialized = true;
      notifyCommandReadiness();
      injectControl();
      injectStage();
      if (startupCommandId && OPENED_CONVERSATION) void runCommand(startupCommandId);
    });

  syncTheme();
  wireTips();
  wireMenu();
  if (typeof globalThis.addEventListener === 'function') {
    listen(globalThis, 'wheel', notePresentationScrollInput, { capture: true, passive: true });
    listen(globalThis, 'touchmove', notePresentationScrollInput, { capture: true, passive: true });
    listen(globalThis, 'keydown', notePresentationScrollInput, true);
  }
  watchComposer();
  watchToolRows();
  watchTranscript();

  every(OBSERVE_MS, () => {
    observe();
    syncTheme();
    injectControl();
    injectStage();
    // Relabelling on the observe tick as well as the activity tick: the calls are
    // already known here, and ChatGPT rendering a block a second after we heard about
    // its call used to mean waiting for the next poll to see the real label.
    paint();
    renderStreams();
    foldBootstrap();
  });
  scheduleActivityPull(ACTIVITY_MS);
  if (typeof document !== 'undefined' && document.addEventListener) {
    const visibilityChanged = () => {
      if (document.visibilityState !== 'visible') return;
      if (activityTimer !== null) clearTimeout(activityTimer);
      activityTimer = null;
      scheduleActivityPull(0);
    };
    listen(document, 'visibilitychange', visibilityChanged);
  }
  every(STATUS_MS, checkStatus);

  // Only now, with every binding above initialised, does this recorder answer for itself.
  // `chrome.runtime.id` is the exact orphan test: an invalidated isolated world keeps its
  // globals and its timers but loses that property, so a successor can tell a live
  // recorder it must not disturb from a dead one it must replace.
  recorderHandle.healthy = () => {
    if (!alive) return false;
    try {
      return !!globalThis.chrome && !!chrome.runtime && typeof chrome.runtime.id === 'string';
    } catch {
      return false;
    }
  };
  recorderHandle.stop = () => {
    // `alive` gates sendToWorker(), so this is what actually silences the old recorder:
    // no observation, evidence or command of its can reach the app afterwards. Its
    // intervals drain themselves on their next tick through every().
    alive = false;
    if (activityTimer !== null) {
      clearTimeout(activityTimer);
      activityTimer = null;
    }
    for (const cleanup of stopCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Detached DOM and an invalidated extension world are both normal takeover states.
      }
    }
    try {
      // Hand ChatGPT's own labels back before the successor paints its own.
      unpaint();
    } catch {
      // A detached/rewritten DOM is not worth failing a handover over.
    }
    try {
      hideTip();
      if (tipNode) tipNode.remove();
      tipNode = null;
      closeMenu();
      if (menuNode) menuNode.remove();
      menuNode = null;
      removeStagePanel();
      if (control && control.root) control.root.remove();
      control = null;
    } catch {
      // Presentation cleanup is best effort; ownership was already revoked by `alive=false`.
    }
  };

  /**
   * Handed to the extension regression tests, which run this file with a real DOM but no
   * Chrome. Nothing on the live page defines this hook, so nothing on the live page can
   * reach in through it.
   */
  if (typeof globalThis.CLF_TEST_HOOK === 'function') {
    globalThis.CLF_TEST_HOOK({
      planLabels,
      controlState,
      stageView,
      goalStageView,
      settingsView,
      toggleMenu,
      closeMenu,
      renderControl,
      noteGoalTurn,
      maybeSendGoalReply,
      GOAL_STABLE_MS,
      emit,
      flush,
      observe,
      syncTheme,
      meterView,
      paint,
      renderStreams,
      foldBootstrap,
      injectControl,
      injectStage,
      pullActivity,
      activityPullDelay,
      currentActivityPullDelay,
      notePresentation,
      presentationPending,
      runCommand,
      startCompact,
      cancelCompact,
      refreshFiber,
      fiberFor,
      readDescriptor,
      /** Reading order, so a test can pin it against `src/shared/chronology.ts` directly. */
      chronological,
      streamTurnGroups,
      visibleStream,
      /** So a test settles a turn by the real window rather than a copy of the number. */
      TURN_SETTLE_MS,
      STALL_MS,
      GOAL_RETRY_MS,
      PRESENTATION_SCROLL_IDLE_MS,
      /** Test-only: production defaults ON; tests opt into renderer cases explicitly. */
      setRenderStream: (on) => {
        RENDER_STREAM = on === true;
        renderPreferenceReady = true;
      },
      renderStreamEnabled: () => RENDER_STREAM,
      setShowTimes: (on) => {
        SHOW_TIMES = on === true;
      }
    });
  }
})();
