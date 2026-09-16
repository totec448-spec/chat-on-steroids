// Isolated real Electron renderer; no production userData, bridge or provider calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/chat-switch');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const deadline=setTimeout(()=>{console.error('Renderer probe exceeded 45 seconds');app.exit(1)},45000);
  const { createServer } = await import('vite');
  const fixture = `
    const config = {
      roots:[{name:'fixture',path:'C:/fixture'}], readOnly:true, capabilities:{read:true,browse:true},
      tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui:{theme:'dark',autoConnect:false}, sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},
      compaction:{auto:true,autoTokens:300000}, multiAgent:{enabled:false,maxWorkers:2},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}
    };
    const state = {config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,
      status:{state:'disconnected',surfaces:[]},bridge:{running:false,paired:false,present:false},
      update:{current:'fixture',latest:null,stage:'idle'}};
    const sessions = ['a','b'].map((id,index)=>({id,title:'Chat '+id,conversationId:'chat-'+id,
      chatIds:['chat-'+id],startedAt:1,updatedAt:2-index,endedAt:2,events:1,userMessages:1,
      toolCalls:0,lastToolCallAt:null,estimatedTokens:10,contextTokens:10,errors:0,
      lastHandoffId:null,lastTurnOutcome:null,activeTurnId:null,agents:[],origin:null}));
    window.inputs=[]; window.extra=[];
    const detail = id=>({summary:sessions.find(s=>s.id===id),total:1+window.extra.length,nextFrom:2+window.extra.length,events:[{
      seq:1,time:1,source:'extension',kind:'user_message',messageId:id,
      message:{text:'Transcript '+id,truncated:false,chars:12}},...window.extra]});
    const ok=data=>Promise.resolve({ok:true,data});
    window.pending=[]; window.hold=false;
    window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok([]),listProjects:()=>ok([]),
      listSessions:()=>ok({sessions,total:2,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      getSession:id=>window.hold?new Promise(resolve=>window.pending.push({id,resolve})):ok(detail(id)),
      getSessionControls:()=>ok({automation:'off',objective:'',blocked:'',job:null}),
      listInputs:()=>ok(structuredClone(window.inputs)),listPausedHelpers:()=>ok([]),
      onSessionChanged:listener=>{window.changed=listener;return ()=>{}},
      getSwarm:()=>ok({running:false,agents:[],pendingReports:0}),
      getChatModels:()=>ok({state:'unknown',models:[]})
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    window.complete=()=>{const p=window.pending.shift();p.resolve({ok:true,data:detail(p.id)})};
    await import('/main.ts');
    window.fixtureReady=true;
  `;
  const server = await createServer({configFile:false,root:path.join(root,'src/renderer'),
    server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'chat-switch-fixture',configureServer(vite) {
      vite.middlewares.use('/fixture.html',async (_request,response)=>{
        const html=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
          .replace('</body>','<script type="module">'+fixture+'</script></body>');
        response.setHeader('Content-Type','text/html');
        response.end(await vite.transformIndexHtml('/fixture.html',html));
      });
    }}]});
  let win;
  try {
    await server.listen(); fs.mkdirSync(output,{recursive:true});
    win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    const js=code=>win.webContents.executeJavaScript(code);
    const until=async predicate=>{
      for(let i=0;i<100;i++) { if(await js(predicate)) return; await new Promise(r=>setTimeout(r,30)); }
      throw new Error('Renderer did not reach: '+predicate+' '+await js(`JSON.stringify({ready:window.fixtureReady,rows:document.querySelectorAll('#sessionList [data-id]').length,toasts:document.getElementById('toasts')?.textContent,body:document.body.innerText.slice(-1600)})`));
    };
    await until('window.fixtureReady && document.querySelectorAll("#sessionList [data-id]").length===2');
    console.log('Fixture ready');
    await js(`document.querySelector('#sessionList [data-id="a"]').click()`);
    await until(`document.getElementById('timeline').textContent.includes('Transcript a')`);
    await js(`window.hold=true;document.querySelector('#sessionList [data-id="b"]').click()`);
    await until('window.pending.length===1');
    // Sample every paint, deliberately holding IPC much longer than the reported flash.
    const frames=await js(`new Promise(resolve=>{const frames=[];function frame(){
      const timeline=document.getElementById('timeline');
      frames.push({text:timeline.textContent,inert:timeline.inert,welcome:!document.getElementById('timelineEmpty').hidden});
      if(frames.length===12)resolve(frames);else requestAnimationFrame(frame);
    }requestAnimationFrame(frame)})`);
    assert.ok(frames.every(f=>f.text.includes('Transcript a') && f.inert && !f.welcome));
    console.log('Selection frames passed');
    fs.writeFileSync(path.join(output,'pending.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await js('window.complete()');
    await until(`document.getElementById('timeline').textContent.includes('Transcript b')`);
    assert.equal(await js(`document.getElementById('timeline').inert`),false);
    assert.equal(await js(`document.getElementById('timelineEmpty').hidden`),true);
    fs.writeFileSync(path.join(output,'loaded.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await js(`window.hold=false;window.inputs=[{id:'delivery',sessionId:'b',conversationId:'chat-b',state:'browser',owner:'page',text:'Exactly one follow-up',mode:'auto',model:null,reasoningEffort:null,createdAt:3,dueAt:3}];window.changed()`);
    await until(`document.querySelector('#inputQueue .pending-message')?.textContent.includes('Exactly one follow-up')`);
    console.log('Delivery row ready');
    const deliveryFrames=await js(`new Promise(resolve=>{const frames=[];let n=0;function frame(){
      frames.push({count:[...document.querySelectorAll('#timeline .said.is-user,#inputQueue .pending-message')].filter(el=>el.textContent.includes('Exactly one follow-up')).length,
        previous:document.getElementById('timeline').textContent.includes('Transcript b'),welcome:!document.getElementById('timelineEmpty').hidden});
      if(++n===8){window.inputs[0]={...window.inputs[0],state:'sent',messageId:'native-followup',deliveredAt:4,historyAnchored:true};window.changed()}
      if(n===48){window.extra=[{seq:2,time:4,source:'app',kind:'user_message',messageId:'native-followup',inputId:'delivery',message:{text:'Exactly one follow-up',chars:21,truncated:false}}];window.changed()}
      if(n===100)resolve(frames);else requestAnimationFrame(frame);
    }requestAnimationFrame(frame)})`);
    assert.ok(deliveryFrames.every(f=>f.count===1 && f.previous && !f.welcome),JSON.stringify(deliveryFrames));
    await until(`document.getElementById('timeline').textContent.includes('Exactly one follow-up') && !document.querySelector('#inputQueue .pending-message')`);
    await js(`document.getElementById('newChat').click()`);
    assert.equal(await js(`document.getElementById('timelineEmpty').hidden`),false);
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,frames,deliveryFrames},null,2));
    console.log('PASS: retained transcript across selection and 100 delivery frames; exactly one message; explicit New Chat welcome.');
  } finally { clearTimeout(deadline);win?.destroy(); await server.close(); }
}).then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
