// Real Chromium acceptance of Review's Commit & PR dialog with the current renderer source through
// Vite. Backend responses are synthetic: nothing is committed, pushed or opened. The check measures
// the dialog in every language, both themes and a short window: nothing cut or outside it, the
// buttons always in view, every block on one left edge.
const { withoutScripts } = require('./ui-check-page.cjs');
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require('./fixtures/app-defaults.cjs');
const output = path.join(root, 'outputs/commit-dialog');
app.setPath('userData', path.join(output, 'runtime'));
fs.mkdirSync(output, { recursive: true });
const LANGUAGES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  let win;
  let server;
  try {
    win = new BrowserWindow({ show: false, width: 1500, height: 1000,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    await win.loadURL('data:text/html,' + encodeURIComponent('<h1>Project preview</h1><p>Local synthetic PDF fixture.</p>'));
    const pdf = await win.webContents.printToPDF({ pageSize: 'A5' });
    const fixture = `
      localStorage.clear();
      window.fixtureErrors=[];
      window.addEventListener('error', event => { if (!${JSON.stringify(BENIGN_RENDERER_ERRORS)}.includes(event.message)) window.fixtureErrors.push(event.message); });
      window.addEventListener('unhandledrejection', event => window.fixtureErrors.push(String(event.reason)));
      ${fixtureConfigSource()}
    const config = fixtureConfig({roots:[{name:'demo',path:'C:/demo'}],readOnly:false,
        commandAllowlist:{enabled:false,mode:'allow',rules:[]},
        capabilities:{browse:true,search:true,read:true,metadata:true,create:true,edit:true,move:true,deleteFile:true,command:true,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
        tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
        ui:{minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:new URLSearchParams(location.search).get('theme')||'dark'},
        sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},compaction:{auto:true,autoTokens:300000},
        multiAgent:{enabled:false,maxWorkers:2,allowUnattributedCalls:false,recoverAgentTabs:false},
        goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}});
      const state={config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,
        status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
        bridge:{running:true,port:8765,paired:true,present:true,lastSeenAt:Date.now(),extensionVersion:'2.1.13'},
        update:{current:'2.1.13',latest:null,stage:'idle',error:null,checkedAt:null}};
      const projects=[{id:'project-a',name:'Demo workspace',path:'C:/demo',createdAt:1},{id:'project-b',name:'Second project',path:'C:/demo-b',createdAt:1}];
      const rows=projects.map((p,i)=>({id:'task-'+i,title:i?'Second conversation':'Project review',projectId:p.id,
        conversationId:null,chatIds:[],startedAt:1,updatedAt:10-i,endedAt:2,events:2,userMessages:1,toolCalls:0,
        lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,estimatedTokens:0,contextTokens:0,
        lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:'completed',activeTurnId:null,agents:[],origin:{kind:'desktop'}}));
      rows.push({...rows[0],id:'standalone',title:'Standalone chat',projectId:undefined});
      const monitorNow=Date.now();
      const monitorWorker={...rows[0],id:'worker-monitor',title:'worker-2 · Backend',conversationId:'chat-worker-monitor',
        chatIds:['chat-worker-monitor'],startedAt:monitorNow-90_000,updatedAt:monitorNow,endedAt:null,events:1205,userMessages:2,toolCalls:1200,
        lastToolCallAt:monitorNow-1000,lastToolActivity:{kind:'read',title:'Read src/main/agents.ts'},lastTurnOutcome:null,activeTurnId:'turn-monitor',
        origin:{kind:'worker',fromSessionId:'task-0',agentId:'worker-2',task:'Inspect worker activity'}};
      const monitorAgent={runId:'fixture-run',primeConversationId:'prime-fixture',id:'worker-2',role:'worker',label:'Backend',
        task:'Inspect worker activity',reasoningEffort:null,model:null,state:'active',createdAt:monitorNow-90_000,activatedAt:monitorNow-89_000,
        finishedAt:null,result:null,pending:0,awaitingAck:0,delivered:0,conversationId:'chat-worker-monitor',detachedAt:null,lastSeenAt:monitorNow,revivable:true};
      const files={'README.md':'# Demo workspace\\n\\nProject files, local drafts and bounded previews.\\n','example.ts':'export const value = 1;\\r\\n'};
      const ok=data=>Promise.resolve({ok:true,data});
      const info=(projectId,name)=>({projectId,projectName:projects.find(p=>p.id===projectId).name,path:name,name,
        bytes:files[name]?.length??${pdf.length},modifiedAt:new Date(0).toISOString(),revision:'a'.repeat(64),
        binary:name.endsWith('.pdf'),text:files[name]??null,truncated:false,
        ...(name.endsWith('.pdf')?{pdfDataBase64:${JSON.stringify(pdf.toString('base64'))}}:{})});
      window.fixtureSaves=[]; window.fixtureAttached=[]; window.fixtureCommits=[];
      const personal={id:'review',name:'Code review',description:'Read the complete change, check behavior and preserve existing work.',path:'/skills/review/SKILL.md',managed:true,scope:'managed',source:'managed',allowImplicitInvocation:true};
      const projectSkill={id:'project-check--repo-fixture',name:'Project checks',description:'Use this project’s build, conventions and verification routes.',path:'/demo/.agents/skills/check/SKILL.md',managed:false,scope:'repo',source:'repo-agents',allowImplicitInvocation:true};
      window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok([]),getZoom:()=>ok(1),setZoom:factor=>ok(Math.round(factor*100)/100),petsOverlayState:()=>ok({visible:false,ready:true,activeCount:0,activityCount:0}),listProjects:()=>ok(projects),
        listSessions:()=>ok({sessions:rows,total:rows.length,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
        getSession:id=>ok({events:[{seq:1,time:1,source:'extension',kind:'user_message',messageId:'question',message:{text:'Review this project',chars:19,truncated:false}},
          {seq:2,time:2,source:'extension',kind:'assistant_message',messageId:'answer',final:true,state:'final',message:{text:'The project workspace is ready for inspection.',chars:47,truncated:false}}],total:2,nextFrom:3}),
        getSwarm:()=>ok({enabled:true,running:true,agents:[monitorAgent]}),getChatModels:()=>ok({state:'unknown',models:[]}),
        skillLibrary:()=>ok({skills:[personal,projectSkill],roots:[],errors:[],includeInstructions:true}),
        listSkills:()=>ok([personal]),listInputs:()=>ok([]),getSessionPlan:()=>ok(null),browserPreferences:()=>ok({overwrite:true,durations:false}),
        listProjectFiles:(id,directory='')=>ok({projectId:id,projectName:'Demo workspace',directory,truncated:false,
          entries:['README.md','example.ts','preview.pdf'].map(name=>({name,path:name,kind:'file',bytes:files[name]?.length??${pdf.length}}))}),
        watchProjectFiles:()=>ok(true),previewProjectFile:(id,name)=>ok(info(id,name)),
        getProjectGitSnapshot:(id,baseRef)=>ok({projectId:id,state:'ready',truncated:false,revision:baseRef?'fixture-compared':'fixture-dirty',
          currentBranch:'feature',branches:[{ref:'refs/remotes/origin/main',label:'origin/main'},{ref:'refs/heads/feature',label:'feature'}],
          ...(baseRef?{comparison:{ref:baseRef,label:'origin/main',baseOid:'a'.repeat(40),headOid:'b'.repeat(40)}}:{}),changes:baseRef?[
          {status:'M',path:'README.md',additions:2,deletions:1,binary:false}
        ]:[
          {status:'M',path:'README.md',additions:2,deletions:1,binary:false},
          {status:'U',path:'notes.txt',additions:3,deletions:0,binary:false}
        ]}),
        getProjectGitDiff:(id,name)=>ok({projectId:id,status:'M',path:name,additions:2,deletions:1,binary:false,tooLarge:false,
          baseText:'# Demo workspace\\n',currentText:'# Demo workspace\\n\\nUpdated in the working tree.\\n'}),
        attachProjectFile:(id,name)=>{window.fixtureAttached.push({id,name});return ok({id:'file-1',name,size:12,mimeType:'text/plain'});},
        saveProjectFile:(id,name,text)=>{files[name]=text;window.fixtureSaves.push({id,name,text});return ok({preview:info(id,name)});},
        commitState:()=>ok({branch:'feature',defaultBranch:'main',remote:'origin',upstream:null,github:{owner:'octo',repo:'app'},gh:window.fixtureGh||'ready',changes:[{status:'M',path:'README.md',additions:2,deletions:1,binary:false},{status:'U',path:'notes.txt',additions:3,deletions:0,binary:false}],token:'a'.repeat(64)}),
        commitProject:request=>{window.fixtureCommits.push(request);return ok({commit:'abc1234',branch:request.newBranch||'feature'});},
        pushProject:()=>ok({branch:'feature',remote:'origin',tracking:true}),
        createPullRequest:()=>ok({url:'https://github.com/octo/app/pull/7',via:'gh'}),
        setCommitFlow:flow=>{config.ui.commitFlow=flow;return ok(true);},
        writeClipboard:()=>ok(true),connect:()=>{state.status.state='connected';return ok(state)},disconnect:()=>{state.status.state='disconnected';return ok(state)}
      },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:()=>ok(null)});
      await import('/main.ts');
      const {setLanguage,t}=await import('/i18n.ts');
      const {EditorView}=await import('@codemirror/view');
      window.fixture={setLanguage,t,readyConnection(){state.hasApiKey=true;config.tunnel.tunnelId='tunnel_'+'1'.repeat(32);},
        addMonitorWorker(){if(!rows.some(row=>row.id===monitorWorker.id))rows.push(monitorWorker);},
        edit(text){const view=EditorView.findFromDOM(document.querySelector('.file-preview .cm-editor'));
        if(!view)throw new Error('Editor not ready');view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text}});}};
      window.fixtureReady=true;
    `;
    const icons = path.join(root, 'node_modules/@phosphor-icons/web/src');
    server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), resolve: { alias: { '@phosphor-icons/web': icons } },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, fs.realpathSync(icons)] } }, plugins: [{ name: 'commit-dialog-fixture', configureServer(vite) {
        vite.middlewares.use('/fixture.html', async (_request, response) => {
          const source = withoutScripts(fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8'))
            .replace('</body>', '<script type="module">' + fixture + '</script></body>');
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/fixture.html', source));
        });
      } }] });
    await server.listen();
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) {
        const detail = await win.webContents.executeJavaScript('({errors:window.fixtureErrors,buttons:[...document.querySelectorAll(".file-preview button")].map(b=>({title:b.title,text:b.textContent})),preview:document.querySelector(".file-preview")?.textContent.slice(0,1000)})').catch(() => null);
        throw new Error(`Renderer script failed: ${code}\n${JSON.stringify(detail)}\n${error.message}`);
      }
    };
    const until = async expression => {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
      throw new Error('Renderer condition timed out: ' + expression + ' ' + JSON.stringify(await js('window.fixtureErrors')));
    };
    const screenshot = async name => {
      await js('document.getAnimations().forEach(animation => { if (animation.effect.getTiming().iterations !== Infinity) animation.finish(); })');
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await new Promise(resolve => setTimeout(resolve, 120));
      fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const dialog = `document.getElementById('commitDialog')`;
    const load = async (theme = 'dark') => {
      await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html?theme=' + theme);
      await until('window.fixtureReady && document.querySelectorAll(".sess[data-id]").length===3');
      await js(`document.querySelector('.sess[data-id="task-0"]').click()`);
      await until('!document.querySelector("#workDockRight .work-dock-quick[data-view=review]").disabled');
      await js(`document.getElementById('rightDockToggle').click()`);
      await js(`document.querySelector('#workDockRight .work-dock-quick[data-view=review]').click()`);
      await until(`!!document.querySelector('#workDockRight .file-commit-bar:not([hidden]) .file-commit-open')`);
    };
    // The Commit bar belongs to the list of changes: a file's diff hides it, and going back shows it again.
    const barFollowsList = async () => {
      await js(`document.querySelector('#workDockRight .file-change-row').click()`);
      // Review's own panel is the one whose list holds the change rows.
      const review = `[...document.querySelectorAll('#workDockRight .file-changes-view')].find(v => v.querySelector('.file-change-row'))`;
      await until(`${review}?.querySelector('.file-changes-header-title')?.textContent === 'Diff'`);
      assert.equal(await js(`${review}.querySelector('.file-commit-bar').hidden`), true, 'a diff hides the Commit bar');
      await js(`${review}.querySelector('.file-changes-back').click()`);
      await until(`!!document.querySelector('#workDockRight .file-commit-bar:not([hidden]) .file-commit-open')`);
    };
    const openCommit = async () => {
      await js(`document.querySelector('#workDockRight .file-commit-bar:not([hidden]) .file-commit-open').click()`);
      await until(`${dialog}.open && document.querySelectorAll('.commit-file').length===2`);
      await js('document.getAnimations().forEach(a => { if (a.effect.getTiming().iterations !== Infinity) a.finish(); })');
      await pause(150);
    };
    const layout = async label => {
      const view = await js(`(()=>{const d=${dialog},box=d.getBoundingClientRect();
        const shown=[...d.querySelectorAll('*')].filter(n=>n.offsetParent&&n.getClientRects().length);
        const inside=n=>{const r=n.getBoundingClientRect();return r.left>=box.left-0.5&&r.right<=box.right+0.5;};
        const cut=shown.filter(n=>n.matches('h2,b,em,span:not(.commit-file-path),label,button,p,legend,li')&&n.children.length===0&&n.scrollWidth>n.clientWidth+1).map(n=>n.id||n.className||n.textContent.slice(0,40));
        const primary=[...d.querySelectorAll('.btn-solid')].find(b=>b.offsetParent)?.getBoundingClientRect();
        const edges=[...d.querySelectorAll('.commit-where,.plugin-field,.commit-files-head,.commit-files,.commit-flow,.commit-steps')].filter(n=>n.offsetParent).map(n=>Math.round(n.getBoundingClientRect().left-box.left));
        return {fits:box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight,cut,outside:shown.filter(n=>!inside(n)).map(n=>n.id||n.className),
          edges:[...new Set(edges)],primaryShown:!!primary&&primary.top>=box.top&&primary.bottom<=box.bottom-1,sideways:d.scrollWidth>d.clientWidth+1};})()`);
      assert.equal(view.fits, true, `${label}: the dialog fits the window`);
      assert.deepEqual(view.cut, [], `${label}: no text is cut`);
      assert.deepEqual(view.outside, [], `${label}: nothing sticks out`);
      assert.equal(view.sideways, false, `${label}: no sideways scrolling`);
      assert.equal(view.edges.length <= 1, true, `${label}: one left edge ${JSON.stringify(view.edges)}`);
      assert.equal(view.primaryShown, true, `${label}: the main button is in view`);
    };
    let remembered = null;
    for (const name of ['dark', 'light']) {
      await load(name);
      if (name === 'dark') await barFollowsList();
      // A reload starts a new fixture; carry the first round's remembered choice over as the app would.
      if (remembered) await js(`window.api.setCommitFlow(${JSON.stringify(remembered)})`);
      assert.equal(await js('document.documentElement.dataset.theme'), name);
      await screenshot(`${name}-review-commit-bar`);
      await openCommit();
      assert.equal(await js(`document.getElementById('commitMessage').value`), 'Project review\n\n- README.md\n- notes.txt\n');
      // Nothing remembered at first; the dark round's choice is remembered for the light one.
      assert.equal(await js(`document.querySelector('input[name="commitFlow"]:checked').value`), name === 'dark' ? 'ask-push' : 'pr');
      await layout(`${name} form`);
      await screenshot(`${name}-form`);
      // The button says what it will do (Haz on #1825): the count, and for a pull request that it pushes too.
      await js(`(()=>{const i=document.querySelector('input[name="commitFlow"][value="ask-push"]');i.click();})()`);
      assert.equal(await js(`document.getElementById('commitSubmit').textContent`), 'Commit 2 files');
      await js(`(()=>{const i=document.querySelector('input[name="commitFlow"][value="pr"]');i.click();})()`);
      assert.equal(await js(`document.getElementById('commitSubmit').textContent`), 'Commit 2 files, push and open a pull request');
      await layout(`${name} pull request`);
      await js(`document.getElementById('commitSubmit').click()`);
      await until(`document.querySelectorAll('.commit-step.is-done').length===3`);
      await layout(`${name} done`);
      await screenshot(`${name}-done`);
      assert.equal(await js(`document.activeElement.id`), 'commitDoneClose');
      await js(`document.getElementById('commitDoneClose').click()`);
      await until(`!${dialog}.open`);
      remembered = await js('window.api.getState().then(s=>s.data.config.ui.commitFlow)');
      assert.equal(remembered, 'pr');
      assert.deepEqual(await js('window.fixtureCommits.map(c=>c.paths)'), [['README.md', 'notes.txt']]);
    }

    // Ask before pushing: the commit is reported, and Push waits for the person.
    await js(`(()=>{window.api.setCommitFlow('ask-push');})()`);
    await openCommit();
    await js(`document.getElementById('commitSubmit').click()`);
    await until(`!document.getElementById('commitStepAction').hidden`);
    assert.equal(await js(`document.getElementById('commitStepAction').textContent`), 'Push');
    await layout('ask to push');
    await screenshot('dark-ask-push');
    await js(`document.getElementById('commitNotNow').click()`);
    await until(`!${dialog}.open`);

    for (const language of LANGUAGES) {
      await js(`window.fixture.setLanguage(${JSON.stringify(language)})`);
      await openCommit();
      await js(`document.querySelector('input[name="commitFlow"][value="pr"]').click()`);
      await layout(`${language} form`);
      if (['de', 'ru', 'ja'].includes(language)) await screenshot(`${language}-form`);
      await js(`document.getElementById('commitCancel').click()`);
      await until(`!${dialog}.open`);
    }
    win.setContentSize(760, 640); await pause(300);
    for (const language of ['en', 'de', 'ru', 'vi']) {
      await js(`window.fixture.setLanguage(${JSON.stringify(language)})`);
      await openCommit();
      await layout(`${language} 760`);
      await screenshot(`${language}-760`);
      await js(`document.getElementById('commitCancel').click()`);
      await until(`!${dialog}.open`);
    }
    // With reduced motion the spinner cannot turn; a still quarter arc would look like a frozen app, so it is a whole ring.
    win.webContents.debugger.attach();
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const still = await js(`(()=>{const s=document.body.appendChild(document.createElement('span'));s.className='commit-step-spinner';const c=getComputedStyle(s);
      const r={animation:c.animationName,top:c.borderTopColor,right:c.borderRightColor};s.remove();return r;})()`);
    win.webContents.debugger.detach();
    assert.ok(still.animation === 'none' && still.top === still.right, `reduced motion: the spinner is a whole ring ${JSON.stringify(still)}`);
    assert.deepEqual(await js('window.fixtureErrors'), []);
    console.log('PASS: Review Commit button, dialog prefilled from the chat task, all three flows, done steps; 13 languages, both themes, 760 px; reduced motion');
  } catch (error) {
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    console.error(error);
    process.exitCode = 1;
  } finally {
    // The dev server can keep a socket open; the check must still end.
    await Promise.race([server?.close(), new Promise(resolve => setTimeout(resolve, 2000))]);
    app.exit(process.exitCode ?? 0);
  }
});
