/**
 * Service worker: the only part of the extension that talks to the app.
 *
 * The pairing token lives here and in chrome.storage.local, never in a content
 * script and never in the page. A content script that were somehow compromised can
 * ask this worker to post observations about the page it is already reading; it
 * cannot read the token, cannot reach the app on its own (the app refuses a
 * https://chatgpt.com origin), and there is no message that makes the app touch a
 * file, run a command or change a permission.
 *
 * Discovery is a scan of five fixed loopback ports for a /hello that identifies the
 * app. Nothing is broadcast and nothing listens.
 *
 * This worker also owns the observation journal. A content script lives only as long as
 * its page: a reload, a navigation or a crash takes its memory with it, and ChatGPT
 * virtualises old turns, so what is gone is often gone for good. So a content script
 * hands an observation over immediately and the durable copy lives here, in
 * chrome.storage.session — which survives this worker being shut down (Chrome does that
 * after seconds of idling) and dies with the browser, which is the right lifetime for a
 * record the app has not accepted yet.
 */

const PORTS = [8765, 8766, 8767, 8768, 8769];
const HELLO_TIMEOUT_MS = 1200;
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * The deadline for the one route that waits on a model rather than on the app's own state.
 *
 * Every other request this worker makes is answered from something the app already has, so the
 * ordinary ten seconds is a generous ceiling for it. `/goal/open` is different: it holds the
 * connection open for a whole OpenRouter completion, which the app itself allows 180s for. A
 * shorter deadline here does not cancel that work — the app keeps going and the account is
 * still billed for the answer — it only guarantees nobody is left to receive it.
 *
 * So this sits above the app's own timeout on purpose. Whichever way the request ends, the
 * app's error handling is the half that gets to say why.
 */
const MODEL_REQUEST_TIMEOUT_MS = 190_000;

/** The reason a deadline aborts with, so it is a fact the caller can act on rather than prose. */
const TIMED_OUT = 'the app took too long to answer';
/** Bumped only when the request/response shape changes; the app compares it. */
const BRIDGE_PROTOCOL = 12;

/**
 * Journal caps. The byte figure is what actually matters — chrome.storage.session has a
 * ten-megabyte budget for the whole extension — and the count keeps a pathological run
 * of tiny events from making every write expensive.
 */
const MAX_JOURNAL = 4000;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const BATCH = 100;
const RETRY_ALARM = 'clf-bridge-drain';
/**
 * How long the worker sleeps between maintenance passes, in minutes.
 *
 * Thirty seconds, because thirty seconds is the floor. Chrome fires an alarm at most twice a
 * minute and clamps anything shorter in a packed extension — an unpacked development copy is
 * exempt, which is the trap: 0.25 works on this machine and silently becomes 0.5 for everybody
 * who installs a release.
 *
 * So this is a sleeping-service-worker fallback with an honest bound, not a fast path. The app
 * arms a repair fifteen to sixty seconds into an unattributed incident, depending on how many
 * chats are still suspect; the browser sees it on the next pass, which is up to thirty seconds
 * later. Anything better would need a keepalive, an offscreen document or a second timer
 * framework to beat a browser API floor, and a broken turn is not worth that.
 *
 * That floor is also why one pass collects *every* repair now due rather than one: the app can
 * decide three at the same instant, and handing them out one per pass would spread three
 * reloads across a minute and a half for no reason anybody chose.
 *
 * A one-shot re-armed at the end of every pass, rather than `periodInMinutes`: a period may not
 * go below a minute at all, and that periodic form was why a repair armed at T+20 could wait
 * until T+75.
 */
const RETRY_PERIOD_MIN = 0.5;
let retryAlarmScheduled = false;

let port = null;
let token = null;
let loaded = false;
/**
 * The one `load()` in flight, shared by everything that has to wait for it.
 *
 * `loaded` alone is not a guard, because it is only set after two awaited storage reads.
 * Chrome stops this worker after seconds of idling, so the cold path is the normal path:
 * two tabs report at the same moment, both see `loaded === false`, and both walk the whole
 * of load(). The first finishes, its handler enqueues an observation and persists it — and
 * then the second finishes and assigns the journal it read *before* that write straight
 * over the global. The entry the first handler already answered `ok` for is gone, and
 * nothing anywhere reports a loss, because as far as both halves are concerned each did
 * its job. Serialising initialisation is the whole fix: after this, the second caller
 * awaits the same promise and never re-reads.
 */
let loading = null;

/**
 * Set when the user disconnected on purpose, and cleared only when they connect again.
 *
 * Without it, "Disconnect" cleared the token and the very next `/hello` handed this
 * browser a new one — a button whose effect lasted until the next poll, roughly two
 * seconds. Auto-provisioning is right for a browser that has never connected and wrong
 * for one that was told to stop, and only this flag can tell those two apart.
 */
let disconnected = false;
/**
 * Monotonic user connection intent for this worker lifetime.
 *
 * `/pair` is an async mint. A user can press Disconnect after that request has left but
 * before its response arrives; without an intent fence the old response writes its token and
 * clears `disconnected`, undoing the newer click. Worker restart needs no persisted generation
 * because an in-flight fetch cannot survive it; the persisted `disconnected` flag is the
 * cross-worker authority.
 */
let connectionEpoch = 0;

/**
 * The `/pair` in flight, shared by everything that wants a token.
 *
 * Several tabs coming back at once all find no token and all call `/pair`. Each call
 * mints a fresh credential and invalidates the one before it, so the tabs rotate each
 * other's tokens: every request 401s, drops its token, and provisions again. One promise
 * means one credential no matter how many callers arrive together.
 */
let pairing = null;
let pairingEpoch = -1;
let pairingReconnect = false;
/** Most recent pairing failure, for the popup. Process-local and never a credential. */
let pairingError = null;

/**
 * When the app was last confirmed to be on `port`, and how long that is believed for.
 *
 * `discover()` used to run a `/hello` before every authenticated request, which doubled
 * the bridge traffic of an already-chatty poll and, with several tabs open, could spend
 * the 900/min budget on nothing but asking whether the app was still there. A failed
 * request re-checks immediately, so nothing is lost by believing a recent answer.
 */
let portCheckedAt = 0;
let portCompatible = null;
let appVersion = null;
let appProtocol = null;
const PORT_TRUST_MS = 30_000;

/**
 * Observations accepted from content scripts but not yet accepted by the app.
 *
 * Each entry carries the conversation it was observed in, captured at that moment.
 * Flushing groups by that field rather than labelling a whole batch with whatever
 * conversation happens to be current — a tab that moves from chat A to chat B while the
 * app is unreachable would otherwise file A's messages into B's history.
 */
let journal = [];
/** The one journal flush currently talking to the app, if any. */
let drainWork = null;

/**
 * What the last /events delivery did, kept only so the popup can show it.
 *
 * Nothing in the transport reads this. It exists because "is my chat actually reaching
 * the app?" was previously answerable only by reading the app's log, and a popup that
 * cannot answer it is a popup that gets replaced by guesswork.
 */
let delivery = { at: 0, ok: null, events: 0, total: 0, conversationId: null, status: 0, error: null };
/** Idempotent conversation-close deliveries awaiting an app ACK. */
let closeOutbox = [];
let closing = false;
/**
 * Command acknowledgements accepted from a content script but not yet accepted by the app.
 *
 * A fresh ChatGPT page is allowed to disappear immediately after it tells this worker that
 * its bootstrap was sent. Keeping that result only in the page, or only in the request that
 * happens to be in flight, creates a classic lost-final-ACK window: the app may commit the
 * command and the HTTP response may still be lost, after which the page is gone and nobody
 * retries. This outbox is worker-owned and storage.session-backed for exactly the same reason
 * as the observation journal. The wire payload is intentionally the existing /commands/ack
 * body unchanged; durability is a transport concern, not a protocol fork.
 */
let commandAckOutbox = [];
let ackingCommands = false;

/**
 * Which ChatGPT conversation each browser tab currently represents.
 *
 * Conversation lifetime is a browser-level fact, not a document-level one. A content
 * script dies on reload and `pagehide` fires even though the tab and conversation are
 * still alive; with two tabs on one chat, either document can disappear while the other
 * remains. Keeping this in the service worker lets a tab reload without closing the
 * app-side session and lets `/closed` mean the last live tab really left.
 *
 * Persisted in storage.session because Chrome routinely stops this worker while tabs stay
 * open. `chrome.tabs.onRemoved` wakes it again and can then retire the right conversation.
 */
let tabConversations = {};
/** Browser-supplied document owner for each tab, plus bounded retired owners. */
let tabDocuments = {};
/** Highest same-document SPA navigation generation accepted for each tab. */
let tabEpochs = {};
let retiredDocuments = {};
/** Durable terminal lease; cleared only when a different browser document speaks. */
let terminalDocuments = {};

/**
 * Command ids this browser has already delivered.
 *
 * Fresh worker/resume commands are app-opened; revivals are routed here after a fresh tab scan.
 * This latch stays because a marked page that reloads must not type the same bootstrap into a
 * second conversation.
 */
let settled = [];
/**
 * Existing-chat revivals that a content document saw while the target chat was not yet safe for
 * another user message. Marker + conversation only: the prime's actual text stays exclusively in
 * the app-side durable command/broker state until a submit-ready page redeems it.
 *
 * Unlike the observation journal this lives in storage.local. A browser restart clears
 * storage.session, and "browser closed while the worker's final answer is still settling" is a
 * normal wait, not permission to lose the wake request. Stale markers are harmless because the
 * bridge redeem is still the authority fence and rejects commands that no longer exist.
 */
let deferredRevivals = [];
/** One in-flight same-tab offer per deferred command in this MV3 worker lifetime. */
const deferredRevivalOffers = new Map();
/** App says an active agent/recovery episode still needs the maintenance cadence. */
let recoveryMonitoring = false;
/** Tabs whose normal auto-discard policy this extension changed for a live agent conversation. */
let discardProtectedTabs = {};

function load() {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = loadOnce().finally(() => {
      // Only ever cleared after loadOnce() has run to completion or thrown. A throw leaves
      // `loaded` false, so the next caller genuinely retries rather than proceeding on
      // half-initialised globals.
      loading = null;
    });
  }
  return loading;
}

async function loadOnce() {
  const stored = await chrome.storage.local.get(['port', 'token', 'disconnected', 'deferredRevivals', 'commandAckOutbox']);
  port = typeof stored.port === 'number' ? stored.port : null;
  token = typeof stored.token === 'string' ? stored.token : null;
  // Deliberately in `local` rather than `session`: a choice to disconnect that a browser
  // restart undoes is not a choice, it is a delay.
  disconnected = stored.disconnected === true;
  deferredRevivals = Array.isArray(stored.deferredRevivals) ? stored.deferredRevivals.slice(-100) : [];
  const live = await chrome.storage.session.get([
    'settled',
    'journal',
    'tabConversations',
    'tabDocuments',
    'tabEpochs',
    'retiredDocuments',
    'terminalDocuments',
    'closeOutbox',
    'commandAckOutbox',
    'recoveryMonitoring',
    'discardProtectedTabs',
    'delivery'
  ]);
  settled = Array.isArray(live.settled) ? live.settled : [];
  journal = Array.isArray(live.journal) ? live.journal : [];
  tabConversations =
    live.tabConversations && typeof live.tabConversations === 'object' && !Array.isArray(live.tabConversations)
      ? { ...live.tabConversations }
      : {};
  tabDocuments = live.tabDocuments && typeof live.tabDocuments === 'object' ? { ...live.tabDocuments } : {};
  tabEpochs = live.tabEpochs && typeof live.tabEpochs === 'object' ? { ...live.tabEpochs } : {};
  retiredDocuments =
    live.retiredDocuments && typeof live.retiredDocuments === 'object' ? { ...live.retiredDocuments } : {};
  terminalDocuments =
    live.terminalDocuments && typeof live.terminalDocuments === 'object' ? { ...live.terminalDocuments } : {};
  closeOutbox = Array.isArray(live.closeOutbox) ? live.closeOutbox.slice(-200) : [];
  // Browser-close durability: a send already accepted by ChatGPT is irreversible. Its final ACK
  // therefore has to survive storage.session being cleared on browser restart. Prefer the local
  // copy, while still accepting the old session copy as an upgrade migration path.
  commandAckOutbox = Array.isArray(stored.commandAckOutbox)
    ? stored.commandAckOutbox.slice(-200)
    : Array.isArray(live.commandAckOutbox)
      ? live.commandAckOutbox.slice(-200)
      : [];
  recoveryMonitoring = live.recoveryMonitoring === true;
  const savedDiscardProtection =
    live.discardProtectedTabs && typeof live.discardProtectedTabs === 'object' && !Array.isArray(live.discardProtectedTabs)
      ? live.discardProtectedTabs
      : {};
  discardProtectedTabs = Object.fromEntries(
    Object.entries(savedDiscardProtection).filter(([id, owned]) => /^\d+$/.test(id) && owned === true)
  );
  if (live.delivery && typeof live.delivery === 'object' && !Array.isArray(live.delivery)) {
    delivery = { ...delivery, ...live.delivery };
  }
  loaded = true;
}

async function persist() {
  await chrome.storage.local.set({ port, token, disconnected });
}

let liveWriteQueue = Promise.resolve();

