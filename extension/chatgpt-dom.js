/**
 * Everything that knows what ChatGPT's page looks like.
 *
 * This is the only file that will break when ChatGPT changes, which is why it is the
 * only file allowed to contain a selector. Every function returns a safe empty value
 * instead of throwing, so a redesign degrades the companion to "records nothing new"
 * rather than breaking the page the user is working in.
 *
 * Anchors used, in order of how directly the live page exposes them:
 *   · turn/message data-* attributes when present (data-turn-id, data-message-id,
 *     data-message-author-role, data-interrupted, data-testid)
 *   · `.markdown` for assistant prose when the current renderer supplies no assistant
 *     data-message-id; progress markdown under data-interrupted is excluded
 *   · the id #prompt-textarea on the composer, and the send/stop/dictation buttons beside
 *     it, which is where our own composer control is anchored
 *   · one structural tool-message class substring, plus a display-contents row shape that
 *     is confirmed structurally (short header line, no prose) before it is believed
 *
 * None of these are a public ChatGPT API. In the live 2026-08-15 page one logical
 * assistant request can also be split into several sections sharing data-turn-id, so
 * turns are grouped before messages, progress or tool blocks are counted. Hashed
 * CSS-module class names are never matched because they are intentionally ephemeral.
 */

var CLF_DOM = (() => {
  const TURN = 'section[data-testid^="conversation-turn"]';
  // ChatGPT has used both shapes in the live renderer: the older tool-message span
  // and, as of 2026-08-15, a display-contents row wrapping the visible tool label.
  // Keep both explicit structural anchors; hashed CSS-module names remain off limits.
  const TOOL_LEGACY = 'span[class*="tool-message"]';
  const TOOL = `${TOOL_LEGACY}, div.pointer-events-none.contents`;
  /**
   * The control ChatGPT puts inside a *connector* tool row and nowhere else.
   *
   * Collapsed, a connector row carries no name, no tool id and no connector attribute —
   * inspected live it is a `group/tool-message` span wrapping a button whose only
   * distinguishing mark is this label, above turn-level attributes that say nothing about
   * what ran. The identity ChatGPT holds (`api_tool`, the connector's name, the request
   * path) appears only once the row or its side panel is opened, and opening rows behind
   * the user's back to read it is not something this extension will do.
   *
   * So this is the one structural thing that separates a connector row from a built-in
   * one — "Searched the web" and friends are a different component. It matters because
   * the app uses these rows as its only evidence of *where a tool call came from*: a row
   * that is not a connector row must never vouch for a connector call, or a turn that
   * merely searched the web ends up adopting a call made from another device.
   */
  const CONNECTOR = '[aria-label="Open tool call list" i]';
  const STOP =
    'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], ' +
    'button[aria-label="Stop streaming"], button[aria-label="Stop generating"]';
  const SEND = 'button[data-testid="send-button"], form button[aria-label^="Send" i]';
  /** The composer's own trailing controls, where the send and dictation buttons live. */
  const TRAILING =
    '[data-testid="composer-trailing-actions"], [data-testid="composer-footer-actions"], ' +
    '[grid-area="trailing"]';
  const SPEECH =
    'button[data-testid="composer-speech-button"], button[data-testid="composer-dictate-button"], ' +
    'button[aria-label^="Dictate" i], button[aria-label^="Voice" i], ' +
    'button[aria-label="Start dictation" i], button[aria-label="Start Voice" i]';
  /**
   * A control ChatGPT mounts for a completed assistant message, scoped to that turn.
   *
   * `Copy message` is intentionally exact. Code blocks have their own Copy controls while a
   * response is still streaming, so a generic copy button would turn ordinary interim prose
   * into false terminal evidence. The current live renderer exposes the accessible label and
   * recent renderers also used the explicit test id below.
   */
  const COMPLETION_ACTION =
    'button[data-testid="copy-turn-action-button"], button[aria-label="Copy message" i]';

  const safe = (fn, fallback) => {
    try {
      const value = fn();
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  };

  const text = (node, cap = 256_000) =>
    node ? (node.textContent || '').replace(/ /g, ' ').trim().slice(0, cap) : '';

  /**
   * Visible page text with every CLF-owned surface removed first.
   *
   * The synthetic stream is mounted inside an assistant turn. On the live page ChatGPT's
   * reasoning container can later expand/reparent around that mount, so reading the outer
   * container's textContent naively feeds our own rendered transcript back into the recorder.
   * That is the exact loop that produced twenty copies of the same assistant update. Clone
   * and strip our nodes before extracting page text. Unknown/fake DOMs fall back safely.
   */
  const OWN_SURFACES = '.clf-stream, .clf-stage, .clf-composer, .clf-boot';

  /**
   * Removes this extension's own rendered surfaces from a clone, in place.
   *
   * Every read of assistant DOM has to do this, not just pageText: our stream is mounted
   * inside the turn, so anything that reads the turn and feeds the result back into the
   * stream compounds on each repaint — one copy, then two, then three.
   */
  function stripOwn(clone) {
    if (!clone || typeof clone.querySelectorAll !== 'function') return clone;
    for (const own of clone.querySelectorAll(OWN_SURFACES)) own.remove();
    return clone;
  }

  function pageText(node, cap = 256_000) {
    return safe(() => {
      if (!node) return '';
      if (typeof node.cloneNode !== 'function') return text(node, cap);
      return text(stripOwn(node.cloneNode(true)), cap);
    }, '');
  }

  /** How an accessible page hides a live region from sight while keeping it announced. */
  const SCREEN_READER_ONLY = '.sr-only, .visually-hidden, [data-testid="visually-hidden"]';

  /**
   * Whether a node is rendered for a person to read, rather than only announced.
   *
   * The one thing this separates is a visible banner from a screen-reader-only live region.
   * Both are `role="alert"`; only one of them is an error the user saw.
   *
   * Two independent signals, because either alone is brittle: the conventional hiding class,
   * and a box clipped to the couple of pixels that hiding leaves behind.
   *
   * Anything else counts as displayed, including a box of zero size — that is what a DOM
   * with no layout engine reports for every node, and a DOM that cannot answer must not be
   * able to delete evidence of a real transport failure. The turn-outcome check reads this
   * same list, and silently losing an error there turns a failed turn into a completed one.
   */
  function displayed(node) {
    return safe(() => {
      if (!node) return true;
      if (typeof node.closest === 'function' && node.closest(SCREEN_READER_ONLY)) return false;
      if (typeof node.getBoundingClientRect !== 'function') return true;
      const rect = node.getBoundingClientRect();
      if (!rect) return true;
      const clipped = (size) => size > 0 && size <= 8;
      return !(clipped(rect.width) || clipped(rect.height));
    }, true);
  }
  /**
   * ChatGPT sometimes renders transport failures inside the same `.markdown` shape as
   * a final assistant answer. Treating "Message delivery timed out … Retry" as model
   * prose makes a broken/reloaded turn look completed. role=alert remains the primary
   * signal; these are narrow fallbacks for failure copy observed on the live site.
   */
  /**
   * Authored message text, without ChatGPT's controls around it.
   *
   * Reading the whole `[data-message-id].textContent` also captures UI chrome. The live
   * page reproduced stored messages ending `Show moreShow less`, which polluted session
   * history and compaction. Prefer ChatGPT's content subtrees; strip controls only as a
   * fallback for an unfamiliar renderer shape.
   */
  function messageText(node, role) {
    return safe(() => {
      if (!node) return '';
      if (role === 'user') {
        const parts = [...node.querySelectorAll('.whitespace-pre-wrap')]
          .map((part) => text(part))
          .filter(Boolean);
        if (parts.length > 0) return parts.join('\n');
      }
      if (role === 'assistant') {
        const parts = [...node.querySelectorAll('.markdown')]
          .filter((part) => !(part.closest && part.closest('[data-interrupted]')))
          .filter((part) => !(part.closest && part.closest(TOOL)))
          .map((part) => text(part))
          .filter(Boolean);
        if (parts.length > 0) return parts.join('\n\n');
      }
      // Structural test fakes and a future partial DOM shim may not implement cloneNode.
      // The live browser always does, but falling back to the node's own text is safer than
      // turning an otherwise valid authored message into an empty string. Real ChatGPT
      // still takes the clone/remove path, which is what strips Show more / Show less.
      if (typeof node.cloneNode !== 'function') return role === 'assistant' ? '' : text(node);
      const clone = node.cloneNode(true);
      // Our own surfaces first, and this is not defensive tidying. A live assistant
      // container with no authored `.markdown` fell through to here and returned the whole
      // node — which contains the stream this extension drew into that very turn. The
      // recorder stored `▣Listed open windows … ›_Ran …` as the assistant's final answer.
      // Anything that reads a turn and feeds the result back into the stream compounds on
      // every repaint, so the strip has to happen before any fallback, not only in
      // pageText().
      stripOwn(clone);
      for (const control of clone.querySelectorAll('button, [role="button"], [data-testid*="copy"], [data-testid*="feedback"]')) {
        control.remove();
      }
      // Everything the preferred path above excludes, excluded here too — otherwise the
      // fallback is not a fallback, it is a different and much laxer rule that fires
      // exactly when the strict one found nothing.
      //
      // Tool rows are ChatGPT's chrome, not its prose, and are reported separately as
      // page_tool activity; reading them here turned one answer into a transcript of its
      // own tool labels. Commentary is not the answer either: a turn that narrated its
      // work and then produced no prose would otherwise have its narration promoted to
      // `final: true`, which is what closes a turn and what a recovery later trusts.
      //
      // Nothing authored left is the honest record. An assistant final is the one thing a
      // reader takes as "what it said", so absence beats a plausible-looking invention.
      if (role === 'assistant') {
        for (const row of clone.querySelectorAll(TOOL)) row.remove();
        for (const commentary of clone.querySelectorAll('[data-interrupted]')) commentary.remove();
      }
      return text(clone);
    }, '');
  }

  /**
   * What ChatGPT itself has put into a section, as a value comparable with a later reading.
   *
   * Deliberately not `textContent`. content.js uses "this section's text changed since the
   * baseline" as evidence that the generation now running is writing into it — and this
   * extension rewrites the visible label of tool rows *inside assistant sections* as steps
   * land (`applyLabel`, `applyPageLabel`). Raw text therefore changes in sections ChatGPT
   * has not touched, and our own relabel of an old row was enough to bind a finished
   * section to the new generation and file this turn's work under the previous answer.
   *
   * So it is built only from signals this extension does not write: authored prose, and how
   * many tool rows the page is showing. A relabel moves neither. New prose or a new row
   * moves one, which is precisely the page-authored activity the caller is asking about.
   */
  function sectionSignature(node) {
    return safe(() => {
      if (!node || typeof node.querySelectorAll !== 'function') return '0|0|';
      // Structural, so it survives a relabel: this extension rewrites what a row *says*,
      // never how many there are. A row appearing is page activity; "Inspecting" becoming
      // "Inspected" is ours.
      const rows = [...node.querySelectorAll(TOOL)].filter(
        (row) => !(row.closest && row.closest(OWN_SURFACES))
      ).length;
      let authored = '';
      if (typeof node.cloneNode === 'function') {
        // Everything ChatGPT put here, with the two things this extension writes taken out:
        // its own surfaces, and the tool rows whose labels it rewrites. Commentary counts —
        // it is usually the *first* thing a new generation writes, and a signature made of
        // final prose and rows alone stayed identical through the whole commentary phase,
        // so a generation writing into an already-mounted section could not be recognised
        // and its visible commentary was never recorded at all.
        const clone = stripOwn(node.cloneNode(true));
        for (const row of clone.querySelectorAll(TOOL)) row.remove();
        authored = text(clone);
      } else {
        authored = [...node.querySelectorAll('.markdown')]
          .filter((part) => !(part.closest && (part.closest(TOOL) || part.closest(OWN_SURFACES))))
          .map((part) => text(part))
          .join('\n');
      }
      return `${rows}|${authored.length}|${authored.slice(-96)}`;
    }, '0|0|');
  }

  function transportFailure(value) {
    const line = String(value || '').replace(/\s+/g, ' ').trim();
    return /(?:message delivery timed out|connection interrupted\.? waiting for the complete answer|unknown error occurred|there was an error generating (?:a|the) response|error in message stream|network error|something went wrong)/i.test(line);
  }

  /**
   * The conversation a ChatGPT path names, or null when it names none.
   *
   * A conversation inside a Project is routed as `/g/<project>/c/<id>`, so anchoring at
   * `/c/` recognised only chats at the site root. Everything downstream — the app session,
   * the ownership registry, caller attribution — is keyed on this id, so in a Project the
   * page was never recognised as being on a conversation at all.
   *
   * Deliberately not a loose `/c/<id>` search anywhere in the path: `/share/c/<id>` is a
   * public read-only snapshot of someone's conversation, not a conversation this document
   * can own, record or bind. One optional `/g/<slug>` segment is the whole exception.
   */
  function conversationFromPath(pathname) {
    return safe(() => {
      const match = /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(String(pathname || ''));
      return match ? match[1] : null;
    }, null);
  }

  /** The conversation this tab is on, or null for a chat that has not been sent yet. */
  function conversationId() {
    return safe(() => conversationFromPath(location.pathname), null);
  }

  /** Human ChatGPT title when one has actually been generated; never conversation identity. */
  function conversationTitle() {
    return safe(() => {
      let value = (document.title || '').trim();
      if (!value) return '';
      value = value.replace(/\s*(?:[-|·]\s*)ChatGPT\s*$/i, '').trim();
      if (!value || /^(?:ChatGPT|New chat)$/i.test(value)) return '';
      return value.slice(0, 200);
    }, '');
  }

  /**
   * Logical conversation turns, newest last.
   *
   * ChatGPT can render one assistant request as several sibling `section` elements
   * carrying the same data-turn-id. Treating each section as a turn makes a five-call
   * request look like several partial requests, so every one fails content.js's
   * one-block-per-call safety check and the page is left with a wall of "Called tool".
   * Group only sections that explicitly share role + id; id-less sections stay
   * independent because merging those would be a guess.
   */
  function turns() {
    return safe(() => {
      const out = [];
      const byKey = new Map();
      for (const node of document.querySelectorAll(TURN)) {
        const id = node.getAttribute('data-turn-id');
        const role = node.getAttribute('data-turn');
        const key = id ? `${role || ''}:${id}` : null;
        if (key && byKey.has(key)) {
          byKey.get(key).nodes.push(node);
          continue;
        }
        const turn = { node, nodes: [node], id, role };
        out.push(turn);
        if (key) byKey.set(key, turn);
      }
      return out;
    }, []);
  }

  /**
   * Logical turns for presentation only.
   *
   * Keep this separate from `turns()`: the recorder has a deliberately conservative model
   * that other code depends on. The renderer needs one extra guarantee the live ChatGPT DOM
   * no longer gives it: `data-turn-id` can be reused by later requests. Grouping every
   * section with the same id across the whole page therefore lets one old id swallow several
   * different assistant turns and the overwrite renderer hides them all as one block.
   *
   * Split sections of one response are adjacent, while a later response is separated by a
   * user turn. So presentation groups only consecutive sections with the same role + id.
   * This changes no observation, attribution or recording path; it is only the list the
   * synthetic stream paints into.
   */
  function presentationTurns() {
    return safe(() => {
      const out = [];
      let previous = null;
      for (const node of document.querySelectorAll(TURN)) {
        const id = node.getAttribute('data-turn-id');
        const role = node.getAttribute('data-turn');
        if (previous && id && previous.id === id && previous.role === role) {
          previous.nodes.push(node);
          continue;
        }
        previous = { node, nodes: [node], id, role };
        out.push(previous);
      }
      return out;
    }, []);
  }

  const turnNodes = (turn) =>
    turn && Array.isArray(turn.nodes) && turn.nodes.length > 0 ? turn.nodes : turn && turn.node ? [turn.node] : [];

  /**
   * Visible messages, newest last.
   *
   * textContent rather than innerText on purpose: a long user message is visually
   * clamped by ChatGPT, and the clamped part is exactly the part a five-hour session
   * cannot afford to lose.
   */
  function messages() {
    return safe(() => {
      const out = [];
      const seen = new Set();
      for (const [index, turn] of turns().entries()) out.push(...messagesIn(turn, index, seen));
      return out;
    }, []);
  }

  /**
   * The messages of exactly one turn.
   *
   * Split out of messages() rather than duplicated because callers that need turn-scoped
   * evidence — "did *this* turn produce an answer" — must read the page the same way the
   * whole-conversation scan does, including the no-data-message-id fallback below. Asking
   * that question by filtering messages() on `turnId` is not the same thing: sections
   * ChatGPT renders without a turn id all report `turnId: null`, so the filter silently
   * merges every id-less turn into one.
   *
   * `seen` is shared by the whole-conversation scan so a message id rendered in two
   * sections is reported once. On its own each turn gets a fresh one.
   */
  function messagesIn(turn, index = 0, seen = new Set()) {
    return safe(() => {
      const out = [];
      const nodes = turnNodes(turn);
      let explicit = 0;
      for (const section of nodes) {
        for (const node of section.querySelectorAll('[data-message-id]')) {
          const id = node.getAttribute('data-message-id');
          if (!id || seen.has(id)) continue;
          const role = node.getAttribute('data-message-author-role') || turn.role;
          if (role !== 'user' && role !== 'assistant') continue;
          seen.add(id);
          explicit++;
          out.push({
            id,
            role,
            text: messageText(node, role),
            turnId: turn.id,
            node: section,
            interrupted: interrupted(turn)
          });
        }
      }

      // The current ChatGPT renderer no longer gives streaming assistant prose a
      // data-message-id. Final prose is still exposed as `.markdown`; live progress
      // prose is also `.markdown`, but lives under `[data-interrupted]`. Only use the
      // fallback when there is no explicit assistant message and only collect
      // markdown outside progress/tool containers. content.js itself waits until the
      // turn has stopped generating before recording this as the final answer.
      if (turn.role === 'assistant' && explicit === 0) {
        const parts = [];
        for (const section of nodes) {
          for (const markdown of section.querySelectorAll('.markdown')) {
            if (markdown.closest && markdown.closest('[data-interrupted]')) continue;
            if (markdown.closest && markdown.closest(TOOL)) continue;
            if (markdown.closest && markdown.closest(OWN_SURFACES)) continue;
            const value = text(markdown);
            if (value && parts[parts.length - 1] !== value) parts.push(value);
          }
        }
        if (parts.length > 0) {
          // The live renderer can leave several assistant-authored markdown blocks in one
          // logical turn: interim commentary messages followed by the actual final answer.
          // Joining them all promoted the whole visible work log to one "final answer" and
          // later re-recorded those interim messages under an older reused page turn id.
          // The final answer is the last authored markdown block. Canonical transcript
          // identity/content is captured from ChatGPT's message model by fiber.js; this DOM
          // fallback is used only for local lifecycle/compaction decisions.
          const value = parts[parts.length - 1];
          if (!transportFailure(value)) {
            out.push({
              id: `assistant:${turn.id || index}`,
              role: 'assistant',
              text: value,
              turnId: turn.id,
              node: nodes[0] || null,
              interrupted: interrupted(turn)
            });
          }
        }
      }
      return out;
    }, []);
  }

  /**
   * ChatGPT's completed-message action for exactly this logical assistant turn, if mounted.
   *
   * This is corroborating lifecycle evidence only. content.js still requires a quiet turn,
   * authored assistant prose, a matching healthy Fiber descriptor and no unanswered connector
   * call before it may use this node as a completion fallback.
   */
  function completionAction(turn) {
    return safe(() => {
      for (const section of turnNodes(turn)) {
        const action = section && section.querySelector ? section.querySelector(COMPLETION_ACTION) : null;
        if (action) return action;
      }
      return null;
    }, null);
  }

  /** True while ChatGPT is producing a turn. The stop button is the honest signal. */
  function generating() {
    return safe(() => document.querySelector(STOP) !== null, false);
  }

  function stopButton() {
    return safe(() => document.querySelector(STOP), null);
  }

  /**
   * The live progress line of a turn.
   *
   * ChatGPT keeps its running commentary inside the block it also marks with
   * data-interrupted, so that attribute doubles as the anchor for both.
   */
  function progressLine(turn) {
    return safe(() => {
      const parts = [];
      for (const section of turnNodes(turn)) {
        // Outermost containers only. These boxes nest, and reading whichever one came last
        // in document order made this value flip between the whole reasoning block and
        // whatever inner box was newest. A shrink is not a prefix of what came before, so
        // the delta below could only report it as brand-new text — which is exactly how the
        // same commentary line came to be printed two and three times.
        for (const box of progressRoots(section)) {
          const lines = pageText(box, 32_000)
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
          if (lines.length > 0) parts.push(lines.join('\n'));
        }
      }
      return parts.length > 0 ? parts.join('\n').slice(0, 8000) : null;
    }, null);
  }

  /**
   * The outermost commentary containers of one section, in document order.
   *
   * Outermost only. These boxes nest, and a scan that returns the inner ones too reports
   * the same sentence under two identities — which is how one caption came to be recorded,
   * and drawn, several times over.
   */
  /**
   * The identity a commentary root inherits from the prose block it swallowed, if any.
   *
   * The two families of item here are told apart by where the text sits: prose blocks are
   * `.markdown` *outside* a `[data-interrupted]` container, commentary is what is inside
   * one. ChatGPT moves text across that line mid-answer — it mounts the markdown first and
   * wraps it a moment later — and the same visible words were then reported twice, once
   * under each family's stamp. The commentary chain revises itself correctly, so what the
   * user saw was a frozen truncated prefix of their answer sitting above the answer:
   * "Yeah bro, I'll stay on the **current" and then the whole paragraph, in one turn.
   *
   * It is one block of text, so it gets one identity: the stamp the prose block already
   * carries from this same generation. Only when the root has exactly one stamped block —
   * two would make the inheritance a guess, and a guess here merges two different things
   * into one row.
   */
  function adoptedProseId(box, namespace) {
    if (!box || !box.querySelectorAll) return '';
    let found = '';
    for (const node of box.querySelectorAll('[data-clf-assistant-prose-id]')) {
      const stamp = node.getAttribute('data-clf-assistant-prose-id') || '';
      if (stamp.indexOf(`${namespace}#`) !== 0) continue;
      if (found) return '';
      found = stamp;
    }
    return found;
  }

  function progressRoots(section) {
    return [...section.querySelectorAll('[data-interrupted]')].filter(
      (node) => !(node.parentElement && node.parentElement.closest && node.parentElement.closest('[data-interrupted]'))
    );
  }

  /**
   * Stamps a list of nodes with per-generation identities, reusing a stamp only within the
   * generation that minted it.
   *
   * The namespace is the caller's generation key, and that is the whole point. Stamping
   * with ChatGPT's `data-turn-id` looked equivalent and was not: live, the page reuses the
   * id `request-<conversation>-0` for turn after turn, and it reuses the commentary
   * container node itself across turns as well. So a stamp minted on turn one was still
   * sitting on the node during turn four, every turn's commentary was recorded under one
   * identity, and the recorder folded four different captions into one row at the position
   * of the first. A stamp from another generation is therefore treated as absent.
   *
   * Within a generation the stamp is what ties identity to the node's own lifecycle: React
   * keeping the node — including reparenting it — keeps the id, and a container ChatGPT
   * genuinely replaces gets a new one. The ordinal is only how an unstamped node is *named*;
   * two nodes carrying the same stamp (React cloned a subtree) are separated rather than
   * merged, because merging them would put two different things in one row.
   */
  function stampIdentities(nodes, attribute, key, letter) {
    const namespace = `${key}#`;
    const taken = new Set();
    const ids = [];
    for (const node of nodes) {
      const stamp = node && node.getAttribute ? node.getAttribute(attribute) : null;
      if (stamp && stamp.indexOf(namespace) === 0 && !taken.has(stamp)) {
        taken.add(stamp);
        ids.push(stamp);
      } else {
        ids.push(null);
      }
    }
    let next = 0;
    for (let at = 0; at < nodes.length; at++) {
      if (ids[at]) continue;
      let id = `${namespace}${letter}${next++}`;
      while (taken.has(id)) id = `${namespace}${letter}${next++}`;
      taken.add(id);
      ids[at] = id;
      try {
        nodes[at].setAttribute(attribute, id);
      } catch {
        // A DOM that will not take the stamp still gets a usable id for this pass; it
        // simply cannot keep it across a redraw. One row per redraw is the old failure,
        // so the caller's own per-id state is what actually holds the line here.
      }
    }
    return ids;
  }

  /**
   * One commentary container's text, with the streaming double-write collapsed.
   *
   * `textContent` of a live commentary container is not the sentence on screen. While
   * ChatGPT streams, the container holds the raw markdown buffer *and* the parsed render of
   * the same words at the same time, so reading it naively returns
   * `…**that screenshot basically confirms` immediately followed by
   * `…that screenshot basically confirms the gate theory`. That is a real duplication in
   * what the page exposes, not a bug in how it is read, and every layer downstream that
   * tried to reconcile snapshots against each other was reconciling text that already said
   * everything twice.
   *
   * Two collapses, because the page produces the duplication in two shapes.
   *
   * Within a line, because there is very often no newline between the two copies at all.
   * The recorded example is a single line reading
   * `Yep bro, **that screenshot basically confirmsYep bro, that screenshot basically
   * confirms the gate theory` — the raw buffer runs straight into the rendered copy, and a
   * deduper that only looks across lines cannot see it. So a line that begins with a long
   * prefix which then starts again immediately is cut back to the second copy, which is the
   * complete one: the buffer is always the shorter, earlier half.
   *
   * Then across lines, where a block contained in one already kept — or containing one —
   * collapses to the longer of the two.
   *
   * Markdown punctuation is ignored for both comparisons; the text kept is always the
   * page's own, never a rewritten one. The prefix has to be long to count, because prose
   * legitimately repeats short openings and this must never eat a real sentence.
   */
  const MARKDOWN_CHAR = /[*_`#>~[\]()]/;
  const SPACE_CHAR = /\s/;
  const bareText = (value) => value.replace(/[*_`#>~[\]()]/g, '').replace(/\s+/g, ' ').trim();

  /** Shortest repeated opening that is taken as a streaming double-write rather than prose. */
  const MIN_ECHO_CHARS = 12;

  /**
   * Where the segment starting at `from` is immediately restated, or -1.
   *
   * A restatement has to be exact and back-to-back — `plain.slice(from, cut)` repeated at
   * `cut` — so this never fires on prose that merely opens the same way twice. The candidate
   * positions are the places the segment's own opening occurs again, which is a handful of
   * indices rather than every one; a commentary line can be thousands of characters long and
   * this runs on every container on every tick. The nearest candidate wins, because the
   * shortest restated segment is the one that was interrupted earliest.
   */
  function echoCut(plain, from) {
    const probe = plain.slice(from, from + MIN_ECHO_CHARS);
    if (probe.length < MIN_ECHO_CHARS) return -1;
    for (let at = plain.indexOf(probe, from + MIN_ECHO_CHARS); at > from; at = plain.indexOf(probe, at + 1)) {
      const width = at - from;
      if (at + width > plain.length) break;
      // Two words at minimum. A repeated single long word is a word, not a double-write.
      if (plain.slice(from, at).indexOf(' ') < 0) continue;
      if (plain.slice(from, at) === plain.slice(at, at + width)) return at;
    }
    return -1;
  }

  /**
   * A line the page wrote over itself while streaming, reduced to its last and fullest pass.
   *
   * Measured live: ChatGPT's commentary container briefly holds the paragraph it is replacing
   * alongside the replacement, and `innerText` runs the two together without a newline. The
   * result is not `A + A` but a chain of ever-longer prefixes — `**Schritt 3 erled` then
   * `Schritt 3 erledigt: Die ersten 15 Zeilen` then the same sentence carried further — all on
   * one line, which is how a single interim message came to be stored reading itself three and
   * four times over. Only `A + A` was recognised before, so none of that chain was caught.
   *
   * Each pass is a prefix of the one after it, so stripping the restated segment repeatedly
   * peels the chain from the front and leaves the last pass. Markdown punctuation is ignored
   * for the comparison; the text kept is always the page's own, never a rewritten one, and a
   * line the page did not double is returned untouched.
   */
  function dropEcho(line) {
    // React can briefly mount the old streaming buffer immediately beside the new one with
    // no separator at all. The smallest live reproducer was `I’veI’ve gotI’ve got ...`:
    // the old long-echo guard intentionally ignored the four-character first pass, so the
    // corruption survived and every later snapshot compounded it. Peel only *immediate*
    // duplicate prefixes whose join has no whitespace; normal prose such as `ha ha` keeps
    // its separating space and is therefore untouched. Repeating this also handles the
    // growing-prefix chain: A + AB + ABC -> AB + ABC -> ABC.
    let compact = line;
    for (;;) {
      let cut = -1;
      const max = Math.min(200, Math.floor(compact.length / 2));
      for (let width = 3; width <= max; width++) {
        const prefix = compact.slice(0, width);
        if (/\s$/.test(prefix) || /^\s/.test(compact.slice(width))) continue;
        if (compact.slice(width).startsWith(prefix)) {
          cut = width;
          break;
        }
      }
      if (cut < 0) break;
      compact = compact.slice(cut);
    }
    line = compact;
    if (line.length < MIN_ECHO_CHARS * 2) return line;
    const chars = [];
    const origin = [];
    for (let at = 0; at < line.length; at++) {
      const ch = line[at];
      if (MARKDOWN_CHAR.test(ch)) continue;
      if (SPACE_CHAR.test(ch)) {
        if (chars.length === 0 || chars[chars.length - 1] === ' ') continue;
        chars.push(' ');
        origin.push(at);
        continue;
      }
      chars.push(ch);
      origin.push(at);
    }
    const plain = chars.join('');
    let from = 0;
    for (let cut = echoCut(plain, from); cut > from; cut = echoCut(plain, from)) from = cut;
    return from === 0 ? line : line.slice(origin[from]).trim();
  }

  function commentaryText(node) {
    const blocks = pageText(node, 32_000)
      .split('\n')
      .map((line) => dropEcho(line.trim()))
      .filter(Boolean);
    const kept = [];
    for (const block of blocks) {
      const plain = bareText(block);
      if (!plain) continue;
      let merged = false;
      for (let at = 0; at < kept.length; at++) {
        const held = bareText(kept[at]);
        if (held.indexOf(plain) >= 0) {
          merged = true;
          break;
        }
        if (plain.indexOf(held) >= 0) {
          kept[at] = block;
          merged = true;
          break;
        }
      }
      if (!merged) kept.push(block);
    }
    return kept.join('\n').slice(0, 8000);
  }

  /**
   * This turn's visible commentary, as identified items rather than as one blob of text.
   *
   * `progressLine()` answers "what does the whole reasoning area say right now", which is
   * the wrong question for recording. ChatGPT grows one caption block in place, reparents
   * it, shrinks it during a re-layout and grows it again; a caller comparing consecutive
   * blobs can only see "the text changed" and has to guess whether that is new commentary
   * or the same commentary redrawn. It guessed wrong, repeatedly, and every wrong guess
   * became another stored event and another row on screen.
   *
   * `key` is the caller's generation key — see stampIdentities for why it may not be
   * ChatGPT's turn id.
   */
  function progressItems(turn, key) {
    return safe(() => {
      const namespace = key || (turn && turn.id) || 'turn';
      const boxes = [];
      for (const section of turnNodes(turn)) boxes.push(...progressRoots(section));
      const ids = stampIdentities(boxes, 'data-clf-progress-id', namespace, 'p');

      const out = [];
      for (let at = 0; at < boxes.length; at++) {
        const value = commentaryText(boxes[at]);
        if (value) out.push({ id: adoptedProseId(boxes[at], namespace) || ids[at], text: value });
      }
      return out;
    }, []);
  }

  function interrupted(turn) {
    return safe(
      () => turnNodes(turn).some((section) => section.querySelector('[data-interrupted="true"]') !== null),
      false
    );
  }

  /** Marks ChatGPT's own progress/reasoning containers so our CSS can make them legible. */
  function markProgress(turn) {
    return safe(() => {
      let marked = 0;
      for (const section of turnNodes(turn)) {
        for (const box of section.querySelectorAll('[data-interrupted]')) {
          if (!box.hasAttribute('data-clf-progress')) marked++;
          box.setAttribute('data-clf-progress', '1');
        }
      }
      return marked;
    }, 0);
  }

  /**
   * Is this candidate really one tool row?
   *
   * `div.pointer-events-none.contents` is a layout shape, not a semantic one: ChatGPT uses
   * display-contents wrappers in several places, and matching the class alone once counted
   * containers that hold a whole answer. A tool row is a short header line — no prose, no
   * nested tool row — so require that shape rather than trusting the class.
   *
   * A block we have already relabelled is always accepted. Expanding one puts its output
   * inside, which would otherwise make our own row stop looking like a tool row and let
   * its call be handed to a different block on the next repaint.
   */
  function isToolBlock(node) {
    if (node.hasAttribute && node.hasAttribute('data-clf-call')) return true;
    // A row that carries the tool-call control is a tool row whatever its size. Expanding
    // one puts its result — markdown and all — inside it, and the length/markdown test
    // below would then stop recognising it. Judging by the control instead of by the body
    // is what keeps an expanded connector result out of the chronology as prose.
    if (node.querySelector && node.querySelector(CONNECTOR)) return true;
    if (node.closest && node.closest(CONNECTOR)) return true;
    if (node.querySelector && node.querySelector('.markdown')) return false;
    const label = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return label.length > 0 && label.length <= 200;
  }

  /**
   * Collapse nested selector matches without comparing every node with every other node.
   * Long chats can contain hundreds of activity rows; the old `filter(...some(...))`
   * shape turned every transcript pass into quadratic containment work.
   */
  function collapseNested(found, keepInnermost) {
    if (found.length < 2) return found;
    const candidates = new Set(found);
    if (keepInnermost) {
      const containsCandidate = new Set();
      for (const node of found) {
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (candidates.has(parent)) containsCandidate.add(parent);
        }
      }
      return found.filter((node) => !containsCandidate.has(node));
    }
    return found.filter((node) => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (candidates.has(parent)) return false;
      }
      return true;
    });
  }

  /** The tool-call blocks of one logical turn, across every split section, in DOM order. */
  function toolBlocks(turn) {
    return safe(
      () =>
        turnNodes(turn).flatMap((section) => {
          const current = [...section.querySelectorAll(TOOL)];
          const found = (current.length > 0 ? current : [...section.querySelectorAll(TOOL_LEGACY)]).filter(
            isToolBlock
          );
          // The two shapes nest — the display-contents wrapper can sit inside the legacy
          // span — and relabelling both would put our icon and title inside our own row.
          // Keep the innermost, which is the element that actually carries the label.
          return collapseNested(found, true);
        }),
      []
    );
  }

  /**
   * Whether this block is a connector (API tool) row rather than a built-in one.
   *
   * Structural, not textual: the row carries the control named by CONNECTOR, and built-in
   * rows — "Searched the web", canvas, image generation — do not. That makes it stable
   * across locales and immune to the label games a name-frequency guess is open to.
   *
   * It says "a connector", not "this connector". The provider's identity — the account
   * name, the tool name, the request path — exists in ChatGPT's client state and appears
   * in the expanded card and the side panel, but nothing in the collapsed row carries it,
   * so a Gmail or Calendar row is indistinguishable from this app's from here. Callers
   * that use this as evidence must treat it as narrowing, not as proof of provider.
   */
  /**
   * Visible assistant activity in the exact DOM order ChatGPT drew it.
   *
   * Chat On Steroids remains authoritative for its own call labels/results. This only supplies
   * the missing chronology: a visible commentary paragraph can sit between two calls, and
   * the recorder clock cannot recover that after a fast turn. ChatGPT's completed DOM can.
   */
  function activityItems(turn) {
    return safe(() => {
      const out = [];
      let markerBase = 0;
      for (const section of turnNodes(turn)) {
        const roots = [...section.querySelectorAll('[data-interrupted]')].filter((node) => {
          const parent = node.parentElement && node.parentElement.closest
            ? node.parentElement.closest('[data-interrupted]')
            : null;
          return !parent;
        });

        for (const root of roots) {
          // ChatGPT's reasoning is one outer data-interrupted container. Its inner
          // display-contents activity rows are the *actual chronology slots*; plain text
          // between them is the visible commentary. Replacing those rows with sentinels in
          // a clone gives us the ordering without having to depend on hashed prose classes.
          // Strip our own stream before reading a single character of this subtree. Without
          // it, every repaint reads back what we rendered last time and republishes it.
          const clone = stripOwn(root.cloneNode(true));
          const found = [...clone.querySelectorAll(TOOL)].filter(isToolBlock);
          const slots = collapseNested(found, true);
          if (slots.length === 0) {
            const value = (clone.innerText || clone.textContent || '').trim();
            if (value) out.push({ kind: 'progress', text: value });
            continue;
          }

          const markers = [];
          slots.forEach((node, index) => {
            const token = `\n[[CLF_ACTIVITY_${markerBase + index}]]\n`;
            markers.push(token.trim());
            node.replaceWith(document.createTextNode(token));
          });
          markerBase += slots.length;

          const text = (clone.innerText || clone.textContent || '').replace(/\u00a0/g, ' ');
          const pattern = /\[\[CLF_ACTIVITY_(\d+)\]\]/g;
          let at = 0;
          let match;
          while ((match = pattern.exec(text)) !== null) {
            const prose = text.slice(at, match.index).trim();
            if (prose) out.push({ kind: 'progress', text: prose });
            out.push({ kind: 'tool' });
            at = match.index + match[0].length;
          }
          const tail = text.slice(at).trim();
          if (tail) out.push({ kind: 'progress', text: tail });
        }
      }
      return out;
    }, []);
  }

  /**
   * Whether this row is one of our own connector calls rather than something ChatGPT did.
   *
   * The answer is remembered on the row once it is known, and that is the point. The only
   * live marker is the control ChatGPT puts in a connector row, and it does not survive
   * everything the page does to that row: a collapse, a relabel, a React replacement of the
   * button can all take it away. A row that loses its marker then reads as ChatGPT-native,
   * and the call this app already recorded first-hand — with its arguments, outcome and
   * duration — gets written down a second time as an anonymous page caption.
   *
   * Being wrong in this direction is cheap and the other direction is not: a row wrongly
   * remembered as ours is one missing native caption, while a row wrongly read as native is
   * a duplicate of work already in the log.
   */
  function isConnectorBlock(node) {
    return safe(() => {
      if (!node) return false;
      if (node.getAttribute && node.getAttribute('data-clf-local') === '1') return true;
      const found = !!node.querySelector(CONNECTOR) || !!node.closest(CONNECTOR);
      if (found) markLocalBlock(node);
      return found;
    }, false);
  }

  /**
   * Records that a row belongs to this connector, for callers who know it from elsewhere.
   *
   * The Fiber pass can prove it — a request whose resource path is this app's — and that
   * proof outlives the DOM control, so it is worth keeping on the row.
   */
  function markLocalBlock(node) {
    return safe(() => {
      if (!node || !node.setAttribute) return false;
      node.setAttribute('data-clf-local', '1');
      return true;
    }, false);
  }

  /**
   * Whether this node is a connector row or contains one.
   *
   * Separate from isConnectorBlock because the questions are different: that one asks what
   * a known tool row is, and answers upwards as well, while this one asks whether an
   * arbitrary node that just appeared brought any evidence with it. React inserts whole
   * subtrees, so the row is as often a descendant of what was added as it is the node
   * itself, and only looking at the node would miss it.
   */
  function hasConnectorRow(node) {
    return safe(() => !!node && node.nodeType === 1 && (node.matches(CONNECTOR) || !!node.querySelector(CONNECTOR)), false);
  }

  /**
   * The connector rows inside a root, outermost first and counted once each.
   *
   * The evidence path asks this rather than filtering toolBlocks(), and that is deliberate.
   * toolBlocks() exists for *relabelling*, so it has to find the element that carries the
   * visible title, which means the display-contents/tool-message shapes and a heuristic
   * about what a row looks like. Attribution needs none of that: it only needs to know how
   * many connector calls this page has shown, and the one anchor that says so is CONNECTOR.
   * Depending on the relabelling shapes for it meant a renderer change that moved the title
   * silently turned every call in the browser into an unplaceable one.
   *
   * Nested matches are collapsed to the outermost, so a row whose control is labelled twice
   * — the wrapper and the button inside it — is still one call.
   */
  function connectorRows(root) {
    return safe(() => {
      const scope = root || document;
      const found = [...scope.querySelectorAll(CONNECTOR)];
      if (scope.nodeType === 1 && scope.matches(CONNECTOR)) found.unshift(scope);
      return collapseNested(found, false);
    }, []);
  }

  /**
   * The exact MAIN-world scan reference stamped on this block's connector row, or null.
   *
   * An index alone is not identity: React can leave a row stamped `0` from an earlier scan
   * while the next scan also has a completely different descriptor at index 0. The helper
   * therefore stamps `{scanToken,index}` and callers must match both. Numeric/legacy stamps
   * deliberately fail closed rather than being reinterpreted against a newer frame.
   */
  function fiberRef(block) {
    return safe(() => {
      if (!block) return null;
      const marked =
        (block.closest && block.closest('[data-clf-fiber]')) ||
        (block.querySelector && block.querySelector('[data-clf-fiber]'));
      if (!marked) return null;
      const value = marked.getAttribute('data-clf-fiber');
      if (!value) return null;
      const split = value.lastIndexOf(':');
      if (split <= 0 || split === value.length - 1) return null;
      const scanToken = value.slice(0, split);
      const rawIndex = value.slice(split + 1);
      if (scanToken.length > 64 || !/^\d+$/.test(rawIndex)) return null;
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 0) return null;
      return { scanToken, index };
    }, null);
  }

  /**
   * The single text node inside a tool block that reads "Called tool".
   *
   * Found structurally — the first text-bearing leaf of the block's header button —
   * rather than by matching the English string, so it also works in other languages.
   */
  function toolLabel(block) {
    return safe(() => {
      const marked = block.querySelector('[data-clf-label]');
      if (marked) return marked;
      const header = block.querySelector('button') || block;
      for (const node of header.querySelectorAll('*')) {
        if (node.children.length === 0 && (node.textContent || '').trim().length > 0) {
          node.setAttribute('data-clf-label', '1');
          return node;
        }
      }
      return null;
    }, null);
  }

  /**
   * Visible error banners plus narrowly recognised transport-failure markdown.
   *
   * Occurrences, not strings. The same wording failing twice is two failures, and the
   * caller has to be able to tell them apart: keyed on text alone, "Message delivery timed
   * out" on turn nine was indistinguishable from the same banner on turn three, so the
   * second one was never recorded and — because the outcome check consults the same
   * filter — the failed turn could be written down as completed instead.
   *
   * What gives an occurrence its identity is the node it is rendered in, plus the turn it
   * belongs to when it is inside one. A toast lives outside every turn, so it has no
   * turnId; its node is still its identity.
   *
   * "Visible" is load-bearing and used to be assumed rather than checked. ChatGPT announces
   * ordinary UI state through screen-reader-only `role="alert"` live regions, so a session
   * accumulated "Reasoning details opened", "Actions refreshed." and "Dictation is active
   * and in use" as recorded chat errors — 60 of them against 5 real transport failures in
   * one run — and every error count the app showed was inflated by them. An offscreen
   * announcement is not a banner. Neither is this extension's own surface, which was
   * recording "Chat On Steroids Desktop is now connected" as a ChatGPT failure.
   */
  function errors() {
    return safe(() => {
      const out = [];
      const texts = new Set();
      for (const node of document.querySelectorAll('[role="alert"]')) {
        if (node.closest && node.closest(OWN_SURFACES)) continue;
        if (!displayed(node)) continue;
        const value = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (value.length <= 2 || value.length >= 500) continue;
        // A live region names no turn. It is announced above the thread, outside every
        // section, so `turnId` stays null here and the caller's own live generation is what
        // places it. The wording it does carry goes through the same classifier the in-turn
        // branch below trusts, because that is the only difference between the two: a send
        // that dies before an assistant turn exists has nowhere to paint "Message delivery
        // timed out" except up here. Withholding recovery authority from that one case left
        // the app recording the failure, marking the turn failed, and then leaving the chat
        // parked on it - which is what a reload exists to undo. An announcement that is not
        // a recognised transport failure ("Reasoning details opened", a user-row error) is
        // still recorded as session evidence and still authorizes nothing.
        out.push({ text: value, node, turnId: null, recoverable: transportFailure(value) });
        texts.add(value);
      }
      for (const turn of turns()) {
        if (turn.role !== 'assistant') continue;
        for (const section of turnNodes(turn)) {
          for (const markdown of section.querySelectorAll('.markdown')) {
            const value = text(markdown, 500).replace(/\s+/g, ' ').trim();
            if (!value || !transportFailure(value) || texts.has(value)) continue;
            texts.add(value);
            out.push({ text: value, node: markdown, turnId: turn.id, turn, recoverable: true });
          }
        }
      }
      return out;
    }, []);
  }

  function composer() {
    return safe(() => document.querySelector('#prompt-textarea'), null);
  }

  /**
   * Whether ChatGPT's editing host is presently safe to receive a new user message.
   *
   * This deliberately says nothing about whether *our* recorder still considers the previous
   * turn open; content.js owns that stronger lifecycle state. It is the page-native half of the
   * same proof: a connected/editable composer, no Stop/generation control, and no user draft.
   * Keeping the emptiness check here also makes it impossible for a revival waiter to "reserve"
   * the composer by inserting its text before the page is actually ready.
   */
  function composerSubmitReady() {
    return safe(() => {
      const box = composer();
      if (!box || !box.isConnected) return false;
      if (generating() || stopButton()) return false;
      if ((box.textContent || '').trim() !== '') return false;
      if (box.getAttribute('aria-disabled') === 'true') return false;
      if (box.getAttribute('contenteditable') === 'false') return false;
      return true;
    }, false);
  }

  /** The composer as a whole, used as the root to watch for React replacing it. */
  function composerBox() {
    return safe(() => {
      const box = composer();
      if (!box) return null;
      return box.closest('form') || box.parentElement || null;
    }, null);
  }

  /**
   * Whether the page is currently drawn light or dark: `'light'` or `'dark'`.
   *
   * Not `prefers-color-scheme`. ChatGPT's appearance setting is its own — it can be pinned
   * to Light on a dark Windows and the other way round — so asking the operating system
   * gives our injected menu the opposite surface from the page it is sitting on. Not the
   * `html` class either: the theme classes are ChatGPT's and would be one more name to
   * break. What is asked instead is the paint: the composer's own background, which is the
   * surface our control physically sits on, climbing until an ancestor is actually opaque
   * (the composer's inner layers are transparent over the one that carries the colour).
   */
  function pageTheme() {
    return safe(() => {
      for (let node = composerBox() || document.body; node; node = node.parentElement) {
        const found = luminance(getComputedStyle(node).backgroundColor);
        if (found !== null) return found < 0.5 ? 'dark' : 'light';
      }
      const declared = getComputedStyle(document.documentElement).colorScheme || '';
      return declared.indexOf('dark') >= 0 ? 'dark' : 'light';
    }, 'dark');
  }

  /** Perceived brightness of a painted colour, or null if it paints nothing at all. */
  function luminance(color) {
    const parts = String(color).match(/[\d.]+/g);
    if (!parts || parts.length < 3) return null;
    // A transparent layer shows what is behind it, so it is not this node's answer.
    if (parts.length > 3 && Number(parts[3]) === 0) return null;
    const [red, green, blue] = parts.slice(0, 3).map(Number);
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  }

  /**
   * Where a control of ours belongs in the composer: `{ host, before }`.
   *
   * ChatGPT gives its trailing button row no stable id, so the anchor is the send button
   * (or the stop button that replaces it while generating, or the dictation button when
   * the composer is empty and there is no send button at all). Our control goes *before*
   * that anchor, so send stays the rightmost thing in the composer — moving the primary
   * action of the page is not ours to do.
   */
  function composerActions() {
    return safe(() => {
      const anchor = document.querySelector(SEND) || document.querySelector(STOP) || document.querySelector(SPEECH);
      const explicit = anchor ? anchor.closest(TRAILING) : document.querySelector(TRAILING);
      if (!anchor) return explicit ? { host: explicit, before: null } : null;

      // The row that holds several controls, not the wrapper around this one button.
      // Capped: climbing all the way to <body> because every ancestor happens to have one
      // child would put our control somewhere it has no business being.
      let host = anchor.parentElement;
      for (let up = 0; up < 3 && host && host !== explicit && host.children.length < 2 && host.parentElement; up++) {
        host = host.parentElement;
      }
      if (!host) return null;
      let before = anchor;
      while (before && before.parentElement !== host) before = before.parentElement;
      return { host, before: before || null };
    }, null);
  }

  /**
   * The node holding the text of the chat's first user message, if there is one.
   *
   * Only ever asked for on a chat this app opened, where the first user message is the
   * instruction the app typed. Returns the message element itself, so the caller folds
   * away the text and nothing structural around it.
   */
  function firstUserMessage() {
    return safe(() => {
      for (const turn of turns()) {
        for (const section of turnNodes(turn)) {
          for (const node of section.querySelectorAll('[data-message-id]')) {
            const role = node.getAttribute('data-message-author-role') || turn.role;
            if (role === 'assistant') return null;
            if (role === 'user') return node;
          }
        }
      }
      return null;
    }, null);
  }

  /**
   * Where a panel of ours belongs *above* the composer: `{ host, before }`.
   *
   * Outside the composer's own container rather than inside it. A block element inside
   * ChatGPT's input row fights the row's layout, and a click that lands anywhere in there
   * is turned into "focus the textarea" — so a panel with text to read and scroll cannot
   * live there.
   */
  function composerStack() {
    return safe(() => {
      const box = composerBox();
      if (!box || !box.parentElement) return null;
      return { host: box.parentElement, before: box };
    }, null);
  }

  /**
   * Stable mount point for the extension-owned activity stream of one assistant turn.
   * The stream is a sibling of ChatGPT's own activity, so replacing a tool/reasoning
   * subtree cannot take the local transcript with it.
   */
  function turnMount(turn) {
    return safe(() => {
      const sections = turnNodes(turn);
      const host = sections[0] || null;
      if (!host) return null;

      // Where ChatGPT itself put this turn's activity. Anchoring there is the whole point:
      // the stream stands in for that block, so it has to occupy the same place in the
      // turn. Mounting at the top of the section instead — which is what this did — lifted
      // every reconstructed call and caption above the commentary and prose they belong
      // between, and made a long turn read as if all the work happened first.
      for (const section of sections) {
        for (const box of progressRoots(section)) {
          if (box.closest && box.closest(OWN_SURFACES)) continue;
          if (box.parentElement) return { host: box.parentElement, before: box };
        }
      }

      // No activity block yet. The answer is the only other fixed landmark, and the stream
      // belongs above it: everything in the stream happened before the turn could answer.
      for (const section of sections) {
        for (const prose of section.querySelectorAll('.markdown')) {
          if (prose.closest && (prose.closest(TOOL) || prose.closest(OWN_SURFACES))) continue;
          if (prose.parentElement) return { host: prose.parentElement, before: prose };
        }
      }

      // Neither: append, rather than prepend. An assistant section with tool rows and no
      // reasoning box renders those rows first, and the stream stands after them.
      return { host, before: null };
    }, null);
  }

  /**
   * Does this progress box also contain the turn's answer?
   *
   * ChatGPT's reasoning container can expand and reparent around content that started
   * outside it, so a `[data-interrupted]` subtree is not reliably progress-only. Hiding
   * one that has grown to hold the final prose is what leaves a turn showing "Worked for
   * 45s" above an empty gap with no answer under it.
   */
  function holdsAnswer(box) {
    return safe(() => {
      const prose = [...box.querySelectorAll('.markdown')].filter(
        (node) => !(node.closest && node.closest(TOOL)) && !(node.closest && node.closest(OWN_SURFACES))
      );
      return prose.some((node) => text(node).length > 0);
    }, true);
  }

  /** Hides/restores only ChatGPT's own visible progress boxes for this logical turn. */
  function hideProgress(turn, hidden) {
    return safe(() => {
      for (const section of turnNodes(turn)) {
        for (const box of section.querySelectorAll('[data-interrupted]')) {
          // Restoring is always safe; hiding is not. A box carrying the answer stays.
          if (hidden && !holdsAnswer(box)) box.setAttribute('data-clf-native-hidden', '1');
          else box.removeAttribute('data-clf-native-hidden');
        }
      }
    }, undefined);
  }

  /**
   * Makes one assistant turn an app-owned surface without deleting any React-owned DOM.
   *
   * The recorder still needs ChatGPT's native subtree to exist so it can observe final
   * prose, progress and lifecycle changes. The visible stream deliberately lives *beside*
   * ChatGPT's turn sections, not inside one of them. React transiently moves/reuses assistant
   * sections while mounting the next user turn; keeping our stream inside such a section made
   * the already-correct assistant answer jump across the new user message for one paint before
   * reconciliation put it back. A connected sibling stream therefore never follows a native
   * section that React moves. Turning Overwrite off only removes markers/the sibling; React
   * never has to reconstruct anything we destroyed.
   */
  function replaceTurn(turn, root, replaced) {
    return safe(() => {
      const sections = turnNodes(turn);
      if (sections.length === 0) return false;
      for (const section of sections) {
        if (replaced) section.setAttribute('data-clf-turn-replaced', '1');
        else section.removeAttribute('data-clf-turn-replaced');
      }
      const embedded = Boolean(root && sections.some((section) => root.parentElement === section));
      if (replaced && root && (!root.isConnected || embedded)) {
        const last = sections[sections.length - 1];
        if (last && last.parentElement) last.parentElement.insertBefore(root, last.nextSibling);
      }
      return true;
    }, false);
  }

  /** Types into the composer. Refuses if the user already has a draft there. */
  function insertPrompt(value) {
    return safe(() => {
      const box = composer();
      if (!box) return false;
      if ((box.textContent || '').trim() !== '') return false;
      box.focus();
      // execCommand still produces the native editing path ChatGPT listens for. Newer
      // composer builds occasionally ignore its return value, so verify the DOM and
      // also emit input so React cannot miss the mutation.
      document.execCommand('insertText', false, value);
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return (box.textContent || '').trim().length > 0;
    }, false);
  }

  /** Clears only app-owned text that still exactly matches the value it inserted. */
  function clearPromptExact(value) {
    return safe(() => {
      const box = composer();
      const compact = (text) => String(text || '').replace(/\s+/g, '');
      if (!box || compact(box.textContent) !== compact(value)) return false;
      box.focus();
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      return (box.textContent || '').trim() === '';
    }, false);
  }

  async function send() {
    try {
      const box = composer();
      if (!box) return false;
      const submitted = (box.textContent || '').trim();
      if (!submitted) return false;
      const compact = (value) => String(value || '').replace(/\s+/g, '');
      const expected = compact(submitted);
      const beforeConversation = conversationId();
      const beforeGenerating = generating();
      const beforeStop = stopButton();
      const priorUserNodes = new Set(
        messages()
          .filter((message) => message.role === 'user' && message.node)
          .map((message) => message.node)
      );

      // click()/dispatchEvent() only prove that JavaScript ran, not that ChatGPT accepted a
      // prompt. Observe for a page-owned consequence instead of sleeping and re-sampling on a
      // clock. Composer clear and a freshly rendered matching user message are direct submit
      // evidence; a newly assigned conversation id or a generation/Stop transition covers
      // editor variants that leave the rich-text value mounted while React starts the turn.
      const accepted = () => {
        const current = composer();
        if (current && (current.textContent || '').trim() === '') return true;
        const currentConversation = conversationId();
        if (currentConversation && currentConversation !== beforeConversation) return true;
        if (!beforeGenerating && generating()) return true;
        if (!beforeStop && stopButton()) return true;
        const visible = messages();
        for (let at = visible.length - 1; at >= 0; at--) {
          const message = visible[at];
          if (message.role !== 'user') continue;
          if (!priorUserNodes.has(message.node) && compact(message.text) === expected) return true;
        }
        return false;
      };

      return await new Promise((resolve) => {
        let done = false;
        let observer = null;
        let timer = null;
        const finish = (value) => {
          if (done) return;
          done = true;
          if (observer) observer.disconnect();
          if (timer !== null) clearTimeout(timer);
          resolve(value);
        };
        const check = () => {
          if (accepted()) finish(true);
        };

        observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true
        });
        timer = setTimeout(() => finish(false), 3000);

        try {
          const button = document.querySelector(SEND);
          if (button && !button.disabled) {
            button.click();
          } else {
            const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            box.dispatchEvent(new KeyboardEvent('keydown', key));
            box.dispatchEvent(new KeyboardEvent('keyup', key));
          }
          // Close the race where the acceptance mutation happens synchronously inside the
          // click/keyboard handler before MutationObserver gets its microtask callback.
          check();
        } catch {
          finish(false);
        }
      });
    } catch {
      return false;
    }
  }

  return {
    conversationId,
    conversationFromPath,
    conversationTitle,
    turns,
    presentationTurns,
    messages,
    messagesIn,
    completionAction,
    sectionSignature,
    generating,
    stopButton,
    progressLine,
    progressItems,
    interrupted,
    markProgress,
    toolBlocks,
    activityItems,
    isConnectorBlock,
    markLocalBlock,
    hasConnectorRow,
    connectorRows,
    fiberRef,
    toolLabel,
    errors,
    composer,
    composerSubmitReady,
    composerBox,
    pageTheme,
    composerActions,
    composerStack,
    firstUserMessage,
    turnMount,
    hideProgress,
    replaceTurn,
    insertPrompt,
    clearPromptExact,
    send
  };
})();
