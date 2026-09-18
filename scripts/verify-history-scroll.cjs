/** Real renderer regression for dense activity paging. Synthetic data by default.
 * node scripts/verify-history-scroll.cjs [--show] [--recording /path/to/event-snapshot.json]
 * Optional recordings are read-only local evidence and never included in the repository. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const built = await require('esbuild').build({ entryPoints: [path.join(root, 'src/renderer/chat.ts')],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'chat',
    outfile: path.join(root, '.local/history-fixture.js'),
    plugins: [{ name: 'fixture-url-assets', setup(build) {
      build.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'fixture-url' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture-url' }, () => ({ contents: 'export default "";', loader: 'js' }));
    } }] });
  const code = built.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8') +
    built.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '')
    .replace('</head>', `<style>${css}</style></head>`);
  const show = process.argv.includes('--show');
  const win = new BrowserWindow({ show, title: 'CoS history scroll verification', width: 1400, height: 1000,
    webPreferences: { sandbox: true, backgroundThrottling: false, offscreen: !show } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await win.webContents.executeJavaScript(`(() => {
    const ok = data => Promise.resolve({ok:true, data});
    const text = value => ({text:value, truncated:false, chars:value.length});
    let sessionChanged = null;
    const history = [];
    const add = event => { const seq=history.length+1; history.push({seq,time:seq,source:'extension',...event}); };
    add({kind:'user_message',messageId:'long-task',message:text(('The full earlier task stays above the recent work.\\n\\n').repeat(120))});
    for(let i=0;i<200;i++) add({kind:'tool_call',source:'mcp',call:{callId:'tool-'+i,tool:'read',
      args:text('{}'),result:text('Recorded tool output. '.repeat(50)),outcome:'ok',durationMs:1,
      attribution:'request_id',summary:{kind:'read',title:'Read file '+i,tone:'neutral'}}});
    for(let i=0;i<8;i++) add({kind:'assistant_message',messageId:'recent-'+i,message:text('Recent visible message '+i),state:'final',final:true});
    const session={id:'history-fixture',title:'Dense history fixture',conversationId:'fixture',chatIds:['fixture'],
      startedAt:1,updatedAt:1,endedAt:null,events:history.length,userMessages:1,toolCalls:200,
      errors:0,estimatedTokens:0,contextTokens:0,agents:[],origin:null};
    window.fixture={history,session,inputs:[],reads:[],listReads:0,
      add:event=>{add(event);session.events=history.length;session.updatedAt++;},
      signal:()=>{if(!sessionChanged)throw new Error('onSessionChanged was not registered');sessionChanged();}};
    window.api=new Proxy({
      listSessions:()=>{fixture.listReads++;return ok({sessions:[session],activeId:null,blocked:[],pressure:[]})},
      listProjects:()=>ok([]),listInputs:()=>ok(fixture.inputs),listPausedHelpers:()=>ok([]),
      onSessionChanged:handler=>{sessionChanged=handler;return()=>{if(sessionChanged===handler)sessionChanged=null;}},
      getSession:(_id,options)=>{
        fixture.reads.push(options);
        const position=e=>e.origin??e.seq;
        const eligible=history.filter(e=>(options.from===undefined||e.seq>=options.from)&&(options.before===undefined||position(e)<options.before)&&(options.after===undefined||position(e)>options.after))
          .sort((a,b)=>options.from===undefined?position(a)-position(b):a.seq-b.seq);
        const events=options.from===undefined&&options.after===undefined?eligible.slice(-options.limit):eligible.slice(0,options.limit);
        return ok({summary:session,total:history.length,events,nextFrom:events.reduce((n,e)=>Math.max(n,e.seq+1),options.from??0)});
      }
    },{get:(target,key)=>target[key]??(()=>ok(null))});
    window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    window.waitFor=async predicate=>{
      const deadline=performance.now()+5000;
      while(performance.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}
      throw new Error('Timed out waiting for synthetic session refresh: '+JSON.stringify({reads:fixture.reads.slice(-10),geometry:geometry(),users:document.querySelectorAll('#timeline .ev-user_message').length}));
    };
    window.geometry=()=>{
      const pane=document.getElementById('chatBody'),timeline=document.getElementById('timeline');
      const row=[...timeline.querySelectorAll('.ev-assistant_message')].find(e=>e.textContent.includes('Recent visible message 0'));
      const bounds=pane.getBoundingClientRect();
      return {top:pane.scrollTop,height:pane.scrollHeight,viewport:pane.clientHeight,
        readerTop:row?.getBoundingClientRect().top-bounds.top,readerPresent:!!row,
        groups:timeline.querySelectorAll('.tool-group').length,records:timeline.querySelectorAll('.ev').length,
        bottomGap:pane.scrollHeight-pane.clientHeight-pane.scrollTop,
        x:Math.round(bounds.right-100),y:Math.round(bounds.top+100)};
    };
  })()`);
  await win.webContents.executeJavaScript(code);
  await win.webContents.executeJavaScript(`(async()=>{
    chat.initChat({state:()=>null,save:async()=>{}});chat.chatVisible(true);await frame();
    document.querySelector('#sessionList [data-id="history-fixture"]').click();
    for(let i=0;i<120&&!geometry().readerPresent;i++) await frame();
    await waitFor(()=>document.querySelector('#timeline .ev-user_message'));
    await frame();
  })()`);
  win.webContents.debugger.attach('1.3');
  const initial = await win.webContents.executeJavaScript('geometry()');
  assert.ok(initial.viewport > 0 && initial.height > 4000, 'Opening fills visible history through collapsed batches without wheel input: '+JSON.stringify(initial));
  let older = initial;
  const stages = [];
  for (let stage = 0; stage < 10 && older.height <= 4000; stage++) {
    const before = older;
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseWheel',x:before.x,y:before.y,deltaY:-100,deltaX:0});
    await new Promise(resolve=>setTimeout(resolve,250));
    older = await win.webContents.executeJavaScript('geometry()');
    assert.ok(older.readerPresent && Math.abs(older.readerTop-before.readerTop) <= 110,
      'Each 30-row stage preserves the reader: '+JSON.stringify({before,older}));
    stages.push(older);
  }
  assert.equal(older.readerPresent,true,'Prepending must not evict the messages currently on screen');
  assert.ok(Math.abs(older.readerTop-initial.readerTop) <= 110, 'One wheel step must not jump to the earlier long task: '+JSON.stringify({initial,older}));
  assert.ok(older.height > 4000,'Earlier task must actually load above the reader: '+JSON.stringify({initial,older,reads:await win.webContents.executeJavaScript('fixture.reads')}));
  assert.equal(older.groups,1,'The overlapping activity remains one disclosure');
  const expanded = await win.webContents.executeJavaScript(`(async()=>{
    const pane=document.getElementById('chatBody'),timeline=document.getElementById('timeline');
    const group=timeline.querySelector('.tool-group');
    const collapsedHeight=group.getBoundingClientRect().height;
    group.querySelector('summary').click();await frame();
    const tools=group.querySelectorAll('.tool');
    tools[100].querySelector('summary').click();await frame();
    const output=tools[100].querySelector('.raw');
    pane.scrollTop+=output.getBoundingClientRect().top-pane.getBoundingClientRect().top-100;await frame();
    const rect=pane.getBoundingClientRect();
    return {collapsedHeight,expandedHeight:group.getBoundingClientRect().height,
      rawCount:timeline.querySelectorAll('.raw').length,top:pane.scrollTop,
      x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+160)};
  })()`);
  assert.ok(expanded.collapsedHeight<60 && expanded.expandedHeight>4000,'Group height follows its actual disclosure');
  assert.equal(expanded.rawCount,1,'Only the deliberately expanded call materializes its output');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:expanded.x,y:expanded.y,deltaY:120,deltaX:0});
  await new Promise(resolve=>setTimeout(resolve,200));
  const collapsedAgain=await win.webContents.executeJavaScript(`(async()=>{
    const pane=document.getElementById('chatBody'),group=document.querySelector('#timeline .tool-group');
    const afterWheel=pane.scrollTop;
    group.querySelector('summary').click();await frame();
    const height=group.getBoundingClientRect().height;
    const hiddenOutputHeight=group.querySelector('.raw').getBoundingClientRect().height;
    pane.scrollTop=pane.scrollHeight;await frame();
    return {afterWheel,height,hiddenOutputHeight};
  })()`);
  assert.ok(Math.abs(collapsedAgain.afterWheel-expanded.top-120)<2,'Native wheel over an expanded group travels its requested distance');
  assert.equal(collapsedAgain.height,expanded.collapsedHeight,'Collapsing returns to one headline');
  assert.equal(collapsedAgain.hiddenOutputHeight,0,'Collapsed output contributes no scroll geometry');
  const historicalRefresh=await win.webContents.executeJavaScript(`(async()=>{
    const listBefore=fixture.listReads;fixture.signal();
    await waitFor(()=>fixture.listReads>listBefore);await frame();
    return {...geometry(),listBefore,listAfter:fixture.listReads};
  })()`);
  assert.ok(historicalRefresh.listAfter>historicalRefresh.listBefore,'Historical refresh must perform a list read');
  assert.equal(historicalRefresh.readerTop,older.readerTop,'Historical repaint preserves the underfilled tail reserve');
  const observations=[{phase:'initial',...initial},...stages.map((stage,index)=>({phase:'older-'+index,...stage}))];
  for(let cycle=0;cycle<4;cycle++) {
    const before=await win.webContents.executeJavaScript('geometry()');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:before.x,y:before.y,deltaY:cycle%2 ? -100 : 100,deltaX:0});
    await new Promise(resolve=>setTimeout(resolve,150));
    const after=await win.webContents.executeJavaScript('geometry()');
    assert.ok(after.readerPresent && Math.abs(after.readerTop-before.readerTop)<=110,'Direction reversal stays within the wheel distance');
    assert.ok(after.height > 4000,'Returning to the tail must retain the adjacent long row instead of collapsing the scrollbar');
    observations.push({phase:'reverse-'+cycle,...after});
  }
  const latest=await win.webContents.executeJavaScript(`(async()=>{
    const readBefore=fixture.reads.length;
    const pane=document.getElementById('chatBody');
    for(let i=0;i<4;i++){
      pane.scrollTop=pane.scrollHeight;
      pane.dispatchEvent(new WheelEvent('wheel',{deltaY:100}));
      await frame();
    }
    return {...geometry(),banner:!!document.querySelector('[data-history="latest"]'),readBefore,readAfter:fixture.reads.length};
  })()`);
  assert.equal(latest.banner,false,'History navigation never renders a Back to latest banner');
  const refresh=await win.webContents.executeJavaScript(`(async()=>{
    const before=geometry();
    const readBefore=fixture.reads.length;
    fixture.add({kind:'assistant_message',messageId:'live-new',message:{text:'New live work',truncated:false,chars:13},state:'final',final:true});
    fixture.signal();
    await waitFor(()=>fixture.reads.length>readBefore&&[...document.querySelectorAll('.ev-assistant_message')].some(row=>row.textContent.includes('New live work')));
    await frame();
    return {before,after:geometry(),readBefore,readAfter:fixture.reads.length,
      inserted:[...document.querySelectorAll('.ev-assistant_message')].some(row=>row.textContent.includes('New live work'))};
  })()`);
  assert.ok(refresh.readAfter>refresh.readBefore,'Live refresh must perform a session read');
  assert.equal(refresh.inserted,true,'Live refresh must render the inserted assistant row');
  assert.ok(refresh.after.records>refresh.before.records,'Live refresh must add a rendered record');
  assert.ok(refresh.after.readerPresent,'Live deltas retain the reader');
  if(refresh.before.bottomGap<=1) assert.ok(refresh.after.bottomGap<=1,'A live refresh at the bottom must continue following it');
  else assert.ok(Math.abs(refresh.after.readerTop-refresh.before.readerTop)<2,'A live refresh must preserve the deliberate reader row');
  const bottomRefresh=await win.webContents.executeJavaScript(`(async()=>{
    const pane=document.getElementById('chatBody');pane.scrollTop=pane.scrollHeight;await frame();
    const before=geometry(),readBefore=fixture.reads.length;fixture.signal();
    await waitFor(()=>fixture.reads.length>readBefore);await frame();
    return {before,after:geometry(),readBefore,readAfter:fixture.reads.length};
  })()`);
  assert.ok(bottomRefresh.readAfter>bottomRefresh.readBefore,'Bottom refresh must perform a session read');
  assert.equal(bottomRefresh.after.readerTop,bottomRefresh.before.readerTop,'An unchanged live repaint cannot consume the tail reserve');
  await win.webContents.executeJavaScript(`(async()=>{
    document.getElementById('newChat').click();await frame();
    fixture.history.splice(0,fixture.history.length,{seq:50,time:50,source:'extension',kind:'user_message',messageId:'short',message:{text:'Short chat',chars:10,truncated:false}});
    fixture.session.events=1;
    document.querySelector('#sessionList [data-id="history-fixture"]').click();
    await waitFor(()=>document.getElementById('timeline').textContent.includes('Short chat'));await frame();
  })()`);
  const shortBefore=await win.webContents.executeJavaScript('geometry()');
  assert.equal(shortBefore.height,shortBefore.viewport,'Short conversation fits without overflow');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:shortBefore.x,y:shortBefore.y,deltaY:-100,deltaX:0});
  const shortAfter=await win.webContents.executeJavaScript(`(async()=>{
    await waitFor(()=>fixture.reads.some(read=>read.before===50));await frame();
    const after=geometry();
    fixture.history.push({seq:51,time:51,source:'extension',kind:'assistant_message',messageId:'short-live',message:{text:'Still live',chars:10,truncated:false},final:true});
    fixture.signal();await waitFor(()=>document.getElementById('timeline').textContent.includes('Still live'));
    return {...after,banner:!!document.querySelector('.timeline-window-note')};
  })()`);
  assert.equal(shortAfter.top,0,'Wheel-up cannot scroll a fitting conversation');
  assert.equal(shortAfter.height,shortAfter.viewport,'Empty history does not create overflow');
  assert.equal(shortAfter.banner,false,'Short conversation never shows a navigation banner');
  const interjection = await win.webContents.executeJavaScript(`(async()=>{
    fixture.inputs=[{id:'interjection',sessionId:'history-fixture',text:'Pending correction beside current tools',
      delivery:'tool',mode:'auto',state:'queued',createdAt:52,dueAt:52}];
    fixture.signal();await waitFor(()=>document.querySelector('#inputQueue .pending-message'));await frame();
    const pane=document.getElementById('chatBody'),timeline=document.getElementById('timeline');
    const root=document.getElementById('timelineContent')||timeline;
    // A legitimate underfilled-page reserve must stay below the entire transcript,
    // including the input which is still awaiting its first tool receipt.
    root.style.setProperty('--timeline-scroll-reserve','600px');
    pane.scrollTop=pane.scrollHeight;await frame();
    const pending=document.querySelector('#inputQueue .pending-message');
    for(const animation of pending.getAnimations()) animation.finish();
    await frame();
    const last=timeline.lastElementChild;
    const gap=pending.getBoundingClientRect().top-last.getBoundingClientRect().bottom;
    const before=pending.getBoundingClientRect().top,scrollBefore=pane.scrollTop;
    pane.scrollTop=Math.max(0,scrollBefore-80);await frame();
    const movement=pending.getBoundingClientRect().top-before;
    const pendingBeforeDelivery=pending.getBoundingClientRect().top;
    const count=()=>[...document.querySelectorAll('#timeline .said.is-user,#inputQueue .pending-message')]
      .filter(row=>row.textContent.includes('Pending correction beside current tools')).length;
    fixture.history.push({seq:52,time:52,source:'app',kind:'user_message',messageId:'input:interjection',inputId:'interjection',
      message:{text:fixture.inputs[0].text,chars:45,truncated:false}});
    fixture.inputs[0]={...fixture.inputs[0],state:'tool',messageId:'input:interjection',offeredAt:52,historyAnchored:true,historySeq:52};
    fixture.signal();await waitFor(()=>!document.querySelector('#inputQueue .pending-message'));await frame();
    const delivered=[...timeline.querySelectorAll('[data-timeline-key]')].find(row=>row.dataset.timelineKey==='input:interjection')?.querySelector('.user-message-text');
    return {gap,movement,scrollDelta:scrollBefore-(scrollBefore-80<0?0:scrollBefore-80),copies:count(),
      deliveryDrift:delivered?Math.abs(delivered.getBoundingClientRect().top-pendingBeforeDelivery):null};
  })()`);
  assert.ok(interjection.gap >= 0 && interjection.gap < 60,
    'Pending interjection stays adjacent to transcript content, never beyond reserved empty space: '+JSON.stringify(interjection));
  assert.ok(Math.abs(interjection.movement-interjection.scrollDelta)<2,'Pending interjection moves with the transcript');
  assert.equal(interjection.copies,1,'First tool delivery keeps exactly one interjection');
  assert.ok(interjection.deliveryDrift!==null && interjection.deliveryDrift<2,
    'First tool delivery preserves the interjection position: '+JSON.stringify(interjection));
  const revisedHistory=await win.webContents.executeJavaScript(`(async()=>{
    document.getElementById('newChat').click();await frame();
    fixture.history.splice(0,fixture.history.length,...Array.from({length:360},(_,i)=>({
      seq:i+1,time:1,source:'extension',kind:'user_message',messageId:'position-'+i,
      message:{text:'History position '+(i+1),chars:25,truncated:false}})));
    fixture.history[99]={seq:1000,origin:100,time:1,source:'extension',kind:'assistant_message',messageId:'review',
      message:{text:'Detailed review with ratings. '.repeat(650),chars:18850,truncated:false},final:true};
    fixture.inputs=[{id:'old',sessionId:'history-fixture',text:'Already delivered input',state:'sent',mode:'auto',
      createdAt:100,deliveredAt:110,messageId:'input:old',historyAnchored:true,historyRecorded:true,historySeq:50},
      {id:'waiting',sessionId:'history-fixture',text:'Still waiting input',state:'queued',mode:'auto',createdAt:100,dueAt:100}];
    fixture.session.events=1000;
    document.querySelector('#sessionList [data-id="history-fixture"]').click();
    await waitFor(()=>document.getElementById('timeline').textContent.includes('History position 360'));
    fixture.signal();await waitFor(()=>document.getElementById('inputQueue').textContent.includes('Still waiting input'));
    const pane=document.getElementById('chatBody'),timeline=document.getElementById('timeline');
    const checks=[];
    for(let i=0;i<12&&!timeline.textContent.includes('Detailed review');i++) {
      pane.scrollTop=0;await frame();const count=fixture.reads.length;
      pane.dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));
      await waitFor(()=>fixture.reads.length>count);await frame();
      checks.push(fixture.reads.at(-1));
    }
    const present=timeline.textContent.includes('Detailed review');
    const reads=fixture.reads.length;
    // Panel departure/return performs the same production refresh path.
    chat.chatVisible(false);chat.chatVisible(true);await frame();
    return {present,afterReturn:timeline.textContent.includes('Detailed review'),checks,reads,
      queue:document.getElementById('inputQueue').textContent,
      copies:timeline.querySelectorAll('.ev-assistant_message').length};
  })()`);
  assert.equal(revisedHistory.present,true,'A revised long answer remains reachable by its original history page');
  assert.equal(revisedHistory.afterReturn,true,'Returning to the chat retains the long answer');
  assert.equal(revisedHistory.copies,1,'The long answer has one canonical row');
  assert.ok(!revisedHistory.queue.includes('Already delivered input'),'Old timestamps cannot resurrect a committed input in the queue');
  assert.ok(revisedHistory.queue.includes('Still waiting input'),'The actual waiting input stays visible');
  assert.ok(await win.webContents.executeJavaScript('fixture.reads.every(read => read.limit === 30)'),
    'Opening, history navigation and live deltas all use 30-row requests');
  const recordingAt = process.argv.indexOf('--recording');
  if (recordingAt >= 0) {
    const recordingPath = process.argv[recordingAt + 1];
    if (!recordingPath) throw new Error('--recording requires an event snapshot path');
    const recording = JSON.parse(fs.readFileSync(recordingPath, 'utf8'));
    const source = Array.isArray(recording) ? recording : recording.events;
    assert.ok(Array.isArray(source) && source.length > 0 && source.every(row =>
      row && Number.isFinite(row.seq) && typeof row.kind === 'string'), 'Recording must contain stored events');
    const compiled = require('esbuild').transformSync(fs.readFileSync(path.join(root, 'src/shared/chronology.ts'), 'utf8'),
      { loader: 'ts', format: 'cjs' }).code;
    const module = { exports: {} }; new Function('module', 'exports', compiled)(module, module.exports);
    const { chronological, projectTimeline, positionOf } = module.exports;
    const turns = {};
    for (const row of [...source].sort((a,b)=>a.seq-b.seq)) {
      if (row.kind === 'turn_start' && row.turnId && !turns[row.turnId]) turns[row.turnId] = {origin:positionOf(row),time:row.time};
      if (row.kind === 'turn_end' && turns[row.turnId]) turns[row.turnId].endTime = Math.max(turns[row.turnId].endTime || 0,row.time);
    }
    const projected = projectTimeline(source, recording.summary?.timelineTurns ?? turns, recording.summary?.requestTurns);
    const keys = [...new Set(chronological(projected).flatMap(row => {
      if (row.kind === 'user_message' && row.inputId) return ['input:'+row.inputId];
      if (row.kind === 'tool_call') return [`message:tool_call\u0000${row.call.callId}`];
      return ['user_message','assistant_message'].includes(row.kind) && row.messageId
        ? [`message:${row.kind}\u0000${row.messageId}`] : [];
    }))];
    await win.webContents.executeJavaScript(`(async()=>{
      document.getElementById('newChat').click();await frame();
      fixture.history.splice(0,fixture.history.length,...${JSON.stringify(projected)});
      fixture.inputs=[];fixture.session.events=fixture.history.length;fixture.session.updatedAt++;
      // Use a distinct recording identity instead of reusing the synthetic history window.
      fixture.session.id='recorded-fixture';fixture.signal();
      window.recordingOrder = new Map(${JSON.stringify(keys)}.map((key,index)=>[key,index]));
      await waitFor(()=>document.querySelector('#sessionList [data-id="recorded-fixture"]'));
      document.querySelector('#sessionList [data-id="recorded-fixture"]').click();
      await waitFor(()=>document.querySelectorAll('#timeline [data-timeline-key]').length>0);await frame();
    })()`);
    const recorded = await win.webContents.executeJavaScript(`(async()=>{
      const pane=document.getElementById('chatBody'),timeline=document.getElementById('timeline');
      const steps=[];
      const order=()=>[...timeline.querySelectorAll('[data-timeline-key]')]
        .map(row=>row.dataset.timelineKey).filter(key=>recordingOrder.has(key));
      const checkOrder=()=>{
        const keys=order();
        if(new Set(keys).size!==keys.length) throw new Error('Duplicate canonical recording row');
        for(let i=1;i<keys.length;i++) if(recordingOrder.get(keys[i-1])>recordingOrder.get(keys[i]))
          throw new Error('Recording order changed across a history boundary');
      };
      checkOrder();
      for(const direction of [-1,1]) for(let stage=0;stage<Math.ceil(fixture.history.length/30)+5;stage++) {
        pane.scrollTop=direction<0?0:pane.scrollHeight;await frame();
        const edge=pane.getBoundingClientRect().top;
        const anchor=[...timeline.querySelectorAll('[data-timeline-key]')].find(row=>{
          const rect=row.getBoundingClientRect();return !row.matches('.tool-group[open]') && rect.height>0 && rect.bottom>edge && rect.top<edge+pane.clientHeight;
        });
        const before=anchor?.getBoundingClientRect().top-edge;
        const reads=fixture.reads.length;
        pane.dispatchEvent(new WheelEvent('wheel',{deltaY:direction*100}));await frame();
        if(fixture.reads.length===reads) break;
        checkOrder();
        const after=anchor?.getBoundingClientRect().top-pane.getBoundingClientRect().top;
        if(anchor && (!anchor.isConnected || Math.abs(after-before)>2))
          throw new Error('Recording viewport changed on '+direction+' page '+stage+': '+JSON.stringify({key:anchor.dataset.timelineKey,before,after,connected:anchor.isConnected}));
        steps.push({direction,stage,rows:timeline.querySelectorAll('.ev').length,drift:anchor?Math.abs(after-before):0});
      }
      const retained=order();
      const listReads=fixture.listReads;fixture.signal();await waitFor(()=>fixture.listReads>listReads);await frame();checkOrder();
      if(JSON.stringify(order())!==JSON.stringify(retained)) throw new Error('Idle recording refresh reordered resident history');
      const question=[...timeline.querySelectorAll('.ev-user_message')].at(-1);
      question?.scrollIntoView({block:'center'});await frame();
      return {sourceRows:fixture.history.length,residentRows:retained.length,expectedRows:recordingOrder.size,
        missing:fixture.history.filter(row=>row.kind==='tool_call' ? !retained.some(key=>key.endsWith(row.call.callId)) :
          ['user_message','assistant_message'].includes(row.kind) && row.messageId && !retained.some(key=>key.endsWith(row.inputId ?? row.messageId)))
          .map(row=>({kind:row.kind,tool:row.call?.tool,seq:row.seq})),
        steps,maxDrift:Math.max(0,...steps.map(step=>step.drift))};
    })()`);
    const screenshotPath = path.join(root, '.local', 'recorded-transcript-scroll.png');
    fs.mkdirSync(path.dirname(screenshotPath), {recursive:true});
    fs.writeFileSync(screenshotPath, (await win.webContents.capturePage()).toPNG());
    assert.ok(recorded.steps.length > 0 || recorded.residentRows === recorded.expectedRows,
      'The recorded transcript must exercise paging or already contain every canonical row: '+JSON.stringify(recorded));
    console.log(JSON.stringify({recorded,screenshot:screenshotPath},null,2));
  }
  console.log(JSON.stringify({observations,expanded,collapsedAgain,interjection,historicalRefresh,latest,refresh,bottomRefresh,shortAfter},null,2));
  console.log(JSON.stringify({revisedHistory},null,2));
  console.log('Dense history scroll passed: real renderer, native wheel, overlap, reversals, scrollbar continuity and live refresh.');
  if(show) { win.webContents.debugger.detach(); return; }
  win.destroy();app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