function persistLive() {
  const write = liveWriteQueue.then(() =>
    Promise.all([
      chrome.storage.session.set({
        settled: settled.slice(-40),
        tabConversations,
        tabDocuments,
        tabEpochs,
        retiredDocuments,
        terminalDocuments,
        closeOutbox: closeOutbox.slice(-200),
        commandAckOutbox: commandAckOutbox.slice(-200),
        recoveryMonitoring,
        discardProtectedTabs,
        delivery
      }),
      // Only small command-control metadata crosses browser restarts. No transcript and no
      // revival text is duplicated into extension storage.
      chrome.storage.local.set({
        commandAckOutbox: commandAckOutbox.slice(-200),
        deferredRevivals: deferredRevivals.slice(-100)
      })
    ])
  );
  liveWriteQueue = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}

/**
 * Writes the journal where it will survive this worker being shut down.
 *
 * Chrome stops the service worker after seconds of idling, so an in-memory journal is
 * not a journal at all. If the write is refused the size estimate was optimistic, so
 * compact harder and try once more; only if *that* fails is durability genuinely lost,
 * and then the journal says so in place rather than pretending it is safe.
 */
let durabilityGap = false;
let journalWriteQueue = Promise.resolve();

async function persistJournalNow() {
  try {
    await chrome.storage.session.set({ journal });
    durabilityGap = false;
    return true;
  } catch {
    makeRoom(true);
    try {
      await chrome.storage.session.set({ journal });
      durabilityGap = false;
      return true;
    } catch (err) {
      if (!durabilityGap) {
        durabilityGap = true;
        journal.push(
          gapEntry(
            journal.length > 0 ? journal[journal.length - 1] : null,
            'chat_error',
            '⚠ The browser refused to store this extension’s pending observations. Until the app accepts them they exist only in memory, so closing the browser or reloading the extension would lose them.'
          )
        );
      }
      return false;
    }
  }
}

function persistJournal() {
  // storage.session.set is asynchronous and whole-snapshot writes may complete out of order.
  // Serialize them so an older snapshot can never land after a newer one while both callers
  // were already told their observations were durable.
  const write = journalWriteQueue.then(() => persistJournalNow());
  journalWriteQueue = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}

// --------------------------------------------------------------------- journal

/**
 * Events that are dropped only when there is genuinely nothing else to give up.
 *
 * Progress lines are not among them: they are dense, repetitive, and their outline can
 * be inferred from what surrounds them. A user message cannot be inferred from anything.
 */
const ESSENTIAL = new Set(['user_message', 'assistant_message', 'chat_error', 'turn_start', 'turn_end']);

/**
 * Cached per-entry serialised size, kept out-of-band so measuring an entry does not
 * mutate the thing we later write to chrome.storage.session.
 *
 * The old cache lived as `entry.b`. That made every measured entry several bytes larger
 * after it had been measured, so the journal could report itself under the 4 MiB cap
 * while the actual JSON written to Chrome was already over it.
 */
const sizeCache = new WeakMap();
const utf8 = new TextEncoder();

function sizeOf(entry) {
  const cached = sizeCache.get(entry);
  if (typeof cached === 'number') return cached;
  let bytes = 500;
  try {
    // Chrome limits storage by bytes. JS string length counts UTF-16 code units, so German
    // text, CJK and especially emoji could make the journal several times larger than this
    // guard believed and turn an acknowledged observation back into volatile RAM.
    bytes = utf8.encode(JSON.stringify(entry)).byteLength;
  } catch {
    // A malformed observation will be rejected by the app later; keep its pressure
    // estimate conservative here so it cannot bypass the browser journal cap.
  }
  sizeCache.set(entry, bytes);
  return bytes;
}

/** Exact JSON-array size for the journal itself, including commas and brackets. */
function totalBytes() {
  if (journal.length === 0) return 2;
  let sum = 2 + journal.length - 1;
  for (const entry of journal) sum += sizeOf(entry);
  return sum;
}

/**
 * Copies the identity that decides where one queued observation may be delivered.
 *
 * A fresh chat has no conversation id yet, so `provisional` is just as important as the
 * eventual id. Worker provenance also has to stay on the exact row that carried it: combining
 * an agent label from one row with another row's command id would manufacture authority.
 */
function routeOf(entry) {
  return {
    conversationId: entry && typeof entry.conversationId === 'string' ? entry.conversationId : null,
    provisional: entry && typeof entry.provisional === 'string' ? entry.provisional : null,
    agent: entry && typeof entry.agent === 'string' ? entry.agent : null,
    agentCommandId: entry && typeof entry.agentCommandId === 'string' ? entry.agentCommandId : null
  };
}

function routeKey(entry) {
  const route = routeOf(entry);
  return JSON.stringify([route.conversationId, route.provisional, route.agent, route.agentCommandId]);
}

function gapEntry(source, kind, text) {
  return { ...routeOf(source), gap: true, event: { kind, time: Date.now(), text } };
}

/**
 * Brings the journal back inside both budgets — count *and* bytes.
 *
 * Both matter and for different reasons: the count keeps a run of tiny events from
 * making every write expensive, and the byte figure is the one Chrome enforces. Being
 * under one while over the other is what quietly turned this journal back into plain
 * RAM, because chrome.storage.session then refused the write.
 *
 * Progress lines go first, oldest first. Essentials are given up only when dropping
 * every last progress line still leaves the journal over budget — and when that
 * happens it is stated in the record, in place, rather than closed over. A history with
 * an acknowledged hole is usable; one with an invisible hole is not.
 *
 * `tighten` compacts to roughly three quarters of the budget instead of exactly to it,
 * used when Chrome has already refused a write and the estimate is evidently optimistic.
 */
function makeRoom(tighten = false) {
  const countCap = tighten ? Math.floor(MAX_JOURNAL * 0.75) : MAX_JOURNAL;
  const byteCap = tighten ? Math.floor(MAX_JOURNAL_BYTES * 0.75) : MAX_JOURNAL_BYTES;
  // Measure once. sizeOf() is cached, but summing all 4,000 retained entries on every
  // discarded row still made quota compaction quadratic under a long outage.
  let bytes = totalBytes();
  const fits = () => journal.length <= countCap && bytes <= byteCap;
  if (fits()) return;

  const removeAt = (index) => {
    const before = journal.length;
    const [entry] = journal.splice(index, 1);
    if (!entry) return null;
    bytes -= sizeOf(entry) + (before > 1 ? 1 : 0);
    return entry;
  };
  const insertAt = (index, entry) => {
    const comma = journal.length > 0 ? 1 : 0;
    journal.splice(Math.min(index, journal.length), 0, entry);
    bytes += sizeOf(entry) + comma;
  };
  /** Updates a gap and keeps the running exact serialised size in sync. */
  const setGapText = (gap, text) => {
    const before = sizeOf(gap);
    gap.event.text = text;
    sizeCache.delete(gap);
    bytes += sizeOf(gap) - before;
  };

  // Pass one: progress and other non-essential lines, oldest first. The gap marker is
  // inserted on the first removal and counts against the limits while we keep trimming,
  // so pressure can never make the algorithm delete its own evidence of what was lost.
  const progressGaps = new Map();
  let progressAt = 0;
  while (!fits()) {
    while (
      progressAt < journal.length &&
      (journal[progressAt].gap || ESSENTIAL.has(journal[progressAt].event.kind))
    ) {
      progressAt++;
    }
    if (progressAt >= journal.length) break;
    const index = progressAt;
    const entry = removeAt(index);
    if (!entry) break;
    const key = routeKey(entry);
    let bucket = progressGaps.get(key);
    if (!bucket) {
      bucket = { gap: gapEntry(entry, 'progress', ''), dropped: 0 };
      progressGaps.set(key, bucket);
      insertAt(index, bucket.gap);
      progressAt = index + 1;
    }
    bucket.dropped++;
    setGapText(
      bucket.gap,
      `⚠ ${bucket.dropped} progress line(s) observed here were dropped in the browser before the app accepted them. The app was unreachable and the local queue was full.`
    );
  }
  if (fits()) return;

  // Pass two: essentials themselves have to go. This is real loss, so keep one durable
  // marker naming exactly what kinds disappeared. As above, the marker is present while
  // trimming, which guarantees the final journal is genuinely inside both caps.
  const lossGaps = new Map();
  let lossAt = 0;
  while (!fits()) {
    while (lossAt < journal.length && journal[lossAt].gap) lossAt++;
    if (lossAt >= journal.length) break;
    const index = lossAt;
    const entry = removeAt(index);
    if (!entry) break;
    const key = routeKey(entry);
    let bucket = lossGaps.get(key);
    if (!bucket) {
      bucket = { gap: gapEntry(entry, 'chat_error', ''), lost: 0, counts: {} };
      lossGaps.set(key, bucket);
      insertAt(index, bucket.gap);
      lossAt = index + 1;
    }
    bucket.lost++;
    bucket.counts[entry.event.kind] = (bucket.counts[entry.event.kind] || 0) + 1;
    const detail = Object.entries(bucket.counts)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ');
    setGapText(
      bucket.gap,
      `⚠ ${bucket.lost} observation(s) (${detail}) were lost in the browser before the app accepted them: the local journal hit its storage limit while the app was unreachable. This part of the history is incomplete.`
    );
  }
}

function enqueue(entries) {
  for (const entry of entries) {
    if (!entry || !entry.event || typeof entry.event.kind !== 'string') continue;
    journal.push({
      conversationId: typeof entry.conversationId === 'string' ? entry.conversationId : null,
      // Observations made before ChatGPT has assigned a conversation id are held under
      // the tab that saw them; bindProvisional() renames them once the id exists.
      provisional: typeof entry.provisional === 'string' ? entry.provisional : null,
      agent: typeof entry.agent === 'string' ? entry.agent : null,
      agentCommandId: typeof entry.agentCommandId === 'string' ? entry.agentCommandId : null,
      event: entry.event
    });
  }
  makeRoom();
}

/**
 * Gives a real conversation id to everything a tab observed before one existed.
 *
 * A brand new chat has no id until ChatGPT accepts the first message, and that is
 * exactly when the first user message is observed. Those entries are journalled here
 * immediately under the tab's key, so a reload in that window does not take them with
 * it, and this renames them the moment the id turns up.
 *
 * Only entries observed in the last ten minutes are bound. A tab that sat on an empty
 * composer this morning and is used for a different chat this afternoon must not have
 * the morning's observations filed into the afternoon's conversation.
 */
const PROVISIONAL_TTL_MS = 10 * 60 * 1000;

function bindProvisional(provisional, conversationId) {
  if (!provisional || !conversationId) return 0;
  const cutoff = Date.now() - PROVISIONAL_TTL_MS;
  let bound = 0;
  for (const entry of journal) {
    if (entry.provisional !== provisional || entry.conversationId) continue;
    if (typeof entry.event.time === 'number' && entry.event.time < cutoff) continue;
    entry.conversationId = conversationId;
    entry.provisional = null;
    sizeCache.delete(entry);
    bound++;
  }
  return bound;
}

/**
 * Promotes a fresh command's durable ACK gate once ChatGPT finally assigns /c/<id>.
 *
 * A command may report `sent` before the fresh route exists. Its observations are still
 * journalled under this document's provisional key, so if the ACK itself is waiting on a
 * transient bridge failure we must carry that same identity forward when `bind` happens.
 * Otherwise the newly named observations could overtake the still-pending command result.
 */
function bindCommandAckProvisional(provisional, conversationId) {
  if (!provisional || !conversationId) return 0;
  let bound = 0;
  for (const entry of commandAckOutbox) {
    if (!entry || entry.conversationId || entry.provisional !== provisional) continue;
    entry.conversationId = conversationId;
    bound++;
  }
  return bound;
}

/**
 * Delivers what the app has not accepted yet, one conversation at a time.
 *
 * Nothing leaves the journal until the app answers 200 for that batch. A 413 is the one
 * case where retrying unchanged is pointless, so the batch is halved instead.
 */
/** Records one /events attempt for the popup's diagnostics. Never affects delivery. */
function noteDelivery(result, count, conversationId) {
  delivery = {
    at: Date.now(),
    ok: result.ok === true,
    events: count,
    total: delivery.total + (result.ok === true ? count : 0),
    conversationId: conversationId || null,
    status: result.status || 0,
    error: result.ok === true ? null : String(result.error || `HTTP ${result.status || 0}`)
  };
}

/** Finds the next deliverable conversation and its first batch in one journal pass. */
function nextJournalBatch(preferredConversationId = null) {
  const blocked = new Set();
  for (const ack of commandAckOutbox) {
    if (ack && ack.conversationId) blocked.add(ack.conversationId);
  }
  const preferred = cleanConversationId(preferredConversationId);
  let conversationId =
    preferred && !blocked.has(preferred) && journal.some((entry) => entry.conversationId === preferred)
      ? preferred
      : null;
  let agent;
  let agentCommandId;
  const mine = [];
  for (const entry of journal) {
    if (!conversationId) {
      if (!entry.conversationId || blocked.has(entry.conversationId)) continue;
      conversationId = entry.conversationId;
    }
    if (entry.conversationId !== conversationId || mine.length >= BATCH) continue;
    mine.push(entry);
    // Recovery provenance must come from the same journal entry. Older entries can have an
    // agent label but no command id; keep delivering them, but never upgrade that label into
    // worker-binding authority by combining it with another row's command id.
    if (!agent && entry.agent && entry.agentCommandId) {
      agent = entry.agent;
      agentCommandId = entry.agentCommandId;
    }
    if (mine.length >= BATCH) break;
  }
  return conversationId ? { conversationId, mine, agent, agentCommandId } : null;
}

