/**
 * Passive, bounded page-response projection.
 *
 * Never reads request headers, cookies, credentials or request bodies. Besides
 * quota metadata, it observes the two opaque identifiers ChatGPT itself puts in the live
 * conversation event stream: `conversation_id` and `metadata.request_id`. The latter can
 * reach the stream tens of seconds before React publishes it, which is the difference between
 * an exact Core caller and CALLER_IDENTITY_REQUIRED. Only that pair crosses worlds.
 */
(() => {
  'use strict';
  const OBSERVER_VERSION = 3;
  const prior = window.__cosUsageObserver;
  if (prior?.version === OBSERVER_VERSION && typeof prior.refresh === 'function' && prior.refresh() === true) return;
  // A legacy boolean has no listener/reader disposal handle. A fresh document is
  // required to replace it; stacking another active observer is not a repair.
  if (prior && typeof prior.dispose !== 'function') { window.__cosUsageObserverNeedsReload = true; return; }
  prior?.dispose();
  let active = true;
  const nativePost = window.postMessage.bind(window);
  const post = (...args) => { if (active) nativePost(...args); };
  let latest = null;
  let requestOrder = 0, latestOrder = 0;
  const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CONVERSATION_PATH = /(?:^|\/)conversation_id(?:\/|$)/;
  // @ehkogh/#318: the alternate shell also uses bare UUID workflow ids.
  const REQUEST = /^(?:wfr_[a-zA-Z0-9_-]{1,96}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
  // Scan whole JSON string tokens so quoted message content cannot introduce keys.
  // Unlike JSON.parse alone, this also retains contradictory duplicate/escaped keys.
  const JSON_STRING_FIELD = /("(?:[^"\\]|\\.)*")\s*(:)?/g;
  const JSON_STRING_VALUE = /\s*("(?:[^"\\]|\\.)*")/y;
  // Passive evidence only: no polling, and no full response survives a scan. Retain a
  // small replay window for document_start -> content-script readiness and deduplicate
  // repeated provider observations across responses as well as inside one stream.
  const origins = new Map();
  const originReaders = new Set();
  const readers = new Set();
  const ORIGIN_LISTEN_MS = 15 * 60_000;
  function publishOrigin(conversationId, requestIds, observedAt) {
    if (!active) return;
    const fresh = requestIds.filter(id => !origins.has(`${conversationId}:${id}`));
    if (!fresh.length) return;
    for (const requestId of fresh) {
      if (origins.size >= 64) origins.delete(origins.keys().next().value);
      origins.set(`${conversationId}:${requestId}`, { conversationId, requestId, observedAt });
    }
    post({ type: 'cos-request-origin', conversationId, requestIds: fresh, observedAt }, location.origin);
  }
  const project = (data, observedAt, order) => {
    if (!data || typeof data !== 'object') return;
    const rows = [];
    const label = (value) => typeof value === 'string' && /^[a-zA-Z0-9_. /-]{1,100}$/.test(value) ? value : null;
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const add = (value) => { if (rows.length < 80) rows.push(value); };
    const metadata = data.conversation_detail_metadata || data;
    const recognized = Array.isArray(metadata.model_limits) || Array.isArray(metadata.limits_progress) || !!data.rate_limit || Array.isArray(data.additional_rate_limits);
    if (!recognized || order < latestOrder) return;
    for (const row of (Array.isArray(metadata.model_limits) ? metadata.model_limits : []).slice(0, 40)) {
      const model = label(row?.model_slug);
      const reset = typeof row?.resets_after === 'string' ? Date.parse(row.resets_after) : NaN;
      // A reset timestamp alone is not a remaining-message count.
      const remaining = finite(row?.remaining), resetAt = Number.isFinite(reset) && reset > 0 ? reset : null;
      if (model && (remaining !== null || resetAt !== null)) add({ model, scope: 'model', remaining, remainingPercent: null, resetAt, windowSeconds: null });
    }
    for (const row of (Array.isArray(metadata.limits_progress) ? metadata.limits_progress : []).slice(0, 40)) {
      const model = label(row?.model_slug), feature = label(row?.feature_name), remaining = finite(row?.remaining);
      const reset = typeof row?.reset_after === 'string' ? Date.parse(row.reset_after) : NaN;
      if ((model || feature) && remaining !== null) add({ model: model || feature, scope: model ? 'model' : 'feature', remaining, remainingPercent: null, resetAt: Number.isFinite(reset) && reset > 0 ? reset : null, windowSeconds: null });
    }
    const rates = [{ ...data, label: 'Shared usage' }, ...(Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.slice(0, 40) : [])];
    for (const rate of rates) {
      const model = label(rate?.model_slug), name = model || label(rate?.limit_name) || label(rate?.label);
      for (const window of [rate?.rate_limit?.primary_window, rate?.rate_limit?.secondary_window]) {
        const used = finite(window?.used_percent);
        if (!name || used === null || used > 100) continue;
        const reset = finite(window?.reset_at);
        add({ model: name, scope: model ? 'model' : 'shared', remaining: null, remainingPercent: 100 - used, resetAt: reset === null || reset === 0 ? null : reset * 1000, windowSeconds: finite(window?.limit_window_seconds) || null });
      }
    }
    latestOrder = order;
    latest = { type: 'cos-usage', rows, observedAt }; post(latest, location.origin);
  };
  async function inspect(response, observedAt, order) {
    if (!active) return;
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !/^\/backend-api\/(?:wham\/usage|conversation\/init|conversation\/prepare|models)(?:\?|$)/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    readers.add(reader);
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), 10000);
    let bytes = 0, text = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 512 * 1024) return;
        text += decoder.decode(value, { stream: true });
      }
      project(JSON.parse(text + decoder.decode()), observedAt, order);
    } catch { /* Unsupported metadata is unavailable, never guessed. */ }
    finally { clearTimeout(timer); readers.delete(reader); void reader.cancel().catch(() => {}); }
  }
  /**
   * Reads bounded complete SSE events from a clone without changing the page's response.
   * @Maximapple/#414 identified the split handoff -> input_message request metadata.
   * Only that typed message may reuse an owner from this response or linked socket stream.
   */
  function retireOriginStream(stream) {
    stream.invalid = true;
    stream.conversationId = null;
    stream.header = null;
  }
  function frameConversation(data) {
    let conversationId;
    JSON_STRING_FIELD.lastIndex = 0;
    for (let field; (field = JSON_STRING_FIELD.exec(data));) {
      if (!field[2] || (field[1] !== '"conversation_id"' &&
          (!field[1].includes('\\') || JSON.parse(field[1]) !== 'conversation_id'))) continue;
      JSON_STRING_VALUE.lastIndex = JSON_STRING_FIELD.lastIndex;
      const value = JSON_STRING_VALUE.exec(data);
      if (!value) return null;
      const id = JSON.parse(value[1]);
      if (!CONVERSATION.test(id) || (conversationId && conversationId !== id)) return null;
      conversationId = id;
    }
    return conversationId;
  }
  function readOrigin(frame, stream = {}) {
      if (stream.invalid || !frame) return;
      if (frame.length > 512 * 1024) { retireOriginStream(stream); return; }
      const lines = frame.split(/\r?\n/);
      const type = lines.filter(line => line.startsWith('event:')).at(-1)?.slice(6).trim() || 'message';
      const dataLines = lines.filter(line => line.startsWith('data:'));
      if (!dataLines.length) return; // SSE comments and control-only heartbeats carry no value.
      const data = dataLines.map(line => line.slice(5).trimStart()).join('\n');
      let event, explicitConversation;
      try {
        event = JSON.parse(data);
        explicitConversation = frameConversation(data);
      } catch {
        retireOriginStream(stream);
        return;
      }
      // Even a handoff without a request can contradict the pinned response or socket.
      // A contradiction retires that scope; a later value cannot silently replace its owner.
      if (explicitConversation === null || (explicitConversation &&
          ((stream.conversationId && stream.conversationId !== explicitConversation) ||
           (stream.socketConversationId && stream.socketConversationId !== explicitConversation)))) {
        retireOriginStream(stream); return;
      }
      if (type === 'delta_encoding') {
        stream.encoding = event === 'v1';
        stream.header = stream.encoding ? { c: 0, p: '', o: 'add' } : null;
        if (!stream.encoding) retireOriginStream(stream);
        return;
      }
      let body;
      if (type === 'delta' && stream.encoding === false) return;
      if (type === 'delta') {
        // Native v1 omits repeated headers, including on complete root messages.
        // Keep format fields and the exact owner only, never prior message values.
        if (!event || typeof event !== 'object' || Array.isArray(event)) { retireOriginStream(stream); return; }
        const own = key => Object.prototype.hasOwnProperty.call(event, key);
        const operations = ['add', 'replace', 'append', 'patch', 'remove', 'truncate'];
        if ((own('c') && (!Number.isInteger(event.c) || event.c < 0 || event.c > 1023)) ||
            (own('p') && (typeof event.p !== 'string' || event.p.length > 1024)) ||
            (own('o') && !operations.includes(event.o))) { retireOriginStream(stream); return; }
        // A handoff may omit the prologue. An explicit root-add remains readable,
        // but cannot grant inherited format fields to subsequent deltas.
        if (!stream.header && !(event.p === '' && event.o === 'add')) { retireOriginStream(stream); return; }
        const field = key => own(key) ? event[key] : stream.header?.[key] ?? (key === 'c' ? 0 : undefined);
        const c = field('c'), p = field('p'), o = field('o');
        if (stream.header) stream.header = { c, p, o };
        // Do not keep an owner across an identity mutation or an uninterpreted
        // compound patch. Reconstructing partial values is outside this observer.
        if (CONVERSATION_PATH.test(p) || o === 'patch' || (p === '' && o !== 'add' && o !== 'replace')) {
          retireOriginStream(stream); return;
        }
        if (p !== '' || (o !== 'add' && o !== 'replace')) return;
        body = event.v;
      } else if (type === 'message') {
        if (event && typeof event === 'object' && ('p' in event || 'o' in event)) {
          if ((typeof event.p === 'string' && CONVERSATION_PATH.test(event.p)) || event.o === 'patch' ||
              ((event.p === '' || event.p === undefined) && event.o !== 'add')) {
            retireOriginStream(stream); return;
          }
          if (event.o !== 'add' || (event.p !== '' && event.p !== undefined)) return;
          if ('c' in event && (!Number.isInteger(event.c) || event.c < 0 || event.c > 1023)) {
            retireOriginStream(stream); return;
          }
          body = event.v;
        } else body = event;
      } else return;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return;
      // Nested/partial conversation fields can veto ownership, but never supply it.
      if (explicitConversation && body.conversation_id !== explicitConversation) return;
      if (explicitConversation) stream.conversationId = explicitConversation;
      const conversationId = explicitConversation || stream.conversationId;
      if (!conversationId) return;
      const candidates = explicitConversation ? [body.metadata?.request_id, body.message?.metadata?.request_id] : [];
      if (body.type === 'input_message') candidates.push(body.input_message?.metadata?.request_id);
      const requestIds = new Set(candidates.filter(id => typeof id === 'string' && REQUEST.test(id)));
      return requestIds.size ? { conversationId, requestIds: [...requestIds] } : null;
  }
  async function inspectRequestOrigins(response, observedAt) {
    if (!active) return;
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !/^\/backend-api\/(?:conversation|f\/conversation(?:\/resume)?)$/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) return;
    if (originReaders.size >= 2) return;
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    originReaders.add(reader);
    readers.add(reader);
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), ORIGIN_LISTEN_MS);
    const decoder = new TextDecoder(), emitted = new Set(), stream = {};
    let bytes = 0, buffer = '';
    const scan = (frame) => {
      const origin = readOrigin(frame, stream);
      if (!origin) return;
      const fresh = origin.requestIds.filter((id) => !emitted.has(id)).slice(0, 16 - emitted.size);
      if (fresh.length === 0) return;
      for (const id of fresh) emitted.add(id);
      publishOrigin(origin.conversationId, fresh, observedAt);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const lf = buffer.indexOf('\n\n');
          const crlf = buffer.indexOf('\r\n\r\n');
          const split = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
          if (split < 0) break;
          const width = buffer.startsWith('\r\n\r\n', split) ? 4 : 2;
          scan(buffer.slice(0, split));
          if (emitted.size >= 16 || stream.invalid) return;
          buffer = buffer.slice(split + width);
        }
        if (buffer.length > 512 * 1024) return;
      }
      buffer += decoder.decode();
      scan(buffer);
    } catch { /* A missing stream observation leaves the existing Fiber path in charge. */ }
    finally { clearTimeout(timer); originReaders.delete(reader); readers.delete(reader); void reader.cancel().catch(() => {}); }
  }
  let observedFetch = null;
  let observedWebSocket = null;
  const observedSockets = new WeakSet();
  function inspectSocketMessage(event, streams) {
    if (!active) { streams.clear(); return; }
    // Pro hands its HTTP stream to the native conversation-turn-stream socket.
    // Header-only events matter too. No subscriptions or message reconstruction.
    if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) { streams.clear(); return; }
    let rows;
    try { rows = JSON.parse(event.data); } catch { streams.clear(); return; }
    if (!Array.isArray(rows) || rows.length > 32) { streams.clear(); return; }
    for (const row of rows) {
      const payload = row?.payload?.payload;
      if (row?.type !== 'message' || row.payload?.type !== 'conversation-turn-stream' ||
          typeof payload?.conversation_id !== 'string' || !CONVERSATION.test(payload.conversation_id)) continue;
      const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
      const key = opaque(payload.turn_id) ? `${payload.conversation_id}\u0000${payload.turn_id}` : null;
      if (payload.type === 'done') { if (key) streams.delete(key); continue; }
      if (payload.type !== 'stream-item') continue;
      if (typeof payload.encoded_item !== 'string' || payload.encoded_item.length > 512 * 1024) { if (key) streams.delete(key); continue; }
      const frames = payload.encoded_item.split(/\r?\n\r?\n/);
      if (frames.length > 16) { if (key) streams.delete(key); continue; }
      let stream = {};
      if (key && opaque(payload.stream_item_id) && (payload.parent_stream_item_id === null || opaque(payload.parent_stream_item_id))) {
        const now = Date.now();
        let retained = streams.get(key);
        if (!retained || now < retained.at || now - retained.at > ORIGIN_LISTEN_MS) {
          if (!streams.has(key) && streams.size >= 8) streams.delete(streams.keys().next().value);
          retained = { at: now, header: null, last: null, seen: new Set() }; streams.set(key, retained);
        }
        if (retained.seen.has(payload.stream_item_id)) continue;
        // Only the exact preceding item can supply format fields or a split owner.
        if (payload.parent_stream_item_id !== retained.last) {
          retained.header = null; retained.conversationId = null; retained.encoding = undefined;
        }
        retained.last = payload.stream_item_id;
        if (retained.seen.size >= 128) retained.seen.delete(retained.seen.values().next().value);
        retained.seen.add(payload.stream_item_id);
        stream = retained;
      } else if (key) streams.delete(key);
      stream.socketConversationId = payload.conversation_id;
      for (const frame of frames) {
        if (!frame.trim()) continue;
        const origin = readOrigin(frame, stream);
        if (origin?.conversationId === payload.conversation_id)
          publishOrigin(origin.conversationId, origin.requestIds, Date.now());
      }
    }
  }
  function installSocketObserver() {
    if (!active || typeof window.WebSocket !== 'function' || window.WebSocket === observedWebSocket) return;
    observedWebSocket = new Proxy(window.WebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        try {
          const url = new URL(socket.url);
          if (url.protocol === 'wss:' && (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com')) &&
              active && !observedSockets.has(socket)) {
            observedSockets.add(socket);
            const streams = new Map();
            socket.addEventListener('message', event => inspectSocketMessage(event, streams));
            socket.addEventListener('close', () => streams.clear());
          }
        } catch { /* Foreign/unsupported transport remains untouched. */ }
        return socket;
      }
    });
    window.WebSocket = observedWebSocket;
  }
  const inspectedResponses = new WeakSet();
  const installFetchObserver = () => {
    if (!active || window.fetch === observedFetch || typeof window.fetch !== 'function') return;
    // A page wrapper may still call our earlier wrapper. Capture its downstream
    // function per installation; changing a shared pointer would create a cycle.
    const downstreamFetch = window.fetch;
    observedFetch = function (...args) {
      // Request order fences late responses, not accounts. No account identity is inferred.
      const observedAt = Date.now(), order = ++requestOrder;
      const result = downstreamFetch.apply(this, args);
      if (!active) return result;
      void result.then((response) => {
        if (!active) return;
        if (inspectedResponses.has(response)) return;
        inspectedResponses.add(response);
        void inspect(response, observedAt, order).catch(() => {});
        let method = 'GET';
        try {
          const explicit = args[1] && typeof args[1].method === 'string' ? args[1].method : null;
          const inherited = args[0] && typeof args[0] === 'object' && typeof args[0].method === 'string' ? args[0].method : null;
          method = String(explicit || inherited || 'GET').toUpperCase();
        } catch { return; }
        if (method === 'POST') void inspectRequestOrigins(response, observedAt).catch(() => {});
      }).catch(() => {});
      return result;
    };
    // ChatGPT installs its own fetch instrumentation after document_start. Keep that owner in
    // the chain and reattach once at the page-ready boundary; otherwise our flag remains set
    // while the live response observer has silently been replaced.
    window.fetch = observedFetch;
  };
  installFetchObserver();
  installSocketObserver();
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', installFetchObserver, { once: true });
    window.addEventListener('DOMContentLoaded', installSocketObserver, { once: true });
  }
  const request = (event) => {
    if (!active || event.source !== window || event.origin !== location.origin || event.data?.type !== 'cos-usage-request') return;
    if (latest) post(latest, location.origin);
    // Newest first: old evidence must not fill content's 16-ID pending capacity
    // before the current workflow can enter it during document startup.
    for (const { conversationId, requestId, observedAt } of [...origins.values()].slice(-16).reverse())
      post({ type: 'cos-request-origin', conversationId, requestIds: [requestId], observedAt }, location.origin);
  };
  const hide = () => {
    for (const reader of originReaders) void reader.cancel().catch(() => {});
    origins.clear();
  };
  window.addEventListener('message', request);
  window.addEventListener('pagehide', hide);
  window.__cosUsageObserver = {
    version: OBSERVER_VERSION,
    refresh() { installFetchObserver(); installSocketObserver(); return active; },
    current: () => active && window.fetch === observedFetch && window.WebSocket === observedWebSocket,
    dispose() {
      active = false;
      for (const reader of readers) void reader.cancel().catch(() => {});
      readers.clear(); origins.clear(); latest = null;
      window.removeEventListener('message', request); window.removeEventListener('pagehide', hide);
      window.removeEventListener('DOMContentLoaded', installFetchObserver);
      window.removeEventListener('DOMContentLoaded', installSocketObserver);
    }
  };
})();
