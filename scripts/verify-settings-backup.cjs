// Real renderer with synthetic data only. Never connects to the installed app or ChatGPT.
// Settings backup: the Backup rows in Settings → General, and the Export and Import dialogs. Each
// dialog fits the window, its fields, switch row and buttons share one left and right edge, no
// text is cut, and the buttons stay on one line, in every language, narrow and zoomed too.
const { withoutScripts } = require('./ui-check-page.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const root = path.join(__dirname, '..'), output = path.join(root, 'outputs/settings-backup');
  fs.mkdirSync(output, { recursive: true });
  const code = (await require('esbuild').build({ stdin: { contents: `
      export { initSettingsBackup } from './src/renderer/settings-backup-dialog.ts';
      export { setLanguage, initLanguage } from './src/renderer/i18n.ts';`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'backup', logLevel: 'error', loader: { '.css': 'empty' } })).outputFiles[0].text;
  const font = (name) => 'data:font/woff2;base64,' + fs.readFileSync(path.join(root, 'node_modules/@phosphor-icons/web/src', name)).toString('base64');
  const icons = fs.readFileSync(path.join(root, 'src/renderer/icons.css'), 'utf8')
    .replace("url('@phosphor-icons/web/regular/Phosphor.woff2')", `url('${font('regular/Phosphor.woff2')}')`)
    .replace("url('@phosphor-icons/web/fill/Phosphor-Fill.woff2')", `url('${font('fill/Phosphor-Fill.woff2')}')`);
  // Every stylesheet the window links, in its order; a missing one hides real layout (the
  // disclosure chevron is drawn by settings.css).
  const linked = [...fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8').matchAll(/<link rel="stylesheet" href="\.\/([^"]+)"/g)].map(match => match[1]);
  const css = linked.map(name => name === 'icons.css' ? icons : fs.readFileSync(path.join(root, 'src/renderer', name), 'utf8')).join('\n');
  const html = withoutScripts(fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')).replace(/<link\b[^>]*>/g, '')
    .replace('</head>', `<style>${css}</style></head>`);
  const win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.webContents.on('console-message', (_e, _l, message) => { if (/error|Error/.test(message)) console.error('renderer:', message); });
  await win.webContents.executeJavaScript(code);
  await win.webContents.executeJavaScript(`(()=>{
    backup.initLanguage();
    const ok = data => Promise.resolve({ ok: true, data });
    window.fixtureChoice = { token: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff', file: 'chat-on-steroids-settings-2026-10-23.json', appVersion: '2.1.46',
      exportedAt: '2026-10-23T08:00:00.000Z', keyCount: 3,
      changed: ['capabilities.command', 'capabilities.edit', 'readOnly', 'ui.appearance.dark.accent', 'ui.theme', 'goal.model', 'multiAgent.maxWorkers',
        'sessions.retainDays', 'compaction.autoTokens', 'ui.enterSends', 'ui.followOutput', 'ui.turnNotifications'],
      wider: ['capabilities.command', 'capabilities.edit', 'readOnly'] };
    backup.initSettingsBackup({ exportSettings: () => ok(null), pickSettingsBackup: () => ok(window.fixtureChoice),
      importSettingsBackup: () => ok({ state: {}, changedCount: 12, keyCount: 3 }) }, { imported: () => {}, toast: () => {} });
    // The General page with the Backup section in view, as in the app.
    document.querySelector('.app')?.setAttribute('data-screen', 'settings');
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('is-active', p.dataset.panel === 'general'));
    return true; })()`);
  const measureDialog = (id) => `(()=>{
    const d = document.getElementById(${JSON.stringify(id)}); const r = d.getBoundingClientRect();
    const body = d.querySelector('.plugin-dialog-body'); const b = body.getBoundingClientRect();
    const padL = parseFloat(getComputedStyle(body).paddingLeft), padR = parseFloat(getComputedStyle(body).paddingRight);
    const shown = el => el && !el.closest('[hidden]') && el.getClientRects().length > 0;
    // The button bar is full-bleed by design (its line spans the dialog); its last button is what aligns.
    const blocks = [...body.querySelectorAll(':scope > p, :scope > label, :scope > div > label, :scope > details > summary')].filter(shown);
    const lastButton = [...body.querySelectorAll('.pet-delete-actions .btn')].filter(shown).pop();
    // A box (the access warning, a disclosure's summary) aligns by its own edge; text by its first letter.
    const textLeft = el => { if (el.matches('.backup-wider, summary')) return el.getBoundingClientRect().left;
      const first = el.querySelector('b, span') ?? el; const r = document.createRange(); r.selectNodeContents(first); return r.getBoundingClientRect().left; };
    const lefts = blocks.map(el => Math.round(textLeft(el) - b.left - padL));
    const rights = [...blocks.filter(el => !el.matches('p, summary')), lastButton].filter(Boolean).map(el => Math.round(b.right - padR - el.getBoundingClientRect().right));
    const texts = [...d.querySelectorAll('b, em, span, small, button, h2, p')].filter(shown);
    const cut = texts.filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible').map(el => el.textContent.slice(0, 40));
    const buttons = [...d.querySelectorAll('.pet-delete-actions .btn')].filter(shown);
    const wrapped = buttons.filter(btn => btn.getBoundingClientRect().height > parseFloat(getComputedStyle(btn).lineHeight || '20') * 1.9 + 24).map(btn => btn.textContent);
    const tops = new Set(buttons.map(btn => Math.round(btn.getBoundingClientRect().top)));
    return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
      lefts: [...new Set(lefts)], rights: [...new Set(rights)], cut, wrapped, oneRow: tops.size <= 1,
      box: { x: Math.max(0, Math.floor(r.left) - 12), y: Math.max(0, Math.floor(r.top) - 12), width: Math.min(innerWidth, Math.ceil(r.width) + 24), height: Math.min(innerHeight, Math.ceil(r.height) + 24) } }; })()`;
  const rows = `(()=>{
    const s = document.getElementById('backupSettings'); s.scrollIntoView({ block: 'center' });
    const r = s.getBoundingClientRect();
    const buttons = [...s.querySelectorAll('.setting .btn')];
    return { cut: [...s.querySelectorAll('b, em, .btn, h2, p')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent.slice(0, 40)),
      buttonsOneLine: buttons.every(b => b.getBoundingClientRect().height < 44), sameRight: new Set(buttons.map(b => Math.round(b.getBoundingClientRect().right))).size === 1,
      box: { x: Math.max(0, Math.floor(r.left) - 16), y: Math.max(0, Math.floor(r.top) - 16), width: Math.min(innerWidth - Math.max(0, Math.floor(r.left) - 16), Math.ceil(r.width) + 32), height: Math.ceil(r.height) + 32 } }; })()`;
  const results = [];
  const languages = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
  for (const language of languages) {
    for (const [width, height, zoom] of language === 'en' || language === 'de' || language === 'ru' ? [[1100, 760, 1], [720, 600, 1], [1100, 760, 1.5]] : [[1100, 760, 1]]) {
      win.setContentSize(width, height); win.webContents.setZoomFactor(zoom);
      await new Promise(r => setTimeout(r, 120));
      const tag = `${language}-${width}${zoom === 1 ? '' : '-zoom'}`;
      await win.webContents.executeJavaScript(`backup.setLanguage(${JSON.stringify(language)}); document.querySelectorAll('dialog[open]').forEach(d => d.close()); true`);
      const settings = await win.webContents.executeJavaScript(rows);
      assert.deepEqual(settings.cut, [], 'Backup rows: nothing cut ' + tag);
      assert.ok(settings.buttonsOneLine && settings.sameRight, 'Backup rows: buttons on one line, one right edge ' + tag + JSON.stringify(settings));
      if (zoom === 1 && width === 1100) fs.writeFileSync(path.join(output, `rows-${language}.png`), (await win.webContents.capturePage(settings.box)).toPNG());
      // Export, with the keys and passphrase fields open (its tallest state).
      await win.webContents.executeJavaScript(`(()=>{ document.getElementById('exportSettings').click(); const k = document.getElementById('exportSettingsKeys'); k.checked = true; k.dispatchEvent(new Event('change')); return true; })()`);
      await new Promise(r => setTimeout(r, 80));
      const exp = await win.webContents.executeJavaScript(measureDialog('exportSettingsDialog'));
      results.push({ tag, dialog: 'export', ...exp });
      assert.ok(exp.inside, 'export dialog inside the window ' + tag);
      assert.equal(exp.lefts.length, 1, 'export: one left edge ' + tag + JSON.stringify(exp.lefts));
      assert.ok(exp.rights.length <= 1, 'export: one right edge ' + tag + JSON.stringify(exp.rights));
      assert.deepEqual(exp.cut, [], 'export: nothing cut ' + tag);
      assert.ok(exp.oneRow && !exp.wrapped.length, 'export: buttons on one row ' + tag);
      // Every quiet line (a switch's description, a field's hint) has one colour and size.
      const quiet = await win.webContents.executeJavaScript(`[...new Set([...document.querySelectorAll('#exportSettingsDialog small, #exportSettingsDialog .setting-text em')]
        .filter(n => n.offsetParent).map(n => { const c = getComputedStyle(n); return c.color + ' ' + c.fontSize + ' ' + c.fontWeight; }))]`);
      assert.equal(quiet.length, 1, 'export: hints look alike ' + tag + JSON.stringify(quiet));
      if (zoom === 1 && width === 1100 && (language === 'en' || language === 'de' || language === 'ja')) fs.writeFileSync(path.join(output, `export-${language}.png`), (await win.webContents.capturePage(exp.box)).toPNG());
      await win.webContents.executeJavaScript(`document.getElementById('exportSettingsDialog').close(); true`);
      // Import in its tallest state: the access warning, Review changes open, saved keys ticked with the passphrase field.
      await win.webContents.executeJavaScript(`document.getElementById('importSettings').click(); true`);
      await new Promise(r => setTimeout(r, 120));
      await win.webContents.executeJavaScript(`(()=>{ document.getElementById('importSettingsReview').open = true; const k = document.getElementById('importSettingsKeys'); k.checked = true; k.dispatchEvent(new Event('change')); return true; })()`);
      await new Promise(r => setTimeout(r, 80));
      const imp = await win.webContents.executeJavaScript(measureDialog('importSettingsDialog'));
      results.push({ tag, dialog: 'import', ...imp });
      assert.ok(imp.inside, 'import dialog inside the window ' + tag);
      assert.equal(imp.lefts.length, 1, 'import: one left edge ' + tag + JSON.stringify(imp.lefts));
      assert.ok(imp.rights.length <= 1, 'import: one right edge ' + tag + JSON.stringify(imp.rights));
      assert.deepEqual(imp.cut, [], 'import: nothing cut ' + tag);
      assert.ok(imp.oneRow && !imp.wrapped.length, 'import: buttons on one row ' + tag);
      if (zoom === 1 && width === 1100 && (language === 'en' || language === 'de' || language === 'ja')) fs.writeFileSync(path.join(output, `import-${language}.png`), (await win.webContents.capturePage(imp.box)).toPNG());
      await win.webContents.executeJavaScript(`document.getElementById('importSettingsDialog').close(); true`);
    }
  }
  win.setContentSize(1100, 760); win.webContents.setZoomFactor(1);
  fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(results, null, 2));
  // A short passphrase typed, then saved keys turned off: Export must still go. Typed for real, since
  // only a value the person edited counts as too short for the browser's own form check.
  await win.webContents.executeJavaScript(`backup.setLanguage('en'); document.querySelectorAll('dialog[open]').forEach(d => d.close());
    document.getElementById('exportSettings').click(); const k = document.getElementById('exportSettingsKeys'); k.checked = true; k.dispatchEvent(new Event('change'));
    document.getElementById('exportSettingsPass').focus(); true`);
  await win.webContents.insertText('short');
  const typedValid = await win.webContents.executeJavaScript(`document.getElementById('exportSettingsPass').validity.valid`);
  await win.webContents.executeJavaScript(`(() => { const k = document.getElementById('exportSettingsKeys'); k.checked = false; k.dispatchEvent(new Event('change')); return true; })()`);
  const formValid = await win.webContents.executeJavaScript(`document.getElementById('exportSettingsForm').checkValidity()`);
  assert.ok(formValid, 'export goes once saved keys are off, whatever the hidden passphrase says' + JSON.stringify({ typedValid }));
  await win.webContents.executeJavaScript(`document.getElementById('exportSettingsDialog').close(); true`);
  console.log('Passed: the Backup rows and the Export and Import dialogs fit, share one edge and cut nothing in all 13 languages (English, German and Russian also narrow and zoomed).');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
