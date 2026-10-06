// The chat stays at its end when its visible area shrinks (composer, docks), and keeps a reader's
// place when they scrolled up. Isolated real Electron renderer; synthetic session only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const output = path.join(root, 'outputs/chat-stays-at-end');
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
    win=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{offscreen:true,sandbox:true}});
    const js=e=>win.webContents.executeJavaScript(e);
    const pause=ms=>new Promise(r=>setTimeout(r,ms));
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    for(let i=0;i<100&&!(await js('!!window.fixtureReady&&!!document.querySelector("#sessionList [data-id]")'));i++) await pause(100);
    await js('document.querySelector("#sessionList [data-id]").click()'); await pause(1500);
    const view=()=>js(`(()=>{const p=document.getElementById('chatBody');const last=[...document.querySelectorAll('#timeline .ev-assistant_message')].at(-1).getBoundingClientRect();const box=p.getBoundingClientRect();
      return {gap:Math.round(p.scrollHeight-p.clientHeight-p.scrollTop),lastVisible:last.bottom<=box.bottom+1&&last.top>=box.top-1,top:p.scrollTop,client:p.clientHeight}})()`);
    let v=await view();
    assert.ok(v.gap<=2 && v.lastVisible, 'opens at the end: '+JSON.stringify(v));
    // The visible area shrinks: a many-line draft grows the message box.
    await js(`(()=>{const i=document.getElementById('chatInput');i.value='one\\ntwo\\nthree\\nfour\\nfive\\nsix\\nseven\\neight';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
    await pause(700);
    v=await view();
    fs.writeFileSync(path.join(output,'at-end-after-shrink.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    assert.ok(v.gap<=2 && v.lastVisible, 'stays at the end when the area shrinks: '+JSON.stringify(v));
    // Shrink the window too, like opening the bottom terminal.
    win.setContentSize(1100,560); await pause(700);
    v=await view(); assert.ok(v.gap<=2 && v.lastVisible, 'stays at the end when the window shrinks: '+JSON.stringify(v));
    // A reader who scrolled up keeps their place. Only the reader's own scrolling counts as reading
    // (a script setting scrollTop does not), so scroll with the wheel.
    const pane=await js(`(()=>{const r=document.getElementById('chatBody').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    for(let i=0;i<4;i++){win.webContents.sendInputEvent({type:'mouseWheel',x:pane.x,y:pane.y,deltaX:0,deltaY:240});await pause(120);}
    await pause(500);
    v=await view(); const place=v.top;
    assert.ok(v.gap>200, 'scrolled up with the wheel: '+JSON.stringify(v));
    await js(`(()=>{const i=document.getElementById('chatInput');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
    await pause(700);
    v=await view(); assert.ok(Math.abs(v.top-place)<=2, 'keeps a scrolled-up place: '+JSON.stringify({...v,place}));
    // Agents & automation shows in the chat's own scroll pane. Reached the usual way (Settings opens
    // Workspace first), it starts at its top without the chat's jump control, reading it is not
    // reading the chat, and the chat comes back at its end, still following.
    await js(`document.getElementById('jumpLatest').click()`); await pause(700);
    v=await view(); assert.ok(v.gap<=2 && v.lastVisible, 'back at the end before Settings: '+JSON.stringify(v));
    await js(`document.getElementById('workspaceSettings').click()`); await pause(300);
    await js(`document.querySelector('#tabs button[data-tab="settings"]').click()`); await pause(700);
    const agents=()=>js(`(()=>{const p=document.getElementById('chatBody');return {top:Math.round(p.scrollTop),max:p.scrollHeight-p.clientHeight,
      jump:document.getElementById('jumpLatest').classList.contains('is-shown'),timeline:!document.getElementById('timelineContent').hidden}})()`);
    let a=await agents();
    assert.ok(a.max>200 && !a.timeline, 'Agents & automation fills the pane: '+JSON.stringify(a));
    assert.equal(a.top,0,'Agents & automation opens at its top');
    assert.equal(a.jump,false,'No jump-to-latest control over the settings');
    const box=await js(`(()=>{const r=document.getElementById('chatBody').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    for(const deltaY of [-240,-240,-240,240]){win.webContents.sendInputEvent({type:'mouseWheel',x:box.x,y:box.y,deltaX:0,deltaY});await pause(120);}
    await pause(600);
    a=await agents();
    assert.ok(a.top>0 && a.top<a.max, 'the settings were scrolled to a middle: '+JSON.stringify(a));
    assert.equal(a.jump,false,'Still no jump-to-latest control while reading the settings');
    fs.writeFileSync(path.join(output,'agents-scrolled.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await js(`document.getElementById('backToChat').click()`); await pause(700);
    v=await view(); assert.ok(v.gap<=2 && v.lastVisible, 'the chat comes back at its end: '+JSON.stringify(v));
    win.setContentSize(1100,480); await pause(700);
    v=await view(); assert.ok(v.gap<=2 && v.lastVisible, 'and still follows when its area shrinks: '+JSON.stringify(v));
    console.log('PASS: the chat stays at its end when the message box or window shrinks, keeps a scrolled-up reader in place, and is not moved by Agents & automation.');
  } finally { win?.destroy(); await server.close(); app.quit(); }
// A failed assertion must fail the check: quitting alone exits 0 and reads as a pass.
}).catch(error => { console.error(error); app.exit(1); });
