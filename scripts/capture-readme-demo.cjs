// Maintainer tool: records the README demo from the production renderer with synthetic data only
// (the same made-up project and chat as the README pictures), so it can be redone whenever the
// app changes. It plays one task from the first keystroke to the final answer and writes
// docs/images/demo.gif (960x540) and docs/images/demo.mp4 (1280x720).
//
//   npx electron scripts/capture-readme-demo.cjs [outDir] [--frames]
//
// --frames also writes each frame as frame-NN.png, for checking a change to the story.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { fixtureServer, root } = require('./fixtures/readme-fixture.cjs');
const { app, BrowserWindow } = require('electron');

const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const keepFrames = process.argv.includes('--frames');
const output = path.resolve(args[0] || path.join(root, 'docs/images'));
const SIZE = { width: 1280, height: 720 };
app.setPath('userData', path.join(root, 'outputs/readme-demo-runtime'));

/** Encodes the frames, each held for its time, as H.264 in MP4 with Chromium's own recorder. */
async function recordVideo(frames) {
  const win = new BrowserWindow({ show: false, ...SIZE, webPreferences: { sandbox: true, backgroundThrottling: false } });
  try {
    await win.loadURL('about:blank');
    await win.webContents.executeJavaScript(`window.clips = []; window.add = (png, ms) => { window.clips.push({ png, ms }); }; true`);
    // Base64 and a number: nothing in these calls needs escaping.
    for (const frame of frames) await win.webContents.executeJavaScript(`add('data:image/png;base64,${frame.png.toString('base64')}', ${Number(frame.ms)})`);
    const base64 = await win.webContents.executeJavaScript(`(async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: ${SIZE.width}, height: ${SIZE.height} });
      const context = canvas.getContext('2d');
      const images = await Promise.all(clips.map(frame => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = frame.png; })));
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4;codecs=avc1.640028', videoBitsPerSecond: 3_000_000 });
      const chunks = []; recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      context.drawImage(images[0], 0, 0, canvas.width, canvas.height);
      recorder.start();
      for (const [index, image] of images.entries()) {
        const until = performance.now() + clips[index].ms;
        // Redrawn on every animation frame: the stream only carries frames the canvas paints.
        while (performance.now() < until) { context.drawImage(image, 0, 0, canvas.width, canvas.height); await new Promise(resolve => requestAnimationFrame(resolve)); }
      }
      recorder.stop(); await stopped;
      const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/mp4' }).arrayBuffer());
      let binary = ''; for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      return btoa(binary);
    })()`);
    return Buffer.from(base64, 'base64');
  } finally { win.destroy(); }
}

