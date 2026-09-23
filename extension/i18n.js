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

  function t(key, fallback, substitutions) {
    const safeFallback = applyFallback(fallback ?? key, substitutions);
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
      const language = chrome?.i18n?.getUILanguage?.();
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

  const api = Object.freeze({ t, localizeDocument });
  scope.CLF_I18N = api;
  scope.CosI18n = api;
})();
