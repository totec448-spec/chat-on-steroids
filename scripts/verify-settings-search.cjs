// Settings search in real Chromium: the field and its results fit the sidebar, a result opens its
// page with the setting in view, marked and focused, in both themes. Synthetic state only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const output = path.join(root, 'outputs/settings-search');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    ${fixtureConfigSource()}
    const config = fixtureConfig({
      roots:[{name:'fixture',path:'C:/fixture'}], readOnly:true, capabilities:{read:true,browse:true},
      tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui:{theme:new URLSearchParams(location.search).get('theme')||'dark',autoConnect:false}, sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},
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
  const icons = path.join(root,'node_modules/@phosphor-icons/web/src');
  const server = await createServer({configFile:false,root:path.join(root,'src/renderer'),cacheDir:path.join(output,'vite'),
    resolve:{alias:{'@phosphor-icons/web':icons}},
    server:{host:'127.0.0.1',port:0,hmr:false,fs:{allow:[root,fs.realpathSync(icons)]}},plugins:[{name:'chat-switch-fixture',configureServer(vite) {
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
    win=new BrowserWindow({show:false,width:1180,height:760,webPreferences:{offscreen:true,sandbox:true}});
    const js=e=>win.webContents.executeJavaScript(e);
    const pause=ms=>new Promise(r=>setTimeout(r,ms));
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    const shot=async name=>fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    const type=text=>js(`(()=>{const f=document.getElementById('settingsFind');f.focus();f.value=${JSON.stringify(text)};f.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
    for(const theme of ['dark','light']){
      await win.loadURL(server.resolvedUrls.local[0]+'fixture.html?theme='+theme);
      for(let i=0;i<100&&!(await js('!!window.fixtureReady&&!!document.querySelector("#sessionList [data-id]")'));i++) await pause(100);
      await pause(300);
      assert.equal(await js('document.documentElement.dataset.theme'),theme,'The fixture runs in '+theme);
      await js(`document.getElementById('workspaceSettings').click()`); await pause(400);
      await type('theme'); await pause(300);
      const list=await js(`(()=>{const side=document.querySelector('.sidebar').getBoundingClientRect(),field=document.getElementById('settingsFind').getBoundingClientRect();
        const rows=[...document.querySelectorAll('#settingsFindResults .search-result')].map(row=>{const r=row.getBoundingClientRect();return {left:r.left,right:r.right,text:row.innerText}});
        return {rows,inside:rows.every(r=>r.left>=side.left-0.5&&r.right<=side.right+0.5),fieldInside:field.left>=side.left&&field.right<=side.right,
          pages:!document.getElementById('tabs').checkVisibility()}})()`);
      assert.ok(list.rows.length>=1 && /Theme/.test(list.rows[0].text) && /Appearance › Colors/.test(list.rows[0].text), 'Theme is found on Appearance: '+JSON.stringify(list.rows));
      assert.equal(list.inside,true,'Results stay inside the sidebar');
      assert.equal(list.fieldInside,true,'The field stays inside the sidebar');
      // Its own look, not the browser's bare input: rounded, sidebar height, the magnifier inside it.
      const look=await js(`(()=>{const f=document.getElementById('settingsFind'),s=getComputedStyle(f),r=f.getBoundingClientRect(),i=document.querySelector('#settingsFindBox > .ico').getBoundingClientRect();
        return {radius:s.borderTopLeftRadius,height:Math.round(r.height),iconInside:i.left>=r.left&&i.right<=r.left+30&&i.top>=r.top&&i.bottom<=r.bottom}})()`);
      assert.deepEqual(look,{radius:'8px',height:30,iconInside:true},'The search field is styled');
      assert.equal(list.pages,true,'The page list steps aside while searching');
      await shot(`results-${theme}.png`);
      await js(`document.querySelector('#settingsFindResults .search-result').click()`); await pause(400);
      const opened=await js(`(()=>{const select=document.getElementById('appearanceTheme'),row=select.closest('.setting')??select.parentElement,r=row.getBoundingClientRect();
        return {active:document.querySelector('[data-panel="appearance"]').classList.contains('is-active'),inView:r.top>=0&&r.bottom<=innerHeight,
          focused:document.activeElement===select,marked:!!document.querySelector('.is-found'),pages:document.getElementById('tabs').checkVisibility()}})()`);
      assert.deepEqual(opened,{active:true,inView:true,focused:true,marked:true,pages:true},'The Theme setting opens in view, marked and focused');
      await shot(`opened-${theme}.png`);
      // A setting far down Agents & automation scrolls into view there.
      await type('handoff length'); await pause(300);
      await js(`document.querySelector('#settingsFindResults .search-result').click()`); await pause(500);
      const far=await js(`(()=>{const select=document.getElementById('handoffLength'),r=select.getBoundingClientRect();return {inView:r.top>=0&&r.bottom<=innerHeight,focused:document.activeElement===select}})()`);
      assert.deepEqual(far,{inView:true,focused:true},'Handoff length opens in view and focused: '+JSON.stringify(await js(`(()=>{const s=document.getElementById('handoffLength'),r=s.getBoundingClientRect(),p=document.getElementById('chatBody');return {top:r.top,bottom:r.bottom,h:innerHeight,scroll:p.scrollTop,max:p.scrollHeight-p.clientHeight,active:document.activeElement?.id,hidden:s.closest('[hidden]')?.id||s.closest('[hidden]')?.className||null}})()`)));
      await js(`document.getElementById('backToChat').click()`); await pause(300);
      assert.equal(await js(`document.getElementById('settingsFindBox').checkVisibility()`),false,'No settings search outside Settings');
    }
    console.log('PASS: settings search finds settings on every page, fits the sidebar, and opens a setting in view, marked and focused.');
  } finally { win?.destroy(); await server.close(); app.quit(); }
// A failed assertion must fail the check: quitting alone exits 0 and reads as a pass.
}).catch(error => { console.error(error); app.exit(1); });
