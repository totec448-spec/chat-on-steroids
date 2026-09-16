// Real Chromium geometry against production renderer modules; synthetic history only.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const run = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || ''); process.exit(run.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'outputs/message-reactions');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    const text = text=>({text,chars:text.length,truncated:false});
    const question = {kind:'user_message',seq:1,origin:1,time:1,source:'extension',messageId:'user',message:text('That actually worked 😂'),inputDelivery:'confirmed'};
    const answer = {kind:'assistant_message',seq:2,origin:2,time:2,source:'extension',messageId:'answer',message:text('Yes, it did. The reaction stays under your message.'),final:true};
    window.rows=[question,answer];
    const config={roots:[{name:'fixture',path:'C:/fixture'}],readOnly:true,capabilities:{read:true,browse:true},tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui:{theme:'dark',autoConnect:false},sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},
      compaction:{auto:false,autoTokens:300000},multiAgent:{enabled:false,maxWorkers:2},goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}};
    const state={config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,status:{state:'disconnected',surfaces:[]},bridge:{running:false,paired:false,present:false},update:{current:'fixture',latest:null,stage:'idle'}};
    const summary={id:'fixture',title:'Message reactions',conversationId:'fixture-chat',chatIds:['fixture-chat'],startedAt:1,updatedAt:2,
      events:2,userMessages:1,toolCalls:0,estimatedTokens:20,contextTokens:20,errors:0,agents:[],origin:null};
    const ok=data=>Promise.resolve({ok:true,data});
    window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok([]),listProjects:()=>ok([]),
      listSessions:()=>ok({sessions:[summary],activeId:null,pressure:[],blocked:[]}),
      getSession:()=>ok({summary,events:structuredClone(window.rows),total:2,nextFrom:100}),
      getSessionControls:()=>ok({automation:'off',blocked:'',job:null}),listInputs:()=>ok([]),listPausedHelpers:()=>ok([]),
      onSessionChanged:fn=>{window.changed=fn;return ()=>{}},getSwarm:()=>ok({running:false,agents:[]}),
      getChatModels:()=>ok({state:'unknown',models:[]})},{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    window.reaction=(value)=>{question.reaction=value;question.seq++;window.changed()};
    await import('/main.ts');window.ready=true;
  `;
  const server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), server:{host:'127.0.0.1',port:0,hmr:false},
    plugins:[{name:'reaction-fixture',configureServer(vite){vite.middlewares.use('/fixture.html',async (_req,res)=>{
      const html=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
        .replace('</body>','<script type="module">'+fixture+'</script></body>');
      res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/fixture.html',html));
    })}}] });
  let win;
  try {
    fs.mkdirSync(output,{recursive:true}); await server.listen();
    win = new BrowserWindow({show:false,width:1100,height:800,webPreferences:{sandbox:true,backgroundThrottling:false}});
    win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)});
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    const js = code=>win.webContents.executeJavaScript(code);
    const until=async predicate=>{for(let i=0;i<200;i++){if(await js(predicate))return;await new Promise(r=>setTimeout(r,30))}throw Error(predicate+' '+await js('document.body.innerText.slice(-1200)'))};
    await until('window.ready && document.querySelector("#sessionList [data-id]")');
    await js('document.querySelector("#sessionList [data-id]").click()');
    await until('document.querySelector(".said.is-user")');
    const results=[];
    for(const zoom of [1,1.17,1.5]) for(const width of [1100,600]) {
      win.setSize(width,800);win.webContents.setZoomFactor(zoom);
      await js('window.reaction(null)');await until('!document.querySelector(".message-reaction")');
      const measure=`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]};return {bubble:rect('.user-message-text'),answer:rect('.ev-assistant_message'),scroll:document.getElementById('chatBody').scrollTop}})()`;
      const before=await js(measure);
      await js('window.originalBubble=document.querySelector(".said.is-user");window.reaction("😂")');
      await until('document.querySelector(".message-reaction")?.textContent==="😂"');
      assert.deepEqual(await js(measure),before,'Reaction must not move or resize either message');
      assert.equal(await js('window.originalBubble===document.querySelector(".said.is-user")'),true);
      // Exercise simultaneous visibility even though a later reply normally hides
      // the delivery tick. Both occupy the same reserved footer without colliding.
      await js(`document.querySelector('.input-receipt').hidden=false;document.querySelector('.said.is-user').classList.add('has-input-receipt')`);
      const geometry=await js(`(()=>{const b=document.querySelector('.message-reaction').getBoundingClientRect(),r=document.querySelector('.input-receipt').getBoundingClientRect();return {separate:r.right<=b.left||r.left>=b.right,below:b.top>=document.querySelector('.user-message-text').getBoundingClientRect().bottom-5}})()`);
      assert.ok(geometry.separate && geometry.below,'Badge must sit below text without overlapping its receipt');
      await js('window.reaction("❤️")');await until('document.querySelector(".message-reaction")?.textContent==="❤️"');
      assert.deepEqual(await js(measure),before);
      results.push({zoom,width,stable:true});
    }
    win.setSize(1100,800);win.webContents.setZoomFactor(1.17);await js('window.reaction("😂")');
    await until('document.querySelector(".message-reaction")?.textContent==="😂"');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output,'preview.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify(results));
  } finally {win?.destroy();await server.close()}
}).then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
