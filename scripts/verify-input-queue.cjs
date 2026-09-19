// Real Chromium and production renderer; isolated API fixture, no provider or live outbox.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = process.argv[2] ? path.resolve(root, process.argv[2]) : path.join(root, '.tmp/message-send-20260918/ui');
app.setPath('userData', path.join(output, 'runtime'));

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    addEventListener('error', event => window.fixtureError = event.message);
    addEventListener('unhandledrejection', event => window.fixtureError = String(event.reason?.stack ?? event.reason));
    const ok = data => Promise.resolve({ok:true,data});
    const config = {
      roots:[{name:'fixture',path:'C:/fixture'}],readOnly:true,capabilities:{browse:true,search:true,read:true,metadata:true},
      tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui:{theme:'dark',autoConnect:false,minimizeToTray:true,privacyScreenshots:false},
      sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},
      compaction:{auto:false,autoTokens:300000},multiAgent:{enabled:false,maxWorkers:2},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}
    };
    const state={config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,health:null,surfaces:[]},
      bridge:{running:false,paired:false,present:false,port:0},update:{current:'fixture',stage:'idle'}};
    const session={id:'queue-fixture-session',title:'Message delivery',conversationId:'fixture-chat',chatIds:['fixture-chat'],
      selectedModel:{conversationId:'fixture-chat',model:'gpt-5.6-sol',reasoningEffort:'high',observedAt:1},
      startedAt:1,updatedAt:1,endedAt:null,events:0,userMessages:0,toolCalls:0,lastToolCallAt:null,
      processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,estimatedTokens:0,contextTokens:0,
      lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:null,activeTurnId:'fixture-turn',agents:[],origin:null};
    window.queueFixture={inputs:[],sent:[],files:[],events:[],session,controls:{}};
    const live=window.queueFixture;
    window.api=new Proxy({
      getState:()=>ok(state),getLog:()=>ok([]),listProjects:()=>ok([]),
      getSwarm:()=>ok({running:false,agents:[],maxWorkers:2,pendingReports:0}),
      listSessions:()=>ok({sessions:[session],activeId:null,pressure:[]}),
      getSession:(_id,options={})=>ok({summary:session,events:live.events.filter(event=>event.seq>=(options.from??0)),
        total:live.events.length,nextFrom:(live.events.at(-1)?.seq??-1)+1}),
      getSessionControls:()=>ok({sessionId:session.id,activeTurnId:'fixture-turn',canInject:true,automation:'off',objective:'',...live.controls}),
      getChatModels:()=>ok({state:'ready',observedAt:Date.now(),models:[{id:'gpt-5.6-sol',label:'GPT-5.6 Sol',efforts:['high']}]}),
      listInputs:()=>ok(structuredClone(live.inputs)),listPausedHelpers:()=>ok([]),
      onSessionChanged:fn=>{live.notify=fn;return ()=>{}},chooseFiles:()=>ok(live.files),
      editQueuedInput:(id,text)=>{const row=live.inputs.find(r=>r.id===id);if(!row||row.state!=='queued')return ok(false);row.text=text.trim();return ok(true)},
      cancelInput:id=>{const row=live.inputs.find(r=>r.id===id);if(!row)return ok(false);row.state='cancelled';return ok(true)},
      sendInput:input=>{live.sent.push(input);const row={...input,state:'queued',owner:null,createdAt:Date.now(),conversationId:session.conversationId};live.inputs.push(row);return ok(row)}
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    window.fixtureReady=true;
  `;
  const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'queue-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_request, response) => {
        const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace('</body>', '<script type="module">' + fixture + '</script></body>');
        response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml('/fixture.html', source));
      });
    } }] });
  let win;
  try {
    fs.mkdirSync(output, { recursive: true }); await server.listen();
    win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true, backgroundThrottling: false } });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async condition => {
      for (let i = 0; i < 160; i++) {
        if (await js(condition)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Renderer condition timed out: ' + condition + ' ' + JSON.stringify(await js('({ready:!!window.fixtureReady,error:window.fixtureError})')));
    };
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const checks = [];
    await wait('window.fixtureReady && !!document.querySelector("#sessionList [data-id]")');
    await click('#sessionList [data-id]');
    const seed = async () => {
      await js(`queueFixture.inputs=[{id:'editable-task',sessionId:queueFixture.session.id,text:'Review the attached screenshots',mode:'after-turn',dueAt:0,
        state:'queued',owner:null,createdAt:0,conversationId:'fixture-chat',model:null,reasoningEffort:null}];queueFixture.notify()`);
      await wait('!!document.querySelector("#finishQueue [aria-label=\\"Edit queued task\\"]")');
      await click('#finishQueue [aria-label="Edit queued task"]');
    };
    await seed();
    for (const width of [1100, 640]) {
      win.setSize(width, 800);
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const geometry = await js(`(() => {
        const field=document.querySelector('#finishQueue textarea'), save=field.nextElementSibling, trash=save.nextElementSibling;
        const a=field.getBoundingClientRect(),b=save.getBoundingClientRect(),c=trash.getBoundingClientRect();
        return {fieldWidth:a.width,fieldRight:a.right,saveLeft:b.left,saveBottom:b.bottom,trashTop:c.top,trashRight:c.right,viewport:innerWidth};
      })()`);
      assert.ok(geometry.fieldWidth > 40 && geometry.fieldRight <= geometry.saveLeft && geometry.trashTop >= geometry.saveBottom, JSON.stringify(geometry));
      assert.ok(geometry.trashRight <= geometry.viewport, JSON.stringify(geometry));
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await new Promise(resolve => setTimeout(resolve, 150));
      fs.writeFileSync(path.join(output, `editor-${width}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      checks.push({ width, ...geometry });
    }
    await js(`const field=document.querySelector('#finishQueue textarea');field.value='  ';field.nextElementSibling.click()`);
    await wait('document.getElementById("finishQueue").hidden');
    assert.equal(await js('queueFixture.inputs[0].state'), 'cancelled'); checks.push('empty Save cancels');
    await seed(); await click('#finishQueue [aria-label="Remove queued task"]');
    await wait('document.getElementById("finishQueue").hidden'); checks.push('Trash cancels while editing');
    await seed();
    assert.equal(await js(`document.getElementById('newChat').click();document.getElementById('finishQueue').hidden && !document.querySelector('#finishQueue textarea')`), true);
    checks.push('New Chat retires editor synchronously');
    await click('#sessionList [data-id]');
    await seed();
    await js(`queueFixture.inputs[0].state='cancelled';document.querySelector('#finishQueue textarea').nextElementSibling.click()`);
    await wait('document.getElementById("finishQueue").hidden'); checks.push('missing queue row retires editor');
    await js(`queueFixture.inputs=[{id:'deferred-upload',sessionId:queueFixture.session.id,text:'Native upload waiting',mode:'after-turn',requestedMode:'auto',dueAt:0,
      state:'queued',owner:null,createdAt:0,conversationId:'fixture-chat',model:null,reasoningEffort:null}];queueFixture.notify()`);
    await wait('!!document.querySelector("#inputQueue [data-input-id=\\"deferred-upload\\"] [aria-label=\\"Cancel delivery\\"]")');
    assert.equal(await js('document.getElementById("finishQueue").hidden'), true); checks.push('deferred upload remains visible and cancellable');
    await click('#inputQueue [aria-label="Cancel delivery"]');
    await js(`(() => {
      const deadline=Date.now()+60_000;
      queueFixture.controls={automation:'loop',objective:'Finish the requested work',goalWait:{reason:'listening',until:deadline},
        recovery:[{kind:'post-reload',next:'continue',generating:true,deadline}]};
      queueFixture.inputs=[{id:'recovery-continue',sessionId:queueFixture.session.id,text:'Continue until the requested task is finished.',
        mode:'after-turn',dueAt:0,state:'queued',owner:null,createdAt:0,conversationId:'fixture-chat',model:null,reasoningEffort:null,
        recovery:{questionId:'fixture-question',pro:false,busyUntil:deadline,phase:'ready'}}];
      queueFixture.notify();
    })()`);
    await wait('!!document.querySelector("#finishQueue [aria-label=\\"Cancel automatic Continue\\"]") && !!document.querySelector("#recoveryStatus [role=timer]")');
    for (const width of [1100, 640]) {
      win.setSize(width, 800);
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const measured = await js(`(() => {
        const dock=document.getElementById('composerDock'), card=dock.querySelector('[data-input-id="recovery-continue"]');
        const timer=dock.querySelector('#recoveryStatus [role="timer"]'), label=card.querySelector('.queue-label');
        const cancel=card.querySelector('[aria-label="Cancel automatic Continue"]'), bounds=dock.getBoundingClientRect();
        const visibleTimers=[...dock.querySelectorAll('[role="timer"]')].filter(node=>node.getBoundingClientRect().width>0);
        return {timers:visibleTimers.length,goalHidden:document.getElementById('goalLifecycle').hidden,
          controlsVisible:!document.getElementById('activeGoalRow').hidden,label:label.textContent,title:label.title,
          editable:!!card.querySelector('[aria-label="Edit queued task"]'),draggable:label.draggable,
          fits:[timer,cancel].every(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.left>=bounds.left&&r.right<=bounds.right}),
          error:window.fixtureError||null};
      })()`);
      assert.equal(measured.timers, 1); assert.equal(measured.goalHidden, true); assert.equal(measured.controlsVisible, true);
      assert.ok(measured.label.startsWith('Automatic Continue')); assert.ok(measured.title.includes('without a final answer'));
      assert.equal(measured.editable, false); assert.equal(measured.draggable, false); assert.equal(measured.fits, true); assert.equal(measured.error, null);
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await new Promise(resolve => setTimeout(resolve, 150));
      fs.writeFileSync(path.join(output, `recovery-dock-${width}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      checks.push({recoveryWidth:width,...measured});
    }
    await js('queueFixture.controls.goalWait.until+=15_000;queueFixture.notify()');
    await wait('!document.getElementById("goalLifecycle").hidden && document.querySelectorAll("#composerDock [role=timer]").length===2');
    checks.push('independent Loop deadline remains visible');
    await click('#finishQueue [aria-label="Cancel automatic Continue"]');
    await wait('document.getElementById("finishQueue").hidden');
    assert.equal(await js('queueFixture.inputs[0].state'), 'cancelled'); checks.push('automatic Continue remains cancellable');
    await js('queueFixture.controls={};queueFixture.notify()');
    await wait('document.getElementById("recoveryStatus").hidden && document.getElementById("goalLifecycle").hidden');
    await js(`(() => {
      const start=Date.now()-240_000;
      queueFixture.events=Array.from({length:4},(_,i)=>({seq:i+1,time:start+i*60_000,source:'extension',kind:'user_message',
        messageId:'question-'+i,message:{text:'Recorded task '+(i+1),chars:15,truncated:false}}));
      queueFixture.session.events=4;queueFixture.session.updatedAt=Date.now();
      queueFixture.inputs=Array.from({length:3},(_,i)=>({id:'cancelled-continue-'+i,sessionId:queueFixture.session.id,
        text:'Continue the task after this interrupted response.',mode:'after-turn',dueAt:0,state:'cancelled',owner:null,
        createdAt:start+i*60_000+10_000,conversationId:'previous-chat-'+i,model:null,reasoningEffort:null,
        error:'Automatic Continue cancelled: the source received new work.',
        recovery:{questionId:'question-'+i,pro:false,busyUntil:start+i*60_000+70_000,phase:'ready'}}));
      queueFixture.notify();
    })()`);
    await wait('document.querySelectorAll("#timeline [data-input-id^=\\"cancelled-continue-\\"]").length===3');
    for (const width of [1100,640]) {
      win.setSize(width,1000);
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const history=await js(`(() => {
        const timeline=document.getElementById('timeline'),content=timeline.textContent;
        const order=Array.from({length:3},(_,i)=>{
          const card=timeline.querySelector('[data-input-id="cancelled-continue-'+i+'"]');
          const before=content.indexOf('Recorded task '+(i+1)),at=content.indexOf(card.textContent),after=content.indexOf('Recorded task '+(i+2));
          return !!card.querySelector('time')&&before<at&&at<after;
        });
        return {order,bottomCards:document.querySelectorAll('#inputQueue [data-input-id^="cancelled-continue-"]').length,
          dates:[...timeline.querySelectorAll('[data-input-id^="cancelled-continue-"] time')].map(time=>time.textContent),error:window.fixtureError||null};
      })()`);
      assert.deepEqual(history.order,[true,true,true]);assert.equal(history.bottomCards,0);assert.equal(history.error,null);
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await new Promise(resolve=>setTimeout(resolve,150));
      fs.writeFileSync(path.join(output,'cancelled-history-'+width+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      checks.push({historyWidth:width,...history});
    }
    for (const count of [7, 10]) {
      await js(`queueFixture.files=Array.from({length:${count}},(_,i)=>({id:'image-'+i,name:'reference-'+i+'.png',mimeType:'image/png',size:42}))`);
      await click('#attachImages');
      await wait(`document.querySelectorAll('#composerImages .image-remove').length === ${count}`);
      assert.equal(await js('document.querySelector("[data-delivery=\\"tool\\"]").hidden'), false);
      await js(`document.getElementById('composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
      await wait(`queueFixture.sent.at(-1)?.attachments.length === ${count}`);
      assert.equal(await js('queueFixture.sent.at(-1).delivery'), 'tool'); checks.push(`${count} images select Inject now`);
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(checks, null, 2));
    console.log(JSON.stringify({ passed: checks.length, output }));
  } finally { win?.destroy(); await server.close(); }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
