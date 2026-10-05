// The CoS browser's whole Google sign-in, in real Electron with synthetic sites: built panel and
// toolbar pages, Chromium's own network stack and cookie jar, and the shipped popup. Local TLS
// stands in for chatgpt.com/auth.openai.com behind a test proxy; Google is never contacted, no
// browser is launched, and no personal profile, installed app, bridge or account is touched.
// Needs `npm run build` first (it loads out/preload and out/renderer) and OpenSSL for the cert.
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-sign-in-check-'));
app.setPath('userData', path.join(fixture, 'user-data'));
app.on('window-all-closed', () => {});
// Chromium stops painting a window it thinks is covered; the captures need it painted regardless.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const deadline = setTimeout(() => { console.error('CoS sign-in fixture timed out'); app.exit(1); }, 100_000);
const SITES = ['chatgpt.com', 'auth.openai.com', 'accounts.google.com'];
const SESSION_COOKIE = '__Secure-next-auth.session-token';
const SYNTHETIC_TOKEN = 'synthetic-e2e-session';

async function waitFor(what, check, timeout = 15_000) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** A self-signed certificate for the synthetic sites; the fixture session trusts only it. */
function certificate() {
  const key = path.join(fixture, 'site.key'), cert = path.join(fixture, 'site.crt');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=cos-sign-in-fixture',
    '-addext', `subjectAltName=${SITES.map(site => `DNS:${site}`).join(',')}`, '-keyout', key, '-out', cert], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`openssl could not make the fixture certificate: ${made.stderr}`);
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

