// Real Electron layout with the production renderer and CSS. No user session is loaded.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', path.join(__dirname, '../.tmp/plan-collapse/runtime'));

app.whenReady().then(async () => {
  const { build } = await import('vite');
  const bundle = await build({ configFile: false, logLevel: 'error', build: {
    write: false, minify: false,
    lib: { entry: path.join(__dirname, '../src/renderer/agent-plan.ts'), name: 'PlanProbe', formats: ['iife'] }
  } });
  const code = bundle[0].output.find(item => item.type === 'chunk').code;
  const motion = await build({ configFile: false, logLevel: 'error', build: {
    write: false, minify: false,
    lib: { entry: path.join(__dirname, '../src/renderer/composer-motion.ts'), name: 'MotionProbe', formats: ['iife'] }
  } });
  const motionCode = motion[0].output.find(item => item.type === 'chunk').code;
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style>
    <div data-panel="chat" style="height:100vh"><section class="card is-session" style="height:100%">
    <div class="subhead">Plan layout check</div><div id="chatBody" class="scroll"><div style="height:2000px">Conversation</div></div>
    <div class="composer-dock" id="composerDock"><div class="composer-dock-body"><section class="agent-plan" id="agentPlan" hidden></section><div id="queue" hidden><div class="queued-input">Queued instruction</div></div><div id="activeGoalRow" hidden>Goal</div></div></div>
    <form id="composer" class="composer"><textarea rows="1">A draft stays here</textarea></form><div id="chatFoot"></div>
    </section></div><script>
    const frames = async (count = 2) => { for(let i = 0; i < count; i++) await new Promise(requestAnimationFrame); };
    const settleDock = async () => {
      await frames();
      await Promise.all(document.getElementById('composerDock').getAnimations().map(a => a.finished.catch(() => {})));
      await frames();
    };
    </script>`));
  await win.webContents.executeJavaScript(code);
  await win.webContents.executeJavaScript(motionCode);
  await win.webContents.executeJavaScript("void MotionProbe.installComposerDockMotion(document.getElementById('composerDock'))");
  const results = [];
  for (const zoom of [1, 1.5]) {
    win.webContents.setZoomFactor(zoom);
    // Zoom is committed across the renderer boundary. Do not compare geometry
    // captured before its reflow with geometry captured after a later frame.
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    results.push(await win.webContents.executeJavaScript(`(async () => {
      const host = document.getElementById('agentPlan');
      const plan = { updatedAt: 1, plan: Array.from({length: 12}, (_, i) => ({step: 'Step ' + i, status: 'pending'})) };
      PlanProbe.renderAgentPlan(host, 'layout', plan);
      const shell = host.querySelector('details');
      const startsClosed = !shell.open; shell.open = true;
      await settleDock();
      const heading = shell.querySelector('summary');
      const body = document.getElementById('chatBody');
      const expanded = body.clientHeight;
      const openArrow = getComputedStyle(heading, '::after').transform;
      heading.click();
      await settleDock();
      const collapsed = body.clientHeight;
      const closedArrow = getComputedStyle(heading, '::after').transform;
      PlanProbe.renderAgentPlan(host, 'layout', {...plan, explanation: 'Progress update'});
      const stayedClosed = !host.querySelector('details').open;
      body.scrollTop = body.scrollHeight;
      host.querySelector('details').open = true;
      PlanProbe.renderAgentPlan(host, 'layout', {...plan, explanation: 'Another update'});
      const stayedOpen = host.querySelector('details').open;
      PlanProbe.renderAgentPlan(host, 'other-chat', plan);
      const otherChatClosed = !host.querySelector('details').open;
      await settleDock();
      const dock = document.getElementById('composerDock');
      const queue = document.getElementById('queue'), goal = document.getElementById('activeGoalRow');
      const composer = document.getElementById('composer');
      const completions = [];
      for (const siblings of [true, false]) {
        queue.hidden = goal.hidden = !siblings;
        PlanProbe.renderAgentPlan(host, 'completion-' + siblings, plan);
        await settleDock();
        const offsets = [queue, goal].map(e => e.getBoundingClientRect().top - composer.getBoundingClientRect().top);
        PlanProbe.renderAgentPlan(host, 'completion-' + siblings, {...plan, plan: plan.plan.map(step => ({...step, status:'completed'}))});
        const animation = host.querySelector('details').getAnimations()[0];
        animation.pause(); animation.currentTime = 450;
        await frames();
        const green = getComputedStyle(host.querySelector('details')).boxShadow.includes('70, 210, 150');
        let maxShift = 0, minOpacity = 1;
        for (const time of [1260, 1400, 1550, 1700, 1780, 1799]) {
          animation.currentTime = time; await frames();
          if (siblings) {
            [queue, goal].forEach((e, index) => {
              maxShift = Math.max(maxShift, Math.abs(e.getBoundingClientRect().top - composer.getBoundingClientRect().top - offsets[index]));
            });
            minOpacity = Math.min(minOpacity, Number(getComputedStyle(dock).opacity));
          }
        }
        animation.finish(); await animation.finished; await settleDock();
        const style = getComputedStyle(dock);
        completions.push({siblings, green, maxShift, minOpacity, hidden:host.hidden,
          height:dock.getBoundingClientRect().height, border:style.borderTopWidth, opacity:style.opacity,
          inlineHeight:dock.style.height, animations:dock.getAnimations().filter(a => a.playState !== 'finished').length});
      }
      // A new occupant after the zero-height completion must still animate in.
      // Record admission rather than sampling playState: hidden Windows surfaces
      // can deliver the next frame after the short animation has already finished.
      let reentered = false;
      const animate = dock.animate.bind(dock);
      dock.animate = (keyframes, options) => {
        reentered ||= keyframes.some(frame => frame.height);
        return animate(keyframes, options);
      };
      queue.hidden = false; await frames();
      await settleDock(); queue.hidden = true; await settleDock();
      dock.animate = animate;
      return { zoom: ${zoom}, expanded, collapsed, startsClosed, stayedClosed, stayedOpen, otherChatClosed, scrollTop: body.scrollTop,
        arrowVisible: openArrow !== 'none', completions, reentered,
        arrowChanges: openArrow !== closedArrow, draft: document.querySelector('textarea').value };
    })()`));
  }
  console.log(JSON.stringify(results, null, 2));
  for (const row of results) {
    assert.ok(row.collapsed > row.expanded + 80, 'Collapsing returns space to the conversation');
    assert.ok(row.stayedClosed && row.arrowVisible && row.arrowChanges);
    assert.ok(row.startsClosed && row.stayedOpen && row.otherChatClosed, 'New chats start collapsed; updates retain the chosen state');
    assert.ok(row.scrollTop > 0, 'Conversation still scrolls');
    assert.equal(row.draft, 'A draft stays here');
    assert.ok(row.reentered, 'A panel after plan completion still animates');
    for (const completion of row.completions) {
      assert.ok(completion.green && completion.hidden, 'Native green completion finishes and retires the plan');
      assert.ok(completion.maxShift < 1.5 && completion.minOpacity === 1, 'Surviving rows neither jump nor flash');
      assert.equal(completion.inlineHeight, '', 'No persisted height can strand an empty shell');
      assert.equal(completion.animations, 0);
      if (!completion.siblings) {
        assert.equal(completion.height, 0); assert.equal(completion.border, '0px'); assert.equal(completion.opacity, '0');
      }
    }
  }
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
