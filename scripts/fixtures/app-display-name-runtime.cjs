// Real main branding module, built preload and renderer; synthetic state, no provider traffic.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = process.argv[2];
assert.ok(output && path.isAbsolute(output), 'An absolute proof directory is required');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, 'runtime-')));
app.whenReady().then(async () => {
  const bundle = path.join(output, 'main-brand.cjs');
  require('esbuild').buildSync({ stdin: { contents: `export {appBrand} from './src/main/app-brand.ts';`, resolveDir: root },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
  const { appBrand } = require(bundle);
  assert.equal(appBrand.displayName, 'Chat On Steroids (dev)');
  const config = require('./app-defaults.cjs').defaultConfig();
  config.ui = { ...config.ui, theme: 'light', autoConnect: false, lastSeenVersion: '2.1.55' };
  const base = { config, hasApiKey: false, hasGoalKey: false, resolvedBinary: null,
    status: { state: 'disconnected', surfaces: [] }, bridge: { running: false, paired: false, present: false },
    update: { current: '2.1.55', latest: null, stage: 'idle' } };
  let state = base;
  const preload = path.join(root, 'out/preload/index.js');
  const channels = new Set([...fs.readFileSync(preload, 'utf8').matchAll(/\bcall\(\s*["']([^"']+)["']/g)].map(x => x[1]));
  const arrays = new Set(['log:get', 'projects:list', 'sessions:outbox', 'sessions:pausedHelpers', 'sessions:runningTools']);
  for (const channel of channels) ipcMain.handle(channel, () => {
    let data = null;
    if (channel === 'state:get') data = state;
    else if (arrays.has(channel)) data = [];
    else if (channel === 'sessions:list') data = { sessions: [], total: 0, nextCursor: null, activeId: null, pressure: [], blocked: [] };
    else if (channel === 'swarm:get') data = { running: false, agents: [], pendingReports: 0 };
    else if (channel === 'chatModels:get') data = { state: 'unknown', models: [] };
    return { ok: true, data };
  });
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: /^https?:/.test(request.url) }));
  const proof = [], errors = [];
  // Keep one window alive until both states and the final JSON have been captured.
  const win = new BrowserWindow({ show: true, width: 1180, height: 820, title: '',
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  for (const legacy of [true, false]) {
    state = legacy ? base : { ...base, displayName: appBrand.displayName };
    const expected = legacy ? 'Chat On Steroids' : appBrand.displayName;
    await win.loadFile(path.join(root, 'out/renderer/index.html'));
    const js = code => win.webContents.executeJavaScript(code);
    const until = async code => { const end = Date.now() + 15000; while (Date.now() < end) { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timeout: ' + code); };
    await until(`document.title === ${JSON.stringify(expected)}`);
    await js(`(() => {const s=document.getElementById('uiLanguage');s.value='en';s.dispatchEvent(new Event('change',{bubbles:true}));const back=document.getElementById('backToChat');if(back.checkVisibility())back.click()})()`);
    await until(`document.querySelector('.sidebar-brand strong').checkVisibility() && document.querySelector('.sidebar-brand strong').textContent === ${JSON.stringify(expected)}`);
    await js('document.fonts.ready'); await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(win.getTitle(), expected); assert.deepEqual(errors, []);
    const rendererTitle = await js('document.title'), header = await js(`document.querySelector('.sidebar-brand strong').textContent`);
    fs.writeFileSync(path.join(output, legacy ? 'before.png' : 'after.png'), (await win.webContents.capturePage()).toPNG());
    proof.push({ legacy, nativeTitle: win.getTitle(), rendererTitle, header, errors: [...errors] });
  }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(proof, null, 2));
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
