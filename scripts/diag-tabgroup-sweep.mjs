/**
 * Drives the browser driver in a real browser, against a real page.
 *
 * The unit tests cover what can be decided without a browser: the refusal list, the input
 * vocabulary, the page reader against a synthetic DOM. None of that can tell you whether a
 * click actually lands, whether the page believes it, or whether a coordinate read off a
 * screenshot addresses the pixel it appears to. This can, and it is how five real defects were
 * found that the suite was green through.
 *
 * Deliberately not part of `verify` or CI. It needs a Chromium browser installed, and headless
 * capture is timing-dependent in a way that would make CI flaky for reasons that have nothing
 * to do with the code — see the compositor note below. Run it by hand when the driver changes:
 *
 *     npm run verify:browser
 *
 * ## Two accommodations, neither of which changes the code under test
 *
 * `debugger` and `<all_urls>` ship as optional permissions, granted from a click in the popup
 * that cannot be clicked headlessly, so a throwaway copy of the extension promotes exactly
 * those two to required and changes nothing else.
 *
 * The driver normally runs in the service worker. An MV3 worker is lazy and headless does not
 * expose it as a debuggable target, so the module is imported into the popup instead — an
 * ordinary extension page with the same `chrome.debugger` access, running the same file.
 *
 * ## The compositor
 *
 * `Page.captureScreenshot` answers when the renderer produces a frame, and a wheel event when
 * the compositor has taken it. Headless has no compositor driving frames on its own, so both
 * can stall for as long as you let them. The page is nudged and the observation retried here;
 * a wheel event may still not be acknowledged, and that is a property of headless rather than
 * of the driver — clicks, which are acknowledged directly, land every time.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPNG } from './lib/read-png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(os.tmpdir(), `cos-browser-driver-${process.pid}`);
const copy = path.join(workspace, 'extension');
const profile = path.join(workspace, 'profile');
const port = 9400 + (process.pid % 200);
const pagePort = port + 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Where a Chromium build usually lives, in the order worth trying.
 *
 * Chrome for Testing comes first, because installed Chrome can no longer be told to load an
 * unpacked extension: Chrome 137 removed `--load-extension`, and Chrome 152 here ignores it
 * under every documented re-enabling flag — it records zero extensions from the given path.
 * Chrome for Testing is the same Chromium, published by Google for exactly this purpose.
 * Edge still honours the switch, so it remains a usable fallback.
 */
