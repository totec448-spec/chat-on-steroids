// Production renderer and real Chromium layout; synthetic conversations only (#1133).
// Aged data (2.1.47 round, the user: "389h ago"): chats from seconds to years old, with long titles,
// in every language. No visible text, tooltip, title or label may run one unit up into the hundreds,
// show a clock past 59 minutes as minutes, or leak NaN, Infinity, undefined, [object or a minus age.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'aged-data'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
// From just now to two and a half years, each unit boundary and the reported 389 hours.
const AGES = [20_000, 5 * MIN, 3 * HOUR, 30 * HOUR, 6 * DAY, 389 * HOUR, 45 * DAY, 400 * DAY, 900 * DAY];
const LANGUAGES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
let server, win;
const fixture = `(() => {
 const old=window.api,f=composerFixture,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 const ages=${JSON.stringify(AGES)};
 // src/shared/appearance.ts defaultAppearance(): a whole appearance, as Settings saves one.
 const defaultAppearance={light:{background:'#f4f4f5',sidebar:'#e9edf2',accent:'#486f9d',contrast:45},dark:{background:'#181818',sidebar:'#1a2129',accent:'#b0cbed',contrast:60},
  font:'system',fontSize:14,lineSpacing:100,translucentSidebar:true,sidebarLayout:'projects',highContrast:false};
 f.summary.title='The open chat'; f.summary.updatedAt=Date.now(); f.summary.lastToolCallAt=null; f.summary.activityExpiresAt=null;
 const others=ages.map((age,n)=>({...f.summary,id:'aged-chat-'+n,conversationId:'aged-conversation-'+n,chatIds:['aged-conversation-'+n],
  title:'Aged chat '+n+': '+'a long generated title that keeps going with tool names and paths '.repeat(n%3+1),
  startedAt:Date.now()-age-1000,updatedAt:Date.now()-age,lastAssistantFinalAt:Date.now()-age,lastTurnEndAt:Date.now()-age}));
 window.fixtureLanguage='en'; window.fixtureLayout='projects';
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:window.fixtureLanguage,theme:'dark',
   appearance:{...defaultAppearance,...(r.data.config.ui.appearance||{}),sidebarLayout:window.fixtureLayout}};return r;},
  listSessions:()=>ok({sessions:[{...f.summary,events:f.events.length},...others],activeId:null,pressure:[],blocked:[],trusted:[]})
 };
 window.pushState=async()=>{const r=await methods.getState();f.emit('onStateChanged',r.data);f.emit('onSessionChanged',{allTranscripts:true});};
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
// Text a person or a screen reader meets: what is shown, and every tooltip, title and label.
const READ = `(() => {
 const texts=[document.body.innerText];
 for (const node of document.querySelectorAll('[title],[data-tooltip],[aria-label]'))
  texts.push(node.getAttribute('title')||'',node.dataset.tooltip||'',node.getAttribute('aria-label')||'');
 return texts.join('\\n');
})()`;
const RUNAWAY = [
  [/(^|[^\d.,:])(\d{3,})\s?(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|w|wk|weeks?|Std\.?|Min\.?|ч|мин|時間|分|小时|小時|分钟|分鐘|시간|분|giờ|phút|sa|dk)(?![\p{L}])/u, 'one unit run into the hundreds'],
  [/(^|[^\d:])([6-9]\d|\d{3,}):[0-5]\d(?!:)/, 'a clock past 59 minutes written as minutes'],
  [/\bNaN\b|\bInfinity\b|\bundefined\b|\[object /, 'a broken value'],
  [/(^|\s)-\d+\s?(s|m|h|d|w|j|дн|sem)\b/u, 'a negative age']
];
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'aged-data-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}
    const seen=await js(`({rows:document.querySelectorAll('#sessionList .sess[data-id]').length,lang:document.documentElement.lang,list:(document.getElementById('sessionList')?.innerText||'').slice(0,200)})`).catch(()=>null);
    throw new Error('Timed out: '+expression+' — saw '+JSON.stringify(seen)+' errors '+JSON.stringify(errors.slice(0,3)));};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`document.querySelectorAll('#sessionList .sess[data-id^="aged-chat-"]').length===${AGES.length}`);
  const found=[];
  // Both sidebars: the project tree (ages in each row's tooltip) and the inbox (an age beside each title).
  for (const layout of ['projects','inbox']) {
  await js(`window.fixtureLayout=${JSON.stringify(layout)};window.pushState()`);
  for (const language of LANGUAGES) {
    // As Settings → Language does it (the fixture's saved state follows).
    await js(`(()=>{window.fixtureLanguage=${JSON.stringify(language)};const s=document.getElementById('uiLanguage');s.value=${JSON.stringify(language)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(`document.documentElement.lang===${JSON.stringify(language)}`);
    await js(`window.pushState()`);
    await pause(250);
    const text=await js(READ);
    for (const line of text.split('\n')) for (const [pattern,why] of RUNAWAY) if (pattern.test(line)) found.push(`${language}: ${why}: ${line.trim().slice(0,160)}`);
    if (language==='en'||language==='de') { fs.mkdirSync(output,{recursive:true}); fs.writeFileSync(path.join(output,`aged-${layout}-${language}.png`),(await win.webContents.capturePage()).toPNG()); }
  }
  if (layout==='inbox') {
    // The inbox draws an age beside every quiet chat: the check must have read them.
    const ages=await js(`[...document.querySelectorAll('#sessionList .sess[data-id^="aged-chat-"] .sess-age')].map(n=>n.textContent)`);
    const seen=await js(`({layout:document.getElementById('sessionList')?.dataset.layout||document.querySelector('.app')?.dataset.sidebarLayout||'',rows:[...document.querySelectorAll('#sessionList .sess[data-id]')].map(r=>r.dataset.id+':'+r.className+':'+r.innerText.replace(/\\s+/g,' ').slice(0,40)).slice(0,6)})`);
    assert.equal(ages.length,AGES.length,'Every aged chat shows its age in the inbox: '+JSON.stringify(ages)+' saw '+JSON.stringify(seen));
  }
  }
  // The 16-day chat's tooltip, where "389h ago" was (kept for the PR's before/after pictures).
  await js(`(()=>{window.fixtureLanguage='en';const s=document.getElementById('uiLanguage');s.value='en';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`document.documentElement.lang==='en'`);
  win.show(); await pause(150);
  const box=await js(`(()=>{const r=document.querySelector('#sessionList .sess[data-id="aged-chat-5"]').getBoundingClientRect();return {x:Math.round(r.x+40),y:Math.round(r.y+r.height/2)};})()`);
  await win.webContents.sendInputEvent({type:'mouseMove',x:box.x,y:box.y});
  await pause(1200);
  fs.mkdirSync(output,{recursive:true}); fs.writeFileSync(path.join(output,'aged-tooltip-en.png'),(await win.webContents.capturePage()).toPNG());
  // The check reads what it claims to: each aged chat has a row, and its tooltip names its age.
  const titles=await js(`[...document.querySelectorAll('#sessionList .sess[data-id^="aged-chat-"]')].map(r=>r.getAttribute('title')||r.dataset.tooltip||'')`);
  assert.equal(titles.length,AGES.length);
  assert.ok(titles.every(title=>/ago|vor|前|назад|전|önce|trước|il y a|hace|há/.test(title)),'Every row tooltip carries an age: '+JSON.stringify(titles.slice(0,2)));
  assert.deepEqual(found,[],'Aged data reads naturally in every language:\n'+found.join('\n'));
  assert.deepEqual(errors,[],'No renderer errors');
  console.log(`PASS verify-aged-data: ${AGES.length} ages × ${LANGUAGES.length} languages × 2 sidebars, no runaway units or broken values`);
  win.destroy(); await server.close(); app.exit(0);
}).catch(async error=>{console.error(error.stack||error);try{win?.destroy();await server?.close();}catch{}app.exit(1);});
