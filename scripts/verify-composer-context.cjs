/** Current composer markup/CSS in offscreen Chromium; no installed app interaction. */
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
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { offscreen: true } });
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const composer = html.match(/<form class="composer"[\s\S]*?<\/form>/)[0];
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style><div id="fixture" style="margin:250px 20px 0">${composer}</div>`));
  const results = await win.webContents.executeJavaScript(`(async () => {
    const fixture = document.getElementById('fixture');
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const output = [];
    document.getElementById('contextMeter').classList.add('pinned');
    for (const width of [1000, 640, 430]) for (const { images, skills } of [
      { images: false, skills: false }, { images: true, skills: false },
      { images: false, skills: true }, { images: true, skills: true }
    ]) for (const mode of ['', 'Loop + Plan']) {
      fixture.style.width = width + 'px';
      const attachments = document.getElementById('composerImages');
      attachments.hidden = !images;
      attachments.textContent = 'Example image'; attachments.style.height = '60px';
      const selectedSkills = document.getElementById('composerSelectedSkills');
      selectedSkills.hidden = !skills; selectedSkills.textContent = 'Example skill';
      const settings = document.getElementById('composerSettingsSummary');
      const modeLabel = document.getElementById('composerModeLabel');
      settings.toggleAttribute('data-mode-active', !!mode);
      modeLabel.hidden = !mode; modeLabel.textContent = mode;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const clear = document.getElementById('clearComposerMode');
      document.getElementById('composerModeControl').toggleAttribute('data-mode-active', !!mode);
      clear.hidden = !mode;
      const plus = rect('#attachmentMenu > summary'), gear = rect('#composerSettings > summary'), modeControl = rect('#composerModeControl'), clearControl = rect('#clearComposerMode'), circle = rect('#contextMeterButton'), tooltip = rect('#contextMeterInfo'), input = rect('#chatInput'), model = rect('#modelMenu > summary'), send = rect('#chatSend');
      output.push({width, images, skills, mode, plusWidth: plus.width, gearWidth: gear.width, gearHeight: gear.height, circleWidth: circle.width,
        modeControlWidth: modeControl.width, clearWidth: clearControl.width, clearRightInset: modeControl.right - clearControl.right,
        clearCenterDifference: Math.abs((clearControl.top + clearControl.bottom - gear.top - gear.bottom) / 2),
        plusGearGap: modeControl.left - plus.right, gearCircleGap: circle.left - modeControl.right,
        plusCenterDifference: Math.abs((plus.top + plus.bottom - gear.top - gear.bottom) / 2),
        circleCenterDifference: Math.abs((circle.top + circle.bottom - gear.top - gear.bottom) / 2),
        tooltipCenterDifference: Math.abs((tooltip.left + tooltip.right - circle.left - circle.right) / 2),
        tooltipInViewport: tooltip.left >= 0 && tooltip.right <= document.documentElement.clientWidth && tooltip.top >= 0 && tooltip.bottom <= document.documentElement.clientHeight,
        toolbarBelowInput: circle.top >= input.bottom, modelAligned: Math.abs((model.top + model.bottom - circle.top - circle.bottom) / 2) < 1,
        sendAligned: Math.abs((send.top + send.bottom - circle.top - circle.bottom) / 2) < 1, overflow: fixture.scrollWidth > fixture.clientWidth});
    }
    return output;
  })()`);
  for (const row of results) {
    assert.deepEqual([row.plusWidth, row.circleWidth, row.gearHeight], [36, 36, 36], JSON.stringify(row));
    if (row.mode) {
      assert.ok(row.gearWidth > 36 && row.gearWidth <= 154, JSON.stringify(row));
      assert.equal(row.clearWidth, 20, JSON.stringify(row));
      assert.equal(row.clearRightInset, 6, JSON.stringify(row));
      assert.ok(row.clearCenterDifference < 0.1, JSON.stringify(row));
      assert.ok(Math.abs(row.modeControlWidth - row.gearWidth - 26) < 0.1, JSON.stringify(row));
    }
    else assert.equal(row.gearWidth, 36, JSON.stringify(row));
    assert.equal(row.plusGearGap, 8, 'Attachment and options have one toolbar gap');
    assert.equal(row.gearCircleGap, 4, 'Gear and context form a compact pair');
    assert.ok(row.plusCenterDifference < 1, 'Attachment and gear share their vertical center');
    assert.ok(row.circleCenterDifference < 1, 'Circle and gear share their vertical center');
    assert.ok(row.tooltipCenterDifference < 1, 'Tooltip remains centered over the context circle');
    assert.equal(row.tooltipInViewport, true, 'Tooltip remains within the visible viewport');
    assert.equal(row.toolbarBelowInput, true);
    assert.equal(row.modelAligned, true);
    assert.equal(row.sendAligned, true);
    assert.equal(row.overflow, false);
  }

  const emptySession = `<div class="panel is-active" data-panel="chat" id="emptyPanel"><section class="card is-session" id="emptyFixture"><div class="subhead"></div><div class="scroll" id="chatBody"><div class="view" data-view="timeline"><p class="empty" id="timelineEmpty"><span class="welcome-mark"></span><span id="welcomeText">What would you like to build?</span></p></div></div><div class="composer-dock" id="composerDock"></div>${composer}<p id="chatFoot"></p></section></div>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style>${emptySession}`));
  const emptyResults = await win.webContents.executeJavaScript(`(async () => {
    const panel = document.getElementById('emptyPanel');
    const welcome = document.getElementById('timelineEmpty');
    const welcomeMark = welcome.querySelector('.welcome-mark');
    const welcomeText = document.getElementById('welcomeText');
    const selectedSkills = document.getElementById('composerSelectedSkills');
    const composer = document.getElementById('composer');
    const chatBody = document.getElementById('chatBody');
    const output = [];
    const skill = (name) => '<span class="composer-selected-skill"><span class="composer-selected-skill-title">' + name + '</span><button class="composer-selected-skill-remove" type="button">x</button></span>';
    for (const width of [1000, 640, 430]) {
      panel.style.width = width + 'px';
      panel.style.height = '760px';
      for (const state of ['none', 'one', 'wrapped']) {
        selectedSkills.hidden = state === 'none';
        selectedSkills.innerHTML = state === 'one'
          ? skill('grilling')
          : state === 'wrapped'
            ? Array.from({ length: 10 }, (_, index) => skill('skill-' + index + '-with-a-long-name')).join('')
            : '';
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const panelRect = panel.getBoundingClientRect();
        const bodyRect = chatBody.getBoundingClientRect();
        const welcomeRect = welcome.getBoundingClientRect();
        const markRect = welcomeMark.getBoundingClientRect();
        const textRect = welcomeText.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        output.push({ width, state,
          welcomeCenterX: (welcomeRect.left + welcomeRect.right) / 2,
          welcomeVisualCenterY: (markRect.top + textRect.bottom) / 2,
          panelTop: panelRect.top, panelHeight: panelRect.height,
          bodyContentCenterX: bodyRect.left + chatBody.clientWidth / 2,
          bodyLeft: bodyRect.left, bodyRight: bodyRect.right,
          panelLeft: panelRect.left, panelRight: panelRect.right,
          composerLeft: composerRect.left, composerRight: composerRect.right,
          composerHeight: composerRect.height });
      }
    }
    return output;
  })()`);
  for (const width of [1000, 640, 430]) {
    const rows = emptyResults.filter(row => row.width === width);
    const centers = rows.map(row => row.welcomeVisualCenterY);
    const heights = Object.fromEntries(rows.map(row => [row.state, row.composerHeight]));
    assert.ok(Math.max(...centers) - Math.min(...centers) < 1, JSON.stringify(rows));
    assert.ok(heights.one > heights.none, JSON.stringify(rows));
    assert.ok(heights.wrapped > heights.one, JSON.stringify(rows));
    for (const row of rows) {
      assert.ok(Math.abs(row.welcomeCenterX - row.bodyContentCenterX) < 1, JSON.stringify(row));
      const visualRatio = (row.welcomeVisualCenterY - row.panelTop) / row.panelHeight;
      assert.ok(visualRatio >= 0.4 && visualRatio <= 0.45, JSON.stringify(row));
      assert.equal(row.bodyLeft, row.panelLeft, JSON.stringify(row));
      assert.equal(row.bodyRight, row.panelRight, JSON.stringify(row));
      assert.ok(row.composerLeft >= row.panelLeft && row.composerRight <= row.panelRight, JSON.stringify(row));
    }
  }
  console.log('Composer geometry passed at 1000/640/430px: controls stay aligned without overflow and the empty welcome stays fixed across 0, 1 and wrapped Skill/action pill rows.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
