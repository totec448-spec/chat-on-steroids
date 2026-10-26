// #1802: the three sounds, rendered by Chromium's own Web Audio (OfflineAudioContext) in real
// Electron, then measured: audible but well below full scale, short, and with no click where a
// note starts or ends. No sound device is needed and nothing is played aloud.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const root = path.join(__dirname, '..'), output = path.join(root, 'outputs/sound-cues');
  fs.mkdirSync(output, { recursive: true });
  const code = (await require('esbuild').build({ stdin: { contents: `export { scheduleSoundCue } from './src/renderer/sound-cues.ts';`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'cues', logLevel: 'error' })).outputFiles[0].text;
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,<!doctype html><title>sounds</title>');
  await win.webContents.executeJavaScript(code);
  const results = {};
  for (const kind of ['finished', 'needs-you', 'failed']) {
    const measured = await win.webContents.executeJavaScript(`(async () => {
      const rate = 48000, audio = new OfflineAudioContext(1, rate, rate);
      cues.scheduleSoundCue(audio, ${JSON.stringify(kind)}, 0);
      const data = (await audio.startRendering()).getChannelData(0);
      let peak = 0, sum = 0, jump = 0, first = -1, last = -1;
      for (let i = 0; i < data.length; i++) {
        const value = Math.abs(data[i]);
        peak = Math.max(peak, value); sum += data[i] * data[i];
        if (value > 0.001) { if (first < 0) first = i; last = i; }
        if (i) jump = Math.max(jump, Math.abs(data[i] - data[i - 1]));
      }
      const heard = data.slice(first, last + 1);
      const rms = Math.sqrt(heard.reduce((total, value) => total + value * value, 0) / heard.length);
      return { peak, rms, seconds: (last - first) / rate, start: Math.abs(data[Math.max(0, first)]), end: Math.abs(data[last]), jump,
        tail: Math.max(...data.slice(last + 1).map(Math.abs), 0) };
    })()`);
    results[kind] = measured;
    // Audible: a cue that renders silence would pass every unit test and still be useless.
    assert.ok(measured.rms > 0.02, `${kind} is audible: ${JSON.stringify(measured)}`);
    // Well below full scale, overlapping notes included.
    assert.ok(measured.peak <= 0.13, `${kind} stays quiet: ${JSON.stringify(measured)}`);
    assert.ok(measured.seconds > 0.15 && measured.seconds < 0.6, `${kind} is short: ${JSON.stringify(measured)}`);
    // No click: it starts and ends near silence, and no sample leaps the way a hard cut does.
    // A 880 Hz sine at 0.12 moves at most about 0.014 per sample at 48 kHz.
    assert.ok(measured.start < 0.01 && measured.end < 0.01 && measured.tail < 0.001, `${kind} fades in and out: ${JSON.stringify(measured)}`);
    assert.ok(measured.jump < 0.03, `${kind} has no click: ${JSON.stringify(measured)}`);
  }
  fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(results, null, 2));
  console.log('Passed: the three sounds render audible, at most 0.13 of full scale, under 0.6 s, fading in and out with no click.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