app.whenReady().then(async () => {
  const server = await fixtureServer({ demo: true });
  let win;
  try {
    fs.mkdirSync(output, { recursive: true });
    win = new BrowserWindow({ show: false, ...SIZE, useContentSize: true, webPreferences: { sandbox: true, backgroundThrottling: false, zoomFactor: 1 } });
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('renderer:', event.message); });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    const js = code => win.webContents.executeJavaScript(code);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (predicate, what) => { for (let i = 0; i < 300; i++) { if (await js(predicate)) return; await sleep(50); } throw new Error('timed out: ' + what); };
    const settle = () => js('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))))');
    const frames = [];
    /** One frame of the recording, shown for `ms`. */
    const frame = async ms => { await settle(); frames.push({ png: (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).resize(SIZE).toPNG(), ms }); };
    /** Moves the story on and waits until the app has drawn it. */
    const advance = async (change, drawn, what) => {
      // Stage values are numbers; the keys are this script's own.
      await js(`advance({ ${Object.entries(change).map(([key, value]) => `${key}: ${Number(value)}`).join(', ')} })`);
      await until(drawn, what);
      // Work in progress stays open, as a person watching it would keep it.
      await js(`(() => { for (const group of document.querySelectorAll('#timeline details.tool-group')) group.open = true;
        const plan = document.querySelector('.agent-plan-shell'); if (plan) plan.open = true;
        const body = document.getElementById('chatBody'); body.scrollTop = body.scrollHeight; })()`);
    };
    const tools = count => `document.querySelectorAll('#timeline .tool').length >= ${count}`;

    // 1. A new chat: the task is typed, the model is chosen.
    await until('window.ready && document.getElementById("chatInput").getClientRects().length', 'composer');
    await frame(900);
    // The text typed is the message the story then shows as sent.
    const length = await js('window.rows[1].message.text.length');
    for (let end = 3; end < length + 3; end += 3) {
      await js(`(() => { const input = document.getElementById('chatInput'); input.value = window.rows[1].message.text.slice(0, ${Number(end)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await frame(60);
    }
    await frame(500);
    await js(`document.querySelector('#modelMenu > summary').click()`);
    await until('document.getElementById("modelMenu").open && document.querySelector("#modelMenu .composer-popover").getClientRects().length', 'model picker');
    await frame(1600);
    await js(`document.querySelector('#modelMenu > summary').click()`);
    await frame(400);

    // 2. Sent: the chat opens with the message, and ChatGPT starts on it.
    await js(`(() => { const input = document.getElementById('chatInput'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await js(`advance({ listed: true, rows: 2 })`);
    await until('document.querySelector("#sessionList [data-id=\\"demo\\"]")', 'chat in the list');
    await js('document.querySelector("#sessionList [data-id=\\"demo\\"]").click()');
    await until('document.querySelector(".said.is-user")', 'the sent message');
    await frame(800);
    await advance({ plan: 0 }, 'document.querySelector(".agent-plan-shell")', 'plan');
    await frame(700);

    // 3. Local tools, one call after the other, while the plan moves on.
    await advance({ rows: 3 }, tools(1), 'read'); await frame(500);
    await advance({ rows: 4, plan: 1 }, tools(2), 'search'); await frame(500);
    await advance({ rows: 5 }, tools(3), 'first edit'); await frame(550);
    await advance({ rows: 6 }, tools(4), 'second edit'); await frame(550);
    await advance({ rows: 7, plan: 2 }, tools(5), 'tests'); await frame(800);

    // 4. Two workers take the tests and the docs; their chats appear beside the main one.
    await advance({ workers: 1 }, 'true', 'workers'); await sleep(900);
    await js(`document.getElementById('rightDockToggle').click()`);
    await sleep(600);
    await js(`[...document.querySelectorAll('button, [role=button]')].find(node => node.getClientRects().length && /^Sub-agents/.test(node.textContent.trim()))?.click()`);
    await sleep(600);
    await frame(1200);
    await advance({ rows: 8 }, 'document.querySelector(".ev-assistant_message")', 'progress note'); await frame(1400);
    await advance({ workers: 2 }, 'true', 'docs worker done'); await sleep(700); await frame(1000);
    await advance({ workers: 3, plan: 3 }, 'true', 'tests worker done'); await sleep(700); await frame(900);
    await advance({ rows: 9 }, tools(6), 'final tests'); await frame(800);

    // 5. The answer.
    await advance({ rows: 11, plan: 4 }, 'document.querySelectorAll(".ev-assistant_message").length >= 2', 'final answer');
    await sleep(700);
    await frame(3200);

    if (keepFrames) frames.forEach((entry, index) => fs.writeFileSync(path.join(output, `frame-${String(index).padStart(2, '0')}.png`), entry.png));
    const small = await Promise.all(frames.map(entry => sharp(entry.png).resize(960, 540).png().toBuffer()));
    await sharp(small, { join: { animated: true } }).gif({ delay: frames.map(entry => entry.ms), loop: 0, effort: 10, colours: 128, dither: 0.4, interFrameMaxError: 6 })
      .toFile(path.join(output, 'demo.gif'));
    fs.writeFileSync(path.join(output, 'demo.mp4'), await recordVideo(frames));
    const seconds = frames.reduce((total, entry) => total + entry.ms, 0) / 1000;
    console.log(`wrote demo.gif (${Math.round(fs.statSync(path.join(output, 'demo.gif')).size / 1024)} KB) and demo.mp4 (${Math.round(fs.statSync(path.join(output, 'demo.mp4')).size / 1024)} KB): ${frames.length} frames, ${seconds.toFixed(1)} s`);
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
