// What's New in real Chromium (#1172): once after an update, centred, every icon centred in its badge,
// both themes, a narrow window, dismissal by button and Escape; nothing on the same version or on a
// version without highlights. Synthetic state only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const { inkInsets: sharedInkInsets } = require('./fixtures/ink.cjs');
const output = path.join(root, 'outputs/whats-new');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    ${fixtureConfigSource()}
    const params = new URLSearchParams(location.search);
    const seen = params.get('seen');
    // Every page states its language, so a failed earlier run cannot leave the next one in German.
    if (params.get('lang')) localStorage.setItem('cos.ui.language', params.get('lang')); else localStorage.removeItem('cos.ui.language');
    const config = fixtureConfig({
      roots:[{name:'fixture',path:'C:/fixture'}], readOnly:true, capabilities:{read:true,browse:true},
      tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui:{theme:params.get('theme')||'dark',autoConnect:false, ...(seen ? {lastSeenVersion:seen} : {})},
      sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},
      compaction:{auto:true,autoTokens:300000}, multiAgent:{enabled:false,maxWorkers:2},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}
    });
    const state = {config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,
      status:{state:'disconnected',surfaces:[]},bridge:{running:false,paired:false,present:false},
      update:{current:params.get('version')||'2.1.31',latest:null,stage:'idle'}};
    const ok=data=>Promise.resolve({ok:true,data});
    window.seenCalls=0; window.openedLinks=[];
    window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok([]),listProjects:()=>ok([]),
      listSessions:()=>ok({sessions:[],total:0,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      listInputs:()=>ok([]),runningTools:()=>ok([]),listPausedHelpers:()=>ok([]),onSessionChanged:()=>()=>{},
      getSwarm:()=>ok({running:false,agents:[],pendingReports:0}),getChatModels:()=>ok({state:'unknown',models:[]}),
      markWhatsNewSeen:()=>{window.seenCalls++;return ok(null);},
      openLink:url=>{window.openedLinks.push(url);return ok(true);}
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    window.fixtureReady=true;
  `;
  const icons = path.join(root,'node_modules/@phosphor-icons/web/src');
  const server = await createServer({configFile:false,root:path.join(root,'src/renderer'),cacheDir:path.join(output,'vite'),
    resolve:{alias:{'@phosphor-icons/web':icons}},
    server:{host:'127.0.0.1',port:0,hmr:false,fs:{allow:[root,fs.realpathSync(icons)]}},plugins:[{name:'whats-new-fixture',configureServer(vite) {
      vite.middlewares.use('/fixture.html',async (_request,response)=>{
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
    const until=async(expression,ms=6000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await js(expression))return;await pause(40);}throw new Error('Timeout: '+expression);};
    const open=async query=>{
      await win.loadURL(server.resolvedUrls.local[0]+'fixture.html?'+query);
      await until('window.fixtureReady===true');
    };
    const shot=async name=>fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());
    const inkInsets=element=>sharedInkInsets(win,js,element);

    for (const theme of ['dark','light']) {
      await open(`theme=${theme}&seen=2.1.30&version=2.1.31`);
      await until(`document.getElementById('whatsNewDialog').open`);
      // Measure only once every entry animation has finished: a row still sliding up reads as an
      // icon sitting low in its badge.
      await until(`document.getAnimations().every(animation=>animation.playState==='finished')`);
      await pause(100);
      const view=await js(`(()=>{const d=document.getElementById('whatsNewDialog'),r=d.getBoundingClientRect(),list=document.getElementById('whatsNewList');
        return {left:r.left,right:innerWidth-r.right,top:r.top,bottom:innerHeight-r.bottom,items:list.children.length,
          title:document.getElementById('whatsNewTitle').textContent,version:document.getElementById('whatsNewVersion').textContent,
          lead:document.getElementById('whatsNewLead').textContent,focus:document.activeElement.id,ring:document.activeElement.matches(':focus-visible'),
          sideways:list.scrollWidth>list.clientWidth,fits:list.scrollHeight<=list.clientHeight,clipped:[...list.querySelectorAll('b,span')].some(e=>e.scrollWidth>e.clientWidth+1)}})()`);
      assert.equal(view.items,5,'Five highlights for 2.1.31');
      assert.equal(view.title,"What's new");
      assert.equal(view.version,'Version 2.1.31');
      assert.match(view.lead,/^GPT-6 support, a timeline that reads like ChatGPT/);
      assert.equal(view.focus,'whatsNewDone','"Got it" has the focus');
      assert.equal(view.ring,false,'It opens without a focus ring; the keyboard brings one');
      assert.ok(Math.abs(view.left-view.right)<=1 && Math.abs(view.top-view.bottom)<=1,'The dialog is centred: '+JSON.stringify(view));
      assert.ok(!view.sideways && !view.clipped,'Nothing scrolls sideways or is cut: '+JSON.stringify(view));
      assert.ok(view.fits,'All highlights fit an ordinary window without scrolling: '+JSON.stringify(view));
      assert.equal(await js('window.seenCalls'),1,'The version is recorded once it has been shown');
      // Every glyph sits in the middle of its badge, and the sparkle in its mark.
      for (const element of ["document.querySelector('.whats-new-tile')","document.querySelector('.whats-new-seal')",...Array.from({length:view.items},(_, i)=>`document.querySelectorAll('.whats-new-icon')[${i}]`)]) {
        // A rounded square's corners show the card through: square it off while measuring; the glyph stays put.
        // The seal sits over the tile's corner; it is measured on its own, so hide it for the tile.
        const tile=element.includes('whats-new-tile');
        if (tile) await js(`document.querySelector('.whats-new-seal').style.visibility='hidden'`);
        const round=element.includes('whats-new-seal');
        // The seal's disc and ring are accent over the tile; measure only its glyph, in ink on a card-coloured disc.
        if (round) await js(`(s=>{s.style.background='var(--whats-new-surface)';s.style.boxShadow='none';s.style.color='var(--ink)'})(document.querySelector('.whats-new-seal'))`);
        if (!round) await js(`${element}.style.borderRadius='0'`);
        const ink=await inkInsets(element);
        if (!round) await js(`${element}.style.borderRadius=''`);
        if (round) await js(`(s=>{s.style.background='';s.style.boxShadow='';s.style.color=''})(document.querySelector('.whats-new-seal'))`);
        if (tile) await js(`document.querySelector('.whats-new-seal').style.visibility=''`);
        assert.ok(Math.abs(ink.left-ink.right)<=1.5 && Math.abs(ink.top-ink.bottom)<=1.5,`${element} is centred in ${theme}: ${JSON.stringify(ink)}`);
      }
      // As it opens: measuring scrolled the list; back to its top for the picture.
      await js(`document.getElementById('whatsNewList').scrollTop=0`); await pause(100);
      await shot(`whats-new-${theme}.png`);
      // The release notes open externally, for this exact version.
      await js(`document.getElementById('whatsNewNotes').click()`);
      assert.deepEqual(await js('window.openedLinks'),['https://github.com/totec448-spec/chat-on-steroids/releases/tag/v2.1.31']);
      // "Got it" closes it, with its motion.
      await js(`document.getElementById('whatsNewDone').click()`);
      await until(`!document.getElementById('whatsNewDialog').open`);
    }

    // German, the longest of the catalogs here: translated, nothing cut, the actions in view.
    await open('lang=de&seen=2.1.30&version=2.1.31');
    await until(`document.getElementById('whatsNewDialog').open`);
    await pause(1100);
    const de=await js(`(()=>{const list=document.getElementById('whatsNewList'),a=document.querySelector('.whats-new-actions').getBoundingClientRect();
      return {title:document.getElementById('whatsNewTitle').textContent,done:document.getElementById('whatsNewDone').textContent.trim(),
        clipped:[...document.querySelectorAll('#whatsNewDialog b,#whatsNewDialog span,#whatsNewDialog button')].some(e=>e.scrollWidth>e.clientWidth+1),
        sideways:list.scrollWidth>list.clientWidth,fits:list.scrollHeight<=list.clientHeight,over:list.scrollHeight-list.clientHeight,rows:[...list.children].map(r=>Math.round(r.getBoundingClientRect().height)),actionsBottom:innerHeight-a.bottom}})()`);
    assert.equal(de.title,'Neuigkeiten'); assert.equal(de.done,'Verstanden');
    assert.ok(!de.clipped && !de.sideways && de.fits && de.actionsBottom>=8,'German fits without scrolling: '+JSON.stringify(de));
    await shot('whats-new-de.png');

    // Escape dismisses it the same way.
    await open('seen=2.1.30&version=2.1.31');
    await until(`document.getElementById('whatsNewDialog').open`);
    await pause(1100);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(`!document.getElementById('whatsNewDialog').open`);

    // A short window: the list scrolls inside the dialog and both actions stay in view.
    win.setContentSize(720,460);
    await open('seen=2.1.30&version=2.1.31');
    await until(`document.getElementById('whatsNewDialog').open`);
    await pause(1100);
    const short=await js(`(()=>{const d=document.getElementById('whatsNewDialog').getBoundingClientRect(),a=document.querySelector('.whats-new-actions').getBoundingClientRect(),l=document.getElementById('whatsNewList');
      return {top:d.top,bottom:innerHeight-d.bottom,actionsBottom:innerHeight-a.bottom,scrolls:l.scrollHeight>l.clientHeight}})()`);
    assert.ok(short.top>=8 && short.bottom>=8 && short.actionsBottom>=8 && short.scrolls,'A short window keeps the dialog and its actions in view: '+JSON.stringify(short));
    await shot('whats-new-short.png');
    win.setContentSize(1180,760);

    // Nothing on the same version, and nothing (but a record) on a version without highlights.
    await open('seen=2.1.30&version=2.1.30');
    await pause(1200);
    assert.equal(await js(`document.getElementById('whatsNewDialog').open`),false,'Same version: no dialog');
    assert.equal(await js('window.seenCalls'),0,'Same version: nothing recorded');
    await open('seen=2.1.30&version=9.9.9');
    await pause(1200);
    assert.equal(await js(`document.getElementById('whatsNewDialog').open`),false,'No highlights: no dialog');
    assert.equal(await js('window.seenCalls'),1,'No highlights: the version is still recorded');

    console.log('PASS: What\'s New opens once after an update, centred with centred icons in both themes, opens the exact release notes, closes by button and Escape, fits a short window, and stays away on the same version or one without highlights');
  } finally {
    win?.destroy(); await server.close(); app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
