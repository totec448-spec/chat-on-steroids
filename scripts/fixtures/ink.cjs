// Where drawn pixels sit inside an element, measured on real pixels: a box can be centered while its
// glyph is not. Insets are CSS px from the element's inner edges to the first drawn pixel on each side.
const assert = require('node:assert/strict');

async function inkInsets(win, js, element) {
  // Settings scroll smoothly; the rect is read only after an instant scroll has landed.
  await js(`${element}.scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const box = await js(`(() => { const el = ${element}, r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return { x: r.left, y: r.top, width: r.width, height: r.height, border: parseFloat(s.borderTopWidth) || 0,
      round: parseFloat(s.borderTopLeftRadius) >= r.width / 2 - 1 }; })()`);
  const rect = { x: Math.floor(box.x), y: Math.floor(box.y) };
  rect.width = Math.ceil(box.x + box.width) - rect.x; rect.height = Math.ceil(box.y + box.height) - rect.y;
  const image = await win.webContents.capturePage(rect);
  // The capture is in device pixels while its reported scale factor can stay 1.
  const { width, height } = image.getSize(), bitmap = image.toBitmap(), scale = width / rect.width;
  const at = (x, y) => { const i = (y * width + x) * 4; return [bitmap[i], bitmap[i + 1], bitmap[i + 2]]; };
  // Inside the border; a round element is read inside its circle so the edge never counts as ink.
  const left = (box.x - rect.x + box.border + 1) * scale, top = (box.y - rect.y + box.border + 1) * scale;
  const right = (box.x - rect.x + box.width - box.border - 1) * scale, bottom = (box.y - rect.y + box.height - box.border - 1) * scale;
  const cx = (left + right) / 2, cy = (top + bottom) / 2, radius = (right - left) / 2;
  const inside = (x, y) => !box.round || (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius ** 2;
  const counts = new Map();
  for (let y = Math.ceil(top); y < bottom; y++) for (let x = Math.ceil(left); x < right; x++) if (inside(x, y)) {
    const key = at(x, y).join(); counts.set(key, (counts.get(key) || 0) + 1);
  }
  const fill = [...counts].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
  const diff = (x, y) => at(x, y).reduce((sum, value, i) => sum + Math.abs(value - fill[i]), 0);
  let strongest = 0;
  for (let y = Math.ceil(top); y < bottom; y++) for (let x = Math.ceil(left); x < right; x++) if (inside(x, y)) strongest = Math.max(strongest, diff(x, y));
  const threshold = Math.max(36, strongest * 0.4), ink = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (let y = Math.ceil(top); y < bottom; y++) for (let x = Math.ceil(left); x < right; x++) if (inside(x, y) && diff(x, y) > threshold) {
    ink.left = Math.min(ink.left, x); ink.right = Math.max(ink.right, x + 1); ink.top = Math.min(ink.top, y); ink.bottom = Math.max(ink.bottom, y + 1);
  }
  assert.ok(Number.isFinite(ink.left), 'Something is drawn in ' + element);
  return { left: (ink.left - left) / scale, right: (right - ink.right) / scale, top: (ink.top - top) / scale, bottom: (bottom - ink.bottom) / scale };
}

/** Round, icon-only controls inside a root (no text of their own), as an expression list. */
const ROUND_ICON_BADGES = `(root => [...root.querySelectorAll('*')].filter(el => {
  if (!el.checkVisibility() || el.textContent.trim()) return false;
  const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  return r.width >= 14 && r.width <= 72 && Math.abs(r.width - r.height) < 1 && parseFloat(s.borderTopLeftRadius) >= r.width / 2 - 1
    && (s.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(s.borderTopWidth) > 0) && !!el.querySelector('.ph, svg');
}))`;

module.exports = { inkInsets, ROUND_ICON_BADGES };
