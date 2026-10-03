(() => {
  const scope = globalThis;
  if (scope.CLF_I18N) {
    if (!scope.CosI18n) scope.CosI18n = scope.CLF_I18N;
    return;
  }

  function normalizeSubstitutions(substitutions) {
    if (substitutions === undefined || substitutions === null) return [];
    return (Array.isArray(substitutions) ? substitutions : [substitutions]).map((value) => String(value));
  }

  function applyFallback(fallback, substitutions) {
    const values = normalizeSubstitutions(substitutions);
    return String(fallback ?? '').replace(/\$\$|\$([1-9])/g, (token, index) => {
      if (token === '$$') return '$';
      const value = values[Number(index) - 1];
      return value === undefined ? token : value;
    });
  }

  /**
   * The app's interface language, not Chrome's.
   *
   * `chrome.i18n` always answers in the browser's own language, so an app set to English showed
   * a German extension on a German Chrome. The app hands its language over (`appLanguage`, from
   * its /status reply) and this loads that catalog itself. Until it is loaded, or when the app has
   * not said, `chrome.i18n` answers as before.
   */
  const LANGUAGE_KEY = 'appLanguage';
  const FOLDERS = Object.freeze({ en: 'en', de: 'de', es: 'es', fr: 'fr', 'pt-BR': 'pt_BR', 'pt-PT': 'pt_PT', ru: 'ru',
    tr: 'tr', vi: 'vi', ja: 'ja', ko: 'ko', 'zh-CN': 'zh_CN', 'zh-TW': 'zh_TW' });
  let catalog = null;
  let catalogLanguage = null;
  const extensionPage = (() => { try { return location.protocol === 'chrome-extension:'; } catch { return true; } })();

  async function readCatalog(folder) {
    const response = await fetch(chrome.runtime.getURL(`_locales/${folder}/messages.json`));
    if (!response.ok) throw new Error(`no catalog for ${folder}`);
    return response.json();
  }

  /** Extension pages read their own files; a content script asks the service worker for them. */
  async function loadCatalog(language) {
    const folder = FOLDERS[language];
    if (!folder) return null;
    if (!extensionPage) {
      const reply = await chrome.runtime.sendMessage({ type: 'i18n_catalog', language });
      return reply && reply.ok === true && reply.messages && typeof reply.messages === 'object' ? reply.messages : null;
    }
    // A language this extension has no catalog for yet reads as English, the app's own fallback,
    // rather than as whatever Chrome happens to be set to.
    try { return await readCatalog(folder); } catch { return folder === 'en' ? null : readCatalog('en').catch(() => null); }
  }

  async function useLanguage(language) {
    if (typeof language !== 'string' || !FOLDERS[language]) return;
    const next = await loadCatalog(language).catch(() => null);
    if (!next) return;
    catalog = next;
    catalogLanguage = language;
    try { scope.dispatchEvent?.(new CustomEvent('clf-i18n-changed', { detail: { language } })); } catch { /* No listeners here. */ }
  }

  const ready = (async () => {
    try {
      const stored = await chrome.storage.local.get(LANGUAGE_KEY);
      await useLanguage(stored?.[LANGUAGE_KEY]);
    } catch {
      // No storage or no catalog: chrome.i18n stays the source, as before.
    }
  })();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes?.[LANGUAGE_KEY]) void useLanguage(changes[LANGUAGE_KEY].newValue);
    });
  } catch {
    // Contexts without storage events keep the language they started with.
  }

  /** Chrome's message format: named $placeholders$ resolve to $1…$9, and $$ is a literal $. */
  function formatEntry(entry, values) {
    const placeholders = {};
    for (const [name, value] of Object.entries(entry.placeholders || {})) placeholders[name.toLowerCase()] = value;
    const named = String(entry.message).replace(/\$([A-Za-z0-9_@]+)\$/g, (token, name) => {
      const placeholder = placeholders[name.toLowerCase()];
      return placeholder ? String(placeholder.content ?? '') : token;
    });
    return named.replace(/\$\$|\$([1-9])/g, (token, index) => token === '$$' ? '$' : (values[Number(index) - 1] ?? ''));
  }

  function t(key, fallback, substitutions) {
    const safeFallback = applyFallback(fallback ?? key, substitutions);
    const entry = catalog && Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : null;
    if (entry && typeof entry.message === 'string' && entry.message) {
      try { return formatEntry(entry, normalizeSubstitutions(substitutions)); } catch { /* Fall through to chrome.i18n. */ }
    }
    try {
      const values = normalizeSubstitutions(substitutions);
      const translated = chrome?.i18n?.getMessage?.(
        key,
        values.length === 0 ? undefined : values.length === 1 ? values[0] : values
      );
      return typeof translated === 'string' && translated.length > 0 ? translated : safeFallback;
    } catch {
      return safeFallback;
    }
  }

  function localizeAttribute(node, dataName, attribute) {
    const key = node.dataset?.[dataName];
    if (!key) return;
    const fallback = node.getAttribute(attribute) || '';
    node.setAttribute(attribute, t(key, fallback));
  }

  function localizeDocument(doc = document) {
    try {
      const language = catalogLanguage || chrome?.i18n?.getUILanguage?.();
      if (language) doc.documentElement.lang = language.replace('_', '-');
    } catch {
      // The document's English markup remains the fallback when the i18n API is unavailable.
    }

    for (const node of doc.querySelectorAll('[data-i18n]')) {
      const key = node.dataset.i18n;
      if (key) node.textContent = t(key, node.textContent || '');
    }
    for (const node of doc.querySelectorAll('[data-i18n-title]')) {
      localizeAttribute(node, 'i18nTitle', 'title');
    }
    for (const node of doc.querySelectorAll('[data-i18n-aria-label]')) {
      localizeAttribute(node, 'i18nAriaLabel', 'aria-label');
    }
  }

  /** Serves a catalog to a content script, which cannot read extension files itself. */
  async function catalogFor(language) {
    return loadCatalog(language);
  }

  const api = Object.freeze({ t, localizeDocument, ready, catalogFor, language: () => catalogLanguage });
  scope.CLF_I18N = api;
  scope.CosI18n = api;
})();
