// Production Setup modules in isolated Electron; never starts a bridge or visits ChatGPT.
const { app, BrowserWindow, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const preview = process.argv.includes('--preview');
app.setPath('userData', path.resolve(preview ? 'outputs/browser-setup-runtime' : 'outputs/browser-setup-test-runtime'));
/** The production page without its entry script, which the fixture replaces. */
function fixturePage() {
  const entry = '<script type="module" src="./main.ts"></script>';
  const html = fs.readFileSync('src/renderer/index.html', 'utf8');
  assert.equal(html.split(entry).length, 2, 'index.html has exactly one entry script');
  return html.replace(entry, '');
}
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const output = path.resolve('outputs/browser-setup', String(Date.now())); fs.mkdirSync(output, { recursive: true });
  const defaults = fixtureConfigSource();
  const server = await createServer({ configFile: false, root: path.resolve('src/renderer'),
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'browser-setup-fixture', configureServer(vite) {
      vite.middlewares.use('/browser-setup-preview.html', async (_req, res) => {
        let html = fixturePage()
          .replace('</body>', `<script type="module">
            import { initBrowserSetup } from '/setup-browser.ts';
            import { initSetupGuide } from '/setup-guide.ts';
            import { applyAppearance } from '/appearance.ts';
            import { initLanguage, setLanguage } from '/i18n.ts';
            ${defaults}
            window.api = { openChatGpt: async () => ({ok:true,data:true}) };
            initLanguage(); initSetupGuide();
            document.querySelector('.app').dataset.screen = 'settings';
            for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('is-active', panel.dataset.panel === 'setup');
            document.querySelector('[data-step="browser"]').classList.add('is-open');
            window.fixture = { config: fixtureConfig({}), update:{current:'2.1.26'}, bridge:{running:true,paired:true,present:true}, cosBrowserSignedIn:false };
            applyAppearance(fixture.config.ui.theme, fixture.config.ui.appearance);
            window.opened = []; window.choices = [];
            const setup = initBrowserSetup({ choose(browser) { window.choices.push(browser); fixture.config.ui.chatBrowser=browser; window.paint(); }, repaint() {window.paint();}, async open(browser,page) {window.opened.push([browser,page]);} });
            window.paint = () => setup.render(fixture);
            window.setLanguage = setLanguage;
            window.paint(); window.fixtureReady=true;
          </script></body>`);
        if (preview) html = fixturePage()
          .replace('</body>', '<script type="module">'+require('./fixtures/setup-preview.cjs')(defaults)+'</script></body>');
        res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/browser-setup-preview.html', html));
      });
    } }] });
  let win;
  try {
    await server.listen();
    win = new BrowserWindow({ show: preview, width: 1280, height: 1000, webPreferences: { sandbox: true, backgroundThrottling: false } });
    await win.loadURL(server.resolvedUrls.local[0] + 'browser-setup-preview.html');
    const js = code => win.webContents.executeJavaScript(code);
    for (let attempt=0; attempt<100 && !await js('!!window.fixtureReady'); attempt++) await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(await js('window.fixtureReady'), true);
    if (preview) {
      const title = 'Setup completo — prévia com dados simulados';
      win.on('page-title-updated', event => { event.preventDefault(); win.setTitle(title); });
      win.webContents.on('did-finish-load', () => { void js("setLanguage('pt-BR')"); win.setTitle(title); });
      await js("setLanguage('pt-BR')"); win.setTitle(title);
      const connection = (present, version) => { void js(`fixture.bridge.externalExtension={present:${present},version:${JSON.stringify(version)},lastSeenAt:Date.now()};paint()`); };
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Simular conexão', submenu: [
        { label: 'Aguardando extensão', click: () => connection(false, null) },
        { label: 'Extensão conectada', click: () => connection(true, '2.1.26') },
        { label: 'Extensão desatualizada', click: () => connection(true, '2.1.25') },
        { label: 'Login ChatGPT concluído', click: () => { void js("simulate('login')"); } }
        ,{ label: 'Túnel configurado', click: () => { void js("simulate('tunnel')"); } },
        { label: 'Chave de API configurada', click: () => { void js("simulate('key')"); } },
        { label: 'Plugin conectado', click: () => { void js("simulate('plugin')"); } }
      ] }, { label: 'Visualização', submenu: [{ role: 'reload' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        {label:'Salvar e abrir captura desta janela',click:async()=>{const file=path.join(output,'live-preview.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());await require('electron').shell.openPath(file);}}
      ] }]));
      win.show(); win.focus();
      if (process.argv.includes('--check-preview')) {
        await js("simulate('extension');document.getElementById('browserContinue').click()");
        for (const step of ['browser','folder','tunnel','key','connect','chatgpt','ready']) {
          await js(`document.querySelector('[data-rail-step="${step}"]').click()`);
          assert.equal(await js(`document.querySelector('[data-step="${step}"]').classList.contains('is-open')`),true,step);
        }
        await js("(async()=>{simulate('login');await api.addRoot();simulate('tunnel');simulate('key');await api.connect();simulate('plugin')})()");
        assert.equal(await js("document.getElementById('readyStart').hidden"),false);
        await js("document.querySelector('[data-rail-step=browser]').click();document.getElementById('browserBack').click()");
        console.log('PASS: all seven Setup panels navigate through the production renderer; simulated completion reaches Ready.');
      }
      console.log('Preview open; Vite reloads it when the Setup sources change.');
      await new Promise(resolve => win.once('closed', resolve));
      win = null;
      return;
    }
    assert.equal(await js('document.getElementById("browserContinue").disabled'), true, 'CoS presence alone cannot unlock setup');
    const capture = async name => {
      await js(`(async()=>{ await document.fonts.ready; await Promise.all([...document.querySelectorAll('.browser-setup img')].map(i=>i.decode())); document.querySelector('[data-step="browser"]').scrollIntoView({block:'start'}); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); })()`);
      const bounds = await js(`(() => { const p=document.querySelector('[data-panel="setup"]'); return { overflow:p.scrollWidth>p.clientWidth, icons:[...document.querySelectorAll('.browser-segments img, .browser-option img')].every(i=>i.naturalWidth>0) }; })()`);
      assert.deepEqual(bounds, { overflow: false, icons: true }, name);
      fs.writeFileSync(path.join(output, name+'.png'), (await win.webContents.capturePage()).toPNG());
    };
    await js("setLanguage('pt-BR')");
    await capture('extension-waiting-desktop');
    await js("fixture.bridge.externalExtension={present:true,version:'2.1.25',lastSeenAt:Date.now()};paint()");
    assert.equal(await js('document.getElementById("browserContinue").disabled'), true);
    await js("fixture.bridge.externalExtension.version=null;paint()");
    assert.equal(await js('document.getElementById("browserContinue").disabled'), true);
    await js("fixture.bridge.externalExtension.version='2.1.26';paint()");
    assert.equal(await js('document.getElementById("browserContinue").disabled'), false);
    await capture('extension-connected-desktop');
    await js("document.getElementById('browserContinue').click();document.getElementById('useCosBrowser').click()");
    assert.equal(await js('document.getElementById("browserLocationStage").hidden'), false);
    await capture('location-cos-desktop');
    await js("document.getElementById('useExtensionBrowser').click()");
    assert.equal(await js('paint().ready'), false);
    await js('fixture.bridge.externalExtension.signedIn=false;paint()');
    // Signed out in the person's browser says so, and names it: not the built-in browser's wording.
    assert.match(await js('document.getElementById("externalBrowserState").textContent'), /Chrome/);
    assert.equal(await js('paint().ready'), false);
    await js('fixture.bridge.externalExtension.signedIn=true;paint()');
    assert.equal(await js('paint().ready'), true);
    await js('fixture.bridge.externalExtension.signedIn=null;paint()');
    assert.equal(await js('paint().ready'), false);
    await capture('location-browser-desktop');
    win.setSize(800, 1000);
    await js("document.getElementById('browserBack').click()");
    await capture('extension-narrow');
    await js("document.getElementById('browserContinue').click();document.getElementById('useCosBrowser').click()");
    await capture('location-narrow');
    // The installation browser is a local choice; it never switches the saved CoS preference.
    await js("document.getElementById('browserBack').click();document.querySelector('[data-external-browser=edge]').click();document.getElementById('openExtensionSettings').click()");
    assert.equal(await js('fixture.config.ui.chatBrowser'), 'cos');
    assert.deepEqual(await js('window.opened'), [['edge','extensions']]);
    await js("document.getElementById('browserContinue').click();fixture.bridge.externalExtension.present=false;paint()");
    assert.equal(await js('document.getElementById("browserConnectionLost").hidden'), false);
    assert.equal(await js('paint().ready'), false);
    console.log('PASS: external-only gating, versions, two stages, icons, explicit browser opening, desktop/narrow layouts.');
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
