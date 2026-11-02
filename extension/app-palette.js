/*
 * The app's palette for this extension's own parts of the ChatGPT page (2026-11-02).
 *
 * The service worker stores the app's colors from every status (`appAppearance`, see popup.js); here
 * they become `--clf-app-*` variables for the light and the dark page, and overlay.css paints the
 * settings sheet, its switches and the stage card with them. The page's own theme picks the set, not
 * the app's: these parts sit on ChatGPT's surface. Without a stored value (never paired) the
 * stylesheet's defaults, the app's default palette, apply.
 */
(() => {
  const KEY = 'appAppearance';
  const ID = 'clf-app-palette';
  // Only `--name: #rrggbb` pairs reach the page; anything else in storage is dropped.
  const declarations = tokens => Object.entries(tokens)
    .filter(([name, value]) => /^--[a-z-]{2,30}$/.test(name) && /^#[0-9a-f]{6}$/i.test(String(value)))
    .map(([name, value]) => `--clf-app-${name.slice(2)}: ${value};`)
    .join(' ');
  function paint(value) {
    const valid = value && typeof value === 'object' && value.light && typeof value.light === 'object' &&
      value.dark && typeof value.dark === 'object';
    let node = document.getElementById(ID);
    if (!valid) {
      node?.remove();
      return;
    }
    // Doubled :root outranks the defaults in overlay.css whatever order the two stylesheets load in.
    const css = `:root:root[data-clf-theme='light'] { ${declarations(value.light)} }\n` +
      `:root:root[data-clf-theme='dark'] { ${declarations(value.dark)} }`;
    if (!node) {
      node = document.createElement('style');
      node.id = ID;
      (document.head || document.documentElement).append(node);
    }
    if (node.textContent !== css) node.textContent = css;
  }
  try {
    void Promise.resolve(chrome.storage.local.get(KEY)).then(stored => paint(stored?.[KEY])).catch(() => undefined);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes?.[KEY]) paint(changes[KEY].newValue);
    });
  } catch {
    // No storage here (an invalidated context after an update): the stylesheet's defaults stay.
  }
})();
