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
  // Once per page: the manifest, a recovered tab and a recorder repair may all load this script, and
  // each run would add one more storage listener (CodeRabbit on #2038).
  if (globalThis.__clfAppPaletteLoaded) return;
  globalThis.__clfAppPaletteLoaded = true;
  const KEY = 'appAppearance';
  const ID = 'clf-app-palette';
  // Every color the app sends, as in popup.js. A palette missing one, or holding anything but
  // `#rrggbb`, keeps the stylesheet's defaults whole; nothing else from storage reaches the page.
  const APP_TOKENS = ['--page', '--card', '--ink', '--soft', '--faint', '--line', '--edge', '--hover', '--track',
    '--accent', '--accent-wash', '--accent-fill', '--on-accent', '--knob-off', '--knob-on', '--green', '--green-wash',
    '--red', '--red-wash'];
  const complete = tokens => Boolean(tokens) && typeof tokens === 'object' &&
    APP_TOKENS.every(name => /^#[0-9a-f]{6}$/i.test(String(tokens[name])));
  const declarations = tokens => APP_TOKENS.map(name => `--clf-app-${name.slice(2)}: ${tokens[name]};`).join(' ');
  function paint(value) {
    const valid = value && typeof value === 'object' && complete(value.light) && complete(value.dark);
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
    // A change that arrives while the first read is pending is newer than what that read returns.
    let changedDuringRead = false;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes?.[KEY]) return;
      changedDuringRead = true;
      paint(changes[KEY].newValue);
    });
    void Promise.resolve(chrome.storage.local.get(KEY))
      .then(stored => { if (!changedDuringRead) paint(stored?.[KEY]); }).catch(() => undefined);
  } catch {
    // No storage here (an invalidated context after an update): the stylesheet's defaults stay.
  }
})();
