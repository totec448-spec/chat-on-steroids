// Run: node scripts/verify-pet-performance.cjs <label> [--full-host] [--check]
// Builds the production overlay renderer in an isolated Electron fixture. The
// full-host mode also measures its desktop-sized transparent host, owner window
// and platform pointer transport without production userData or a provider.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const label = process.argv[2] || 'current';
assert.match(label, /^[a-z0-9-]+$/i);
const output = path.join(root, 'outputs/pet-performance', label);
const check = process.argv.includes('--check');
const fullHost = process.argv.includes('--full-host');
const forwardsIgnoredMouseMoves = process.platform === 'darwin';

async function buildAndRun() {
  const { build } = await import('vite');
  const fixture = path.join(output, 'fixture');
  fs.mkdirSync(fixture, { recursive: true });
  const renderer = path.join(root, 'src/renderer').replaceAll('\\', '/');
  fs.writeFileSync(path.join(fixture, 'entry.ts'), `
    import '${renderer}/icons.css';
    import '${renderer}/pet-overlay.css';
    const nativeRaf = window.requestAnimationFrame.bind(window);
    (window as any).petRafs = 0;
    window.requestAnimationFrame = callback => nativeRaf(now => {
      (window as any).petRafs++;
      callback(now);
    });
    const appearance = {
      light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
      dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
      font: 'system', fontSize: 14, translucentSidebar: true
    };
    let snapshot = { visible: true, dismissedPetIds: [], level: 'idle', activities: [], theme: 'dark', appearance };
    let publishSnapshot = (_value: typeof snapshot) => {};
    const hostPointer = (window as any).petHostPointer as undefined | { onPointer(listener: (value: {x:number;y:number}) => void): () => void };
    (window as any).setPetVisible = (visible: boolean) => {
      snapshot = { ...snapshot, visible };
      publishSnapshot(snapshot);
    };
    (window as any).petApi = {
      listPets: async () => ({ ok: true, data: { pets: [{
        id: 'tur-tur-sahur', displayName: 'Tur Tur Sahur', description: '',
        kind: 'builtin', builtin: true, enabled: true, favorite: true
      }] } }),
      petAsset: async () => ({ ok: false, error: 'No imported pet in this fixture.' }),
      setInteractive() {}, focusOwner() {}, openLibrary() {}, openActivity() {},
      onSnapshot(listener: typeof publishSnapshot) { publishSnapshot = listener; listener(snapshot); return () => {}; },
      onLibraryChanged() { return () => {}; },
      onPointer(listener: (value: {x:number;y:number}) => void) { return hostPointer?.onPointer(listener) ?? (() => {}); },
      onBounds() { return () => {}; }
    };
    await import('${renderer}/pet-overlay.ts');
  `);
  fs.writeFileSync(path.join(fixture, 'host-preload.cjs'), `
    const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('petHostPointer', {
      onPointer(listener) {
        const wrapped = (_event, value) => listener(value);
        ipcRenderer.on('fixture:pointer', wrapped);
        return () => ipcRenderer.removeListener('fixture:pointer', wrapped);
      }
    });
  `);
  fs.writeFileSync(path.join(fixture, 'index.html'), `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><title>CoS Pet Performance</title></head><body>
    <div id="petStage"></div><section class="pet-tray" id="petTray" hidden>
      <div class="pet-tray-head"><strong>Tasks</strong><span id="petTrayCount"></span><button id="petTrayClose">×</button></div>
      <div id="petCards"></div></section><script type="module" src="./entry.ts"></script></body></html>`);
  await build({ configFile: false, root: fixture, base: './', logLevel: 'warn',
    build: { outDir: path.join(output, 'site'), emptyOutDir: true },
    esbuild: { supported: { 'top-level-await': true } } });
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, label, ...(check ? ['--check'] : []), ...(fullHost ? ['--full-host'] : [])],
    { cwd: root, env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

async function measure() {
  const { app, BrowserWindow, screen } = require('electron');
  app.setPath('userData', path.join(output, 'runtime'));
  await app.whenReady();
  const area = fullHost ? screen.getPrimaryDisplay().workArea : { x: 0, y: 0, width: 1100, height: 850 };
  const owner = fullHost ? new BrowserWindow({ show: false, width: Math.min(1400, area.width - 120), height: Math.min(900, area.height - 120),
    backgroundColor: '#181818', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } }) : null;
  if (owner) {
    await owner.loadURL('data:text/html,<style>html{background:%23181818;color:%23eee;font:14px system-ui}body{margin:0;padding:32px}.surface{height:72vh;border:1px solid %23333;border-radius:20px;background:%231b1b1b}</style><h1>CoS owner fixture</h1><div class="surface"></div>');
    owner.show();
  }
  const win = new BrowserWindow({ show: false, transparent: true,
    x: area.x, y: area.y, width: area.width, height: area.height,
    focusable: false, frame: !fullHost, fullscreenable: false, hasShadow: !fullHost,
    resizable: !fullHost, skipTaskbar: fullHost,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false,
      preload: path.join(output, 'fixture/host-preload.cjs') } });
  if (fullHost) {
    win.setAlwaysOnTop(true, 'floating');
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
    if (forwardsIgnoredMouseMoves) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(true);
  }
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code);
  const wait = async (condition, timeout = 12000) => {
    const end = Date.now() + timeout;
    while (!await js(condition)) { assert.ok(Date.now() < end, condition); await delay(40); }
  };
  const startAction = async index => {
    await js(`document.querySelector('.pet-shell').dispatchEvent(new MouseEvent('contextmenu', {clientX:500,clientY:400,bubbles:true}))`);
    await js(`document.querySelector('.pet-menu button:nth-child(${index})').click()`);
  };
  let pointerTimer = null;
  let pointerSamples = 0;
  let pointerMessages = 0;
  const stopPointer = () => {
    if (pointerTimer) clearInterval(pointerTimer);
    pointerTimer = null;
  };
  const startPointer = () => {
    stopPointer();
    let previous = null;
    const poll = () => {
      if (win.isDestroyed() || !win.isVisible()) return;
      pointerSamples++;
      const cursor = screen.getCursorScreenPoint();
      const content = win.getContentBounds();
      const zoom = win.webContents.getZoomFactor();
      const point = { x: (cursor.x - content.x) / zoom, y: (cursor.y - content.y) / zoom };
      const now = Date.now();
      if (previous && previous.x === point.x && previous.y === point.y && now - previous.at < 250) return;
      previous = { ...point, at: now };
      pointerMessages++;
      win.webContents.send('fixture:pointer', point);
    };
    poll();
    if (forwardsIgnoredMouseMoves) return;
    pointerTimer = setInterval(poll, 50);
    pointerTimer.unref?.();
  };
  try {
    await win.loadFile(path.join(output, 'site/index.html'));
    win.showInactive();
    if (fullHost) startPointer();
    await wait('!!document.querySelector(".pet-shell")');
    await wait('document.querySelector(".pet-shell").dataset.state === "idle"');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Performance.enable');
    const perf = async () => Object.fromEntries((await win.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const records = [];
    const sample = async (name, milliseconds) => {
      const before = await perf(), rafBefore = await js('window.petRafs');
      const pointerSamplesBefore = pointerSamples, pointerMessagesBefore = pointerMessages;
      const processes = new Map(app.getAppMetrics().map(m => [m.pid, m.cpu.cumulativeCPUUsage]));
      const started = performance.now(); await delay(milliseconds);
      const seconds = (performance.now() - started) / 1000;
      const cpu = app.getAppMetrics().filter(m => processes.has(m.pid)).map(m => ({
        type: m.type, role: m.pid === win.webContents.getOSProcessId() ? 'pet' : owner && m.pid === owner.webContents.getOSProcessId() ? 'owner' : undefined,
        pid: m.pid, seconds: m.cpu.cumulativeCPUUsage - processes.get(m.pid)
      }));
      const cpuSampleValid = cpu.length === processes.size && cpu.every(m => Number.isFinite(m.seconds) && m.seconds >= 0);
      const after = await perf();
      const result = { name, seconds, cpuSampleValid,
        cpuPercent: cpuSampleValid ? cpu.reduce((sum, m) => sum + m.seconds, 0) / seconds / os.cpus().length * 100 : null,
        rafPerSecond: (await js('window.petRafs') - rafBefore) / seconds,
        taskMsPerSecond: (after.TaskDuration - before.TaskDuration) * 1000 / seconds,
        styleRecalculationsPerSecond: (after.RecalcStyleCount - before.RecalcStyleCount) / seconds,
        layoutsPerSecond: (after.LayoutCount - before.LayoutCount) / seconds, cpu };
      result.pointerSamplesPerSecond = (pointerSamples - pointerSamplesBefore) / seconds;
      result.pointerMessagesPerSecond = (pointerMessages - pointerMessagesBefore) / seconds;
      records.push(result); console.log(JSON.stringify(result)); return result;
    };
    if (fullHost) {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await delay(150); await sample('host-static', 4000);
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await delay(150);
    }
    await sample('idle', 2200);
    await sample('autonomous', 9000);
    await startAction(1);
    await sample('openai', 8500);
    await wait('!document.querySelector(".pet-shell").dataset.action');
    await startAction(2);
    await sample('anthropic', 8500);
    await wait('!document.querySelector(".pet-shell").dataset.action');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await delay(150); await sample('reduced-motion', 2000);
    await js('window.setPetVisible(false)');
    if (fullHost) { stopPointer(); win.hide(); }
    await sample('hidden', 2000);
    if (fullHost) win.showInactive();
    await js('window.setPetVisible(true)');
    if (fullHost) startPointer();
    await delay(650);
    fs.writeFileSync(path.join(output, 'pet.png'), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ label, electron: process.versions.electron,
      chrome: process.versions.chrome, processors: os.cpus().length, gpu: app.getGPUFeatureStatus(), records, errors }, null, 2));
    assert.deepEqual(errors, []);
    if (check) {
      assert.ok(records.find(r => r.name === 'idle').rafPerSecond < 12, 'Idle clock should follow authored deadlines');
      assert.ok(records.find(r => r.name === 'idle').styleRecalculationsPerSecond < 12, 'Idle must not restyle at display refresh rate');
      if (fullHost && forwardsIgnoredMouseMoves) {
        assert.equal(records.find(r => r.name === 'host-static').pointerSamplesPerSecond, 0,
          'Forwarded pointer platforms must not retain a native polling loop');
      } else if (fullHost && process.platform === 'win32') {
        const host = records.find(r => r.name === 'host-static');
        assert.ok(host.pointerSamplesPerSecond >= 15 && host.pointerSamplesPerSecond <= 25,
          `Windows cursor ownership must use only the bounded 50 ms native poll: ${host.pointerSamplesPerSecond}`);
        assert.ok(host.pointerMessagesPerSecond <= 6,
          `A stationary Windows cursor must suppress unchanged IPC: ${host.pointerMessagesPerSecond}`);
      }
      for (const name of ['reduced-motion', 'hidden']) {
        assert.equal(records.find(r => r.name === name).rafPerSecond, 0, name + ' has no running animation clock');
      }
    }
  } finally { stopPointer(); win.destroy(); owner?.destroy(); app.quit(); }
}

if (process.versions.electron) measure().catch(error => { console.error(error); require('electron').app.exit(1); });
else buildAndRun().catch(error => { console.error(error); process.exitCode = 1; });