async function drainOnce(preferredConversationId = null) {
  await load();
  if (journal.length === 0 || !token) return { ok: true, pending: journal.length };
  let guard = 0;
  while (journal.length > 0 && guard++ < 20) {
    // A command page deliberately holds its page-local observations until its final ACK is
    // handed to this worker. Preserve the same ordering after that hand-off: if transport
    // leaves the ACK in the durable outbox, do not let observations from that command's
    // concrete conversation overtake it. Other conversations remain independent.
    const batch = nextJournalBatch(preferredConversationId);
    if (!batch) break;
    const { conversationId, mine, agent, agentCommandId } = batch;
    const result = await call('/events', {
      method: 'POST',
      body: JSON.stringify({
        conversationId,
        agent,
        agentCommandId,
        events: mine.map((entry) => entry.event)
      })
    });
    noteDelivery(result, mine.length, conversationId);
    if (result.status === 413 && mine.length > 1) {
      // Too big for the app to accept. Send half; the remainder stays queued.
      const half = mine.slice(0, Math.floor(mine.length / 2));
      const retry = await call('/events', {
        method: 'POST',
        body: JSON.stringify({ conversationId, agent, agentCommandId, events: half.map((entry) => entry.event) })
      });
      noteDelivery(retry, half.length, conversationId);
      if (!retry.ok) break;
      const sent = new Set(half);
      journal = journal.filter((entry) => !sent.has(entry));
      continue;
    }
    if (result.status === 413 && mine.length === 1) {
      const rejected = mine[0];
      journal = journal.filter((entry) => entry !== rejected);
      journal.unshift(
        gapEntry(
          rejected,
          'chat_error',
          '⚠ One browser observation was too large for the local bridge and was replaced by this explicit gap.'
        )
      );
      continue;
    }
    if (!result.ok) {
      // A permanently malformed/authenticated item must not hold every later
      // conversation hostage. Replace it with an explicit gap and continue; transport,
      // auth, throttling and server failures remain retryable.
      if (result.status >= 400 && result.status < 500 && ![401, 408, 409, 426, 429].includes(result.status)) {
        const rejected = mine[0];
        journal = journal.filter((entry) => entry !== rejected);
        if (!rejected.gap) {
          journal.unshift(
            gapEntry(
              rejected,
              'chat_error',
              `⚠ One browser observation was rejected by the local bridge (HTTP ${result.status}) and was replaced by this explicit gap.`
            )
          );
        }
        continue;
      }
      scheduleRetry();
      break;
    }
    const sent = new Set(mine);
    journal = journal.filter((entry) => !sent.has(entry));
  }
  await persistJournal();
  if (journal.length > 0) scheduleRetry();
  else clearRetryIfIdle();
  return { ok: true, pending: journal.length };
}

/**
 * Starts a journal drain if one is not already running.
 *
 * Normal observation delivery deliberately keeps the old contention semantics: once an entry
 * is durable in storage.session, a second tab should not have to wait for another chat's slow
 * /events request merely because that request is already in flight. Goal joins explicitly in
 * deliverConversationJournal(), because its correctness depends on the delivery boundary.
 */
function drain(preferredConversationId = null) {
  if (drainWork) return Promise.resolve({ ok: true, pending: journal.length });
  const work = drainOnce(preferredConversationId);
  const tracked = work.finally(() => {
    if (drainWork === tracked) drainWork = null;
  });
  drainWork = tracked;
  return tracked;
}

function journalCountForConversation(conversationId) {
  return journal.reduce((count, entry) => count + (entry.conversationId === conversationId ? 1 : 0), 0);
}

/** Proves this conversation has no accepted-but-undelivered transcript before Goal reads it. */
async function deliverConversationJournal(conversationId) {
  // One pass can carry 2,000 rows (20 × BATCH). Three attempts cover the full 4,000-row
  // journal even if the first merely joins a flush that was already serving another chat.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = journalCountForConversation(conversationId);
    if (before === 0) return true;
    // Unlike ordinary journal callers, Goal must join a flush already in flight. Only after
    // it ends can a targeted pass prove whether this conversation reached the app.
    if (drainWork) await drainWork;
    if (journalCountForConversation(conversationId) === 0) return true;
    await drain(conversationId);
    const after = journalCountForConversation(conversationId);
    if (after === 0) return true;
    // The first pass may only have joined somebody else's in-flight drain. Once a targeted
    // pass itself makes no progress, transport/ACK ordering prevents us proving the context.
    if (attempt > 0 && after >= before) return false;
  }
  return journalCountForConversation(conversationId) === 0;
}

// -------------------------------------------------------------------- transport

async function fetchBounded(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const external = init.signal;
  const abort = () => controller.abort();
  if (external && external.aborted) controller.abort();
  else if (external && typeof external.addEventListener === 'function') external.addEventListener('abort', abort, { once: true });
  // Aborted with a reason on purpose. An abort with none rejects as the platform's opaque
  // "signal is aborted without reason", which is exactly what this worker's own deadline
  // used to put on screen in place of anything a reader could act on.
  const timer = setTimeout(() => controller.abort(new Error(TIMED_OUT)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (external && typeof external.removeEventListener === 'function') external.removeEventListener('abort', abort);
  }
}

/**
 * Whether the periodic alarm still has something to do.
 *
 * Undelivered records are the obvious half. Open ChatGPT tabs are the other: while this
 * browser is holding chats, the app may need one of them reloaded — see maintain() — and this
 * alarm is the only thing that wakes a stopped service worker to ask. Both halves are work
 * this worker owes somebody, so they share the one alarm rather than growing a second.
 *
 * It is also what ends the cadence: the pass that finds nothing left to do arms nothing, and
 * the worker goes back to sleep until a page or the browser wakes it.
 */
function retryWanted() {
  // Paired at all is reason enough. The app hands out reopen/reload work only when this worker
  // asks for it, and after a browser restart this worker holds no tabs and no queues — which is
  // exactly when a Loop chat the user closed is waiting to be opened again. On 2026-09-02 a Loop
  // prime sat unopened for good because nothing here thought it had a reason to ask.
  return (
    token !== null ||
    journal.length > 0 ||
    closeOutbox.length > 0 ||
    commandAckOutbox.length > 0 ||
    deferredRevivals.length > 0 ||
    Object.keys(tabConversations).length > 0 ||
    Object.keys(discardProtectedTabs).length > 0 ||
    recoveryMonitoring
  );
}

function scheduleRetry() {
  if (!retryWanted()) return;
  if (retryAlarmScheduled) return;
  try {
    if (chrome.alarms && typeof chrome.alarms.create === 'function') {
      chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_PERIOD_MIN });
      retryAlarmScheduled = true;
    }
  } catch {
    // A later content-script message or browser lifecycle wake still retries.
  }
}

function clearRetryIfIdle() {
  if (retryWanted()) return;
  try {
    if (chrome.alarms && typeof chrome.alarms.clear === 'function') void chrome.alarms.clear(RETRY_ALARM);
    retryAlarmScheduled = false;
  } catch {
    // No alarms API in narrow test harnesses.
  }
}

async function hello(candidate) {
  try {
    const response = await fetchBounded(`http://127.0.0.1:${candidate}/hello`, {
      cache: 'no-store',
      headers: versionHeaders()
    }, HELLO_TIMEOUT_MS);
    if (!response.ok) return null;
    const body = await response.json();
    return body && body.app === 'chat-on-steroids' ? body : null;
  } catch {
    return null;
  }
}

/** Lets the app say plainly when the two halves are out of step. */
function versionHeaders() {
  let version = '0';
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    // Not worth failing a request over.
  }
  return { 'x-extension-version': version, 'x-extension-protocol': String(BRIDGE_PROTOCOL) };
}

/**
 * Finds the app, preferring the port that worked last time.
 *
 * A recent confirmation is believed rather than re-checked. The alternative was a
 * `/hello` in front of every authenticated request, which doubled the traffic of a poll
 * that already runs every two seconds in every open tab. Nothing is lost by it: a request
 * to a port the app has left fails, and a failure re-checks immediately.
 */
async function discover(force = false) {
  await load();
  if (port !== null && !force) {
    if (Date.now() - portCheckedAt < PORT_TRUST_MS) return { port, paired: token !== null, compatible: portCompatible !== false, version: appVersion, bridge: appProtocol };
    const body = await hello(port);
    if (body) {
      if (body.disconnected === true) await latchAppDisconnect();
      portCheckedAt = Date.now();
      portCompatible = body.compatible !== false && body.bridge === BRIDGE_PROTOCOL;
      appVersion = typeof body.version === 'string' ? body.version : null;
      appProtocol = Number.isFinite(Number(body.bridge)) ? Number(body.bridge) : null;
      return { port, paired: body.paired === true, compatible: portCompatible, version: appVersion, bridge: appProtocol };
    }
  }
  for (const candidate of PORTS) {
    const body = await hello(candidate);
    if (body) {
      if (body.disconnected === true) await latchAppDisconnect();
      port = candidate;
      portCheckedAt = Date.now();
      portCompatible = body.compatible !== false && body.bridge === BRIDGE_PROTOCOL;
      appVersion = typeof body.version === 'string' ? body.version : null;
      appProtocol = Number.isFinite(Number(body.bridge)) ? Number(body.bridge) : null;
      await persist();
      return { port: candidate, paired: body.paired === true, compatible: portCompatible, version: appVersion, bridge: appProtocol };
    }
  }
  port = null;
  portCheckedAt = 0;
  portCompatible = null;
  appVersion = null;
  appProtocol = null;
  await persist();
  return null;
}

/** Forgets that the app was ever confirmed, so the next call really looks. */
function forgetPort() {
  portCheckedAt = 0;
  portCompatible = null;
}

/**
 * Mirrors an explicit app-side Disconnect into this browser's own durable latch.
 *
 * `false` from the app is deliberately not authoritative here: this browser may itself have
 * been disconnected from the popup, and merely observing an app that is willing to pair is
 * not user intent to reconnect. Only an explicit successful pair clears the local latch.
 */
async function latchAppDisconnect() {
  token = null;
  disconnected = true;
  await persist();
}

/** One authenticated request. Returns { ok, status, data } and never throws. */
async function call(path, init = {}, retried = false) {
  await load();
  const found = await discover();
  if (!found) return { ok: false, status: 0, error: 'app_not_found' };
  if (found.compatible === false) return { ok: false, status: 426, error: 'incompatible_extension' };
  if (!token) {
    // Somebody disconnected this browser on purpose. Quietly getting a new token here is
    // how "Disconnect" came to mean "disconnect until the next poll".
    if (disconnected) return { ok: false, status: 401, error: 'disconnected' };
    // First use. Ask the app for a token instead of asking the user for one — see
    // provision() for why that is not a downgrade.
    const got = await provision();
    if (!got.ok) return { ok: false, status: 401, error: got.error || 'not_paired' };
  }
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = init;
  try {
    const response = await fetchBounded(
      `http://127.0.0.1:${found.port}${path}`,
      {
        ...rest,
        cache: 'no-store',
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...versionHeaders(),
          authorization: `Bearer ${token}`
        }
      },
      timeoutMs
    );
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      if (data && data.error === 'browser_disconnected') {
        await latchAppDisconnect();
        return { ok: false, status: 401, error: 'disconnected', data };
      }
      // Our token no longer matches the app's — it was reset, or the app's storage was
      // rebuilt. Drop ours and provision a new one once, rather than retrying forever
      // with a credential that will never work again or making the user do it by hand.
      token = null;
      await persist();
      if (retried) return { ok: false, status: 401, error: 'not_paired' };
      return call(path, init, true);
    }
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    const detail = String(err && err.message ? err.message : err);
    // A deadline disproves nothing about where the app is. It answered on this port, and the
    // request simply outlived the wait — so keep the port, and say so in a way the caller can
    // act on. Dropping it here made every slow answer cost a rediscovery as well.
    if (detail === TIMED_OUT) return { ok: false, status: 0, error: detail, retryable: true };
    // Anything else never reached anything, so the belief that the app is on this port is
    // exactly what has just been disproved. Next call looks properly.
    forgetPort();
    return { ok: false, status: 0, error: detail };
  }
}

/**
 * Gets this browser a bearer token, with nothing for the user to type.
 *
 * There used to be a six-digit code shown in the app and entered in the extension popup.
 * It bought nothing: the only callers that can reach the app at all are already on this
 * machine's loopback interface — the app refuses any web origin outright — so the code
 * was asking the user to prove something the network had already proved. What it did cost
 * was the first-run path, which failed until somebody found the popup.
 *
 * The token itself stays: it is what keeps a second local program from driving the bridge
 * by accident, and it is why the marker in a chat URL is harmless on its own.
 */
function provision(reconnect = false) {
  // Singleflight. Everything that wants a token waits on the same request: `/pair` mints
  // a fresh credential and invalidates the one before it, so two concurrent callers do
  // not get two tokens, they get one working token and one that has already been revoked.
  // A pairing from an *older* connection intent is deliberately not shared: Disconnect may
  // have happened while it was in flight, and a later explicit Connect must be able to mint
  // under the new intent without waiting for/accepting that stale result.
  const intent = connectionEpoch;
  if (pairing && pairingEpoch === intent && pairingReconnect === reconnect) return pairing;
  const work = pairOnce(intent, reconnect).then((result) => {
    pairingError = result && result.ok
      ? null
      : {
          error: result && result.error ? String(result.error) : 'pair_failed',
          message: result && result.message ? String(result.message) : ''
        };
    return result;
  });
  const tracked = work.finally(() => {
    if (pairing === tracked) {
      pairing = null;
      pairingEpoch = -1;
      pairingReconnect = false;
    }
  });
  pairing = tracked;
  pairingEpoch = intent;
  pairingReconnect = reconnect;
  return tracked;
}

