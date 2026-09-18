/** Native activity-fold layout in offscreen Chromium, using the shipped DOM adapter/CSS.
 * Synthetic content only. Does not connect to the installed app or a signed-in browser. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2)],
    { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'cos-overwrite-layout' } });
  const css = fs.readFileSync(path.join(__dirname, '../extension/overlay.css'), 'utf8');
  const adapter = fs.readFileSync(path.join(__dirname, '../extension/chatgpt-dom.js'), 'utf8');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html data-clf-theme="dark"><style>
    body { background:#121212; color:#eee; font:16px/1.5 system-ui,sans-serif; margin:48px; }
    #thread { max-width:800px; } .markdown { margin:0; } .native-steps { display:flex; flex-direction:column; gap:32px; }
    .native-step { margin-bottom:24px; padding-bottom:8px; } .native-call { padding:16px 0; }
    .native-notification { padding:16px 0; min-height:48px; }
    .native-final { margin-top:24px; } button { color:inherit; background:transparent; border:0; font:inherit; }
    pre { border:1px solid #555; padding:12px; } ${css}
    </style><main id="thread"></main></html>`));
  await win.webContents.executeJavaScript(adapter);
  const measurements = [];
  for (const zoom of [1, 1.25]) {
    win.webContents.setZoomFactor(zoom);
    for (const width of [800, 480, 320]) for (const mode of ['open', 'clipped', 'unmounted']) {
      const result = await win.webContents.executeJavaScript(`(() => {
        const thread = document.getElementById('thread'); thread.replaceChildren(); thread.style.width = ${width} + 'px';
        const section = document.createElement('section');
        section.dataset.testid = 'conversation-turn-2'; section.dataset.turn = 'assistant'; section.dataset.turnId = 'layout-fixture';
        section.innerHTML = '<div class="native-fold"><button aria-expanded="${mode === 'open'}">Stopped thinking</button>' +
          '<div data-item-anchor="start" data-clip="true" data-dimension="height" style="height:${mode === 'open' ? 400 : 0}px;overflow:hidden"></div></div>' +
          '<div class="native-call"><div><div class="pointer-events-none contents"><button>Called tool</button></div></div>' +
          '<div><div class="pointer-events-none contents"><button>Called tool</button></div></div></div>' +
          '<div class="native-notification"><div class="pointer-events-none contents" data-clf-fiber-thought="fixture:0:thought-layout-notification">' +
          '<button>Inspected the implementation and verified the changes</button></div></div>' +
          '<div class="native-final"><div class="markdown" data-clf-fiber-message="fixture:0:final">Final answer stays in ChatGPT.</div>' +
          '<pre><code>Native code remains usable.</code></pre><button aria-label="Copy response">Copy response</button></div>';
        thread.append(section);
        const fold = CLF_DOM.activityFold({ node: section });
        const tool = document.createElement('details'); tool.className = 'clf-stream-tool-disclosure';
        tool.innerHTML = '<summary class="clf-stream-row clf-stream-tool_call"><span class="clf-stream-icon">›</span>' +
          '<span class="clf-stream-text">Read implementation.ts</span></summary><div class="clf-stream-tool-panel">Recorded details</div>';
        const root = document.createElement('div'); root.className = 'clf-stream';
        let first, next, placement;
        if ('${mode}' === 'unmounted') {
          first = document.createElement('div'); first.className = 'clf-stream-row clf-stream-assistant_message';
          first.textContent = 'First interim: checking the implementation and its callers.';
          next = first.cloneNode(); next.textContent = 'Second interim: the tool completed and the next update follows directly.';
          root.append(first, tool, next);
          placement = { chunks: [{ anchor: fold.clip, before: false }], anchors: [fold.clip], fold };
          CLF_DOM.replaceActivity({ node: section }, root, true, { anchor: fold.clip, before: false });
        } else {
          fold.clip.innerHTML = '<div class="native-steps"><div class="native-step"><div class="message"><div class="markdown" data-clf-fiber-message="fixture:0:A">' +
            'First interim: checking the implementation and its callers.</div></div></div>' +
            '<div class="native-step"><div class="markdown" data-clf-fiber-message="fixture:0:B">Second interim: the tool completed and the next update follows directly.</div></div></div>';
          first = fold.clip.querySelector('[data-clf-fiber-message="fixture:0:A"]');
          next = fold.clip.querySelector('[data-clf-fiber-message="fixture:0:B"]');
          root.append(tool);
          const chunk = { anchor: first, before: false, interim: true };
          placement = { chunks: [chunk], anchors: [first, next] };
          CLF_DOM.replaceActivity({ node: section }, root, true, chunk);
        }
        const turn = { node: section };
        const final = section.querySelector('.native-final');
        const copy = final.querySelector('button'); let copied = 0; copy.onclick = () => copied++;
        const thoughts = CLF_DOM.thoughtActivityRows(turn, 'fixture', 0, ['thought-layout-notification']);
        const nativeTools = CLF_DOM.toolBlocks(turn).filter(block => block.closest('.native-call'));
        CLF_DOM.hideActivity(turn, nativeTools, thoughts, [], placement);
        const shown = node => getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0;
        const geometry = () => ({ gap: next.getBoundingClientRect().top - tool.getBoundingClientRect().bottom,
          headerHidden: !shown(fold.button), toolHidden: !shown(section.querySelector('.native-call')),
          notificationHeight: section.querySelector('.native-notification').getBoundingClientRect().height,
          clipped: fold.clip.scrollHeight > fold.clip.clientHeight && getComputedStyle(fold.clip).overflow === 'hidden',
          firstHeight: first.getBoundingClientRect().height, nextHeight: next.getBoundingClientRect().height,
          width: root.getBoundingClientRect().width, nativeFinal: final === section.querySelector('.native-final') });
        const closed = geometry(); tool.open = true; const expanded = geometry();
        copy.click(); tool.open = false;
        const retainedState = fold.button.getAttribute('aria-expanded');
        CLF_DOM.hideActivity(turn, []);
        const restored = shown(fold.button) && shown(section.querySelector('.native-notification')) &&
          section.querySelectorAll('[data-clf-activity-part], [data-clf-native-hidden]').length === 0 &&
          fold.button.getAttribute('aria-expanded') === retainedState && fold.clip.style.height === '${mode === 'open' ? 400 : 0}px';
        CLF_DOM.hideActivity(turn, nativeTools, thoughts, [], placement);
        return { width:${width}, mode:'${mode}', closed, expanded, copied, restored };
      })()`);
      for (const state of [result.closed, result.expanded]) {
        assert.ok(state.gap >= 0 && state.gap <= 12, 'Tool-to-interim spacing: ' + JSON.stringify(result));
        assert.equal(state.headerHidden, true); assert.equal(state.toolHidden, true); assert.equal(state.clipped, false);
        assert.equal(state.notificationHeight, 0, 'Thinking notification leaves no empty layout slot');
        assert.ok(state.firstHeight > 0 && state.nextHeight > 0); assert.equal(state.nativeFinal, true);
        assert.ok(state.width <= width + 1, 'No horizontal overflow');
      }
      assert.equal(result.copied, 1, 'Native final action still works'); assert.equal(result.restored, true, 'Off restores native layout/state');
      measurements.push({ zoom, width, mode, gap: result.closed.gap, expandedGap: result.expanded.gap });
      if (process.argv[2] && zoom === 1 && width === 800 && mode === 'open') {
        const destination = path.resolve(process.argv[2]); fs.mkdirSync(path.dirname(destination), { recursive: true });
        await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        fs.writeFileSync(destination, (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  console.log(JSON.stringify(measurements));
  console.log('Overwrite layout passed: 18 native/projected states, hidden thinking notifications without empty slots, compact tool-to-interim gaps, details, native final and Off restoration.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
