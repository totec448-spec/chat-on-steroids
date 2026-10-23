// Real renderer with synthetic controls only. Never connects to the installed app or ChatGPT.
// #1787: a chat whose page stopped answering repairs read "Working for …" for six hours. Its caption
// now says it stopped and how to continue, and it must stay one readable line at every size.
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
  const root = path.join(__dirname, '..'), output = path.join(root, 'outputs/stopped-caption');
  fs.mkdirSync(output, { recursive: true });
  const code = (await require('esbuild').build({ entryPoints: [path.join(root, 'src/renderer/chat.ts')],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'chat', logLevel: 'error',
    loader: { '.css': 'empty' },
    plugins: [{ name: 'vite-url-stub', setup(build) {
      build.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'vite-url-stub' }));
      build.onLoad({ filter: /.*/, namespace: 'vite-url-stub' }, () => ({ contents: 'export default ""', loader: 'js' }));
    } }] })).outputFiles[0].text;
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const html = withoutScripts(fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')).replace(/<link\b[^>]*>/g, '')
    .replace('</head>', `<style>${css}</style></head>`);
  const win = new BrowserWindow({ show: false, width: 1100, height: 760,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await win.webContents.executeJavaScript(`(() => {
    const ok = data => Promise.resolve({ok:true,data});
    const started = Date.now() - (6 * 3600 + 12 * 60) * 1000;
    const session = {id:'stopped-fixture',title:'Refactor the payment module',conversationId:'fixture',chatIds:['fixture'],
      startedAt:started - 60000,updatedAt:started,endedAt:null,events:3,userMessages:1,toolCalls:1,errors:0,estimatedTokens:0,contextTokens:0,agents:[],origin:null,
      activeTurnId:'fixture-turn'};
    const events = [
      {seq:1,origin:1,time:started - 500,source:'extension',kind:'user_message',turnId:'fixture-turn',messageId:'q',message:{text:'Move the payment helpers into their own module and update the tests.',truncated:false,chars:70}},
      {seq:2,time:started,source:'extension',kind:'turn_start',turnId:'fixture-turn'},
      {seq:3,origin:3,time:started + 9000,source:'extension',kind:'assistant_message',turnId:'fixture-turn',messageId:'a',final:false,message:{text:'I will start by listing the payment helpers and their callers.',truncated:false,chars:62}}
    ];
    window.controls = {sessionId:session.id,conversationId:'fixture',automation:'off',objective:'',blocked:'',job:null,activeTurnId:'fixture-turn',pageless:false};
    window.api = new Proxy({listSessions:()=>ok({sessions:[session],activeId:null,blocked:[],pressure:[],recoveryStopped:[]}),
      listProjects:()=>ok([]),listInputs:()=>ok([]),runningTools:()=>ok([]),listPausedHelpers:()=>ok([]),
      getSession:()=>ok({summary:session,total:events.length,events,nextFrom:events.length}),getSessionControls:()=>ok(controls)
    }, {get:(target,key)=>target[key]??(()=>ok(null))});
    window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  })()`);
  await win.webContents.executeJavaScript(code);
  // What a person sees: the line under the question in the timeline (the header caption is mirrored there).
  const caption = `(async()=>{await frame();const n=document.querySelector('#timeline .turn-stopped');
    if(!n) return {text:null,visible:false};
    const label=n.firstElementChild,r=n.getBoundingClientRect(),q=document.querySelector('#timeline .ev-user_message').getBoundingClientRect();
    return {text:n.textContent,visible:r.height>0&&getComputedStyle(n).display!=='none',below:r.top>=q.bottom,
      fits:label.scrollWidth<=n.clientWidth+1&&r.right<=innerWidth,color:getComputedStyle(n).color,
      red:getComputedStyle(n).color===getComputedStyle(document.documentElement).getPropertyValue('--red').trim()||getComputedStyle(n).color!==getComputedStyle(document.querySelector('#timeline .ev-user_message')).color,
      working:!!document.querySelector('#timeline .turn-status.is-working'),thinking:!!document.querySelector('#timeline .turn-now:not([hidden])')}})()`;
  const working = await win.webContents.executeJavaScript(`(async()=>{
    chat.initChat({state:()=>null,save:async()=>{}});chat.chatVisible(true);await frame();
    document.querySelector('#sessionList [data-id="stopped-fixture"]').click();
    for(let i=0;i<120&&!/^Working for /.test(document.getElementById('chatState').textContent);i++) await frame();
    return document.getElementById('chatState').textContent;
  })()`);
  assert.match(working, /^Working for 6h 12m \d+s$/, working);
  fs.writeFileSync(path.join(output, 'before-working.png'), (await win.webContents.capturePage()).toPNG());
  // The app gives up: no page took this chat's repairs. The window learns it on its next read of the controls.
  await win.webContents.executeJavaScript(`(async()=>{controls.activeTurnId=null;controls.pageless=true;
    chat.chatVisible(false);chat.chatVisible(true);
    for(let i=0;i<120&&!document.querySelector('#timeline .turn-stopped');i++) await frame();})()`);
  const results = [];
  for (const width of [1100, 720]) for (const zoom of [1, 1.5]) {
    win.setContentSize(width, 760); win.webContents.setZoomFactor(zoom);
    const result = await win.webContents.executeJavaScript(caption);
    assert.equal(result.text, "Stopped · open this chat's tab again to continue", JSON.stringify({ width, zoom, ...result }));
    assert.ok(result.visible && result.fits && result.below, JSON.stringify({ width, zoom, ...result }));
    assert.ok(!result.working && !result.thinking, 'the running line and "Thinking" are gone: ' + JSON.stringify(result));
    results.push({ width, zoom, ...result });
    if (width === 1100 && zoom === 1) fs.writeFileSync(path.join(output, 'after-stopped.png'), (await win.webContents.capturePage()).toPNG());
  }
  // The page polls again: the verdict lifts and the caption goes with it.
  win.setContentSize(1100, 760); win.webContents.setZoomFactor(1);
  const back = await win.webContents.executeJavaScript(`(async()=>{controls.pageless=false;chat.chatVisible(false);chat.chatVisible(true);
    for(let i=0;i<120&&document.querySelector('#timeline .turn-stopped');i++) await frame();
    return {line:!!document.querySelector('#timeline .turn-stopped'),caption:document.getElementById('chatState').textContent};})()`);
  assert.deepEqual(back, { line: false, caption: '' });
  fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(results, null, 2));
  console.log('Passed: a stopped chat says so in one fitting line at four size/zoom combinations, and the line goes when the page is back.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