/** chatgpt.com and auth.openai.com as far as sign-in goes. Google must never be requested. */
function sites(seen) {
  const page = body => `<!doctype html><meta charset="utf-8"><title>ChatGPT</title>
    <body style="margin:0;font:16px system-ui;background:#212121;color:#fff;display:grid;place-items:center;height:100vh">${body}</body>`;
  return https.createServer(certificate(), (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    seen.push({ host, path: req.url, session: (req.headers.cookie || '').includes(`${SESSION_COOKIE}=${SYNTHETIC_TOKEN}`) });
    if (host === 'auth.openai.com' && req.url === '/google') {
      res.writeHead(302, { location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture' }).end();
    } else if (host === 'chatgpt.com' && req.url === '/auth/login') {
      // Light, like ChatGPT's own login: whatever covers it must still let it show through.
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><meta charset="utf-8"><title>ChatGPT</title>
        <body style="margin:0;font:15px system-ui;background:#fff;color:#0d0d0d;display:grid;place-items:center;height:100vh">
        <div style="display:grid;gap:12px;width:320px;text-align:center"><h1 style="font-size:30px;margin:0 0 12px">Welcome back</h1>
        <div style="border:1px solid #ccc;border-radius:999px;padding:14px">Email address</div>
        <div style="background:#0d0d0d;color:#fff;border-radius:999px;padding:14px">Continue</div>
        <a id="google" href="https://auth.openai.com/google" style="border:1px solid #ccc;border-radius:999px;padding:14px;color:#0d0d0d;text-decoration:none">Continue with Google</a></div>`);
    } else if (host === 'chatgpt.com' && req.url === '/') {
      const signedIn = seen.at(-1).session;
      res.writeHead(200, { 'content-type': 'text/html' }).end(page(`<meta name="state" id="state" content="${signedIn ? 'signed-in' : 'signed-out'}">
        <div style="display:grid;gap:22px;justify-items:center;width:min(720px,90vw)"><h2 style="font-weight:400;margin:0">${signedIn ? 'Por onde começamos?' : 'Entrar'}</h2>
        <div style="width:100%;height:56px;border-radius:28px;background:#303030"></div></div>`));
    } else res.writeHead(404).end();
  });
}

/** An HTTP proxy that tunnels every CONNECT to the synthetic sites, as DNS would to the real ones. */
function proxy(sitePort) {
  return http.createServer((_req, res) => res.writeHead(405).end()).on('connect', (req, socket, head) => {
    const upstream = net.connect(sitePort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
}

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** The host bundle, with only the external browser launch replaced by a recorder. */
async function loadHost(launched) {
  globalThis.__cosFixtureLaunched = launched;
  const browserTs = path.join(root, 'src/main/browser.ts').replace(/\\/g, '/');
  const result = await build({
    stdin: { resolveDir: root, loader: 'ts', contents: `
      export { CosBrowser } from './src/main/cos-browser/host.ts';
      export { cosSignInTransfer } from './src/main/cos-browser/sign-in-transfer.ts';
      export { getConfig } from './src/main/config.ts';` },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent',
    plugins: [{ name: 'record-browser-launch', setup(build) {
      build.onResolve({ filter: /^\.\.\/browser\.js$/ }, args => args.importer.endsWith(path.join('cos-browser', 'host.ts'))
        ? { path: 'fixture-browser', namespace: 'fixture' } : undefined);
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ resolveDir: root, loader: 'js', contents: `
        export { EXTERNAL_BROWSER_LABELS, installedSignInBrowsers } from ${JSON.stringify(browserTs)};
        export async function openBrowserSignIn(browser) { globalThis.__cosFixtureLaunched.push(browser); return 'fixture'; }` }));
    } }]
  });
  const loaded = new Module(path.join(fixture, 'host.cjs'));
  loaded.filename = path.join(fixture, 'host.cjs');
  loaded.paths = module.paths;
  loaded._compile(result.outputFiles[0].text, loaded.filename);
  return loaded.exports;
}

/** The CoS browser window as it is on screen: toolbar, page and panel composited by the OS. */
async function captureWindow(host, name) {
  // macOS grants window capture only with Screen Recording access, which CI runners lack.
  if (process.platform === 'darwin' && require('electron').systemPreferences.getMediaAccessStatus('screen') !== 'granted') return null;
  // This fixture's own window: another running app instance has windows with the same title.
  const ids = new Set([...host.frames.values()].map(frame => frame.base.getMediaSourceId()));
  await new Promise(resolve => setTimeout(resolve, 400));
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1180, height: 820 } });
  const source = sources.find(candidate => ids.has(candidate.id));
  if (!source) return null;
  const file = path.join(fixture, `${name}.png`);
  fs.writeFileSync(file, source.thumbnail.toPNG());
  return file;
}

/** Mean luminance 0..1 of the middle of an on-screen capture: the dark theme must never show white. */
function luminance(file) {
  const { nativeImage } = require('electron');
  const image = nativeImage.createFromPath(file);
  const { width, height } = image.getSize();
  const bitmap = image.crop({ x: Math.round(width * .1), y: Math.round(height * .2), width: Math.round(width * .8), height: Math.round(height * .7) }).toBitmap();
  let total = 0;
  for (let index = 0; index < bitmap.length; index += 4) total += (0.0722 * bitmap[index] + 0.7152 * bitmap[index + 1] + 0.2126 * bitmap[index + 2]) / 255;
  return total / (bitmap.length / 4);
}

app.whenReady().then(async () => {
  const seen = [];
  const siteServer = sites(seen);
  const proxyServer = proxy(await listen(siteServer));
  const proxyPort = await listen(proxyServer);
  const launched = [];
  const { CosBrowser, cosSignInTransfer, getConfig } = await loadHost(launched);
  getConfig().ui.chatBrowser = 'cos';
  getConfig().ui.language = 'pt-BR';
  getConfig().ui.theme = 'dark';

  const ses = session.fromPartition('persist:cos-browser');
  await ses.setProxy({ proxyRules: `127.0.0.1:${proxyPort}` });
  ses.setCertificateVerifyProc((request, callback) => callback(SITES.includes(request.hostname) ? 0 : -2));
  const host = new CosBrowser({ preloadDir: path.join(root, 'out/preload'), rendererDir: path.join(root, 'out/renderer'), rendererUrl: () => null });
  // Everything start() does except loading the companion, which this fixture does not exercise.
  host.configure(ses);
  host.ses = ses;
  host.browserEpoch++;
  host.startPromise = Promise.resolve();
  // As src/main/index.ts registers them for the app.
  ipcMain.on('cos-browser:toolbar', (event, action, tabId) => host.toolbarAction(event.sender, action, tabId));
  ipcMain.on('cos-browser:sign-in', (event, action, value) => host.signInAction(event.sender, action, value));
  const screenshots = [];
  const tabs = () => [...host.views.values()].map(view => view.webContents);
  const panelReady = async () => host.signIn && !host.signIn.view.webContents.isLoading() &&
    await host.signIn.view.webContents.executeJavaScript(`!document.getElementById('card').hidden`);
  const inPanel = script => host.signIn.view.webContents.executeJavaScript(script, true);

  // 1. ChatGPT's login sends the embedded browser to Google: the panel replaces that navigation.
  await host.open('https://chatgpt.com/auth/login', { reveal: true });
  const login = tabs()[0];
  await waitFor('the login page', () => login.getURL() === 'https://chatgpt.com/auth/login' && !login.isLoading());
  await login.executeJavaScript(`document.getElementById('google').click()`, true);
  await waitFor('the sign-in panel', panelReady);
  const options = await waitFor('browser options', async () => {
    const found = await inPanel(`[...document.querySelectorAll('.option')].map(option => ({
      name: option.querySelector('span').textContent, icon: !!option.querySelector('img') }))`);
    return found.length && found.every(option => option.icon) ? found : null;
  }, 5000).catch(() => inPanel(`[...document.querySelectorAll('.option')].map(option => ({
      name: option.querySelector('span').textContent, icon: !!option.querySelector('img') }))`));
  const choose = await inPanel(`({ title: document.getElementById('title').textContent,
    lang: document.documentElement.lang, fits: document.documentElement.scrollWidth <= innerWidth })`);
  assert.equal(choose.lang, 'pt-BR');
  assert.equal(choose.title, 'Entrar com Google');
  await waitFor('the login page under the card', () => login.getURL() === 'https://chatgpt.com/auth/login' && !login.isLoading());
  assert.equal(choose.fits, true);
  assert.ok(options.length > 0, 'this machine has no Chrome, Edge or Brave to offer');
  assert.equal(login.getURL(), 'https://chatgpt.com/auth/login', 'the cancelled redirect left the login page');
  assert.equal(launched.length, 0, 'a browser opened before the person chose one');
  screenshots.push(await captureWindow(host, '1-choose-browser'));

  // 2. Choosing a browser opens it on ChatGPT's own login and waits with one expiring offer.
  await inPanel(`document.querySelector('.option').click()`);
  await waitFor('the waiting step', async () => await inPanel(`document.getElementById('card').classList.contains('is-waiting')`) &&
    await inPanel(`!document.getElementById('reopen').disabled`));
  const offer = cosSignInTransfer.pending();
  assert.ok(offer, 'no transfer offer after choosing');
  assert.deepEqual(launched, [offer.browser]);
  const waiting = await inPanel(`({ title: document.getElementById('title').textContent,
    step: document.getElementById('lead').textContent, fits: document.documentElement.scrollWidth <= innerWidth })`);
  assert.match(waiting.title, /^Conclua o login no /);
  assert.equal(waiting.step, 'Ao terminar, a extensão traz a sessão para cá.');
  assert.equal(waiting.fits, true);
  screenshots.push(await captureWindow(host, '2-waiting-for-session'));

  // 3. The extension's POST lands (the bridge route hands it to the same offer): the cookie is
  //    imported, the panel closes, and ChatGPT receives that session on its next real request.
  const expirationDate = Math.floor(Date.now() / 1000) + 86_400;
  await cosSignInTransfer.accept(offer.id, 'fixture-browser', [{ name: SESSION_COOKIE, value: SYNTHETIC_TOKEN,
    domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, hostOnly: false, sameSite: 'lax', expirationDate }]);
  // The card confirms with the app's mark for a moment, then leaves.
  await waitFor('the signed-in confirmation', async () => host.signIn &&
    await inPanel(`document.getElementById('card').classList.contains('is-done')`));
  assert.equal(await inPanel(`document.getElementById('title').textContent`), 'Pronto, você entrou');
  screenshots.push(await captureWindow(host, '3a-signed-in-confirmation'));
  await waitFor('the panel to close', () => host.signIn === null);
  await waitFor('ChatGPT to load signed in', async () => login.getURL() === 'https://chatgpt.com/' && !login.isLoading() &&
    await login.executeJavaScript(`document.getElementById('state')?.content`) === 'signed-in');
  const stored = (await ses.cookies.get({ url: 'https://chatgpt.com/' })).find(cookie => cookie.name === SESSION_COOKIE);
  assert.equal(stored?.httpOnly, true);
  assert.equal(stored?.secure, true);
  assert.ok(seen.some(request => request.host === 'chatgpt.com' && request.path === '/' && request.session));
  assert.equal(cosSignInTransfer.pending(), null);
  screenshots.push(await captureWindow(host, '3-signed-in'));

  // 4. A Google popup becomes a tab with no page of its own; the panel covers it in the page color,
  //    and cancelling takes that tab to ChatGPT instead of leaving it empty.
  await login.executeJavaScript(`window.open('https://auth.openai.com/google')`, true);
  await waitFor('the popup panel', async () => host.signIn?.contents !== login && await panelReady());
  const popup = host.signIn.contents;
  screenshots.push(await captureWindow(host, '4-popup-panel'));
  // ChatGPT's light login, dimmed behind the card: never a bare white tab.
  if (screenshots.at(-1)) assert.ok(luminance(screenshots.at(-1)) < 0.7, 'the popup tab shows white behind the card');
  await inPanel(`document.getElementById('cancel').click()`);
  await waitFor('the popup tab to show ChatGPT login', () => host.signIn === null && popup.getURL() === 'https://chatgpt.com/auth/login' && !popup.isLoading());
  assert.equal(cosSignInTransfer.pending(), null);
  assert.equal(seen.filter(request => request.host === 'accounts.google.com').length, 0, 'Google was requested');
  host.stop();
  siteServer.close();
  proxyServer.close();

  const preload = path.join(fixture, 'popup-preload.cjs');
  fs.writeFileSync(preload, `
    const { contextBridge } = require('electron');
    const locale = process.argv.find(arg => arg.startsWith('--fixture-locale=')).split('=')[1];
    const messages = require(${JSON.stringify(path.join(root, 'extension/_locales'))} + '/' + locale + '/messages.json');
    contextBridge.exposeInMainWorld('__fixtureChrome', {
      i18n: { getUILanguage: () => locale.replace('_', '-'), getMessage: (key, substitutions) =>
        (messages[key]?.message || '').replace(/\\$([1-9])/g, (_, index) =>
          String((Array.isArray(substitutions) ? substitutions : [substitutions])[Number(index) - 1] ?? '')) },
      permissions: { request: async () => locale === 'pt_BR' },
      storage: { local: { get: async () => ({}) } },
      runtime: { sendMessage: async message => message.type === 'status'
        ? { connected: true, paired: true, compatible: true, port: 8765, signInOffer: { id: 'synthetic-offer' } }
        : message.type === 'cos_sign_in_transfer' ? { ok: true, imported: true } : null }
    });
    contextBridge.executeInMainWorld({ func: () => { globalThis.chrome = globalThis.__fixtureChrome; } });
  `);
  for (const locale of ['en', 'pt_BR']) {
    const win = new BrowserWindow({ width: 364, height: 680, show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false,
        partition: `cos-sign-in-ui-${locale}`, additionalArguments: [`--fixture-locale=${locale}`] } });
    win.webContents.on('preload-error', (_event, _file, error) => console.error(error.stack));
    await win.loadFile(path.join(root, 'extension/popup.html'));
    await win.webContents.executeJavaScript(`refresh().then(() => new Promise(resolve => setTimeout(resolve, 400)))`);
    // An unshown window never advances CSS animations; capture their final frames.
    const settle = `document.getAnimations().forEach(animation => animation.finish())`;
    await win.webContents.executeJavaScript(settle);
    const ready = path.join(fixture, `popup-ready-${locale}.png`);
    fs.writeFileSync(ready, (await win.webContents.capturePage()).toPNG());
    screenshots.push(ready);
    const check = await win.webContents.executeJavaScript(`(async () => {
      const visible = !document.getElementById('signInTransfer').hidden;
      document.getElementById('signInTransferBtn').click();
      for (let i = 0; i < 20 && transferringSignIn; i++) await new Promise(resolve => setTimeout(resolve, 10));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const button = document.getElementById('signInTransferBtn');
      await new Promise(resolve => setTimeout(resolve, 700));
      const done = document.getElementById('signInTransferDone');
      return { visible, busy: transferringSignIn,
        message: done.hidden ? document.getElementById('signInTransferResult').textContent : done.textContent,
        disabled: button.disabled, fits: button.scrollWidth <= button.clientWidth,
        pageFits: document.documentElement.scrollWidth <= innerWidth };
    })()`);
    assert.equal(check.visible, true);
    assert.equal(check.busy, false);
    assert.equal(check.disabled, locale === 'pt_BR');
    assert.equal(check.fits, true);
    assert.equal(check.pageFits, true);
    assert.ok(check.message.includes(locale === 'pt_BR' ? 'Sessão transferida' : 'not allowed'));
    await win.webContents.executeJavaScript(settle);
    const screenshot = path.join(fixture, `popup-${locale}.png`);
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    screenshots.push(screenshot);
    win.destroy();
  }
  clearTimeout(deadline);
  console.log(JSON.stringify({ ok: true, checks: [
    'Google redirect replaced by the CoS panel; login page kept, Google never requested',
    'card over the dimmed, reloaded ChatGPT login, Portuguese copy, real browser icons, no overflow',
    'nothing launched before the choice; one launch and one offer after it',
    'transfer imports an httpOnly secure cookie, closes the panel and ChatGPT receives the session',
    'Google popup tab gets ChatGPT login under the card, kept on cancel',
    'English permission denial', 'Portuguese transfer receipt', 'popup wrapping'], screenshots }));
  app.exit(0);
}).catch(error => { clearTimeout(deadline); console.error(error.stack); app.exit(1); });
