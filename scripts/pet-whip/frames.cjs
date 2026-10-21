// All 96 frames of the whip pet, the animations manifest and the atlas.
// Lash points are relative to the lash root at the top of the handle (cell 80,26 when standing).
const { frame, lashTip } = require('./draw.cjs');

const OUT = '#3a2312';
const star = (x, y, r = 1, rot = 0) => `<g transform="translate(${x},${y}) rotate(${rot}) scale(${r})"><path d="M0,-13 L3.5,-3.5 L13,-4.5 L5.5,2 L10,12 L0,5.5 L-10,12 L-5.5,2 L-13,-4.5 L-3.5,-3.5 Z" fill="#ffd34d" stroke="${OUT}" stroke-width="2.2" stroke-linejoin="round"/></g>`;
const burst = (x, y, r = 1) => `<g transform="translate(${x},${y}) scale(${r})">${[0, 45, 90, 135, 180, 225, 270, 315].map(a => `<line x1="${(Math.cos(a * Math.PI / 180) * 10).toFixed(1)}" y1="${(Math.sin(a * Math.PI / 180) * 10).toFixed(1)}" x2="${(Math.cos(a * Math.PI / 180) * 17).toFixed(1)}" y2="${(Math.sin(a * Math.PI / 180) * 17).toFixed(1)}" stroke="#ffb02e" stroke-width="3" stroke-linecap="round"/>`).join('')}<circle r="6" fill="#fff6c9" stroke="${OUT}" stroke-width="2"/></g>`;
const speed = (x, y, n = 3, len = 14) => Array.from({ length: n }, (_, i) => `<line x1="${x}" y1="${y + i * 7}" x2="${x - len + i * 3}" y2="${y + i * 7}" stroke="${OUT}" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`).join('');
const sparkle = (x, y, r = 1) => `<g transform="translate(${x},${y}) scale(${r})"><path d="M0,-7 L1.6,-1.6 L7,0 L1.6,1.6 L0,7 L-1.6,1.6 L-7,0 L-1.6,-1.6 Z" fill="#fff1a8" stroke="${OUT}" stroke-width="1.4" stroke-linejoin="round"/></g>`;
const puff = (x, y, r = 1) => `<g transform="translate(${x},${y}) scale(${r})" opacity="0.9"><circle cx="-5" cy="0" r="5" fill="#fff" stroke="${OUT}" stroke-width="1.8"/><circle cx="3" cy="-3" r="6" fill="#fff" stroke="${OUT}" stroke-width="1.8"/><circle cx="8" cy="2" r="4" fill="#fff" stroke="${OUT}" stroke-width="1.8"/></g>`;

// Lash shapes, reused and blended.
const HANG = [[16, -6], [34, 14], [40, 44], [36, 76], [52, 100], [70, 98]];
const HANG2 = [[16, -4], [33, 16], [37, 46], [34, 78], [50, 101], [68, 101]];
const HANG3 = [[17, -7], [36, 12], [43, 42], [40, 74], [55, 98], [72, 94]];
const TRAIL = [[-14, -6], [-30, 6], [-42, 26], [-52, 46], [-66, 54]];
const TRAIL2 = [[-14, -2], [-28, 14], [-38, 36], [-50, 58], [-66, 66]];
const OVER = [[-12, -16], [-30, -24], [-48, -18], [-60, -2], [-64, 16]];
const UP = [[-6, -20], [-14, -42], [-6, -62], [12, -64], [22, -50]];
const FWD = [[18, -6], [38, -8], [56, -10], [70, -12]];
const FWD_LOW = [[18, 0], [36, 10], [54, 18], [70, 26]];
const DOWN = [[18, 4], [25, 30], [23, 58], [27, 86]];

const frames = [];
const add = (spec) => frames.push(spec);

