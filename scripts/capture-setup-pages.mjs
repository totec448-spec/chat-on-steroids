// Maintainer tool: captures the ChatGPT and OpenAI Platform pages that Setup shows, from a Chrome
// that is signed in to both, through its DevTools port. ChatGPT pages are captured in every app
// language (ChatGPT follows the browser language when its own setting is "Auto-detect"); the
// Platform pages, which are English, once.
//
//   node scripts/capture-setup-pages.mjs <cdp-url> <outDir> --private <words> [scene] [language]
//
// Nothing is submitted: dialogs are opened, filled with placeholders and closed with their tab.
// Before each screenshot the page's own names and ids are replaced with placeholders, and the
// capture is refused when anything from --private (comma-separated account names, e-mail parts,
// tunnel or workspace names) or an id pattern is still visible inside it. Writes
// <scene>-<language>.webp and manifest.json (labels and outlined places measured from the page);
// copy both into src/renderer/setup-images/pages/.
// The scene "signin" has no picture: it reads the "Log in" label from ChatGPT's signed-out page in a
// private context of the same browser, which is closed again afterwards.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const privateAt = args.indexOf('--private');
const privateWords = privateAt >= 0 ? args.splice(privateAt, 2)[1].split(',').map(word => word.trim()).filter(Boolean) : [];
const [cdp, out, onlyScene, onlyLanguage] = args;
if (!cdp || !out || !privateWords.length) {
  console.error('Usage: node scripts/capture-setup-pages.mjs <cdp-url> <outDir> --private <words> [scene] [language]');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const LANGS = { en: 'en-US', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', ja: 'ja-JP', ko: 'ko-KR', 'pt-BR': 'pt-BR', 'pt-PT': 'pt-PT',
  ru: 'ru-RU', tr: 'tr-TR', vi: 'vi-VN', 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW' };
const PLACEHOLDER = { tunnelId: 'tunnel_0123456789abcdef', tunnelName: 'Chat On Steroids', org: 'org-0123456789', user: 'user-0123456789',
  workspace: 'Your ChatGPT workspace', core: 'Chat On Steroids Core',
  coreDescription: 'Read and edit code and text files on this computer, and run commands in a real terminal.' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const manifestPath = path.join(out, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};

/** In-page helpers, installed once per document. */
const HELPERS = `window.__cos = window.__cos || (() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const text = e => (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim();
  const find = (selector, test, root = document) => [...root.querySelectorAll(selector)].find(e => visible(e) && test(e));
  const rect = e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
  const union = (...rs) => { const x0 = Math.min(...rs.map(r => r[0])), y0 = Math.min(...rs.map(r => r[1])),
    x1 = Math.max(...rs.map(r => r[0] + r[2])), y1 = Math.max(...rs.map(r => r[1] + r[3])); return [x0, y0, x1 - x0, y1 - y0]; };
  const setValue = (e, value) => {
    const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value);
    e.dispatchEvent(new Event(e instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  const press = e => { e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); e.click(); };
  // Replaces text in every text node and input under root; returns how many it changed.
  const replaceText = (root, pattern, replacement) => {
    let changed = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const next = node.nodeValue.replace(pattern, replacement);
      if (next !== node.nodeValue) { node.nodeValue = next; changed++; }
    }
    for (const field of root.querySelectorAll('input,textarea')) {
      const next = field.value.replace(pattern, replacement);
      if (next !== field.value) { field.value = next; changed++; }
    }
    return changed;
  };
  // All visible text inside a page rectangle, for the privacy check.
  const textIn = ([x, y, w, h]) => {
    const parts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement; if (!parent || !visible(parent) || !node.nodeValue.trim()) continue;
      const r = parent.getBoundingClientRect();
      if (!(r.right > x && r.left < x + w && r.bottom > y && r.top < y + h)) continue;
      // Text under a modal's overlay is not in the picture; what is painted on top is.
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || parent.contains(hit) || hit.contains(parent) || !document.querySelector('[role=dialog]')) parts.push(node.nodeValue);
    }
    for (const field of document.querySelectorAll('input,textarea')) {
      const r = field.getBoundingClientRect();
      if (visible(field) && r.right > x && r.left < x + w && r.bottom > y && r.top < y + h) parts.push(field.value, field.placeholder || '');
    }
    return parts.join(' | ');
  };
  // The page's Add button: the topmost labelled menu button in main ("More actions" are icon-only).
  const addButton = () => [...document.querySelectorAll('main button[aria-haspopup="menu"]')].filter(e => visible(e) && text(e))
    .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)[0];
  // Hides everything but the dialog, so no page text shows around its rounded corners.
  const isolate = dialog => { for (const child of document.body.children) if (!child.contains(dialog)) child.style.visibility = 'hidden';
    let node = dialog.parentElement; while (node && node !== document.body) { for (const sibling of node.children) if (!sibling.contains(dialog)) sibling.style.visibility = 'hidden'; node = node.parentElement; } };
  return { sleep, visible, text, find, rect, union, setValue, press, replaceText, textIn, addButton, isolate };
})(); true`;

/**
 * Each scene: where it opens, how its state is reached, and what it measures. `prepare` runs in the
 * page and returns { clip, spots: { key: rect }, labels: { key: text } } in page coordinates.
 */
const SCENES = {
  'plugin-add': { site: 'chatgpt', url: 'https://chatgpt.com/plugins', languages: Object.keys(LANGS), prepare: `(async () => {
    const { press, sleep, rect, union, text } = __cos;
    const trigger = __cos.addButton(); press(trigger); await sleep(1200);
    const items = [...document.querySelectorAll('[role=menuitem]')].filter(__cos.visible);
    if (items.length < 3) throw new Error('Add menu not found');
    const item = items[items.length - 1];
    const menu = item.closest('[role=menu]');
    // Only the button and its menu: no half-cut search field or settings icon at the edges.
    for (const node of document.querySelectorAll('main *')) if (!node.contains(trigger) && !trigger.contains(node)) node.style.visibility = 'hidden';
    return { clip: union(rect(trigger), rect(menu)), spots: { item: rect(item), add: rect(trigger) }, labels: { add: text(trigger), item: text(item) } };
  })()` },
  'plugin-new': { site: 'chatgpt', pad: 0, url: 'https://chatgpt.com/plugins', languages: Object.keys(LANGS), prepare: `(async () => {
    const { press, sleep, rect, union, text, setValue } = __cos;
    const trigger = __cos.addButton(); press(trigger); await sleep(1200);
    const items = [...document.querySelectorAll('[role=menuitem]')].filter(__cos.visible);
    items[items.length - 1].click(); await sleep(2500);
    const dialog = document.querySelector('[role=dialog]'); if (!dialog) throw new Error('dialog did not open');
    let name = null, description = null;
    for (let wait = 0; wait < 50 && !(name && description); wait++) {
      await sleep(100);
      name = [...dialog.querySelectorAll('input:not([type]), input[type=text]')].find(__cos.visible) || null;
      description = dialog.querySelector('textarea');
    }
    if (!name || !description) throw new Error('dialog fields did not appear: ' + dialog.innerText.slice(0, 120));
    setValue(name, ${JSON.stringify(PLACEHOLDER.core)}); setValue(description, ${JSON.stringify(PLACEHOLDER.coreDescription)});
    const group = dialog.querySelector('[role=group]');
    const [, tunnelMode] = group.querySelectorAll('button'); tunnelMode.click(); await sleep(1200);
    const tunnelInput = group.closest('fieldset').querySelector('input');
    // A real tunnel enables Create, as it would for the person; the picture then shows placeholders.
    const tunnelChips = () => [...group.closest('fieldset').querySelectorAll('div > button')].filter(b => b.parentElement !== group);
    for (let wait = 0; wait < 30 && !tunnelChips().length; wait++) await sleep(100);
    if (tunnelChips()[0]) { tunnelChips()[0].click(); await sleep(600); }
    const select = dialog.querySelector('select');
    setValue(select, 'NONE'); await sleep(600);
    const checkbox = dialog.querySelector('button[role=checkbox]');
    if (checkbox.getAttribute('aria-checked') !== 'true') checkbox.click();
    await sleep(800);
    // The account's own tunnels show as shortcut chips: keep one, named by the placeholder.
    tunnelChips().forEach((chip, index) => { if (index) chip.style.display = 'none'; else chip.textContent = ${JSON.stringify(PLACEHOLDER.tunnelName)}; });
    tunnelInput.value = ${JSON.stringify(PLACEHOLDER.tunnelId)};
    __cos.isolate(dialog);
    const submit = dialog.querySelector('button[type=submit]');
    const consent = checkbox.closest('label, div');
    const optionNone = [...select.options].find(o => o.value === 'NONE');
    return { clip: rect(dialog), spots: { name: rect(name), connection: union(rect(group), rect(tunnelInput)), auth: rect(select), create: union(rect(consent), rect(submit)) },
      labels: { title: text(dialog.querySelector('h2, [id*=title]') || dialog.firstElementChild), tunnel: text(tunnelMode), noAuth: optionNone.textContent.trim(),
        consent: ((checkbox.closest('label') || consent).innerText || '').split('\\n').map(line => line.trim()).filter(Boolean)[0], create: text(submit) } };
  })()` },
  'tunnel-create': { site: 'platform', pad: 0, url: 'https://platform.openai.com/settings/organization/tunnels', languages: ['en'], prepare: `(async () => {
    const { find, sleep, rect, text, setValue } = __cos;
    find('button', e => text(e) === 'Create tunnel').click(); await sleep(2000);
    const dialog = document.querySelector('[role=dialog]'); if (!dialog) throw new Error('dialog did not open');
    const name = dialog.querySelector('input'); const description = dialog.querySelector('textarea');
    setValue(name, 'Chat On Steroids'); setValue(description, 'Core connector for Chat On Steroids'); await sleep(500);
    __cos.replaceText(dialog, /org-[A-Za-z0-9]+/g, ${JSON.stringify(PLACEHOLDER.org)});
    const field = label => [...dialog.querySelectorAll('label')].find(l => text(l).startsWith(label)).parentElement.querySelector('[role=button]');
    const workspace = field('ChatGPT workspaces');
    const shown = workspace.querySelector('span span'); if (shown) shown.textContent = ${JSON.stringify(PLACEHOLDER.workspace)};
    const create = find('button', e => text(e) === 'Create', dialog);
    __cos.isolate(dialog);
    return { clip: rect(dialog), spots: { name: rect(name), workspace: rect(workspace), create: rect(create) }, labels: { create: text(create) } };
  })()` },
  'tunnel-id': { site: 'platform', url: 'https://platform.openai.com/settings/organization/tunnels', languages: ['en'], prepare: `(async () => {
    const { rect, union, text, sleep } = __cos;
    const rows = [...document.querySelectorAll('tbody tr, [role=row]')].filter(__cos.visible);
    const header = document.querySelector('thead tr') || rows[0];
    const row = rows.find(r => r !== header && /tunnel_/.test(r.innerText));
    if (!row) throw new Error('no tunnel row');
    for (const other of rows) if (other !== row && other !== header) other.style.display = 'none';
    const cells = [...row.children];
    const [nameCell, idCell] = cells;
    nameCell.querySelectorAll('*').forEach(e => { if (!e.childElementCount && text(e)) e.textContent = ${JSON.stringify(PLACEHOLDER.tunnelName)}; });
    __cos.replaceText(row, /tunnel_[a-z0-9]+(…|\\.\\.\\.)?/g, ${JSON.stringify(PLACEHOLDER.tunnelId)});
    await sleep(300);
    const copy = idCell.querySelector('button') || idCell;
    const headerCells = [...header.children];
    // Only Name and ID (with its copy button) belong in the picture: hide the columns after it.
    const copyCell = cells.find(cell => cell.contains(copy)) || idCell;
    const keep = cells.indexOf(copyCell);
    for (const line of [row, header]) [...line.children].forEach((cell, index) => { if (index > keep) cell.style.visibility = 'hidden'; });
    const copyBox = rect(copy);
    return { clip: union(rect(headerCells[0]), rect(idCell), rect(copyCell), [copyBox[0], copyBox[1], copyBox[2] + 16, copyBox[3]]), spots: { copy: copyBox }, labels: { name: text(headerCells[0]), id: text(headerCells[1]) } };
  })()` },
  'api-key-create': { site: 'platform', url: 'https://platform.openai.com/api-keys', languages: ['en'], prepare: `(async () => {
    const { find, sleep, rect, text, setValue } = __cos;
    find('button, a', e => /Create new secret key/.test(text(e))).click(); await sleep(2000);
    const dialog = document.querySelector('[role=dialog]'); if (!dialog) throw new Error('dialog did not open');
    setValue(dialog.querySelector('input'), 'Chat On Steroids');
    const restricted = find('button[role=radio]', e => text(e) === 'Restricted', dialog); restricted.click(); await sleep(800);
    const project = [...dialog.querySelectorAll('label')].find(l => text(l) === 'Project').parentElement.querySelector('[role=button]');
    const box = rect(dialog), segmented = rect(restricted.parentElement);
    __cos.isolate(dialog);
    return { clip: [box[0], box[1], box[2], segmented[1] + segmented[3] + 16 - box[1]], spots: { project: rect(project), restricted: rect(restricted) },
      labels: { restricted: text(restricted) } };
  })()` },
  'api-key-tunnels': { site: 'platform', url: 'https://platform.openai.com/api-keys', languages: ['en'], prepare: `(async () => {
    const { find, sleep, rect, union, text } = __cos;
    find('button, a', e => /Create new secret key/.test(text(e))).click(); await sleep(2000);
    const dialog = document.querySelector('[role=dialog]'); if (!dialog) throw new Error('dialog did not open');
    find('button[role=radio]', e => text(e) === 'Restricted', dialog).click(); await sleep(800);
    const label = [...dialog.querySelectorAll('span')].find(e => !e.children.length && text(e) === 'Tunnels');
    const row = label.closest('button'), trigger = row.nextElementSibling;
    trigger.scrollIntoView({ block: 'center' }); await sleep(500);
    __cos.press(trigger); await sleep(1200);
    const popover = document.getElementById(trigger.getAttribute('aria-controls'));
    const options = [...popover.querySelectorAll('[role=option]')];
    for (const option of options) {
      if (option.getAttribute('aria-selected') === 'true') continue;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) option.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, button: 0 }));
      option.click(); await sleep(500);
    }
    if (options.some(option => option.getAttribute('aria-selected') !== 'true')) throw new Error('Read and Use did not get selected');
    await sleep(600);
    const box = rect(dialog), at = rect(row), menu = rect(popover);
    const top = at[1] - 100, bottom = Math.max(menu[1] + menu[3], at[1] + at[3]) + 16;
    const right = Math.max(box[0] + box[2] - 8, menu[0] + menu[2] + 12);
    return { clip: [box[0] + 8, top, right - box[0] - 8, bottom - top], spots: { tunnels: union(rect(trigger), menu) },
      labels: { tunnels: text(label), read: text(options[0]), use: text(options[1]) } };
  })()` }
};

const ID_PATTERNS = [/tunnel_6[a-f0-9]{6,}/, /org-(?!0123456789)[A-Za-z0-9]{8,}/, /user-(?!0123456789)[A-Za-z0-9]{8,}/, /asdk_app_[a-f0-9]{8,}/, /@[a-z0-9.-]+\.[a-z]{2,}/i];

async function capture(sceneName, scene, language) {
  const locale = LANGS[language];
  const tab = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve));
  let n = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++n; const handle = message => { const data = JSON.parse(message.data); if (data.id !== id) return; ws.removeEventListener('message', handle); data.error ? reject(new Error(data.error.message)) : resolve(data.result); }; ws.addEventListener('message', handle); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  try {
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 2, mobile: false });
    await call('Emulation.setLocaleOverride', { locale });
    await call('Network.enable');
    await call('Network.setUserAgentOverride', { userAgent: (await call('Browser.getVersion')).userAgent, acceptLanguage: locale });
    await call('Page.navigate', { url: scene.url });
    await sleep(9000);
    await evaluate(HELPERS);
    const shot = await evaluate(scene.prepare);
    await sleep(500);
    const pad = scene.pad ?? 12;
    const clip = { x: Math.max(0, shot.clip[0] - pad), y: Math.max(0, shot.clip[1] - pad), width: shot.clip[2] + 2 * pad, height: shot.clip[3] + 2 * pad };
    const seen = await evaluate(`__cos.textIn(${JSON.stringify([clip.x, clip.y, clip.width, clip.height])})`);
    // Whole words only: "Maxim" must not match "Maximale" (German for maximum).
    const whole = word => new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
    const leak = privateWords.map(whole).find(pattern => pattern.test(seen)) || ID_PATTERNS.find(pattern => pattern.test(seen));
    if (leak) {
      const at = seen.search(leak);
      throw new Error(`private text inside the capture (${leak}); not saved. Context: …${seen.slice(Math.max(0, at - 60), at + 40)}…`);
    }
    const image = await call('Page.captureScreenshot', { format: 'webp', quality: 90, clip: { ...clip, scale: 1 } });
    const file = `${sceneName}-${language}.webp`;
    fs.writeFileSync(path.join(out, file), Buffer.from(image.data, 'base64'));
    const relative = r => [r[0] - clip.x, r[1] - clip.y, r[2], r[3]].map((v, i) => +(100 * v / (i % 2 ? clip.height : clip.width)).toFixed(1));
    (manifest[sceneName] ??= {})[language] = { file, size: [Math.round(clip.width), Math.round(clip.height)], labels: shot.labels,
      spots: Object.fromEntries(Object.entries(shot.spots).map(([key, r]) => [key, relative(r)])) };
    console.log(sceneName, language, JSON.stringify(shot.labels));
  } finally {
    ws.close();
    await fetch(`${cdp}/json/close/${tab.id}`);
  }
}

