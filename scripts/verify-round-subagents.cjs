// Production renderer and real Chromium layout/input; synthetic conversations only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'round-subagents'));
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
    plugins:[{name:'round-workers-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1440,height:1200,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression+'; '+JSON.stringify(await js(`({focus:document.activeElement?.outerHTML,panels:[...document.querySelectorAll('.agent-panel')].map(p=>({hidden:p.hidden,rows:p.querySelectorAll('.agent-panel-row').length})),errors:document.body.textContent.slice(-300)})`))); };
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(180);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('#sessionList [data-id="composer-preview"]')`);
  await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`);
  await until(`document.querySelectorAll('#timeline .activity-workers:not([hidden])').length===3`);
  assert.equal(await js(`document.getElementById('timeline').nextElementSibling.id`),'inputQueue');
  assert.equal(await js(`document.getElementById('inlineAgents')===null`),true,'No aggregate history card');
  assert.equal(await js(`workerReads.length`),0,'Round indicators never load worker transcripts');
  assert.deepEqual(await js(`[...document.querySelectorAll('#timeline .activity-workers')].map(b=>b.textContent)`),['2','1','2']);
  await js(`document.getElementById('chatInput').value='Keep the prime draft';document.getElementById('chatInput').dispatchEvent(new Event('input'));
    document.querySelector('#timeline .tool-group').open=true;document.getElementById('chatBody').scrollTop=0`);
  await capture('after-timeline.png');
  assert.equal(await js(`getComputedStyle(document.querySelector('#timeline .activity-workers')).display`),'none','Indicators appear only on collapsed rounds');
  win.show(); win.focus(); win.webContents.focus(); await pause(100);
  await js(`document.querySelectorAll('#timeline .activity-workers')[2].scrollIntoView({block:'nearest'});document.querySelectorAll('#timeline .activity-workers')[2].focus({preventScroll:true})`);
  await settle();
  const readerTop=await js(`document.getElementById('chatBody').scrollTop`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await until(`document.querySelectorAll('#workDockRight .is-round-worker').length===2`);
  await settle();
  assert.equal(await js(`workerReads.length`),0,'Opening the highlighted overview is lazy');
  assert.equal(await js(`document.querySelectorAll('#timeline .tool-group')[2].open`),false,'Indicator does not expand its round');
  assert.ok(Math.abs(await js(`document.getElementById('chatBody').scrollTop`)-readerTop)<=2,'Opening the dock keeps the reader: '+JSON.stringify({before:readerTop,after:await js(`document.getElementById('chatBody').scrollTop`)}));
  await capture('after-inspection.png');
  await js(`document.querySelectorAll('#timeline .activity-workers')[1].click()`);
  assert.deepEqual(await js(`[...document.querySelectorAll('#workDockRight .is-round-worker')].map(r=>r.dataset.workerSession)`),['worker-local-1']);
  await js(`document.querySelector('#workDockRight .is-round-worker').click()`);
  await until(`document.querySelectorAll('#workDockRight .ev-assistant_message').length===48`);
  const mainTop=await js(`document.getElementById('chatBody').scrollTop`);
  await js(`document.querySelector('#workDockRight .agent-panel-body').scrollTop=300`);
  const workerTop=await js(`document.querySelector('#workDockRight .agent-panel-body').scrollTop`);
  await js(`appendPrimeOutput()`);
  await until(`document.getElementById('timeline').textContent.includes('Additional live prime output')`);
  assert.ok(Math.abs(await js(`document.getElementById('chatBody').scrollTop`)-mainTop)<=2,'Prime output does not pull the reader');
  assert.equal(await js(`document.querySelector('#workDockRight .agent-panel-body').scrollTop`),workerTop);
  await js(`refreshWorker()`);await until(`workerReads.length===2`);await settle();
  assert.equal(await js(`document.querySelector('#workDockRight .agent-panel-body').scrollTop`),workerTop,'Worker refresh preserves reading position');
  assert.equal(await js(`document.getElementById('chatInput').value`),'Keep the prime draft');
  assert.equal(await js(`document.querySelector('.sess.is-sel').dataset.id`),'composer-preview');
  await capture('after-history.png');
  await js(`document.getElementById('rightDockToggle').click();document.getElementById('jumpLatest').click()`);
  await until(`Math.abs(document.getElementById('chatBody').scrollHeight-document.getElementById('chatBody').clientHeight-document.getElementById('chatBody').scrollTop)<=2`);
  win.setContentSize(760,960);await until('innerWidth===760');await settle();
  assert.equal(await js(`document.getElementById('chatBody').scrollWidth<=document.getElementById('chatBody').clientWidth+1`),true,'No narrow-layout overflow');
  await capture('after-narrow.png');
  assert.deepEqual(errors,[]);
  console.log('PASS: round counts, keyboard activation, dock highlights, lazy history, live output, refresh and narrow layout');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
