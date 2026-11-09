// Maintainer tool: the README's feature pictures, taken from the UI checks' own fixtures (made-up
// data only) and cropped to the part that matters. Run after `npm run build`:
//
//   node scripts/capture-readme-features.cjs
//
// Together with capture-readme-shots.cjs this redoes every picture in docs/images used by the README.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const electron = require('electron');

const root = path.resolve(__dirname, '..');
const images = path.join(root, 'docs/images');

// [check, file the check writes, output name, crop as fractions of the picture {x, y, w, h}, folder the check
// writes to when it does not take COS_UI_OUTPUT]
const features = [
  ['verify-user-requests.cjs', 'timeline-dark.png', 'step-for-you.png', { x: 0.29, y: 0.2, w: 0.64, h: 0.5 }],
  ['verify-recovery-episode.cjs', 'stopped-dark.png', 'why-stuck.png', { x: 0.27, y: 0.56, w: 0.68, h: 0.3 }],
  ['verify-related-folders.cjs', 'dialog-two.png', 'related-folders.png', { x: 0.31, y: 0.3, w: 0.368, h: 0.4 }],
  ['verify-phone-push.cjs', 'telegram-code-en.png', 'telegram-link.png', { x: 0, y: 0.527, w: 1, h: 0.215 }, 'outputs/phone-push'],
  ['verify-move-to-project.cjs', 'move-to-project-menu.png', 'move-to-project.png', { x: 0, y: 0.295, w: 0.58, h: 0.4 }, 'outputs/move-to-project'],
  ['verify-phone-push.cjs', 'phone-en-1100.png', 'phone-notifications.png', { x: 0, y: 0, w: 1, h: 0.605 }, 'outputs/phone-push']
];

(async () => {
  for (const [check, file, name, crop, fixedOutput] of features) {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-readme-feature-'));
    const run = spawnSync(electron, ['--lang=en-US', path.join(root, 'scripts', check)], { cwd: root, env: { ...process.env, COS_UI_OUTPUT: output }, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`${check} failed:\n${run.stdout}\n${run.stderr}`);
    const source = sharp(path.join(fixedOutput ? path.join(root, fixedOutput) : output, file));
    const { width, height } = await source.metadata();
    const region = { left: Math.round(width * crop.x), top: Math.round(height * crop.y), width: Math.round(width * crop.w), height: Math.round(height * crop.h) };
    await source.extract(region).png({ palette: true, quality: 92, compressionLevel: 9 }).toFile(path.join(images, name));
    fs.rmSync(output, { recursive: true, force: true });
    console.log('wrote', name);
  }
})().catch(error => { console.error(error); process.exit(1); });
