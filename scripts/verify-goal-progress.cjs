// Real renderer with synthetic controls only. Never connects to the installed app or ChatGPT.
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
  const root = path.join(__dirname, '..'), output = path.join(root, 'outputs/goal-progress');
  fs.mkdirSync(output, { recursive: true });
  const code = require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/renderer/chat.ts')],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'chat' }).outputFiles[0].text;
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '')
    .replace('</head>', `<style>${css}</style></head>`);
  const win = new BrowserWindow({ show: false, width: 1100, height: 760,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await win.webContents.executeJavaScript(`(() => {
    const ok = data => Promise.resolve({ok:true,data});
    const session = {id:'goal-fixture',title:'Loop progress',conversationId:'fixture',chatIds:['fixture'],
      startedAt:1,updatedAt:1,endedAt:null,events:0,userMessages:0,toolCalls:0,errors:0,estimatedTokens:0,contextTokens:0,agents:[],origin:null};
    window.controls = {sessionId:session.id,conversationId:'fixture',automation:'loop',objective:'Continue the requested work',blocked:'',job:null,
      goalWait:{reason:'quiet',until:Date.now()+125000},goalDraft:null};
    window.api = new Proxy({listSessions:()=>ok({sessions:[session],activeId:null,blocked:[],pressure:[]}),
      listProjects:()=>ok([]),listInputs:()=>ok([]),listPausedHelpers:()=>ok([]),
      getSession:()=>ok({summary:session,total:0,events:[],nextFrom:0}),getSessionControls:()=>ok(controls)
    }, {get:(target,key)=>target[key]??(()=>ok(null))});
    window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  })()`);
  await win.webContents.executeJavaScript(code);
  await win.webContents.executeJavaScript(`(async()=>{
    chat.initChat({state:()=>null,save:async()=>{}});chat.chatVisible(true);await frame();
    document.querySelector('#sessionList [data-id="goal-fixture"]').click();
    for(let i=0;i<120&&!document.getElementById('goalLifecycle')?.textContent.includes('Waiting for tool inactivity');i++) await frame();
  })()`);
  const results = [];
  for (const width of [1100, 720]) for (const zoom of [1, 1.5]) {
    win.setContentSize(width, 760); win.webContents.setZoomFactor(zoom);
    const result = await win.webContents.executeJavaScript(`(async()=>{
      await frame();const row=document.getElementById('goalLifecycle'),timer=row.querySelector('[role="timer"]');
      const r=row.getBoundingClientRect(),t=timer.getBoundingClientRect();
      return {text:row.textContent,visible:!row.hidden&&r.height>0,fits:row.scrollWidth<=row.clientWidth&&t.right<=r.right};
    })()`);
    assert.ok(result.visible && result.fits, JSON.stringify({ width, zoom, ...result }));
    results.push({ width, zoom, ...result });
    if (width === 1100 && zoom === 1) fs.writeFileSync(path.join(output, 'waiting.png'), (await win.webContents.capturePage()).toPNG());
  }
  win.setContentSize(1100, 760); win.webContents.setZoomFactor(1);
  const generated = await win.webContents.executeJavaScript(`(async()=>{
    controls.goalWait=null;controls.goalDraft={stage:'answering',model:'fixture',text:'Continue with the remaining verification and report the result.',error:null};
    chat.chatVisible(true);await frame();await frame();return document.getElementById('goalLifecycle').textContent;
  })()`);
  assert.ok(generated.includes('Generating a continuation') && generated.includes('remaining verification'), generated);
  fs.writeFileSync(path.join(output, 'generating.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(results, null, 2));
  console.log('Passed real Loop progress rendering, countdown fit at four size/zoom combinations, and generated text.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