async function pairOnce(intent = connectionEpoch, reconnect = false) {
  const found = await discover(true);
  if (!found) return { ok: false, error: 'app_not_found' };
  if (found.compatible === false) return { ok: false, error: 'incompatible_extension' };
  try {
    const response = await fetchBounded(`http://127.0.0.1:${found.port}/pair`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...versionHeaders() },
      body: JSON.stringify(reconnect ? { reconnect: true } : {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.token !== 'string') {
      if (data && data.error === 'browser_disconnected') {
        await latchAppDisconnect();
        return { ok: false, error: 'disconnected', message: data.message };
      }
      return { ok: false, error: data.error || `HTTP ${response.status}`, message: data.message };
    }
    // The response belongs to the connection state that launched it. A newer Disconnect is
    // authoritative and must not be undone just because the network answered out of order.
    if (intent !== connectionEpoch) return { ok: false, error: 'disconnected' };
    token = data.token;
    // Connecting is the counterpart of disconnecting, and the only thing that clears it.
    disconnected = false;
    await persist();
    scheduleRetry();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// -------------------------------------------------------------------- commands

/**
 * Fetches the one command a marked page was opened for.
 *
 * Redeeming by id is what replaced the single global "pending bootstrap" slot. That slot
 * was consumed by whichever fresh tab asked first, so a tab that came up before the slot
 * was filled got nothing and never asked again, while a later unrelated tab could take a
 * bootstrap meant for something else. An id in the URL cannot be taken by the wrong page,
 * survives the tab being reloaded, and can be asked for as many times as it takes.
 *
 * The app answers 404 for a command that has been cancelled, superseded, or already
 * sent, so a stale marker types nothing.
 */
async function redeemCommand(id, client, conversationId = null) {
  await load();
  if (!id || settled.includes(id)) return { ok: true, command: null };
  const body = { id, client };
  if (typeof conversationId === 'string' && conversationId) body.conversationId = conversationId;
  const result = await call('/commands/redeem', { method: 'POST', body: JSON.stringify(body) });
  if (result.status === 404) return { ok: true, command: null, gone: true };
  // Another page already owns this command. Not an error to report: this page simply is not
  // the one the app is talking to, and it must type nothing.
  if (result.status === 409) return { ok: true, command: null, gone: true };
  if (!result.ok) return { ok: false, error: result.error || `HTTP ${result.status}` };
  const command = result.data && result.data.command ? result.data.command : null;
  return { ok: true, command };
}

function commandAckPayload(id, status, error, conversationId, agent, client) {
  return {
    id,
    status,
    error: error || undefined,
    conversationId: conversationId || undefined,
    agent: agent || undefined,
    client: client || undefined
  };
}

/**
 * Retries command ACKs independently of command redemption or page lifetime.
 *
 * 404/409 are terminal ownership answers from the current bridge contract: the command no
 * longer exists or another document owns it, so replaying the same result can never apply it.
 * Transport failures, throttling, auth repair and 426 incompatibility remain queued. A later
 * compatible app/extension pair can therefore finish an ACK that was already durable here.
 */
async function drainCommandAcks(targetId = null) {
  await load();
  if (ackingCommands || commandAckOutbox.length === 0 || !token) {
    return { ok: true, pending: commandAckOutbox.length, queued: commandAckOutbox.length > 0 };
  }
  ackingCommands = true;
  let targetResult = null;
  let changed = false;
  try {
    for (const entry of [...commandAckOutbox]) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) {
        commandAckOutbox = commandAckOutbox.filter((candidate) => candidate !== entry);
        changed = true;
        continue;
      }
      const payload = commandAckPayload(
        entry.id,
        entry.status === 'failed' ? 'failed' : 'sent',
        entry.error,
        entry.conversationId,
        entry.agent,
        entry.client
      );
      const result = await call('/commands/ack', { method: 'POST', body: JSON.stringify(payload) });
      if (entry.id === targetId) targetResult = result;

      if (result.ok || result.status === 404 || result.status === 409) {
        commandAckOutbox = commandAckOutbox.filter((candidate) => candidate !== entry);
        changed = true;
        if (result.ok && result.data?.committed !== false && payload.status === 'sent' && !payload.agent) {
          // The app is authoritative. Settling before its ACK made a transient rejection
          // blacklist a valid superseding resume command for the rest of the browser session.
          settled = [...new Set([...settled, payload.id])].slice(-40);
        }
        continue;
      }

      // A normalized current payload should not get a permanent 4xx other than the ownership
      // answers above. Do not spin forever if the bridge explicitly rejects one, but preserve
      // the statuses that can become valid after auth/version/backoff recovery.
      if (result.status >= 400 && result.status < 500 && ![401, 408, 426, 429].includes(result.status)) {
        commandAckOutbox = commandAckOutbox.filter((candidate) => candidate !== entry);
        changed = true;
        continue;
      }
      scheduleRetry();
      break;
    }
    if (changed) await persistLive();
    if (commandAckOutbox.length > 0) scheduleRetry();
    else clearRetryIfIdle();
    if (targetResult) return { ...targetResult, pending: commandAckOutbox.length };
    return { ok: true, pending: commandAckOutbox.length, queued: commandAckOutbox.length > 0 };
  } finally {
    ackingCommands = false;
  }
}

async function ackCommand(id, status, error, conversationId, agent, client, source = null) {
  await load();
  if (!id) return { ok: false, status: 400, error: 'bad_command_id' };
  const payload = commandAckPayload(id, status, error, conversationId, agent, client);
  const queued = {
    ...payload,
    provisional: payload.conversationId ? null : tabKey(source),
    queuedAt: Date.now()
  };
  // One command has one terminal page result. Replace an earlier replay copy rather than
  // allowing duplicate storage entries to race each other after a worker restart.
  commandAckOutbox = [...commandAckOutbox.filter((entry) => entry && entry.id !== id), queued].slice(-200);
  // Durability is established before any network attempt. If storage itself fails the message
  // handler rejects and the page is told truthfully that this worker did not take custody.
  await persistLive();
  scheduleRetry();
  return drainCommandAcks(id);
}

/**
 * Bounded app command identity, shared by every marker this worker handles.
 *
 * Inert on its own: a command id names a row in the app's queue and proves nothing. Redeeming
 * it still requires the pairing bearer token, which is why a marker may travel in a URL.
 */
function commandMarkerId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 128 ? id : null;
}

/**
 * Requested ChatGPT model slug for a worker's fresh chat, or null for the account default.
 *
 * Same vocabulary the app enforces: anything shaped like a slug passes through to the open
 * URL, anything else is dropped here rather than typed into a URL. An unknown slug is
 * ChatGPT's to ignore — the chat then opens with the default.
 */
function commandModelSlug(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  return model && /^[A-Za-z0-9._-]{1,80}$/.test(model) ? model : null;
}

function deferredRevivalId(value) {
  return commandMarkerId(value);
}

async function rememberDeferredRevival(idValue, conversationValue) {
  await load();
  const id = deferredRevivalId(idValue);
  const conversationId = cleanConversationId(conversationValue);
  if (!id || !conversationId) return false;
  if (deferredRevivals.some((entry) => entry?.id === id && cleanConversationId(entry.conversationId) === conversationId)) {
    return true;
  }
  // There can only be one not-yet-redeemed wake for one existing conversation. Seeing a newer
  // marker for the same chat is app-side proof that an older extension-only recovery marker is
  // obsolete. Keeping both is worse than redundant: recoverDeferredRevivals() can put the old
  // marker into the exact document's pre-redeem wait and make the current wake bounce off `busy`.
  const retiredIds = deferredRevivals
    .filter((entry) => entry && entry.id !== id && cleanConversationId(entry.conversationId) === conversationId)
    .map((entry) => deferredRevivalId(entry.id))
    .filter(Boolean);
  for (const retiredId of retiredIds) {
    deferredRevivalOffers.delete(retiredId);
  }
  deferredRevivals = [
    ...deferredRevivals.filter(
      (entry) =>
        entry &&
        entry.id !== id &&
        cleanConversationId(entry.conversationId) !== conversationId
    ),
    { id, conversationId, queuedAt: Date.now() }
  ].slice(-100);
  await persistLive();
  return true;
}

async function forgetDeferredRevival(idValue) {
  await load();
  const id = deferredRevivalId(idValue);
  if (!id) return false;
  const before = deferredRevivals.length;
  deferredRevivals = deferredRevivals.filter((entry) => entry && entry.id !== id);
  deferredRevivalOffers.delete(id);
  if (deferredRevivals.length !== before) await persistLive();
  return deferredRevivals.length !== before;
}

/**
 * A stable key for the tab an observation came from.
 *
 * The tab id, not the page: it survives a reload, which is exactly the window where an
 * un-bound observation would otherwise be lost. Falls back to a per-worker constant if
 * Chrome does not name the sender, which only costs precision when several fresh chats
 * are opened at once and never misfiles anything that already has a conversation id.
 */
function tabKey(source) {
  return source && Number.isInteger(source.tab) && source.documentId
    ? `tab-${source.tab}:${source.documentId}`
    : 'tab-unknown';
}

function reloadProvisionalKey(tab) {
  return Number.isInteger(tab) ? `reload-tab-${tab}` : null;
}

async function carryFreshReloadProvisional(tab, documentId) {
  if (!Number.isInteger(tab) || !documentId) return 0;
  const from = `tab-${tab}:${documentId}`;
  const to = reloadProvisionalKey(tab);
  if (!to) return 0;
  let moved = 0;
  for (const entry of journal) {
    if (!entry || entry.conversationId || entry.provisional !== from) continue;
    entry.provisional = to;
    sizeCache.delete(entry);
    moved++;
  }
  let ackMoved = 0;
  for (const entry of commandAckOutbox) {
    if (!entry || entry.conversationId || entry.provisional !== from) continue;
    entry.provisional = to;
    ackMoved++;
  }
  if (moved > 0) await persistJournal();
  if (ackMoved > 0) await persistLive();
  return moved + ackMoved;
}

async function adoptFreshReloadProvisional(tab, documentId) {
  if (!Number.isInteger(tab) || !documentId) return 0;
  const from = reloadProvisionalKey(tab);
  if (!from) return 0;
  const to = `tab-${tab}:${documentId}`;
  let moved = 0;
  for (const entry of journal) {
    if (!entry || entry.conversationId || entry.provisional !== from) continue;
    entry.provisional = to;
    sizeCache.delete(entry);
    moved++;
  }
  let ackMoved = 0;
  for (const entry of commandAckOutbox) {
    if (!entry || entry.conversationId || entry.provisional !== from) continue;
    entry.provisional = to;
    ackMoved++;
  }
  if (moved > 0) await persistJournal();
  if (ackMoved > 0) await persistLive();
  return moved + ackMoved;
}

function tabId(sender) {
  return sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
}

function senderDocument(sender) {
  if (!sender || (sender.frameId !== undefined && sender.frameId !== 0)) return null;
  return typeof sender.documentId === 'string' && sender.documentId.length > 0 ? sender.documentId : null;
}

