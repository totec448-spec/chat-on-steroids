/** Real renderer + Chromium layout with synthetic sessions; no installed app or provider access.
 * Run: node scripts/verify-chat-opening-scroll.cjs */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const code = require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/renderer/chat.ts')],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'chat' }).outputFiles[0].text;
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '')
    .replace('</head>', `<style>${css}</style></head>`);
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await win.webContents.executeJavaScript(`(() => {
    const ok = data => Promise.resolve({ok:true, data});
    const rows = (id, count) => Array.from({length:count}, (_, i) => ({seq:i+1, time:1+i,
      source:'extension', kind:'user_message', messageId:id+'-'+i,
      message:{text:('Message '+i+' in '+id+'\\n\\n').repeat(i === 0 ? 400 : 4), truncated:false, chars:100}}));
    const history = {a:rows('a',160), b:rows('b',5)};
    const sessions = Object.keys(history).map(id => ({id, title:'Chat '+id, conversationId:id,
      chatIds:[id], startedAt:1, updatedAt:1, endedAt:null, events:history[id].length, userMessages:1,
      toolCalls:0, errors:0, estimatedTokens:0, contextTokens:0, agents:[], origin:null}));
    window.api = new Proxy({
      listSessions: () => ok({sessions, activeId:null, blocked:[], pressure:[]}),
      listProjects: () => ok([]), listInputs: () => ok([]), listPausedHelpers: () => ok([]),
      getSession: (id, options) => ok({summary:sessions.find(s=>s.id===id), total:history[id].length,
        events:history[id].filter(e=>e.seq >= (options?.from ?? 0)), nextFrom:history[id].length+1})
    }, {get:(target,key) => target[key] ?? (()=>ok(null))});
  })()`);
  await win.webContents.executeJavaScript(code);
  const results = await win.webContents.executeJavaScript(`(async () => {
    chat.initChat({state:()=>null, save:async()=>{}}); chat.chatVisible(true);
    const frame = () => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    await frame();
    const pane = document.getElementById('chatBody'), observations = [];
    const select = async id => {
      document.querySelector('#sessionList [data-id="'+id+'"]').click();
      await frame();
      observations.push({id, top:pane.scrollTop, height:pane.scrollHeight, viewport:pane.clientHeight,
        gap:pane.scrollHeight-pane.clientHeight-pane.scrollTop});
    };
    await select('a');
    for (let i=0;i<3;i++) {
      pane.scrollTop=pane.scrollHeight;
      await select('b');
      pane.scrollTop=0;
      await select('a');
    }
    pane.scrollTop=700;
    chat.chatVisible(true); await frame();
    return {observations, readerAfterRefresh:pane.scrollTop};
  })()`);
  console.log(JSON.stringify(results, null, 2));
  assert.ok(results.observations[0].height > 10000, 'Fixture must exercise a long chat');
  for (const row of results.observations) {
    assert.ok(row.viewport > 0, 'Chat must have visible geometry');
    assert.ok(row.gap <= 1, `${row.id} must open at the bottom, got gap ${row.gap}`);
  }
  assert.equal(results.readerAfterRefresh, 700, 'Live refresh preserves deliberate reading');
  console.log('Chat opening passed: initial open, three A/B/A cycles, long first message and live reader position.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
