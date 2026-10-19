// Maintainer tool: the pictures on the Sidebar layout cards (Settings → Appearance), taken from the
// production renderer with made-up projects and chats. Redo them whenever the sidebar changes:
//
//   npx electron scripts/capture-layout-previews.cjs
//
// Writes src/renderer/layout-previews/{projects,inbox}-{light,dark}.png.
const fs = require('node:fs');
const path = require('node:path');
const { fixtureServer, root } = require('./fixtures/readme-fixture.cjs');
const { app, BrowserWindow } = require('electron');

const output = path.join(root, 'src/renderer/layout-previews');
app.setPath('userData', path.join(root, 'outputs/layout-previews-runtime'));

app.whenReady().then(async () => {
  const server = await fixtureServer({ sidebar: true });
  let win;
  try {
    fs.mkdirSync(output, { recursive: true });
    win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false, zoomFactor: 1 } });
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('renderer:', event.message); });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    const js = code => win.webContents.executeJavaScript(code);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (predicate, what) => { for (let i = 0; i < 300; i++) { if (await js(predicate)) return; await wait(50); } throw new Error('timed out: ' + what); };
    const settle = () => js('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 500)))))');
    await until('window.ready', 'ready');
    // A picture of the list, not of the scroll bar beside it.
    await win.webContents.insertCSS('.sidebar ::-webkit-scrollbar { display: none; }');
    await wait(800);
    await js(`[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === 'Got it')?.click()`);
    for (const theme of ['light', 'dark']) for (const layout of ['projects', 'inbox']) {
      await js(`(async () => { const state = (await window.api.getState()).data;
        const { defaultAppearance } = await import('/@fs${root}/src/shared/appearance.ts');
        state.config.ui.theme = ${JSON.stringify(theme)};
        state.config.ui.appearance = { ...defaultAppearance(), sidebarLayout: ${JSON.stringify(layout)} };
        window.pushState(state); })()`);
      await settle();
      if (layout === 'projects') {
        // Two projects open, as a person working in them sees the tree.
        await js(`for (const id of ['p-web', 'p-app']) { const group = document.querySelector('[data-project-id="' + id + '"]'); if (group && !group.open) group.querySelector('.project-heading').click(); }`);
        await settle();
      }
      // From where the two layouts start to differ: the Projects heading, or the inbox's search row.
      const rect = await js(`(() => { const side = document.querySelector('.sidebar').getBoundingClientRect();
        const start = document.querySelector(${JSON.stringify(layout === 'inbox' ? '.inbox-top' : '.sidebar-session-label')}).getBoundingClientRect();
        const y = Math.round(start.top - 10); return { x: Math.round(side.x), y, width: Math.round(side.width), height: Math.min(330, Math.round(side.bottom - y)) }; })()`);
      fs.writeFileSync(path.join(output, `${layout}-${theme}.png`), (await win.webContents.capturePage(rect, { stayHidden: true, stayAwake: true })).toPNG());
      console.log('wrote', `${layout}-${theme}.png`);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win?.destroy();
    await server.close();
    app.quit();
  }
});