function messageEpoch(message) {
  const value = Number(message && message.navigationEpoch);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Whether a terminal lease was a wrong prediction about a document that is still running.
 *
 * `markTerminal` is speculative by construction: it fires from `chrome.tabs.onUpdated`
 * the moment Chrome says a navigation is *starting*, and stamps whichever document the tab
 * currently holds. The design then assumed a replacement document would always arrive and
 * clear the stamp. When one does not — an aborted navigation, a redirect that reports a
 * second `loading` after the replacement has already registered, a soft route change, a
 * prerender that never commits — the stamp lands on the tab's own live document, and from
 * then on `authorizeDocument` answers `tab_closed` to every message it sends while
 * `registerDocument` answers `tab_closed` to its attempt to re-register. Nothing in the
 * browser could clear it, so the tab kept reading ChatGPT perfectly and delivered none of
 * it until the user happened to reload. That is the 2026-08-21 blackout: a live tab whose
 * request-id evidence never reached the app, so `agents action=spawn` was refused with
 * UNIDENTIFIED_CALLER while the popup showed the request id it had already read.
 *
 * A message arriving here is itself the disproof. Chrome does not deliver `runtime.sendMessage`
 * from a document that no longer exists, so an inbound message from the tab's *current*
 * document means that document is alive; a tab that really went away fails `tabs.get`, and a
 * document that really was replaced is barred by `retiredDocuments`, which this never touches.
 * Only the speculative half of the lease is given up.
 */
async function terminalPredictionWrong(id, key, documentId) {
  if (!Object.prototype.hasOwnProperty.call(terminalDocuments, key)) return false;
  if (typeof tabDocuments[key] !== 'string' || tabDocuments[key] !== documentId) return false;
  let tab = null;
  try {
    tab = await chrome.tabs.get(id);
  } catch {
    return false;
  }
  if (!tab || !isChatGptUrl(tab.url)) return false;
  // A document can still send extension IPC during the overlap between navigation starting
  // and Chrome replacing that document. In that window tabs.get() may already describe the
  // destination ChatGPT URL, so the message proves only that the old document is *dying*, not
  // that the loading event was a false terminal prediction. Reopen the lease only after
  // Chrome itself says the tab is settled and has no destination still pending.
  if (tab.status === 'loading') return false;
  if (typeof tab.pendingUrl === 'string' && tab.pendingUrl !== '') return false;
  return true;
}

/**
 * Establishes one current browser document per tab from Chrome's MessageSender authority.
 *
 * A body field would be page-controlled and is not accepted. A different document can take
 * over a live tab (reload/update) and retires the old id permanently. A terminal lease still
 * rejects delayed IPC from a dying document and a document that was actually superseded;
 * what it no longer does is outlive the live document it was wrongly stamped on — see
 * `terminalPredictionWrong`.
 */
async function authorizeDocument(sender, message) {
  await load();
  const id = tabId(sender);
  const documentId = senderDocument(sender);
  if (id === null || !documentId) return { ok: false, error: 'document_identity_missing' };
  const key = String(id);
  const retired = Array.isArray(retiredDocuments[key]) ? retiredDocuments[key] : [];
  if (retired.includes(documentId)) return { ok: false, error: 'stale_document' };
  const current = typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null;
  const requestedEpoch = messageEpoch(message);
  const currentEpoch = Number.isSafeInteger(tabEpochs[key]) ? tabEpochs[key] : 0;
  let terminal = Object.prototype.hasOwnProperty.call(terminalDocuments, key);
  if (terminal && (await terminalPredictionWrong(id, key, documentId))) {
    delete terminalDocuments[key];
    terminal = false;
    await persistLive();
  }
  if (terminal) {
    return { ok: false, error: !current || current === documentId ? 'tab_closed' : 'document_unregistered' };
  }
  if (current === documentId && !terminal) {
    if (requestedEpoch < currentEpoch) return { ok: false, error: 'stale_navigation' };
    if (requestedEpoch > currentEpoch) {
      tabEpochs[key] = requestedEpoch;
      await persistLive();
    }
    return { ok: true, tab: id, documentId, navigationEpoch: requestedEpoch };
  }
  if (current && current !== documentId) {
    retiredDocuments[key] = [...new Set([...retired, current])].slice(-8);
  }
  tabDocuments[key] = documentId;
  tabEpochs[key] = requestedEpoch;
  delete terminalDocuments[key];
  await persistLive();
  return { ok: true, tab: id, documentId, navigationEpoch: requestedEpoch };
}

async function registerDocument(sender, message) {
  await load();
  const id = tabId(sender);
  const documentId = senderDocument(sender);
  if (id === null || !documentId) return { ok: false, error: 'document_identity_missing' };
  const key = String(id);
  const retired = Array.isArray(retiredDocuments[key]) ? retiredDocuments[key] : [];
  if (retired.includes(documentId)) return { ok: false, error: 'stale_document' };
  const current = typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null;
  const requestedEpoch = messageEpoch(message);
  const terminal = Object.prototype.hasOwnProperty.call(terminalDocuments, key);
  // Same rule as authorizeDocument, and it matters more here: this is the one message type
  // that bypasses authorization, so it is the only way a live document that was wrongly
  // retired can ever come back. Refusing it on the lease alone is what made the blackout
  // permanent — content.js re-sends `register_document` on every failure and simply got the
  // same `tab_closed` forever.
  if (terminal && current === documentId && !(await terminalPredictionWrong(id, key, documentId))) {
    return { ok: false, error: 'tab_closed' };
  }
  if (current && current !== documentId) await adoptFreshReloadProvisional(id, documentId);
  if (current && current !== documentId) retiredDocuments[key] = [...new Set([...retired, current])].slice(-8);
  tabDocuments[key] = documentId;
  tabEpochs[key] = requestedEpoch;
  delete terminalDocuments[key];
  await persistLive();
  return { ok: true, tab: id, documentId, navigationEpoch: requestedEpoch };
}

function ownsDocument(source) {
  if (!source || !Number.isInteger(source.tab) || !source.documentId) return false;
  const key = String(source.tab);
  return (
    tabDocuments[key] === source.documentId &&
    (!Number.isSafeInteger(source.navigationEpoch) || tabEpochs[key] === source.navigationEpoch) &&
    !Object.prototype.hasOwnProperty.call(terminalDocuments, key) &&
    !(Array.isArray(retiredDocuments[key]) && retiredDocuments[key].includes(source.documentId))
  );
}

async function markTerminal(id) {
  await load();
  const key = String(id);
  const documentId = typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null;
  terminalDocuments[key] = documentId;
  // Do not purge provisional fresh-chat observations here. A full ChatGPT reload is a document
  // boundary too, and onUpdated deliberately calls markTerminal() before it knows whether the
  // replacement document is the same chat. releaseTab() owns the destructive purge because it
  // runs only after the tab actually closes or concretely leaves ChatGPT.
  await persistLive();
  return documentId;
}

function cleanConversationId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[0-9a-f-]{8,64}$/i.test(id) ? id : null;
}

/**
 * The mode a goal was written under, as a body fragment or nothing at all.
 *
 * Two words are legal and everything else is silently absent rather than passed on, because
 * the app pins whatever arrives here as a durable per-chat switch. Absent is a real answer:
 * it means "this page named no mode", which leaves the standing switch deciding exactly as
 * it did before the two buttons existed.
 */
function goalMode(message) {
  const mode = message && typeof message.mode === 'string' ? message.mode : '';
  return mode === 'goal' || mode === 'loop' ? { mode } : {};
}

/** Records a tab's current conversation without writing storage on every poll. */
async function noteTabConversation(source, value) {
  const id = source && Number.isInteger(source.tab) ? source.tab : null;
  const conversationId = cleanConversationId(value);
  if (id === null || !conversationId) return false;
  if (!ownsDocument(source)) return false;
  const key = String(id);
  if (tabConversations[key] === conversationId) return false;
  const previous = cleanConversationId(tabConversations[key]);
  tabConversations[key] = conversationId;
  await persistLive();
  scheduleRetry();
  if (!ownsDocument(source)) return false;
  // A same-tab full navigation is not a close until the replacement document proves it is
  // a different conversation. This keeps ordinary reloads alive while still retiring A
  // when the new document eventually binds B.
  if (previous && previous !== conversationId && !conversationStillOpen(previous)) {
    await drain();
    await enqueueClose(previous);
    await drainCloses();
  }
  return true;
}

/**
 * Asks the app whether one of the chats this browser is holding needs putting back together.
 *
 * The app can prove that a chat's local tool calls have stopped being attributable to it —
 * usually that document's own reporting died mid-turn — but it cannot do anything about it:
 * the page it would instruct is the page that stopped listening, and opening the url would
 * make a second tab of a chat that is still on screen. This worker can, because the tab
 * registry here is the authority on which tab that chat is in, so the app hands out the
 * conversation id and nothing else and this decides whether there is a tab to reload.
 *
 * A match reloads, and never more than one tab of a chat exists afterwards: several copies are
 * resolved to the one this registry binds, not left alone. None opens the exact conversation.
 * The scan
 * happens immediately before the action; the content-script registry alone is too stale to
 * prevent duplicates. Only a browser action that actually happened is reported, because only
 * that is worth placing behind the app's per-chat cooldown.
 */
