// Real Electron check of the context dialog: one fact per row, and every row fits the 310px
// dialog in all interface languages. Synthetic IPC only; no account, provider or installed app.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp/context-dialog');
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// The account shapes this control has to handle: an Instant model, a three-step reasoning model
// and a long ladder.
const MODELS = `[
  {id:'gpt-5-6',label:'5.6 Instant',efforts:['none']},
  {id:'gpt-5-6-thinking',label:'5.6 Thinking',efforts:['medium','high','xhigh']},
  {id:'gpt-6-sol',label:'GPT-6 Sol',efforts:['low','medium','high','xhigh','max','ultra']}]`;
let server;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/composer-ui.js'), 'utf8')
    .replace(/models:\[\s*\{id:'gpt-6-sol'[\s\S]*?\n \]\};/, `models:${MODELS}};`);
  assert.ok(fixture.includes("'5.6 Instant'"), 'fixture model list replaced');
  server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    cacheDir: path.join(output, 'vite'), logLevel: 'error',
    resolve: { alias: { '@phosphor-icons/web': path.join(root, 'node_modules/@phosphor-icons/web/src') } },
    server: { host: '127.0.0.1', port: 4422, strictPort: true, fs: { allow: [root] } },
    plugins: [{ name: 'ipc-fixture', transformIndexHtml(html) {
      return html.replace('</head>', '<script src="/composer-fixture.js"></script></head>');
    }, configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url !== '/composer-fixture.js') return next();
      res.setHeader('Content-Type', 'text/javascript'); res.end(fixture);
    }); } }]
  });
  await server.listen();
  const win = new BrowserWindow({ show: false, width: 1440, height: 960,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const js = source => win.webContents.executeJavaScript(source);
  const capture = async name => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const click = async selector => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await pause(250); };
  // A move with the button held is a drag only when it says so (leftButtonDown).
  const mouse = (type, x, y, held = false) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...(held ? { modifiers: ['leftButtonDown'] } : {}) });
  const key = async keyCode => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await pause(260); };
  const state = () => js(`(() => { const s = document.querySelector('#composerPowerChoices input'), t = document.querySelector('.power-track');
    return { slider: !!s, value: s ? Number(s.value) : null, fraction: t ? Number(t.style.getPropertyValue('--power-fraction')) : null,
      stops: document.querySelectorAll('.power-track .power-stop').length, endpoints: !!document.querySelector('#composerPowerChoices .effort-endpoints'),
      effort: document.getElementById('composerReasoning').value, subtitle: document.getElementById('composerPowerModel').textContent,
      label: document.getElementById('composerModelLabel').textContent,
      rect: s ? s.getBoundingClientRect().toJSON() : null }; })()`);
  try {
    await win.loadURL('http://127.0.0.1:4422'); await pause(2200);
    await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`); await pause(500);
    const languages = [...new Set(await js(`[...document.querySelectorAll('#uiLanguage option')].map(o=>o.value)`))];
    assert.ok(languages.length >= 11, 'all interface languages: ' + languages.join(','));
    const results = [];
    for (const language of languages) {
      await js(`(()=>{const s=document.getElementById('uiLanguage');s.value=${JSON.stringify('LANG')};s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`.replace('LANG', language));
      await pause(500);
      await js(`(()=>{const m=document.getElementById('contextMeter');if(!m.classList.contains('pinned'))document.getElementById('contextMeterButton').click();return 1})()`);
      await pause(300);
      const r = await js(`(()=>{const d=document.getElementById('contextMeterInfo'),box=d.getBoundingClientRect();
        const rows=[...d.querySelectorAll('.context-data dt')].map(dt=>{const dd=dt.nextElementSibling,a=dt.getBoundingClientRect(),b=dd.getBoundingClientRect();
          return {label:dt.textContent,value:dd.textContent,inside:a.left>=box.left-1&&b.right<=box.right+1,overlap:a.right>b.left+1&&Math.abs(a.top-b.top)<4,clipped:dt.scrollWidth>dt.clientWidth+1||dd.scrollWidth>dd.clientWidth+1}});
        return {lang:document.documentElement.lang,rows,inViewport:box.left>=0&&box.right<=innerWidth&&box.top>=0}})()`);
      results.push(r);
      assert.equal(r.rows.length, 4, language + ': four rows');
      assert.ok(r.inViewport, language + ': dialog visible');
      for (const row of r.rows) {
        assert.ok(row.inside && !row.overlap && !row.clipped, language + ': row fits: ' + JSON.stringify(row));
        assert.ok(row.value.trim().length > 0 && !/undefined|NaN|\{\d\}/.test(row.value + row.label), language + ': row has a value: ' + JSON.stringify(row));
      }
      if (['en', 'de', 'pt-BR'].includes(language)) await capture('context-' + language);
    }
    await js(`(()=>{const s=document.getElementById('uiLanguage');s.value='en';s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
    assert.deepEqual(errors, [], 'no renderer errors');
    console.log('PASS: context dialog has four labelled rows that fit in ' + results.length + ' languages. ' + output);
  } finally { win.destroy(); await server?.close(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
