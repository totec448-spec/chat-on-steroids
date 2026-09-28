// Real Electron overlay regression, with isolated data and no provider/tunnel access.
// Run after npm run build: electron scripts/verify-pet-toggle.cjs
// Windows --native-pointer moves the OS cursor; do not touch the mouse during this test.
const { app, BrowserWindow, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
// Native callbacks must fail the probe, not leave an Electron error dialog open.
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
const nativePointer = process.argv.includes('--native-pointer');
const checkFocus = process.argv.includes('--check-focus');
const externalKeyboard = process.argv.includes('--external-keyboard');
const runFile = promisify(execFile);
const root = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-pet-toggle-'));
fs.mkdirSync(path.join(userData, 'state'));
fs.writeFileSync(path.join(userData, 'state/pet-library.json'), JSON.stringify({ version: 1, enabled: [], favorites: [] }));
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  roots: [], readOnly: true, capabilities: {},
  tunnel: { kind: 'openai', tunnelId: '', desktopTunnelId: '', binaryPath: '' },
  ui: { minimizeToTray: false, autoConnect: false, autoContinue: false, backgroundChats: false },
  multiAgent: { enabled: false, allowUnattributedCalls: false, recoverAgentTabs: false },
  goal: { enabled: false }
}));
app.setName('CoS Pet Toggle Probe');
app.setPath('userData', userData);
app.setAppPath(root);
process.env.CLF_BRIDGE_PORTS = '0';
let owner, overlay, ignored = true, decodes = 0;
let pointer = { x: 0, y: 0 };
// Drive the existing native proximity sampler without moving the user's actual mouse.
app.whenReady().then(() => { if (!nativePointer) screen.getCursorScreenPoint = () => pointer; });
const decode = nativeImage.createFromBuffer;
nativeImage.createFromBuffer = (...args) => { decodes++; return decode(...args); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.session.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
  contents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
});
const deadline = setTimeout(() => { console.error('Pet toggle timed out', { userData, errors }); app.exit(1); }, 45000);
async function until(predicate, label) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await predicate()) return; await sleep(40); }
  throw new Error(`Timed out: ${label}; ${errors.join('; ')}`);
}
async function petRect(id) {
  return overlay.webContents.executeJavaScript(`(() => {
    const pet = document.querySelector('[data-pet-id="${id}"].pet-shell');
    return pet ? { ...pet.getBoundingClientRect().toJSON(), frame: pet.dataset.frame } : null;
  })()`);
}
async function enable(id, enabled) {
  const result = await owner.webContents.executeJavaScript(`window.api.petsSetEnabled(${JSON.stringify(id)}, ${enabled})`);
  assert.equal(result.ok, true, JSON.stringify(result));
}
async function nativeGesture(x, y, dx = 0, dy = 0, right = false) {
  const area = overlay.getContentBounds();
  const start = screen.dipToScreenPoint({ x: area.x + x, y: area.y + y });
  const end = screen.dipToScreenPoint({ x: area.x + x + dx, y: area.y + y + dy });
  const ownerArea = owner.getContentBounds();
  const typingPoint = screen.dipToScreenPoint({ x: ownerArea.x + 100, y: ownerArea.y + 90 });
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-Command', `
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class PetMouse {
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command);
[DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
[DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);
}
'@
${(dx || dy) && externalKeyboard ? `Add-Type -AssemblyName System.Windows.Forms
$typingForm = New-Object System.Windows.Forms.Form
$typingForm.Text = 'Pets external keyboard test'
$typingForm.SetBounds(80,80,500,200)
$typingBox = New-Object System.Windows.Forms.TextBox
$typingBox.Dock = 'Fill'
$typingForm.Controls.Add($typingBox)
$typingForm.Show()
# The hidden PowerShell startup flag overrides the first native ShowWindow call.
# Explicitly show our owned fixture, never a user's existing window.
[PetMouse]::ShowWindow($typingForm.Handle,5) | Out-Null
$typingForm.Activate()
$typingBox.Focus() | Out-Null
[System.Windows.Forms.Application]::DoEvents()
if (-not [PetMouse]::IsWindowVisible($typingForm.Handle)) { throw 'External typing target is hidden' }
if ([PetMouse]::GetForegroundWindow() -ne $typingForm.Handle) { throw 'External typing target did not reach foreground' }` : dx || dy ? `[PetMouse]::SetCursorPos(${typingPoint.x},${typingPoint.y}) | Out-Null
[PetMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
[PetMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
if ([PetMouse]::GetForegroundWindow().ToInt64() -ne ${owner.getNativeWindowHandle().readBigUInt64LE(0)}) { throw 'Typing owner did not reach native foreground' }` : ''}
$foregroundBefore = [PetMouse]::GetForegroundWindow()
[PetMouse]::SetCursorPos(${start.x},${start.y}) | Out-Null
Start-Sleep -Milliseconds 450
if ([PetMouse]::GetForegroundWindow() -ne $foregroundBefore) { throw 'Hover stole foreground focus' }
[PetMouse]::mouse_event(${right ? 8 : 2},0,0,0,[UIntPtr]::Zero)
try {
Start-Sleep -Milliseconds 100
for($i=1;$i -le 20;$i++) {
if ($typingForm) { [System.Windows.Forms.Application]::DoEvents() }
[PetMouse]::SetCursorPos([int](${start.x}+(${end.x}-${start.x})*$i/20),[int](${start.y}+(${end.y}-${start.y})*$i/20)) | Out-Null
Start-Sleep -Milliseconds 30
}
} finally { [PetMouse]::mouse_event(${right ? 16 : 4},0,0,0,[UIntPtr]::Zero) }
Start-Sleep -Milliseconds 300
if ($typingForm) { [System.Windows.Forms.Application]::DoEvents() }
${checkFocus && (dx || dy) ? `if ([PetMouse]::GetForegroundWindow() -ne $foregroundBefore) { throw 'Focus did not return to the typing target' }
[PetMouse]::keybd_event(0x58,0,0,[UIntPtr]::Zero)
[PetMouse]::keybd_event(0x58,0,2,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
if ($typingForm) {
  [System.Windows.Forms.Application]::DoEvents()
  if ($typingBox.Text -ne 'x') { throw 'External text field did not receive native typing' }
}` : ''}
@{ before = $foregroundBefore.ToInt64(); after = [PetMouse]::GetForegroundWindow().ToInt64() } | ConvertTo-Json -Compress
if ($typingForm) { $typingForm.Dispose() }
`], { windowsHide: true, timeout: 5000 });
  const focus = JSON.parse(stdout.trim());
  if (checkFocus && (dx || dy)) assert.equal(focus.after, focus.before, `Drag must restore foreground: ${stdout.trim()}`);
  if (dx || dy) console.log('Native drag focus', focus);
  await sleep(600);
}
async function nativeMenu(id) {
  const rect = await petRect(id);
  await nativeGesture(Math.round(rect.x + 80), Math.round(rect.y + 80), 0, 0, true);
  const button = await overlay.webContents.executeJavaScript(`(() => {
    const menu = document.querySelector('.pet-menu');
    if (menu.hidden) return null;
    return [...menu.querySelectorAll('button')].find(b => b.textContent === 'Hide pet')?.getBoundingClientRect().toJSON();
  })()`);
  assert.ok(button, 'Native right click must open the menu');
  await nativeGesture(Math.round(button.x + button.width / 2), Math.round(button.y + button.height / 2));
  await until(async () => !await petRect(id), 'native left click on Hide pet');
  assert.equal(overlay.isVisible(), false);
  console.log(`Native context menu: ${id} hidden by left click`);
}
async function drag(id) {
  await until(async () => overlay && await petRect(id), `visible ${id}`);
  const rect = await petRect(id), area = overlay.getContentBounds();
  const x = Math.round(rect.x + 80), y = Math.round(rect.y + 80);
  if (nativePointer) {
    owner.show(); owner.focus();
    await until(() => owner.isFocused(), 'foreground typing owner');
    await sleep(300);
    owner.moveTop();
    await owner.webContents.executeJavaScript(`(() => {
      let input = document.getElementById('pet-keyboard-probe');
      if (!input) { input = document.createElement('input'); input.id = 'pet-keyboard-probe'; input.style.cssText = 'position:fixed;left:50px;top:70px;width:250px;height:40px;z-index:2147483647'; document.body.append(input); }
      input.value = ''; input.focus();
    })()`);
    await overlay.webContents.executeJavaScript(`window.petProbeEvents = []; if (!window.petProbeListening) { window.petProbeListening = true; for (const type of ['pointerdown','pointerup','pointercancel','click']) document.addEventListener(type, e => window.petProbeEvents.push({type, x:e.clientX,y:e.clientY,button:e.button,target:e.target.className}), {capture:true}); }`);
    await nativeGesture(x, y, -80, -40);
    const moved = await petRect(id);
    console.log(JSON.stringify({ nativeDrag: id, rect, moved, events: await overlay.webContents.executeJavaScript('window.petProbeEvents') }));
    assert.ok(moved && Math.abs(moved.x - rect.x + 80) < 3, `${id}: native drag failed`);
    if (checkFocus && !externalKeyboard) assert.equal(await owner.webContents.executeJavaScript("document.getElementById('pet-keyboard-probe').value"), 'x');
    return;
  }
  pointer = { x: area.x + x, y: area.y + y };
  await until(() => !ignored, `interactive ${id}`);
  overlay.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  overlay.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y, clickCount: 1 });
  await sleep(60);
  pointer = { x: area.x + x - 80, y: area.y + y - 40 };
  overlay.webContents.sendInputEvent({ type: 'mouseMove', x: x - 80, y: y - 40, movementX: -80, movementY: -40 });
  overlay.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: x - 80, y: y - 40, clickCount: 1 });
  await sleep(80);
  const moved = await petRect(id);
  assert.ok(moved && Math.abs(moved.x - rect.x + 80) < 3, `${id} did not drag: ${JSON.stringify({ rect, moved })}`);
  console.log(JSON.stringify({ dragged: id, dx: moved.x - rect.x, dy: moved.y - rect.y }));
  pointer = { x: area.x + 5, y: area.y + 5 };
  await until(() => ignored, 'click-through after leaving pet');
}
app.on('browser-window-created', (_event, win) => {
  if (win.getTitle() === 'Pets') {
    overlay = win;
    const ignore = win.setIgnoreMouseEvents.bind(win);
    win.setIgnoreMouseEvents = (value, options) => { ignored = value; return ignore(value, options); };
  } else if (!owner) {
    owner = win;
    win.webContents.once('did-finish-load', () => {
      void (async () => {
        await sleep(1200);
        await enable('capy', true);
        await drag('capy');
        await enable('capy', false);
        await until(() => !overlay.isVisible(), 'hide last pet');
        await enable('hammy', true);
        await drag('hammy');
        if (nativePointer) await nativeMenu('hammy');
        await enable('hammy', false);
        await enable('capy', true);
        await drag('capy');
        owner.focus();
        await owner.webContents.executeJavaScript('window.api.petsSetOverlayVisible(false)');
        assert.equal(overlay.isVisible(), false);
        await owner.webContents.executeJavaScript('window.api.petsSetOverlayVisible(true)');
        assert.equal(overlay.isVisible(), true);
        assert.equal(owner.isFocused(), true, 'Showing pets must not steal foreground focus');
        await drag('capy');
        await enable('hammy', true);
        await until(async () => !!await petRect('hammy'), 'both pets');
        await sleep(150);
        const count = decodes, cpu = process.cpuUsage(), start = performance.now();
        await sleep(1100);
        const elapsed = performance.now() - start, usage = process.cpuUsage(cpu);
        const measurements = { idleDecodes: decodes - count, elapsedMs: elapsed, mainCpuPercent: (usage.user + usage.system) / (elapsed * 10) };
        console.log(JSON.stringify(measurements));
        assert.equal(measurements.idleDecodes, 0, 'Pointer polling must not decode pet atlases');
        await enable('capy', false); await enable('hammy', false);
        assert.equal(overlay.isVisible(), false);
        if (checkFocus) {
          overlay.destroy();
          await enable('capy', true);
          await drag('capy');
          await enable('capy', false);
        }
        clearTimeout(deadline);
        console.log('Pet toggle/drag/click-through and idle decode checks passed.');
        app.quit();
      })().catch(error => { console.error(error); app.exit(1); });
    });
  }
});
require(path.join(root, 'out/main/index.js'));