// spawn 0-3: rises out of the floor
add({ y: 130, sx: 1.2, sy: 0.25, eyes: 'closed', mouth: 'flat', lash: [[14, 2], [26, 6], [36, 4]] });
add({ y: 130, sx: 1.08, sy: 0.62, eyes: 'closed', mouth: 'smile', lash: [[16, 0], [32, 8], [44, 10], [56, 6]] });
add({ y: 122, sx: 0.94, sy: 1.1, eyes: 'wide', mouth: 'o', lash: [[10, -14], [24, -22], [40, -16], [50, -2]] });
add({ eyes: 'open', mouth: 'grin', lash: HANG });
// idle 4-7: breathes, blinks, the lash sways
add({ eyes: 'open', mouth: 'smile', lash: HANG });
add({ eyes: 'closed', mouth: 'smile', sx: 1.02, sy: 0.98, lash: HANG2 });
add({ eyes: 'open', mouth: 'smile', look: 0.3, lash: HANG3 });
add({ eyes: 'open', mouth: 'smile', sy: 1.01, lash: HANG });
// look 8-11
add({ eyes: 'open', mouth: 'smile', look: -1, tilt: -3, lash: HANG2 });
add({ eyes: 'open', mouth: 'o', look: -1, tilt: -4, lash: HANG2 });
add({ eyes: 'open', mouth: 'smile', look: 1, tilt: 3, lash: HANG3 });
add({ eyes: 'open', mouth: 'smile', look: 0.4, tilt: 1, lash: HANG });
// walk 12-19: hops on its knob, the lash trailing behind
const hop = [0, 5, 10, 13, 10, 5, 0, 0];
const squash = [[1.08, 0.92], [0.98, 1.04], [0.96, 1.06], [0.97, 1.04], [0.98, 1.02], [1, 1], [1.1, 0.9], [1.03, 0.97]];
hop.forEach((h, i) => add({ y: 130 - h, sx: squash[i][0], sy: squash[i][1], tilt: i < 4 ? 4 : i < 6 ? 2 : 0, eyes: 'open', mouth: i === 3 ? 'grin' : 'smile', look: 0.6,
  lash: i % 2 ? TRAIL2 : TRAIL, fx: i === 6 ? puff(52, 132, 0.6) : '' }));
