/**
 * The only code this extension runs in ChatGPT's own JavaScript context.
 *
 * It exists for one reason: a collapsed connector row shows the word "Called tool" and
 * nothing else, but the React Fiber behind it already knows exactly which tool ran, under
 * which connector, and how many further calls that single row is standing in for. That
 * last part is why this file has to exist at all — the page renders one row for a run of
 * calls, not always to the same tool, so the visible rows are not a list of the calls, and
 * no amount of DOM reading from the isolated world can recover the ones it folded away.
 *
 * Everything here is written on the assumption that it is the least trusted code in the
 * extension:
 *
 *  · **It runs where the page can reach it.** ChatGPT could replace `JSON.parse`,
 *    `postMessage`, `Array.prototype.map` — anything this file touches. Native references
 *    are captured at load, before the page has had a chance to react to us, and the file
 *    is kept short so there is little to subvert.
 *  · **It emits an allowlist, never a filtered copy.** Only the named fields below cross
 *    into the extension. Copying the props and deleting the sensitive parts would be a
 *    denylist, and one renamed field would be a leak — the request JSON has been observed
 *    carrying tool arguments verbatim.
 *  · **It emits no argument values at all, and does not even parse them.** Tool arguments
 *    are the user's own text and this app's own secrets, and there is no key-level
 *    allowlist that generalises across tools. The request payload is never handed to
 *    `JSON.parse`; only the tool path anchored at the very front of it is read, so `args`
 *    is never walked at all. The tool's identity is what relabelling actually needs; the
 *    app already knows the arguments for every call it ran itself.
 *  · **It fails closed.** An unrecognised Fiber shape yields `null` for that row, which
 *    leaves the row exactly as ChatGPT drew it. Guessing would put a wrong tool name on a
 *    real call, which is worse than the generic label it replaced.
 *
 * The receiving side treats everything here as page-controlled evidence regardless: the
 * page can post these same messages itself. See the trust note in content.js.
 */

