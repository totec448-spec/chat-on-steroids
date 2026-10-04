// Real Chromium + production chat renderer with an isolated API fixture.
// Exercises the persistent background-process row together with the other composer-dock occupants.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env, encoding: 'utf8', windowsHide: true
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const output = path.join(root, 'outputs/background-process-dock');
  fs.mkdirSync(output, { recursive: true });
  const code = (await require('esbuild').build({
    entryPoints: [path.join(root, 'src/renderer/chat.ts')], bundle: true, write: false,
    platform: 'browser', format: 'iife', globalName: 'chat', logLevel: 'error', loader: { '.css': 'empty' },
    plugins: [{ name: 'vite-url-stub', setup(build) {
      build.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'vite-url-stub' }));
      build.onLoad({ filter: /.*/, namespace: 'vite-url-stub' }, () => ({ contents: 'export default ""', loader: 'js' }));
    } }]
  })).outputFiles[0].text;
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
    .replace('    <link rel="stylesheet" href="./icons.css" />\n', '')
    .replace('    <link rel="stylesheet" href="./styles.css" />\n', '')
    .replace('    <link rel="stylesheet" href="./settings.css" />\n', '')
    .replace('    <script type="module" src="./main.ts"></script>\n', '')
    .replace('</head>', `<style>${css}</style></head>`);
  const win = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await win.webContents.executeJavaScript(`(() => {
      const ok = data => Promise.resolve({ok:true,data});
      const base = (id,title,conversationId) => ({id,title,conversationId,chatIds:[conversationId],startedAt:1,updatedAt:Date.now(),endedAt:null,
        events:0,userMessages:0,toolCalls:0,lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,
        estimatedTokens:0,contextTokens:0,lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:null,activeTurnId:'turn-'+id,agents:[],origin:null});
      const a=base('process-a','Background process stress','fixture-a'), b=base('process-b','Other chat','fixture-b');
      const now=Date.now();
      const long='node -e "console.log(\\'background fixture with a deliberately long command that must truncate without pushing Stop off screen\\'); setInterval(() => {}, 1000)"';
      window.processFixture={
        sessions:[a,b], stopCalls:[], inputs:Array.from({length:8},(_,i)=>({id:'task-'+i,sessionId:a.id,text:'Queued verification stage '+(i+1)+' with enough descriptive text to exercise wrapping and the bounded task scroller.',
          mode:'after-turn',dueAt:0,state:'queued',owner:null,createdAt:now+i,conversationId:a.conversationId,model:null,reasoningEffort:null})),
        processes:{[a.id]:[{processId:7001,incarnation:101,command:long,startedAt:now-65_000,tty:false}],[b.id]:[]},
        controls:{
          [a.id]:{sessionId:a.id,activeTurnId:'turn-'+a.id,canInject:true,automation:'loop',objective:'Continue the verification until every requested check is complete.',blocked:'',
            recovery:[{kind:'post-reload',next:'continue',generating:true,deadline:now+120_000}],goalWait:{reason:'quiet',until:now+150_000},
            plan:{updatedAt:now,explanation:'Exercise the real composer dock with a running child and several independent status surfaces.',plan:[
              {step:'Start the background service',status:'completed',details:'The process must stay owned by this chat.'},
              {step:'Verify the live UI',status:'in_progress',details:'Check elapsed time, Stop, task scrolling and narrow widths.'},
              {step:'Exercise queued follow-ups',status:'pending',details:'Keep several later stages visible without growing the whole dock.'},
              {step:'Switch chats safely',status:'pending'},{step:'Wait for spontaneous exit',status:'pending'},{step:'Finish regression checks',status:'pending'}
            ]}}
          ,[b.id]:{sessionId:b.id,activeTurnId:'turn-'+b.id,canInject:true,automation:'off',objective:'',blocked:'',recovery:[],goalWait:null,plan:null}
        }, backgroundListeners:new Set(), sessionListeners:new Set()
      };
      const live=window.processFixture;
      window.api=new Proxy({
        listSessions:()=>ok({sessions:live.sessions,activeId:null,blocked:[],pressure:[]}), listProjects:()=>ok([]),
        getSession:id=>ok({summary:live.sessions.find(row=>row.id===id),total:0,events:[],nextFrom:0}),
        getSessionControls:id=>ok(structuredClone(live.controls[id]??null)), listInputs:()=>ok(structuredClone(live.inputs)), listPausedHelpers:()=>ok([]), runningTools:()=>ok([]),
        runningProcesses:id=>ok(structuredClone(live.processes[id]??[])),
        stopProcess:(id,processId,incarnation)=>{live.stopCalls.push({id,processId,incarnation});const before=live.processes[id]?.length??0;live.processes[id]=(live.processes[id]??[]).filter(row=>row.processId!==processId||row.incarnation!==incarnation);
          for(const listener of live.backgroundListeners)listener();return ok((live.processes[id]?.length??0)<before)},
        onBackgroundProcessesChanged:fn=>{live.backgroundListeners.add(fn);return()=>live.backgroundListeners.delete(fn)},
        onSessionChanged:fn=>{live.sessionListeners.add(fn);return()=>live.sessionListeners.delete(fn)}, onTaskProgress:()=>()=>{},
        getChatModels:()=>ok({state:'ready',observedAt:now,models:[{id:'gpt-5.6-sol',label:'GPT-5.6 Sol',efforts:['high']}]}),
        reorderQueuedInputs:()=>ok(true), editQueuedInput:()=>ok(true), cancelInput:()=>ok(true)
      },{get:(target,key)=>key in target?target[key]:(()=>ok(null))});
      live.publishBackground=()=>{for(const listener of live.backgroundListeners)listener()};
      live.publishSession=()=>{for(const listener of live.sessionListeners)listener({allTranscripts:true})};
      window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    })()`);
    await win.webContents.executeJavaScript(code);
    const js = source => win.webContents.executeJavaScript(source);
    const wait = async (condition, detail = '') => {
      for (let i = 0; i < 200; i++) {
        if (await js(condition)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Renderer condition timed out: ' + condition + ' ' + detail);
    };
    await js(`chat.initChat({state:()=>null,save:async()=>{}});chat.chatVisible(true);`);
    await wait('!!document.querySelector("#sessionList [data-id=\\"process-a\\"]")');
    await js(`document.querySelector('#sessionList [data-id="process-a"]').click()`);
    await wait('!document.getElementById("backgroundExecStatus").hidden && !document.getElementById("finishQueue").hidden');

    // One process: exact command is in the tooltip while the visible line stays compact.
    let one = await js(`(() => {const row=document.getElementById('backgroundExecStatus'),label=row.querySelector('.queue-label'),stop=row.querySelector('.background-exec-stop');
      return {label:label.textContent,title:row.title,time:row.querySelector('.background-exec-time').textContent,stop:stop.textContent,stopTitle:stop.title};})()`);
    assert.match(one.label, /^Background process running · node -e /); assert.match(one.title, /^#7001 node -e /);
    assert.match(one.time, /^Running for 1m \d+s$/); assert.equal(one.stop.trim(), 'Stop'); assert.equal(one.stopTitle, 'Stop background process');
    // The elapsed label may update, but the native hover tooltip must remain byte-for-byte stable
    // so Chromium does not dismiss/reopen it once per second.
    await wait(`document.querySelector('#backgroundExecStatus .background-exec-time').textContent!==${JSON.stringify(one.time)}`);
    const afterTick = await js(`({title:document.getElementById('backgroundExecStatus').title,time:document.querySelector('#backgroundExecStatus .background-exec-time').textContent})`);
    assert.equal(afterTick.title, one.title); assert.notEqual(afterTick.time, one.time);

    // Switching chats never leaks A's process into B; switching back restores A from the manager projection.
    await js(`document.querySelector('#sessionList [data-id="process-b"]').click()`);
    await wait('document.getElementById("backgroundExecStatus").hidden');
    await js(`document.querySelector('#sessionList [data-id="process-a"]').click()`);
    await wait('!document.getElementById("backgroundExecStatus").hidden');

    // Multiple live children collapse into one row, then expand into individually actionable rows.
    await js(`processFixture.processes['process-a'].push({processId:7002,incarnation:102,command:'npm run watch',startedAt:Date.now()-20_000,tty:true});processFixture.publishBackground()`);
    await wait('document.querySelector("#backgroundExecStatus .queue-label").textContent.startsWith("2 background processes running")');
    const multiple = await js(`({label:document.querySelector('#backgroundExecStatus .queue-label').textContent,title:document.getElementById('backgroundExecStatus').title,expanded:document.getElementById('backgroundExecStatus').getAttribute('aria-expanded'),listHidden:document.getElementById('backgroundExecList').hidden,summaryStopHidden:document.querySelector('#backgroundExecStatus .background-exec-stop').hidden})`);
    assert.equal(multiple.label, '2 background processes running');
    assert.match(multiple.title, /#7001 /); assert.match(multiple.title, /#7002 npm run watch/);
    assert.equal(multiple.expanded, 'false'); assert.equal(multiple.listHidden, true); assert.equal(multiple.summaryStopHidden, true);
    await js(`document.getElementById('backgroundExecStatus').click()`);
    await wait('document.getElementById("backgroundExecStatus").getAttribute("aria-expanded")==="true" && !document.getElementById("backgroundExecList").hidden && document.querySelectorAll("#backgroundExecList .background-exec-process").length===2');
    const expanded = await js(`[...document.querySelectorAll('#backgroundExecList .background-exec-process')].map(row=>({text:row.textContent,title:row.title,id:row.dataset.processId,incarnation:row.dataset.incarnation}))`);
    assert.equal(expanded.length, 2); assert.match(expanded[0].text, /#7001 /); assert.match(expanded[1].text, /#7002 npm run watch/);

    // Each expanded row targets exactly the child it represents. Stop the newer child and keep the oldest one live.
    await js(`document.querySelectorAll('#backgroundExecList .background-exec-stop')[1].click()`);
    await wait('processFixture.stopCalls.length===1 && document.querySelector("#backgroundExecStatus .queue-label").textContent.startsWith("Background process running")');
    assert.deepEqual(await js('processFixture.stopCalls[0]'), {id:'process-a',processId:7002,incarnation:102});
    assert.match(await js('document.getElementById("backgroundExecStatus").title'), /#7001 /);

    // A child exiting without a tool call publishes lifecycle state and removes the persistent row.
    await js(`processFixture.processes['process-a']=[];processFixture.publishBackground()`);
    await wait('document.getElementById("backgroundExecStatus").hidden');
    await js(`processFixture.processes['process-a']=[
      {processId:7003,incarnation:103,command:'npm run dev -- --fixture-with-a-long-background-command-that-must-ellipsis-cleanly',startedAt:Date.now()-65_000,tty:false},
      {processId:7004,incarnation:104,command:'npm run watch',startedAt:Date.now()-20_000,tty:true},
      {processId:7005,incarnation:105,command:'node scripts/background-worker.js --fixture',startedAt:Date.now()-8_000,tty:false},
      {processId:7006,incarnation:106,command:'node scripts/background-worker-two.js --fixture',startedAt:Date.now()-4_000,tty:false}
    ];processFixture.publishBackground()`);
    await wait('document.querySelector("#backgroundExecStatus .queue-label").textContent==="4 background processes running"');
    await js(`document.getElementById('backgroundExecStatus').click()`);
    await wait('!document.getElementById("backgroundExecList").hidden && document.querySelectorAll("#backgroundExecList .background-exec-process").length===4');

    // Stress the real dock occupants at wide/narrow sizes and zoom. The queue alone scrolls;
    // the process row, Stop action, recovery/Goal statuses and composer remain reachable.
    await wait('!document.getElementById("agentPlan").hidden && !document.getElementById("recoveryStatus").hidden && !document.getElementById("activeGoalRow").hidden');
    await js(`document.querySelector('#agentPlan .agent-plan-heading').click();`);
    const cases = [
      {width:1100,height:800,zoom:1,theme:'dark',file:'wide-dark'},
      {width:640,height:800,zoom:1,theme:'light',file:'narrow-light'},
      {width:640,height:800,zoom:1.5,theme:'dark',file:'narrow-zoom'},
      {width:420,height:800,zoom:1,theme:'dark',file:'phone-width'}
    ];
    const measurements = [];
    for (const sample of cases) {
      // Reset zoom before sizing: changing the content size while the previous case is still at
      // 150% makes Electron preserve that effective CSS viewport for the next measurement.
      win.webContents.setZoomFactor(sample.zoom); win.setContentSize(sample.width, sample.height);
      await js(`document.documentElement.dataset.theme=${JSON.stringify(sample.theme)};frame()`);
      const measured = await js(`(() => {
        const dock=document.getElementById('composerDock'),proc=document.getElementById('backgroundExecStatus'),list=document.getElementById('backgroundExecList'),queue=document.getElementById('finishQueue'),composer=document.getElementById('composer');
        const stop=proc.querySelector('.background-exec-stop'),time=proc.querySelector('.background-exec-time');
        const itemStops=[...list.querySelectorAll('.background-exec-stop')].map(node=>node.getBoundingClientRect()),d=dock.getBoundingClientRect(),p=proc.getBoundingClientRect(),l=list.getBoundingClientRect(),s=stop.getBoundingClientRect(),t=time.getBoundingClientRect(),c=composer.getBoundingClientRect();
        return {viewport:[innerWidth,innerHeight],dock:[d.left,d.right,d.top,d.bottom],process:[p.left,p.right,p.top,p.bottom],list:[l.left,l.right,l.top,l.bottom],stop:[s.left,s.right],time:[t.left,t.right],composer:[c.top,c.bottom],
          queueClient:queue.clientHeight,queueScroll:queue.scrollHeight,queueOverflow:getComputedStyle(queue).overflowY,
          timeVisible:t.width>0,
          fits:d.left>=0&&d.right<=innerWidth+1&&p.left>=d.left-1&&p.right<=d.right+1&&l.left>=d.left-1&&l.right<=d.right+1&&(!t.width||(t.left>=d.left&&t.right<=d.right))&&itemStops.every(rect=>rect.left>=d.left&&rect.right<=d.right)&&proc.scrollWidth<=proc.clientWidth+1&&list.scrollWidth<=list.clientWidth+1,
          processVisible:!proc.hidden&&p.height>0,listVisible:!list.hidden&&l.height>0,queueVisible:!queue.hidden&&queue.clientHeight>0,composerVisible:c.top<innerHeight&&c.bottom>0,error:window.fixtureError||null};
      })()`);
      assert.equal(measured.error, null, JSON.stringify({sample,measured})); assert.ok(measured.fits, JSON.stringify({sample,measured}));
      assert.ok(measured.processVisible && measured.listVisible && measured.queueVisible && measured.composerVisible, JSON.stringify({sample,measured}));
      assert.equal(measured.queueOverflow, 'auto'); assert.ok(measured.queueScroll > measured.queueClient, JSON.stringify({sample,measured}));
      assert.ok(measured.queueClient <= 241, JSON.stringify({sample,measured}));
      if (measured.viewport[0] <= 480) assert.equal(measured.timeVisible, false, JSON.stringify({sample,measured}));
      measurements.push({sample,...measured});
      await js('frame()'); fs.writeFileSync(path.join(output, sample.file+'.png'), (await win.webContents.capturePage()).toPNG());
    }
    fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(measurements, null, 2));
    console.log(`Passed background-process dock lifecycle, isolation, Stop and ${cases.length} geometry cases. Screenshots: ${output}`);
  } finally {
    win.destroy(); app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
