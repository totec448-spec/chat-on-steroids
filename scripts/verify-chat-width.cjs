/** Real Electron layout regression; synthetic content, no installed app/session access. */
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
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000, webPreferences: { offscreen: true } });
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style>
    <div id="fixture"><div id="chatBody" class="scroll"><div class="view" id="timelineContent" data-view="timeline">
    <div id="timeline"><button class="timeline-window-note" hidden>Back to latest</button>
    <div class="ev"><div class="ev-body"><p class="msg" id="prose"></p></div></div>
    <details class="tool-group"><summary>Refused to run a tool</summary><div class="tool-group-body" style="height:400px">Recorded tool details</div></details>
    </div></div></div></div>`));
  const results = [];
  for (const zoom of [1, 1.17, 1.5]) {
    win.webContents.setZoomFactor(zoom);
    for (const width of [1100, 760, 500]) {
      const states = await win.webContents.executeJavaScript(`(async () => {
        const pane = document.getElementById('chatBody'), timeline = document.getElementById('timelineContent');
        const prose = document.getElementById('prose'), group = document.querySelector('details'), latest = document.querySelector('button');
        document.getElementById('fixture').style.width = '${width}px';
        prose.textContent = 'The chat text should keep the same line breaks when opening tool details or returning to the latest messages. '.repeat(4);
        group.open = false; latest.hidden = true; timeline.style.removeProperty('--timeline-scroll-reserve');
        pane.style.height = 'auto'; pane.style.height = (pane.scrollHeight + 5) + 'px';
        const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const measure = phase => {
          const range = document.createRange(); range.selectNodeContents(prose);
          return { phase, width: prose.getBoundingClientRect().width, left: prose.getBoundingClientRect().left,
            lines: [...range.getClientRects()].map(r => r.width), overflow: pane.scrollHeight > pane.clientHeight };
        };
        await frame(); const states = [measure('collapsed')];
        group.querySelector('summary').click(); await frame(); states.push(measure('expanded'));
        pane.scrollTop = 60; latest.hidden = false; await frame(); states.push(measure('history'));
        group.open = false; timeline.style.setProperty('--timeline-scroll-reserve', '500px');
        await frame(); states.push(measure('reserved-tail'));
        latest.hidden = true; timeline.style.removeProperty('--timeline-scroll-reserve'); pane.scrollTop = pane.scrollHeight;
        await frame(); states.push(measure('latest')); return states;
      })()`);
      assert.equal(states[0].overflow, false, 'Fixture starts without vertical overflow');
      assert.equal(states[1].overflow, true, 'Opening tools must introduce vertical overflow');
      assert.equal(states.at(-1).overflow, false, 'Returning to latest removes vertical overflow');
      for (const state of states.slice(1)) {
        assert.equal(state.width, states[0].width, `Text width changed at zoom ${zoom}, container ${width}: ${JSON.stringify(states)}`);
        assert.equal(state.left, states[0].left, 'Text position must remain stable');
        assert.deepEqual(state.lines, states[0].lines, 'Authored line wrapping must remain identical');
      }
      results.push({ zoom, container: width, textWidth: states[0].width, phases: states.length });
    }
  }
  console.log(JSON.stringify(results));
  console.log('Chat width passed: disclosure, history, tail reserve and latest at three widths and zoom levels.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
