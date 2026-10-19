// The Whip pet's drawing: one parametric cartoon whip (handle with a face, braided lash), one SVG per frame.
const OUT = '#3a2312', WOOD = '#d0945a', WOOD_D = '#a96a35', WOOD_L = '#ecbb85', GRIP = '#6b3e1e', GRIP_L = '#8f5a31', BRASS = '#e2b13c', BRASS_D = '#a97c1c';
const LASH = '#7b4a24', LASH_D = '#5b3317', LASH_L = '#a06636';

/** Point on a cubic bezier. */
function bez(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0], u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]];
}
/** Smooth curve through points (Catmull-Rom), sampled. */
function spline(points, steps = 10) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(j => 0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
/** A tapered braided lash through points: filled ribbon, braid ticks, a light rim and the popper. */
function lash(points, w0 = 11, w1 = 2.4) {
  const c = spline(points), n = c.length - 1, left = [], right = [], mids = [];
  for (let i = 0; i <= n; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(n, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const t = i / n, w = (w0 + (w1 - w0) * Math.pow(t, 0.7)) / 2, nx = -dy / l * w, ny = dx / l * w;
    left.push([c[i][0] + nx, c[i][1] + ny]); right.push([c[i][0] - nx, c[i][1] - ny]); mids.push({ c: c[i], nx, ny });
  }
  const pts = [...left, ...right.reverse()].map(p => p.map(v => v.toFixed(1)).join(',')).join(' ');
  let braid = '';
  for (let i = 1; i < n - 3; i += 2) { const { c: q, nx, ny } = mids[i]; braid += `<line x1="${(q[0]+nx*0.85).toFixed(1)}" y1="${(q[1]+ny*0.85).toFixed(1)}" x2="${(q[0]-nx*0.2).toFixed(1)}" y2="${(q[1]-ny*0.2).toFixed(1)}" stroke="${LASH_D}" stroke-width="1.3" stroke-linecap="round"/>`; }
  const tip = c[n], pre = c[n - 2], ang = Math.atan2(tip[1] - pre[1], tip[0] - pre[0]);
  const pop = `<path d="M${tip[0].toFixed(1)},${tip[1].toFixed(1)} q ${(Math.cos(ang)*6 - Math.sin(ang)*3).toFixed(1)},${(Math.sin(ang)*6 + Math.cos(ang)*3).toFixed(1)} ${(Math.cos(ang)*11).toFixed(1)},${(Math.sin(ang)*11).toFixed(1)}" stroke="#f1e2c0" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
  const rim = `<path d="M${mids.slice(1, n - 5).map(m => `${(m.c[0]+m.nx*0.45).toFixed(1)},${(m.c[1]+m.ny*0.45).toFixed(1)}`).join(' L')}" stroke="${LASH_L}" stroke-width="1.5" fill="none" stroke-linecap="round" opacity="0.85"/>`;
  return `<polygon points="${pts}" fill="${LASH}" stroke="${OUT}" stroke-width="2.6" stroke-linejoin="round"/>${braid}${rim}${pop}`;
}

const H = 104, K = 0.84, ROOT_Y = -H + 2;
const DEFAULT_LASH = [[16, -6], [34, 14], [40, 44], [36, 76], [52, 100], [70, 98]];
/** The lash points of a frame, kept inside the 160 px cell: only what rises above the handle is compressed. */
function fitLash(s) {
  const L = s.lash ?? DEFAULT_LASH, x = s.x ?? 80, y = s.y ?? 130, sx = s.sx ?? 1, sy = s.sy ?? 1;
  const kx = K * sx, ky = K * sy, groundY = y + 6;
  const cellY = (py) => groundY + ky * (ROOT_Y + py - 6);
  const minY = Math.min(...L.map(p => p[1]));
  const lift = minY < 0 && cellY(minY) < 5 ? ((5 - groundY) / ky + 6 - ROOT_Y) / minY : 1;
  const reach = Math.max(...L.map(p => Math.abs(p[0])));
  const spread = reach > 0 ? Math.min(1, ((x > 80 ? 160 - x : x) - 6) / (kx * reach)) : 1;
  return L.map(([px, py]) => [px * spread, py < 0 ? py * Math.min(1, lift) : py]);
}
/** Where the drawn lash ends, in cell pixels: the hand point a carried word hangs from. */
function lashTip(s) {
  const [px, py] = fitLash(s).at(-1), tilt = (s.tilt ?? 0) * Math.PI / 180, x = s.x ?? 80, y = s.y ?? 130;
  const rx = K * (s.sx ?? 1) * px, ry = K * (s.sy ?? 1) * (ROOT_Y + py - 6);
  return [x + rx * Math.cos(tilt) - ry * Math.sin(tilt), y + 6 + rx * Math.sin(tilt) + ry * Math.cos(tilt)];
}

/**
 * One frame. s: { x, y (feet), sx, sy (squash), tilt (deg), lash: [p1,p2,p3] relative to the lash root,
 * eyes: 'open'|'closed'|'wide'|'angry'|'happy', look: -1..1, mouth: 'smile'|'o'|'grin'|'grit'|'flat', fx: extra svg }
 */
function frame(s) {
  const x = s.x ?? 80, y = s.y ?? 130, sx = s.sx ?? 1, sy = s.sy ?? 1, tilt = s.tilt ?? 0, look = s.look ?? 0;
  const H = 104, W = 38, top = -H, root = [0, top + 2];
  const L = s.lash ?? [[16, -6], [34, 14], [40, 44], [36, 76], [52, 98], [70, 96]];
  const body = `
    
    <path d="M${-W/2+3},${top+10} Q${-W/2+3},${top+6} ${-W/2+8},${top+6} H${W/2-8} Q${W/2-3},${top+6} ${W/2-3},${top+10} L${W/2},-20 H${-W/2} Z" fill="${WOOD}" stroke="${OUT}" stroke-width="3.2" stroke-linejoin="round"/>
    <path d="M${-W/2+8},${top+18} L${-W/2+6},-26" stroke="${WOOD_L}" stroke-width="5" stroke-linecap="round" opacity="0.8"/>
    <path d="M${W/2-7},${top+20} L${W/2-5},-28" stroke="${WOOD_D}" stroke-width="4" stroke-linecap="round" opacity="0.45"/>
    <path d="M${-W/2-1},-38 h${W+2} v22 h${-W-2} Z" fill="${GRIP}" stroke="${OUT}" stroke-width="3" stroke-linejoin="round"/>
    ${[0,1,2,3].map(i => `<path d="M${-W/2+1},${-33+i*5.5} L${W/2-1},${-37+i*5.5}" stroke="${GRIP_L}" stroke-width="2.2" stroke-linecap="round"/>`).join('')}
    <path d="M${-W/2+3},-16 Q${-W/2+1},6 0,6 Q${W/2-1},6 ${W/2-3},-16 Z" fill="${WOOD_D}" stroke="${OUT}" stroke-width="3" stroke-linejoin="round"/>
    <ellipse cx="-6" cy="-8" rx="5" ry="2.6" fill="${WOOD_L}" opacity="0.6"/>
    <rect x="${-W/2+5}" y="${top}" width="${W-10}" height="11" rx="4" fill="${BRASS}" stroke="${OUT}" stroke-width="2.8"/>
    <line x1="${-W/2+9}" y1="${top+3.5}" x2="${-W/2+15}" y2="${top+3.5}" stroke="#fff3c4" stroke-width="2" stroke-linecap="round"/>
    <line x1="${-W/2+6}" y1="${top+8}" x2="${W/2-6}" y2="${top+8}" stroke="${BRASS_D}" stroke-width="1.6"/>`;
  const ex = 8.5, ey = top + 38;
  const pupil = (cx) => `<circle cx="${cx + look*2.6}" cy="${ey+1}" r="3.9" fill="${OUT}"/><circle cx="${cx + look*2.6 + 1.2}" cy="${ey-0.4}" r="1.2" fill="#fff"/>`;
  const eye = (cx, flip) => {
    switch (s.eyes) {
      case 'closed': return `<path d="M${cx-4.5},${ey+1} Q${cx},${ey+4} ${cx+4.5},${ey+1}" stroke="${OUT}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
      case 'happy': return `<path d="M${cx-4.5},${ey+2} Q${cx},${ey-4} ${cx+4.5},${ey+2}" stroke="${OUT}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
      case 'wide': return `<ellipse cx="${cx}" cy="${ey}" rx="5.6" ry="6.6" fill="#fff" stroke="${OUT}" stroke-width="2"/><circle cx="${cx + look*2.6}" cy="${ey}" r="2.6" fill="${OUT}"/>`;
      default: {
        const lid = s.eyes === 'angry' ? `<path d="M${cx-7},${ey-8 + (flip ? 3 : -3)} L${cx+7},${ey-8 + (flip ? -3 : 3)} L${cx+7},${ey-10} L${cx-7},${ey-10} Z" fill="${WOOD}"/><path d="M${cx-6.5},${ey-7.5 + (flip ? 3 : -3)} L${cx+6.5},${ey-7.5 + (flip ? -3 : 3)}" stroke="${OUT}" stroke-width="1.6"/>` : '';
        return `<ellipse cx="${cx}" cy="${ey}" rx="6" ry="7.2" fill="#fff" stroke="${OUT}" stroke-width="2"/>${pupil(cx)}${lid}`;
      }
    }
  };
  const brow = (cx, flip) => {
    const k = s.eyes === 'angry' ? -4 : s.eyes === 'wide' ? 0 : 0;
    const lift = s.eyes === 'wide' ? -4 : 0;
    return `<path d="M${cx-5},${ey-11 + lift + (flip ? -k : k)} L${cx+5},${ey-11 + lift + (flip ? k : -k)}" stroke="${OUT}" stroke-width="2.6" stroke-linecap="round"/>`;
  };
  const my = ey + 12;
  const mouth = {
    smile: `<path d="M-5,${my} Q0,${my+5} 5,${my}" stroke="${OUT}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,
    grin: `<path d="M-6.5,${my-1} Q0,${my+8} 6.5,${my-1} Z" fill="#7a2a1c" stroke="${OUT}" stroke-width="2.2" stroke-linejoin="round"/><path d="M-3,${my+3.5} Q0,${my+5.5} 3,${my+3.5}" stroke="#e07a5f" stroke-width="2" fill="none"/>`,
    o: `<ellipse cx="0" cy="${my+1}" rx="3.2" ry="3.8" fill="#7a2a1c" stroke="${OUT}" stroke-width="2"/>`,
    grit: `<rect x="-6" y="${my-1.5}" width="12" height="5" rx="2" fill="#fff" stroke="${OUT}" stroke-width="2"/><line x1="-2" y1="${my-1.5}" x2="-2" y2="${my+3.5}" stroke="${OUT}" stroke-width="1.2"/><line x1="2" y1="${my-1.5}" x2="2" y2="${my+3.5}" stroke="${OUT}" stroke-width="1.2"/>`,
    flat: `<line x1="-4" y1="${my+1}" x2="4" y2="${my+1}" stroke="${OUT}" stroke-width="2.4" stroke-linecap="round"/>`
  }[s.mouth ?? 'smile'];
  const cheeks = `<ellipse cx="-12" cy="${my-2}" rx="3.2" ry="2" fill="#e8846a" opacity="0.45"/><ellipse cx="12" cy="${my-2}" rx="3.2" ry="2" fill="#e8846a" opacity="0.45"/>`;
  const face = `${brow(-ex, false)}${brow(ex, true)}${eye(-ex, false)}${eye(ex, true)}${cheeks}${mouth}`;
    const fitted = fitLash(s);
  const lashSvg = lash([root, ...fitted.map(p => [root[0] + p[0], root[1] + p[1]])]);
  const behind = s.lashFront ? '' : lashSvg, front = s.lashFront ? lashSvg : '';
  const shadow = s.noShadow ? '' : `<ellipse cx="${x}" cy="136" rx="${(19 * Math.max(0.55, 1 - (130 - y) / 60)).toFixed(1)}" ry="4.5" fill="#000" opacity="${(0.16 * Math.max(0.35, 1 - (130 - y) / 50)).toFixed(2)}"/>`;
  return `${shadow}${s.fxBack ?? ''}<g transform="translate(${x},${y + 6}) rotate(${tilt}) scale(${0.84 * sx},${0.84 * sy}) translate(0,-6)">${behind}${body}${face}${front}</g>${s.fx ?? ''}`;
}
module.exports = { frame, lashTip };
