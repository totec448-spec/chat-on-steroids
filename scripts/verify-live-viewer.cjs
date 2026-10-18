/** Isolated real-Electron right-dock check: fake session records, no app profile, network or credentials. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env, encoding: 'utf8', windowsHide: true, timeout: 90_000
  });
  process.stdout.write(child.stdout ?? '');
  process.stderr.write(child.stderr ?? '');
  process.exit(child.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
const js = require('esbuild').buildSync({
  stdin: {
    contents: `
      import { createWorkspaceDocks } from './src/renderer/workspace-docks.ts';
      import { createLiveViewerPanel } from './src/renderer/live-viewer-panel.ts';
      const host = document.querySelector('[data-panel="chat"]');
      const docks = createWorkspaceDocks(host);
      const selection = { id: 'synthetic-session', generation: 1 };
      const call = (seq) => ({
        kind: 'tool_call', seq, time: 1780000000000 + seq, source: 'mcp',
        call: {
          callId: 'example-' + seq, tool: 'exec_command', attribution: 'inferred',
          requestId: null, conversationId: null, attributionMethod: 'unattributed',
          args: { text: '{"cmd":"npm test"}', chars: 18, truncated: false },
          result: { text: '4 tests passed', chars: 14, truncated: false },
          outcome: 'ok', durationMs: 14,
          summary: { title: 'Ran npm test', kind: 'run', tone: 'good' },
          changes: [{ path: 'src/example.ts', added: 3, removed: 1, approximate: false }]
        }
      });
      const panel = createLiveViewerPanel({
        selection: () => selection,
        read: async () => [call(1), { kind: 'turn_end', seq: 2,
          time: 1780000000002, source: 'extension', outcome: 'completed' }]
      });
      docks.register('live', 'Live Viewer', 'i-steps', mount => panel.show(mount),
        () => panel.hide(), () => !!selection.id);
      window.__viewerFixture = { docks, panel, selection };
    `,
    resolveDir: root, sourcefile: 'live-viewer-fixture.ts', loader: 'ts'
  },
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', write: false,
  logLevel: 'silent'
}).outputFiles[0].text;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1320, height: 780,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
  const fixtureHtml = `<!doctype html><html lang="en"><meta charset="utf-8">
    <style>${css}</style>
    <style>
      html,body { width:100%;height:100%;margin:0;overflow:hidden; }
      .app { display:flex;flex-direction:column;height:100vh;min-height:0; }
      .app-topbar { flex:none; height:52px;display:flex;align-items:center;padding:0 20px; }
      [data-panel="chat"] { display:grid;grid-template-columns:minmax(0,1fr);
        flex:1 1 auto;min-height:0; width:100%; }
      [data-panel="chat"].has-work-dock { grid-template-columns:minmax(0,1fr) 440px; }
      [data-panel="chat"] > .is-session { min-width:0;overflow:hidden;padding:28px; }
      .work-dock-right { grid-column:2; }
      .work-dock-body { min-height:0;flex:1;display:flex;flex-direction:column; }
    </style>
    <div class="app" data-screen="chat">
      <header class="app-topbar">Chat On Steroids · Synthetic fixture</header>
      <main data-panel="chat">
        <article class="is-session"><h2>Example coding conversation</h2>
          <p>This fixture uses no real user chat or local files.</p></article>
      </main>
    </div></html>`;
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixtureHtml));
    await win.webContents.executeJavaScript(js);
    const capture = async (name) => {
      if (!process.env.COS_VIEWER_PROOF_DIR) return;
      // Hidden Electron windows need an actual compositor frame before capturePage.
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      fs.mkdirSync(process.env.COS_VIEWER_PROOF_DIR, { recursive: true });
      const file = path.join(process.env.COS_VIEWER_PROOF_DIR, name);
      fs.writeFileSync(file, image.toPNG());
      console.log('Saved synthetic screenshot:', file, fs.statSync(file).size);
    };
    const proofDir = process.env.COS_VIEWER_PROOF_DIR;
    if (proofDir) console.log('Writing synthetic screenshots to', proofDir);
    if (proofDir) await capture('right-dock-before.png');
    const facts = await win.webContents.executeJavaScript(`(async () => {
      window.__viewerFixture.docks.activate('live');
      await new Promise(resolve => setTimeout(resolve, 200));
      const pane = document.querySelector('.live-viewer-panel');
      const dock = document.querySelector('#workDockRight');
      const card = document.querySelector('.live-viewer-row');
      return {
        dockOpen: !dock.hidden, paneOpen: !pane.hidden,
        tab: dock.querySelector('[role=tab][aria-selected=true]')?.textContent,
        command: card?.textContent, width: pane.getBoundingClientRect().width,
        screenOverflow: document.documentElement.scrollWidth > innerWidth
      };
    })()`);
    assert.ok(facts.dockOpen && facts.paneOpen, 'Live Viewer opens as a dock tab');
    assert.match(facts.tab, /Live Viewer/);
    assert.match(facts.command, /Ran npm test/);
    assert.match(facts.command, /src\/example.ts/);
    assert.ok(facts.width >= 280, `Expected a readable dock, got width ${facts.width}`);
    assert.equal(facts.screenOverflow, false, 'Viewer does not horizontally overflow the window');
    if (proofDir) await capture('right-dock-after.png');
    console.log('Live Viewer native Electron fixture passed:', JSON.stringify(facts));
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error);
    win.destroy(); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