// held 20-23: dangles, lash hanging down
[-8, 6, -5, 4].forEach((t, i) => add({ tilt: t, eyes: i === 0 ? 'wide' : 'open', mouth: 'o', look: i % 2 ? 0.5 : -0.5, lash: DOWN.map(([x, y]) => [x + t * 1.2, y]), noShadow: true }));
// landing 24-27
[[1.16, 0.84], [1.06, 0.94], [0.97, 1.04], [1, 1]].forEach(([sx, sy], i) => add({ sx, sy, eyes: i < 2 ? 'closed' : 'open', mouth: i < 2 ? 'flat' : 'smile', lash: i < 2 ? [[18, 2], [36, 16], [48, 40], [56, 70], [66, 96], [78, 100]] : HANG, fx: i === 0 ? puff(48, 132, 0.7) + puff(112, 132, 0.6) : '' }));
// poke 28-31
add({ tilt: -7, sx: 1.06, sy: 0.94, eyes: 'closed', mouth: 'grit', lash: HANG3, fx: sparkle(112, 30, 0.9) });
add({ tilt: -4, eyes: 'wide', mouth: 'o', lash: HANG2 });
add({ tilt: 2, eyes: 'open', mouth: 'flat', look: -0.5, lash: HANG });
add({ eyes: 'open', mouth: 'smile', lash: HANG });
// angry 32-37: flicks the lash overhead, steaming
[OVER, UP, OVER, UP, [[-10, -18], [-24, -36], [-20, -56], [-4, -64], [12, -56]], OVER].forEach((lash, i) => add({ tilt: i % 2 ? 3 : -3, sx: 1.02, sy: 0.98, eyes: 'angry', mouth: i % 2 ? 'grit' : 'flat', lash, fx: i % 2 ? puff(52, 18, 0.55) : puff(108, 16, 0.5) }));
// punch 38-55: wind-up, CRACK, recoil, second crack, settle
const punch = [
  { tilt: -6, eyes: 'angry', mouth: 'grit', lash: OVER },
  { tilt: -9, sx: 0.97, sy: 1.03, eyes: 'angry', mouth: 'grit', lash: [[-14, -14], [-34, -16], [-54, -6], [-64, 10], [-70, 26]] },
  { tilt: -11, eyes: 'angry', mouth: 'grit', lash: [[-12, -20], [-26, -40], [-18, -60], [0, -66], [16, -62]] },
  { tilt: -4, eyes: 'angry', mouth: 'grin', lash: [[4, -22], [14, -44], [32, -52], [50, -46], [62, -34]] },
  { tilt: 6, eyes: 'angry', mouth: 'grin', lash: [[16, -12], [36, -20], [54, -20], [68, -14]], fx: speed(150, 10) },
  { tilt: 8, sx: 1.04, sy: 0.96, eyes: 'angry', mouth: 'grin', lash: FWD, fx: burst(150, 14) },
  { tilt: 8, eyes: 'happy', mouth: 'grin', lash: FWD, fx: burst(150, 14, 1.25) + star(132, 44, 0.55, 20) },
  { tilt: 6, eyes: 'happy', mouth: 'grin', lash: [[18, -4], [36, 0], [54, 6], [68, 14]], fx: star(140, 40, 0.7, 10) },
  { tilt: 3, eyes: 'open', mouth: 'grin', lash: FWD_LOW },
  { tilt: -2, eyes: 'angry', mouth: 'grit', lash: [[-10, -14], [-28, -22], [-46, -16], [-58, 0], [-62, 18]] },
  { tilt: -7, eyes: 'angry', mouth: 'grit', lash: [[-10, -20], [-22, -40], [-12, -58], [6, -64], [22, -58]] },
  { tilt: 2, eyes: 'angry', mouth: 'grin', lash: [[12, -18], [28, -34], [46, -38], [62, -30]] },
  { tilt: 8, sx: 1.04, sy: 0.96, eyes: 'angry', mouth: 'grin', lash: FWD, fx: burst(150, 14) + speed(140, 32, 2) },
  { tilt: 7, eyes: 'happy', mouth: 'grin', lash: FWD, fx: burst(150, 14, 1.2) },
  { tilt: 5, eyes: 'happy', mouth: 'grin', lash: [[18, -2], [36, 4], [52, 12], [64, 22]], fx: star(144, 36, 0.6, -15) },
  { tilt: 2, eyes: 'happy', mouth: 'smile', lash: [[18, 2], [36, 14], [48, 34], [58, 58], [70, 80]] },
  { tilt: 0, eyes: 'open', mouth: 'smile', lash: HANG3 },
  { eyes: 'open', mouth: 'smile', lash: HANG }
];
punch.forEach(add);
// heavy 56-65: the big overhead crack
const heavy = [
  { y: 128, tilt: -5, sx: 0.96, sy: 1.05, eyes: 'angry', mouth: 'grit', lash: UP },
  { y: 122, tilt: -8, sx: 0.94, sy: 1.08, eyes: 'angry', mouth: 'grit', lash: [[-4, -24], [-6, -50], [8, -66], [28, -64], [40, -52]] },
  { y: 118, tilt: -6, eyes: 'angry', mouth: 'grin', lash: [[2, -26], [12, -52], [34, -64], [56, -56], [70, -40]] },
  { y: 124, tilt: 6, eyes: 'angry', mouth: 'grin', lash: [[14, -16], [34, -30], [54, -30], [70, -20]], fx: speed(150, 6, 3, 18) },
  { y: 130, tilt: 10, sx: 1.1, sy: 0.9, eyes: 'closed', mouth: 'grin', lash: [[18, -4], [38, 4], [56, 14], [70, 26]], fx: burst(148, 58, 1.4) + puff(150, 112, 0.6) },
  { tilt: 9, sx: 1.06, sy: 0.94, eyes: 'happy', mouth: 'grin', lash: [[18, -2], [38, 8], [54, 20], [68, 32]], fx: burst(148, 58, 1.1) + star(126, 30, 0.6, 15) },
  { tilt: 6, eyes: 'happy', mouth: 'grin', lash: FWD_LOW, fx: star(138, 26, 0.7, -10) },
  { tilt: 3, eyes: 'open', mouth: 'grin', lash: [[18, 2], [34, 16], [46, 36], [56, 60], [66, 82]] },
  { tilt: 1, eyes: 'open', mouth: 'smile', lash: HANG3 },
  { eyes: 'open', mouth: 'smile', lash: HANG }
];
heavy.forEach(add);
// grab 66-71: the lash reaches out low and loops round the word
const grabLash = [
  [[16, -2], [30, 10], [42, 28], [52, 48]],
  [[18, 0], [36, 14], [52, 32], [64, 52], [72, 66]],
  [[18, 2], [38, 18], [56, 38], [70, 58], [78, 72]],
  [[18, 2], [36, 16], [52, 34], [62, 50], [72, 60]],
  [[16, 0], [32, 12], [44, 26], [54, 40], [64, 48]],
  [[14, -2], [28, 8], [40, 22], [50, 34], [60, 42]]
];
grabLash.forEach((lash, i) => add({ tilt: [3, 6, 8, 6, 4, 2][i], eyes: i < 3 ? 'open' : 'happy', mouth: i < 3 ? 'o' : 'grin', look: 1, lash }));
// carry 72-79: hops along, the word swinging from the lash
hop.forEach((h, i) => add({ y: 130 - h, sx: squash[i][0], sy: squash[i][1], tilt: 3, eyes: i === 6 ? 'closed' : 'happy', mouth: 'grin', look: 0.8,
  lash: [[14, -2], [28, 8], [40, 22], [50, 34 + (i % 2) * 3], [60, 42 + (i % 2) * 3]], fx: i === 6 ? puff(52, 132, 0.6) : '' }));