const BROWSERS = [
  process.env['COS_BROWSER'],
  `${os.homedir()}/AppData/Local/chrome-for-testing/chrome-win64/chrome.exe`,
  `${os.homedir()}/.cache/puppeteer/chrome/win64/chrome.exe`,
  '/Applications/Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

const browserPath = BROWSERS.find((candidate) => existsSync(candidate));
if (!browserPath) {
  console.error('No Chromium browser found. Set COS_BROWSER to one and try again.');
  process.exit(2);
}

rmSync(workspace, { recursive: true, force: true });
mkdirSync(copy, { recursive: true });
cpSync(path.join(root, 'extension'), copy, { recursive: true });

const manifest = JSON.parse(readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
manifest.permissions = [...manifest.permissions, ...manifest.optional_permissions];
manifest.host_permissions = [...manifest.host_permissions, ...manifest.optional_host_permissions];
delete manifest.optional_permissions;
delete manifest.optional_host_permissions;
writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(manifest, null, 2));

// The shapes that matter: a control named only by aria-label, a field, something hidden, and
// an iframe — which is the case that was invisible until the frame walk landed.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Driver fixture</title>
<style>body{font:14px system-ui;margin:0;padding:16px}</style>
<button id="go" aria-label="Run the thing">Run</button>
<input id="name" placeholder="Your name">
<button id="hidden" style="display:none">Never</button>
<button id="dbl" aria-label="Double me">Double</button>
<div id="pad" style="width:220px;height:70px;border:1px dashed #999">Drag pad</div>
<a id="onward" href="/second">Go onward</a>
<a id="leave" href="about:blank">Leave for a refused page</a>
<a id="popsNewTab" href="/second" target="_blank">Open in a new tab</a>
<div id="log">nothing yet</div>
<div id="klog">no keys</div>
<div id="dlog">no dblclick</div>
<div id="draglog">no drag</div>
<div id="wheellog">no wheel</div>
<!-- Reveals itself only under the pointer, and only for a real mouseover: a hover that is not
     delivered leaves this reading "no hover", which a click could never distinguish. -->
<button id="hovertarget" aria-label="Hover me">Hover me</button>
<!-- A real checkbox and a text field side by side: the collector must report a checked state for
     the first and none for the second. The checked property is a boolean on every input, so the
     naive reading gave the text field one too. (No backticks in here: this page is a template
     literal, and a backtick ends it.) -->
<input id="agree" type="checkbox" aria-label="Agree to terms">
<div id="hoverlog">no hover</div>
<iframe id="frame" src="/frame" style="width:320px;height:80px;border:1px solid #ccc"></iframe>
<!-- A small horizontally-scrollable strip, absolutely positioned so it costs the rest of the
     fixture no layout shift and sits well clear of the (400,300) point the page-scroll checks
     use. Its own content is wider than its box, so scrolling it is a real, judgeable movement. -->
<div id="wide" style="position:absolute;left:16px;top:460px;width:200px;height:40px;overflow-x:auto;white-space:nowrap;border:1px solid #999">
  <span style="display:inline-block;width:700px;padding:0 8px">a strip of content much wider than its own box</span>
</div>
<!-- Last, so the page can scroll without pushing anything above it out of the viewport. -->
<div id="tall" style="height:3000px">room to scroll</div>
<!-- A band at a known place in the document, so a screenshot of a scrolled page can be judged by
     its pixels instead of by a scroll counter. Well below the fold and transparent to the pointer,
     so no other check can see it. -->
<div id="band" style="position:absolute;left:0;top:1400px;width:100%;height:300px;background:#0060ff;pointer-events:none"></div>
<script>
document.getElementById('go').addEventListener('click', (e) => {
  document.getElementById('log').textContent = 'clicked trusted=' + e.isTrusted;
});
document.getElementById('name').addEventListener('input', () => {
  document.getElementById('log').textContent = 'typed:' + document.getElementById('name').value;
});
document.getElementById('name').addEventListener('keydown', (e) => {
  document.getElementById('klog').textContent = 'key:' + e.key + ' trusted=' + e.isTrusted;
});
document.getElementById('hovertarget').addEventListener('mouseover', (e) => {
  document.getElementById('hoverlog').textContent = 'hovered trusted=' + e.isTrusted;
});
document.getElementById('hovertarget').addEventListener('click', () => {
  document.getElementById('hoverlog').textContent = 'clicked, which a hover must not do';
});
document.getElementById('dbl').addEventListener('dblclick', (e) => {
  document.getElementById('dlog').textContent = 'dblclick trusted=' + e.isTrusted;
});
// Recorded as a sequence, because a drag that only lands its endpoints is not a drag: the
// press, at least one move while held, and the release all have to arrive, in that order.
const drag = [];
const pad = document.getElementById('pad');
pad.addEventListener('mousedown', (e) => { drag.length = 0; drag.push('down:' + e.isTrusted); });
pad.addEventListener('mousemove', (e) => {
  if (drag.length && e.buttons === 1 && !drag.includes('move:' + e.isTrusted)) drag.push('move:' + e.isTrusted);
});
window.addEventListener('wheel', (e) => {
  document.getElementById('wheellog').textContent =
    'wheel deltaY=' + e.deltaY + ' trusted=' + e.isTrusted;
}, { passive: true });
pad.addEventListener('mouseup', (e) => {
  drag.push('up:' + e.isTrusted);
  document.getElementById('draglog').textContent = drag.join(' ');
});
</script>`;

const FRAME = `<!doctype html><meta charset="utf-8"><title>inner</title>
<button id="inner">Inside the frame</button><span id="innerlog">idle</span>
<script>
document.getElementById('inner').addEventListener('click', (e) => {
  document.getElementById('innerlog').textContent = 'inner clicked trusted=' + e.isTrusted;
});
</script>`;

const SECOND = `<!doctype html><meta charset="utf-8"><title>Second document</title>
<h1>Second</h1>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/frame' ? FRAME : req.url.startsWith('/second') ? SECOND : PAGE);
});
await new Promise((resolve) => server.listen(pagePort, '127.0.0.1', resolve));

