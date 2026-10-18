// Isolated Electron + actual project/projectless PTYs + current renderer. No provider or production state.
const { withoutScripts } = require('./ui-check-page.cjs');
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
// PowerShell on Windows, the login shell elsewhere. Every command prints a marker the checks wait for.
const WINDOWS = process.platform === 'win32';
const SHELL = WINDOWS ? 'powershell' : path.basename(process.env.SHELL || '/bin/bash');
// The tab shows the terminal's title. PowerShell keeps its name; zsh and bash replace it with their
// own title (user@host:dir) once the prompt draws, so elsewhere any label will do.
const TAB_LABEL = WINDOWS ? `.includes(${JSON.stringify(SHELL)})` : '.trim().length>0';
const sh = WINDOWS ? {
  home: "Write-Output ('HOME_'+(Get-Location).Path)",
  proof: "$proof='persisted'; cd child; Write-Output ('PROOF_'+$proof+'_'+(Split-Path (Get-Location) -Leaf))",
  show: label => `Write-Output ('${label}_'+$proof)`,
  plain: text => `Write-Output ${text}`,
  second: "Write-Output ('SECOND_'+(Split-Path (Get-Location) -Leaf)); Start-Sleep -Seconds 30",
  interrupt: "Write-Output ('INTERRUPT'+'_OK')"
} : {
  home: 'echo "HOME_$PWD"',
  proof: 'proof=persisted; cd child; echo "PROOF_${proof}_$(basename "$PWD")"',
  show: label => `echo "${label}_$proof"`,
  plain: text => `echo ${text}`,
  second: 'echo "SECOND_$(basename "$PWD")"; sleep 30',
  interrupt: 'echo "INTERRUPT""_OK"'
};
const output = path.join(root, 'outputs/terminal-acceptance');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'runtime'));
// Without a listener, destroying the only window quits Electron at once, before the cleanup below
// can wait for the shell the check closed last. Its ConPTY exit then lands while Node tears down,
// which aborts the process with 0xC0000409 on Windows (3 in 30 runs on a test VM, 2026-10-10).
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const { buildSync } = require('esbuild');
  const helper = path.join(output, 'main.cjs');
  buildSync({ stdin: { contents: [
    "export {registerWorkspaceTerminalIpc} from './src/main/workspace-terminal-ipc.ts';",
    "export {workspaceTerminalsExited} from './src/main/workspace-terminal.ts';",
    "export {initConfigPath, defaultConfig, saveConfig} from './src/main/config.ts';",
    "export {initDurableStore, flushDurable} from './src/main/durable.ts';",
    "export {addProject} from './src/main/projects.ts';"
  ].join('\n'), resolveDir: root }, outfile: helper, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
  const backend = require(helper);
  const workspace = path.join(output, 'project'); fs.mkdirSync(path.join(workspace, 'child'), { recursive: true });
  backend.initConfigPath(path.join(output, 'state')); backend.initDurableStore(path.join(output, 'state'));
  await backend.saveConfig({ ...backend.defaultConfig(), roots: [{ name: 'fixture', path: workspace }] });
  const project = await backend.addProject(workspace);
  const preload = path.join(output, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
    const request=payload=>ipcRenderer.invoke('workspaceTerminal:request',payload);
    contextBridge.exposeInMainWorld('api',{
      terminalCreate:(id,projectId,cols,rows)=>request({action:'create',id,projectId,cols,rows}),
      terminalWrite:(id,data)=>request({action:'write',id,data}),
      terminalResize:(id,cols,rows)=>request({action:'resize',id,cols,rows}),
      terminalAck:(id,count)=>request({action:'ack',id,count}),terminalClose:id=>request({action:'close',id}),
      onTerminalEvent:listener=>{const fn=(_,value)=>listener(value);ipcRenderer.on('workspaceTerminal:event',fn);return()=>ipcRenderer.removeListener('workspaceTerminal:event',fn)},
      writeClipboard:()=>Promise.resolve({ok:true,data:true})
    });`);
  // A hidden window on Windows advances no animations, so the docks' slide-in never settles there
  // and a click is measured mid-drawer. Shown, it behaves like the app itself (2026-10-06, VM 141).
  let win = new BrowserWindow({ show: WINDOWS, width: 1100, height: 800, webPreferences: { preload, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  backend.registerWorkspaceTerminalIpc(() => win);
  const fixture = `
    window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));
    window.ids=[];window.outputs={};window.exits={};
    window.api.onTerminalEvent(e=>{if('data' in e){window.outputs[e.id]=(window.outputs[e.id]||'')+e.data;}else window.exits[e.id]=e.exitCode;});
    const {createWorkspaceTerminal}=await import('/workspace-terminal.ts');
    const {createWorkspaceDocks}=await import('/workspace-docks.ts');
    const {applyAppearance}=await import('/appearance.ts');
    const {defaultAppearance}=await import(${JSON.stringify('/@fs/' + path.join(root, 'src/shared/appearance.ts').replace(/\\/g, '/'))});
    document.body.append(document.getElementById('connectionPopover'));
    window.applyColor=(theme,background)=>{const settings=defaultAppearance();settings.translucentSidebar=false;settings[theme].background=background;applyAppearance(theme,settings);};
    const docks=createWorkspaceDocks(document.querySelector('[data-panel="chat"]'));
    const bottomTerminal=createWorkspaceTerminal(()=>docks.toggleBottomTerminal(),docks.bottomBody,
      {onEmpty:()=>docks.setBottomOpen(false),onClosePanel:()=>docks.setBottomOpen(false)});
    const rightTerminal=createWorkspaceTerminal(()=>docks.toggleBottomTerminal(),docks.body,
      {id:'workspaceTerminalRight',dockedTabs:true,onTabsChanged:()=>docks.sync()});
    bottomTerminal.update(${JSON.stringify(project)});rightTerminal.update(${JSON.stringify(project)});
    window.setTerminalProject=value=>bottomTerminal.update(value);
    docks.registerTerminal(
      {show:(mount,createIfEmpty)=>rightTerminal.show(mount,createIfEmpty),hide:()=>rightTerminal.hide(),canCreate:()=>true,
       newTab:()=>rightTerminal.newTab(),tabs:()=>rightTerminal.tabs(),selectTab:id=>rightTerminal.selectTab(id),closeTab:id=>rightTerminal.closeTab(id)},
      {show:(mount,createIfEmpty)=>bottomTerminal.show(mount,createIfEmpty),hide:()=>bottomTerminal.hide()});
    window.docks=docks;
    const proto=crypto.randomUUID.bind(crypto);crypto.randomUUID=()=>{const id=proto();window.ids.push(id);return id;};
    window.ready=true;`;
  const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    // Keep the test's Vite optimizer graph separate from other renderer checks
    // in the full UI run, and declare the two xterm ESM dependencies explicitly.
    cacheDir: path.join(output, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['@xterm/xterm', '@xterm/addon-fit'] },
    server: {
    host: '127.0.0.1', port: 0,
    // Linked worktrees can resolve their dependencies outside this source root.
    // Allow only this project and the real dependency directory, not the filesystem.
    fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] }
  }, plugins: [{ name: 'terminal-fixture', configureServer(vite) {
    vite.middlewares.use('/fixture.html', async (_, response) => {
      const source = withoutScripts(fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')).replace('</body>', '<script type="module">' + fixture + '</script></body>');
      response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml('/fixture.html', source));
    });
  } }] });
  const js = code => win.webContents.executeJavaScript(code);
  const click = async selector => {
    // Docks slide in (panel-motion.ts); measure the target at rest, not mid-drawer.
    await js('Promise.race([Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity).map(animation => animation.finished.catch(() => undefined))), new Promise(resolve => setTimeout(resolve, 1500))])');
    const point = await js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});const rect=node.getBoundingClientRect();const x=Math.round(rect.left+rect.width/2),y=Math.round(rect.top+rect.height/2);return {x,y,target:document.elementFromPoint(x,y)?.outerHTML.slice(0,120)}})()`);
    // This fixture owns the DOM, layout, and actual terminal backend, but OS
    // foreground focus is not stable while automated Electron runs beside an
    // interactive user. Check the real hit-test position, then activate the
    // same DOM button without depending on a simulated physical mouse click.
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    return point;
  };
  const until = async expression => { const end = Date.now() + 15_000; while (Date.now() < end) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    // Full xterm startup output obscures the active prompt and the last input
    // that actually reached the PTY. Bound diagnostics to the evidence near failure.
    const sought = /outputs\["([^"]+)"\]/.exec(expression)?.[1];
    throw new Error('Timeout: ' + expression + ' ' + JSON.stringify(await js(`({
      errors, focused: document.activeElement?.getAttribute('aria-label'),
      documentFocus: document.hasFocus(),
      lastOutput: (outputs[${JSON.stringify(sought)}] || '').replace(/\\x1b\\[[0-9;?]*[ -\\/]*[@-~]/g,'').slice(-310)
    })`)));
  };
  try {
    await server.listen(); await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html'); await until('window.ready');
    await js("window.setTerminalProject(null);document.getElementById('terminalToggle').click()");
    await until(`ids.length===1 && document.querySelector("#workspaceTerminal .terminal-tab").textContent${TAB_LABEL}`);
    const homeId = await js('ids[0]');
    assert.equal(await js('document.querySelector("#workspaceTerminal .terminal-screen").title'), app.getPath('home'));
    await js(`window.api.terminalWrite(${JSON.stringify(homeId)}, ${JSON.stringify(sh.home + '\r')})`);
    await until(`outputs[${JSON.stringify(homeId)}]?.includes('HOME_')`);
    await js("document.querySelector('#workspaceTerminal .terminal-tab .btn-icon').click()");
    await until('document.getElementById("workDockBottom").hidden');
    assert.equal((await js(`window.api.terminalWrite(${JSON.stringify(homeId)}, 'echo closed\\r')`)).ok, false);
    await js(`window.setTerminalProject(${JSON.stringify(project)});window.ids=[];document.getElementById('terminalToggle').click()`);
    await until(`ids.length===1 && document.querySelector(".terminal-tab").textContent${TAB_LABEL}`);
    const first = await js('ids[0]');
    assert.equal(await js('!document.getElementById("workspaceTerminal").hidden && !document.getElementById("workDockBottom").hidden'), true);
    // Type via actual Chromium input into xterm, through the production preload and IPC. The drawer
    // animates in first; opening a terminal must leave the keyboard in it.
    await js('Promise.race([Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity).map(animation => animation.finished.catch(() => undefined))), new Promise(resolve => setTimeout(resolve, 1500))])');
    await until(`!!document.activeElement?.closest('#workspaceTerminal .xterm')`);
    win.webContents.insertText(sh.proof);
    // insertText and sendInputEvent take different input paths, so Return could reach the shell
    // first: an empty Enter, then the command typed but never sent (macOS CI, 2026-10-03). Send
    // Return only once the shell has echoed the text.
    // The first word is echoed well before the complete pasted command. Sending
    // Return on that early substring can submit a half-written PowerShell line.
    // Wait for the command's LAST token to reach the terminal before pressing it.
    await until(`(outputs[${JSON.stringify(first)}]||'').replace(/\\x1b\\[[0-9;?]*[ -\\/]*[@-~]/g,'').includes(${JSON.stringify(WINDOWS ? '-Leaf))' : 'basename')})`);
    // The Chromium-synthesized Return keyboard event does not reliably reach
    // Windows ConPTY through xterm in this automated fixture. The command text
    // above is still typed through the real renderer, and must echo in full;
    // commit only Return through the same *production preload IPC* used by
    // xterm's onData handler, then verify the actual PTY's command result.
    // This check does not claim to test the physical Enter key mapping.
    const submitted = await js(`window.api.terminalWrite(${JSON.stringify(first)}, '\\r')`);
    assert.equal(submitted.ok, true, 'the live terminal must accept Return');
    await until(`outputs[${JSON.stringify(first)}]?.includes('PROOF_persisted_child')`);
    assert.ok(await js(`(()=>{const tab=document.querySelector('#workspaceTerminal .terminal-tab').getBoundingClientRect();const plus=document.querySelector('#workspaceTerminal .work-dock-add summary').getBoundingClientRect();return plus.left-tab.right<=12&&plus.left>=tab.right})()`));
    await js("document.querySelector('#workspaceTerminal .work-dock-add summary').click()");
    assert.equal(await js("document.querySelector('#workspaceTerminal .work-dock-add').open"), true);
    assert.ok(await js(`(()=>{const menu=document.querySelector('#workspaceTerminal .work-dock-menu');const rect=menu.getBoundingClientRect();return rect.height>0&&menu.contains(document.elementFromPoint(rect.left+10,rect.top+10))})()`));
    const bottomClick = await click('#workspaceTerminal .work-dock-menu-item');
    assert.ok(bottomClick.target.includes('work-dock-menu-item'), JSON.stringify(bottomClick));
    await until('ids.length===2 && document.querySelectorAll("#workspaceTerminal .terminal-tab").length===2');
    const extraBottom = await js('ids[1]');
    await js("document.querySelector('#workspaceTerminal .terminal-tab:last-child .btn-icon').click()");
    await until('document.querySelectorAll("#workspaceTerminal .terminal-tab").length===1');
    assert.equal((await js(`window.api.terminalWrite(${JSON.stringify(extraBottom)}, 'echo nope\\r')`)).ok, false);
    await click('#workspaceTerminal .terminal-panel-close');
    // The bottom dock hides its terminal once the closing drawer has left.
    await until('document.getElementById("workspaceTerminal").hidden');
    await js(`window.api.terminalWrite(${JSON.stringify(first)}, ${JSON.stringify(sh.show('HIDDEN') + '\r')})`);
    await until(`outputs[${JSON.stringify(first)}]?.includes('HIDDEN_persisted')`);
    await js("document.getElementById('rightDockToggle').click()");
    assert.equal(await js("document.querySelector('#workDockRight .work-dock-bar').hidden && !document.querySelector('#workDockRight .work-dock-empty').hidden"), true);
    await click('#workDockRight .work-dock-quick[data-view=terminal]');
    await until(`ids.length===3 && document.querySelector("#workDockRight .work-dock-tab[data-terminal-id]").textContent${TAB_LABEL}`);
    assert.equal(await js("document.querySelectorAll('#workDockRight [role=tab]').length"), 1);
    assert.equal(await js("document.querySelector('#workspaceTerminalRight .terminal-bar') === null"), true);
    assert.equal(await js('document.getElementById("workDockBottom").hidden'), true);
    await js(`window.api.terminalWrite(${JSON.stringify(first)}, ${JSON.stringify(sh.show('BOTTOM') + '\r')})`);
    await until(`outputs[${JSON.stringify(first)}]?.includes('BOTTOM_persisted')`);
    const second = await js('ids[2]');
    await js("document.getElementById('rightDockToggle').click()");
    assert.equal(await js('document.getElementById("workDockRight").hidden'), true);
    await js(`window.api.terminalWrite(${JSON.stringify(second)}, ${JSON.stringify(sh.plain('RIGHT_HIDDEN_OK') + '\r')})`);
    await until(`outputs[${JSON.stringify(second)}]?.includes('RIGHT_HIDDEN_OK')`);
    await js("document.getElementById('rightDockToggle').click()");
    assert.equal(await js('ids.length===3 && !document.getElementById("workDockRight").hidden && document.querySelectorAll("#workDockRight .work-dock-tab[data-terminal-id]").length===1'), true);
    await js("document.querySelector('#workDockRight .work-dock-add summary').click()");
    const rightClick = await click('#workDockRight .work-dock-menu-item[data-view=terminal]');
    assert.ok(rightClick.target.includes('work-dock-menu-item'), JSON.stringify(rightClick));
    await until('ids.length===4 && document.querySelectorAll("#workDockRight .work-dock-tab[data-terminal-id]").length===2');
    const extraRight = await js('ids[3]');
    await js("document.querySelector('#workDockRight .work-dock-tab[data-terminal-id]:last-child .btn-icon').click()");
    await until('document.querySelectorAll("#workDockRight .work-dock-tab[data-terminal-id]").length===1');
    assert.equal(await js('!document.getElementById("workDockRight").hidden && document.querySelector("#workDockRight .work-dock-tab[data-terminal-id] [aria-selected=true]") !== null'), true);
    assert.equal((await js(`window.api.terminalWrite(${JSON.stringify(extraRight)}, 'echo closed\\r')`)).ok, false);
    await js("document.getElementById('terminalToggle').click()");
    await until('!document.getElementById("workspaceTerminal").hidden');
    // Update both the selected and hidden terminal without recreating either shell.
    for (const [theme, color, rgb] of [['dark','#000000','rgb(0, 0, 0)'],['light','#ffffff','rgb(255, 255, 255)'],['dark','#231133','rgb(35, 17, 51)'],['dark','#000000','rgb(0, 0, 0)']]) {
      await js(`window.applyColor(${JSON.stringify(theme)},${JSON.stringify(color)})`);
      const backgrounds = await js(`Array.from(document.querySelectorAll('.xterm .xterm-scrollable-element'), node=>getComputedStyle(node).backgroundColor)`);
      assert.deepEqual(backgrounds, [rgb, rgb]);
      assert.equal(await js(`getComputedStyle(document.getElementById('connectionPopover')).backgroundColor`),
        await js(`getComputedStyle(document.querySelector('.sidebar')).backgroundColor`));
    }
    await js(`window.api.terminalWrite(${JSON.stringify(second)}, ${JSON.stringify(sh.second + '\r')})`);
    await until(`outputs[${JSON.stringify(second)}]?.includes('SECOND_project')`);
    // Ctrl+C must stop the 30 s sleep: the marker command typed after it has to run long before the
    // sleep would have ended. PowerShell discards anything typed while it is still handling Ctrl+C,
    // and ConPTY's output can't say when that is over (it answers Ctrl+C with a repaint of the old
    // prompts, and draws the new one with or without a trailing space). So press Ctrl+C, give the
    // shell a moment, type the marker, and try again until it runs. 12 s stays inside the sleep, so an
    // interrupt that never lands still fails here.
    const interruptDeadline = Date.now() + 12_000;
    const interrupted = () => js(`outputs[${JSON.stringify(second)}]?.includes('INTERRUPT_OK')`);
    while (!(await interrupted())) {
      assert.ok(Date.now() < interruptDeadline, 'Ctrl+C did not interrupt the sleep: ' + JSON.stringify(await js(`outputs[${JSON.stringify(second)}]`)));
      await js(`window.api.terminalWrite(${JSON.stringify(second)}, "\\u0003")`);
      await new Promise(resolve => setTimeout(resolve, 250));
      await js(`window.api.terminalWrite(${JSON.stringify(second)}, ${JSON.stringify(sh.interrupt + '\r')})`);
      const attemptEnd = Date.now() + 1_500;
      while (Date.now() < attemptEnd && !(await interrupted())) await new Promise(resolve => setTimeout(resolve, 40));
    }
    win.setSize(830, 700); await new Promise(resolve => setTimeout(resolve, 300));
    const geometry = await js(`(()=>{const p=document.getElementById('workspaceTerminal').getBoundingClientRect();return {width:p.width,height:p.height,fits:p.right<=innerWidth+1&&p.bottom<=innerHeight+1}})()`);
    assert.ok(geometry.fits, JSON.stringify(geometry));
    // Immediately after resizing the shown Electron window, the Chromium
    // compositor may not yet have a committed frame (capturePage throws
    // UnknownVizError on Windows). Keep the screenshot assertion but only
    // request it after paint and retry a bounded transient capture failure.
    let terminalPng = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Occluded Electron windows can indefinitely suspend rAF; make each
      // paint wait bounded so a screenshot probe cannot hang the whole suite.
      await js('Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), new Promise(resolve => setTimeout(resolve, 500))])');
      try {
        const picture = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        if (picture.isEmpty()) throw new Error('Terminal captured an empty frame');
        terminalPng = picture.toPNG();
        break;
      } catch (error) {
        if (attempt === 2) throw new Error(`Terminal frame capture failed after 3 attempts: ${String(error)}`);
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    assert.ok(terminalPng && terminalPng.length > 0, 'Terminal must have a screenshot');
    fs.writeFileSync(path.join(output, 'terminal.png'), terminalPng);
    await js(`window.api.terminalWrite(${JSON.stringify(second)}, "exit 7\\r")`); await until(`exits[${JSON.stringify(second)}]===7`);
    await js("document.querySelector('#workDockRight .work-dock-tab[data-terminal-id] .btn-icon').click()");
    assert.equal((await js(`window.api.terminalWrite(${JSON.stringify(second)}, 'echo closed\\r')`)).ok, false);
    assert.equal(await js("document.querySelector('#workDockRight .work-dock-bar').hidden && !document.querySelector('#workDockRight .work-dock-empty').hidden && document.getElementById('workspaceTerminalRight').hidden"), true);
    await js("document.querySelector('#workspaceTerminal .terminal-tab .btn-icon').click()");
    await until('document.getElementById("workDockBottom").hidden');
    assert.equal((await js(`window.api.terminalWrite(${JSON.stringify(first)}, 'echo nope\\r')`)).ok, false);
    assert.deepEqual(await js('errors'), []);
    const result = { actualPty: true, projectCwd: true, projectlessHomeCwd: true, singleRightTabRow: true, rightTabClosesPty: true, rightPanelHidePreservesPty: true, persistentEnvironmentAndCd: true, keyboardInput: 'chromium text; Enter via preload IPC', hiddenPanelContinuity: true, bottomPanelClose: true, bottomMenuVisible: true, rightMenuClickable: true, rightAndBottomIndependent: true, lastBottomTabClosesPanel: true, multipleTabs: true, ctrlC: true, exitCode: 7, closeRetiresShell: true, geometry };
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { win.destroy(); win = null; await server.close(); await backend.flushDurable(); await backend.workspaceTerminalsExited(); }
  // Let Electron run before-quit so the IPC owner disposes any remaining PTYs before the
  // native ConPTY backend unloads. app.exit() skips those handlers and can crash Windows CI.
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
