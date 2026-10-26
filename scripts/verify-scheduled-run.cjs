// Real Chromium + production chat renderer with an isolated API fixture (#1826): a scheduled run
// says so above its message (on time and late), and as a task card while a turn runs. The origin
// line sits on the message's own right edge, smaller and quieter than the text, whole, in both themes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const output = path.join(root, 'outputs/scheduled-run');
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
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await win.webContents.executeJavaScript(`(() => {
      const ok = data => Promise.resolve({ok:true,data});
      const base = (id,title,conversationId,activeTurnId) => ({id,title,conversationId,chatIds:[conversationId],startedAt:1,updatedAt:Date.now(),endedAt:null,
        events:0,userMessages:0,toolCalls:0,lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,
        estimatedTokens:0,contextTokens:0,lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:null,activeTurnId,agents:[],origin:null});
      const idle=base('scheduled-idle','Daily issue check','fixture-idle',null), busy=base('scheduled-busy','Hourly test run','fixture-busy','turn-busy');
      const nine=new Date(); nine.setHours(9,0,0,0);
      const row=(id,sessionId,conversationId,text,mode,late)=>({id,sessionId,text,mode,dueAt:0,state:'queued',owner:null,createdAt:Date.now(),conversationId,
        model:null,reasoningEffort:null,scheduled:{scheduleId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',dueAt:nine.getTime(),late}});
      window.fixture={ inputs:[
        row('on-time',idle.id,idle.conversationId,'Check the open issues and summarise what changed since yesterday.','auto',false),
        row('late',idle.id,idle.conversationId,'Run the test suite and tell me what broke.','auto',true),
        row('waiting',busy.id,busy.conversationId,'Run the test suite and tell me what broke.','after-turn',false)
      ]};
      window.api=new Proxy({
        listSessions:()=>ok({sessions:[idle,busy],activeId:null,blocked:[],pressure:[]}), listProjects:()=>ok([]),
        getSession:id=>{const events=id===idle.id?[{kind:'user_message',seq:1,origin:1,time:nine.getTime(),source:'app',messageId:'sent-run',inputId:'sent-run',
          message:{text:'Summarise the new issues from last night.',chars:41,truncated:false},scheduled:{dueAt:nine.getTime(),late:false}}]:[];
          return ok({summary:[idle,busy].find(row=>row.id===id),total:events.length,events,nextFrom:events.length});},
        getSessionControls:id=>ok({sessionId:id,activeTurnId:id===busy.id?'turn-busy':null,canInject:true,automation:'off',objective:'',blocked:'',recovery:[],goalWait:null,plan:null}),
        listInputs:()=>ok(structuredClone(window.fixture.inputs)), listPausedHelpers:()=>ok([]), runningTools:()=>ok([]), runningProcesses:()=>ok([]),
        onBackgroundProcessesChanged:()=>()=>{}, onSessionChanged:()=>()=>{}, onTaskProgress:()=>()=>{},
        getChatModels:()=>ok({state:'ready',observedAt:Date.now(),models:[{id:'gpt-5.6-sol',label:'GPT-5.6 Sol',efforts:['high']}]})
      },{get:(target,key)=>key in target?target[key]:(()=>ok(null))});
    })()`);
    await win.webContents.executeJavaScript(code);
    const js = source => win.webContents.executeJavaScript(source);
    const wait = async (condition) => {
      for (let i = 0; i < 200; i++) { if (await js(condition)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
      throw new Error('Renderer condition timed out: ' + condition);
    };
    const frame = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))');
    await js(`chat.initChat({state:()=>null,save:async()=>{}});chat.chatVisible(true);`);
    const results = {};
    for (const theme of ['dark', 'light']) {
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; true`);
      await wait('!!document.querySelector("#sessionList [data-id=\\"scheduled-idle\\"]")');
      await js(`document.querySelector('#sessionList [data-id="scheduled-idle"]').click()`);
      await wait(`document.querySelectorAll('#inputQueue .pending-message-origin').length === 2`);
      await frame();
      const rows = await js(`[...document.querySelectorAll('#inputQueue .pending-message')].map(row => {
        const origin = row.querySelector('.pending-message-origin'), text = row.querySelector('.pending-message-text');
        const o = origin.getBoundingClientRect(), t = text.getBoundingClientRect(), so = getComputedStyle(origin), st = getComputedStyle(text);
        return { origin: origin.textContent, right: Math.round(t.right - o.right), above: o.bottom <= t.top + 1, cut: origin.scrollWidth > origin.clientWidth + 1,
          smaller: parseFloat(so.fontSize) < parseFloat(st.fontSize), quieter: so.color !== st.color,
          box: { x: Math.floor(Math.min(o.left, t.left)) - 16, y: Math.floor(o.top) - 12, width: Math.ceil(Math.max(o.right, t.right) - Math.min(o.left, t.left)) + 32, height: Math.ceil(t.bottom - o.top) + 40 } };
      })`);
      assert.equal(rows.length, 2);
      // Sent, the run keeps the same line above its message in the chat.
      const sent = await js(`(() => { const bubble = document.querySelector('.said.is-user'), origin = bubble?.querySelector('.said-origin'), text = bubble?.querySelector('.user-message-text');
        if (!origin || !text) return null;
        const o = origin.getBoundingClientRect(), t = text.getBoundingClientRect(), so = getComputedStyle(origin), st = getComputedStyle(text);
        return { origin: origin.textContent, right: Math.round(t.right - o.right), above: o.bottom <= t.top + 1, cut: origin.scrollWidth > origin.clientWidth + 1,
          smaller: parseFloat(so.fontSize) < parseFloat(st.fontSize), quieter: so.color !== st.color, sameAsQueue: so.fontSize === getComputedStyle(document.querySelector('#inputQueue .pending-message-origin')).fontSize }; })()`);
      assert.ok(sent && sent.origin === 'Scheduled' && sent.right >= 0 && sent.right <= 6 && sent.above && !sent.cut && sent.smaller && sent.quieter && sent.sameAsQueue,
        `${theme} sent message origin line: ${JSON.stringify(sent)}`);
      assert.equal(rows[0].origin, 'Scheduled');
      assert.match(rows[1].origin, /^Scheduled · late, was due \d{1,2}:00(?:\s?[AP]M)?$/);
      for (const row of rows) {
        // On the message's own edge, the margin of the bubble's rounded corner at most.
        assert.ok(row.right >= 0 && row.right <= 6 && row.above && !row.cut && row.smaller && row.quieter, `${theme} origin line: ${JSON.stringify(row)}`);
      }
      const box = { x: Math.max(0, Math.min(...rows.map(r => r.box.x))), y: Math.max(0, rows[0].box.y), width: Math.max(...rows.map(r => r.box.width)), height: rows[1].box.y + rows[1].box.height - rows[0].box.y };
      fs.writeFileSync(path.join(output, `pending-${theme}.png`), (await win.webContents.capturePage(box)).toPNG());
      // While a turn runs, the run waits as a task card with the same word.
      await js(`document.querySelector('#sessionList [data-id="scheduled-busy"]').click()`);
      await wait(`!!document.querySelector('#finishQueue [data-input-id="waiting"] .queue-label')`);
      await frame();
      const card = await js(`(() => { const label = document.querySelector('#finishQueue [data-input-id="waiting"] .queue-label'), r = document.getElementById('finishQueue').getBoundingClientRect();
        return { label: label.textContent, box: { x: Math.max(0, Math.floor(r.left) - 12), y: Math.max(0, Math.floor(r.top) - 12), width: Math.ceil(r.width) + 24, height: Math.ceil(r.height) + 24 } }; })()`);
      assert.equal(card.label, 'Scheduled · Run the test suite and tell me what broke.');
      fs.writeFileSync(path.join(output, `card-${theme}.png`), (await win.webContents.capturePage(card.box)).toPNG());
      results[theme] = { rows, card };
    }
    fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(results, null, 2));
    console.log('Passed: a scheduled run says so above its message (on time and late), on its task card and on the sent message, on the message edge, smaller and quieter, whole, in both themes.');
  } finally { win.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
