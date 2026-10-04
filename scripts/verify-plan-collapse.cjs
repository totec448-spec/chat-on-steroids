// Real Electron layout with the production renderer and CSS. No user session is loaded.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', path.join(__dirname, '../.tmp/plan-collapse/runtime'));
// This verifier deliberately destroys the first mode's only window before creating the second.
// Own window lifecycle until the serialized matrix finishes, then quit explicitly below.
app.on('window-all-closed', () => {});

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
  const html = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style>
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
    </script>`);

  const runMode = async preference => {
    const win = new BrowserWindow({ show: false, width: 1000, height: 760,
      webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
    try {
      // Establish a document before sending CDP commands; Electron may defer debugger commands
      // issued before the target's first navigation.
      await win.loadURL('about:blank');
      win.webContents.debugger.attach('1.3');
      // Do not inherit the host OS preference. Each mode gets a fresh renderer whose production
      // matchMedia calls see one explicit CDP preference from first load through teardown.
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: preference }]
      });
      await win.loadURL(html);
      const mediaReduced = await win.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches");
      assert.equal(mediaReduced, preference === 'reduce', `CDP must select ${preference} before renderer motion is installed`);
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
          const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
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
            const completedShell = host.querySelector('details');
            const animation = completedShell?.getAnimations()[0];
            if (!animation?.effect) throw new Error('Plan completion must create its production animation');
            const keyframes = animation.effect.getKeyframes();
            const duration = Number(animation.effect.getTiming().duration);
            const metadata = new Set(['offset', 'computedOffset', 'easing', 'composite']);
            const animatedProperties = [...new Set(keyframes.flatMap(frame => Object.keys(frame)
              .filter(property => !metadata.has(property))))].sort();
            const startPlanHeight = completedShell.getBoundingClientRect().height;
            let green = false, midOpacity = 1, minPlanHeight = startPlanHeight, maxPlanHeightShift = 0;
            let maxShift = 0, minOpacity = 1;
            animation.pause();
            const sample = async time => {
              animation.currentTime = time; await frames();
              const style = getComputedStyle(completedShell);
              const height = completedShell.getBoundingClientRect().height;
              green ||= style.boxShadow.includes('70, 210, 150');
              minPlanHeight = Math.min(minPlanHeight, height);
              maxPlanHeightShift = Math.max(maxPlanHeightShift, Math.abs(height - startPlanHeight));
              if (siblings) {
                [queue, goal].forEach((e, index) => {
                  maxShift = Math.max(maxShift, Math.abs(e.getBoundingClientRect().top - composer.getBoundingClientRect().top - offsets[index]));
                });
                minOpacity = Math.min(minOpacity, Number(getComputedStyle(dock).opacity));
              }
              return style;
            };
            if (reduced) {
              midOpacity = Number((await sample(75)).opacity);
              await sample(149);
            } else {
              await sample(450);
              for (const time of [1260, 1400, 1550, 1700, 1780, 1799]) await sample(time);
            }
            animation.finish(); await animation.finished; await settleDock();
            const style = getComputedStyle(dock);
            completions.push({siblings, reduced, duration, animatedProperties, green, midOpacity,
              startPlanHeight, minPlanHeight, maxPlanHeightShift, maxShift, minOpacity, hidden:host.hidden,
              height:dock.getBoundingClientRect().height, border:style.borderTopWidth, opacity:style.opacity,
              inlineHeight:dock.style.height, animations:dock.getAnimations().filter(a => a.playState !== 'finished').length});
          }
          // A new occupant after the zero-height completion must still animate in normally.
          // Under reduced motion the dock intentionally admits the layout change with no height animation.
          // Record admission rather than sampling playState: hidden Windows surfaces can deliver the
          // next frame after the short normal-mode animation has already finished.
          let reentered = false;
          const animate = dock.animate.bind(dock);
          dock.animate = (keyframes, options) => {
            reentered ||= keyframes.some(frame => frame.height);
            return animate(keyframes, options);
          };
          queue.hidden = false; await frames();
          await settleDock(); queue.hidden = true; await settleDock();
          dock.animate = animate;
          return { preference: ${JSON.stringify(preference)}, reduced, zoom: ${zoom}, expanded, collapsed,
            startsClosed, stayedClosed, stayedOpen, otherChatClosed, scrollTop: body.scrollTop,
            arrowVisible: openArrow !== 'none', completions, reentered,
            arrowChanges: openArrow !== closedArrow, draft: document.querySelector('textarea').value };
        })()`));
      }
      return results;
    } finally {
      if (!win.isDestroyed() && !win.webContents.isDestroyed() && win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
      if (!win.isDestroyed()) win.destroy();
    }
  };

  const results = [];
  // Keep this serialized: each preference owns a fresh renderer and debugger session.
  for (const preference of ['no-preference', 'reduce']) results.push(...await runMode(preference));
  assert.equal(results.length, 4, 'Both motion preferences must run at both zoom levels');
  assert.deepEqual(results.map(row => `${row.preference}@${row.zoom}`),
    ['no-preference@1', 'no-preference@1.5', 'reduce@1', 'reduce@1.5'],
    'The serialized motion matrix must complete before the verifier can pass');
  console.log(JSON.stringify(results, null, 2));
  for (const row of results) {
    assert.equal(row.reduced, row.preference === 'reduce', 'Each result must come from its explicit CDP motion preference');
    assert.ok(row.collapsed > row.expanded + 80, 'Collapsing returns space to the conversation');
    assert.ok(row.stayedClosed && row.arrowVisible && row.arrowChanges);
    assert.ok(row.startsClosed && row.stayedOpen && row.otherChatClosed, 'New chats start collapsed; updates retain the chosen state');
    assert.ok(row.scrollTop > 0, 'Conversation still scrolls');
    assert.equal(row.draft, 'A draft stays here');
    if (row.reduced) assert.equal(row.reentered, false, 'Reduced motion admits a new dock occupant without height animation');
    else assert.ok(row.reentered, 'Normal motion animates a new panel after plan completion');
    for (const completion of row.completions) {
      assert.equal(completion.hidden, true, 'Completed plans retire in both motion modes');
      assert.ok(completion.maxShift < 1.5 && completion.minOpacity === 1, 'Surviving rows neither jump nor flash');
      assert.equal(completion.inlineHeight, '', 'No persisted height can strand an empty shell');
      assert.equal(completion.animations, 0);
      if (row.reduced) {
        assert.equal(completion.duration, 150, 'Reduced plan completion uses the production 150 ms fade');
        assert.deepEqual(completion.animatedProperties, ['opacity'], 'Reduced completion animates opacity only');
        assert.ok(completion.midOpacity > 0 && completion.midOpacity < 1, 'Reduced completion actually fades instead of skipping animation');
        assert.ok(completion.maxPlanHeightShift < 1.5, 'Reduced completion does not animate plan height or scale');
        assert.equal(completion.green, false, 'Reduced completion does not run the green spatial celebration');
      } else {
        assert.equal(completion.duration, 1800, 'Normal plan completion keeps the production celebration duration');
        assert.ok(completion.animatedProperties.includes('height') && completion.animatedProperties.includes('transform')
          && completion.animatedProperties.includes('boxShadow'), 'Normal completion owns height, scale and green celebration motion');
        assert.ok(completion.green, 'Normal completion reaches the green celebration frame');
        assert.ok(completion.minPlanHeight < completion.startPlanHeight - 4, 'Normal completion visibly collapses plan height');
      }
      if (!completion.siblings) {
        assert.equal(completion.height, 0); assert.equal(completion.border, '0px'); assert.equal(completion.opacity, '0');
      }
    }
  }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
