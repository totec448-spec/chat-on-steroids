// Real Electron layout with the production renderer and CSS. No user session is loaded.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const { build } = await import('vite');
  const bundle = await build({ configFile: false, logLevel: 'error', build: {
    write: false, minify: false,
    lib: { entry: path.join(__dirname, '../src/renderer/agent-plan.ts'), name: 'PlanProbe', formats: ['iife'] }
  } });
  const code = bundle[0].output.find(item => item.type === 'chunk').code;
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style>
    <div data-panel="chat" style="height:100vh"><section class="card is-session" style="height:100%">
    <div class="subhead">Plan layout check</div><div id="chatBody" class="scroll"><div style="height:2000px">Conversation</div></div>
    <div class="composer-dock"><section class="agent-plan" id="agentPlan"></section></div>
    <form id="composer" class="composer"><textarea rows="1">A draft stays here</textarea></form><div id="chatFoot"></div>
    </section></div><script>${code}</script>`));
  const results = [];
  for (const zoom of [1, 1.5]) {
    win.webContents.setZoomFactor(zoom);
    results.push(await win.webContents.executeJavaScript(`(async () => {
      const host = document.getElementById('agentPlan');
      const plan = { updatedAt: 1, plan: Array.from({length: 12}, (_, i) => ({step: 'Step ' + i, status: 'pending'})) };
      PlanProbe.renderAgentPlan(host, 'layout', plan);
      const shell = host.querySelector('details'); shell.open = true;
      const heading = shell.querySelector('summary');
      const body = document.getElementById('chatBody');
      const expanded = body.clientHeight;
      const openArrow = getComputedStyle(heading, '::after').transform;
      heading.click();
      await new Promise(requestAnimationFrame);
      const collapsed = body.clientHeight;
      const closedArrow = getComputedStyle(heading, '::after').transform;
      PlanProbe.renderAgentPlan(host, 'layout', {...plan, explanation: 'Progress update'});
      const stayedClosed = !host.querySelector('details').open;
      body.scrollTop = body.scrollHeight;
      return { zoom: ${zoom}, expanded, collapsed, stayedClosed, scrollTop: body.scrollTop,
        arrowVisible: getComputedStyle(host.querySelector('summary'), '::after').content !== 'none',
        arrowChanges: openArrow !== closedArrow, draft: document.querySelector('textarea').value };
    })()`));
  }
  console.log(JSON.stringify(results, null, 2));
  for (const row of results) {
    assert.ok(row.collapsed > row.expanded + 80, 'Collapsing returns space to the conversation');
    assert.ok(row.stayedClosed && row.arrowVisible && row.arrowChanges);
    assert.ok(row.scrollTop > 0, 'Conversation still scrolls');
    assert.equal(row.draft, 'A draft stays here');
  }
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
