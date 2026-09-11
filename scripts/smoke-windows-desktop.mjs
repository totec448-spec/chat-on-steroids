/** Opt-in live Windows smoke: node scripts/smoke-windows-desktop.mjs [--software-fixture]
 * The optional flag changes WPF fixture rendering only; capture always uses production WGC. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import sharp from 'sharp';

if (process.platform !== 'win32') throw new Error('This smoke requires an unlocked Windows desktop.');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(path.join(tmpdir(), 'cos-desktop-smoke-'));
const execute = promisify(execFile);
const children = [];
const softwareFixture = process.argv.includes('--software-fixture');

function launch(executable, args) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, args, { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  async function read() {
    let timer;
    try {
      const line = await Promise.race([
        (async () => { let next; do { next = await lines.next(); } while (!next.done && !next.value.trim()); return next; })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Desktop smoke response timeout')), 10_000); })
      ]);
      if (line.done) throw new Error('Desktop smoke process exited before its response');
      return JSON.parse(line.value);
    } finally { clearTimeout(timer); }
  }
  return { child, read, request: async value => { child.stdin.write(value + '\n'); return read(); } };
}

try {
  const framework = path.join(process.env.windir ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const fixtureFile = path.join(directory, 'fixture.exe');
  await execute(path.join(framework, 'csc.exe'), [
    '/nologo', '/r:System.Xaml.dll', '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    ...['WindowsBase.dll', 'PresentationCore.dll', 'PresentationFramework.dll'].map(name => `/r:${path.join(framework, 'WPF', name)}`),
    `/out:${fixtureFile}`, path.join(repository, 'test', 'fixtures', 'windows-desktop', 'capture.cs')
  ], { windowsHide: true, timeout: 15_000 });
  const bundled = await build({ entryPoints: [path.join(repository, 'src/main/computer/helper.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
  const { HELPER_SCRIPT } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const script = path.join(directory, 'helper.ps1');
  await writeFile(script, HELPER_SCRIPT);
  const fixture = launch(fixtureFile, softwareFixture ? ['--software'] : []);
  const windows = await fixture.read();
  assert.ok(windows.target > 0, `Fixture was not ready: ${JSON.stringify(windows)}`);
  // A different process owns foreground, as when the user watches the Electron
  // app while its helper must activate Chrome. Same-process WPF windows alone
  // do not exercise that thread-input boundary.
  const foregroundFixture = launch(fixtureFile, softwareFixture ? ['--software'] : []);
  const foregroundWindows = await foregroundFixture.read();
  assert.ok(foregroundWindows.target > 0, 'Foreground fixture was not ready');
  const electronFile = path.join(directory, 'electron-probe.cjs');
  await build({
    stdin: { resolveDir: repository, loader: 'ts', contents: `
import { app } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { act, activeWindow, getWindowState, listDesktopApps, listWindows, stopComputerHelper } from ${JSON.stringify(path.join(repository, 'src/main/computer/index.ts'))};
import { createWindowsComputerApi } from ${JSON.stringify(path.join(repository, 'src/main/computer/windows-api.ts'))};
app.setPath('userData', ${JSON.stringify(path.join(directory, 'electron-data'))});
const target=${windows.target};
app.whenReady().then(async()=>{
 let result;
 const op=process.argv[2];
  try {
   if(op==='snapshot') {
    const before=await activeWindow();
    const state=await getWindowState({window:target,maxWidth:320,includeUi:false,includeRelated:true});
    const after=await activeWindow();
    if(!state.screenshot) throw Error('Missing composed screenshot');
    await writeFile(${JSON.stringify(path.join(directory, 'electron-capture.png'))},Buffer.from(state.screenshot.data,'base64'));
    const {data,...screenshot}=state.screenshot;
    const related=[];
    for(const [index,item] of (state.related??[]).entries()) {
     if(item.screenshot) await writeFile(${JSON.stringify(directory)}+'/related-'+index+'.png',Buffer.from(item.screenshot.data,'base64'));
     const {data,...image}=item.screenshot??{};
     related.push({window:item.window.id,screenshot:item.screenshot?image:null,error:item.error});
    }
    const api=createWindowsComputerApi({act,listDesktopApps,listWindows,getWindowState:opts=>getWindowState({...opts,maxWidth:320})});
    const listed=await api.list_windows();
    const window=listed.find(item=>item.id===target);
    assert.ok(window?.app,'Native target absent from Windows API');
    assert.deepEqual(await api.get_window({id:target,app:window.app}),window);
    const popup=await api.get_window({id:${windows.popup}});
    assert.equal(popup.app,window.app,'Owned popup application identity changed');
    const apps=await api.list_apps();
    const ownApp=apps.find(item=>item.id===window.app);
    assert.ok(ownApp?.isRunning && ownApp.windows.some(item=>item.id===target),'Actual app membership missing');
    for(const item of apps) for(const member of item.windows) assert.equal(member.app,item.id);
    const defaultState=await api.get_window_state({window});
    assert.equal(defaultState.accessibility,null,'Default unexpectedly includes text');
    assert.equal(defaultState.screenshots.length,1+related.filter(item=>item.screenshot).length);
    assert.ok(defaultState.screenshots.every(item=>item.url.startsWith('data:image/png;base64,')&&item.width>0&&item.height>0));
    assert.equal(new Set(defaultState.screenshots.map(item=>item.id)).size,defaultState.screenshots.length);
    const popupSource=state.related.find(item=>item.window.id===popup.id).screenshot;
    assert.ok(defaultState.screenshots.some(item=>item.originX===popupSource.region.x&&item.originY===popupSource.region.y&&item.width===popupSource.width&&item.height===popupSource.height),'Popup screenshot coordinates were not mapped from the native owned window');
    for(const image of defaultState.screenshots){const png=Buffer.from(image.url.split(',')[1],'base64');assert.equal(image.width,png.readUInt32BE(16));assert.equal(image.height,png.readUInt32BE(20));}
    const textState=await api.get_window_state({window,include_text:true});
    assert.ok(textState.accessibility?.tree,'Explicit accessibility tree missing');
    const invokeLine=textState.accessibility.tree.split('\\n').find(line=>line.includes('"Smoke Invoke"')&&line.includes('[Invoke'));
    assert.ok(invokeLine,'Owned button/action missing from indexed tree: '+textState.accessibility.tree);
    const elementIndex=Number(invokeLine.trim().split(':')[0]);
    assert.ok(Number.isInteger(elementIndex));
    const textOnly=await api.get_window_state({window,include_text:true,include_screenshot:false});
    assert.equal(textOnly.screenshots.length,0);
    assert.equal(textOnly.accessibility.tree,textState.accessibility.tree);
    const apiAfter=await activeWindow();
    assert.equal(apiAfter.window?.id,before.window?.id,'Windows API observation changed foreground');
    await api.perform_secondary_action({window,element_index:elementIndex,action:'Invoke'});
    await api.get_window_state({window});
    await api.click({window,x:(${windows.invokeX}-state.screenshot.region.x)*state.screenshot.scale,y:(${windows.invokeY}-state.screenshot.region.y)*state.screenshot.scale});
    result={ok:true,before:before.window?.id,after:after.window?.id,window:state.window.id,screenshot,related,windowsApi:{app:window.app,catalogCount:apps.length,membershipVerified:true,defaultTextAbsent:true,textIndexesVerified:true,semanticInvocationRequested:true,popupIdentityVerified:true,screenshots:defaultState.screenshots.map(({url,...item})=>item)}};
   } else if(op==='paste') result={ok:true,result:await act([{type:'paste',text:'a\\nb\\r\\nc'}],{window:target})};
   else throw Error('Unknown probe operation');
  }catch(error){result={ok:false,error:String(error)};}
 await writeFile(${JSON.stringify(path.join(directory, 'electron-result.json'))},JSON.stringify(result));
 await stopComputerHelper();app.exit(result.ok?0:1);
}).catch(error=>{console.error(error);app.exit(1);});
` }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: electronFile
  });
  const electronExecutable = createRequire(import.meta.url)('electron');
  async function runElectron(op) {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    try { await execute(electronExecutable, [electronFile, op], { env: environment, windowsHide: true, timeout: 15_000, maxBuffer: 32_768 }); }
    catch (error) {
      const detail = await readFile(path.join(directory, 'electron-result.json'), 'utf8').catch(() => '');
      if (detail) throw new Error(`Electron probe failed: ${detail}`);
      throw error;
    }
    return JSON.parse(await readFile(path.join(directory, 'electron-result.json'), 'utf8'));
  }
  const composed = await runElectron('snapshot');
  assert.equal(composed.ok, true, JSON.stringify(composed));
  const invocationReport=await fixture.request('report');
  assert.equal(invocationReport.invocations,2,'Windows API semantic and resized-image coordinate clicks did not both reach the owned fixture');
  await foregroundFixture.request('quit');
  await fixture.request('occlude');
  assert.equal(composed.window, windows.target);
  assert.equal(composed.before, composed.after);
  assert.equal(composed.screenshot.captureMode, 'window');
  assert.equal(composed.screenshot.width, 320);
  assert.ok(composed.screenshot.frameId > 0);
  assert.ok(windows.popup > 0);
  assert.ok(!composed.related.some(item => item.window === windows.occluder), 'Unrelated same-process window was captured');
  const popupIndex = composed.related.findIndex(item => item.window === windows.popup);
  assert.ok(popupIndex >= 0, 'Owned WPF popup was not returned');
  const popupImage = composed.related[popupIndex];
  assert.ok(popupImage.screenshot, JSON.stringify(popupImage));
  assert.notEqual(popupImage.screenshot.frameId, composed.screenshot.frameId);
  const popupPixels = await sharp(path.join(directory, `related-${popupIndex}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const popupOffset = (Math.floor(popupPixels.info.height / 2) * popupPixels.info.width + Math.floor(popupPixels.info.width / 2)) * 4;
  assert.ok(popupPixels.data[popupOffset] > 240 && popupPixels.data[popupOffset + 1] < 10 && popupPixels.data[popupOffset + 2] > 240, 'Popup capture has incorrect pixels');
  const composedPixels = await sharp(path.join(directory, 'electron-capture.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const composedOffset = (Math.round(composedPixels.info.height * 0.25) * composedPixels.info.width + Math.round(composedPixels.info.width * 0.125)) * 4;
  const composedMarker = Array.from(composedPixels.data.subarray(composedOffset, composedOffset + 4));
  if (!(composedMarker[0] < 10 && composedMarker[1] > 240 && composedMarker[2] < 10)) {
    await mkdir(path.join(repository, 'outputs/windows-capture-validation'), { recursive: true });
    await writeFile(path.join(repository, 'outputs/windows-capture-validation/failed-owned-fixture.png'), await readFile(path.join(directory, 'electron-capture.png')));
    throw new Error('Owned marker mismatch: ' + JSON.stringify({ pixel: composedMarker, image: composedPixels.info, screenshot: composed.screenshot }));
  }
  const helper = launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script]);
  const request = value => helper.request(JSON.stringify(value));
  const before = await request({ op: 'active' });
  const file = path.join(directory, 'capture.png');
  const start = performance.now();
  const state = await request({ op: 'snapshot', id: windows.target, includeScreenshot: true, includeUi: false, maxWidth: 320, file });
  const after = await request({ op: 'active' });
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.equal(state.captureMode, 'window');
  assert.equal(state.focused, false);
  assert.equal(after.window.id, before.window.id);
  assert.equal(state.image.width, 320);
  assert.ok(state.region.width <= state.windowGeometry.width);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Marker occupies the upper left of the known owned target, independent of the
  // occluder's blue surface and the input control lower down.
  const offset = (Math.round(info.height * 0.25) * info.width + Math.round(info.width * 0.125)) * 4;
  assert.ok(data[offset] < 10 && data[offset + 1] > 240 && data[offset + 2] < 10, 'Capture contains the wrong target pixels');
  const captureMs = Math.round(performance.now() - start);
  await fixture.request('minimize');
  const minimized = await request({ op: 'capture', id: windows.target, maxWidth: 320, file });
  assert.equal(minimized.ok, false);
  assert.equal(minimized.error_code, 'CAPTURE_FAILED', JSON.stringify(minimized));
  await fixture.request('edit');
  const typed = await request({ op: 'act', targetWindow: windows.target, actions: [{ type: 'type', text: 'a\nb\r\nc' }] });
  assert.equal(typed.ok, false, JSON.stringify(typed));
  assert.equal(typed.error_code, 'MULTILINE_REQUIRES_PASTE', JSON.stringify(typed));
  const rejected = await fixture.request('report');
  assert.equal(rejected.text, '', 'Multiline rejection occurred after partial input');
  const literalText = 'Computer use test: Hello123';
  const literal = await request({ op: 'act', targetWindow: windows.target, actions: [{ type: 'type', text: literalText }] });
  assert.equal(literal.ok, true, JSON.stringify(literal));
  // SendInput acceptance precedes the target's message processing. Observe its
  // actual value under a bounded wait instead of equating injection with delivery.
  let report;
  const inputDeadline = performance.now() + 2000;
  do {
    report = await fixture.request('report');
    if (report.text === literalText) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (performance.now() < inputDeadline);
  assert.equal(report.text, literalText);
  assert.equal(report.enterKeys, 0, 'Literal text emitted a Return keypress');
  const preserved = await fixture.request('save-clipboard');
  let paste;
  if (preserved.ok !== true) {
    paste = { status: 'skipped', reason: preserved.error, clipboardChanged: false };
  } else {
    assert.equal(preserved.clipboardSaved, true);
    await fixture.request('paste-ready');
    let pasted;
    let restored;
    try {
      pasted = await runElectron('paste');
      assert.equal(pasted.ok, true, JSON.stringify(pasted));
      assert.equal(pasted.result.completedCount, 1);
      const pasteDeadline = performance.now() + 2000;
      do {
        report = await fixture.request('report');
        if (report.text.replaceAll('\r\n', '\n') === 'a\nb\nc') break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (performance.now() < pasteDeadline);
      assert.equal(report.text.replaceAll('\r\n', '\n'), 'a\nb\nc');
      assert.equal(report.enterKeys, 0, 'Multiline paste emitted Return');
      assert.equal(report.pasteCount, 1);
    } finally { restored = await fixture.request('restore-clipboard'); }
    paste = { status: 'passed', completedCount: pasted.result.completedCount, pasteCount: report.pasteCount, enterKeys: report.enterKeys, clipboardRestored: restored.clipboardRestored };
  }
  console.log(JSON.stringify({ fixtureRendering: softwareFixture ? 'wpf-software' : 'wpf-default-hardware-eligible', capturePassed: true, nativeInputPassed: true, windowsApi: {...composed.windowsApi,semanticAndCoordinateInvocationVerified:invocationReport.invocations===2}, captureMs, image: state.image, region: state.region, windowGeometry: state.windowGeometry, foregroundPreserved: true, composedFrame: composed.screenshot.frameId, relatedFrame: popupImage.screenshot.frameId, unrelatedWindowExcluded: true, minimizedError: minimized.error_code, multilineError: typed.error_code, paste }, null, 2));
  await fixture.request('quit');
} finally {
  // Only processes created by this harness are stopped, and only its own mkdtemp
  // directory is removed. Closing stdin tells the fixture to close both windows.
  for (const child of children) child.stdin.end();
  for (const child of children) {
    if (child.exitCode !== null) continue;
    let timer;
    try { await Promise.race([once(child, 'exit'), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(timer); }
    if (child.exitCode === null) child.kill();
  }
  await rm(directory, { recursive: true, force: true });
}