(() => {
  'use strict';

  /** Bumped when the descriptor shape changes, so a stale pair cannot half-understand. */
  const VERSION = 10;
  // The MAIN world survives an extension reload because the ChatGPT document survives it.
  // Recovery may therefore execute this file again in a page that still has an older helper
  // listener. Keep at most one listener for this protocol version; content.js rejects older
  // versions, so a v5 listener can coexist harmlessly until the document itself navigates.
  const ACTIVE_HELPER = '__clfFiberHelper';
  const ASK = 'clf-fiber-ask';
  const REPLY = 'clf-fiber-reply';
  /** The control ChatGPT puts in a connector tool row and nowhere else. */
  const CONNECTOR = '[aria-label="Open tool call list" i]';
  /**
   * A runaway guard on the climb, not a claim about how the page is shaped.
   *
   * This was 30, taken from an observed depth, and the live page put the group node at
   * exactly 30 — one past `up < MAX_CLIMB`. Every row of every chat then produced no
   * descriptor at all, silently, because failing closed is indistinguishable from a
   * browser where this helper never ran. What stops the climb now is `groupOf`'s own test
   * for the shape it wants; this number only keeps a detached or cyclic tree from looping.
   */
  const MAX_CLIMB = 80;
  const MAX_TEXT = 200;
  /** A page with more connector rows than this is not one we need to read exhaustively. */
  const MAX_ROWS = 400;
  /** Assistant turns whose message model is read for per-call evidence, newest first. */
  const MAX_TURNS = 6;
  /** Connector requests reported for one turn. Far above any real turn's call count. */
  const MAX_CALLS = 200;
  /** ChatGPT's own assistant turn sections, which is where a turn's message model hangs. */
  const TURN_SECTION = 'section[data-testid^="conversation-turn"]';
  /** ChatGPT-rendered authored prose. Tool rows and this extension's own surfaces are excluded. */
  const MARKDOWN = '.markdown';
  const TOOL = 'span[class*="tool-message"], div.pointer-events-none.contents';
  const OWN_SURFACES = '.clf-stream, .clf-stage, .clf-composer, .clf-boot';
  const MAX_RENDERED_HTML = 120_000;
  // A 15k–20k-token compaction answer is routinely 60k–90k characters. Capping public
  // assistant prose at 32k here made the canonical session transcript lose the back half
  // even though Compact & Resume itself carried the full DOM answer. One event still stays
  // comfortably below the 512 KiB bridge body cap alongside its bounded rendered HTML.
  // Safety guard only. Compact & Resume is specified in tokens (up to 30k), so this must be
  // comfortably larger than a normal handoff rather than acting as a second token budget.
  const MAX_RENDERED_TEXT = 256_000;
  /** Aggregate authored text/HTML copied through MAIN -> isolated world in one scan. */
  const MAX_RESPONSE_TEXT = MAX_TURNS * 512 * 1024;
  const MAX_TURN_TEXT = 512 * 1024;

  function budgetedText(value, budget, perValueLimit) {
    if (typeof value !== 'string' || !value || !budget || budget.remaining <= 0) return '';
    const limit = Math.max(0, Math.min(perValueLimit, budget.remaining));
    if (limit === 0) return '';
    const taken = value.slice(0, limit);
    budget.remaining -= taken.length;
    return taken;
  }
  /**
   * The connectors this app is reached through. Nothing else is ours to vouch for.
   *
   * There is more than one now: 1.7.1 split the model-facing surface into a Core and a
   * Desktop connector, so a single hardcoded name stopped matching *anything* the page
   * held — every call in every chat lost its page evidence at once and was filed outside
   * the conversation that made it. The name is not user input: ChatGPT takes `app_name`
   * from the `resource_name` this app serves in its own protected-resource metadata
   * (`server.ts`), so these are this app naming itself rather than labels somebody typed.
   * The pre-1.7.1 name stays so an older chat's evidence still reads.
   *
   * Exact names, never a prefix: `Chat On Steroids Backup` would be somebody else's
   * connector, and a prefix test would have this app vouch for its traffic.
   */
  const OUR_APPS = ['Chat On Steroids Core', 'Chat On Steroids Desktop', 'TobisComputer'];

  /** Whether an `invoked_resource.app_name` names one of this app's own connectors. */
  function ourApp(name) {
    if (typeof name !== 'string') return false;
    for (let at = 0; at < OUR_APPS.length; at++) if (OUR_APPS[at] === name) return true;
    return false;
  }

  /** Whether a request path — `/<connector>/link_…/<tool>` — is one of ours. */
  function ourPath(path) {
    if (typeof path !== 'string' || path.charCodeAt(0) !== 47) return false;
    const end = path.indexOf('/', 1);
    return end > 1 && ourApp(path.slice(1, end));
  }
  /**
   * The tool path at the very front of a request payload.
   *
   * Anchored, and it stops at the first quote, so it can only ever see the path — never a
   * key or value from `args`, including the `path` argument a file tool takes, which is a
   * second `"path"` later in the same string.
   */
  const PATH_HEAD = /^\s*\{\s*"path"\s*:\s*"([^"\\]{1,200})"/;
  /** A tool name we are willing to put on a row. */
  const NAME = /^[a-z0-9_.-]{1,64}$/i;

  // Captured before the page can swap them. If the page has already replaced one of these
  // at load time there is nothing to be done about it, but it cannot do so afterwards.
  const post = window.postMessage.bind(window);
  const own = Object.prototype.hasOwnProperty;

  /** A short, plain string or null. Never a number, object, or anything with a toString. */
  function str(value) {
    return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : null;
  }

  function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function int(value) {
    const raw = num(value);
    return raw === null ? 0 : Math.max(0, Math.min(999, Math.round(raw)));
  }

  /**
   * The React Fiber node for a DOM element.
   *
   * React hangs it off a property whose name carries a per-build random suffix, so the
   * key has to be discovered rather than named.
   */
  function fiberOf(node) {
    for (const key in node) {
      if (key.charCodeAt(0) === 95 && key.indexOf('__reactFiber$') === 0) return node[key];
    }
    return null;
  }

  /**
   * The props of the node that renders exactly this row's group of messages.
   *
   * Two shapes are reachable by climbing from a row, and only one of them may be used.
   * The near one — observed live at depth 30 — carries `messages`, where `messages[0]` is
   * this row's own request and everything after it is other rows' business. The far one,
   * around depth 43, carries `allMessages`/`turn` for the *whole* turn; reading a row's
   * identity out of that means picking one of a turn's many requests by position, which is
   * how a row ends up labelled with a neighbour's tool. So the turn-level node is not a
   * fallback, it is a stop: reaching it means this row's group was not found, and a row
   * with no group keeps the label ChatGPT gave it.
   */
  function groupOf(fiber) {
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      if (Array.isArray(props.allMessages) || (props.turn && typeof props.turn === 'object')) return null;
      if (Array.isArray(props.messages) && props.messages.length > 0) return props;
    }
    return null;
  }
  /**
   * The complete message list for this logical turn, read separately from the row group.
   *
   * Row identity must never come from this list because it contains many requests. For
   * attribution cardinality, though, that is exactly the useful property: it lets us count
   * how many requests in the turn actually target TobisComputer instead of treating
   * ChatGPT's folded-row count as if api_tool metadata calls were local MCP calls.
   */
  function turnMessagesOf(fiber) {
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const turn = props.turn;
      if (turn && typeof turn === 'object' && Array.isArray(turn.messages)) return turn.messages;
      if (Array.isArray(props.allMessages)) return props.allMessages;
    }
    return null;
  }

  /**
   * ChatGPT's internal conversation identity attached to this Fiber branch.
   *
   * Absence and contradiction are deliberately different states. During navigation React can
   * leave props from chat A and chat B mounted on one branch for a tick. Returning plain null
   * for that shape used to make content.js treat the branch exactly like one that simply had
   * no conversation metadata, which let stale assistant messages from another chat be recorded
   * under the current URL. Preserve the conflict bit so the isolated world can fail closed.
   */
  function conversationEvidenceOf(fiber) {
    let found = null;
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const turn = props.turn && typeof props.turn === 'object' ? props.turn : null;
      const values = [props.clientThreadId, props.conversationId, turn && turn.clientThreadId, turn && turn.conversationId];
      for (let index = 0; index < values.length; index++) {
        const value = str(values[index]);
        if (!value) continue;
        if (found && found !== value) return { conversationId: null, conflict: true };
        found = value;
      }
    }
    return { conversationId: found, conflict: false };
  }

  /** An authored assistant message object, when a rendered prose node exposes one directly. */
  function messageOf(fiber) {
    let found = null;
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const candidate = props.message;
      if (!candidate || typeof candidate !== 'object') continue;
      const author = candidate.author;
      const id = str(candidate.id);
      if (!id || !author || author.role !== 'assistant') continue;
      if (requestOf(candidate) || resultOf(candidate)) continue;
      if (found && found !== id) return null;
      found = id;
    }
    return found;
  }

  /**
   * ChatGPT's own name for what a public assistant message is *for*.
   *
   * The page model routes assistant prose down three named channels, and they are not
   * interchangeable. `final` is the answer. `commentary` is the running narration a
   * tool-using turn shows between calls. `analysis` is the model's private scratch, which
   * this extension never records and never shows.
   *
   * Read as a plain string, absent included: page data old enough to carry no channel at all
   * keeps behaving exactly as it did before this field was known, rather than being
   * reclassified by a default.
   */
  function channelOf(message) {
    return message && typeof message === 'object' ? str(message.channel) : '';
  }

  /**
   * Whether this message is ChatGPT's private reasoning scratch rather than something it
   * said. Recording it would put chain-of-thought in the transcript; letting it stand as the
   * turn's newest public prose is worse, and is measured below.
   */
  function analysisMessage(message) {
    return channelOf(message) === 'analysis';
  }

  /**
   * Whether this message is, by ChatGPT's own routing, incapable of being the answer.
   *
   * Live 2026-08-31, on a finished tool-heavy turn with the Stop control already gone, the
   * page model held: the answer on `channel:'final'` with `end_turn:true` and
   * `status:'finished_successfully'`, and *after* it an empty message on `channel:'analysis'`
   * left at `status:'in_progress'` forever. A trailing `commentary` message left at
   * `end_turn:false` behaves the same way. Neither is a turn that is still running and
   * neither can ever become the answer — so neither may stand in front of the message that
   * is one.
   */
  function neverTerminalChannel(message) {
    const channel = channelOf(message);
    return channel === 'analysis' || channel === 'commentary';
  }

  function hiddenMessage(message) {
    const meta = message && typeof message === 'object' ? message.metadata : null;
    return Boolean(
      meta &&
      typeof meta === 'object' &&
      (meta.is_visually_hidden_from_conversation === true || meta.is_visually_hidden === true)
    );
  }

  /** Whether one page-model message is ChatGPT's own reasoning/thought object. */
  function thoughtMessage(message) {
    if (!message || typeof message !== 'object') return false;
    const author = message.author;
    const content = message.content;
    return Boolean(
      author &&
      author.role === 'assistant' &&
      content &&
      typeof content === 'object' &&
      content.content_type === 'thoughts' &&
      str(message.id)
    );
  }

  /**
   * ChatGPT's row-local identity for a rendered thought item.
   *
   * The live renderer exposes `memoizedProps.item = { type: 'thought', key:
   * 'thought-<message UUID>-<item index>', ... }` only a few Fibers above the visible row.
   * The UUID portion must resolve to an actual thought message in this turn; the full key is
   * retained because the suffix is page identity too and can distinguish two items owned by
   * one thought if ChatGPT ever emits them.
   */
  function thoughtItemOf(fiber, thoughtIds) {
    let found = null;
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const item = props.item;
      if (!item || typeof item !== 'object' || item.type !== 'thought') continue;
      const key = str(item.key);
      if (!key) continue;
      const suffixAt = key.lastIndexOf('-');
      const suffix = suffixAt >= 0 ? key.slice(suffixAt + 1) : '';
      const owner = key.startsWith('thought-') && /^\d{1,6}$/.test(suffix) ? key.slice(8, suffixAt) : null;
      if (owner && !thoughtIds.has(owner)) continue;
      if (!owner) continue;
      if (found && found.messageId !== key) return null;
      found = { messageId: key, thoughtMessageId: owner };
    }
    return found;
  }

  /**
   * The public authored text carried by one ChatGPT assistant message, or null.
   *
   * Live turns contain many assistant-authored *internal* messages as well: connector
   * requests are `code`, and reasoning/tool-summary state is `thoughts`. The latter is the
   * shape that broke canonical prose capture in 1.8.1: a turn with 3 real text messages also
   * held 23 `thoughts` records, so the old positional fallback saw 26 candidate ids for 18
   * rendered Markdown nodes and (correctly) refused to guess. `content_type: text` is the
   * page model's explicit boundary for authored prose; `parts` then carries the raw Markdown
   * exactly as ChatGPT authored it.
   *
   * Do not fall back to arbitrary object/string fields. This helper runs in the page world
   * and its allowlist is a privacy boundary: only the public text payload crosses worlds.
   */
  function authoredText(message) {
    const content = message && typeof message === 'object' ? message.content : null;
    if (!content || typeof content !== 'object' || content.content_type !== 'text') return null;
    if (Array.isArray(content.parts)) {
      let value = '';
      for (let at = 0; at < content.parts.length; at++) {
        const part = content.parts[at];
        if (typeof part !== 'string') continue;
        if (value) value += '\n';
        value += part;
        if (value.length >= MAX_RENDERED_TEXT) break;
      }
      value = value.slice(0, MAX_RENDERED_TEXT);
      return value.length > 0 ? value : null;
    }
    return typeof content.text === 'string' && content.text.length > 0
      ? content.text.slice(0, MAX_RENDERED_TEXT)
      : null;
  }

  /** ChatGPT's own message creation time, normalized to epoch milliseconds when present. */
  function authoredTime(message) {
    const raw = message && typeof message === 'object' ? Number(message.create_time) : NaN;
    if (!Number.isFinite(raw) || raw <= 0) return null;
    // The live model uses epoch seconds (often fractional). Accept milliseconds too so a
    // renderer change cannot move a valid timestamp ~54,000 years into the past.
    return Math.round(raw < 10_000_000_000 ? raw * 1000 : raw);
  }

  /** Whether two optional page turn identities contradict one another. */
  function turnIdentityContradicts(left, right) {
    return Boolean(left && right && left !== right);
  }

  /**
   * Stable public-assistant identity before the owning thought object necessarily mounts.
   *
   * ChatGPT can rotate the child text-message UUID while one commentary item streams, so the
   * raw message id is not identity. Three pieces of ChatGPT's own server-authored metadata
   * are: `working_turn_id` and `turn_exchange_id` name the branch, and `create_time` names
   * the message inside it. That tuple is the same before and after a reload, which the
   * previous `parent_id` tuple was not: rehydrating a conversation from the server re-parents
   * the text message, so every already-recorded message came back under a second key and the
   * transcript showed each one twice.
   *
   * No text, DOM position, or local observation time takes part. `create_time` here is
   * ChatGPT's own creation stamp for that exact message, read from the page model.
   *
   * `parent_id` remains the fallback identity for page data old enough to carry no
   * `create_time`. A bare parent_id is deliberately insufficient even then: Retry/Regenerate
   * branches can share a parent. With no turn/exchange discriminator at all there is no exact
   * identity to use, and the raw message id stands until one exists.
   */
  function assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, createTime) {
    if ((workingTurnId || turnExchangeId) && createTime) {
      const stable = `assistant:${workingTurnId || ''}:${turnExchangeId || ''}:${createTime}`;
      if (stable.length <= 190) return stable;
    }
    if (!parentId || (!workingTurnId && !turnExchangeId)) return id;
    const value = `assistant:${parentId}:${workingTurnId || ''}:${turnExchangeId || ''}`;
    return value.length <= 190 ? value : id;
  }

  /** Public assistant messages in ChatGPT's own turn model, in model order. */
  function authoredAssistantMessages(messages, budget) {
    const out = [];
    const seen = new Set();
    const logicalIds = new Set();
    const thoughtParents = new Map();
    if (!Array.isArray(messages)) return out;
    for (const candidate of messages) {
      if (thoughtMessage(candidate)) thoughtParents.set(str(candidate.id), candidate);
    }
    for (let index = 0; index < messages.length; index++) {
      if (!budget || budget.remaining <= 0) break;
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      const author = message.author;
      if (!author || author.role !== 'assistant') continue;
      if (requestOf(message) || resultOf(message) || hiddenMessage(message)) continue;
      // Private reasoning, by ChatGPT's own routing. Never a transcript row.
      if (analysisMessage(message)) continue;
      const id = str(message.id);
      const rawText = budgetedText(authoredText(message), budget, MAX_RENDERED_TEXT);
      if (!id || !rawText) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
      const parentId = meta ? str(meta.parent_id) : null;
      const workingTurnId = meta ? str(meta.working_turn_id) : null;
      const turnExchangeId = meta ? str(meta.turn_exchange_id) : null;
      const createTime = authoredTime(message);
      const authoredId = assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, createTime);
      // Two messages of one branch sharing a creation millisecond would collide on that
      // identity. Keep the first and hand the later one the parent tuple instead, so a
      // collision costs a weaker key rather than a swallowed message.
      const collides = logicalIds.has(authoredId);
      let logicalId = collides ? assistantLogicalId(id, parentId, workingTurnId, turnExchangeId, null) : authoredId;
      // The reload-durable identity needs no thought parent to be trustworthy.
      let stable = !collides && Boolean(createTime) && logicalId !== id && logicalId !== parentId;

      // Live streaming can replace the raw text-message UUID while the same commentary block
      // keeps growing. The page already supplies a stronger relation: public commentary is a
      // child of the thought object that owns that reasoning step. Use that thought id only
      // when the parent is actually present in this same turn model and its own turn metadata
      // does not contradict the child. No text, order, timing or DOM position participates.
      if (parentId) {
          const parent = thoughtParents.get(parentId);
          if (parent) {
          const parentMeta = parent.metadata && typeof parent.metadata === 'object' ? parent.metadata : null;
          const parentWorking = parentMeta ? str(parentMeta.working_turn_id) : null;
          const parentExchange = parentMeta ? str(parentMeta.turn_exchange_id) : null;
          if (!turnIdentityContradicts(workingTurnId, parentWorking) && !turnIdentityContradicts(turnExchangeId, parentExchange)) {
          // Keep the same exact tuple chosen above. If older page data has a thought parent
          // but no working/exchange metadata, parent_id itself is the stronger identity.
          if (logicalId === id) logicalId = parentId;
          stable = true;
          }
        }
      }
      // The parent fallback can itself collide when the page publishes two authored blocks
      // with the same relation and no creation stamp. Raw ids are weaker across reloads but
      // still strictly better than swallowing one of two distinct messages in this scan.
      if (logicalIds.has(logicalId)) {
        logicalId = id;
        stable = false;
      }
      // Keep the position from ChatGPT's own turn model. `messages` and native activity are
      // transported as separate arrays below for validation, so without this ordinal the
      // isolated-world recorder has no way to put them back together. That was visible on
      // the first interim update of a turn: the prose and the preceding thinking headline
      // often arrived in one scan, and content.js always emitted all prose before all
      // headlines regardless of the order ChatGPT actually rendered them.
      out.push({
        id,
        messageId: logicalId,
        role: 'assistant',
        stable,
        rawText,
        order: index,
        createTime
      });
      logicalIds.add(logicalId);
    }
    return out;
  }

  /**
   * Public user messages in ChatGPT's own turn model.
   *
   * The DOM usually exposes `data-message-id` for user prose, but the first message of a
   * brand-new chat can exist in the React model before that attribute is mounted. That is
   * exactly the gap where the live recorder used to miss the opening prompt and only recover
   * it after a reload. The model id is already ChatGPT's durable identity, so there is no
   * reason to make user capture depend on the DOM having caught up.
   */
  function authoredUserMessages(messages, budget) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(messages)) return out;
    for (let index = 0; index < messages.length; index++) {
      if (!budget || budget.remaining <= 0) break;
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      const author = message.author;
      if (!author || author.role !== 'user') continue;
      const id = str(message.id);
      const rawText = budgetedText(authoredText(message), budget, MAX_RENDERED_TEXT);
      if (!id || !rawText) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        messageId: id,
        role: 'user',
        stable: true,
        rawText,
        order: index,
        createTime: authoredTime(message)
      });
    }
    return out;
  }

  /**
   * Whether ChatGPT's own message model says this turn reached a terminal successful end.
   *
   * Live 2026-08-19 evidence: an actively generating turn can already expose
   * `isFinalTurn:true`, and interim public messages can already have
   * `status:'finished_successfully'`; neither is completion. The final assistant message is
   * the one that additionally carries direct `end_turn:true`. Only that boolean plus the
   * assistant role/status crosses worlds. No private reasoning or finish payload is copied.
   */
  function turnEndMessageId(messages) {
    if (!Array.isArray(messages)) return null;
    // The latest public text that *could* be the answer is the current state of the assistant
    // turn. A Retry/Regenerate can leave the previous finished attempt in the same model while
    // a newer public message is active; searching for *any* older end_turn=true would
    // incorrectly keep the new attempt terminal forever. So the first such message from the
    // tail decides, fail closed.
    //
    // "Could be the answer" is ChatGPT's own routing, not a guess about content: a turn's
    // trailing `analysis` or `commentary` message is not a turn still in flight, it is a
    // message on a channel that never carries answers. Skipping those is what stops one empty
    // scratch message — live, an `analysis` row stuck at `status:'in_progress'` after the
    // Stop control had already gone — from hiding a completed answer forever, leaving the real
    // final prose recorded as partial and the turn permanently open. See neverTerminalChannel.
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      const author = message.author;
      if (!author || author.role !== 'assistant') continue;
      const content = message.content;
      if (!content || typeof content !== 'object' || content.content_type !== 'text') continue;
      if (neverTerminalChannel(message)) continue;
      if (message.end_turn === true && message.status === 'finished_successfully') return str(message.id);
      return null;
    }
    return null;
  }

  /** Whitespace-only normalisation for an optional DOM decoration match. */
  function visibleText(value) {
    return typeof value === 'string' ? value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * Public authored prose from ChatGPT's own message model, optionally decorated with the
   * rendered HTML of the matching visible block.
   *
   * Identity and raw Markdown come from the model, not the DOM. That is the important
   * invariant: a renderer refactor may cost rich HTML for one message, but can no longer make
   * the message disappear or mint a new identity for each streaming snapshot.
   *
   * HTML is decoration only. Prefer an explicit DOM/Fiber message id. Where the page no
   * longer exposes one, an exact whitespace-normalised text equality may attach a block, but
   * only when that match is unique on both sides. Markdown whose rendered text differs from
   * its raw source simply keeps `renderedHtml: ''` and the recorder still has the canonical
   * raw Markdown. Finally, the old positional fallback remains only for the fully balanced
   * case, where every remaining candidate has exactly one remaining visible block.
   */
  function renderedMessagesOf(sections, messages, budget) {
    const assistantCandidates = authoredAssistantMessages(messages, budget);
    const userCandidates = authoredUserMessages(messages, budget);
    if (assistantCandidates.length === 0 && userCandidates.length === 0) return [];

    const blocks = [];
    const blockSections = [];
    for (let sectionAt = 0; sectionAt < sections.length; sectionAt++) {
      const section = sections[sectionAt];
      let found;
      try {
        found = section.querySelectorAll(MARKDOWN);
      } catch {
        continue;
      }
      for (let at = 0; at < found.length; at++) {
        const block = found[at];
        if (block.closest && (block.closest(TOOL) || block.closest(OWN_SURFACES))) continue;
        const parent = block.parentElement && block.parentElement.closest ? block.parentElement.closest(MARKDOWN) : null;
        if (parent && section.contains(parent)) continue;
        blocks.push(block);
        blockSections.push(sectionAt);
      }
    }

    const used = new Set();
    const ids = [];
    for (let at = 0; at < blocks.length; at++) {
      const block = blocks[at];
      let id = null;
      try {
        const holder = block.closest && block.closest('[data-message-id]');
        id = holder ? str(holder.getAttribute('data-message-id')) : null;
      } catch {
        id = null;
      }
      if (!id) {
        try {
          const fiber = fiberOf(block);
          if (fiber) id = messageOf(fiber);
        } catch {
          id = null;
        }
      }
      let known = false;
      for (let c = 0; c < assistantCandidates.length; c++) if (assistantCandidates[c].id === id) known = true;
      if (!known) id = null;
      if (id) used.add(id);
      ids.push(id);
    }

    const freeBlocks = [];
    for (let at = 0; at < ids.length; at++) if (!ids[at]) freeBlocks.push(at);
    const freeCandidates = [];
    for (let c = 0; c < assistantCandidates.length; c++) {
      let taken = false;
      if (used.has(assistantCandidates[c].id)) taken = true;
      if (!taken) freeCandidates.push(assistantCandidates[c]);
    }

    // The live 2026-08-19 page no longer exposes a message id on authored Markdown blocks.
    // Attach HTML by exact visible text only when the equality is unique in both directions.
    for (let c = 0; c < freeCandidates.length; c++) {
      const candidate = freeCandidates[c];
      const wanted = visibleText(candidate.rawText);
      if (!wanted) continue;
      let match = -1;
      let count = 0;
      for (let b = 0; b < freeBlocks.length; b++) {
        const blockAt = freeBlocks[b];
        let text = '';
        try {
          text = visibleText(blocks[blockAt] && blocks[blockAt].textContent);
        } catch {
          text = '';
        }
        if (text !== wanted) continue;
        match = blockAt;
        count += 1;
      }
      if (count !== 1) continue;
      let candidateCount = 0;
      for (let other = 0; other < freeCandidates.length; other++) {
        if (visibleText(freeCandidates[other].rawText) === wanted) candidateCount += 1;
      }
      if (candidateCount !== 1) continue;
      ids[match] = candidate.id;
      used.add(candidate.id);
    }

    const remainingBlocks = [];
    for (let at = 0; at < ids.length; at++) if (!ids[at]) remainingBlocks.push(at);
    const remainingCandidates = [];
    for (let c = 0; c < assistantCandidates.length; c++) {
      let taken = false;
      if (used.has(assistantCandidates[c].id)) taken = true;
      if (!taken) remainingCandidates.push(assistantCandidates[c]);
    }
    if (remainingBlocks.length === remainingCandidates.length) {
      for (let at = 0; at < remainingBlocks.length; at++) ids[remainingBlocks[at]] = remainingCandidates[at].id;
    }

    // One canonical record per model message whether or not HTML could be attached.
    const out = [];
    for (let c = 0; c < assistantCandidates.length; c++) {
      out.push({
        messageId: assistantCandidates[c].messageId,
        rawMessageId: assistantCandidates[c].id,
        role: 'assistant',
        stable: assistantCandidates[c].stable,
        order: assistantCandidates[c].order,
        createTime: assistantCandidates[c].createTime,
        rawText: assistantCandidates[c].rawText,
        renderedHtml: ''
      });
    }
    for (let c = 0; c < userCandidates.length; c++) {
      out.push({
        messageId: userCandidates[c].messageId,
        rawMessageId: userCandidates[c].id,
        role: 'user',
        stable: true,
        order: userCandidates[c].order,
        createTime: userCandidates[c].createTime,
        rawText: userCandidates[c].rawText,
        renderedHtml: ''
      });
    }
    for (let at = 0; at < blocks.length; at++) {
      const id = ids[at];
      if (!id) continue;
      let target = -1;
      for (let c = 0; c < out.length; c++) if (out[c].rawMessageId === id) target = c;
      if (target < 0 || out[target].renderedHtml) continue;
      const block = blocks[at];
      let renderedHtml = '';
      try {
        // All of the markup or none of it. Cutting HTML at a character count cuts it mid-tag,
        // and ChatGPT's code blocks carry several hundred characters of wrapper chrome around
        // a few lines of code — so a cut lands inside one often, and everything after it is
        // lost while the visible remainder ends as an unclosed box. The canonical raw text is
        // always carried beside this, so an absent capture costs presentation, never content.
        const markup = block.innerHTML;
        renderedHtml =
          markup.length <= Math.min(MAX_RENDERED_HTML, budget.remaining)
            ? budgetedText(markup, budget, MAX_RENDERED_HTML)
            : '';
      } catch {
        renderedHtml = '';
      }
      if (renderedHtml) {
        out[target].renderedHtml = renderedHtml;
        // This is rendered ownership, not model identity: the message id above came from the
        // Fiber/model join, and this ordinal says which exact sibling section supplied its
        // unique visible block. content.js uses it only as corroboration for a completed-message
        // action when end_turn is missing; no unique rendered join means null/fail closed.
        out[target].sectionIndex = blockSections[at];
      }
    }
    out.sort((left, right) => left.order - right.order);
    return out;
  }

  /**
   * Visible ChatGPT-native activity, keyed by the thought object that owns the rendered row.
   *
   * The label is display data only. React may replace the DOM row or rewrite its text from
   * "Inspecting" to "Inspected"; neither can create a new record because the identity is the
   * page-model thought `message.id`. If two simultaneously rendered rows claim one thought
   * with different labels (a transition/reparent race), that scan is ambiguous and emits
   * neither version. The next stable scan reconciles it.
   */
  function nativeActivitiesOf(sections, messages) {
    const thoughtIds = new Set();
    const thoughtOrder = new Map();
    for (let at = 0; at < messages.length; at++) {
      if (!thoughtMessage(messages[at])) continue;
      const id = str(messages[at].id);
      if (id) {
        thoughtIds.add(id);
        thoughtOrder.set(id, at);
      }
    }
    if (thoughtIds.size === 0) return [];

    const held = [];
    for (let sectionAt = 0; sectionAt < sections.length; sectionAt++) {
      const section = sections[sectionAt];
      let found;
      try {
        found = section.querySelectorAll(TOOL);
      } catch {
        continue;
      }
      const rows = [];
      const candidates = new Set(found);
      const nestedParents = new Set();
      for (let at = 0; at < found.length; at++) {
        const row = found[at];
        let parent = row && row.parentElement;
        while (parent && parent !== section) {
          if (candidates.has(parent)) nestedParents.add(parent);
          parent = parent.parentElement;
        }
      }
      for (let at = 0; at < found.length; at++) {
        if (!nestedParents.has(found[at])) rows.push(found[at]);
      }

      for (let at = 0; at < rows.length; at++) {
        const row = rows[at];
        try {
          if (row.closest && row.closest(OWN_SURFACES)) continue;
          if ((row.querySelector && row.querySelector(CONNECTOR)) || (row.closest && row.closest(CONNECTOR))) continue;
          if (row.querySelector && row.querySelector(MARKDOWN)) continue;
        } catch {
          continue;
        }
        const label = visibleText(row.textContent).slice(0, 300);
        if (!label || label.length > 300) continue;
        let activity = null;
        try {
          const fiber = fiberOf(row);
          if (fiber) activity = thoughtItemOf(fiber, thoughtIds);
        } catch {
          activity = null;
        }
        if (!activity) continue;

        let prior = null;
        for (let entryAt = 0; entryAt < held.length; entryAt++) {
          if (held[entryAt].messageId === activity.messageId) prior = held[entryAt];
        }
        if (!prior) {
          held.push({
            messageId: activity.messageId,
            label,
            order: thoughtOrder.get(activity.messageId),
            conflicted: false
          });
        } else if (prior.label !== label) {
          prior.conflicted = true;
        }
      }
    }
    const out = [];
    for (let at = 0; at < held.length; at++) {
      if (!held[at].conflicted) {
        out.push({ messageId: held[at].messageId, label: held[at].label, order: held[at].order });
      }
    }
    return out;
  }

  /**
   * The connector request this row stands for, or null if `message` is not one.
   *
   * A connector request is an assistant message whose `recipient` names the API tool
   * bridge. The tool is at the front of its content, which is *nearly* JSON: the live page
   * stores the payload truncated — `Unterminated string in JSON at position 741` on a
   * routine call — so parsing it fails on most rows, and the old fallback of naming the row
   * after the recipient turned every one of those into `call_tool`, a tool this app does
   * not have. The path is read off the front of the string instead, which survives the
   * truncation because it is the first field, and nothing else in the payload is looked at.
   */
  function requestOf(message) {
    if (!message || typeof message !== 'object') return null;
    const author = message.author;
    if (!author || author.role !== 'assistant') return null;
    const recipient = str(message.recipient);
    if (!recipient || recipient.indexOf('api_tool') !== 0) return null;

    let path = null;
    const text = message.content && message.content.text;
    if (typeof text === 'string' && text.length > 0) {
      const head = PATH_HEAD.exec(text);
      if (head) path = str(head[1]);
    }

    // ChatGPT stamps every connector request with its own request id, and the same id
    // reaches the app on the MCP request itself — a deterministic join between the page and
    // the call, so two workers calling one tool at once need no timing heuristic to tell
    // apart. Allowlisted like everything else here — an opaque id, never arguments.
    const meta = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    return {
      path,
      messageId: str(message.id),
      requestId: meta ? str(meta.request_id) : null,
      createTime: num(message.create_time)
    };
  }

  /**
   * Every request id ChatGPT has stamped anywhere in this turn.
   *
   * `callsOf` deliberately answers a narrow question — which rows are *this app's* connector
   * calls, so they can be labelled and rendered — and to answer it, it requires a readable
   * `api_tool` recipient and a parseable tool path. That filter is right for a tool row and
   * wrong for attribution, and the difference cost an entire class of calls.
   *
   * ChatGPT stamps `metadata.request_id` on the plain `recipient: "all"` message the moment a
   * turn starts a connector request, and only materializes the `api_tool` message once its
   * safety check clears — live 2026-08-21, forty seconds later, well past the app's fifteen
   * second evidence window. The id was on screen and readable the whole time; this file threw
   * it away because it was not yet attached to a row worth *drawing*. The app then filed the
   * call under `Unattributed activity`, refused identity-sensitive calls, and the chat looked
   * broken for reasons no log named.
   *
   * The request id is opaque, and the join it feeds is exact: id -> conversation, nothing
   * else. So harvest it from every message in the turn, with no opinion about recipient, path
   * or tool name, and let the app decide. Nothing here is rendered and nothing here is parsed
   * from `content.text` — this list carries three allowlisted primitives per entry and never
   * appears in the transcript.
   */
  function requestIdsOf(messages) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    const seen = new Set();
    for (let at = 0; at < messages.length && out.length < MAX_CALLS; at++) {
      const message = messages[at];
      if (!message || typeof message !== 'object') continue;
      const meta = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
      const requestId = meta ? str(meta.request_id) : null;
      if (!requestId || seen.has(requestId)) continue;
      seen.add(requestId);
      out.push({
        requestId,
        messageId: str(message.id),
        createTime: num(message.create_time)
      });
    }
    return out;
  }

  /** "/Chat On Steroids Core/link_…/read" -> "read", or null if that is not a name. */
  function toolName(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    const tail = value.slice(value.lastIndexOf('/') + 1);
    return NAME.test(tail) ? tail : null;
  }

  /**
   * The tool a row ran, from both sources or neither.
   *
   * The request names it and so does the result — `invoked_resource.resource_uri`, which
   * is structured and needs no parsing. Where both are readable they must agree: two
   * sources naming different tools means the pairing is wrong, and a row labelled with the
   * wrong tool is worse than one left saying "Called tool". Where only one is readable it
   * is used, because an unanswered call has no result yet and a truncated payload has no
   * path.
   */
  function identify(request, result) {
    const asked = toolName(request.path);
    const answered = result ? toolName(result.resource) : null;
    if (asked && answered) return asked === answered ? asked : null;
    return asked || answered;
  }

  /** The connector a result came back through, and whether it came back at all. */
  function resultOf(message) {
    if (!message || typeof message !== 'object') return null;
    const meta = message.metadata;
    const resource = meta && meta.invoked_resource;
    if (!resource || typeof resource !== 'object') return null;
    return { app: str(resource.app_name), resource: str(resource.resource_uri) };
  }
  /** Exact number of this app's own invocations represented by the whole turn, or null. */
  function localCountOf(messages) {
    if (!Array.isArray(messages)) return null;
    const ids = [];
    let anonymous = 0;
    const remember = (id) => {
      if (!id) {
        anonymous += 1;
        return;
      }
      for (let at = 0; at < ids.length; at++) if (ids[at] === id) return;
      ids.push(id);
    };

    for (let at = 0; at < messages.length; at++) {
      const message = messages[at];
      const request = requestOf(message);
      if (request && ourPath(request.path)) {
        remember(request.messageId);
      }

      const result = resultOf(message);
      if (result && ourApp(result.app)) {
        const meta = message && typeof message === 'object' ? message.metadata : null;
        remember(meta && typeof meta === 'object' ? str(meta.parent_id) : null);
      }
    }
    return Math.min(999, ids.length + anonymous);
  }

  /**
   * One row's descriptor, or null when the shape is not the one we know.
   *
   * The representative call is `messages[0]` — the group's own request, and the one whose
   * name the row shows. It is also the *last* call of what the row stands for: ChatGPT's
   * own "Open tool call list" for a turn that ran five calls showed four rows whose
   * requests were calls two to five, with call one folded under the first row.
   *
   * The result is found by `parent_id`, never by position. Everything after `messages[0]`
   * is a result, but only the one whose `metadata.parent_id` is this request's id answered
   * *this* call; the rest are chained to requests that are not in this array at all.
   * Taking the nearest one instead — which is what scanning forward does — pairs a row with
   * whatever came back next, and that is the live symptom of a row headed `Search files`
   * sitting over another tool's output.
   */
  function describe(row, index) {
    const fiber = fiberOf(row);
    if (!fiber) return null;

    const group = groupOf(fiber);
    if (!group) return null;

    const turnMessages = turnMessagesOf(fiber);
    const localCount = localCountOf(turnMessages);
    const messages = group.messages;
    const request = requestOf(messages[0]);
    if (!request) return null;

    let result = null;
    if (request.messageId) {
      // An index loop and no array method: this walks page-owned data, and the page can
      // replace Array.prototype.find but it cannot replace the language.
      for (let at = 1; at < messages.length && result === null; at++) {
        const message = messages[at];
        const meta = message && typeof message === 'object' ? message.metadata : null;
        if (meta && typeof meta === 'object' && str(meta.parent_id) === request.messageId) {
          result = resultOf(message);
        }
      }
    }

    /**
     * How many calls the row shows in place of, as the page counts them.
     *
     * Presentation cardinality and nothing else. The prop is named for a run of calls to
     * the same tool, but the live page folds different tools together — `list_resources`
     * under one `agents` call — so it says how many the row stands for, never which.
     */
    const hidden = int(own.call(group, 'collapsedSameToolCallCount') ? group.collapsedSameToolCallCount : null);
    const turnId = str(group.turnId);

    return {
      v: VERSION,
      index,
      tool: identify(request, result),
      path: request.path,
      app: result ? result.app : null,
      resource: result ? result.resource : null,
      messageId: request.messageId,
      turnId,
      conversationId: str(group.clientThreadId) || str(group.conversationId),
      createTime: request.createTime,
      hidden,
      // Turn-wide cardinality only. No request arguments or message bodies cross worlds.
      localCount,
      /** Whether the page has shown a result for the representative call yet. */
      answered: result !== null
    };
  }

  /**
   * Every connector request this turn issued, one entry per call.
   *
   * This is the evidence the app's attribution was missing, and it was here the whole time.
   * The visible rows are a *rendering* of these messages: ChatGPT folds a run of calls into
   * one row and on a fast turn draws no row at all until well after the call was answered,
   * so counting rows counts fewer calls than the turn made. Everything the row count could
   * not account for was then filed outside the chat that made it — a single conversation
   * splitting itself into its real session plus a permanently growing pile of unattributed
   * work. The message list does not fold: each request is its own message, with its own id
   * and its own tool path, whatever the renderer decides to draw.
   *
   * Restricted to this app's own connector. A Gmail or Calendar request in the same turn is
   * some other integration's business, and vouching for it would put a stranger's call into
   * this app's session — the precise false match that made a bare connector row weak
   * evidence in the first place.
   *
   * The allowlist is the same one everything else here obeys, and is if anything tighter:
   * a message id, a tool name derived from the front of the path, the position in the turn
   * and whether a result has come back. No argument values, no result bodies, no reasoning,
   * no whole objects. `content.text` is never parsed — only the anchored path is read off
   * the front of it, exactly as `requestOf` already does.
   */
  function callsOf(messages) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    const seen = new Set();
    const answered = new Set();
    // Results first, so a request can say whether its own answer has arrived. `parent_id`
    // is what pairs them; position does not, and pairing by position is how a row came to
    // sit over another tool's output.
    for (let at = 0; at < messages.length && answered.size < MAX_CALLS; at++) {
      const message = messages[at];
      const result = resultOf(message);
      if (!result || !ourApp(result.app)) continue;
      const meta = message && typeof message === 'object' ? message.metadata : null;
      const parent = meta && typeof meta === 'object' ? str(meta.parent_id) : null;
      if (parent) answered.add(parent);
    }

    const duplicated = new Set();
    for (let at = 0; at < messages.length && out.length < MAX_CALLS; at++) {
      const request = requestOf(messages[at]);
      if (!request || !ourPath(request.path)) continue;
      const tool = toolName(request.path);
      const id = request.messageId;
      if (!tool || !id) continue;
      // An id reported twice is an ambiguity, not a second call, and it is dropped on
      // *both* sides: keeping the first would still hand the app one identity standing
      // for two different requests, which is the same piece of evidence spent twice.
      if (seen.has(id)) duplicated.add(id);
      seen.add(id);
      const hasResult = answered.has(id);
      out.push({
        messageId: id,
        tool,
        order: 0,
        answered: hasResult,
        // ChatGPT's own id for the request, and its own timestamp for when the request was
        // created. The app's existing stamp is when the *extension* observed the row, which
        // is a poll tick and jitters per tab; these are the only values on either side that
        // say which request this is and when it was actually issued.
        requestId: request.requestId || null,
        createTime: request.createTime
      });
    }

    const kept = [];
    for (let at = 0; at < out.length; at++) {
      if (duplicated.has(out[at].messageId)) continue;
      out[at].order = kept.length;
      kept.push(out[at]);
    }
    return kept;
  }

  /**
   * The per-turn call evidence for the assistant turns currently on screen.
   *
   * Read from the turn sections rather than from the connector rows, because the case this
   * exists for is the turn that rendered *no* row: climbing from a row cannot reach a turn
   * that has none, which is exactly the turn whose calls went missing.
   */
  function turnsOf(scanToken) {
    const out = [];
    let sections;
    try {
      sections = document.querySelectorAll(TURN_SECTION);
    } catch {
      return out;
    }
    // A descriptor index is valid for one scan only. Stale stamps must disappear when a
    // still-mounted section becomes unreadable, but clearing every stamp up front is not
    // harmless: these attributes are observed by the isolated-world MutationObserver, so
    // remove+restore on every scan creates a self-sustaining scan/mutation loop. Build the
    // desired stamp set first, then change only attributes whose value actually differs.
    const desiredTurnStamps = new Map();
    const groups = [];
    for (let at = 0; at < sections.length; at++) {
      const section = sections[at];
      const id = str(section.getAttribute('data-turn-id'));
      const previous = groups[groups.length - 1];
      if (id && previous && previous.turnId === id) previous.sections.push(section);
      else groups.push({ turnId: id, sections: [section] });
    }
    const first = Math.max(0, groups.length - MAX_TURNS);
    const responseBudget = { remaining: MAX_RESPONSE_TEXT };
    for (let at = first; at < groups.length; at++) {
      const group = groups[at];
      const section = group.sections[0];
      let entry = null;
      try {
        const fiber = fiberOf(section);
        if (!fiber) continue;
        const messages = turnMessagesOf(fiber);
        const calls = callsOf(messages);
        const requests = requestIdsOf(messages);
        const turnBudget = { remaining: Math.min(MAX_TURN_TEXT, responseBudget.remaining) };
        const before = turnBudget.remaining;
        const renderedMessages = renderedMessagesOf(group.sections, messages, turnBudget);
        responseBudget.remaining -= before - turnBudget.remaining;
        const activities = nativeActivitiesOf(group.sections, messages);
        if (
          calls.length === 0 &&
          requests.length === 0 &&
          renderedMessages.length === 0 &&
          activities.length === 0
        ) continue;
        const index = out.length;
        const conversation = conversationEvidenceOf(fiber);
        entry = {
          index,
          turnId: group.turnId,
          conversationId: conversation.conversationId,
          conversationConflict: conversation.conflict,
          endMessageId: turnEndMessageId(messages),
          calls,
          requests,
          messages: renderedMessages,
          activities
        };
        // The isolated-world renderer needs to know which visible section this exact Fiber
        // turn descriptor came from. Remember the desired ephemeral scan index now and apply
        // it after the scan, so a stable scan produces no attribute mutation at all.
        for (let sectionAt = 0; sectionAt < group.sections.length; sectionAt++) {
          const stamped = group.sections[sectionAt];
          if (stamped) desiredTurnStamps.set(stamped, `${scanToken}:${index}`);
        }
      } catch {
        // One unreadable turn must not cost the others their evidence.
        entry = null;
      }
      // `data-turn-id` is presentation metadata, not transcript identity. ChatGPT's current
      // virtualized renderer can omit it from a perfectly readable assistant section while
      // the underlying turn model still exposes exact conversation/message/request ids.
      // Dropping that descriptor made opening or scrolling an old chat lose precisely those
      // messages until another render happened to restore the attribute. Keep the descriptor;
      // content.js will simply leave local turn ownership unset when the page turn id is null.
      if (entry) out.push(entry);
    }
    for (let at = 0; at < sections.length; at++) {
      const section = sections[at];
      try {
        if (!section || !section.getAttribute) continue;
        const wanted = desiredTurnStamps.get(section);
        const current = section.getAttribute('data-clf-fiber-turn');
        if (wanted === undefined) {
          if (current !== null && section.removeAttribute) section.removeAttribute('data-clf-fiber-turn');
        } else if (current !== wanted && section.setAttribute) {
          section.setAttribute('data-clf-fiber-turn', wanted);
        }
      } catch {
        // One hostile/stale DOM node must not cost the remaining turns their evidence.
      }
    }
    return out;
  }

  /**
   * Answers a request from the isolated world.
   *
   * The rows are stamped with their index before the reply is sent, so the two worlds
   * agree on which descriptor belongs to which row without relying on both querying the
   * DOM at the same instant — React can re-render between the two.
   */
  function scan(nonce) {
    // The request nonce already uniquely names this scan across the two worlds. Reuse it as
    // the ephemeral frame token rather than minting a second random value: every DOM stamp
    // can then prove both which descriptor index it names and which exact scan produced it.
    // A stamp from scan N is therefore unusable against descriptors from scan N+1 even when
    // React leaves the old DOM node mounted and both scans happen to use index 0.
    const scanToken = nonce;
    const rows = [];
    let turns = [];
    let scanOk = true;
    try {
      turns = turnsOf(scanToken);
    } catch {
      turns = [];
      scanOk = false;
    }
    let found;
    try {
      found = document.querySelectorAll(CONNECTOR);
    } catch {
      return post({ source: REPLY, nonce, scanToken, v: VERSION, scanOk: false, rows: [], turns }, location.origin);
    }
    const limit = Math.min(found.length, MAX_ROWS);
    for (let index = 0; index < limit; index++) {
      const row = found[index];
      let descriptor = null;
      try {
        descriptor = describe(row, index);
      } catch {
        // One unreadable row must not cost the rest of the page its labels.
        descriptor = null;
      }
      try {
        row.setAttribute('data-clf-fiber', `${scanToken}:${index}`);
      } catch {
        // If the page will not take the marker, the descriptor is unusable: drop it
        // rather than let the other side match it to a row by position.
        descriptor = null;
      }
      if (descriptor) rows.push(descriptor);
    }
    post({ source: REPLY, nonce, scanToken, v: VERSION, scanOk, rows, turns }, location.origin);
  }

  const listener = (event) => {
    // Only this window, only our own request shape. Anything else is not ours to answer.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== ASK) return;
    const nonce = typeof data.nonce === 'string' ? data.nonce.slice(0, 64) : '';
    if (!nonce) return;
    try {
      scan(nonce);
    } catch {
      try {
        post({ source: REPLY, nonce, scanToken: nonce, v: VERSION, scanOk: false, rows: [], turns: [] }, location.origin);
      } catch {
        // Nothing further to try. The other side times out and keeps ChatGPT's labels.
      }
    }
  };
  // Re-execution is a repair, not a marker check. A stale primitive marker could survive
  // while its listener did not, so keep the actual listener and always replace it.
  const prior = window[ACTIVE_HELPER];
  if (prior && prior.version === VERSION && typeof prior.listener === 'function') {
    try {
      window.removeEventListener('message', prior.listener);
    } catch {
      // Installing the replacement below is still the only useful recovery action.
    }
  }
  window.addEventListener('message', listener);
  window[ACTIVE_HELPER] = { version: VERSION, listener };
})();
