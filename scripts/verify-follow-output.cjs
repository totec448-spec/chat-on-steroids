// "Follow new output": the chat stays at its end while its content grows outside a repaint, stops
// following once the reader scrolls up, resumes at the end, and is inert when switched off.
// Isolated real Electron renderer; synthetic session only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const output = path.join(root, 'outputs/follow-output');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    ${fixtureConfigSource()}
    const config = fixtureConfig({
      roots:[{name:'fixture',path:'C:/fixture'}], readOnly:true, capabilities:{read:true,browse:true},
      tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui:{theme:'dark',autoConnect:false}, sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},
      compaction:{auto:true,autoTokens:300000}, multiAgent:{enabled:false,maxWorkers:2},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}
    });
    const state = {config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,
      status:{state:'disconnected',surfaces:[]},bridge:{running:false,paired:false,present:false},
      update:{current:'fixture',latest:null,stage:'idle'}};
    const t=x=>({text:x,truncated:false,chars:x.length});
    const events=[];let seq=1;
    for(let i=0;i<14;i++){events.push({seq,origin:seq,time:seq*1000,source:'extension',kind:'user_message',messageId:'q'+i,message:t('Question '+i)});seq++;
      events.push({seq,time:seq*1000,source:'extension',kind:'assistant_message',messageId:'a'+i,message:t('Answer '+i+'. '+'Some longer text to fill the line. '.repeat(6)),final:true,state:'final'});seq++;}
    const sessions=[{id:'long',title:'Long chat',conversationId:'chat-long',chatIds:['chat-long'],startedAt:1,updatedAt:2,endedAt:2,events:events.length,userMessages:14,toolCalls:0,lastToolCallAt:null,estimatedTokens:10,contextTokens:10,errors:0,lastHandoffId:null,lastTurnOutcome:'completed',activeTurnId:null,agents:[],origin:null}];
    const ok=data=>Promise.resolve({ok:true,data});
    window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok([]),listProjects:()=>ok([]),
      listSessions:()=>ok({sessions,total:1,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      getSession:id=>ok({summary:sessions[0],total:events.length,nextFrom:events.length+1,events}),
      getSessionControls:id=>ok({sessionId:id,automation:'off',objective:'',blocked:'',job:null,activeTurnId:null}),
      listInputs:()=>ok([]),runningTools:()=>ok([]),listPausedHelpers:()=>ok([]),onSessionChanged:()=>()=>{},
      getSwarm:()=>ok({running:false,agents:[],pendingReports:0}),getChatModels:()=>ok({state:'unknown',models:[]})
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    window.fixtureState=state;
    window.fixtureReady=true;
  `;
  const server = await createServer({configFile:false,root:path.join(root,'src/renderer'),
    server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'follow-output-fixture',configureServer(vite) {
      vite.middlewares.use('/fixture.html',async (_request,response)=>{
        // The page's one entry script, removed by its exact text so the fixture boots it instead.
        const entry='<script type="module" src="./main.ts"></script>';
        const page=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8');
        if(!page.includes(entry)) throw new Error('index.html entry script changed: update this fixture');
        const html=page.replace(entry,'').replace('</body>','<script type="module">'+fixture+'</script></body>');
        response.setHeader('Content-Type','text/html');
        response.end(await vite.transformIndexHtml('/fixture.html',html));
      });
    }}]});
  let win;
  try {
    await server.listen(); fs.mkdirSync(output,{recursive:true});
    win=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{offscreen:true,sandbox:true}});
    const js=e=>win.webContents.executeJavaScript(e);
    const pause=ms=>new Promise(r=>setTimeout(r,ms));
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    for(let i=0;i<100&&!(await js('!!window.fixtureReady&&!!document.querySelector("#sessionList [data-id]")'));i++) await pause(100);
    await js('document.querySelector("#sessionList [data-id]").click()'); await pause(1500);
    const gap=()=>js(`(()=>{const p=document.getElementById('chatBody');return Math.round(p.scrollHeight-p.clientHeight-p.scrollTop)})()`);
    // Growth no repaint sees: a block appearing inside the last answer, like an image loading.
    const grow=async px=>{await js(`(()=>{const rows=document.querySelectorAll('#timeline .ev-assistant_message');const b=document.createElement('div');b.style.height='${px}px';rows[rows.length-1].append(b);return 1})()`);await pause(400);};
    // The reader's own scrolling: a wheel on the pane, then the position it lands on.
    const wheelTo=async top=>{await js(`(()=>{const p=document.getElementById('chatBody');p.dispatchEvent(new WheelEvent('wheel',{deltaY:-200,bubbles:true}));p.scrollTop=${top};return 1})()`);await pause(300);};
    assert.ok(await gap()<=2, 'opens at the end');
    await grow(240);
    assert.ok(await gap()<=2, 'follows growth outside a repaint: gap '+(await gap()));
    fs.writeFileSync(path.join(output,'follows-growth.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await wheelTo(100);
    await grow(240);
    const held=await js(`document.getElementById('chatBody').scrollTop`);
    assert.ok(Math.abs(held-100)<=2, 'keeps a reader who scrolled up in place: '+held);
    await wheelTo(1e7);
    await grow(240);
    assert.ok(await gap()<=2, 'resumes following at the end: gap '+(await gap()));
    await js(`window.fixtureState.config.ui.followOutput=false`);
    await grow(240);
    assert.ok(await gap()>=200, 'switched off, growth outside a repaint is not followed: gap '+(await gap()));
    console.log('PASS: the chat follows growth at its end, holds a reader who scrolled up, resumes at the end, and stays put when switched off.');
  } finally { win?.destroy(); await server.close(); app.quit(); }
});
