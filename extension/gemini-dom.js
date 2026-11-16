/**
 * Self-contained DOM adapter for Google Gemini Web (`https://gemini.google.com/*`).
 * Loaded in the extension's isolated world alongside `gemini-content.js` and imported by
 * JSDOM unit tests. Read-only helpers never mutate the page; composer helpers return booleans.
 */
(() => {
  const GEMINI_HOSTS = new Set(['gemini.google.com']);
  const GEMINI_SLUG_RE = /^[A-Za-z0-9_-]{8,56}$/;
  const GEMINI_RESERVED = new Set([
    'app',
    'apps',
    'auth',
    'download',
    'edit',
    'extensions',
    'faq',
    'gem',
    'gems',
    'help',
    'login',
    'logout',
    'new',
    'saved-info',
    'scheduled',
    'settings',
    'share',
    'updates',
    'workspace'
  ]);

  const STOP_ARIA_RE = /\b(stop|cancel|durdur|iptal|arrêter|anhalten|detener|interrompi|parar|остановить|停止)\b/i;
  const SEND_ARIA_RE = /\b(send|submit|gönder|envoyer|senden|enviar|invia|отправить|送信)\b/i;
  const THINKING_RE = /model-thoughts|\.thoughts-container|\[data-test-id="thoughts-container"\]/i;
  const SPAWN_BLOCK_RE = /\[\[COS_SPAWN_WORKERS\]\]\s*([\s\S]*?)\s*\[\[\/COS_SPAWN_WORKERS\]\]/g;

  function cleanText(value) {
    return String(value || '')
      .replace(/\u200b/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    const style = el.style;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    try {
      const computed = globalThis.getComputedStyle ? globalThis.getComputedStyle(el) : null;
      if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) return false;
    } catch { /* ignore in synthetic roots */ }
    const body = el.ownerDocument?.body;
    const hasLayout = Boolean(body && typeof body.getClientRects === 'function' && body.getClientRects().length > 0);
    if (hasLayout && typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
    return true;
  }

  function isDisabledControl(el) {
    if (!el) return true;
    if (el.disabled === true || el.hasAttribute('disabled')) return true;
    const ariaDisabled = el.getAttribute('aria-disabled');
    return ariaDisabled === 'true';
  }

  function conversationFromUrl(href = globalThis.location?.href) {
    try {
      const parsed = new URL(String(href || ''));
      if (parsed.protocol !== 'https:' || !GEMINI_HOSTS.has(parsed.hostname)) return null;
      const parts = parsed.pathname.split('/').filter(Boolean);
      const start = parts[0] === 'u' && /^\d+$/.test(parts[1] || '') ? 2 : 0;
      const tail = parts.slice(start);
      let rawSlug = null;
      if (tail[0] === 'app' && tail.length === 2) rawSlug = tail[1];
      else if (tail[0] === 'gem' && tail.length === 3) rawSlug = tail[2];
      if (rawSlug && GEMINI_SLUG_RE.test(rawSlug) && !GEMINI_RESERVED.has(rawSlug.toLowerCase())) {
        return `gemini-${rawSlug}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  function conversationId(href = globalThis.location?.href) {
    return conversationFromUrl(href);
  }

  function isSkippedNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'model-thoughts' || tag === 'mat-icon') return true;
    if (node.getAttribute('aria-hidden') === 'true') return true;
    const cls = typeof node.className === 'string' ? node.className : '';
    if (/\b(?:cdk-visually-hidden|sr-only|visually-hidden|thoughts-container|code-block-decoration|header-formatted)\b/.test(cls)) {
      return true;
    }
    const testId = node.getAttribute('data-test-id') || '';
    if (testId === 'thoughts-container' || testId === 'copy-button') return true;
    return false;
  }

  function extractStructuredText(root) {
    if (!root) return '';
    const chunks = [];
    const blockTags = new Set([
      'p', 'div', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'section', 'article'
    ]);

    function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        chunks.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== 1) return;
      if (isSkippedNode(node)) return;
      const tag = (node.tagName || '').toLowerCase();
      if (tag === 'br') {
        chunks.push('\n');
        return;
      }
      if (tag === 'pre') {
        const code = node.querySelector('code');
        const langMatch = code?.className?.match(/language-([a-z0-9_+-]+)/i);
        const lang = langMatch ? langMatch[1] : '';
        const raw = String((code || node).textContent || '').replace(/\u200b/g, '').trimEnd();
        if (raw) chunks.push(`\n\`\`\`${lang}\n${raw}\n\`\`\`\n`);
        return;
      }
      if (tag === 'li') {
        const ordered = node.parentElement && node.parentElement.tagName.toLowerCase() === 'ol';
        if (ordered) {
          const items = Array.from(node.parentElement.children).filter((c) => c.tagName.toLowerCase() === 'li');
          const idx = Math.max(0, items.indexOf(node)) + 1;
          chunks.push(`${idx}. `);
        } else {
          chunks.push('- ');
        }
      }
      for (const child of node.childNodes) {
        walk(child);
      }
      if (blockTags.has(tag)) {
        chunks.push('\n');
      }
    }

    walk(root);
    return cleanText(chunks.join(''));
  }

  function outerBlocks(root = document) {
    const candidates = Array.from(
      root.querySelectorAll(
        'user-query, model-response, [data-message-author-role="user"], [data-message-author-role="model"]'
      )
    );
    const seen = new Set(candidates);
    return candidates.filter((el) => {
      let cur = el.parentElement;
      while (cur) {
        if (seen.has(cur)) return false;
        cur = cur.parentElement;
      }
      return true;
    });
  }

  function nativeIdOf(el) {
    if (!el) return null;
    const direct = el.getAttribute('data-message-id') || el.getAttribute('data-response-id');
    if (direct && /^[A-Za-z0-9:_-]{4,128}$/.test(direct)) return direct;
    const inner = el.querySelector?.('[data-message-id], [data-response-id]');
    const nested = inner?.getAttribute('data-message-id') || inner?.getAttribute('data-response-id');
    if (nested && /^[A-Za-z0-9:_-]{4,128}$/.test(nested)) return nested;
    return null;
  }

  function extractUserContent(el) {
    const queryRoot =
      el.querySelector?.('.query-text, [data-test-id="user-query-text"], .query-content, .user-query-bubble-with-background') ||
      el;
    const lineNodes = el.querySelectorAll?.('.query-text-line');
    if (lineNodes && lineNodes.length > 0 && queryRoot === el) {
      return cleanText(Array.from(lineNodes).map((n) => extractStructuredText(n)).filter(Boolean).join('\n'));
    }
    const text = extractStructuredText(queryRoot);
    return text.replace(/^(?:You said|Sen dedin)\s*\n+/i, '').trim();
  }

  function extractAssistantContent(el) {
    const contentRoot =
      el.querySelector?.('message-content .markdown, message-content, .model-response-text .markdown, .model-response-text, .response-content') ||
      el;
    const text = extractStructuredText(contentRoot);
    let renderedHtml = '';
    if (contentRoot && contentRoot !== el && typeof contentRoot.innerHTML === 'string') {
      renderedHtml = contentRoot.innerHTML.trim();
    } else if (!THINKING_RE.test(el.tagName || '') && typeof el.innerHTML === 'string') {
      renderedHtml = el.innerHTML.trim();
    }
    return { text, renderedHtml };
  }

  function extractTurns(root = document) {
    const blocks = outerBlocks(root);
    let userCount = 0;
    let assistantCount = 0;
    const turns = [];
    for (const block of blocks) {
      const tag = (block.tagName || '').toLowerCase();
      const authorAttr = block.getAttribute('data-message-author-role');
      const role = tag === 'user-query' || authorAttr === 'user' ? 'user' : 'assistant';
      const occurrence = role === 'user' ? userCount++ : assistantCount++;
      const messageId = `gmsg-${role}-${occurrence}`;
      const providerMessageId = nativeIdOf(block) || messageId;
      if (role === 'user') {
        const text = extractUserContent(block);
        if (!text) continue;
        turns.push({ role: 'user', messageId, providerMessageId, text });
      } else {
        const { text, renderedHtml } = extractAssistantContent(block);
        const streaming =
          block.getAttribute('aria-busy') === 'true' ||
          Boolean(block.querySelector?.('[aria-busy="true"], .streaming, .loading-spinner:not([hidden])'));
        turns.push({ role: 'assistant', messageId, providerMessageId, text, renderedHtml, streaming });
      }
    }
    return turns;
  }

  function stopButton(root = document) {
    const buttons = Array.from(root.querySelectorAll('button'));
    for (const btn of buttons) {
      if (!isVisible(btn) || isDisabledControl(btn)) continue;
      const aria = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('mattooltip') || ''} ${btn.getAttribute('data-test-id') || ''}`;
      const isStopClass = btn.classList.contains('stop') || Boolean(btn.querySelector('.stop-icon, mat-icon[fonticon="stop"], mat-icon[fonticon="stop_circle"]'));
      const iconText = (btn.querySelector('mat-icon')?.textContent || '').trim().toLowerCase();
      if (STOP_ARIA_RE.test(aria) || isStopClass || iconText === 'stop' || iconText === 'stop_circle') {
        return btn;
      }
    }
    return null;
  }

  function generating(root = document) {
    if (stopButton(root)) return true;
    const busy = root.querySelector(
      'model-response[aria-busy="true"], .response-container.streaming, bard-avatar[aria-busy="true"], [data-test-id="streaming-indicator"]'
    );
    return Boolean(busy && isVisible(busy));
  }

  function conversationTitle(root = document) {
    const selectors = [
      '[data-test-id="conversation-title"]',
      '.conversation-title-column .conversation-title',
      'h1.conversation-title',
      '.conversation.selected .conversation-title',
      '[aria-current="page"] .conversation-title',
      '[aria-selected="true"].conversation .conversation-title'
    ];
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      const text = cleanText(el?.textContent || '');
      if (text && !/^(?:Google )?Gemini$/i.test(text)) return text;
    }
    const rawDocTitle = cleanText(root.title || globalThis.document?.title || '');
    const stripped = rawDocTitle.replace(/\s*[-|]\s*(?:Google )?Gemini\s*$/i, '').trim();
    if (!stripped || /^(?:Google )?Gemini$/i.test(stripped)) return '';
    return stripped;
  }

  const MODE_TRIGGER_SELECTORS = [
    '[data-test-id="bard-mode-menu-button"]',
    'bard-mode-switcher button',
    'button.gds-mode-switch-button',
    'button[aria-label*="model" i]'
  ];

  const MODE_MENU_CONTAINER_SELECTORS = [
    '.cdk-overlay-container [role="menu"]',
    '.cdk-overlay-container [role="listbox"]',
    '.cdk-overlay-container .mat-mdc-menu-panel',
    'bard-mode-switcher [role="menu"]',
    'bard-mode-switcher .bard-mode-list',
    '.mat-mdc-menu-panel',
    '[role="menu"]',
    '[role="listbox"]',
    '.bard-mode-list'
  ];

  const MODE_MENU_ITEM_SELECTORS = [
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    'button.mat-mdc-menu-item',
    'button.bard-mode-item',
    '.bard-mode-list button'
  ];

  function textWithoutIcons(el) {
    if (!el) return '';
    let raw = '';
    if (typeof el.cloneNode === 'function') {
      const clone = el.cloneNode(true);
      if (clone && typeof clone.querySelectorAll === 'function') {
        for (const ignored of clone.querySelectorAll('mat-icon, svg, .mat-icon, [aria-hidden="true"], .cdk-visually-hidden')) {
          ignored.remove();
        }
      }
      raw = String(clone?.textContent || '');
    } else {
      raw = String(el.textContent || '');
    }
    return cleanText(raw)
      .replace(/\b(?:keyboard_arrow_down|arrow_drop_down|expand_more|check|check_circle)\b/gi, '')
      .trim();
  }

  function modelTrigger(root = document) {
    for (const selector of MODE_TRIGGER_SELECTORS) {
      const candidates = Array.from(root.querySelectorAll(selector));
      const el = candidates.find((node) => isVisible(node) && !isDisabledControl(node));
      if (el) return el;
    }
    return null;
  }

  function modelLabel(root = document) {
    for (const selector of MODE_TRIGGER_SELECTORS) {
      for (const el of root.querySelectorAll(selector)) {
        if (!isVisible(el)) continue;
        const text = textWithoutIcons(el);
        if (text && text.length <= 64) return text;
      }
    }
    return '';
  }

  function foldModelText(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\u0130I]/g, 'i')
      .replace(/\u0131/g, 'i')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function modelSlug(el, label) {
    const rawAttr =
      el?.getAttribute?.('data-mode-id') ||
      el?.getAttribute?.('data-value') ||
      el?.getAttribute?.('data-test-id') ||
      '';
    const strippedAttr = rawAttr
      .replace(/^bard-mode-option-/i, '')
      .replace(/^bard-mode-/i, '')
      .trim();
    const asciiFrom = (text) =>
      foldModelText(text)
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    const attrSlug = strippedAttr && !/^(?:item|option|menu|button|\d+)$/i.test(strippedAttr) ? asciiFrom(strippedAttr) : '';
    if (attrSlug) return attrSlug;
    const labelSlug = asciiFrom(label);
    if (labelSlug) return labelSlug;
    let hash = 2166136261;
    const source = String(label || rawAttr || 'model');
    for (let i = 0; i < source.length; i += 1) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `gem-${hash.toString(16)}`;
  }

  function bareModelKey(value) {
    return foldModelText(value)
      .replace(/[^\p{L}\p{N}.]/gu, '')
      .replace(/^gemini(?=\d|[a-z])/, '');
  }

  function modelsMatch(candidate, requested) {
    if (!candidate || !requested) return false;
    const cRaw = String(candidate).trim();
    const rRaw = String(requested).trim();
    if (!cRaw || !rRaw) return false;
    if (cRaw.toLowerCase() === rRaw.toLowerCase()) return true;
    const cBare = bareModelKey(cRaw);
    const rBare = bareModelKey(rRaw);
    return Boolean(cBare && rBare && cBare === rBare);
  }

  function visibleMenuContainers(root = document) {
    const containers = [];
    const seen = new Set();
    for (const selector of MODE_MENU_CONTAINER_SELECTORS) {
      for (const node of root.querySelectorAll(selector)) {
        if (seen.has(node) || !isVisible(node)) continue;
        seen.add(node);
        containers.push(node);
      }
    }
    return containers;
  }

  function readOpenMenuOptions(root = document) {
    const containers = visibleMenuContainers(root);
    if (!containers.length) return [];
    const triggerText = modelLabel(root);
    const options = [];
    const seenIds = new Set();
    for (const container of containers) {
      for (const selector of MODE_MENU_ITEM_SELECTORS) {
        for (const item of container.querySelectorAll(selector)) {
          if (!isVisible(item) || isDisabledControl(item)) continue;
          if ((item.tagName || '').toLowerCase() === 'a') continue;
          const testId = item.getAttribute('data-test-id') || '';
          if (/upgrade/i.test(testId) || item.closest?.('[data-test-id*="upgrade" i]')) continue;

          const titleEl = item.querySelector?.(
            '[data-test-id="mode-name"], .mode-title, .gds-label-l, .mdc-list-item__primary-text, .title-and-description > :first-child, strong, b'
          );
          const descEl = item.querySelector?.(
            '[data-test-id="mode-description"], .mode-description, .gds-body-s, .mdc-list-item__secondary-text, .subtitle, .description'
          );
          let label = titleEl ? textWithoutIcons(titleEl) : '';
          let description = descEl && descEl !== titleEl ? textWithoutIcons(descEl) : '';
          if (!label) {
            const full = textWithoutIcons(item);
            const lines = full.split('\n').map((part) => cleanText(part)).filter(Boolean);
            label = lines[0] || '';
            if (!description && lines.length > 1) description = lines.slice(1).join(' ');
          }
          label = cleanText(label).slice(0, 80);
          description = cleanText(description).slice(0, 160);
          if (!label || /^(?:upgrade|yükselt|get gemini advanced|learn more)$/i.test(label)) continue;

          let id = modelSlug(item, label);
          if (seenIds.has(id)) {
            let suffix = 2;
            while (seenIds.has(`${id}-${suffix}`)) suffix += 1;
            id = `${id}-${suffix}`;
          }
          seenIds.add(id);

          const selected =
            item.getAttribute('aria-checked') === 'true' ||
            item.getAttribute('aria-selected') === 'true' ||
            item.classList.contains('selected') ||
            item.classList.contains('is-selected') ||
            Boolean(triggerText && modelsMatch(label, triggerText));

          options.push({
            id,
            label,
            ...(description ? { description } : {}),
            selected,
            element: item
          });
          if (options.length >= 20) return options;
        }
      }
    }
    return options;
  }

  async function waitForCondition(check, stillCurrent = () => true, timeoutMs = 2_500, pollMs = 40) {
    const started = Date.now();
    while (stillCurrent()) {
      const value = check();
      if (value) return value;
      if (Date.now() - started >= timeoutMs) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return stillCurrent() ? check() : null;
  }

  async function openModelMenu(trigger, root = document, stillCurrent = () => true) {
    if (!trigger || !stillCurrent()) return null;
    const existing = readOpenMenuOptions(root);
    if (existing.length) return existing;
    try {
      trigger.click();
    } catch {
      return null;
    }
    return await waitForCondition(() => {
      const items = readOpenMenuOptions(root);
      return items.length ? items : null;
    }, stillCurrent, 2_500);
  }

  async function closeModelMenu(trigger, root = document, stillCurrent = () => true) {
    if (!visibleMenuContainers(root).length) return true;
    const target = root.activeElement || visibleMenuContainers(root)[0] || root;
    try {
      dispatchPageEvent(target, 'KeyboardEvent', 'keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    } catch { /* ignore key dispatch errors */ }
    if (await waitForCondition(() => visibleMenuContainers(root).length === 0, stillCurrent, 700)) return true;
    const backdrop = root.querySelector('.cdk-overlay-backdrop');
    if (backdrop && isVisible(backdrop)) {
      try { backdrop.click(); } catch { /* ignore */ }
      if (await waitForCondition(() => visibleMenuContainers(root).length === 0, stillCurrent, 700)) return true;
    }
    if (trigger && isVisible(trigger) && trigger.getAttribute('aria-expanded') === 'true') {
      try { trigger.click(); } catch { /* ignore */ }
      if (await waitForCondition(() => visibleMenuContainers(root).length === 0, stillCurrent, 700)) return true;
    }
    return visibleMenuContainers(root).length === 0;
  }

  async function inspectModels(root = document, stillCurrent = () => true) {
    const trigger = modelTrigger(root);
    if (!trigger) return { models: null, error: 'picker_unavailable' };
    const original = modelLabel(root);
    const items = await openModelMenu(trigger, root, stillCurrent);
    if (!items || !items.length) {
      await closeModelMenu(trigger, root, stillCurrent);
      return { models: null, error: 'picker_unavailable' };
    }
    const models = items.map(({ id, label, description }) => ({
      id,
      label,
      ...(description ? { description } : {})
    }));
    const closed = await closeModelMenu(trigger, root, stillCurrent);
    if (!closed) return { models: null, error: 'picker_close_failed' };
    const afterLabel = modelLabel(root);
    if (original && afterLabel && !modelsMatch(afterLabel, original)) {
      return { models: null, error: 'restore_failed' };
    }
    return { models };
  }

  async function selectModel(requestedModel, stillCurrent = () => true, root = document) {
    if (!requestedModel || !String(requestedModel).trim()) {
      return { ok: true, model: modelLabel(root) || null };
    }
    const target = String(requestedModel).trim();
    const before = modelLabel(root);
    if (before && modelsMatch(before, target)) {
      return { ok: true, model: before };
    }
    const trigger = modelTrigger(root);
    if (!trigger) return { ok: false, error: 'picker_unavailable' };
    const items = await openModelMenu(trigger, root, stillCurrent);
    if (!items || !items.length) {
      await closeModelMenu(trigger, root, stillCurrent);
      return { ok: false, error: 'picker_unavailable' };
    }
    const match =
      items.find((item) => item.id.toLowerCase() === target.toLowerCase()) ||
      items.find((item) => modelsMatch(item.label, target) || modelsMatch(item.id, target));
    if (!match) {
      await closeModelMenu(trigger, root, stillCurrent);
      return { ok: false, error: 'model_unconfirmed' };
    }
    try {
      match.element.click();
    } catch {
      await closeModelMenu(trigger, root, stillCurrent);
      return { ok: false, error: 'model_unconfirmed' };
    }
    const settled = await waitForCondition(() => {
      if (visibleMenuContainers(root).length > 0) return null;
      const now = modelLabel(root);
      if (!now || modelsMatch(now, match.label) || modelsMatch(now, target)) return now || match.label;
      return null;
    }, stillCurrent, 2_500);
    if (!settled) {
      await closeModelMenu(trigger, root, stillCurrent);
      const after = modelLabel(root);
      if (after && !modelsMatch(after, match.label) && !modelsMatch(after, target)) {
        return { ok: false, error: 'model_unconfirmed' };
      }
      if (visibleMenuContainers(root).length > 0) {
        return { ok: false, error: 'picker_close_failed' };
      }
    }
    return { ok: true, model: modelLabel(root) || match.label };
  }

  function errors(root = document) {
    const found = [];
    for (const el of root.querySelectorAll('[role="alert"], .error-message, model-response .error-container')) {
      if (!isVisible(el)) continue;
      const text = cleanText(el.textContent || '');
      if (text && !found.includes(text)) found.push(text.slice(0, 400));
    }
    return found;
  }

  function composer(root = document) {
    const selectors = [
      'rich-textarea div.ql-editor[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"][role="textbox"]',
      'div.ql-editor[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea[aria-label]',
      'textarea'
    ];
    for (const selector of selectors) {
      const matches = Array.from(root.querySelectorAll(selector));
      const candidate = matches.find((el) => isVisible(el));
      if (candidate) return candidate;
    }
    return null;
  }

  function readComposerText(el) {
    if (!el) return '';
    if (el.tagName && el.tagName.toLowerCase() === 'textarea') return String(el.value || '');
    return extractStructuredText(el);
  }

  function setNativeValue(el, value) {
    const proto = el.ownerDocument?.defaultView?.HTMLTextAreaElement?.prototype || globalThis.HTMLTextAreaElement?.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, value);
    else el.value = value;
  }

  function dispatchPageEvent(el, ctorName, type, init) {
    const win = el.ownerDocument?.defaultView || globalThis;
    const Ctor = win[ctorName] || globalThis[ctorName] || win.Event || globalThis.Event;
    try {
      return el.dispatchEvent(new Ctor(type, init));
    } catch {
      const FallbackEvent = win.Event || globalThis.Event;
      return el.dispatchEvent(new FallbackEvent(type, { bubbles: Boolean(init?.bubbles), cancelable: Boolean(init?.cancelable) }));
    }
  }

  function insertPrompt(text, root = document) {
    const el = composer(root);
    if (!el) return false;
    const promptText = String(text ?? '');
    try {
      if (typeof el.focus === 'function') el.focus();
    } catch { /* ignore focus errors in headless roots */ }

    if (el.tagName && el.tagName.toLowerCase() === 'textarea') {
      setNativeValue(el, promptText);
      dispatchPageEvent(el, 'Event', 'input', { bubbles: true });
      dispatchPageEvent(el, 'Event', 'change', { bubbles: true });
      return true;
    }

    const doc = el.ownerDocument || document;
    if (typeof el.replaceChildren === 'function') el.replaceChildren();
    else while (el.firstChild) el.removeChild(el.firstChild);
    const lines = promptText.split(/\r\n?|\n/);
    if (el.classList.contains('ql-editor') || el.closest?.('rich-textarea')) {
      for (const line of lines) {
        const p = doc.createElement('p');
        if (line) p.textContent = line;
        else p.appendChild(doc.createElement('br'));
        el.appendChild(p);
      }
    } else {
      el.textContent = promptText;
    }
    el.classList.remove('ql-blank');
    dispatchPageEvent(el, 'InputEvent', 'beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: promptText });
    dispatchPageEvent(el, 'InputEvent', 'input', { bubbles: true, inputType: 'insertText', data: promptText });
    dispatchPageEvent(el, 'Event', 'change', { bubbles: true });
    return cleanText(readComposerText(el)) === cleanText(promptText);
  }

  function sendButton(root = document) {
    const selectors = [
      'button.send-button',
      'button[data-test-id="send-button"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Gönder" i]'
    ];
    for (const selector of selectors) {
      for (const btn of root.querySelectorAll(selector)) {
        if (!isVisible(btn) || isDisabledControl(btn)) continue;
        const aria = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('mattooltip') || ''}`;
        if (STOP_ARIA_RE.test(aria) || btn.classList.contains('stop')) continue;
        const iconText = (btn.querySelector('mat-icon')?.textContent || '').trim().toLowerCase();
        if (iconText === 'stop' || iconText === 'stop_circle') continue;
        return btn;
      }
    }
    for (const btn of root.querySelectorAll('button')) {
      if (!isVisible(btn) || isDisabledControl(btn)) continue;
      const aria = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('mattooltip') || ''}`;
      if (SEND_ARIA_RE.test(aria) && !STOP_ARIA_RE.test(aria)) return btn;
    }
    return null;
  }

  function send(root = document) {
    const btn = sendButton(root);
    if (btn) {
      btn.click();
      return true;
    }
    const el = composer(root);
    if (!el || !cleanText(readComposerText(el))) return false;
    dispatchPageEvent(el, 'KeyboardEvent', 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
    return true;
  }

  function stopGeneration(root = document) {
    const btn = stopButton(root);
    if (!btn) return false;
    btn.click();
    return true;
  }

  function pageChecks(root = document) {
    return {
      composer: Boolean(composer(root)),
      sendButton: Boolean(sendButton(root)),
      stopButton: Boolean(stopButton(root)),
      modelMenu: Boolean(modelTrigger(root) || modelLabel(root)),
      generating: generating(root),
      turns: extractTurns(root).length
    };
  }

  function extractWorkerSpawnDirective(text) {
    if (typeof text !== 'string' || !text.includes('[[COS_SPAWN_WORKERS]]')) return null;
    SPAWN_BLOCK_RE.lastIndex = 0;
    const workers = [];
    let match;
    while ((match = SPAWN_BLOCK_RE.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.workers) ? parsed.workers : [];
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          const task = typeof item.task === 'string' ? item.task.trim() : '';
          if (!task) continue;
          const label = typeof item.label === 'string' ? item.label.trim().slice(0, 60) : '';
          const provider = item.provider === 'chatgpt' || item.provider === 'gemini' ? item.provider : undefined;
          const model = typeof item.model === 'string' && item.model.trim() ? item.model.trim().slice(0, 80) : undefined;
          workers.push({
            task: task.slice(0, 12000),
            ...(label ? { label } : {}),
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {})
          });
          if (workers.length >= 6) return workers;
        }
      } catch {
        /* ignore malformed block */
      }
    }
    return workers.length ? workers : null;
  }

  const api = {
    conversationFromUrl,
    conversationId,
    conversationTitle,
    extractTurns,
    generating,
    modelTrigger,
    modelLabel,
    inspectModels,
    selectModel,
    errors,
    composer,
    composerText: readComposerText,
    readComposerText,
    insertPrompt,
    messages: extractTurns,
    sendButton,
    send,
    stopButton,
    stopGeneration,
    pageChecks,
    extractWorkerSpawnDirective
  };

  globalThis.COS_GEMINI_DOM = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
