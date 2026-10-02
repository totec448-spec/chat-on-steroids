// Production renderer, isolated in-memory evidence. No provider, bridge or user-data writes.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'outputs/desktop-migration');
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `
(() => {
 const old = window.api, f = composerFixture, now = Date.now(), ok = data => Promise.resolve({ok:true,data});
 const project={id:'migration-project',name:'chat-on-steroids',path:'/workspace/chat-on-steroids',createdAt:now};
 f.summary.projectId=project.id;
 const stored=text=>({text,chars:text.length,truncated:false});
 const tool=(seq,tool,args,summary,changes)=>({seq,time:now+seq,source:'mcp',kind:'tool_call',turnId:'t-1',call:{callId:'call-'+seq,tool,args:stored(JSON.stringify(args)),result:stored(tool==='apply_patch'?'{}':'Build passed'),summary,changes,outcome:'ok',attribution:'request_id',attributionMethod:'request_id',requestId:'request',conversationId:'preview-chat',durationMs:120}});
 f.events.splice(1,0,
  tool(2,'exec_command',{cmd:'npm run build'},{kind:'run',title:'Ran npm run build',tone:'good'}),
  tool(3,'read',{paths:['src/app.ts','package.json']},{kind:'read',title:'Read 2 files',tone:'neutral'}),
  tool(4,'apply_patch',{patch:'*** Begin Patch\\n*** Update File: src/app.ts\\n@@\\n-old\\n+new\\n*** End Patch'},{kind:'edit',title:'Edited src/app.ts',tone:'good'},[{path:'src/app.ts',added:1,removed:1,approximate:false,reviewAssetId:'edit'}]));
 f.events.at(-1).seq=5;
 const worker={...f.summary,id:'worker-local',title:'Verify the build',conversationId:'worker-chat',origin:{kind:'worker',fromSessionId:f.summary.id,agentId:'worker-1',task:'Verify the build'},selectedModel:null,lastTurnOutcome:'completed'};
 const methods={
  listProjects:()=>ok([project]),listSessions:()=>ok({sessions:[f.summary,worker],activeId:f.summary.id,pressure:[]}),
  getProjectGitSnapshot:()=>ok({projectId:project.id,state:'ready',revision:'r1',currentBranch:'feat/desktop-layout',changes:[{path:'src/app.ts',status:'M',additions:1,deletions:1,binary:false}],truncated:false}),
  getToolEditReview:()=>ok({callId:'call-4',changeIndex:0,path:'src/app.ts',added:1,removed:1,baseText:'const value = 1;\\n',currentText:'const value = 2;\\n'}),
  getSession:id=>id==='worker-local'?ok({summary:worker,events:[],total:0,nextFrom:1}):old.getSession(id)
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false,root:path.join(root,'src/renderer'),cacheDir:path.join(output,'vite'),logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:4427,strictPort:true,fs:{allow:[root]}},plugins:[{
      name:'migration-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/migration-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/migration-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(__dirname,'fixtures/composer-ui.js'),'utf8')+fixture);});}
    }] });
  await server.listen();
  win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[]; win.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error('Renderer:',e.message);}});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async(expression)=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(await js(expression))return;await pause(40)}throw new Error('Timeout: '+expression)};
  await win.loadURL('http://127.0.0.1:4427');
  await until(`!!document.querySelector('#sessionList [data-id="composer-preview"]')`);
  await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`);await until(`document.getElementById('composerBranch').textContent==='feat/desktop-layout'&&document.querySelectorAll('#inlineAgents .agent-panel-row').length===1`);
  assert.equal(await js(`document.getElementById('composerBranch').textContent`),'feat/desktop-layout');
  assert.equal(await js(`document.getElementById('composerGitStats').textContent`),'+1−1');
  assert.equal(await js(`document.querySelector('#timeline .activity-title').textContent`),'Executed 1 command · Read 2 files · 1 edit');
  assert.ok(await js(`document.querySelector('#workDockRight [data-view=agents]') && !document.querySelector('#workDockRight [data-view=agents]').disabled`));
  assert.equal(await js(`document.querySelectorAll('#inlineAgents .agent-panel-row').length`),1);
  await js(`document.querySelector('.tool-group').open=true;document.querySelectorAll('#timeline .tool')[2].open=true`);await pause(180);
  assert.equal(await js(`document.querySelectorAll('.tool-inspection .pre').length`),0,'Raw payloads stay lazy and out of the visible execution tree');
  await js(`document.querySelector('.edit-card').open=true`);await pause(800);
  assert.equal(await js(`document.querySelectorAll('.diff-line.is-added').length`),1);
  assert.equal(await js(`document.querySelectorAll('.diff-line.is-removed').length`),1);
  assert.equal(await js(`document.querySelector('.diff-line.is-added .diff-gutter:nth-child(2)').textContent`),'1');
  await js(`document.querySelector('#inlineAgents .agent-panel').open=true;document.querySelector('#workDockRight [data-view=agents]').click()`);await pause(200);
  assert.equal(await js(`document.querySelector('#inlineAgents .agent-panel').open`),true);
  assert.equal(await js(`document.querySelector('.agent-sidebar .agent-panel').open`),true);
  await js(`document.getElementById('rightDockToggle').click()`);await pause(250);
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'desktop-layout.png'),(await win.webContents.capturePage()).toPNG());
  for(const width of [1440,1000,760,640]){
    win.setContentSize(width,960);
    await until(`innerWidth===${width}`);
    // Responsive geometry belongs to the resting layout, after the dock's finite
    // entry/exit motion; hidden macOS windows need not advance animations by time.
    await js('document.getAnimations().forEach(animation=>{if(animation.effect.getTiming().iterations!==Infinity)animation.finish()})');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const geometry=await js(`(()=>{const dock=document.getElementById('composer'),toolbar=document.querySelector('.composer-toolbar'),input=document.getElementById('chatInput'),context=document.getElementById('composerContext');const d=dock.getBoundingClientRect(),t=toolbar.getBoundingClientRect(),i=input.getBoundingClientRect(),c=context.getBoundingClientRect();const height=d.height,inputStyle=getComputedStyle(input);const draftLimit=parseFloat(inputStyle.lineHeight)+parseFloat(inputStyle.paddingTop)+parseFloat(inputStyle.paddingBottom)+1;const controls=[...toolbar.querySelectorAll(':scope > :not([hidden])')].filter(e=>getComputedStyle(e).display!=='none').map(e=>{const r=e.getBoundingClientRect();return {id:e.id,left:r.left,right:r.right}});return {width:${width},height,draftHeight:i.height,draftSingleLine:i.height<=draftLimit,overflow:dock.scrollWidth>dock.clientWidth,tiers:c.bottom<=i.top&&i.bottom<=t.top,rects:controls,controls:controls.every(r=>r.left>=d.left&&r.right<=d.right)}})()`);
    // The narrow dock has two toolbar rows; native fonts vary across platforms.
    // Enforce a single-line empty draft and a compact total, not one OS's exact height.
    assert.equal(geometry.draftSingleLine,true,JSON.stringify(geometry));
    assert.ok(geometry.height<200,JSON.stringify(geometry));assert.equal(geometry.overflow,false,JSON.stringify(geometry));assert.equal(geometry.tiers,true,JSON.stringify(geometry));assert.equal(geometry.controls,true,JSON.stringify(geometry));
  }
  const resizeNotifications=errors.filter(message=>message==='ResizeObserver loop completed with undelivered notifications.');
  assert.deepEqual(errors.filter(message=>!resizeNotifications.includes(message)),[]);
  console.log('Chromium resize notifications:',resizeNotifications.length);
  console.log('PASS: compound dock, exact Git context, grouped commands, lazy payload inspection, dual diff gutters, inline and sidebar workers and narrow layout.');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'failure.txt'),error.stack??String(error));
  if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());
  console.error(error);await server?.close();app.exit(1);
});
