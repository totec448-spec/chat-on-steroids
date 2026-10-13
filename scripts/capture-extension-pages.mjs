// Maintainer tool, run on Windows with Chrome, Edge and Brave installed: captures each browser's
// extensions page in every app language for Setup's first step (src/renderer/extension-pictures.ts).
//
//   node scripts/capture-extension-pages.mjs <outDir> [chrome|edge|brave] [language]
//
// Each browser runs headless in a throwaway profile with --lang, so its page is in that language.
// The script crops two places (the Developer mode switch, and Load unpacked after switching it on),
// measures where they are on the page, records the browser's own label for them, and writes
// <browser>-<language>-{dev,load}.webp plus manifest.json. Copy both into
// src/renderer/setup-images/extensions/. Run it when a browser changes its extensions page.
import { spawn, spawnSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path';
// Over SSH, every browser start fails a Windows sign-in for the account (no stored credential in
// that logon). Thirteen languages pass Windows' lockout threshold, and a locked-out account then
// breaks SSH and auto sign-in for ten minutes (VM 141, 2026-10-12). Run it in the desktop session.
if (process.env.SSH_CONNECTION && !process.argv.includes('--allow-ssh')) {
  console.error('Run this in the Windows desktop session (or a scheduled task there), not over SSH: each browser start over SSH fails a Windows sign-in and locks the account.');
  process.exit(2);
}
const out = process.argv[2]; const only = process.argv[3]; fs.mkdirSync(out, { recursive: true });
const ONLY_LANG = process.argv[4];
const LANGS = { en: 'en-US', de: 'de', es: 'es', fr: 'fr', ja: 'ja', ko: 'ko', 'pt-BR': 'pt-BR', 'pt-PT': 'pt-PT', ru: 'ru', tr: 'tr', vi: 'vi', 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW' };
const BROWSERS = {
  chrome: { exe: `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`, scheme: 'chrome', width: 1000 },
  edge: { exe: `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`, scheme: 'edge', width: 1400 },
  brave: { exe: [`${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${process.env.ProgramFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`].find(p => fs.existsSync(p)), scheme: 'brave', width: 1000 }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOG = (...a) => fs.appendFileSync(path.join(out, 'log.txt'), new Date().toISOString().slice(11,19) + ' ' + a.join(' ') + '\n');
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('timeout: ' + what)), ms))]);
const manifestPath = path.join(out, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
let port = 9300 + Math.floor(Math.random() * 500) * 2;
// Finds an element through shadow roots; returns its box and label.
const FIND = `(sel)=>{ const walk=r=>{ for (const e of r.querySelectorAll('*')) { if (sel(e)) return e; if (e.shadowRoot) { const f=walk(e.shadowRoot); if (f) return f; } } }; return walk(document); }`;
const box = e => `(()=>{ const r=(${e}).getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; })()`;
for (const [name, b] of Object.entries(BROWSERS)) {
  if (only && name !== only) continue;
  if (!b.exe) { console.log(`skip ${name}: not installed`); continue; }
  for (const [lang, flag] of Object.entries(LANGS)) {
    if (ONLY_LANG && lang !== ONLY_LANG) continue;
    LOG('start', name, lang);
    const profile = `C:\\cos-test\\shot-${name}-${lang}`; fs.rmSync(profile, { recursive: true, force: true });
    const p = ++port;
    const child = spawn(b.exe, [`--remote-debugging-port=${p}`, `--user-data-dir=${profile}`, `--lang=${flag}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-dark-mode', 'about:blank'], { stdio: 'ignore' });
    try {
      let ws; for (let i = 0; i < 80 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${p}/json/list`)).json(); const t = l.find(x => x.type === 'page'); if (t) ws = new WebSocket(t.webSocketDebuggerUrl); } catch {} await sleep(250); }
      LOG('ws', !!ws); if (ws.readyState !== 1) await withTimeout(new Promise(r => ws.addEventListener('open', r)), 10000, 'ws open');
      let n = 0; const call = (method, params = {}) => withTimeout(new Promise(r => { const i = ++n; const h = m => { const d = JSON.parse(m.data); if (d.id === i) { ws.removeEventListener('message', h); r(d.result ?? d); } }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id: i, method, params })); }), 20000, method);
      const ev = async e => (await call('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
      await call('Emulation.setDeviceMetricsOverride', { width: b.width, height: 760, deviceScaleFactor: 2, mobile: false });
      await call('Page.navigate', { url: `${b.scheme}://extensions/` }); await sleep(3000);
      const find = name === 'edge'
        ? { toggle: `(${FIND})(e=>e.id==='dev-switch')`, label: `(${FIND})(e=>e.tagName==='FLUENT-LABEL' && /dev-switch/.test(e.getAttribute('for')||'') ) || (${FIND})(e=>e.tagName==='FLUENT-LABEL')` }
        : { toggle: `(${FIND})(e=>e.id==='devMode')`, label: `(${FIND})(e=>e.id==='devModeLabel')` };
      LOG('url', await ev('location.href'), 'title', await ev('document.title'));
      const devToggle = await ev(box(find.toggle)); const devLabelBox = await ev(box(find.label));
      LOG('dev', JSON.stringify(devToggle), JSON.stringify(devLabelBox));
      const devLabel = await ev(`((${find.label}).innerText||'').trim()`);
      const crop = (boxes, pad, minWidth, clamp) => { let x0 = Math.min(...boxes.map(q => q[0])) - pad[3], y0 = Math.min(...boxes.map(q => q[1])) - pad[0], x1 = Math.max(...boxes.map(q => q[0] + q[2])) + pad[1], y1 = Math.max(...boxes.map(q => q[1] + q[3])) + pad[2]; if (x1 - x0 < minWidth) x0 = Math.max(clamp.x0, x1 - minWidth); x0 = Math.max(clamp.x0, x0); y0 = Math.max(0, y0); x1 = Math.min(clamp.x1, x1); return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) }; };
      const rel = (q, c) => [q[0] - c.x, q[1] - c.y, q[2], q[3]].map((v, i) => +(100 * v / (i % 2 === 0 ? c.width : c.height)).toFixed(1));
      const union = qs => { const x0 = Math.min(...qs.map(q => q[0])), y0 = Math.min(...qs.map(q => q[1])), x1 = Math.max(...qs.map(q => q[0] + q[2])), y1 = Math.max(...qs.map(q => q[1] + q[3])); return [x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12]; };
      const shoot = async (file, clip) => { const s = await call('Page.captureScreenshot', { format: 'webp', quality: 88, clip: { ...clip, scale: 1 } }); fs.writeFileSync(path.join(out, file), Buffer.from(s.data, 'base64')); };
      const devTarget = union([devToggle, devLabelBox]);
      const devCrop = name === 'edge' ? crop([devTarget], [30, 46, 30, 34], 360, { x0: 0, x1: b.width }) : crop([devTarget], [24, 18, 30, 210], 440, { x0: 0, x1: b.width });
      await shoot(`${name}-${lang}-dev.webp`, devCrop);
      // Switch it on the way the page itself does, then find Load unpacked.
      const loadEl = name === 'edge' ? `(${FIND})(e=>/BUTTON/.test(e.tagName) && !!(e.innerText||e.textContent||'').trim() && e.getBoundingClientRect().width>0 && e.getBoundingClientRect().y < 160 && e.getBoundingClientRect().x > 500)` : `(${FIND})(e=>e.id==='loadUnpacked')`;
      // A real mouse click, the way a person switches it: Brave ignores a scripted click(). The button
      // appears only once Developer mode is on, so wait for it to have a size, clicking again if needed.
      const clickToggle = async () => {
        const [x, y, w, h] = await ev(box(find.toggle));
        for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x: x + w / 2, y: y + h / 2, button: 'left', clickCount: 1 });
      };
      await clickToggle();
      let loadBox = [0, 0, 0, 0];
      for (let wait = 0; wait < 30 && !(loadBox?.[2] > 0); wait++) {
        await sleep(200);
        loadBox = await ev(box(loadEl));
        if (wait === 15 && !(loadBox?.[2] > 0)) await clickToggle();
      }
      if (!(loadBox?.[2] > 0)) throw new Error('Load unpacked did not appear after turning on Developer mode');
      const loadLabel = await ev(`((${loadEl}).innerText||(${loadEl}).textContent||'').trim()`);
      LOG('load', JSON.stringify(loadBox), JSON.stringify(loadLabel));
      // The whole row the button sits in, with complete neighbours, so nothing is cut at the edges.
      const rowBoxes = await ev(`(()=>{ const all=[]; const walk=r=>{ for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; walk(document); const load=(${loadEl}).getBoundingClientRect(); const near=all.filter(e=>{ const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && Math.abs((r.y+r.height/2)-(load.y+load.height/2))<14 && r.height<60 && (/BUTTON/.test(e.tagName) || (e.childElementCount===0 && (e.textContent||'').trim().length>2)); }); return near.map(e=>{const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height];}); })()`);
      const loadCrop = name === 'edge'
        // Edge puts a "Developer options" heading far to the left of its buttons: leave it out,
        // so the picture stays narrow enough to read at the size Setup shows it.
        ? crop([loadBox, ...rowBoxes.filter(q => q[0] >= loadBox[0] - 8)], [22, 22, 22, 22], 480, { x0: 360, x1: b.width })
        : crop([loadBox, ...rowBoxes, [loadBox[0], 0, 1, 1]], [0, 22, 20, 24], 560, { x0: 0, x1: b.width });
      await shoot(`${name}-${lang}-load.webp`, loadCrop);
      (manifest[name] ??= {})[lang] = {
        locale: await ev('navigator.language'),
        dev: { file: `${name}-${lang}-dev.webp`, label: devLabel, box: rel(devTarget, devCrop), size: [devCrop.width, devCrop.height] },
        load: { file: `${name}-${lang}-load.webp`, label: loadLabel, box: rel(union([loadBox]), loadCrop), size: [loadCrop.width, loadCrop.height] }
      };
      console.log(name, lang, manifest[name][lang].locale, JSON.stringify(devLabel), JSON.stringify(loadLabel));
    } catch (error) { console.log('FAIL', name, lang, error.message); LOG('FAIL', name, lang, error.message); }
    finally { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); await sleep(600); }
  }
}
// One line per browser and language: generated data, readable in a diff.
fs.writeFileSync(manifestPath, '{\n' + Object.entries(manifest).map(([browser, langs]) => `  ${JSON.stringify(browser)}: {\n` +
  Object.entries(langs).map(([lang, entry]) => `    ${JSON.stringify(lang)}: ${JSON.stringify(entry)}`).join(',\n') + '\n  }').join(',\n') + '\n}\n');
process.exit(0);