/**
 * Chromium's id for an unpacked extension: sha-256 of the load path, nibbles mapped a..p.
 *
 * The path it hashes is the *real* one, with symlinks resolved. On macOS `os.tmpdir()` is
 * `/var/folders/…`, a symlink to `/private/var/folders/…`, so hashing the unresolved path
 * yielded an id no target ever carried: the popup opened as a
 * chrome-error page keeping the requested url, and the run blamed Chrome's `--load-extension`
 * removal for what was this arithmetic. Chrome for Testing 152 loads the extension here fine.
 *
 * Windows is left on `path.resolve` deliberately: it has no such symlink, its id is proven
 * correct against Chrome 152 and Edge, and `realpathSync` there can renormalise a path in ways
 * this cannot check from macOS.
 */
const extensionRoot = process.platform === 'win32' ? path.resolve(copy) : realpathSync(copy);
const digest = createHash('sha256')
  .update(Buffer.from(extensionRoot, process.platform === 'win32' ? 'utf16le' : 'utf8'))
  .digest();
const extensionId = [...digest.subarray(0, 16)]
  .flatMap((byte) => [byte >> 4, byte & 15])
  .map((nibble) => String.fromCharCode(97 + nibble))
  .join('');

// Headless by default, because that is what a build machine can run. A wheel event is only
// delivered to a page by a compositor that draws frames, and headless draws none — so the one
// property scroll has that matters, its direction, is unjudgeable there and the check below says
// so rather than passing. Run with --headed on a machine with a screen to actually judge it.
const headed = process.argv.includes('--headed');
const browser = spawn(browserPath, [
  ...(headed ? [] : ['--headless=new', '--disable-gpu']),
  `--user-data-dir=${profile}`,
  `--load-extension=${copy}`, `--remote-debugging-port=${port}`,
  '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout',
  '--no-first-run', '--no-default-browser-check', `http://127.0.0.1:${pagePort}/`
], { stdio: 'ignore' });
// Wait for the port to answer rather than guessing at a duration: Chrome for Testing takes
// noticeably longer to come up than Edge, and a fixed sleep turned that into "fetch failed".
let ready = null;
for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
  try {
    ready = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  } catch {
    await sleep(500);
  }
}
if (!ready) {
  console.error(`${browserPath} never opened its debugging port.`);
  process.exit(2);
}

