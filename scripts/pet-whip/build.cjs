// Renders the Whip pet (pets/whip): node scripts/pet-whip/build.cjs [--sheet out.png]
// draw.cjs draws one frame as SVG; frames.cjs holds all 96 frames, their timings and the hand points
// where a carried word hangs from the lash. The atlas and manifest are written next to pet.json.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { frames, frame, manifest } = require('./frames.cjs');

const target = path.resolve(__dirname, '../../pets/whip');
const cells = frames.map((f, i) => `<g transform="translate(${(i % 8) * 160},${Math.floor(i / 8) * 160})"><svg x="0" y="0" width="160" height="160" overflow="hidden">${frame(f)}</svg></g>`).join('');
const sheetAt = process.argv.indexOf('--sheet');
const jobs = [sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1920">${cells}</svg>`)).png({ compressionLevel: 9 }).toFile(path.join(target, 'atlas.png'))];
if (sheetAt > 0) {
  // A numbered contact sheet on a light background, for reviewing every frame at once.
  const numbers = frames.map((_, i) => `<rect x="${(i % 8) * 160 + 0.5}" y="${Math.floor(i / 8) * 160 + 0.5}" width="159" height="159" fill="none" stroke="#ddd"/><text x="${(i % 8) * 160 + 4}" y="${Math.floor(i / 8) * 160 + 12}" font-size="10" fill="#999">${i}</text>`).join('');
  jobs.push(sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1920"><rect width="100%" height="100%" fill="#f4f1ea"/>${numbers}${cells}</svg>`)).png().toFile(process.argv[sheetAt + 1]));
}
Promise.all(jobs).then(() => {
  fs.writeFileSync(path.join(target, 'animations.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), target)}/atlas.png and animations.json`);
});
