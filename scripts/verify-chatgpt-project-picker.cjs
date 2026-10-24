// Real renderer with synthetic data only. Never connects to the installed app or ChatGPT.
// #1756: choosing a project's ChatGPT Project. The popover must scan at a glance: heading, search,
// rows and the one note share one left edge and one rhythm, rows have one height, and the note is
// a single short line, at every size and zoom.
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
  const root = path.join(__dirname, '..'), output = path.join(root, 'outputs/chatgpt-project-picker');
  fs.mkdirSync(output, { recursive: true });
  const code = (await require('esbuild').build({ stdin: { contents: `
      export { createChatgptProjectPicker } from './src/renderer/chatgpt-project-picker.ts';
      export { setLanguage, initLanguage } from './src/renderer/i18n.ts';`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'picker', logLevel: 'error', loader: { '.css': 'empty' } })).outputFiles[0].text;
  // The icon font too, embedded, so the pictures show the rows as the app draws them.
  const font = (name) => 'data:font/woff2;base64,' + fs.readFileSync(path.join(root, 'node_modules/@phosphor-icons/web/src', name)).toString('base64');
  const icons = fs.readFileSync(path.join(root, 'src/renderer/icons.css'), 'utf8')
    .replace("url('@phosphor-icons/web/regular/Phosphor.woff2')", `url('${font('regular/Phosphor.woff2')}')`)
    .replace("url('@phosphor-icons/web/fill/Phosphor-Fill.woff2')", `url('${font('fill/Phosphor-Fill.woff2')}')`);
  const css = icons + fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const html = withoutScripts(fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')).replace(/<link\b[^>]*>/g, '')
    .replace('</head>', `<style>${css}</style></head>`);
  const win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.webContents.on('console-message', (_e, _l, message) => { if (/error|Error/.test(message)) console.error('renderer:', message); });
  await win.webContents.executeJavaScript(code);
  await win.webContents.executeJavaScript('picker.initLanguage(); true');
  const open = async (language) => win.webContents.executeJavaScript(`(async()=>{
    document.querySelectorAll('.file-branch-menu').forEach(n => n.remove());
    picker.setLanguage(${JSON.stringify(language)});
    let anchor = document.getElementById('fixture-anchor');
    if (!anchor) { anchor = document.createElement('button'); anchor.id = 'fixture-anchor'; anchor.textContent = 'Website';
      Object.assign(anchor.style, { position: 'fixed', left: '24px', top: '120px' }); document.body.append(anchor); }
    const ok = data => Promise.resolve({ ok: true, data });
    const choices = [
      { id: 'g-p-1', name: 'Website', linkedTo: null },
      { id: 'g-p-2', name: 'Quarterly planning and the very long name of a project that does not fit', linkedTo: null },
      { id: 'g-p-3', name: 'Mobile app', linkedTo: { id: 'other', name: 'Mobile' } },
      { id: 'g-p-4', name: 'Research notes', linkedTo: null }
    ];
    const p = picker.createChatgptProjectPicker({ api: { chatgptProjectChoices: () => ok(choices), linkChatgptProject: () => ok(null), createChatgptProject: () => ok(null) },
      anchor: () => anchor, onUpdated: () => {}, onError: () => {}, onNotice: () => {} });
    await p.hasChoices();
    await p.offer({ id: 'p1', name: 'Website', path: '/work/website', createdAt: 1 }, 'added');
    await new Promise(r => setTimeout(r, 250));
    return true; })()`);
  const measure = `(()=>{
    const menu = document.querySelector('.chatgpt-project-picker'); const m = menu.getBoundingClientRect();
    const heading = menu.querySelector('.file-branch-heading'), search = menu.querySelector('.file-branch-search');
    const options = [...menu.querySelectorAll('.file-branch-option')], notes = [...menu.querySelectorAll('.file-branch-notes p')];
    const textLeft = node => { const r = document.createRange(); r.selectNodeContents(node); return r.getBoundingClientRect().left; };
    const label = o => o.querySelector('.ico') || o.querySelector('span');
    return {
      inside: m.left >= 0 && m.right <= innerWidth && m.bottom <= innerHeight,
      headingLeft: heading ? textLeft(heading) : null, searchLeft: search.getBoundingClientRect().left + parseFloat(getComputedStyle(search).paddingLeft),
      optionLeft: label(options[0]).getBoundingClientRect().left,
      noteLeft: notes.length ? textLeft(notes[0]) : null,
      optionHeights: [...new Set(options.map(o => Math.round(o.getBoundingClientRect().height)))],
      noteLines: notes.map(p => { const cs = getComputedStyle(p); const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4; return Math.round((p.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / line); }),
      noteText: notes.map(p => p.textContent), noteHeight: notes.reduce((sum, p) => sum + p.getBoundingClientRect().height, 0),
      noteCut: notes.some(p => p.scrollWidth > p.clientWidth + 1),
      menuWidth: Math.round(m.width), clipped: options.some(o => o.scrollWidth > o.clientWidth + 1 && !o.querySelector('span').matches(':first-of-type'))
    }; })()`;
  // The sidebar with no projects yet: its one sentence says what to do, whole, in at most two lines.
  const empty = `(()=>{
    document.querySelectorAll('.file-branch-menu').forEach(n => n.remove());
    document.getElementById('projectList').hidden = true;
    const p = document.getElementById('projectsEmpty'); p.hidden = false;
    const cs = getComputedStyle(p), line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const r = p.getBoundingClientRect();
    return { text: p.textContent, lines: Math.round((r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / line),
      cut: p.scrollWidth > p.clientWidth + 1, inside: r.right <= p.parentElement.getBoundingClientRect().right + 0.5,
      box: { x: Math.max(0, Math.floor(r.left) - 24), y: Math.max(0, Math.floor(r.top) - 60), width: 380, height: Math.ceil(r.height) + 90 } }; })()`;
  const results = [];
  const languages = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
  for (const language of languages) {
    // Every language at the default size; the two longest-running catalogs also narrow and zoomed.
    for (const [width, zoom] of language === 'en' || language === 'de' ? [[1100, 1], [720, 1], [1100, 1.5]] : [[1100, 1]]) {
      // A resize closes the popover (as in the app), so it opens again at each size.
      win.setContentSize(width, 760); win.webContents.setZoomFactor(zoom);
      await new Promise(r => setTimeout(r, 120));
      await open(language);
      const result = await win.webContents.executeJavaScript(measure);
      results.push({ language, width, zoom, ...result });
      if (width === 1100 && zoom === 1) fs.writeFileSync(path.join(output, `picker-${language}.png`), (await win.webContents.capturePage({ x: 0, y: 80, width: 380, height: 360 })).toPNG());
      if (width === 1100 && zoom === 1) {
        const state = await win.webContents.executeJavaScript(empty);
        assert.ok(state.lines <= 2 && !state.cut && state.inside, 'the empty projects line is whole, in at most two lines: ' + JSON.stringify({ language, ...state }));
        fs.writeFileSync(path.join(output, `projects-empty-${language}.png`), (await win.webContents.capturePage(state.box)).toPNG());
        results.push({ language, emptyState: state });
        await win.webContents.executeJavaScript(`document.getElementById('projectList').hidden = false; document.getElementById('projectsEmpty').hidden = true; true`);
      }
      assert.ok(result.inside, JSON.stringify({ language, width, zoom, ...result }));
      assert.equal(result.optionHeights.length, 1, 'rows have one height: ' + JSON.stringify(result.optionHeights));
      for (const left of [result.headingLeft, result.searchLeft, result.noteLeft]) {
        if (left !== null) assert.ok(Math.abs(left - result.optionLeft) <= 2, 'one left edge: ' + JSON.stringify({ language, width, zoom, ...result }));
      }
      assert.ok(result.noteLines.every(lines => lines <= 1) && !result.noteCut, 'the note is one short, whole line: ' + JSON.stringify({ language, width, zoom, note: result.noteText }));
    }
    win.setContentSize(1100, 760); win.webContents.setZoomFactor(1);
  }
  fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(results, null, 2));
  console.log('Passed: the ChatGPT Project picker keeps one left edge, one row height and a whole one-line note in all 13 languages (English and German also narrow and zoomed), and the empty Projects line is whole.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