/** One target's CDP session. Every call is bounded: a silent hang would read as a pass. */
async function attachTarget(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const waiting = new Map();
  let id = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', () => reject(new Error('socket failed')));
  });
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    const settle = waiting.get(frame.id);
    if (settle) {
      waiting.delete(frame.id);
      settle(frame);
    }
  });
  return {
    close: () => socket.close(),
    /** Any CDP method, so a check can report what the browser actually answered. */
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const message = { id: ++id, method, params };
        const timer = setTimeout(() => {
          waiting.delete(message.id);
          resolve({ error: `${method} timed out` });
        }, 30_000);
        waiting.set(message.id, (frame) => {
          clearTimeout(timer);
          resolve(frame.error ? { error: JSON.stringify(frame.error) } : (frame.result ?? {}));
        });
        socket.send(JSON.stringify(message));
      }),
    evaluate: (expression) =>
      new Promise((resolve) => {
        const message = {
          id: ++id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        };
        // Longer than the driver's own compositor deadline, or this gives up first and reports
        // a driver failure that is really a harness one.
        const timer = setTimeout(() => {
          waiting.delete(message.id);
          resolve({ error: 'evaluate timed out' });
        }, 90_000);
        waiting.set(message.id, (frame) => {
          clearTimeout(timer);
          const details = frame.result?.exceptionDetails;
          resolve(
            details
              ? { error: `${details.text} ${details.exception?.description ?? ''}`.trim() }
              : { value: frame.result?.result?.value }
          );
        });
        socket.send(JSON.stringify(message));
      })
  };
}
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 300) : ''}`);
};

let worker;
try {
  // Eine gewoehnliche http-Seite, damit es einen "already-settled ordinary tab" gibt.
  await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${pagePort}/second`)}`,
    { method: 'PUT' }).catch(() => {});
  await sleep(2500);

  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  console.log('Ziele im Browser:');
  for (const t of list) console.log(`  ${String(t.type).padEnd(15)} ${String(t.url).slice(0, 78)}`);
  const swTarget = list.find((t) => t.type === 'service_worker' && t.url.includes(extensionId));
  if (!swTarget) { check('der Service Worker ist erreichbar', false, 'kein service_worker-Ziel'); throw new Error('kein worker'); }
  check('der Service Worker ist erreichbar', true, swTarget.url);
  worker = await attachTarget(swTarget.webSocketDebuggerUrl);

  const inWorker = async (expr) => {
    const r = await worker.evaluate(expr);
    return r;
  };

  // Was der Worker ueberhaupt an Rechten hat — sonst kehrt der Sweep still zurueck.
  const caps = await inWorker(`(async () => JSON.stringify({
    hasTabGroups: typeof chrome.tabGroups !== 'undefined' && typeof chrome.tabGroups.query === 'function',
    hasUngroup: typeof chrome.tabs?.ungroup === 'function',
    hasGroup: typeof chrome.tabs?.group === 'function',
    perms: await chrome.permissions.getAll()
  }))()`);
  console.log('\\nRechte im Worker: ' + (caps.value ?? caps.error));
  const capsParsed = JSON.parse(String(caps.value ?? '{}'));
  check('der Worker kann Gruppen abfragen und aufloesen',
    capsParsed.hasTabGroups === true && capsParsed.hasUngroup === true, caps.value ?? caps.error);

  console.log('\\n===== Der vorgeschlagene Ablauf, woertlich =====');
  const script = `(async () => {
  const out = [];
  const tabs = await chrome.tabs.query({});
  const target = tabs.find(t => t.url && t.url.startsWith('http'));
  if (!target) { out.push('No ordinary http(s) tab open — open any normal page first.'); return JSON.stringify(out); }
  out.push('using existing tab: ' + target.id + ' ' + target.url);
  try {
    const groupId = await chrome.tabs.group({ tabIds: [target.id] });
    await chrome.tabGroups.update(groupId, { title: 'Chat On Steroids', color: 'blue' });
    out.push('groupId: ' + groupId);
    out.push('before sweep: ' + JSON.stringify(await chrome.tabGroups.query({ title: 'Chat On Steroids' })));
    chrome.alarms.create('clf-bridge-drain', { when: Date.now() + 500 });
    await new Promise(r => setTimeout(r, 2000));
    out.push('after sweep: ' + JSON.stringify(await chrome.tabGroups.query({ title: 'Chat On Steroids' })));
    out.push('tab still exists, ungrouped: ' + JSON.stringify(await chrome.tabs.get(target.id)));
  } catch (e) {
    out.push('THREW: ' + (e && e.message ? e.message : String(e)));
    try {
      const w = await chrome.windows.get(target.windowId);
      out.push('window of that tab: ' + JSON.stringify(w));
    } catch (e2) { out.push('windows.get threw: ' + String(e2)); }
    out.push('all windows: ' + JSON.stringify(await chrome.windows.getAll({})));
  }
  return JSON.stringify(out);
})()`;
  const res = await inWorker(script);
  let lines = [];
  try { lines = JSON.parse(String(res.value ?? '[]')); } catch { lines = [String(res.value ?? res.error)]; }
  for (const l of lines) console.log('  ' + l);

  console.log('\n===== Die beiden gescheiterten Varianten, nachgestellt =====');
  const variants = `(async () => {
  const out = [];
  const note = async (label, fn) => {
    try { const r = await fn(); out.push(label + ' -> OK ' + JSON.stringify(r)); }
    catch (e) { out.push(label + ' -> FEHLER: ' + (e && e.message ? e.message : String(e))); }
  };
  // Variante 1: frisch erzeugter Tab, sofort gruppiert
  let t1 = null;
  await note('1) tabs.create({about:blank, active:false})', async () => {
    t1 = await chrome.tabs.create({ url: 'about:blank', active: false });
    return { id: t1.id, windowId: t1.windowId, status: t1.status };
  });
  if (t1) await note('1) tabs.group sofort danach', () => chrome.tabs.group({ tabIds: [t1.id] }));
  // Variante 2: normales Fenster explizit aufgeloest und als windowId uebergeben
  let t2 = null, normal = null;
  await note('2) windows.getAll({windowTypes:["normal"]})', async () => {
    const ws = await chrome.windows.getAll({ windowTypes: ['normal'] });
    normal = ws[0] || null;
    return ws.map(w => ({ id: w.id, type: w.type, state: w.state, focused: w.focused }));
  });
  if (normal) {
    await note('2) tabs.create mit windowId', async () => {
      t2 = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: normal.id });
      return { id: t2.id, windowId: t2.windowId, status: t2.status };
    });
    if (t2) await note('2) tabs.group sofort danach', () => chrome.tabs.group({ tabIds: [t2.id] }));
  }
  // Variante 3: derselbe frische Tab, aber erst nach einer kurzen Pause gruppiert
  let t3 = null;
  await note('3) tabs.create, dann 600 ms warten', async () => {
    t3 = await chrome.tabs.create({ url: 'about:blank', active: false });
    await new Promise(r => setTimeout(r, 600));
    const fresh = await chrome.tabs.get(t3.id);
    return { id: fresh.id, windowId: fresh.windowId, status: fresh.status, index: fresh.index };
  });
  if (t3) await note('3) tabs.group nach der Pause', () => chrome.tabs.group({ tabIds: [t3.id] }));
  for (const t of [t1, t2, t3]) if (t) { try { await chrome.tabs.remove(t.id); } catch {} }
  return JSON.stringify(out);
})()`;
  const vr = await inWorker(variants);
  let vlines = [];
  try { vlines = JSON.parse(String(vr.value ?? '[]')); } catch { vlines = [String(vr.value ?? vr.error)]; }
  for (const l of vlines) console.log('  ' + l);
  const anyNormalWindows = vlines.some((l) => /normal windows/i.test(String(l)));
  check('der "normal windows"-Fehler tritt hier NICHT auf', !anyNormalWindows,
    vlines.filter((l) => /FEHLER/.test(String(l))).join(' | ') || 'kein Fehler in allen drei Varianten');

  const threw = lines.find((l) => String(l).startsWith('THREW: '));
  check('der Ablauf laeuft ohne "normal windows"-Fehler durch', !threw, threw ?? 'kein Fehler');

  const afterLine = lines.find((l) => String(l).startsWith('after sweep: '));
  const tabLine = lines.find((l) => String(l).startsWith('tab still exists, ungrouped: '));
  if (afterLine) {
    const groups = JSON.parse(afterLine.slice('after sweep: '.length));
    check('nach dem Sweep ist keine "Chat On Steroids"-Gruppe mehr da', groups.length === 0, afterLine);
  }
  if (tabLine) {
    const tab = JSON.parse(tabLine.slice('tab still exists, ungrouped: '.length));
    check('der Tab lebt noch und ist ungruppiert', Boolean(tab && tab.id) && tab.groupId === -1,
      `groupId=${tab?.groupId} url=${String(tab?.url).slice(0, 50)}`);
  }

} catch (error) {
  check('the run completed', false, String(error?.message ?? error));
} finally {
  worker?.close();
  browser.kill();
  server.close();
  // Best effort: the browser does not release its profile the instant it is killed, and a
  // leftover temp directory is not a reason to fail a run whose checks all passed.
  await sleep(500);
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.log(`(left ${workspace} behind; the browser still had it open)`);
  }
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
