// Real Electron check of the thinking-effort control with real pointer and key input.
// Instant models (one effort) get no slider; reasoning models glide with the pointer and settle
// on the nearest effort. Synthetic IPC only; no account, provider or installed app.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp/effort-slider');
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
    server: { host: '127.0.0.1', port: 4421, strictPort: true, fs: { allow: [root] } },
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
    await win.loadURL('http://127.0.0.1:4421'); await pause(2200);
    await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`); await pause(500);
    await click('#modelMenu > summary');

    // An Instant model has one effort: nothing to slide.
    await click('[data-model="gpt-5-6"]');
    let s = await state();
    assert.equal(s.slider, false, 'Instant model shows no slider');
    assert.equal(s.endpoints, false, 'Instant model shows no endpoint labels');
    assert.equal(s.effort, 'none'); assert.ok(s.subtitle.length > 0, 'the effort is still named');
    await capture('instant');

    // A reasoning model: three stops, thumb glides with the real pointer.
    await click('[data-model="gpt-5-6-thinking"]');
    s = await state();
    assert.equal(s.slider, true); assert.equal(s.stops, 3);
    const { rect } = s, y = rect.y + rect.height / 2, left = rect.x + 8, width = rect.width - 16;
    const at = fraction => left + width * fraction;
    mouse('mouseMove', at(0), y); mouse('mouseDown', at(0), y); await pause(60);
    const fractions = [];
    for (let i = 1; i <= 14; i++) { mouse('mouseMove', at(i * 0.05), y, true); await pause(30); fractions.push((await state()).fraction); }
    await capture('thinking-mid-drag');
    const distinct = new Set(fractions.map(value => value.toFixed(2))).size;
    assert.ok(distinct >= 8, `thumb glides with the pointer instead of jumping: ${JSON.stringify(fractions)}`);
    assert.ok(fractions.every((value, i) => i === 0 || value >= fractions[i - 1] - 0.001), 'no jumps backwards while dragging right');
    s = await state();
    assert.equal(s.effort, 'high', 'mid-drag the effort is the nearest stop (0.7 → high)');
    mouse('mouseUp', at(0.7), y); await pause(400);
    s = await state();
    assert.equal(s.value, 1, 'released thumb settles on the nearest stop'); assert.equal(s.fraction, 0.5);
    assert.equal(s.effort, 'high'); assert.ok(s.label.includes('5.6 Thinking'));
    await capture('thinking-settled');

    // Keys: one whole effort per press, clamped at the ends.
    await js(`document.querySelector('#composerPowerChoices input').focus()`);
    await key('Right'); s = await state(); assert.equal(s.effort, 'xhigh'); assert.equal(s.value, 2);
    await key('Right'); s = await state(); assert.equal(s.effort, 'xhigh');
    await key('Home'); s = await state(); assert.equal(s.effort, 'medium'); assert.equal(s.fraction, 0);

    // A long ladder keeps its stops and endpoints.
    await click('[data-model="gpt-6-sol"]');
    s = await state(); assert.equal(s.stops, 6); assert.equal(s.endpoints, true);
    await capture('long-ladder');
    assert.deepEqual(errors, [], 'no renderer errors');
    console.log('PASS: Instant has no slider; reasoning thumb glides (' + distinct + ' positions over one drag), settles on the nearest effort, keys step and clamp; six-step ladder intact. ' + output);
  } finally { win.destroy(); await server?.close(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
