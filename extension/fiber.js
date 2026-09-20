/**
 * The only code this extension runs in ChatGPT's own JavaScript context.
 *
 * A collapsed connector row shows the word "Called tool" and
 * nothing else, but the React Fiber behind it already knows exactly which tool ran, under
 * which connector, and how many further calls that single row is standing in for. That
 * last part is why this file has to exist at all — the page renders one row for a run of
 * calls, not always to the same tool, so the visible rows are not a list of the calls, and
 * no amount of DOM reading from the isolated world can recover the ones it folded away.
 * The same bounded bridge also reads account-evaluated model choices and the installed
 * connector's public tool declarations. Neither path exports account/session objects or
 * invokes React action callbacks; the named serverId$ signal is read only for durable
 * conversation identity. The isolated world owns UI actions and operation claims.
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
  const VERSION = 21;
  // The MAIN world survives an extension reload because the ChatGPT document survives it.
  // Recovery may therefore execute this file again in a page that still has an older helper
  // listener. Retire it across versions too: picker/plugin replies use their own v1
  // protocol, so an older listener can otherwise win with an empty or stale snapshot.
  const ACTIVE_HELPER = '__clfFiberHelper';
  const ASK = 'clf-fiber-ask';
  const REPLY = 'clf-fiber-reply';
  /** Only a successfully described connector row carries this scan reference. */
  const CONNECTOR = '[data-clf-fiber]';
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
  /** Mounted section groups read per scan, including user and assistant groups. */
  const MAX_TURNS = 6;
  /** Connector requests reported for one turn. Far above any real turn's call count. */
  const MAX_CALLS = 200;
  /** Public generated-image descriptors retained per turn. Pixels never cross this boundary. */
  const MAX_GENERATED_IMAGES = 200;
  /** ChatGPT's own assistant turn sections, which is where a turn's message model hangs. */
  // Shell anchors and typed items adapted from @ehkogh's #318. Keep one wire format.
  const SHELL_TURN = '[data-app-shell-main-surface] [data-thread-find-target="conversation"] [data-turn-key]';
  const TURN_SECTION = `section[data-testid^="conversation-turn"], ${SHELL_TURN}`;
  /** ChatGPT-rendered authored prose. Tool rows and this extension's own surfaces are excluded. */
  const MARKDOWN = '.markdown, [data-content-search-unit-key$=":assistant"] [data-markdown-text-style="assistant-message"]';
  const TOOL = 'span[class*="tool-message"], div.pointer-events-none.contents, div:has(> [data-testid="cot-v5-tool-icon-pile"])';
  const GENERATED_IMAGE = '[class~="group/imagegen-image"] img';
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
  const OUR_APPS = ['Chat On Steroids Core', 'Chat On Steroids Desktop', 'Chat On Steroids Plugins', 'TobisComputer'];

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

  // One synchronous observation owns these path views. Never retain a React tree
  // between requests or mutate its return pointers when a memoized child is shared.
  let currentPaths = null;
  function committedPath(fiber) {
    const path = [], seen = new Set();
    let at = fiber, base = null, paired = false;
    const view = (node, parent) => ({ memoizedProps: node.memoizedProps,
      memoizedState: node.memoizedState, updateQueue: node.updateQueue, return: parent });
    const remember = (node, value) => {
      currentPaths?.set(node, value);
      if (node.alternate) currentPaths?.set(node.alternate, value);
    };
    while (at && path.length < 400) {
      if (seen.has(at)) return null;
      seen.add(at);
      const cached = currentPaths?.get(at);
      if (cached && cached.root.current === cached.current) { base = cached; break; }
      paired ||= !!at.alternate;
      if (at.tag === 3) {
        const root = at.stateNode, current = root?.current;
        if (!current || (current !== at && current !== at.alternate)) return null;
        base = { root, current, node: current, view: view(current, null) };
        remember(at, base);
        break;
      }
      path.push(at); at = at.return;
    }
    // Older unpaired owner facades have no root bookkeeping. A double-buffered
    // or actual React tree must prove its committed root, including on unmount.
    if (!base) return !paired && !at && path.every(node => typeof node.tag !== 'number') ? fiber : null;
    let budget = 4096;
    for (let index = path.length - 1; index >= 0; index--) {
      const wanted = path[index];
      let selected = null;
      // Walk only this parent's child list, never an arbitrary subtree or cache.
      // Return links can still name the previous parent after a React bailout.
      for (let child = base.node.child; child; child = child.sibling) {
        if (--budget < 0) return null;
        if (child !== wanted && child !== wanted.alternate) continue;
        if (selected) return null;
        selected = child;
      }
      if (!selected || base.root.current !== base.current) return null;
      base = { root: base.root, current: base.current, node: selected, view: view(selected, base.view) };
      remember(wanted, base);
    }
    return base.view;
  }

  /** The DOM's original Fiber pointer may be the previous render. Read the
   * root-selected child path, preserving current ancestors of shared children. */
  function fiberOf(node) {
    for (const key in node) {
      if (key.charCodeAt(0) === 95 && key.indexOf('__reactFiber$') === 0) return committedPath(node[key]);
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
    const conversations = new Map();
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const turn = props.turn && typeof props.turn === 'object' ? props.turn : null;
      // The mounted conversation.id can be a local WEB identity, not the /c id.
      // Its serverId$ signal is the read-only durable identity used by that same
      // conversation object. Read it once per object; never equate the local id
      // with the page route or infer ownership from the URL itself.
      const conversation = props.conversation && typeof props.conversation === 'object' ? props.conversation : null;
      if (conversation && !conversations.has(conversation)) {
        let serverId = null;
        try {
          const value = typeof conversation.serverId$ === 'function' ? conversation.serverId$() : null;
          if (typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) serverId = value;
        } catch { /* Unresolved signal carries no durable identity. */ }
        conversations.set(conversation, serverId);
      }
      const values = [props.clientThreadId, props.conversationId, conversation && conversation.id,
        Array.isArray(props.entry?.turn?.items) ? props.entry.conversationId : null,
        conversations.get(conversation), turn && turn.clientThreadId, turn && turn.conversationId];
      for (let index = 0; index < values.length; index++) {
        const value = str(values[index]);
        if (!value || value.startsWith('WEB:') || value.startsWith('local-chatgpt:')) continue;
        if (found && found !== value) return { conversationId: null, conflict: true };
        found = value;
      }
    }
    return { conversationId: found, conflict: false };
  }

  /** An authored assistant message object, when a rendered prose node exposes one directly. */
  function messageOf(fiber, candidates, conversationId) {
    let found = null;
    const scope = conversationEvidenceOf(fiber);
    if (scope.conflict || (scope.conversationId && conversationId && scope.conversationId !== conversationId)) return null;
    let at = fiber;
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const candidate = props.message;
      const direct = candidate && typeof candidate === 'object' && candidate.author?.role === 'assistant' &&
        !requestOf(candidate) && !resultOf(candidate) ? str(candidate.id) : null;
      const scoped = props.conversation && scope.conversationId && scope.conversationId === conversationId ? str(props.messageId) : null;
      // Native public interim rows expose a typed preamble key, while their
      // messageId/conversation props can both be undefined. Join the complete key
      // to this turn's authored candidates; displayed prose is never identity.
      const item = props.item;
      let preamble = null;
      if (item?.type === 'preamble') {
        if (!scope.conversationId || scope.conversationId !== conversationId) return null;
        preamble = candidates.find(candidate => item.key === `preamble-${candidate.id}`)?.id;
        if (!preamble) return null;
      }
      const typed = item?.type === 'assistant-message' && scope.conversationId === conversationId ? str(item.messageId) : null;
      for (const id of [direct, scoped, preamble, typed]) {
        if (!id) continue;
        if (!candidates.some(candidate => candidate.id === id)) return null;
        if (found && found !== id) return null;
        found = id;
      }
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
    const terminalId = turnEndMessageId(messages);
    for (const candidate of messages) {
      if (thoughtMessage(candidate)) thoughtParents.set(str(candidate.id), candidate);
    }
    for (let index = 0; index < messages.length; index++) {
      if (!budget || budget.remaining <= 0) break;
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      const author = message.author;
      if (!author || author.role !== 'assistant') continue;
      // ChatGPT visually hides public preambles even while their text still grows.
      // That presentation flag must not freeze or discard these typed public updates.
      const publicPreamble = message.recipient === 'all' && channelOf(message) === 'commentary' &&
        message.content?.content_type === 'text' && message.metadata?.is_thinking_preamble_message === true &&
        message.metadata.is_visually_hidden !== true;
      if (requestOf(message) || resultOf(message) || (hiddenMessage(message) && !publicPreamble)) continue;
      // Private reasoning, by ChatGPT's own routing. Never a transcript row.
      if (analysisMessage(message)) continue;
      const id = str(message.id);
      const rawText = budgetedText(authoredText(message), budget, MAX_RENDERED_TEXT);
      // A native final can be textless (for example after generated images).
      // Preserve its exact end_turn proof through the normal message pipeline.
      if (!id || (!rawText && id !== terminalId)) continue;
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
      const content = message.content;
      const multimodal = content?.content_type === 'multimodal_text' && Array.isArray(content.parts);
      const imageCount = multimodal ? content.parts.filter(part => part?.content_type === 'image_asset_pointer').length : 0;
      const attachments = imageCount > 0 && Array.isArray(message.metadata?.attachments)
        ? message.metadata.attachments.filter(file => file && typeof file.id === 'string' && file.id.length > 0 && file.id.length <= 100 &&
          typeof file.name === 'string' && file.name.length > 0 && file.name.length <= 200 &&
          /^image\/[a-z0-9.+-]{1,80}$/i.test(file.mime_type) && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 512 * 1024 * 1024)
          .slice(0, Math.min(4, imageCount)).map(file => ({ id: file.id, name: file.name, size: file.size, mimeType: file.mime_type })) : [];
      const authored = multimodal ? content.parts.filter(part => typeof part === 'string').join('\n') : authoredText(message);
      const rawText = budgetedText(authored, budget, MAX_RENDERED_TEXT) || '';
      if (!id || (!rawText && !attachments.length)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        messageId: id,
        role: 'user',
        stable: true,
        rawText,
        ...(attachments.length ? { attachments } : {}),
        order: index,
        createTime: authoredTime(message)
      });
    }
    return out;
  }

  /**
   * Public native generated-image outputs in ChatGPT's own turn model.
   *
   * Live evidence records these as role=tool, channel=final multimodal messages rather than
   * assistant prose. The typed public assistant role is also supported for the same payload;
   * every other role/channel is private or unknown. User image pointers are
   * uploads and every other role/channel is private or unknown. Only the provider message UUID,
   * sediment file id and bounded geometry cross worlds; no signed URL or arbitrary metadata does.
   */
  function generatedImagesOf(sections, messages, exactImageNodes) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(messages)) return out;
    for (let index = 0; index < messages.length && out.length < MAX_GENERATED_IMAGES; index++) {
      const message = messages[index];
      if (!message || typeof message !== 'object' || hiddenMessage(message) || analysisMessage(message)) continue;
      const role = message.author && (message.author.role === 'tool' || message.author.role === 'assistant')
        ? message.author.role : null;
      if (!role || message.recipient !== 'all' || neverTerminalChannel(message)) continue;
      const messageId = str(message.id);
      const content = message.content;
      if (!messageId || !content || typeof content !== 'object' || content.content_type !== 'multimodal_text' || !Array.isArray(content.parts)) continue;
      for (let partOrder = 0; partOrder < content.parts.length && out.length < MAX_GENERATED_IMAGES; partOrder++) {
        const part = content.parts[partOrder];
        if (!part || typeof part !== 'object' || part.content_type !== 'image_asset_pointer') continue;
        const pointer = str(part.asset_pointer);
        const match = pointer && /^sediment:\/\/(file_[A-Za-z0-9_-]{8,100})$/.exec(pointer);
        if (!match) continue;
        const assetId = match[1];
        const key = `${messageId}\u0000${assetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const width = Number.isInteger(part.width) && part.width > 0 && part.width <= 30_000 ? part.width : null;
        const height = Number.isInteger(part.height) && part.height > 0 && part.height <= 30_000 ? part.height : null;
        out.push({
          messageId,
          assetId,
          providerRole: role,
          providerChannel: channelOf(message) || null,
          providerStatus: message.status === 'finished_successfully' || message.status === 'in_progress' ? message.status : null,
          order: index,
          partOrder,
          createTime: authoredTime(message),
          ...(width ? { width } : {}),
          ...(height ? { height } : {})
        });
      }
    }

    // The URL is an ephemeral pixel selector, never durable identity. It is accepted only
    // inside this exact turn, for the exact same-origin estuary endpoint, and only when typed
    // ownership is unique for the sediment file id. A gallery can mount several presentation
    // clones of the same exact asset, so DOM node count is not ownership.
    const descriptorsByAsset = new Map();
    for (const image of out) {
      const list = descriptorsByAsset.get(image.assetId) || [];
      list.push(image);
      descriptorsByAsset.set(image.assetId, list);
    }
    const nodesByAsset = new Map();
    for (const section of sections) {
      let nodes = [];
      try { nodes = section.querySelectorAll(GENERATED_IMAGE); } catch { nodes = []; }
      for (const node of nodes) {
        try {
          const url = new URL(node.currentSrc || node.src, location.href);
          if (url.origin !== location.origin || url.pathname !== '/backend-api/estuary/content') continue;
          const assetId = url.searchParams.get('id');
          if (!assetId || !descriptorsByAsset.has(assetId)) continue;
          const list = nodesByAsset.get(assetId) || [];
          list.push(node);
          nodesByAsset.set(assetId, list);
        } catch {
          // A malformed or inaccessible URL simply has no pixel authority.
        }
      }
    }
    for (const [assetId, descriptors] of descriptorsByAsset) {
      const nodes = nodesByAsset.get(assetId) || [];
      // A native gallery mounts several presentation clones (main image, thumbnail, mask and
      // blur layers) for one exact asset. They all resolve the same source bytes, so stamp all
      // of them. Ambiguous *typed ownership* remains fail-closed.
      if (descriptors.length !== 1 || nodes.length === 0) continue;
      for (const node of nodes) exactImageNodes.set(node, descriptors[0]);
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
    // The latest public message that *could* be the answer is the current state of the assistant
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
      if (!content || typeof content !== 'object' || !['text', 'multimodal_text', 'image'].includes(content.content_type)) continue;
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
  function renderedMessagesOf(sections, messages, budget, exactAnchors, conversationId) {
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
          if (fiber) id = messageOf(fiber, assistantCandidates, conversationId);
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
    // Only direct native/Fiber identity can authorize DOM placement. The optional
    // HTML attachment fallbacks below must never become mutation anchors.
    for (let at = 0; at < ids.length; at++) {
      const id = ids[at];
      if (id && ids.filter(value => value === id).length === 1) exactAnchors.set(blocks[at], id);
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
        ...(userCandidates[c].attachments ? { attachments: userCandidates[c].attachments } : {}),
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
  function nativeActivitiesOf(sections, messages, exactThoughtRows) {
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
    if (thoughtIds.size === 0) return { events: [], notifications: [] };

    const held = [];
    const notificationIds = new Set();
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
        let activity = null;
        try {
          const fiber = fiberOf(row);
          if (fiber) activity = thoughtItemOf(fiber, thoughtIds);
        } catch {
          activity = null;
        }
        if (!activity) continue;
        // Presentation identity is independent from label stability. React can keep the same
        // typed thought item mounted twice while changing its caption; both exact DOM copies
        // remain safe suppression targets even though the recorder must refuse the conflicting
        // display text for this scan.
        exactThoughtRows.set(row, activity.messageId);
        notificationIds.add(activity.messageId);
        // The native icon/empty layout mounts before its caption. Typed identity
        // already proves what may be suppressed; only recording needs text.
        if (!label) continue;

        let prior = null;
        for (let entryAt = 0; entryAt < held.length; entryAt++) {
          if (held[entryAt].messageId === activity.messageId) prior = held[entryAt];
        }
        if (!prior) {
          held.push({
            messageId: activity.messageId,
            label,
            order: thoughtOrder.get(activity.thoughtMessageId),
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
    return {
      events: out,
      notifications: [...notificationIds].slice(0, MAX_CALLS).map(messageId => ({
        messageId,
        kind: 'thought_notification'
      }))
    };
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

  function conflictingRequestScope(left, right) {
    return ['request_id', 'working_turn_id', 'turn_exchange_id'].some(key =>
      str(left.metadata?.[key]) && str(right.metadata?.[key]) && left.metadata[key] !== right.metadata[key]);
  }

  /** Native results can point through a completed assistant/all intermediate message.
   * Follow its exact parent links inside this turn, stopping at any other tool boundary.
   * Repeated ids, cycles and contradictory request/working-turn ids provide no receipt. */
  function resultParentsOf(messages) {
    const byId = new Map(), parents = new Map();
    for (const message of messages || []) {
      const id = str(message?.id);
      if (id) byId.set(id, byId.has(id) ? null : message);
    }
    for (const message of messages || []) {
      const result = resultOf(message);
      if (!result || !ourApp(result.app)) continue;
      const visited = new Set();
      let id = str(message.metadata?.parent_id), parentId = null;
      while (id && visited.size < MAX_CALLS && !visited.has(id)) {
        visited.add(id);
        const parent = byId.get(id);
        if (!parent) { if (!byId.has(id)) parentId = id; break; }
        if (conflictingRequestScope(parent, message)) break;
        const request = requestOf(parent);
        if (request) { if (identify(request, result)) parentId = id; break; }
        if (parent.author?.role !== 'assistant' || parent.recipient !== 'all' ||
            parent.status !== 'finished_successfully' || parent.end_turn === true) break;
        id = str(parent.metadata?.parent_id);
      }
      parents.set(message, parentId);
    }
    return parents;
  }

  /** Rehydrated direct calls can expose only their public result object. Its UUID,
   * request id and invoked resource are exact evidence; no parent or payload is guessed. */
  function completedCallOf(message) {
    if (!message || message.author?.role !== 'tool' || message.author.name !== 'api_tool.call_tool' ||
        message.recipient !== 'all' || str(message.metadata?.parent_id)) return null;
    const result = resultOf(message);
    const messageId = str(message.id), requestId = str(message.metadata?.request_id);
    const tool = result && toolName(result.resource);
    if (!result || !ourApp(result.app) || !messageId || !requestId || !tool) return null;
    return { ...result, messageId, requestId, tool, createTime: num(message.create_time) };
  }
  /** Exact number of this app's own invocations represented by the whole turn, or null. */
  function localCountOf(messages, resultParents = resultParentsOf(messages)) {
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
        remember(resultParents.get(message) || completedCallOf(message)?.messageId);
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
    const messages = group.messages;
    const resultParents = resultParentsOf(turnMessages || messages);
    const localCount = localCountOf(turnMessages, resultParents);
    const request = requestOf(messages[0]);
    // A rejected result join is not positive evidence for the request's label.
    // Keep an explicit contradictory parent/result visible as an unknown row.
    const conflictingResult = request?.messageId && messages.some(message =>
      str(message?.metadata?.parent_id) === request.messageId && resultOf(message) &&
      identify(request, resultOf(message)) === null);
    let result = null;
    if (request?.messageId) {
      // An index loop and no array method: this walks page-owned data, and the page can
      // replace Array.prototype.find but it cannot replace the language.
      for (let at = 1; at < messages.length && result === null; at++) {
        const message = messages[at];
        if (resultParents.get(message) === request.messageId) {
          result = resultOf(message);
        }
      }
    }

    let completed = request ? null : completedCallOf(messages[0]);
    // A settled native disclosure can retain a stale request before a parentless result.
    // Represent the result's own UUID, leaving the unrelated request unanswered in callsOf.
    // Never borrow a neighbor's result to complete that request or a still-running group.
    if (request && !result && group.isCompletionRequestInProgress === false && messages.length === 2 &&
        messages[0].status === 'finished_successfully' && messages[1].status === 'finished_successfully' &&
        !conflictingRequestScope(messages[0], messages[1]) && ourPath(request.path)) {
      const displayed = completedCallOf(messages[1]);
      if (displayed && displayed.requestId === request.requestId && identify(request, displayed) === displayed.tool) completed = displayed;
    }
    if (completed) return { v: VERSION, index, tool: completed.tool, path: null, app: completed.app,
      resource: completed.resource, messageId: completed.messageId, turnId: str(group.turnId),
      conversationId: str(group.clientThreadId) || str(group.conversationId), createTime: completed.createTime,
      hidden: int(own.call(group, 'collapsedSameToolCallCount') ? group.collapsedSameToolCallCount : null),
      localCount, answered: true };
    if (!request) return null;

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
      tool: conflictingResult ? null : identify(request, result),
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
  /** Native Code Mode chains child requests/results before one functions.exec result.
   * A child's parent_id is then chronology, not its individual response receipt.
   * Resolve the exact enclosing call without reading code or result payloads. */
  function codeModeReceipts(messages) {
    const byId = new Map();
    for (const message of messages) {
      const id = str(message && message.id);
      if (id) byId.set(id, byId.has(id) ? null : message);
    }
    const owners = new Map();
    const scope = message => {
      const meta = message && message.metadata;
      const request = str(meta && meta.request_id), working = str(meta && meta.working_turn_id),
        exchange = str(meta && meta.turn_exchange_id);
      return request && working && exchange ? `${request}\u0000${working}\u0000${exchange}` : null;
    };
    const ownerOf = message => {
      const trail = [], visited = new Set();
      let cursor = message, owner = null;
      while (cursor && trail.length < MAX_CALLS) {
        const id = str(cursor.id);
        if (!id || byId.get(id) !== cursor || visited.has(id)) break;
        visited.add(id);
        const role = cursor.author && cursor.author.role;
        if (role === 'assistant' && cursor.recipient === 'functions.exec') {
          owner = { id, scope: scope(cursor), valid: cursor.status === 'finished_successfully' && !!scope(cursor) };
          break;
        }
        // An earlier completed enclosing call cannot own a later ordinary invocation.
        if (trail.length && role === 'tool' && cursor.author.name === 'functions.exec') break;
        if (owners.has(id)) { owner = owners.get(id); break; }
        if (!((role === 'assistant' && cursor.recipient === 'api_tool.call_tool') ||
            (role === 'tool' && cursor.recipient === 'all' &&
              (cursor.author.name === 'api_tool.call_tool' || cursor.author.name === 'functions.exec')))) break;
        trail.push(cursor);
        cursor = byId.get(str(cursor.metadata && cursor.metadata.parent_id));
      }
      for (let index = trail.length - 1; index >= 0; index--) {
        if (owner) owner = { ...owner, valid: owner.valid && scope(trail[index]) === owner.scope };
        owners.set(trail[index].id, owner);
      }
      return owner;
    };
    const completed = new Set();
    for (const message of messages) {
      if (message && message.author && message.author.role === 'tool' && message.author.name === 'functions.exec' &&
          message.recipient === 'all' && message.status === 'finished_successfully' && byId.get(message.id) === message) {
        const owner = ownerOf(message);
        if (owner && owner.valid) completed.add(owner.id);
      }
    }
    const receipts = new Map();
    for (const message of messages) {
      const owner = ownerOf(message);
      if (owner) receipts.set(message.id, owner.valid && completed.has(owner.id));
    }
    return receipts;
  }

  function callsOf(messages, codeReceipts) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    const seen = new Set();
    const answered = new Set();
    const resultParents = resultParentsOf(messages);
    // Results first, so a request can say whether its own answer has arrived. `parent_id`
    // is what pairs them; position does not, and pairing by position is how a row came to
    // sit over another tool's output.
    for (let at = 0; at < messages.length && answered.size < MAX_CALLS; at++) {
      const message = messages[at];
      const result = resultOf(message);
      if (!result || !ourApp(result.app)) continue;
      const parent = resultParents.get(message);
      if (parent) answered.add(parent);
    }

    const duplicated = new Set();
    for (let at = 0; at < messages.length && out.length < MAX_CALLS; at++) {
      const request = requestOf(messages[at]);
      const completed = request ? null : completedCallOf(messages[at]);
      if ((!request || !ourPath(request.path)) && !completed) continue;
      const tool = completed ? completed.tool : toolName(request.path);
      const id = completed ? completed.messageId : request.messageId;
      if (!tool || !id) continue;
      // An id reported twice is an ambiguity, not a second call, and it is dropped on
      // *both* sides: keeping the first would still hand the app one identity standing
      // for two different requests, which is the same piece of evidence spent twice.
      if (seen.has(id)) duplicated.add(id);
      seen.add(id);
      const hasResult = codeReceipts.has(id) ? codeReceipts.get(id) : Boolean(completed) || answered.has(id);
      out.push({
        messageId: id,
        tool,
        order: 0,
        answered: hasResult,
        // ChatGPT's own id for the request, and its own timestamp for when the request was
        // created. The app's existing stamp is when the *extension* observed the row, which
        // is a poll tick and jitters per tab; these are the only values on either side that
        // say which request this is and when it was actually issued.
        requestId: (completed || request).requestId || null,
        createTime: (completed || request).createTime
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
  /** Read the currently mounted query owner; never retain a client across navigation. */
  function shellQueries(fiber) {
    try {
      for (let at = fiber, up = 0; at && up < 400; up++, at = at.return) {
        const client = at.memoizedProps?.client;
        if (typeof client?.getQueryCache !== 'function') continue;
        const queries = client.getQueryCache()?.getAll();
        return Array.isArray(queries) && queries.length <= 512 ? queries : [];
      }
    } catch { /* Optional metadata must not cost the mounted transcript. */ }
    return [];
  }
  /** Exact local/server pair only; a route or the latest cached chat is not a join. */
  function shellConversation(queries, localId, evidence) {
    if (evidence.conflict || !localId?.startsWith('local-chatgpt:')) return evidence;
    let found = evidence.conversationId;
    for (const query of queries) {
      const key = query?.queryKey;
      if (!Array.isArray(key) || key.length !== 2 || key[0] !== 'chatgpt-conversation-details' || key[1]?.clientConversationId !== localId) continue;
      const server = key[1].serverConversationId;
      if (typeof server !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(server)) continue;
      if (found && found !== server) return { conversationId: null, conflict: true };
      found = server;
    }
    return { conversationId: found, conflict: false };
  }
  /** The native shell subscribes to its live mapping independently of the history
   * query (144961 / QH.C). Read published React values, never invoke store actions
   * or enumerate cached branches. The mounted owner and exact user id fence this
   * optional source before any message metadata can leave the helper. */
  function shellLiveMapping(fiber, entry) {
    const user = entry.turn.items.find(item => item?.type === 'user-message');
    const userId = str(user?.messageId) || str(user?.serverMessageId);
    if (!userId) return null;
    const snapshots = new Map();
    const inspected = new WeakSet();
    const value = (object, key) => object && typeof object === 'object'
      ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
    let conflict = false;
    const inspect = candidate => {
      if (!candidate || typeof candidate !== 'object' || inspected.has(candidate)) return;
      inspected.add(candidate);
      const conversation = value(candidate, 'renderedConversation'), turns = value(candidate, 'renderedTurns');
      const mapping = value(conversation, 'mapping');
      if (!mapping || !Array.isArray(turns) || turns.length > 4096 ||
          turns.filter(turn => turn?.id === entry.id && turn.turn === entry.turn).length !== 1) return;
      const node = value(mapping, userId), message = value(node, 'message');
      if (value(node, 'id') !== userId || value(message, 'id') !== userId || message.author?.role !== 'user') return;
      const prior = snapshots.get(mapping);
      if (prior && prior.renderedConversation.current_node !== conversation.current_node) conflict = true;
      snapshots.set(mapping, candidate);
    };
    let remaining = 2048;
    for (let at = fiber, up = 0; at && up < MAX_CLIMB && remaining > 0; up++, at = at.return) {
      if (at.memoizedProps?.conversationId !== entry.conversationId) continue;
      for (let hook = at.memoizedState; hook && remaining-- > 0; hook = hook.next) {
        const state = value(hook, 'memoizedState');
        inspect(state); if (Array.isArray(state)) inspect(state[0]);
      }
      const data = at.updateQueue?.memoCache?.data;
      if (!Array.isArray(data) || data.length > 32) continue;
      for (const row of data) {
        if (!Array.isArray(row) || row.length > 1024) continue;
        for (const item of row) { if (--remaining < 0) break; inspect(item); }
      }
    }
    return conflict || snapshots.size > 1 || remaining <= 0 ? false : snapshots.values().next().value || null;
  }
  /** The renderer publishes its chosen current_node together with the very same
   * turn object. Follow parent links back to that turn's actual user, never pick
   * a child or import another branch. Untyped early messages contribute ids only. */
  function shellCurrentPath(snapshot, entry) {
    if (snapshot?.renderedTurns.at(-1)?.turn !== entry.turn) return [];
    const mapping = snapshot.renderedConversation.mapping, ids = [], seen = new Set();
    let id = snapshot.renderedConversation.current_node;
    for (let at = 0; at < MAX_ROWS && typeof id === 'string' && id.length <= MAX_TEXT && !seen.has(id); at++) {
      const node = Object.getOwnPropertyDescriptor(mapping, id)?.value, message = node?.message;
      if (node?.id !== id || message?.id !== id) return [];
      seen.add(id); ids.push(id);
      if (message.author?.role === 'user') {
        const user = entry.turn.items.find(item => item?.type === 'user-message');
        return id === (user?.messageId || user?.serverMessageId) && entry.turn.messageIds.every(value => seen.has(value))
          ? ids.reverse() : [];
      }
      id = node.parent;
    }
    return [];
  }
  /** #318 identified the history cache. Both sources project only explicitly named
   * messages. Typed public items own presentation; cache text cannot supply a final. */
  function shellRequestMetadata(fiber, queries, shell, conversation) {
    if (conversation.conflict) return [];
    const entry = shell.entry;
    const ids = entry.turn.messageIds;
    if (!Array.isArray(ids) || ids.length > MAX_ROWS || new Set(ids).size !== ids.length) return [];
    let live;
    try { live = shellLiveMapping(fiber, entry); } catch { return []; }
    if (live === false) return [];
    // A freshly submitted shell exchange can still carry only its provisional
    // local-chatgpt id while the page route already names the real conversation.
    // The mounted live mapping is independently fenced by this exact entry, turn
    // object and user message id, so retain its request metadata during that gap.
    // Cache metadata still requires the concrete server conversation join below.
    if (!conversation.conversationId && !live) return [];
    const matches = conversation.conversationId ? queries.filter(query => Array.isArray(query?.queryKey) && query.queryKey.length === 2 &&
      query.queryKey[0] === 'chatgpt-conversation' && query.queryKey[1] === conversation.conversationId) : [];
    if (matches.length > 1) return [];
    const data = matches[0]?.state?.data;
    if (data?.conversation_id && data.conversation_id !== conversation.conversationId) return [];
    const mapping = live?.renderedConversation?.mapping || data?.mapping;
    if (!mapping || typeof mapping !== 'object') return [];
    const out = [];
    const publicBudget = { remaining: MAX_TURN_TEXT };
    const selected = new Set(ids);
    const invocationIds = new Set();
    const sourceCounts = new Map();
    for (const reference of shell.callSources.values()) if (reference.id)
      sourceCounts.set(reference.id, (sourceCounts.get(reference.id) || 0) + 1);
    const messageAt = id => {
      const node = id && Object.getOwnPropertyDescriptor(mapping, id)?.value;
      return node?.id === id && node.message?.id === id ? node.message : null;
    };
    // Native dynamic-tool-call.callId explicitly names the functions.exec
    // invocation (811613 / L). Its source can disappear from messageIds when
    // paired results replace sourceMessage. Read metadata, never its code.
    for (const id of shell.executionIds) {
      const message = messageAt(id);
      if (message?.author?.role === 'assistant' && message.recipient === 'functions.exec') invocationIds.add(id);
    }
    const serverName = name => OUR_APPS.find(app => name === app || name === app.replaceAll(' ', '_'));
    for (const call of shell.calls) {
      const reference = shell.callSources.get(call.messageId);
      if (!reference?.id || !selected.has(reference.id) || sourceCounts.get(reference.id) !== 1) continue;
      const result = messageAt(reference.id);
      if (result?.author?.role !== 'tool') continue;
      const resource = resultOf(result);
      if (resource && (serverName(resource.app) !== serverName(reference.server) || toolName(resource.resource) !== call.tool)) continue;
      const invocation = messageAt(call.messageId);
      if (invocation) {
        const asked = requestOf(invocation), path = asked?.path;
        // Native N() keeps callId while replacing sourceMessage with the result.
        // This mounted relation, not cache position or a sibling's request id,
        // permits reading the original invocation's metadata after a reload.
        if (invocation.recipient !== 'api_tool.call_tool' || !path || serverName(path.slice(1, path.indexOf('/', 1))) !== serverName(reference.server) ||
            toolName(path) !== call.tool) continue;
        for (const key of ['request_id', 'working_turn_id', 'turn_exchange_id']) {
          const a = str(invocation.metadata?.[key]), b = str(result.metadata?.[key]);
          if (a && b && a !== b) return [];
        }
        invocationIds.add(call.messageId);
      }
      reference.metadataId = reference.id;
    }
    for (const id of new Set([...ids, ...invocationIds, ...shellCurrentPath(live, entry)])) {
      if (typeof id !== 'string' || !id || id.length > MAX_TEXT || !own.call(mapping, id)) continue;
      const node = Object.getOwnPropertyDescriptor(mapping, id)?.value, message = node?.message;
      if (node?.id !== id || message?.id !== id) continue;
      const request = str(message.metadata?.request_id), cached = data?.mapping?.[id]?.message;
      if (live && cached?.id === id && request && cached.metadata?.request_id && cached.metadata.request_id !== request) return [];
      const publicMessage = selected.has(id) && message.author?.role === 'assistant' && !hiddenMessage(message) &&
        message.metadata?.is_visually_hidden_reasoning_group !== true && message.metadata?.summary_type !== 'raw_cot';
      const thought = publicMessage && thoughtMessage(message) && Array.isArray(message.content.thoughts)
        ? message.content.thoughts.at(-1)?.summary : null;
      const preamble = publicMessage && channelOf(message) === 'commentary' &&
        (!message.recipient || message.recipient === 'all') ? authoredText(message) : null;
      out.push({ id, create_time: num(message.create_time), metadata: { request_id: request },
        ...(typeof thought === 'string' ? { thought: budgetedText(thought, publicBudget, MAX_RENDERED_TEXT) } : {}),
        ...(preamble ? { preamble: budgetedText(preamble, publicBudget, MAX_RENDERED_TEXT),
          publicIdentity: { parent_id: str(message.metadata?.parent_id), working_turn_id: str(message.metadata?.working_turn_id),
            turn_exchange_id: str(message.metadata?.turn_exchange_id) } } : {}) });
    }
    return out;
  }
  /** Public shell titles/preambles have no ids of their own. Their selected source
   * messages do. Match only unique public representations; never mint ids from a
   * group index, use raw analysis, or suppress DOM based on this text comparison. */
  function shellPublicActivity(shell, metadata, rendered, budget, section, exactAnchors) {
    const publicItems = shell.entry.turn.items.flatMap(item => item?.type === 'chatgpt-reasoning-group' &&
      Array.isArray(item.items) && item.reasoningRecap?.type !== 'hide_all' ? item.items : []).filter(item => item?.type === 'reasoning' &&
        item.isTransient !== true && ['thought', 'preamble'].includes(item.presentation) && typeof item.content === 'string');
    const ids = shell.entry.turn.messageIds;
    const order = new Map(Array.isArray(ids) && ids.length <= MAX_ROWS ? ids.map((id, index) => [id, index]) : []);
    for (const message of rendered) if (order.has(message.rawMessageId)) message.order = order.get(message.rawMessageId);
    const events = [];
    const blocks = [...section.querySelectorAll('[data-markdown-text-style="assistant-message"]')]
      .filter(node => node.closest('[data-turn-key]') === section && !node.closest(OWN_SURFACES)).slice(0, MAX_ROWS);
    for (const source of metadata) for (const kind of ['thought', 'preamble']) {
      const text = source[kind];
      const matches = publicItems.filter(item => item.presentation === kind && item.content === text);
      if (!text || matches.length !== 1 ||
          metadata.filter(other => other[kind] === text).length !== 1) continue;
      const authored = kind === 'preamble' ? authoredAssistantMessages([{ id: source.id, author: { role: 'assistant' },
        channel: 'commentary', metadata: source.publicIdentity, create_time: source.create_time,
        content: { content_type: 'text', parts: [text] } }], budget)[0] : null;
      const publicText = kind === 'thought' ? budgetedText(visibleText(text), budget, 300) : authored?.rawText;
      if (!publicText) continue;
      if (kind === 'thought') events.push({ messageId: source.id, label: publicText, order: order.get(source.id) });
      else if (!rendered.some(message => message.rawMessageId === source.id)) rendered.push({ messageId: authored.messageId,
        rawMessageId: source.id, role: 'assistant', stable: authored.stable, rawText: publicText, renderedHtml: '',
        order: order.get(source.id), createTime: authoredTime(source) });
      if (kind === 'preamble') {
        // Native ChatGptMarkdown is owned by the exact typed reasoning item.
        // Text equality above selects public content; only this object relation
        // may place a local tool chunk beside the provider's own prose node.
        const nodes = blocks.filter(node => {
          for (let at = fiberOf(node), up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
            if (at.memoizedProps?.item === matches[0]) return true;
            if (at.memoizedProps?.entry) break;
          }
          return false;
        });
        if (nodes.length === 1) exactAnchors.set(nodes[0], source.id);
      }
    }
    rendered.sort((a, b) => a.order - b.order);
    return { events, notifications: [] };
  }
  /** Translate only publicly identified items in the mounted exchange. Missing item ids
   * stay missing; a stopped turn does not manufacture replies to its tool calls. */
  function shellTurnSource(fiber, section, turnId) {
    let entry = null;
    for (let at = fiber, up = 0; at && up < 16; up++, at = at.return) {
      if (Array.isArray(at.memoizedProps?.entry?.turn?.items)) { entry = at.memoizedProps.entry; break; }
    }
    if (!entry || !turnId || entry.id !== turnId || entry.turn.items.length > MAX_ROWS) return null;
    const messages = [], calls = [], slots = [], seen = new Set(), callSources = new Map(), executionIds = [];
    const remember = id => { if (!id || seen.has(id)) return false; seen.add(id); return true; };
    let work = 0;
    for (const [index, item] of entry.turn.items.entries()) {
      if (++work > MAX_ROWS) return null;
      if (item?.type === 'user-message' || item?.type === 'assistant-message') {
        const user = item.type === 'user-message', id = str(item.messageId) || (user ? str(item.serverMessageId) : null);
        if (!id) continue;
        if (!remember(id) || (user && item.serverMessageId && item.messageId && item.serverMessageId !== item.messageId)) return null;
        const role = user ? 'user' : 'assistant', text = user ? item.message : item.content;
        const final = !user && item.phase === 'final_answer';
        const completed = final && item.completed === true && entry.turn.status === 'complete';
        messages.push({ id, author: { role }, content: { content_type: 'text', parts: [typeof text === 'string' ? text : ''] },
          channel: user ? null : final ? 'final' : 'commentary', end_turn: completed,
          status: completed ? 'finished_successfully' : 'in_progress', metadata: {} });
        const key = `${turnId}:${index}:${role}`;
        const nodes = [...section.querySelectorAll('[data-content-search-unit-key]')].filter(node =>
          node.closest('[data-turn-key]') === section && node.getAttribute('data-content-search-unit-key') === key);
        if (nodes.length === 1) slots.push({ node: nodes[0], id });
      } else {
        const steps = item?.type === 'chatgpt-reasoning-group' && Array.isArray(item.items) ? item.items : [item];
        for (const step of steps) {
          if (++work > MAX_ROWS) return null;
          if (step?.type === 'dynamic-tool-call' && step.tool === 'exec') {
            const id = str(step.callId);
            if (!id) continue;
            if (!remember(id) || executionIds.length >= MAX_CALLS) return null;
            executionIds.push(id);
            continue;
          }
          if (step?.type !== 'mcp-tool-call' || !OUR_APPS.some(app =>
            step.invocation?.server === app || step.invocation?.server === app.replaceAll(' ', '_'))) continue;
          const id = str(step.callId), tool = toolName(step.invocation?.tool);
          if (!id || !tool) continue;
          if (!remember(id) || calls.length >= MAX_CALLS) return null;
          calls.push({ messageId: id, tool, order: calls.length, answered: step.completed === true, requestId: null, createTime: null });
          callSources.set(id, { id: str(step.widgetStateSource?.messageId), server: step.invocation.server });
        }
      }
    }
    return { entry, messages, calls, slots, callSources, executionIds };
  }
  function turnsOf(scanToken) {
    const out = [];
    let sections;
    try {
      sections = [...document.querySelectorAll(TURN_SECTION)].filter(section => !section.closest(`${OWN_SURFACES},.markdown,[data-markdown-text-style],[data-content-search-unit-key],[contenteditable]`));
    } catch {
      return out;
    }
    // A descriptor index is valid for one scan only. Stale stamps must disappear when a
    // still-mounted section becomes unreadable, but clearing every stamp up front is not
    // harmless: these attributes are observed by the isolated-world MutationObserver, so
    // remove+restore on every scan creates a self-sustaining scan/mutation loop. Build the
    // desired stamp set first, then change only attributes whose value actually differs.
    const desiredTurnStamps = new Map();
    const desiredMessageStamps = new Map();
    const desiredThoughtStamps = new Map();
    const desiredImageStamps = new Map();
    const groups = [];
    for (let at = 0; at < sections.length; at++) {
      const section = sections[at];
      const id = section.matches?.(SHELL_TURN) ? str(section.querySelector('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key')) : str(section.getAttribute('data-turn-id'));
      const previous = groups[groups.length - 1];
      if (id && previous && previous.turnId === id) previous.sections.push(section);
      else groups.push({ turnId: id, sections: [section] });
    }
    // Keep the latest user/assistant boundary even while reading older history.
    // Visible groups share the remaining slots; no additional scan lifecycle.
    const selected = new Set();
    for (let at = Math.max(0, groups.length - 2); at < groups.length; at++) selected.add(at);
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      for (let at = groups.length - 1; at >= 0 && selected.size < MAX_TURNS; at--) {
        if (selected.has(at)) continue;
        const visible = groups[at].sections.some(section => {
          try {
            const rect = section.getBoundingClientRect();
            return [rect.top, rect.bottom, rect.left, rect.right].every(Number.isFinite) &&
              rect.bottom > rect.top && rect.right > rect.left &&
              rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width;
          } catch { return false; }
        });
        if (visible) selected.add(at);
      }
    }
    for (let at = groups.length - 1; at >= 0 && selected.size < MAX_TURNS; at--) selected.add(at);
    const responseBudget = { remaining: MAX_RESPONSE_TEXT };
    for (const at of [...selected].sort((a, b) => a - b)) {
      const group = groups[at];
      const section = group.sections[0];
      let entry = null;
      try {
        const fiber = fiberOf(section);
        if (!fiber) continue;
        const shell = section.matches?.(SHELL_TURN) ? shellTurnSource(fiber, section, group.turnId) : null;
        if (section.matches?.(SHELL_TURN) && !shell) continue;
        const messages = shell ? shell.messages : turnMessagesOf(fiber);
        const codeReceipts = codeModeReceipts(messages || []);
        const codeModeCalls = (messages || []).filter(message => message && message.author &&
          message.author.role === 'assistant' && message.recipient === 'functions.exec').slice(0, MAX_CALLS)
          .map(message => ({ messageId: str(message.id), requestId: str(message.metadata && message.metadata.request_id),
            answered: codeReceipts.get(message.id) === true }));
        const calls = shell ? shell.calls : callsOf(messages, codeReceipts);
        const queries = shell ? shellQueries(fiber) : [];
        const conversation = shell ? shellConversation(queries, shell.entry.conversationId, conversationEvidenceOf(fiber)) : conversationEvidenceOf(fiber);
        const metadata = shell ? shellRequestMetadata(fiber, queries, shell, conversation) : messages;
        const requests = requestIdsOf(metadata);
        if (shell) for (const call of calls) {
          const invocation = metadata.find(message => message.id === call.messageId);
          const source = invocation?.metadata.request_id ? invocation :
            metadata.find(message => message.id === shell.callSources.get(call.messageId)?.metadataId) || invocation;
          call.requestId = source?.metadata.request_id || null;
          call.createTime = source?.create_time ?? null;
        }
        const exactAnchors = new Map();
        const exactThoughtRows = new Map();
        const exactImageNodes = new Map();
        const turnBudget = { remaining: Math.min(MAX_TURN_TEXT, responseBudget.remaining) };
        const before = turnBudget.remaining;
        const renderedMessages = renderedMessagesOf(group.sections, messages, turnBudget, exactAnchors, conversation.conversationId);
        const nativeActivities = shell ? shellPublicActivity(shell, metadata, renderedMessages, turnBudget, section, exactAnchors) : nativeActivitiesOf(group.sections, messages, exactThoughtRows);
        responseBudget.remaining -= before - turnBudget.remaining;
        const generatedImages = generatedImagesOf(group.sections, messages, exactImageNodes);
        const activities = nativeActivities.events;
        const endMessageId = turnEndMessageId(messages);
        // The shell supplies the completed final item's own exact message id,
        // without the classic thought-parent/timestamp tuple. Preserve that
        // identity for handoff capture; streaming and cancelled items stay weak.
        if (shell && !conversation.conflict && conversation.conversationId && endMessageId) {
          const terminal = renderedMessages.find(message => message.role === 'assistant' && message.rawMessageId === endMessageId);
          if (terminal) terminal.stable = true;
        }
        if (
          codeModeCalls.length === 0 && calls.length === 0 &&
          requests.length === 0 &&
          renderedMessages.length === 0 &&
          activities.length === 0 && nativeActivities.notifications.length === 0 && generatedImages.length === 0 && !endMessageId
        ) continue;
        const index = out.length;
        entry = {
          index,
          turnId: group.turnId,
          conversationId: conversation.conversationId,
          conversationConflict: conversation.conflict,
          ...(shell && !conversation.conversationId ? { requestOwnerRequired: true } : {}),
          endMessageId,
          calls,
          codeModeCalls,
          requests,
          messages: renderedMessages,
          activities,
          thoughtNotifications: nativeActivities.notifications,
          images: generatedImages
        };
        // The isolated-world renderer needs to know which visible section this exact Fiber
        // turn descriptor came from. Remember the desired ephemeral scan index now and apply
        // it after the scan, so a stable scan produces no attribute mutation at all.
        for (let sectionAt = 0; sectionAt < group.sections.length; sectionAt++) {
          const stamped = group.sections[sectionAt];
          if (stamped) desiredTurnStamps.set(stamped, `${scanToken}:${index}`);
        }
        if (shell) {
          for (const slot of shell.slots) {
            desiredTurnStamps.set(slot.node, `${scanToken}:${index}`);
            if (!conversation.conflict) desiredMessageStamps.set(slot.node, `${scanToken}:${index}:${encodeURIComponent(slot.id)}`);
            // A slot and its inner Markdown are one native message. Publishing
            // both as placement anchors would make every shell final ambiguous.
            for (const [node, id] of exactAnchors) if (id === slot.id) exactAnchors.delete(node);
          }
          // Busy hint only, never a completion receipt or a Stop action target.
          const running = shell.entry.turn.status === 'in_progress' ? location.pathname : null;
          if (running && section.getAttribute('data-clf-shell-running') !== running) section.setAttribute('data-clf-shell-running', running);
          else if (!running) section.removeAttribute('data-clf-shell-running');
        }
        if (!conversation.conflict) for (const [node, id] of exactAnchors) {
          desiredMessageStamps.set(node, `${scanToken}:${index}:${encodeURIComponent(id)}`);
        }
        if (!conversation.conflict) for (const [node, id] of exactThoughtRows) {
          desiredThoughtStamps.set(node, `${scanToken}:${index}:${encodeURIComponent(id)}`);
        }
        if (!conversation.conflict) for (const [node, image] of exactImageNodes) {
          desiredImageStamps.set(node, `${scanToken}:${index}:${encodeURIComponent(image.messageId)}:${encodeURIComponent(image.assetId)}`);
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
        for (const node of section.querySelectorAll(`[data-clf-fiber-message], [data-content-search-unit-key], [data-markdown-text-style="assistant-message"], ${MARKDOWN}`)) {
          const wantedMessage = desiredMessageStamps.get(node);
          const currentMessage = node.getAttribute('data-clf-fiber-message');
          if (wantedMessage === undefined) {
            if (currentMessage !== null) node.removeAttribute('data-clf-fiber-message');
          } else if (currentMessage !== wantedMessage) node.setAttribute('data-clf-fiber-message', wantedMessage);
        }
        for (const node of section.querySelectorAll(`${TOOL}, [data-clf-fiber-thought]`)) {
          const wantedThought = desiredThoughtStamps.get(node);
          const currentThought = node.getAttribute('data-clf-fiber-thought');
          if (wantedThought === undefined) {
            if (currentThought !== null) node.removeAttribute('data-clf-fiber-thought');
          } else if (currentThought !== wantedThought) node.setAttribute('data-clf-fiber-thought', wantedThought);
        }
        for (const node of section.querySelectorAll(`${GENERATED_IMAGE}, [data-clf-fiber-image]`)) {
          const wantedImage = desiredImageStamps.get(node);
          const currentImage = node.getAttribute('data-clf-fiber-image');
          if (wantedImage === undefined) {
            if (currentImage !== null) node.removeAttribute('data-clf-fiber-image');
          } else if (currentImage !== wantedImage) node.setAttribute('data-clf-fiber-image', wantedImage);
        }
        if (!desiredTurnStamps.has(section)) section.removeAttribute('data-clf-shell-running');
        for (const stamped of [section, ...section.querySelectorAll('[data-content-search-unit-key]')]) {
          const wanted = desiredTurnStamps.get(stamped);
          const current = stamped.getAttribute('data-clf-fiber-turn');
          if (wanted === undefined) {
            if (current !== null && stamped.removeAttribute) stamped.removeAttribute('data-clf-fiber-turn');
          } else if (current !== wanted && stamped.setAttribute) {
            stamped.setAttribute('data-clf-fiber-turn', wanted);
          }
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
    // The existing scan also refreshes mounted-picker evidence; no new poll timer.
    try { pickerSnapshot(); } catch { /* An unknown picker cannot affect recording. */ }
    // The request nonce already uniquely names this scan across the two worlds. Reuse it as
    // the ephemeral frame token rather than minting a second random value: every DOM stamp
    // can then prove both which descriptor index it names and which exact scan produced it.
    // A stamp from scan N is therefore unusable against descriptors from scan N+1 even when
    // React leaves the old DOM node mounted and both scans happen to use index 0.
    const scanToken = nonce;
    const rows = [];
    let turns = [];
    let scanOk = true;
    let found;
    try {
      // Inspect existing native tool containers, never translated control labels.
      // The row-local Fiber group is the authority; built-in tools fail describe().
      found = [...document.querySelectorAll(TOOL)].filter(row => !row.closest(OWN_SURFACES));
      for (const old of document.querySelectorAll(CONNECTOR)) old.removeAttribute('data-clf-fiber');
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
        if (descriptor) row.setAttribute('data-clf-fiber', `${scanToken}:${index}`);
      } catch {
        // If the page will not take the marker, the descriptor is unusable: drop it
        // rather than let the other side match it to a row by position.
        descriptor = null;
      }
      if (descriptor) rows.push(descriptor);
    }
    // Row stamps must exist before native activity projection excludes connectors.
    try {
      turns = turnsOf(scanToken);
    } catch {
      turns = [];
      scanOk = false;
    }
    post({ source: REPLY, nonce, scanToken, v: VERSION, scanOk, rows, turns }, location.origin);
  }

  /** Picker data is account-evaluated state, never a scraped English announcement.
   * Copy only selection metadata; no conversation, account object or callbacks cross worlds. */
  function pickerSnapshot() {
    // The closed native trigger retains the same picker owner. Passive recording
    // must not depend on discovery opening its portal first.
    const form = document.querySelector('#prompt-textarea, form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]')?.closest('form');
    const reported = '[data-codex-intelligence-trigger],[data-composer-navigation-target="reasoning"]';
    const triggers = [...new Set([...(form?.querySelectorAll('button[aria-haspopup="menu"]') || []), ...document.querySelectorAll(reported)])]
      .filter(node => node.matches('button,[role="button"]') && !node.closest(`${OWN_SURFACES},[data-testid^="conversation-turn"],[data-message-author-role],.markdown,[contenteditable],[hidden],[aria-hidden="true"],[inert]`) && node.getClientRects().length > 0 &&
        node.id !== 'composer-plus-btn' && node.getAttribute('data-testid') !== 'composer-plus-btn');
    const candidates = [];
    if (triggers.length <= 8) for (const trigger of triggers) {
      try {
        const picker = readPickerSnapshot(trigger) || readShellPickerSnapshot(trigger);
        if (picker) candidates.push({ node: trigger, picker });
      } catch { /* An unrelated native menu is not picker evidence. */ }
    }
    const specific = candidates.filter(candidate => candidate.node.matches(reported));
    const identified = specific.length === 1 ? specific[0] : candidates.length === 1 ? candidates[0] : null;
    const native = triggers.filter(trigger => trigger.matches(reported));
    const fallback = native.length === 1 ? native[0] : triggers.length === 1 ? triggers[0] : null;
    const node = document.querySelector('[data-testid="composer-intelligence-picker-content"], [data-model-picker-view]') || identified?.node || fallback;
    let state = null;
    try { state = identified?.picker || readPickerSnapshot(node); } catch { /* Unknown state invalidates prior proof. */ }
    const selected = state ? state.choices.find(choice => choice.bucket === state.currentBucket && choice.available)
      : (node && node === fallback ? closedPickerSelection(node) : null);
    const provenTrigger = identified?.node || (selected && node === fallback ? fallback : null);
    for (const trigger of triggers) {
      if (trigger !== provenTrigger) trigger.removeAttribute('data-clf-picker-route');
      else if (trigger.getAttribute('data-clf-picker-route') !== location.pathname) trigger.setAttribute('data-clf-picker-route', location.pathname);
      if (trigger !== node) for (const attribute of ['data-clf-selected-model', 'data-clf-selected-effort', 'data-clf-selected-route']) trigger.removeAttribute(attribute);
    }
    for (const [attribute, value] of [['data-clf-selected-model', selected?.id], ['data-clf-selected-effort', selected?.effort], ['data-clf-selected-route', selected && location.pathname]]) {
      if (!value) node?.removeAttribute(attribute);
      else if (node.getAttribute(attribute) !== value) node.setAttribute(attribute, value);
    }
    return state;
  }
  // The native closed picker does not mount composerIntelligencePickerState.
  // Its own ancestor carries the current execution model; its visible label
  // carries the selected effort. These are observation, never catalog discovery.
  function closedPickerSelection(node) {
    const machine = node.getAttribute('data-selected-reasoning-effort');
    // The reported alternate trigger exposes a locale-independent selected effort.
    // Unknown explicit values invalidate proof rather than falling back to its caption.
    const effort = machine !== null ? (['none','minimal','low','medium','high','xhigh','max','ultra','pro'].includes(machine) ? machine : null)
      : ({ instant: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high',
        'extra high': 'xhigh', max: 'max', ultra: 'ultra', pro: 'pro' })[String(node.textContent || '').trim().toLowerCase()];
    if (!effort) return null;
    let model = null;
    for (let fiber = fiberOf(node), up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
      const current = fiber.memoizedProps?.currentModelId;
      if (current === undefined) continue;
      if (typeof current !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(current) || (model && model !== current)) return null;
      model = current;
    }
    return model ? { id: model, effort } : null;
  }
  function readPickerSnapshot(node) {
    let fiber = node && fiberOf(node);
    for (let up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
      // The September composer retains the unmounted menu as dropdownContent.
      // Read that exact native child too; opening it is unnecessary for observation.
      const owner = fiber.memoizedProps;
      const props = owner?.composerIntelligencePickerState ? owner : owner?.dropdownContent?.props;
      const state = props?.composerIntelligencePickerState, data = props?.modelsData;
      if (!state || !Array.isArray(data?.versions)) continue;
      if (data.versions.length > 20 || !Array.isArray(state.bucketSelections) || state.bucketSelections.length > 12) return null;
      const id = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
      // Native version groups may have spaces; execution slugs retain their strict contract.
      const groupId = value => typeof value === 'string' && value.length <= 80 && /^[\p{L}\p{N}._ -]+$/u.test(value) && value.trim() === value && value.trim() ? value : null;
      const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 80 ? value.trim() : null;
      const effortOf = choice => choice.category?.modelLane === 'pro' ? 'pro'
        : ['auto', 'instant'].includes(choice.category?.modelLane) ? 'none'
        : choice.thinkingEffort === 'max' && choice.modelConfig?.isWorkModeModel === true ? 'max'
        : ({ min: 'low', standard: 'medium', extended: 'high', max: 'xhigh', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', ultra: 'ultra' })[choice.thinkingEffort] || null;
      const choices = state.bucketSelections.map(choice => {
        const name = label(choice.category?.shortLabel);
        // Native navigation groups may contain spaces or localized names. Those
        // are not execution ids: retain the exact provider slug for such families.
        const familyId = id(choice.category?.modelVersion) || id(choice.modelSlug);
        const family = data.versions.find(version => version.id === choice.category?.modelVersion);
        return { bucket: choice.bucket, id: id(choice.modelSlug),
          label: name && (/^\d/.test(name) ? `GPT-${name}` : name), effort: effortOf(choice),
          familyId, familyLabel: label(family?.displayTextForIntelligence) || label(choice.modelConfig?.title) || (name && (/^\d/.test(name) ? `GPT-${name}` : name)),
          available: choice.availability?.status === 'available' && !props.modelSwitcherDenialsBySlug?.[choice.modelSlug] };
      });
      const versions = data.versions.filter(version => version.enabled === true).map(version => ({ id: groupId(version.id), label: label(version.displayTextForIntelligence) }));
      if (!versions.length || versions.some(v => !v.id || !v.label) || choices.some(c => !Number.isInteger(c.bucket) || !c.id || !c.label || !c.effort) ||
          new Set(versions.map(v => v.id)).size !== versions.length || new Set(choices.map(c => c.bucket)).size !== choices.length) return null;
      const version = groupId(state.selectedVersionEntry?.id), currentBucket = state.currentBucket;
      if (!versions.some(v => v.id === version) || !choices.some(c => c.bucket === currentBucket)) return null;
      const selected = state.currentSelection;
      const chosen = choices.find(c => c.bucket === currentBucket);
      if (selected?.modelSlug !== chosen.id || effortOf(selected) !== chosen.effort) return null;
      return { version, currentBucket, versions, choices };
    }
    return null;
  }

  /** @ehkogh/#318: the shell's evaluated powers normalize into the existing picker
   * contract. Execution ids remain families here: a mixed Latest group is not one model. */
  function readShellPickerSnapshot(node) {
    for (let fiber = node && fiberOf(node), up = 0; fiber && up < MAX_CLIMB; up++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (!Array.isArray(p?.powerSelections)) continue;
      const selected = p.selectedPowerSelection ?? p.selectedLabelCandidate, options = p.modelListConfig?.options;
      if (!selected || !Array.isArray(options) || options.length > 20 || p.powerSelections.length > 12) return null;
      const id = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
      const group = value => typeof value === 'string' && /^[\p{L}\p{N}._ -]{1,80}$/u.test(value) && value.trim() === value ? value : null;
      const label = value => typeof value === 'string' && value.trim() && value.length <= 80 ? value.trim() : null;
      const effort = value => ({ none:'none', instant:'none', minimal:'minimal', min:'low', low:'low', standard:'medium', medium:'medium', extended:'high', high:'high', xhigh:'xhigh', max:'max', ultra:'ultra', pro:'pro' })[value] || null;
      const current = options.filter(o => o?.selected === true);
      if (current.length !== 1) return null;
      const version = group(current[0].id);
      const versions = options.filter(o => o && o.disabled !== true).map(o => ({ id: group(o.id), label: label(o.label) }));
      const choices = p.powerSelections.map(c => ({ bucket: c?.powerSettingIndex, id: id(c?.model),
        label: label(c?.modelLabel), familyId: id(c?.model), familyLabel: label(c?.modelLabel), effort: effort(c?.reasoningEffort),
        available: p.modelSelectionDisabled !== true && c?.disabled !== true &&
          (!c?.availability || c.availability.status === 'available') && !p.modelSwitcherDenialsBySlug?.[c?.model] }));
      if (!version || !versions.length || versions.some(v => !v.id || !v.label) || !choices.length ||
          choices.some(c => !Number.isInteger(c.bucket) || !c.id || !c.label || !c.effort) ||
          new Set(versions.map(v => v.id)).size !== versions.length || new Set(choices.map(c => c.bucket)).size !== choices.length || !versions.some(v => v.id === version)) return null;
      const matches = choices.filter(c => c.id === id(selected.model) && c.effort === effort(selected.reasoningEffort));
      if (matches.length !== 1 || (selected.powerSettingIndex !== undefined && selected.powerSettingIndex !== matches[0].bucket)) return null;
      return { version, currentBucket: matches[0].bucket, versions, choices };
    }
    return null;
  }

  function copySchema(value, budget, depth = 0) {
    if (depth > 32 || --budget.nodes < 0) throw new Error('schema_bound');
    const spend = bytes => { budget.bytes -= bytes; if (budget.bytes < 0) throw new Error('schema_bound'); };
    if (value === null) { spend(4); return null; }
    if (typeof value === 'string') { spend(value.length * 3 + 2); return value; }
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) { spend(32); return value; }
    if (!value || typeof value !== 'object') throw new Error('schema_shape');
    if (Array.isArray(value)) {
      if (value.length > budget.nodes) throw new Error('schema_bound');
      spend(value.length + 2); return value.map(item => copySchema(item, budget, depth + 1));
    }
    const keys = Object.keys(value);
    if (keys.length > budget.nodes) throw new Error('schema_bound');
    const result = Object.create(null);
    for (const key of keys) {
      spend(key.length * 3 + 4);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('schema_accessor');
      result[key] = copySchema(descriptor.value, budget, depth + 1);
    }
    return result;
  }

  function pluginSnapshot() {
    const route = /^#settings\/Plugins\/plugin_(asdk_app_[a-zA-Z0-9_-]+)$/.exec(location.hash);
    if (!route) return null;
    const panels = [...document.querySelectorAll('[role="tabpanel"]')].filter(panel =>
      panel.getAttribute('aria-labelledby')?.endsWith('-trigger-Plugins') && !panel.hidden);
    if (panels.length !== 1) return null;
    const buttons = [...panels[0].querySelectorAll('button')].slice(0, 100);
    let result = null, control = null, observedActions = null, observedCard = null;
    for (const button of buttons) {
      let fiber = fiberOf(button);
      for (let up = 0; fiber && up < 24; up++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!props) continue;
        if (props.reportEntity?.entityType === 'connector' && props.reportEntity.id === route[1] &&
            Array.isArray(props.details) && props.details.some(detail => detail.value === route[1]) &&
            button.getClientRects().length > 0) {
          if (observedCard && observedCard !== props) return null;
          observedCard = props;
          if (props.headerTrailingContent) {
            if (control && control !== button) return null;
            control = button;
          }
        }
        if (props.connector?.id !== route[1] || !Array.isArray(props.actions) || props.isLoadingActions === true) continue;
        if (props.actions === observedActions) continue;
        if (observedActions) return null;
        observedActions = props.actions;
        const externalPlugins = props.connector.name === 'Chat On Steroids Plugins';
        if ((!props.actions.length && !externalPlugins) || props.actions.length > (externalPlugins ? 257 : 16) || typeof props.connector.name !== 'string') return null;
        const budget = { bytes: 280000, nodes: 20000 };
        const tools = props.actions.map(action => ({ name: action.name, description: copySchema(action.description_model ?? action.description, budget), inputSchema: copySchema(action.params, budget) }));
        if (tools.some(tool => !NAME.test(tool.name) || typeof tool.description !== 'string' || !tool.inputSchema || tool.inputSchema.type !== 'object') ||
            new Set(tools.map(tool => tool.name)).size !== tools.length) return null;
        result = { appId: route[1], connectorName: props.connector.name.slice(0, 100),
          versionId: str(props.connector.app_metadata?.version_id), tools };
      }
    }
    if (!result || !observedCard) return null;
    // Stamp only the native button wired to this connector's header action. Never
    // invoke page callbacks; the isolated world still owns the durable claim and click.
    if (control && control.getAttribute('data-clf-plugin-refresh') !== route[1]) control.setAttribute('data-clf-plugin-refresh', route[1]);
    return { ...result, refreshAvailable: !!control };
  }

  const listener = (event) => {
    // Only this window, only our own request shape. Anything else is not ours to answer.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || ![ASK, 'clf-picker-ask', 'clf-plugin-ask'].includes(data.source)) return;
    const nonce = typeof data.nonce === 'string' ? data.nonce.slice(0, 64) : '';
    if (!nonce) return;
    const previousPaths = currentPaths;
    currentPaths = new WeakMap();
    try {
    if (data.source === 'clf-plugin-ask') {
      let plugin = null;
      try { plugin = pluginSnapshot(); } catch { /* Unrecognized installed settings. */ }
      post({ source: 'clf-plugin-reply', nonce, v: 1, plugin }, location.origin);
      return;
    }
    if (data.source === 'clf-picker-ask') {
      let picker = null;
      try { picker = pickerSnapshot(); } catch { /* Unknown provider shape fails closed. */ }
      post({ source: 'clf-picker-reply', nonce, v: 1, picker }, location.origin);
      return;
    }
    try {
      scan(nonce);
    } catch {
      try {
        post({ source: REPLY, nonce, scanToken: nonce, v: VERSION, scanOk: false, rows: [], turns: [] }, location.origin);
      } catch {
        // Nothing further to try. The other side times out and keeps ChatGPT's labels.
      }
    }
    } finally { currentPaths = previousPaths; }
  };
  // Re-execution is a repair, not a marker check. A stale primitive marker could survive
  // while its listener did not, so keep the actual listener and always replace it.
  const prior = window[ACTIVE_HELPER];
  if (prior && typeof prior.listener === 'function') {
    try {
      window.removeEventListener('message', prior.listener);
    } catch {
      // Installing the replacement below is still the only useful recovery action.
    }
  }
  window.addEventListener('message', listener);
  window[ACTIVE_HELPER] = { version: VERSION, listener };
})();