async function maintain() {
  // The app decides whether there is recovery work; a worker holding no tabs is not a worker
  // with nothing to do, it is the one that has to open the chat the app is owed.
  if (token === null) return;
  const reply = await call('/status');
  if (!reply.ok || !reply.data) return;
  const monitoring = reply.data.recoveryMonitoring === true;
  if (monitoring !== recoveryMonitoring) {
    recoveryMonitoring = monitoring;
    await persistLive().catch(() => undefined);
  }
  if (await acceptBrowserRevival(reply.data.revival)) await recoverDeferredRevivals();
  // Quoted back exactly as they arrived. A token names the handout being answered, so that a
  // receipt this pass sends late cannot close a repair the app has since raised for a different
  // turn. An entry missing either half is not actionable and is dropped rather than guessed at.
  const repairs = (Array.isArray(reply.data.repairs) ? reply.data.repairs : [])
    .map((entry) => ({
      conversationId: cleanConversationId(entry && entry.conversationId),
      token: entry && typeof entry.token === 'string' ? entry.token : '',
      focus: Boolean(entry && entry.focus === true)
    }))
    .filter((entry) => entry.conversationId && entry.token);
  const nonDiscardable = new Set(
    (Array.isArray(reply.data.nonDiscardableConversations) ? reply.data.nonDiscardableConversations : [])
      .map(cleanConversationId)
      .filter(Boolean)
  );
  const protectionWork = nonDiscardable.size > 0 || Object.keys(discardProtectedTabs).length > 0;
  // Chats the app has finished with: compacted source chats and stopped worker chats beyond
  // the ones the prime is likely to come back to. Their tabs are memory and nothing else.
  const closable = new Set(
    (Array.isArray(reply.data.closableConversations) ? reply.data.closableConversations : [])
      .map(cleanConversationId)
      .filter((conversationId) => conversationId && !nonDiscardable.has(conversationId))
  );
  if (!protectionWork && closable.size === 0 && repairs.length === 0) return clearRetryIfIdle();
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
  } catch {
    return;
  }
  if (closable.size > 0) {
    const remaining = [];
    for (const tab of tabs) {
      // The tab in front of the user is theirs to close, whatever the app thinks of the chat.
      if (!Number.isInteger(tab && tab.id) || tab.active === true || !closable.has(conversationForTab(tab))) {
        remaining.push(tab);
        continue;
      }
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // Already gone, or Chrome refused; onRemoved or the next pass reconciles it.
        remaining.push(tab);
      }
    }
    tabs = remaining;
  }
  if (protectionWork) {
    let changed = false;
    for (const tab of tabs) {
      if (!Number.isInteger(tab && tab.id)) continue;
      const key = String(tab.id);
      const ours = discardProtectedTabs[key] === true;
      const protect = nonDiscardable.has(conversationForTab(tab));
      if (protect && tab.autoDiscardable !== false) {
        try {
          await chrome.tabs.update(tab.id, { autoDiscardable: false });
          if (!ours) {
            discardProtectedTabs[key] = true;
            changed = true;
          }
        } catch {
          // The tab changed after the scan. Its lifecycle event or the next pass reconciles it.
        }
      } else if (!protect && ours) {
        try {
          await chrome.tabs.update(tab.id, { autoDiscardable: true });
          delete discardProtectedTabs[key];
          changed = true;
        } catch {
          // Keep ownership so a transient failure cannot leave the tab protected forever.
        }
      }
    }
    if (changed) await persistLive().catch(() => undefined);
  }
  if (repairs.length === 0) return clearRetryIfIdle();
  for (const { conversationId, token, focus } of repairs) {
    // Re-scanned per repair rather than reused from above. Earlier entries in this same batch
    // may have created a tab, and the scan has to be the state immediately before the action or
    // the duplicate rule below is deciding on a tab list that no longer exists.
    let live = [];
    try {
      live = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
    } catch {
      return;
    }
    const candidates = live.filter((tab) => conversationForTab(tab) === conversationId);
    // One chat is one tab. Bailing out on two copies left the chat broken *and* left the
    // duplicate sitting there, so the ambiguity is resolved instead: reload the copy this
    // worker's registry already binds to the conversation, falling back to the lowest tab id so
    // two passes never pick differently. A tab is only ever created when the chat has none.
    const owned = candidates.filter((tab) => tabConversations[tab.id] === conversationId);
    const [target] = (owned.length > 0 ? owned : candidates).sort((a, b) => a.id - b.id);
    const repairAction = target ? 'reloaded' : 'reopened';
    try {
      // A repair the app wants in front of the user — an automatic compaction's pickup — raises
      // the tab and its window before acting. A background tab is a throttled tab, and the
      // page this reload brings back has tens of seconds of work to do in it.
      if (target && focus) {
        await chrome.tabs.update(target.id, { active: true });
        if (typeof target.windowId === 'number') await chrome.windows.update(target.windowId, { focused: true });
      }
      if (target) await chrome.tabs.reload(target.id);
      else {
        await chrome.tabs.create({ url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`, active: focus });
      }
    } catch {
      // A tab changed between the scan and action, or Chrome refused it. Report the exact failed
      // handout so the app can show the failure while keeping the same repair retryable. The
      // rest of the batch is unaffected: these are separate chats and separate failures.
      await call(`/status?repairFailed=${encodeURIComponent(token)}&repairAction=${repairAction}`);
      continue;
    }
    await call(`/status?repaired=${encodeURIComponent(token)}&repairAction=${repairAction}`);
  }
}

function conversationStillOpen(conversationId) {
  return Object.values(tabConversations).some((value) => value === conversationId);
}

async function enqueueClose(conversationId) {
  const id = cleanConversationId(conversationId);
  if (!id) return false;
  // One status pass after the final tab closes lets the app decide whether that exact chat is
  // an active agent needing a reopen. The pass clears this again when it is ordinary history.
  recoveryMonitoring = true;
  if (!closeOutbox.some((entry) => entry && entry.conversationId === id)) {
    closeOutbox.push({ conversationId: id, queuedAt: Date.now() });
    closeOutbox = closeOutbox.slice(-200);
    await persistLive();
  }
  scheduleRetry();
  return true;
}

async function drainCloses() {
  await load();
  if (closing || closeOutbox.length === 0 || !token) return { ok: true, pending: closeOutbox.length };
  closing = true;
  let changed = false;
  try {
    for (const entry of [...closeOutbox]) {
      const conversationId = cleanConversationId(entry && entry.conversationId);
      if (!conversationId) {
        closeOutbox = closeOutbox.filter((candidate) => candidate !== entry);
        changed = true;
        continue;
      }
      if (conversationStillOpen(conversationId)) continue;
      const result = await call('/closed', {
        method: 'POST',
        body: JSON.stringify({ conversationId })
      });
      if (!result.ok) {
        scheduleRetry();
        break;
      }
      closeOutbox = closeOutbox.filter((candidate) => candidate !== entry);
      changed = true;
    }
    if (changed) await persistLive();
    clearRetryIfIdle();
    return { ok: true, pending: closeOutbox.length };
  } finally {
    closing = false;
  }
}

/**
 * Removes one tab's ownership and closes the app-side conversation only if it was last.
 *
 * `expected` protects an old page's delayed close from deleting a mapping that the same
 * tab has already replaced with a new conversation.
 */
async function releaseTab(tab, expected = null, expectedDocument = null, expectedEpoch = null) {
  await load();
  if (typeof tab !== 'number') return { ok: true, closed: false };
  const key = String(tab);
  const stillOwned = () =>
    (!expectedDocument || tabDocuments[key] === expectedDocument) &&
    (!Number.isSafeInteger(expectedEpoch) || tabEpochs[key] === expectedEpoch);
  if (!stillOwned()) return { ok: true, closed: false };
  // A fresh chat can have durable provisional observations before ChatGPT assigns /c/<id>.
  // Once this browser tab concretely leaves ChatGPT (or closes), those observations cannot be
  // safely rebound to a later unrelated chat that happens to reuse the same tab id.
  const provisional = expectedDocument ? `tab-${tab}:${expectedDocument}` : null;
  const reloadProvisional = reloadProvisionalKey(tab);
  const beforeJournal = journal.length;
  journal = journal.filter(
    (entry) =>
      (!provisional || entry.provisional !== provisional) &&
      (!reloadProvisional || entry.provisional !== reloadProvisional)
  );
  if (journal.length !== beforeJournal) await persistJournal();
  if (!stillOwned()) return { ok: true, closed: false };
  const current = cleanConversationId(tabConversations[key]);
  const wanted = cleanConversationId(expected);
  const protectedHere = discardProtectedTabs[key] === true;
  if (current && (!wanted || current === wanted)) {
    delete tabConversations[key];
  }
  if (protectedHere) {
    try {
      await chrome.tabs.update(tab, { autoDiscardable: true });
    } catch {
      // A closed tab needs no restoration; navigation races are reconciled on the next pass.
    }
    delete discardProtectedTabs[key];
  }
  if ((current && (!wanted || current === wanted)) || protectedHere) await persistLive();
  if (!stillOwned()) return { ok: true, closed: false };
  const conversationId = wanted || current;
  if (!conversationId || conversationStillOpen(conversationId)) {
    return { ok: true, closed: false };
  }
  // Deliver anything still queued before telling the app the final browser view is gone.
  await drain();
  if (!stillOwned() || conversationStillOpen(conversationId)) return { ok: true, closed: false };
  await enqueueClose(conversationId);
  const delivered = await drainCloses();
  // Collect `/closed`'s exact no-tab repair before an old async alarm clear can erase its fallback.
  if (delivered.pending === 0) await maintain();
  return { ok: true, closed: delivered.pending === 0, pendingClose: delivered.pending };
}

function conversationFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || (url.hostname !== 'chatgpt.com' && url.hostname !== 'chat.openai.com')) return null;
    // Matches chatgpt-dom.js: a Project conversation is `/g/<project>/c/<id>`, while
    // `/share/c/<id>` is a public snapshot the service worker must never bind a tab to.
    const match = /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(url.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function isChatGptUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com');
  } catch {
    return false;
  }
}

/** Serializes every ownership transition and owned side effect for one browser tab. */
const tabOperationQueues = new Map();

function serializeTab(tab, operation) {
  if (!Number.isInteger(tab)) return operation();
  const prior = tabOperationQueues.get(tab) || Promise.resolve();
  const current = prior.then(operation, operation);
  const tracked = current.finally(() => {
    if (tabOperationQueues.get(tab) === tracked) tabOperationQueues.delete(tab);
  });
  tabOperationQueues.set(tab, tracked);
  return tracked;
}

const HANDLERS = {
  async register_document(_message, sender) {
    const result = await registerDocument(sender, _message);
    if (result && result.ok === true) void recoverDeferredRevivals().catch(() => undefined);
    return result;
  },
  async status() {
    await load();
    const found = await discover();
    // Provisioning here as well as in call() is what makes the popup show "Connected"
    // the first time it is opened, rather than a truthful but useless "not paired".
    // Not after a deliberate disconnect: opening the popup to check is not a request to
    // undo the thing the popup was opened to check.
    if (found && !token && !disconnected) await provision();
    if (found && token) {
      void drainCommandAcks()
        .then(() => drain())
        .then(() => drainCloses())
        .catch(() => undefined);
    }
    return {
      connected: found !== null,
      port: found ? found.port : null,
      paired: token !== null,
      disconnected,
      pending: journal.length,
      pendingCommandAcks: commandAckOutbox.length,
      compatible: found ? found.compatible !== false : null,
      appVersion: found ? found.version : null,
      appProtocol: found ? found.bridge : null,
      extensionVersion: chrome.runtime.getManifest().version,
      extensionProtocol: BRIDGE_PROTOCOL,
      ...(pairingError ? { pairError: pairingError } : {})
    };
  },
  async pair() {
    await load();
    // This message exists only behind the popup's Connect/Retry control. Advance the intent
    // generation so an older silent provision already on the wire cannot win after this
    // explicit reconnect, then tell the app this /pair is allowed to clear its durable latch.
    connectionEpoch++;
    const result = await provision(true);
    if (result && result.ok) {
      void drainCommandAcks()
        .then(() => drain())
        .then(() => drainCloses())
        .catch(() => undefined);
    }
    return result;
  },
  async unpair() {
    await load();
    // Invalidate any `/pair` already on the wire before changing the visible/persisted state.
    connectionEpoch++;
    token = null;
    // Remembered, not just cleared. Otherwise the next request — two seconds away in any
    // open tab — provisions a new token and the browser is connected again.
    disconnected = true;
    pairingError = null;
    await persist();
    return { ok: true };
  },
  /** Ask every eligible ChatGPT tab to rebuild its Chat On Steroids activity stream now. */
  async overwriteNow() {
    await load();
    const known = Object.keys(tabConversations)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value));
    // The registry is authoritative for session lifetime, but it is populated only after a
    // page has bound/observed something. A valid ChatGPT tab can therefore be absent at the
    // exact moment the user turns Overwrite on. Discover the same host allowlist used by
    // extension-reload recovery and union it with the durable registry. Host permissions in
    // manifest.json already authorize URL-filtered tabs.query on these origins.
    let discovered = [];
    try {
      discovered = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
    } catch {
      discovered = [];
    }
    const tabs = [
      ...new Set([
        ...known,
        ...discovered
          .map((tab) => (tab && typeof tab.id === 'number' ? tab.id : NaN))
          .filter((value) => Number.isInteger(value))
      ])
    ];
    let applied = 0;
    for (const id of tabs) {
      try {
        const result = await chrome.tabs.sendMessage(id, { type: 'clf-overwrite-now' });
        if (result && result.ok === true) applied += 1;
      } catch {
        // A tab may be between navigations/reloads and temporarily have no receiver. The
        // registry is tab-lifetime state, so do not retire it merely because one send raced.
      }
    }
    return { ok: true, tabs: applied, attempted: tabs.length };
  },
  /**
   * Everything this worker and the visible page know about the chat in front of the user.
   *
   * Read-only and popup-only. It exists because the three questions people actually have
   * — did it pick up this chat, what is the chat called, is anything reaching the app —
   * were previously unanswerable without opening the app's log next to the browser's.
   */
  async tabStatus() {
    await load();
    let active = null;
    try {
      const found = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      active = found && found.length > 0 ? found[0] : null;
    } catch {
      active = null;
    }
    const tab = active && typeof active.id === 'number' ? active.id : null;
    const key = tab === null ? null : String(tab);
    const isChat = isChatGptUrl(active && active.url);
    const bound = key ? cleanConversationId(tabConversations[key]) : null;
    const documentId = key && typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null;
    const provisional = tab !== null && documentId ? `tab-${tab}:${documentId}` : null;
    const terminal = key ? Object.prototype.hasOwnProperty.call(terminalDocuments, key) : false;

    let page = null;
    if (tab !== null && isChat) {
      try {
        page = await chrome.tabs.sendMessage(tab, { type: 'clf-page-status' });
      } catch {
        // No live recorder in that document: an unreloaded tab from before this extension
        // was loaded, or a page still starting up. Reported as such rather than as an error.
        page = null;
      }
    }

    let chatTabs = 0;
    try {
      chatTabs = (await chrome.tabs.query({ url: CHATGPT_TAB_URLS })).length;
    } catch {
      chatTabs = 0;
    }

    const conversationId = bound || (page && cleanConversationId(page.conversationId)) || conversationFromUrl(active && active.url);
    return {
      tab,
      isChat,
      url: isChat ? String((active && active.url) || '') : null,
      conversationId,
      bound: bound !== null,
      documentId,
      epoch: key && Number.isSafeInteger(tabEpochs[key]) ? tabEpochs[key] : null,
      terminal,
      recorder: page !== null,
      page,
      chatTabs,
      pending: journal.filter(
        (entry) =>
          (conversationId && entry.conversationId === conversationId) ||
          (provisional && entry.provisional === provisional)
      ).length,
      pendingAll: journal.length,
      pendingCloses: closeOutbox.length,
      pendingCommandAcks: commandAckOutbox.length,
      delivery
    };
  },
  /**
   * Takes observations off a content script's hands.
   *
   * Answering ok means "journalled here", not "the app has it". That is the point: the
   * page can be reloaded a moment later, and this worker will keep retrying delivery.
   * Entries with no conversation id yet are journalled too, under the tab that saw
   * them, so the very first message of a fresh chat is durable before ChatGPT has
   * decided what to call the conversation.
   */
  async events(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    await noteTabConversation(source, message.conversationId);
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const key = tabKey(source);
    const entries = (Array.isArray(message.entries) ? message.entries : []).map((entry) =>
      entry && !entry.conversationId ? { ...entry, provisional: key } : entry
    );
    enqueue(entries);
    let ackBound = 0;
    if (message.conversationId) {
      bindProvisional(key, message.conversationId);
      ackBound = bindCommandAckProvisional(key, message.conversationId);
    }
    const stored = await persistJournal();
    if (ackBound > 0) await persistLive();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    if (ackBound > 0) await drainCommandAcks();
    const result = await drain();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    return { ok: true, pending: result.pending, durable: stored };
  },

  /**
   * The tab now knows which conversation it is in.
   *
   * Everything it observed beforehand belongs to that conversation, including anything
   * journalled during a page load that happened before the id existed — the tab key
   * survives a reload, which is the whole reason it is the tab and not the page.
   */
  async bind(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    await noteTabConversation(source, message.conversationId);
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const key = tabKey(source);
    const bound = bindProvisional(key, String(message.conversationId || ''));
    const ackBound = bindCommandAckProvisional(key, String(message.conversationId || ''));
    if (bound > 0) {
      await persistJournal();
    }
    if (ackBound > 0) await persistLive();
    if (ackBound > 0) await drainCommandAcks();
    if (bound > 0) await drain();
    return { ok: true, bound, ackBound };
  },
  async drain() {
    return drain();
  },
  /**
   * Registers exact request-id ownership for the currently live ChatGPT turn.
   *
   * Unlike normal transcript events this is an acknowledged identity operation: the app
   * creates/reuses the conversation session, stores the request-id join, reads it back, and
   * tells the page which ids are actually confirmed. content.js retries unconfirmed ids on a
   * later Fiber scan, so a sleeping worker/app can delay attribution but cannot silently turn a
   * known request into a permanent Unattributed call.
   */
  async correlate(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, error: 'bad_conversation_id' };
    await noteTabConversation(source, conversationId);
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const calls = Array.isArray(message.calls) ? message.calls : [];
    if (calls.length === 0) return { ok: false, error: 'bad_request_evidence' };
    const result = await call('/correlations', {
      method: 'POST',
      body: JSON.stringify({ conversationId, calls })
    });
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
  async activity(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    await noteTabConversation(source, message.conversationId);
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    // Goal drafts are conversation-scoped in the app but browser writes are tab-scoped. Tell
    // the app which tab is polling so two tabs showing the same chat cannot both receive and
    // submit one ready Goal draft.
    const query =
      `?conversationId=${encodeURIComponent(message.conversationId)}` +
      `&since=${Number(message.since) || 0}` +
      `&goalClient=${encodeURIComponent(String(source.tab))}`;
    const result = await call(`/activity${query}`);
    if (ownsDocument(source) && result.ok && result.data && await acceptBrowserRevival(result.data.revival)) {
      await recoverDeferredRevivals();
    }
    // A fresh chat the app wants opened beside this one. Offered only to the home chat's own
    // poll, so the window this tab is in is the window its successor is created in.
    if (ownsDocument(source) && result.ok && result.data && result.data.placement) {
      await placeSuccessorChat(result.data.placement, source.tab);
    }
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
  /** Reinstall the least-trusted MAIN-world reader when a live content script loses it. */
  async repair_fiber(_message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    try {
      await chrome.scripting.executeScript({
        target: { tabId: source.tab, documentIds: [source.documentId] },
        world: 'MAIN',
        files: ['fiber.js']
      });
      return ownsDocument(source) ? { ok: true } : { ok: false, error: 'stale_document' };
    } catch {
      return { ok: false, error: 'fiber_repair_failed' };
    }
  },
  async closed(message, _sender, source) {
    // releaseTab drains the queue and posts /closed itself, and only when this was the
    // last live tab on the conversation.
    return releaseTab(source.tab, message.conversationId, source.documentId, source.navigationEpoch);
  },
  async compact(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    await noteTabConversation(source, message.conversationId);
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const result = await call('/compact', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: message.conversationId,
        resume: message.resume !== false,
        cancel: message.cancel === true,
        ticket: message.ticket === true,
        automatic: message.automatic === true,
        // The capture. `token` names the transaction the page was given when it marked the
        // compaction turn, and `summary` is that turn's own answer. Both are forwarded
        // verbatim and only together: the app refuses a brief whose token does not name an
        // open continuation for this chat, which is what keeps some other tab's text from
        // ever becoming this session's handoff.
        ...(typeof message.token === 'string' && typeof message.summary === 'string'
          ? { token: message.token, summary: message.summary }
          : {}),
        ...(typeof message.token === 'string' && message.sourceAttempt === true
          ? { token: message.token, sourceAttempt: true }
          : {}),
        ...(typeof message.token === 'string' && message.sourceDispatch === true
          ? { token: message.token, sourceDispatch: true }
          : {}),
        ...(typeof message.token === 'string' && typeof message.sourceMessageId === 'string'
          ? { token: message.token, sourceMessageId: message.sourceMessageId }
          : {}),
        ...(typeof message.token === 'string' && message.destinationAttempt === true
          ? { token: message.token, destinationAttempt: true }
          : {}),
        ...(typeof message.token === 'string' && message.destinationDispatch === true
          ? { token: message.token, destinationDispatch: true }
          : {}),
        ...(typeof message.token === 'string' && typeof message.destinationMessageId === 'string'
          ? { token: message.token, destinationMessageId: message.destinationMessageId }
          : {})
      })
    });
    // Chat B, for this window. The app produced it inside this very request precisely so that
    // the browser holding chat A is the browser that opens its successor — see
    // placeSuccessorChat for what the operating system does with the URL instead.
    if (ownsDocument(source) && result.ok && result.data && result.data.placement) {
      await placeSuccessorChat(result.data.placement, source.tab);
    }
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
  /**
   * The goal loop: this page saw its turn genuinely finish and wants the next user message.
   *
   * The API key never comes near this worker. The app is handed the conversation id and the
   * generation id and answers with a draft — which is also why `turnId` is forwarded
   * verbatim: it is the app's idempotency key, and a retried send must not become a second
   * message in somebody's chat.
   */
  async goal_draft(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, status: 400, error: 'bad_conversation_id' };
    await noteTabConversation(source, conversationId);
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    // Goal builds its prompt from the app's durable session transcript. The final assistant
    // row that caused this request can still be only in this worker's storage.session journal
    // when an earlier /events call was delayed or failed. Spend no OpenRouter request until
    // that row has crossed the same /events boundary normal transcript delivery uses.
    if (!(await deliverConversationJournal(conversationId))) {
      return { ok: false, status: 503, error: 'transcript_not_delivered', retryable: true };
    }
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const result = await call('/goal/draft', {
      method: 'POST',
      body: JSON.stringify({
        conversationId,
        turnId: String(message.turnId || ''),
        clientId: String(source.tab),
        ...(message.terminalRequired === true ? { terminalRequired: true } : {})
      })
    });
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
  /**
   * Raises the exact tab whose owned document is about to act on its own — a Goal draft, an
   * automatic Compact & Resume.
   *
   * The sender is the locator. Never search by conversation and never open a fallback: focus is
   * only presentation after the content script has independently decided to act. That keeps
   * background visibility out of completion/draft/compaction authority and makes a duplicate
   * tab impossible on this path.
   */
  async focus_tab(message, sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, status: 400, error: 'bad_conversation_id' };
    const key = String(source.tab);
    const registeredConversation = cleanConversationId(tabConversations[key]);
    if (registeredConversation && registeredConversation !== conversationId) {
      return { ok: false, error: 'stale_conversation' };
    }
    if (!registeredConversation) {
      await noteTabConversation(source, conversationId);
      if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    }
    try {
      const activated = await chrome.tabs.update(source.tab, { active: true });
      const senderWindow = sender && sender.tab && typeof sender.tab.windowId === 'number' ? sender.tab.windowId : null;
      const windowId = senderWindow ?? (activated && typeof activated.windowId === 'number' ? activated.windowId : null);
      if (windowId !== null) await chrome.windows.update(windowId, { focused: true });
    } catch {
      // Focus is a courtesy. The page owns Goal regardless, so browser/UI refusal must not turn
      // a valid hidden completion into a failed continuation.
      return ownsDocument(source) ? { ok: false, error: 'focus_failed' } : { ok: false, error: 'stale_document' };
    }
    return ownsDocument(source) ? { ok: true, focused: true } : { ok: false, error: 'stale_document' };
  },
  /** Typed, or given up on. Either way that draft is spent. */
  async goal_ack(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const result = await call('/goal/ack', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: message.conversationId,
        token: String(message.token || ''),
        clientId: String(source.tab)
      })
    });
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
  /**
   * This chat's specific goal, set or cleared from the settings sheet.
   *
   * The text is the user's own and goes straight through; the app trims it and answers with
   * what it actually stored, which is what the sheet then draws.
   *
   * `mode` is the button the goal was written under — "add specific goal" or "add specific
   * loop" — and the app pins it as this chat's own switch in the same write. Only those two
   * words cross; anything else is dropped rather than passed on, so a malformed sheet cannot
   * put a third mode into a durable file.
   */
  async goal_objective(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, status: 400, error: 'bad_conversation_id' };
    await noteTabConversation(source, conversationId);
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const result = await call('/goal/objective', {
      method: 'POST',
      body: JSON.stringify({ conversationId, text: String(message.text || ''), ...goalMode(message) })
    });
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
  /**
   * The opening message for a chat ChatGPT has not named yet.
   *
   * No conversation id, because there is none to send: this is the request whose answer
   * becomes the message that causes ChatGPT to issue one. Everything else about it is an
   * ordinary goal draft, and the key stays in the app exactly as it does for those.
   */
  async goal_open(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const result = await call('/goal/open', {
      method: 'POST',
      timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      body: JSON.stringify({ text: String(message.text || ''), ...goalMode(message) })
    });
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
  /**
   * The same two settings, for a chat that has no feed to read them from.
   *
   * `/activity` carries them otherwise, and it needs a conversation id. A New Chat has none
   * and is still somewhere a goal can be written, so the sheet above that composer asks for
   * them directly. Read-only, and conversation-free by construction.
   */
  async settings_get(_message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const result = await call('/settings', { method: 'GET' });
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
  /** The composer's settings menu, which owns exactly two switches. */
  async settings_set(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const requestedConversation = cleanConversationId(message.conversationId);
    const key = String(source.tab);
    const registeredConversation = cleanConversationId(tabConversations[key]);
    if (requestedConversation && registeredConversation && requestedConversation !== registeredConversation) {
      return { ok: false, error: 'stale_conversation' };
    }
    if (requestedConversation && !registeredConversation) {
      await noteTabConversation(source, requestedConversation);
      if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    }
    // A named chat's auto-compaction switch is not anonymous global authority. Pass the
    // document's proven conversation to the app so worker-role policy is enforced there even
    // if stale UI state somehow reaches this handler.
    const conversationId = cleanConversationId(tabConversations[key]) ?? requestedConversation;
    const body = {};
    if (typeof message.autoCompact === 'boolean') body.autoCompact = message.autoCompact;
    // Goal and Loop are one setting behind two switches, and the app refuses a body carrying
    // both. Pass through whichever one the sheet actually moved.
    if (typeof message.goal === 'boolean') body.goal = message.goal;
    else if (typeof message.loop === 'boolean') body.loop = message.loop;
    // The conversation, whichever switch moved. Auto-compaction needs it so worker-role policy
    // is enforced in the app; Goal and Loop need it because they are now that chat's own setting,
    // and a sheet drawn beside one conversation is answering about that conversation. A New Chat
    // has none, and moves the app-wide default it would have inherited.
    if (conversationId) body.conversationId = conversationId;
    const result = await call('/settings', { method: 'POST', body: JSON.stringify(body) });
    return ownsDocument(source) ? result : { ok: false, error: 'stale_document' };
  },
  /** The marked page asking for the one command it was opened for. */
  async redeem(message) {
    return redeemCommand(
      String(message.id || ''),
      String(message.client || ''),
      typeof message.conversationId === 'string' ? message.conversationId : null
    );
  },
  /**
   * A revival page has positively identified the exact target chat but it is not submit-ready
   * yet. Persist only its inert correlation marker so a service-worker/browser restart can put
   * the same durable app command back in front of that conversation. No command text is copied.
   */
  async defer_revival(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, error: 'bad_conversation_id' };
    await noteTabConversation(source, conversationId);
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const id = deferredRevivalId(message.id);
    if (!id) return { ok: false, error: 'bad_command_id' };
    const senderTabId = Number.isInteger(source?.tab) ? source.tab : null;
    const remembered = await rememberDeferredRevival(id, conversationId);
    if (remembered && senderTabId !== null) deferredRevivalOffers.set(id, senderTabId);
    return remembered ? { ok: true, deferred: true } : { ok: false, error: 'bad_command_id' };
  },
  async forget_revival(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    await forgetDeferredRevival(message.id);
    return { ok: true };
  },
  async ack(message, _sender, source) {
    const result = await ackCommand(
      String(message.id || ''),
      message.status === 'failed' ? 'failed' : 'sent',
      message.error,
      message.conversationId,
      message.agent,
      message.client,
      source
    );
    // ackCommand first made this irreversible page result durable in the browser-owned outbox.
    // From that point recovery must never reopen the pre-send marker, even if the bridge HTTP
    // response itself was lost; the outbox is now the sole retry path.
    await forgetDeferredRevival(message.id);
    return result;
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && typeof message.type === 'string' ? HANDLERS[message.type] : null;
  if (!handler) {
    sendResponse({ ok: false, error: 'unknown_message' });
    return false;
  }
  const owned = new Set([
    'events',
    'bind',
    'activity',
    'correlate',
    'closed',
    'compact',
    'goal_draft',
    'focus_tab',
    'goal_ack',
    'goal_objective',
    'goal_open',
    'settings_set',
    'settings_get',
    'repair_fiber',
    'redeem',
    'defer_revival',
    'forget_revival',
    'ack'
  ]);
  const run = async () => {
    let source = null;
    if (owned.has(message.type)) {
      source = await authorizeDocument(sender, message);
      if (!source.ok) return source;
    }
    return handler(message, sender, source);
  };
  const id = tabId(sender);
  const operation = owned.has(message.type) || message.type === 'register_document' ? serializeTab(id, run) : run();
  operation.then(sendResponse, (err) =>
    sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
  );
  return true;
});

/**
 * Best current conversation identity for one ChatGPT tab.
 *
 * A concrete `/c/<id>` URL wins. During full reload/startup Chrome can temporarily expose only
 * the ChatGPT root, a pending URL, or no URL at all while our tab registry still durably knows
 * which conversation this numeric tab represents. That transient shape must count as "the exact
 * worker tab is present" for revival routing, otherwise recovery creates a duplicate tab ~at
 * random depending on which lifecycle event won the race.
 *
 * The registry is deliberately ignored when a concrete *different* conversation is in the URL;
 * that is a real A->B navigation and stale registry state must not keep A artificially present.
 */
function conversationForTab(tab) {
  if (!tab || typeof tab.id !== 'number') return null;
  const current = conversationFromUrl(tab.url);
  if (current) return current;
  const pending = conversationFromUrl(tab.pendingUrl);
  if (pending) return pending;
  const urls = [tab.url, tab.pendingUrl].filter((value) => typeof value === 'string' && value);
  if (urls.some((value) => !isChatGptUrl(value))) return null;
  return cleanConversationId(tabConversations[String(tab.id)]);
}

// Document unload is not conversation lifetime. A real tab close is: reload keeps the
// same tab id, while closing it wakes the service worker and retires only that tab's claim.
chrome.tabs.onRemoved.addListener((id) => {
  clearDeferredRevivalOffersForTab(id);
  void serializeTab(id, async () => {
    const documentId = await markTerminal(id);
    return releaseTab(id, null, documentId);
  }).catch(() => undefined);
});

// A tab can survive while its ChatGPT document does not: navigating it to another site kills
// the content script, so neither pagehide nor any later observer can retire this conversation.
// onRemoved never fires because the tab itself still exists. A URL outside ChatGPT is terminal
// here, and so is a full document load of any ChatGPT URL that is concretely not chat A's own:
// the root, another chat, a project page. The user typing chatgpt.com into a Prime's tab used to
// leave A bound to that tab until some later chat happened to be given an id there, so the app
// never heard that A's page was gone and never reopened it (2026-09-03). A same-chat reload
// carries A's own URL and stays ambiguous until the replacement document binds; an SPA move,
// which fires no `loading` status, remains the content script's to prove.
chrome.tabs.onUpdated.addListener((id, changeInfo) => {
  if (!changeInfo) return;
  const fullNavigation = changeInfo.status === 'loading';
  const leftChatGpt = typeof changeInfo.url === 'string' && !isChatGptUrl(changeInfo.url);
  if (!fullNavigation && !leftChatGpt) return;
  if (fullNavigation || leftChatGpt) clearDeferredRevivalOffersForTab(id);
  // A loading transition is a browser document boundary even when both URLs are ChatGPT.
  // SPA pushState does not emit it. The replacement document must register with its own
  // MessageSender.documentId before any identity-sensitive IPC is accepted.
  void serializeTab(id, async () => {
    // A brand-new chat can be reloaded before ChatGPT has assigned /c/<id>. Keep only that
    // id-less root reload's provisional journal across the document swap. It is parked under
    // a reload-only key and adopted by the replacement document when it registers. Known-chat
    // navigations do not use this path, so chat A cannot hand its provisional observations to B.
    // The known chat this tab is concretely leaving for another ChatGPT URL, or null.
    let departed = null;
    if (fullNavigation && !leftChatGpt) {
      const key = String(id);
      const knownConversation = cleanConversationId(tabConversations[key]);
      let targetUrl = typeof changeInfo.url === 'string' ? changeInfo.url : '';
      if (!targetUrl) {
        try {
          const tab = await chrome.tabs.get(id);
          targetUrl = typeof tab?.url === 'string' ? tab.url : '';
        } catch {
          targetUrl = '';
        }
      }
      let rootReload = false;
      try {
        const url = new URL(targetUrl);
        rootReload = isChatGptUrl(targetUrl) && (url.pathname === '/' || url.pathname === '');
      } catch {
        rootReload = false;
      }
      const documentId = typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null;
      // Not an ambiguous reload: Chrome is replacing known chat A's document with a URL that is
      // not A's. releaseTab() below retires A here and now — its provisional observations are
      // too old to be adopted by whatever loads next, and its final tab leaving is the app's
      // cue to bring it back if a turn is still running in it.
      if (knownConversation && targetUrl && isChatGptUrl(targetUrl) && conversationFromUrl(targetUrl) !== knownConversation) {
        departed = knownConversation;
      } else if (!knownConversation && rootReload && documentId) {
        await carryFreshReloadProvisional(id, documentId);
      }
    }
    const documentId = await markTerminal(id);
    // A full ChatGPT navigation may be a normal reload of the same conversation. Block the
    // dying document immediately, but preserve the conversation until the replacement page
    // binds and proves whether it is the same chat or a different one.
    if (fullNavigation && !leftChatGpt && !departed) return { ok: true, closed: false };
    return releaseTab(id, departed, documentId);
  }).catch(() => undefined);
});

// -------------------------------------------------------------------- recovery

/**
 * Restores the page half of the bridge after this extension itself is updated/reloaded.
 *
 * Chrome invalidates an extension's isolated content-script world when the extension is
 * reloaded, but it does not reload the user's already-open ChatGPT document. The dead
 * content.js then cannot send observations, request-id evidence or even the conversation's
 * first /events batch, while fiber.js can remain visibly alive in the page's MAIN world.
 * That exact split produces a healthy MCP tunnel plus a permanently growing Unattributed
 * session and no session at all for the ChatGPT tab.
 *
 * runtime.onInstalled fires for unpacked Reload as an update, so repair only at that real
 * lifecycle boundary — never from the service worker's ordinary wake/sleep cycle. The
 * isolated content script has its own one-instance guard because a newly loading page can
 * receive both its static manifest injection and this recovery injection.
 */
const CHATGPT_TAB_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
const PAGE_RECORDER_VERSION = 11;

let deferredRecoveryWork = null;

function clearDeferredRevivalOffersForTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  for (const [id, offeredTab] of [...deferredRevivalOffers.entries()]) {
    if (offeredTab === tabId) deferredRevivalOffers.delete(id);
  }
}

function offerDeferredRevivalToTab(entry, tab) {
  if (!entry || !tab || typeof tab.id !== 'number') return false;
  const id = deferredRevivalId(entry.id);
  const conversationId = cleanConversationId(entry.conversationId);
  if (!id || !conversationId) return false;
  if (deferredRevivalOffers.get(id) === tab.id) return true;
  deferredRevivalOffers.set(id, tab.id);
  try {
    const offered = chrome.tabs.sendMessage(tab.id, {
      type: 'clf-run-command',
      id,
      conversationId,
      // This is browser-restart recovery of a marker that may already have been superseded by a
      // later app wake. content.js may abandon it only while it is still pre-redeem; a fresh
      // reuse handoff is never allowed to preempt an already redeeming/owned command.
      deferredRecovery: true
    });
    void Promise.resolve(offered).then(
      (reply) => {
        // A claimed response means this document crossed the durable bridge lease and remains
        // the sole owner until ACK. Every other response means this offer did not take custody;
        // allow a later document-registration/recovery signal to retry the same existing tab.
        if (!reply || reply.ok !== true || reply.claimed !== true) {
          if (deferredRevivalOffers.get(id) === tab.id) deferredRevivalOffers.delete(id);
        }
      },
      () => {
        if (deferredRevivalOffers.get(id) === tab.id) deferredRevivalOffers.delete(id);
      }
    );
    return true;
  } catch {
    if (deferredRevivalOffers.get(id) === tab.id) deferredRevivalOffers.delete(id);
    return false;
  }
}

function deferredRevivalUrl(entry) {
  if (!entry || !deferredRevivalId(entry.id) || !cleanConversationId(entry.conversationId)) return null;
  const url = new URL(`https://chatgpt.com/c/${entry.conversationId}`);
  url.searchParams.set('clf', entry.id);
  url.hash = `clf=${encodeURIComponent(entry.id)}`;
  return url.toString();
}

/**
 * Opens a fresh ChatGPT chat in the window of the chat it succeeds.
 *
 * The app can name which chat a resume's chat B — or a worker's first chat — belongs beside,
 * but it cannot open a tab there. Handing the URL to the operating system resolves to whichever
 * Chrome instance the platform picks, which is the one that last had focus. With two instances
 * running, the successor of a chat that had just finished in the background one was created in
 * the foreground one instead — a browser this extension was not even loaded in, so nothing ever
 * redeemed the command and the handoff died with nothing connected to it.
 *
 * Only the browser holding the home tab can put the successor in the same window, and a tab
 * this worker creates is by construction in a browser that has the extension. That is the whole
 * reason this decision lives here rather than in the app.
 *
 * The offer is spent by the app on handout, so this runs once per command; a second poll, from
 * this tab or another tab of the same chat, is never given the same id. Nothing is retried
 * locally either — when no redeem arrives the app opens it the old way, which is the only
 * recovery that still works if this window is closing.
 */
async function placeSuccessorChat(raw, tabId) {
  const id = commandMarkerId(raw && raw.id);
  if (!id || typeof tabId !== 'number') return;
  let home = null;
  try {
    home = await chrome.tabs.get(tabId);
  } catch {
    // The polling tab closed between its request and this reply. Nothing here can place a
    // window-bound tab without it, and the app's fallback is what covers exactly this.
    return;
  }
  if (!home || typeof home.windowId !== 'number') return;
  // Both a query and a fragment, matching the app's commandUrl(): ChatGPT rewrites its own URL
  // during boot and which of the two survives has changed between builds.
  const marker = `clf=${encodeURIComponent(id)}`;
  const model = commandModelSlug(raw && raw.model);
  const query = model ? `${marker}&model=${encodeURIComponent(model)}` : marker;
  const create = { url: `https://chatgpt.com/?${query}#${marker}`, windowId: home.windowId, active: true };
  // Directly after the chat it continues, so a handoff reads as one piece of work instead of a
  // tab appended to the far end of a long strip.
  if (typeof home.index === 'number') create.index = home.index + 1;
  try {
    await chrome.tabs.create(create);
  } catch {
    // Window teardown or browser policy rejected the create. The app's placement fallback
    // turns that into an ordinary OS open rather than a lost command.
  }
}

/** Accepts only the inert app command identity; the browser still decides the target tab. */
async function acceptBrowserRevival(raw) {
  const id = deferredRevivalId(raw?.id);
  const conversationId = cleanConversationId(raw?.conversationId);
  return id && conversationId ? rememberDeferredRevival(id, conversationId) : false;
}

/**
 * Re-presents deferred revival markers after MV3/document/browser lifetime loss.
 *
 * There is deliberately no command text here and no local "sent" decision. An existing exact
 * conversation gets first chance to install the content-side readiness waiter. A marked exact
 * chat is created only when the scan finds none, or a complete existing document cannot receive
 * and cannot be repaired. Either path still has to win `/commands/redeem`, so several recovery
 * triggers cannot duplicate or cross-deliver text.
 */
function recoverDeferredRevivals() {
  if (deferredRecoveryWork) return deferredRecoveryWork;
  const work = (async () => {
    await load();
    // A durable terminal page result supersedes its pre-send recovery marker. This matters on a
    // browser restart between ChatGPT accepting the message and the app accepting the ACK.
    const ackIds = new Set(commandAckOutbox.map((entry) => deferredRevivalId(entry?.id)).filter(Boolean));
    const before = deferredRevivals.length;
    deferredRevivals = deferredRevivals.filter(
      (entry) => deferredRevivalId(entry?.id) && cleanConversationId(entry?.conversationId) && !ackIds.has(entry.id)
    );
    if (deferredRevivals.length !== before) await persistLive();
    if (deferredRevivals.length === 0) return;

    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
    } catch {
      tabs = [];
    }

    for (const entry of [...deferredRevivals]) {
      const exact = tabs
        .filter((tab) => tab && typeof tab.id === 'number' && conversationForTab(tab) === entry.conversationId)
        .sort((a, b) => a.id - b.id);
      let routed = false;
      let starting = false;
      for (const tab of exact) {
        if (await restoreChatgptTab(tab.id)) {
          offerDeferredRevivalToTab(entry, tab);
          routed = true;
          break;
        }
        // A loading document is not proven broken. Let its registration or the next alarm retry
        // the same tab; opening during this transient is the original duplication race.
        if (tab.status !== 'complete') starting = true;
      }
      if (routed || starting) continue;

      const url = deferredRevivalUrl(entry);
      if (!url) continue;
      try {
        const created = await chrome.tabs.create({ url });
        if (created && typeof created.id === 'number') tabs.push({ ...created, url });
      } catch {
        // Browser policy/window teardown can reject create; the local marker remains for the next
        // browser/service-worker lifetime instead of turning that transport failure into a wake failure.
      }
    }
  })();
  const tracked = work.finally(() => {
    if (deferredRecoveryWork === tracked) deferredRecoveryWork = null;
  });
  deferredRecoveryWork = tracked;
  return tracked;
}

async function restoreChatgptTab(id) {
  try {
    const live = await chrome.tabs.sendMessage(id, { type: 'clf-recorder-ping' });
    if (live && live.ok === true && live.recorderVersion === PAGE_RECORDER_VERSION) {
      // Healthy content.js does not prove the independently running MAIN-world helper is
      // still present. Request-id ownership depends on fiber.js, and re-executing it is
      // idempotent because the helper keeps one listener per protocol version.
      try {
        await chrome.scripting.executeScript({ target: { tabId: id }, world: 'MAIN', files: ['fiber.js'] });
      } catch {
        // The tab can navigate between the ping and repair. Static injection covers it.
      }
      return true;
    }
  } catch {
    // No receiver is the expected signature of an already-open tab whose isolated world
    // was invalidated by an extension reload. Fall through to deterministic recovery.
  }
  try {
    // Rebuild the isolated-world DOM adapter before the recorder that consumes it.
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['chatgpt-dom.js'] });
    // Keep the React/Fiber reader in ChatGPT's own world, exactly like the static manifest
    // declaration. An older helper may still answer too; the nonce/version gate in
    // content.js makes those replies harmless, and a future version bump rejects them.
    await chrome.scripting.executeScript({ target: { tabId: id }, world: 'MAIN', files: ['fiber.js'] });
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId: id }, files: ['overlay.css'] });
    // Successful injection means this exact tab is recovering. Its document registration will
    // re-run revival routing; opening a second tab during that handoff recreates the race.
    return true;
  } catch {
    // A complete exact tab that cannot receive or be repaired is proven unusable. Revival may
    // open one replacement; a loading tab is handled conservatively by the caller.
    return false;
  }
}

