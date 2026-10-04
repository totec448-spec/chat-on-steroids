// Production renderer and real Chromium layout/input; synthetic conversations only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'inline-subagent-cards'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 const old=window.api,f=composerFixture,now=Date.now(),ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 const stored=text=>({text,chars:text.length,truncated:false});
 let seq=0;
 const base=kind=>({seq:++seq,time:now+seq*1000,source:'app',kind,turnId:'long-turn'});
 const tool=(name,args,title)=>({...base('tool_call'),source:'mcp',agent:'prime',call:{callId:'fixture-call-'+seq,tool:name,
  args:stored(JSON.stringify(args)),result:stored('Verified synthetic fixture output.'),summary:{kind:name==='agents'?'agents':'run',title,tone:'good'},
  outcome:'ok',attribution:'request_id',requestId:'synthetic-request',conversationId:'preview-chat',durationMs:120}});
 const prose=text=>({...base('assistant_message'),source:'extension',messageId:'prose-'+seq,message:stored(text),state:'final',final:true});
 const report=(worker,text)=>({...base('agent_message'),agent:'prime',messageId:'report-'+seq,from:worker,to:'prime',delivery:'delivered',message:stored(text)});
 const recap=label=>({...base('page_tool'),source:'extension',messageId:'recap-'+seq,label});
 f.summary.title='Verify the dashboard changes';
 f.events.splice(0,f.events.length,
  {...base('user_message'),source:'extension',messageId:'long-ask',message:stored('Review the dashboard changes, use workers for focused checks, and verify the final behavior.')},
  prose('I will inspect the current behavior, ask workers to review the tests and layout, then verify the combined change.'),
  tool('exec_command',{cmd:'rg --files src test'},'Listed source and test files'),
  tool('agents',{action:'message',to:'worker-1',text:'Inspect the test coverage.'},'Asked worker-1 to inspect tests'),
  tool('agents',{action:'message',to:'worker-2',text:'Check the dashboard layout.'},'Asked worker-2 to inspect layout'),
  report('worker-1','The existing tests cover selection and queue ownership. Add a case for history refresh during reading.'),
  report('worker-2','The narrow layout is readable. Keep worker history height-bounded with its own scroll.'),
  recap('Reviewed tests and layout with workers'),
  prose('Both reviews agree on preserving the prime selection. I am adding the focused regression and checking the narrow layout.'),
  tool('exec_command',{cmd:'npm run typecheck'},'Typechecked the change'),
  tool('exec_command',{cmd:'npm test -- renderer-agent-panel'},'Verified worker history tests'),
  tool('agents',{action:'message',to:'worker-1',text:'Verify the final tests.'},'Asked worker-1 to verify the final tests'),
  report('worker-1','The new race checks pass. A collapsed or retired history view cannot publish stale results.'),
  recap('Verified the focused regression with worker-1'),
  prose('The identity checks pass. I will now check the real renderer and the production bundle.'),
  tool('exec_command',{cmd:'npm run build'},'Built the production renderer'),
  tool('exec_command',{cmd:'npm run verify:ui'},'Checked real Electron layout'),
  tool('agents',{action:'message',to:'worker-2',text:'Review the final narrow layout.'},'Asked worker-2 to review the final layout'),
  report('worker-2','The composer stays on the prime. Worker history scrolls independently and round links retain their context.'),
  report('worker-1','Verified the final build and tests. No regressions found in the checked flows.'),
  recap('Verified the build and final layout with workers'),
  prose('Build and renderer checks passed. The workers reviewed the tests and layout; their reports remain in the rounds above.')
 );
 f.controls.activeTurnId='long-turn'; f.summary.activeTurnId='long-turn'; f.summary.lastTurnOutcome=null;
 const workers=[1,2].map(n=>({...f.summary,id:'worker-local-'+n,title:'worker-'+n+' · '+(n===1?'Verify tests':'Review layout'),
  conversationId:'worker-chat-'+n,activeTurnId:null,lastTurnOutcome:'completed',toolCalls:24,
  origin:{kind:'worker',fromSessionId:f.summary.id,agentId:'worker-'+n,task:n===1?'Verify the dashboard tests':'Review the final narrow layout'},
  selectedModel:{conversationId:'worker-chat-'+n,model:'gpt-6-sol',reasoningEffort:'high',observedAt:now}}));
 const history=Array.from({length:48},(_,i)=>({seq:i+1,time:now+i,source:'extension',kind:'assistant_message',
  messageId:'worker-result-'+i,message:stored('Verification step '+(i+1)+': checked selection, history refresh, keyboard navigation and narrow layout. The prime composer remains intact.'),final:true,state:'final'}));
 window.workerReads=[];
 window.appendPrimeOutput=()=>{f.events.push(prose('Additional live prime output: verification is continuing.'));f.emit('onSessionChanged',{allTranscripts:true});};
 window.refreshWorker=()=>{workers[0].updatedAt++;f.emit('onSessionChanged',{sessionIds:[workers[0].id]});};
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);return r;},
  listSessions:()=>ok({sessions:[{...f.summary,events:f.events.length},...workers],activeId:f.summary.id,pressure:[]}),
  getSession:(id,options)=>{if(id.startsWith('worker-local-')){window.workerReads.push(id);return ok({summary:workers.find(w=>w.id===id),events:history,total:history.length,nextFrom:history.length+1});}return old.getSession(id,options);}
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'inline-history-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1440,height:1200,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(180);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('#sessionList [data-id="composer-preview"]')`);
  await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`);
  await until(`document.querySelectorAll('#timeline .activity-worker').length===5`);
  assert.equal(await js(`document.getElementById('timeline').nextElementSibling.id`),'inputQueue');
  assert.equal(await js(`workerReads.length`),0,'Collapsed cards do not load worker transcripts');
  await js(`document.querySelectorAll('#timeline .tool-group').forEach(group=>group.open=true);document.getElementById('chatBody').scrollTop=1e9`);
  await capture('long-collapsed.png');
  await js(`document.getElementById('chatInput').value='Keep the prime draft';document.getElementById('chatInput').dispatchEvent(new Event('input'));
    document.querySelector('#inlineAgents details').open=true`);
  await until(`document.querySelectorAll('#inlineAgents .agent-panel-row').length===2`);
  assert.equal(await js(`workerReads.length`),0,'Opening the index is still lazy');
  assert.equal(await js(`document.querySelectorAll('#inlineAgents .agent-round-link').length`),5);
  await js(`document.querySelector('#inlineAgents .agent-panel-row').click()`);
  await until(`document.querySelectorAll('#inlineAgents .ev-assistant_message').length===48`);
  await js(`document.getElementById('chatBody').scrollTop=1e9`);
  await capture('long-open.png');
  const geometry=await js(`(()=>{const main=document.getElementById('chatBody'),body=document.querySelector('#inlineAgents .agent-panel-body');
    const edge=main.getBoundingClientRect(),visible=selector=>[...document.querySelectorAll(selector)].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>edge.top&&r.top<edge.bottom}).length;
    return {height:body.getBoundingClientRect().height,mainHeight:main.clientHeight,scrollable:body.scrollHeight>body.clientHeight,
      overscroll:getComputedStyle(body).overscrollBehaviorY,tools:visible('#timeline .tool'),messages:visible('#timeline .agent-communication')};})()`);
  assert.ok(geometry.height<=361 && geometry.height<geometry.mainHeight/2 && geometry.scrollable,JSON.stringify(geometry));
  assert.equal(geometry.overscroll,'contain');
  assert.ok(geometry.tools>=2 && geometry.messages>=1,'Long open screenshot retains visible round context: '+JSON.stringify(geometry));
  // Real wheel input inside worker history must not scroll or page the prime.
  await js(`document.querySelector('#inlineAgents .agent-panel-body').scrollTop=300`);
  const mainTop=await js(`document.getElementById('chatBody').scrollTop`);
  const pointer=await js(`(()=>{const r=document.querySelector('#inlineAgents .agent-panel-body').getBoundingClientRect();return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({type:'mouseWheel',...pointer,deltaX:0,deltaY:100,canScroll:true});
  await until(`document.querySelector('#inlineAgents .agent-panel-body').scrollTop===200`);
  assert.equal(await js(`document.getElementById('chatBody').scrollTop`),mainTop);
  const workerTop=await js(`document.querySelector('#inlineAgents .agent-panel-body').scrollTop`);
  assert.notEqual(workerTop,300,'Wheel reaches the independent worker scroller');
  await js(`appendPrimeOutput()`);
  await until(`document.getElementById('timeline').textContent.includes('Additional live prime output')`);
  assert.ok(Math.abs(await js(`document.getElementById('chatBody').scrollTop`)-mainTop)<=2,'Prime output does not pull the inspection');
  assert.equal(await js(`document.querySelector('#inlineAgents .agent-panel-body').scrollTop`),workerTop);
  await js(`refreshWorker()`);await until(`workerReads.length===2`);await settle();
  assert.equal(await js(`document.querySelector('#inlineAgents .agent-panel-body').scrollTop`),workerTop,'Worker refresh preserves its reading position');
  await js(`document.querySelector('#inlineAgents .agent-round-link').click()`);
  assert.equal(await js(`document.activeElement.closest('.tool-group')!==null`),true,'Round link focuses the actual timeline round');
  assert.equal(await js(`document.getElementById('chatInput').value`),'Keep the prime draft');
  assert.equal(await js(`document.querySelector('.sess.is-sel').dataset.id`),'composer-preview');
  await js(`document.querySelector('#workDockRight [data-view="agents"]').click()`);
  await until(`document.querySelectorAll('.work-dock-body .agent-panel-row').length===2`);
  assert.equal(await js(`document.querySelectorAll('#inlineAgents .ev-assistant_message').length`),48,'Dock and inline selections are independent');
  await js(`document.getElementById('rightDockToggle').click();document.getElementById('jumpLatest').click()`);
  await until(`Math.abs(document.getElementById('chatBody').scrollHeight-document.getElementById('chatBody').clientHeight-document.getElementById('chatBody').scrollTop)<=2`);
  assert.ok(await js(`Math.abs(document.getElementById('chatBody').scrollHeight-document.getElementById('chatBody').clientHeight-document.getElementById('chatBody').scrollTop)<=2`),'Jump to latest resumes following');
  win.setContentSize(760,960);await until('innerWidth===760');await settle();
  assert.equal(await js(`document.getElementById('chatBody').scrollWidth<=document.getElementById('chatBody').clientWidth+1`),true,'No narrow-layout overflow');
  assert.equal(await js(`(()=>{const card=document.querySelector('#inlineAgents details');return card.scrollWidth<=card.clientWidth+1})()`),true,'Inline history remains inside its card');
  await capture('long-narrow.png');
  assert.deepEqual(errors,[]);
  console.log('PASS: inline worker history, round links, live output, wheel input, refresh and narrow layout');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
