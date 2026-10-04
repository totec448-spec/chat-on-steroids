// Real production renderer with synthetic IPC; no provider or installed app data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const before = process.argv.includes('--before'), feature = 'inline-recorded-diffs';
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', feature));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 const old=window.api,f=composerFixture,now=Date.now(),ok=data=>Promise.resolve({ok:true,data});
 const stored=text=>({text,chars:text.length,truncated:false});
 const tool=(seq,name,args,summary,changes)=>({seq,time:now+seq,source:'mcp',kind:'tool_call',turnId:'t-1',call:{callId:'00000000-0000-4000-8000-00000000000'+seq,tool:name,args:stored(JSON.stringify(args)),result:stored(name==='apply_patch'?'Edited src/app.ts':'Build passed'),summary,changes,outcome:'ok',attribution:'request_id',requestId:'synthetic-request',conversationId:'preview-chat',durationMs:120}});
 f.events.splice(1,0,
  tool(2,'exec_command',{cmd:'npm run build'},{kind:'run',title:'Ran npm run build',tone:'good'}),
  tool(3,'read',{paths:['src/app.ts','package.json']},{kind:'read',title:'Read 2 files',tone:'neutral'}),
  tool(4,'apply_patch',{patch:'*** Begin Patch\\n*** Update File: src/app.ts\\n@@\\n-old\\n+new\\n*** End Patch'},{kind:'edit',title:'Edited src/app.ts',tone:'good'},[{path:'src/app.ts',added:1,removed:1,approximate:false,reviewAssetId:'synthetic-edit'}]));
 f.events.at(-1).seq=5;
 const worker={...f.summary,id:'worker-local',title:'Verify the build',conversationId:'worker-chat',toolCalls:3,origin:{kind:'worker',fromSessionId:f.summary.id,agentId:'worker-1',task:'Verify the build'},selectedModel:null,lastTurnOutcome:'completed'};
 window.capturedClipboard=null;
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);return r;},
  listSessions:()=>ok({sessions:[f.summary],activeId:f.summary.id,pressure:[]}),
  getToolEditReview:()=>ok({callId:'00000000-0000-4000-8000-000000000004',changeIndex:0,path:'src/app.ts',added:1,removed:1,baseText:'const value = "before";\\n',currentText:'const value = "after";\\n'}),
  writeClipboard:value=>{window.capturedClipboard=value;return ok(true);},
  getSession:id=>id==='worker-local'?ok({summary:worker,events:[{seq:1,time:now,source:'extension',kind:'assistant_message',messageId:'synthetic-worker-result',message:stored('Build verified. No regressions found.'),final:true,state:'final'}],total:1,nextFrom:2}):old.getSession(id)
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async()=>{
 const {createServer}=await import('vite');
 server=await createServer({configFile:false,root:path.join(root,'src/renderer'),cacheDir:path.join(output,'vite'),logLevel:'error',resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},plugins:[{name:'approved-timeline-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}]});
 await server.listen();
 win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
 const js=code=>win.webContents.executeJavaScript(code).catch(error=>{console.error('Renderer expression:',code);throw error;});
 const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
 await win.loadURL(server.resolvedUrls.local[0]);
 await until(`!!document.querySelector('#sessionList [data-id="composer-preview"]')`);
 await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`);
 await until(`document.querySelectorAll('#timeline .tool').length===3`);
 await js(`document.querySelector('.tool-group').open=true;const tool=document.querySelectorAll('#timeline details.tool')[2];tool.open=true;tool.dispatchEvent(new Event('toggle'))`);await pause(100);
 if(!before){
  await js(`document.querySelector('.edit-card').open=true`);
  await until(`document.querySelectorAll('.diff-line.is-added').length===1`);
  assert.equal(await js(`document.querySelector('.diff-line.is-added .diff-gutter:nth-child(2)').textContent`),'1');
  await js(`document.querySelector('.edit-card .tool-copy').click()`);
  assert.equal(await js(`document.querySelector('.edit-card .tool-copy').textContent`),'Copy file');
  assert.equal(await js('capturedClipboard'),'const value = "after";\n');
  await js(`document.querySelectorAll('.edit-card .tool-copy')[1].click()`);
  assert.equal(await js(`document.querySelector('.edit-card').classList.contains('is-expanded')`),true);
 }
 await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);
 await pause(150);
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,before?'before.png':'after.png'),(await win.webContents.capturePage()).toPNG());
 if(!before){
  assert.equal(await js(`getComputedStyle(document.querySelector('.diff-code .tok-string')).color`),'rgb(195, 232, 141)','Dark diff uses the dark syntax palette');
  await js(`const theme=document.getElementById('appearanceTheme');theme.value='light';theme.dispatchEvent(new Event('change',{bubbles:true}))`);
  await until(`document.documentElement.dataset.theme==='light' && getComputedStyle(document.documentElement).getPropertyValue('--page').trim()!=='#191919'`);
  await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(150);
  assert.equal(await js(`getComputedStyle(document.querySelector('.diff-code .tok-string')).color`),'rgb(4, 120, 87)','Light diff uses the light syntax palette');
  assert.equal(await js(`getComputedStyle(document.querySelector('.unified-diff')).getPropertyValue('--syntax-string').trim()`),await js(`getComputedStyle(document.querySelector('.file-panel')).getPropertyValue('--syntax-string').trim()`),'Diff and file viewer share the selected theme palette');
  fs.writeFileSync(path.join(output,'light.png'),(await win.webContents.capturePage()).toPNG());
  win.setContentSize(760,960);await until('innerWidth===760');await pause(150);
  assert.equal(await js(`document.getElementById('chatBody').scrollWidth<=document.getElementById('chatBody').clientWidth+1`),true,'Diff stays within the narrow chat viewport');
  assert.equal(await js(`getComputedStyle(document.querySelector('.edit-card .tool-copy')).opacity`),'1','Copy remains visible outside hover');
  assert.notEqual(await js(`getComputedStyle(document.querySelector('.diff-code .tok-keyword')).color`),await js(`getComputedStyle(document.querySelector('.diff-code')).color`),'Syntax shares the file-viewer palette');
 }
 assert.deepEqual(errors,[]);console.log('PASS: '+feature+(before?' baseline screenshot':' geometry and interaction checks'));
 win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