// throw 80-87: winds the word back, then flings it forward (released at frame 84)
const throwLash = [
  [[14, -6], [28, -16], [38, -30], [42, -46]],
  [[4, -20], [0, -40], [-12, -52], [-26, -54]],
  [[-8, -18], [-24, -32], [-40, -38], [-54, -36]],
  [[6, -22], [20, -40], [38, -48], [54, -44]],
  [[16, -12], [36, -18], [54, -16], [68, -8]],
  [[18, -4], [36, 0], [52, 6], [66, 14]],
  [[18, 2], [34, 14], [46, 32], [54, 54], [64, 74]],
  HANG3
];
throwLash.forEach((lash, i) => add({ tilt: [0, -6, -9, -2, 8, 7, 3, 0][i], sx: i === 4 ? 1.04 : 1, sy: i === 4 ? 0.96 : 1, eyes: i < 3 ? 'angry' : i < 6 ? 'happy' : 'open', mouth: i < 3 ? 'grit' : 'grin', lash, fx: i === 4 ? speed(150, 14) : '' }));
// celebrate 88-95: jumps and twirls the lash overhead, sparkling
const twirl = [UP, [[6, -22], [18, -42], [6, -60], [-14, -60], [-24, -44]], [[-8, -20], [-24, -34], [-24, -54], [-6, -66], [14, -60]],
  [[8, -22], [26, -34], [34, -54], [20, -68], [0, -66]], UP, [[6, -22], [18, -42], [6, -60], [-14, -60], [-24, -44]], [[-8, -20], [-24, -34], [-24, -54], [-6, -66], [14, -60]], HANG];
const jump = [0, 7, 13, 16, 13, 7, 0, 0];
twirl.forEach((lash, i) => add({ y: 130 - jump[i], sx: i === 6 ? 1.08 : 1, sy: i === 6 ? 0.92 : 1, tilt: [0, -4, 4, -4, 4, -2, 0, 0][i], eyes: i === 7 ? 'open' : 'happy', mouth: 'grin', lash,
  fx: i > 0 && i < 7 ? sparkle(22 + (i * 23) % 116, 20 + (i * 37) % 50, 0.8) + sparkle(136 - (i * 31) % 110, 34 + (i * 17) % 40, 0.6) : '' }));

if (frames.length !== 96) throw new Error(`expected 96 frames, have ${frames.length}`);

const ms = {
  spawn: [130, 110, 100, 140], idle: [600, 200, 220, 650], look: [90, 100, 330, 200], walk: Array(8).fill(95), held: [100, 100, 160, 200],
  landing: [70, 100, 130, 170], poke: [90, 120, 300, 360], angry: [140, 150, 140, 150, 150, 150], punch: [110, 90, 90, 60, 50, 70, 120, 90, 90, 90, 80, 60, 50, 70, 120, 110, 120, 125],
  heavy: [140, 120, 110, 60, 110, 150, 150, 140, 150, 160], grab: [130, 120, 140, 160, 150, 140], carry: Array(8).fill(110), throw: [150, 140, 140, 70, 160, 160, 160, 170],
  celebrate: [140, 140, 150, 160, 150, 150, 160, 170]
};
const order = ['spawn', 'idle', 'look', 'walk', 'held', 'landing', 'poke', 'angry', 'punch', 'heavy', 'grab', 'carry', 'throw', 'celebrate'];
const animations = {};
let index = 0;
for (const name of order) {
  const n = ms[name].length;
  animations[name] = { frames: Array.from({ length: n }, (_, i) => index + i), ms: ms[name], loop: ['idle', 'walk', 'carry'].includes(name) };
  index += n;
}
// The word sits at the lash tip while grabbed, carried and wound up for the throw.
const tipOf = (f) => lashTip(f).map(Math.round);
const hands = {};
for (let f = 69; f <= 84; f++) { const [x, y] = tipOf(frames[f]); hands[String(f)] = [Math.max(8, Math.min(152, x)), Math.max(8, Math.min(152, y + 10)), 1]; }
module.exports = { frames, frame, manifest: { version: 1, image: 'atlas.png', width: 1280, height: 1920, columns: 8, cellWidth: 160, cellHeight: 160, frameCount: 96, anchor: [80, 136], hands, animations } };
