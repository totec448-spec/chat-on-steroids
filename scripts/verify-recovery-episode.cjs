// A chat's recovery episode (#1883): one row says what is wrong now, since when and how often the
// app tried, opens to every step, and turns amber with words once the app stopped. Real production
// renderer with synthetic IPC; no provider or installed app data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const feature = 'recovery-episode';
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', feature));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 localStorage.setItem('cos.ui.language','en');
 const old=window.api,ok=data=>Promise.resolve({ok:true,data});
 const start=Date.now()-3*3600000, min=m=>start+m*60000, text=t=>({text:t,truncated:false,chars:t.length});
 let seq=0; const e=x=>({seq:++seq,...x});
 window.base=[
  e({time:min(0),source:'extension',kind:'user_message',messageId:'u-1',turnId:'t-1',message:text('Audit the fleet dashboard and fix what is broken.')}),
  e({time:min(1),source:'extension',kind:'turn_start',turnId:'t-1'}),
  e({time:min(47),source:'extension',kind:'chat_error',turnId:'t-1',message:text('The response stream is unavailable (resume HTTP 404).')}),
  e({time:min(47),source:'app',kind:'progress',progressId:'browser-repair:a',message:text('Trying to reload chat to recover an interrupted response…')}),
  e({time:min(48),source:'app',kind:'progress',progressId:'browser-repair:a',message:text('Reloaded chat to recover an interrupted response.')}),
  e({time:min(57),source:'extension',kind:'chat_error',turnId:'t-1',recoverable:true,message:text('Message delivery timed out. Please try again. Retry')}),
  e({time:min(58),source:'extension',kind:'turn_end',turnId:'t-1',outcome:'failed'}),
  e({time:min(58.2),source:'app',kind:'progress',progressId:'browser-repair:b',message:text('Reloaded chat to recover a handoff request that has not been sent.')}),
  e({time:min(70),source:'extension',kind:'chat_error',message:text('ChatGPT temporarily limited access to this conversation history.')}),
  e({time:min(80),source:'extension',kind:'user_message',automatic:true,messageId:'u-2',turnId:'t-2',message:text('Continue until you are fully finished.')}),
  e({time:min(91),source:'extension',kind:'chat_error',recoverable:true,message:text('Message delivery timed out. Please try again. Retry')})
 ];
 window.stoppedNote=e({time:min(95),source:'app',kind:'note',message:text('Stopped trying to recover this chat: 10 attempts were offered to the browser and none was picked up, so this chat has no page to reload. Open its tab again and recovery resumes.')});
 const query=new URLSearchParams(location.search);
 window.timeline=query.has('stopped')?[...window.base,window.stoppedNote]:window.base.slice();
 const methods={
  markWhatsNewSeen:()=>ok(true),chatGroups:()=>ok({version:1,groups:[],members:{}}),
  // Main announces a changed chat; the fixture does the same when its timeline changes.
  onSessionChanged:fn=>{window.sessionChanged=fn;return old.onSessionChanged?.(fn)??(()=>{});},
  // Like main: an incremental read returns only what is newer than what the page has.
  getSession:(id,options={})=>old.getSession(id).then(r=>{const after=options.after??(options.from?options.from-1:0);const events=window.timeline.filter(x=>x.seq>after);return {...r,data:{...r.data,events,total:window.timeline.length,nextFrom:window.timeline.length+1}};}),
  getState:()=>old.getState().then(r=>query.get('theme')==='light'?{...r,data:{...r.data,config:{...r.data.config,ui:{...r.data.config.ui,theme:'light'}}}}:r)
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), cacheDir: path.join(output, 'vite'), logLevel: 'error',
    resolve: { alias: { '@phosphor-icons/web': path.join(root, 'node_modules/@phosphor-icons/web/src') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules/@phosphor-icons/web/src')), fs.realpathSync(path.join(root, 'node_modules'))] } },
    plugins: [{ name: 'recovery-episode-fixture', transformIndexHtml: html => html.replace('</head>', '<script src="/recovery-episode-fixture.js"></script></head>'),
      configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== '/recovery-episode-fixture.js') return next(); res.setHeader('Content-Type', 'text/javascript');
        res.end(fixtureConfigSource() + fs.readFileSync(path.join(root, 'scripts/fixtures/composer-ui.js'), 'utf8') + fixture); }); } }] });
  await server.listen();
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  const errors = []; win.webContents.on('console-message', e => { if (e.level === 'error' && !BENIGN_RENDERER_ERRORS.includes(e.message)) errors.push(e.message); });
  const js = code => win.webContents.executeJavaScript(code).catch(error => { console.error('Renderer expression:', code); throw error; });
  const until = async expression => { for (const deadline = Date.now() + 15000; Date.now() < deadline;) { if (await js(expression)) return; await pause(40); } throw new Error('Timed out: ' + expression); };
  const shot = async name => { await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`); await pause(250);
    fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  const row = `document.querySelector('#recoveryStatus .recovery-notice')`;
  const reopen = async () => { await js(`window.sessionChanged ? window.sessionChanged({ sessionIds: ['composer-preview'] }) : document.querySelector('#sessionList [data-id="composer-preview"]').click()`); await pause(900); };
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('#sessionList [data-id="composer-preview"]')`);
  await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`);
  await until(`!document.getElementById('recoveryStatus').hidden && !!document.querySelector('#recoveryStatus .recovery-episode-meta')`);
  const first = await js(`(() => { const r=${row}; const m=r.querySelector('.recovery-episode-meta'); return { label: r.querySelector('.queue-label').textContent, meta: m.textContent, expanded: m.getAttribute('aria-expanded'), stopped: r.classList.contains('is-stopped') }; })()`);
  // The latest step is what is happening now; since when and how often the app tried is beside it.
  assert.equal(first.label, 'Message delivery timed out. Please try again.');
  assert.match(first.meta, /^Since \d{1,2}:\d{2}( [AP]M)? · 3 tries$/);
  assert.equal(first.expanded, 'false');
  assert.equal(first.stopped, false);
  await shot('episode.png');

  await js(`document.querySelector('#recoveryStatus .recovery-episode-meta').click()`);
  await until(`!!document.querySelector('#recoveryEpisodeList')`);
  const list = await js(`[...document.querySelectorAll('#recoveryEpisodeList .recovery-episode-item span')].map(s=>s.textContent)`);
  // Newest first; a reload is one line saying how it ended.
  assert.deepEqual(list, ['Message delivery timed out. Please try again.', 'Automatic Continue sent', 'ChatGPT temporarily limited access to this conversation history.',
    'Reloaded chat to recover a handoff request that has not been sent.', 'The turn failed', 'Message delivery timed out. Please try again.',
    'Reloaded chat to recover an interrupted response.', 'The response stream is unavailable (resume HTTP 404).']);
  assert.equal(await js(`document.activeElement?.classList.contains('recovery-episode-meta')`), true);
  await shot('episode-open.png');

  // The app stopped trying: amber, a warning icon, and its own words.
  await js(`window.timeline=[...window.base, window.stoppedNote]`);
  await reopen();
  await until(`${row}?.classList.contains('is-stopped')`);
  const stopped = await js(`(() => { const r=${row}; return { label: r.querySelector('.queue-label').textContent, icon: r.querySelector(':scope > .ico').className, bg: getComputedStyle(r).backgroundColor }; })()`);
  assert.match(stopped.label, /^Stopped trying to recover this chat/);
  assert.match(stopped.icon, /ph-warning/);
  assert.notEqual(stopped.bg, 'rgba(0, 0, 0, 0)');
  await shot('stopped-dark.png');
  win.setContentSize(760, 900); await until('innerWidth===760'); await pause(200);
  const fits = await js(`(() => { const r=${row}.getBoundingClientRect(); return r.right <= innerWidth + 1; })()`);
  assert.ok(fits, 'the row fits a narrow window');
  // Narrow, the reason keeps its room and its full words (tooltip and accessible text); the try count gives way (Haz on #2062).
  const reason = await js(`(() => { const l=${row}.querySelector('.queue-label'); return { width: l.getBoundingClientRect().width, title: l.title, text: l.textContent }; })()`);
  assert.ok(reason.width >= 200, `the reason keeps room to read: ${reason.width}px`);
  assert.equal(reason.title, reason.text);
  assert.match(reason.text, /^Stopped trying to recover this chat/);
  // The narrowest window the app allows, with the sidebar open: the summary takes its own line under the
  // reason, so the reason keeps the row and the summary shows whole.
  win.setContentSize(640, 900); await until('innerWidth===640'); await pause(300);
  const tiny = await js(`(() => { const r=${row}, l=r.querySelector('.queue-label'), s=r.querySelector('.recovery-episode-meta > span'); const lb=l.getBoundingClientRect(), sb=s.getBoundingClientRect(); return { below: sb.top >= lb.bottom - 1, whole: s.scrollWidth <= s.clientWidth + 1, label: lb.width, fits: r.getBoundingClientRect().right <= innerWidth + 1, text: s.textContent }; })()`);
  assert.ok(tiny.below, 'the summary sits under the reason');
  assert.ok(tiny.whole, `the summary shows whole: ${tiny.text}`);
  assert.ok(tiny.label >= 200, `the reason keeps the row: ${tiny.label}px`);
  assert.ok(tiny.fits, 'the row fits');
  // The offer card above the chat (Keep plugins up to date) at the same width: its buttons take their
  // own line, so its explanation is not squeezed into a nine-line column beside them (2.1.51 polish pass).
  const offer = await js(`(() => { const c=document.getElementById('pluginRefreshOffer'); if (!c || c.hidden || !c.getClientRects().length) return null;
    const text=c.querySelector('.offer-text').getBoundingClientRect(), later=c.querySelector('.offer-later').getBoundingClientRect(), accept=c.querySelector('.offer-accept').getBoundingClientRect();
    return { text: Math.round(text.width), below: later.top >= text.bottom - 1 && accept.top >= text.bottom - 1, together: Math.abs(later.top - accept.top) < 2 && later.right <= accept.left,
      right: Math.round(c.getBoundingClientRect().right - accept.right) }; })()`);
  assert.ok(offer, 'the fixture shows the plugin offer card');
  assert.ok(offer.text >= 240, `the offer explanation keeps its width: ${offer.text}px`);
  assert.ok(offer.below, 'the offer buttons sit under the explanation');
  assert.ok(offer.together, 'Not now and Turn on stay side by side');
  assert.ok(offer.right <= 20, `the buttons end at the card's right edge: ${offer.right}px`);
  await shot('stopped-640.png');
  await shot('stopped-narrow.png');
  win.setContentSize(1280, 900); await until('innerWidth===1280');
  // The light theme, as the app applies it from its settings.
  await win.loadURL(server.resolvedUrls.local[0] + '?theme=light&stopped=1');
  await until(`!!document.querySelector('#sessionList [data-id="composer-preview"]')`);
  await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`);
  await until(`document.documentElement.dataset.theme==='light' && !!${row}?.classList.contains('is-stopped')`);
  await shot('stopped-light.png');

  // The chat works again: the episode is no longer shown.
  // The chat works again after the app's stop note: neither the episode nor that old note shows (CodeRabbit on #2062).
  await js(`window.timeline=[...window.base, window.stoppedNote, {seq:999,time:Date.now(),source:'extension',kind:'assistant_message',messageId:'a-9',turnId:'t-2',message:{text:'Picking up from the last step.',truncated:false,chars:29},state:'streaming'}]`);
  await reopen();
  await until(`document.getElementById('recoveryStatus').hidden && !document.querySelector('#recoveryStatus .recovery-notice')`);
  // A completed turn ends it for good.
  await js(`window.timeline=[...window.base, window.stoppedNote, {seq:1000,time:Date.now(),source:'extension',kind:'turn_end',turnId:'t-2',outcome:'completed'}]`);
  await reopen();
  await until(`!document.querySelector('#recoveryStatus .recovery-episode-meta')`);
  assert.deepEqual(errors, []);
  console.log('PASS: ' + feature + ' latest step, since and tries, the list, amber when stopped, light and dark, narrow, gone once working');
  win.destroy(); await server.close(); app.exit(0);
}).catch(async error => { fs.mkdirSync(output, { recursive: true }); if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); console.error(error); await server?.close(); app.exit(1); });