/**
 * ChatGPT's signed-out page, in a private context of the same browser: only its "Log in" label,
 * which Setup's sign-in steps quote. No picture: those steps show the app's and the browser's
 * own windows around the page.
 */
async function signedOutLabels(language) {
  const locale = LANGS[language];
  const version = await (await fetch(`${cdp}/json/version`)).json();
  const browser = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise(resolve => browser.addEventListener('open', resolve));
  let n = 0;
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++n; const handle = message => { const data = JSON.parse(message.data); if (data.id !== id) return; browser.removeEventListener('message', handle); data.error ? reject(new Error(data.error.message)) : resolve(data.result); }; browser.addEventListener('message', handle); browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { browserContextId } = await call('Target.createBrowserContext');
  try {
    const { targetId } = await call('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    await call('Emulation.setLocaleOverride', { locale }, sessionId);
    await call('Network.enable', {}, sessionId);
    await call('Network.setUserAgentOverride', { userAgent: version['User-Agent'], acceptLanguage: locale }, sessionId);
    await call('Page.navigate', { url: 'https://chatgpt.com/' }, sessionId);
    await sleep(9000);
    // The page's top-right pair is Log in, then Sign up.
    const result = await call('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const top = [...document.querySelectorAll('button, a')].filter(node => node.getClientRects().length && node.getBoundingClientRect().y < 80 && node.innerText.trim())
        .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
      return top.length >= 2 ? top.at(-2).innerText.trim() : null; })()` }, sessionId);
    const login = result.result?.value;
    if (!login) throw new Error('Log in button not found on the signed-out page');
    (manifest.signin ??= {})[language] = { labels: { login } };
    console.log('signin', language, JSON.stringify({ login }));
  } finally {
    await call('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    browser.close();
  }
}

if (!onlyScene || onlyScene === 'signin') {
  for (const language of Object.keys(LANGS)) {
    if (onlyLanguage && language !== onlyLanguage) continue;
    try { await signedOutLabels(language); } catch (error) { console.log('FAIL', 'signin', language, error.message); }
    await sleep(4000);
  }
}
for (const [sceneName, scene] of Object.entries(SCENES)) {
  if (onlyScene && sceneName !== onlyScene) continue;
  for (const language of scene.languages) {
    if (onlyLanguage && language !== onlyLanguage) continue;
    try { await capture(sceneName, scene, language); }
    catch (error) { console.log('FAIL', sceneName, language, error.message); }
    // ChatGPT throttles busy accounts: one page every few seconds is plenty.
    if (scene.site === 'chatgpt') await sleep(8000);
  }
}
// One line per scene and language: generated data, readable in a diff.
fs.writeFileSync(manifestPath, '{\n' + Object.entries(manifest).map(([scene, languages]) => `  ${JSON.stringify(scene)}: {\n` +
  Object.entries(languages).map(([language, entry]) => `    ${JSON.stringify(language)}: ${JSON.stringify(entry)}`).join(',\n') + '\n  }').join(',\n') + '\n}\n');
process.exit(0);
