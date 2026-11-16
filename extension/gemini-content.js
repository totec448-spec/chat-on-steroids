/**
 * Companion content script for Google Gemini Web (`https://gemini.google.com/*`).
 * Streams live Gemini transcript observations into Chat On Steroids Desktop through
 * `extension/background.js` and executes queued CoS inputs, worker spawns, revivals, and stops.
 */
(() => {
  const RECORDER_VERSION = 22;
  const DOM = globalThis.COS_GEMINI_DOM;
  if (!DOM) return;

  const existing = globalThis.__COS_GEMINI_CONTENT__;
  if (existing && existing.version === RECORDER_VERSION && typeof existing.healthy === 'function' && existing.healthy()) {
    return;
  }
  if (existing && typeof existing.stop === 'function') {
    try { existing.stop(); } catch { /* ignore prior instance teardown errors */ }
  }

  const RUN_ID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `gem-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;

  let alive = true;
  let conversationId = DOM.conversationId();
  let lastHref = globalThis.location?.href || '';
  let agent = null;
  let agentCommandId = null;
  let epoch = 1;

  let desktopInputBusy = false;
  let commandBusy = false;
  let modelCatalogBusy = false;
  let generating = false;
  let stopRequested = false;
  let lastTitle = '';
  let lastModel = '';
  let turnCounter = 0;
  let currentTurnId = null;
  let settleTimer = null;
  let observeTimer = null;
  let keepAwakeRelease = null;

  const reportedUsers = new Map();
  const reportedAssistants = new Map();
  const reportedErrors = new Set();
  const claimedInputs = new Set();
  const claimedCommands = new Set();
  const redeemingCommands = new Set();
  const bootRetryTimers = new Map();
  const dispatchedWorkerTurns = new Set();

  let outgoing = [];
  let flushing = false;
  let flushAgain = false;
  let activityTimer = null;
  let observeInterval = null;
  let observer = null;
  let activePromptAttempt = false;
  let initialScanDone = false;

  function normText(value) {
    return String(value || '').replace(/\u200b/g, '').replace(/\r\n?/g, '\n').trim();
  }

  async function ask(message) {
    if (!alive) return null;
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      const text = String(err && err.message ? err.message : err);
      if (text.includes('Extension context invalidated')) stop();
      return null;
    }
  }

  function setKeepAwake(on) {
    const locks = globalThis.navigator && globalThis.navigator.locks;
    if (on && !keepAwakeRelease && locks && typeof locks.request === 'function') {
      const name = `cos-gemini-keep-awake-${Math.random().toString(36).slice(2, 10)}`;
      let release = null;
      const held = new Promise((resolve) => { release = resolve; });
      keepAwakeRelease = release;
      Promise.resolve(locks.request(name, () => held)).catch(() => {
        if (keepAwakeRelease === release) keepAwakeRelease = null;
      });
    } else if (!on && keepAwakeRelease) {
      const release = keepAwakeRelease;
      keepAwakeRelease = null;
      release();
    }
    return Boolean(keepAwakeRelease);
  }

  function emit(event) {
    if (!alive) return;
    outgoing.push({
      ...event,
      time: typeof event.time === 'number' ? event.time : Date.now(),
      ...(conversationId ? { conversationId } : {}),
      ...(agent ? { agent, agentCommandId } : {})
    });
    if (outgoing.length > 500) outgoing = outgoing.slice(-500);
  }

  async function flush() {
    if (!alive || !outgoing.length) return;
    if (flushing) {
      flushAgain = true;
      return;
    }
    flushing = true;
    try {
      while (alive && outgoing.length) {
        const batch = outgoing.slice(0, 50);
        const entries = batch.map((item) => {
          if (item && typeof item === 'object' && item.event && typeof item.event.kind === 'string') {
            return {
              ...item,
              conversationId: item.conversationId || conversationId || null,
              ...(item.agent ? { agent: item.agent, agentCommandId: item.agentCommandId } : {})
            };
          }
          const itemConv = (item && typeof item.conversationId === 'string' && item.conversationId) || conversationId || null;
          const { agent: itemAgent, agentCommandId: itemCommandId, ...itemEvent } = item || {};
          return {
            event: itemEvent,
            conversationId: itemConv,
            ...(itemAgent ? { agent: itemAgent, agentCommandId: itemCommandId } : {})
          };
        });
        const reply = await ask({
          type: 'events',
          conversationId,
          entries
        });
        if (!reply || reply.ok !== true) break;
        outgoing.splice(0, batch.length);
      }
    } finally {
      flushing = false;
      if (flushAgain && alive && outgoing.length) {
        flushAgain = false;
        void flush();
      }
    }
  }

  function nextTurnId() {
    turnCounter += 1;
    return `gturn-${turnCounter}-${RUN_ID.slice(0, 8)}`;
  }

  function refreshConversationRoute() {
    const href = globalThis.location?.href || '';
    const nextConv = DOM.conversationId(href);
    if (href !== lastHref || nextConv !== conversationId) {
      const prevConv = conversationId;
      lastHref = href;
      if (nextConv !== prevConv) {
        conversationId = nextConv;
        if (prevConv) {
          epoch += 1;
          reportedUsers.clear();
          reportedAssistants.clear();
          reportedErrors.clear();
          if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
          }
          currentTurnId = null;
          generating = false;
          stopRequested = false;
          activePromptAttempt = false;
          initialScanDone = false;
          lastTitle = '';
          lastModel = '';
        }
        if (nextConv) {
          void ask({ type: 'bind', conversationId: nextConv });
        }
      }
    }
  }

  function finishCurrentTurn(lastAssistant, outcome) {
    if (!currentTurnId) return;
    const turnId = currentTurnId;
    if (lastAssistant && (lastAssistant.text || lastAssistant.renderedHtml)) {
      const sig = `final\u0000${lastAssistant.text}\u0000${lastAssistant.renderedHtml}\u0000${turnId}`;
      if (reportedAssistants.get(lastAssistant.messageId) !== sig) {
        reportedAssistants.set(lastAssistant.messageId, sig);
        emit({
          kind: 'assistant_message',
          messageId: lastAssistant.messageId,
          providerMessageId: lastAssistant.providerMessageId,
          turnId,
          text: lastAssistant.text,
          renderedHtml: lastAssistant.renderedHtml,
          state: 'final',
          final: true,
          activeNow: true
        });
      }
    }
    emit({ kind: 'turn_end', turnId, outcome });
    currentTurnId = null;
    generating = false;
    stopRequested = false;

    if (
      outcome === 'completed' &&
      !agent &&
      conversationId &&
      !dispatchedWorkerTurns.has(turnId) &&
      lastAssistant?.text
    ) {
      const workers = DOM.extractWorkerSpawnDirective(lastAssistant.text);
      if (workers && workers.length) {
        dispatchedWorkerTurns.add(turnId);
        void ask({
          type: 'gemini_spawn_workers',
          conversationId,
          turnId,
          workers
        });
      }
    }
    void flush();
  }

  function observe() {
    if (!alive) return;
    refreshConversationRoute();

    const title = DOM.conversationTitle();
    if (title && title !== lastTitle) {
      lastTitle = title;
      emit({ kind: 'conversation_title', title });
    }

    const model = DOM.modelLabel();
    if (model && model !== lastModel) {
      lastModel = model;
      emit({ kind: 'model_selection', model });
    }

    const turns = DOM.extractTurns();
    const domBusy = DOM.generating();
    const lastUser = [...turns].reverse().find((t) => t.role === 'user') || null;
    const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant') || null;

    for (const msg of turns) {
      if (msg.role === 'user') {
        const prev = reportedUsers.get(msg.messageId);
        if (prev !== msg.text) {
          reportedUsers.set(msg.messageId, msg.text);
          const authoredNow = initialScanDone || activePromptAttempt;
          emit({
            kind: 'user_message',
            messageId: msg.messageId,
            providerMessageId: msg.providerMessageId,
            text: msg.text,
            ...(currentTurnId && msg === lastUser ? { turnId: currentTurnId } : {}),
            ...(authoredNow ? { authoredNow: true } : { authoredTime: true })
          });
        }
      }
    }

    const assistantTurnBusy = Boolean(domBusy || lastAssistant?.streaming);

    if (assistantTurnBusy && !currentTurnId) {
      currentTurnId = nextTurnId();
      generating = true;
      emit({ kind: 'turn_start', turnId: currentTurnId });
    }

    for (const msg of turns) {
      if (msg.role !== 'assistant') continue;
      const isLast = msg === lastAssistant;
      const isStreamingHere = isLast && assistantTurnBusy;
      const useTurnId = isLast ? currentTurnId || (isStreamingHere ? nextTurnId() : undefined) : undefined;
      if (isLast && !currentTurnId && isStreamingHere) {
        currentTurnId = useTurnId;
        generating = true;
        emit({ kind: 'turn_start', turnId: currentTurnId });
      }
      const state = isStreamingHere || (isLast && currentTurnId) ? 'streaming' : 'final';
      const sig = `${state}\u0000${msg.text}\u0000${msg.renderedHtml}\u0000${useTurnId || ''}`;
      if (reportedAssistants.get(msg.messageId) === sig) continue;
      reportedAssistants.set(msg.messageId, sig);
      if (msg.text || msg.renderedHtml) {
        emit({
          kind: 'assistant_message',
          messageId: msg.messageId,
          providerMessageId: msg.providerMessageId,
          ...(useTurnId ? { turnId: useTurnId } : {}),
          text: msg.text,
          renderedHtml: msg.renderedHtml,
          state,
          final: state === 'final',
          ...(isLast && (isStreamingHere || activePromptAttempt) ? { activeNow: true } : { authoredTime: true })
        });
      }
    }

    if (assistantTurnBusy) {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
    } else if (currentTurnId) {
      if (!settleTimer) {
        const settlingTurn = currentTurnId;
        settleTimer = setTimeout(() => {
          settleTimer = null;
          if (!alive || currentTurnId !== settlingTurn) return;
          if (DOM.generating()) return;
          const latestTurns = DOM.extractTurns();
          const latestAssistant = [...latestTurns].reverse().find((t) => t.role === 'assistant') || null;
          if (latestAssistant?.streaming) return;
          finishCurrentTurn(latestAssistant, stopRequested ? 'stopped' : 'completed');
        }, 550);
      }
    }

    for (const errText of DOM.errors()) {
      if (reportedErrors.has(errText)) continue;
      reportedErrors.add(errText);
      emit({ kind: 'chat_error', text: errText, recoverable: true });
    }

    initialScanDone = true;
    void flush();
  }

  function scheduleObserve(delay = 140) {
    if (!alive || observeTimer) return;
    observeTimer = setTimeout(() => {
      observeTimer = null;
      observe();
    }, delay);
  }

  async function waitForComposer(timeoutMs = 12_000, guard = () => alive) {
    const deadline = Date.now() + timeoutMs;
    while (guard() && Date.now() < deadline) {
      const el = DOM.composer();
      if (el) return el;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return guard() ? DOM.composer() : null;
  }

  async function waitForSendReady(timeoutMs = 2_500, guard = () => alive) {
    const deadline = Date.now() + timeoutMs;
    while (guard() && Date.now() < deadline) {
      const btn = DOM.sendButton();
      if (btn) return btn;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return guard() ? DOM.sendButton() : null;
  }

  function composerPromptBlocker(wantedText, allowedDrafts = []) {
    if (generating || DOM.generating()) return 'busy';
    const comp = DOM.composer();
    if (!comp) return 'missing';
    const currentDraft = normText(DOM.readComposerText(comp));
    const wanted = normText(wantedText);
    if (currentDraft && currentDraft !== wanted && !allowedDrafts.includes(currentDraft)) {
      return 'draft';
    }
    return null;
  }

  function scheduleBootstrapRetry(id, delayMs = 1_500) {
    if (!alive || !id || claimedCommands.has(id) || bootRetryTimers.has(id)) return;
    const timer = setTimeout(() => {
      bootRetryTimers.delete(id);
      if (alive && !claimedCommands.has(id)) {
        void redeemBootstrapCommand(id);
      }
    }, delayMs);
    bootRetryTimers.set(id, timer);
  }

  function urlParam(name) {
    try {
      const url = new URL(globalThis.location.href);
      const q = url.searchParams.get(name);
      if (q) return q;
      const h = new URLSearchParams(url.hash.slice(1)).get(name);
      return h || null;
    } catch {
      return null;
    }
  }

  async function submitPromptIntoComposer(text, failReport, options = {}) {
    const capturedEpoch = Number.isInteger(options.expectedEpoch) ? options.expectedEpoch : epoch;
    const hasExpectedConv = Object.prototype.hasOwnProperty.call(options, 'expectedConversationId');
    const capturedConv = hasExpectedConv ? options.expectedConversationId : conversationId;
    const routeCurrent = () => {
      refreshConversationRoute();
      return alive && epoch === capturedEpoch && (capturedConv === null ? !conversationId : conversationId === capturedConv);
    };

    const comp = await waitForComposer(12_000, routeCurrent);
    if (!routeCurrent()) return failReport('Gemini tab navigated away before composer was ready.', 'route-changed');
    if (!comp) return failReport('Gemini composer did not appear in time.', 'transient');

    if (options.checkBusyAndDraft) {
      const blocker = composerPromptBlocker(text, options.allowedDrafts);
      if (blocker === 'busy') {
        return failReport('Gemini is currently generating a response.', options.deferIfBlocked ? 'defer' : 'busy');
      }
      if (blocker === 'draft') {
        return failReport('Gemini already contains an unsent draft. Send or clear it in your browser first.', options.deferIfBlocked ? 'defer' : 'draft');
      }
    }

    if (!routeCurrent()) return failReport('Gemini tab navigated away before prompt insertion.', 'route-changed');
    activePromptAttempt = true;
    if (!DOM.insertPrompt(text)) {
      activePromptAttempt = false;
      return failReport('Could not insert the prompt into Gemini.');
    }

    await waitForSendReady(2_000, routeCurrent);
    if (!routeCurrent()) {
      activePromptAttempt = false;
      return failReport('Gemini tab navigated away before triggering Gemini Send.', 'route-changed');
    }

    const beforeUsers = DOM.extractTurns().filter((t) => t.role === 'user').length;
    if (!DOM.send()) {
      activePromptAttempt = false;
      return failReport('Could not trigger Gemini Send.');
    }

    // Wait briefly so Angular submits and clears the composer or starts generating / changes URL.
    const verifyDeadline = Date.now() + 2_500;
    while (alive && Date.now() < verifyDeadline) {
      refreshConversationRoute();
      const afterUsers = DOM.extractTurns().filter((t) => t.role === 'user').length;
      const draftLeft = normText(DOM.readComposerText(DOM.composer()));
      if (!draftLeft || DOM.generating() || afterUsers > beforeUsers) {
        if (!currentTurnId) {
          currentTurnId = nextTurnId();
          generating = true;
          emit({ kind: 'turn_start', turnId: currentTurnId });
        }
        observe();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    observe();
    return true;
  }

  async function acceptDesktopInput(message) {
    if (!alive || !message || !message.id) return false;
    if (claimedInputs.has(message.id)) return true;
    if (desktopInputBusy || commandBusy) return false;
    refreshConversationRoute();
    const startEpoch = epoch;
    const target = message.conversationId || null;
    if (conversationId !== target) return false;
    if (generating || DOM.generating()) return false;

    const comp = DOM.composer();
    if (!comp) return false;

    desktopInputBusy = true;
    claimedInputs.add(message.id);
    try {
      const claim = await ask({
        type: 'desktop_input',
        id: message.id,
        conversationId: target,
        requiresAuthorization: true
      });
      const input = claim?.data?.input;
      if (!input) {
        claimedInputs.delete(message.id);
        return false;
      }

      const fail = async (error) => {
        await ask({ type: 'desktop_input', id: input.id, owner: input.owner, fail: true, error });
        return false;
      };

      const ownUnsent = (Array.isArray(claim?.data?.ownUnsent) ? claim.data.ownUnsent : [])
        .filter((v) => typeof v === 'string' && v.trim())
        .map(normText);
      const currentDraft = normText(DOM.readComposerText(DOM.composer()));
      if (currentDraft && currentDraft !== normText(input.text) && !ownUnsent.includes(currentDraft)) {
        return fail('Gemini already contains an unsent draft. Send or clear it in your browser first.');
      }

      if (input.requiresAuthorization) {
        const auth = await ask({
          type: 'desktop_input',
          id: input.id,
          owner: input.owner,
          conversationId: DOM.conversationId(),
          authorize: true
        });
        if (auth?.data?.ok !== true) {
          claimedInputs.delete(message.id);
          return false;
        }
      }

      if (input.model) {
        const picked = await DOM.selectModel(input.model, () => alive && DOM.conversationId() === target);
        if (!picked?.ok) {
          await ask({
            type: 'desktop_input',
            id: input.id,
            owner: input.owner,
            fail: true,
            error: `Requested Gemini model could not be confirmed${picked?.error ? ` (${picked.error})` : ''}`,
            detail: 'model-unconfirmed'
          });
          return false;
        }
        if (picked.model && picked.model !== lastModel) {
          lastModel = picked.model;
          emit({ kind: 'model_selection', model: picked.model });
        }
      }

      let failReason = null;
      const sent = await submitPromptIntoComposer(input.text, (err) => {
        failReason = err;
        return false;
      }, {
        expectedEpoch: startEpoch,
        expectedConversationId: target,
        checkBusyAndDraft: true,
        allowedDrafts: ownUnsent
      });
      if (!sent) return fail(failReason || 'Could not send message to Gemini.');

      // Wait briefly for Gemini to mint /app/<slug> on new chats if not already bound.
      if (!DOM.conversationId()) {
        const slugDeadline = Date.now() + 12_000;
        while (alive && !DOM.conversationId() && Date.now() < slugDeadline) {
          refreshConversationRoute();
          if (conversationId) break;
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }
      refreshConversationRoute();
      observe();
      await flush();

      const latestUser = [...DOM.extractTurns()].reverse().find((t) => t.role === 'user') || null;
      const receiptMessageId = latestUser?.providerMessageId || latestUser?.messageId || `gem-user-${input.id}`;
      const ackReply = await ask({
        type: 'desktop_input',
        id: input.id,
        owner: input.owner,
        ack: true,
        conversationId,
        messageId: receiptMessageId
      });
      return ackReply?.data?.ok === true;
    } finally {
      desktopInputBusy = false;
    }
  }

  async function redeemBootstrapCommand(explicitId = null) {
    const id = explicitId || urlParam('clf');
    if (!id || claimedCommands.has(id) || redeemingCommands.has(id) || commandBusy) return;
    commandBusy = true;
    redeemingCommands.add(id);
    try {
      const comp = await waitForComposer(bootWaitMs(explicitId));
      if (!alive || !comp) return;
      refreshConversationRoute();
      if (explicitId && (generating || DOM.generating())) {
        scheduleBootstrapRetry(id);
        return;
      }
      const reply = await ask({
        type: 'redeem',
        id,
        client: RUN_ID,
        ...(conversationId ? { conversationId } : {})
      });
      const boot = reply?.command;
      if (!boot) {
        if (reply?.gone === true || (reply?.ok === true && !reply?.command)) {
          claimedCommands.add(id);
        }
        return;
      }
      if (boot.agent) {
        agent = boot.agent;
        agentCommandId = boot.id;
      }

      const target = typeof boot.conversationId === 'string' && boot.conversationId ? boot.conversationId : null;
      refreshConversationRoute();
      const startEpoch = epoch;
      if (target && conversationId !== target) {
        claimedCommands.add(id);
        await ask({
          type: 'ack',
          id: boot.id,
          status: 'failed',
          error: 'Gemini tab navigated to a different conversation before bootstrap.',
          client: RUN_ID
        });
        return;
      }

      const preSendBlocker = composerPromptBlocker(boot.prompt || '');
      if (preSendBlocker === 'busy' || preSendBlocker === 'draft') {
        if (target) {
          void ask({ type: 'defer_revival', id: boot.id, conversationId: target });
        }
        scheduleBootstrapRetry(id);
        return;
      }

      claimedCommands.add(id);

      if (boot.model) {
        const picked = await DOM.selectModel(boot.model, () => {
          refreshConversationRoute();
          return alive && epoch === startEpoch && (target ? conversationId === target : !conversationId);
        });
        if (!picked?.ok) {
          await ask({
            type: 'ack',
            id: boot.id,
            status: 'failed',
            error: `Requested Gemini model could not be confirmed${picked?.error ? ` (${picked.error})` : ''}`,
            detail: 'model-unconfirmed',
            client: RUN_ID
          });
          return;
        }
        if (picked.model && picked.model !== lastModel) {
          lastModel = picked.model;
          emit({ kind: 'model_selection', model: picked.model });
        }
      }

      let failedError = null;
      let failedDetail;
      const ok = await submitPromptIntoComposer(boot.prompt || '', (why, detail) => {
        failedError = why;
        failedDetail = detail;
        return false;
      }, {
        expectedEpoch: startEpoch,
        expectedConversationId: target ?? null,
        checkBusyAndDraft: true,
        deferIfBlocked: true
      });
      if (!ok) {
        if (failedDetail === 'defer') {
          claimedCommands.delete(id);
          if (target) {
            void ask({ type: 'defer_revival', id: boot.id, conversationId: target });
          }
          scheduleBootstrapRetry(id);
          return;
        }
        await ask({
          type: 'ack',
          id: boot.id,
          status: 'failed',
          error: failedError || 'Failed to submit Gemini command',
          client: RUN_ID,
          ...(failedDetail ? { detail: failedDetail } : {})
        });
        return;
      }

      if (!conversationId) {
        const slugDeadline = Date.now() + 3_000;
        while (alive && !conversationId && Date.now() < slugDeadline) {
          refreshConversationRoute();
          if (conversationId) break;
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }
      refreshConversationRoute();
      await flush();

      await ask({
        type: 'ack',
        id: boot.id,
        status: 'sent',
        conversationId,
        agent: boot.agent || agent,
        client: RUN_ID
      });
    } finally {
      redeemingCommands.delete(id);
      commandBusy = false;
    }
  }

  function bootWaitMs(explicitId) {
    return explicitId ? 8_000 : 18_000;
  }

  async function pullActivityOnce() {
    if (!alive || !conversationId) return;
    const reply = await ask({
      type: 'activity',
      conversationId,
      since: 0,
      generating: generating || DOM.generating(),
      approval: false,
      fiber: 'ok'
    });
    if (!alive || !reply?.ok || !reply?.data) return;
    if (Array.isArray(reply.data.revivals)) {
      for (const item of reply.data.revivals) {
        if (item?.conversationId === conversationId && item?.id) {
          void redeemBootstrapCommand(item.id);
          break;
        }
      }
    }
  }

  function catalogPageBlocker() {
    if (generating || DOM.generating()) return 'generating';
    if (desktopInputBusy || commandBusy) return 'input_busy';
    const comp = DOM.composer();
    if (!comp) return 'composer_missing';
    if (normText(DOM.readComposerText(comp))) return 'draft';
    return null;
  }

  function catalogHelper() {
    return !conversationId &&
      /^[a-f0-9-]{36}$/i.test(urlParam('cos-model-catalog') || '') &&
      DOM.extractTurns().length === 0;
  }

  async function inspectAppModelCatalog(message) {
    const ownedEpoch = epoch;
    if (modelCatalogBusy || !message || !/^[a-f0-9-]{36}$/i.test(String(message.nonce || '')) || Date.now() >= message.expiresAt) {
      return false;
    }
    modelCatalogBusy = true;
    try {
      const current = () => alive && epoch === ownedEpoch && Date.now() < message.expiresAt;
      if (catalogPageBlocker() === 'composer_missing' && catalogHelper()) {
        await waitForComposer(12_000, () => current() && catalogHelper());
      }
      if (!current() || catalogPageBlocker()) return false;
      const result = await DOM.inspectModels(document, current).catch(() => ({ models: null, error: 'inspection_failed' }));
      if (!current()) return false;
      const posted = await ask({
        type: 'model_catalog',
        provider: 'gemini',
        nonce: message.nonce,
        models: result?.models ?? null,
        ...(result?.error ? { error: result.error } : {})
      });
      return posted?.ok === true;
    } finally {
      modelCatalogBusy = false;
    }
  }

  function runtimeMessage(message, _sender, sendResponse) {
    if (!alive || !message || typeof message.type !== 'string') return false;
    if (message.type === 'clf-recorder-ping') {
      sendResponse({
        ok: true,
        recorderVersion: RECORDER_VERSION,
        busy: Boolean(generating || DOM.generating() || desktopInputBusy || commandBusy || modelCatalogBusy)
      });
      return false;
    }
    if (message.type === 'clf-page-checks') {
      sendResponse(DOM.pageChecks());
      return false;
    }
    if (message.type === 'clf-model-catalog-state') {
      const reason = modelCatalogBusy ? 'inspection_busy' : catalogPageBlocker();
      const ready = !modelCatalogBusy && (!reason || (reason === 'composer_missing' && catalogHelper()));
      if (!ready || catalogHelper()) {
        sendResponse({ ready, reason });
        return false;
      }
      const readable = Boolean(DOM.modelTrigger());
      sendResponse(readable ? { ready: true, reason: null } : { ready: false, reason: 'picker_unreadable' });
      return false;
    }
    if (message.type === 'clf-model-catalog') {
      if (message.provider && message.provider !== 'gemini') {
        sendResponse({ ok: false, reason: 'page_changed' });
        return false;
      }
      void inspectAppModelCatalog(message)
        .then((ok) => sendResponse({ ok: ok === true, ...(!ok ? { reason: catalogPageBlocker() || 'page_changed' } : {}) }))
        .catch(() => sendResponse({ ok: false, reason: 'inspection_failed' }));
      return true;
    }
    if (message.type === 'clf-page-status') {
      sendResponse({
        ok: true,
        streaming: DOM.generating(),
        approval: false,
        assistantError: null,
        recorderVersion: RECORDER_VERSION,
        runId: RUN_ID,
        conversationId,
        agent,
        epoch,
        generating,
        turnId: currentTurnId,
        generations: turnCounter,
        queued: outgoing.length
      });
      return false;
    }
    if (message.type === 'clf-keep-awake') {
      sendResponse({ ok: true, held: setKeepAwake(message.on === true) });
      return false;
    }
    if (message.type === 'clf-route-changed') {
      refreshConversationRoute();
      observe();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'clf-input-reuse-state') {
      refreshConversationRoute();
      const comp = DOM.composer();
      const safe = !conversationId &&
        !desktopInputBusy &&
        !commandBusy &&
        !modelCatalogBusy &&
        !generating &&
        !DOM.generating() &&
        DOM.extractTurns().length === 0 &&
        Boolean(comp) &&
        !normText(DOM.readComposerText(comp)) &&
        !urlParam('cos-input') &&
        !urlParam('clf');
      sendResponse({ safe, navigationEpoch: epoch });
      return false;
    }
    if (message.type === 'clf-prepare-desktop-input') {
      refreshConversationRoute();
      const id = message && /^[a-f0-9-]{36}$/i.test(String(message.id || '')) ? String(message.id) : '';
      const comp = DOM.composer();
      if (!id || conversationId || desktopInputBusy || commandBusy || modelCatalogBusy || generating || DOM.generating() || DOM.extractTurns().length > 0 || !comp || normText(DOM.readComposerText(comp))) {
        sendResponse({ ready: false, ...(conversationId ? { fallback: true, preSend: true } : {}) });
        return false;
      }
      try {
        const nextUrl = new URL(globalThis.location.href);
        nextUrl.searchParams.set('cos-input', id);
        nextUrl.hash = `cos-input=${id}`;
        history.replaceState(history.state, '', nextUrl.href);
      } catch {
        /* ignore history restrictions */
      }
      sendResponse({ ready: true, navigationEpoch: epoch, url: globalThis.location.href });
      return false;
    }
    if (message.type === 'clf-desktop-input') {
      void acceptDesktopInput(message).then((ok) => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (message.type === 'clf-run-command') {
      void redeemBootstrapCommand(message.id).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (message.type === 'clf-stop-turn') {
      stopRequested = true;
      const stopped = DOM.stopGeneration();
      void ask({
        type: 'stop_ack',
        id: message.id,
        client: RUN_ID,
        conversationId,
        turnId: message.turnId || currentTurnId || 'gemini-turn',
        status: stopped ? 'sent' : 'failed',
        ...(!stopped ? { error: 'Stop control not visible on Gemini.' } : {})
      });
      sendResponse({ ok: stopped });
      return false;
    }
    if (message.type === 'clf-tab-close-check' || message.type === 'clf-close-cancelled-opening') {
      const draft = normText(DOM.readComposerText(DOM.composer()));
      sendResponse({
        safe: !generating && !DOM.generating() && !draft,
        conversationId,
        navigationEpoch: epoch
      });
      return false;
    }
    return false;
  }

  function handleUnload() {
    setKeepAwake(false);
    if (conversationId) {
      try { chrome.runtime.sendMessage({ type: 'closed', conversationId }); } catch { /* ignore */ }
    }
  }

  function stop() {
    alive = false;
    setKeepAwake(false);
    if (settleTimer) clearTimeout(settleTimer);
    if (observeTimer) clearTimeout(observeTimer);
    if (observeInterval) clearInterval(observeInterval);
    if (activityTimer) clearInterval(activityTimer);
    for (const timer of bootRetryTimers.values()) clearTimeout(timer);
    bootRetryTimers.clear();
    if (observer) observer.disconnect();
    try { chrome.runtime.onMessage.removeListener(runtimeMessage); } catch { /* ignore */ }
    try { globalThis.removeEventListener('pagehide', handleUnload); } catch { /* ignore */ }
  }

  globalThis.__COS_GEMINI_CONTENT__ = {
    version: RECORDER_VERSION,
    healthy: () => alive,
    stop
  };

  chrome.runtime.onMessage.addListener(runtimeMessage);
  globalThis.addEventListener('pagehide', handleUnload);

  if (typeof MutationObserver === 'function' && document.documentElement) {
    observer = new MutationObserver(() => scheduleObserve(140));
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  observeInterval = setInterval(() => observe(), 1_500);
  activityTimer = setInterval(() => { void pullActivityOnce(); }, 4_000);

  void ask({ type: 'register_document' }).then((reply) => {
    if (reply?.keepAwake) setKeepAwake(true);
    observe();
    void redeemBootstrapCommand();
  });
})();