async function restoreOpenChatgptTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
  } catch {
    return;
  }
  for (const tab of tabs) {
    const id = tab && typeof tab.id === 'number' ? tab.id : null;
    if (id !== null) await restoreChatgptTab(id);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void restoreOpenChatgptTabs().then(() => recoverDeferredRevivals()).catch(() => undefined);
  void load().then(() => {
    scheduleRetry();
  });
});

if (chrome.runtime.onStartup && typeof chrome.runtime.onStartup.addListener === 'function') {
  chrome.runtime.onStartup.addListener(() => {
    void load()
      .then(() => drainCommandAcks())
      .then(() => drain())
      .then(() => drainCloses())
      .then(() => recoverDeferredRevivals())
      // The browser just came back; the app may have been waiting the whole time it was gone.
      .then(() => maintain())
      .catch(() => undefined)
      .then(() => scheduleRetry());
  });
}

if (chrome.alarms && chrome.alarms.onAlarm && typeof chrome.alarms.onAlarm.addListener === 'function') {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== RETRY_ALARM) return;
    void drainCommandAcks()
      .then(() => drain())
      .then(() => drainCloses())
      .then(() => maintain())
      .catch(() => undefined)
      .then(() => {
        // Re-armed here and nowhere else. Every other caller of scheduleRetry() finds the
        // alarm already standing and leaves it alone, which is what keeps a burst of failing
        // requests from pushing the next pass further and further away.
        retryAlarmScheduled = false;
        scheduleRetry();
      });
  });
}

// `chrome://extensions` Reload does not provide a dependable install/update event across
// development/reload paths. The service worker itself *must* start, though. Ping first, so
// ordinary worker wake-ups are one cheap message per ChatGPT tab and inject nothing; only a
// dead or stale recorder pays the scripting cost.
void restoreOpenChatgptTabs().then(() => recoverDeferredRevivals()).catch(() => undefined);
void load().then(() => {
  scheduleRetry();
});
