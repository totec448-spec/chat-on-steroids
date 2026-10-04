import { el, icon } from './dom.js';
import { t, ui } from './i18n.js';
import { initToolApprovalNotice } from './tool-approval.js';

/** One place to click: a few words, and where it is on the picture as percentages of its size. */
type Spot = { text: string; box: [number, number, number, number]; pin?: 'top-left' | 'bottom-left' | 'outside-left' };
type Shot = { src: string; spots: Spot[] };

// Only reviewed, redacted captures belong here: placeholders stand in for every name, address and id.
const guides: Record<string, Shot[]> = {
  extension: [
    { src: new URL('./setup-images/browser-extensions.png', import.meta.url).href, spots: [
      { text: 'Turn on Developer mode.', box: [85, 3, 14, 18] }
    ] }
  ],
  'extension-load': [
    { src: new URL('./setup-images/browser-extensions.png', import.meta.url).href, spots: [
      { text: 'Load the extension', box: [2, 25, 12.5, 15] }
    ] }
  ],
  signin: [
    { src: new URL('./setup-images/cos-browser-sign-in.png', import.meta.url).href, spots: [
      // Two places side by side: the pins take opposite corners so neither covers the other.
      { text: 'Click Log in', box: [72, 11.7, 8.7, 10.6], pin: 'bottom-left' },
      { text: 'Green dot: the app is connected', box: [77.2, 2.6, 2.9, 5.1] }
    ] }
  ],
  'external-browser': [
    { src: new URL('./setup-images/external-browser-chatgpt.png', import.meta.url).href, spots: [
      { text: 'Review extension', box: [96.1, 2.8, 2.6, 5.1], pin: 'outside-left' },
      { text: 'Click Log in', box: [91.2, 12.1, 7.5, 11.1], pin: 'bottom-left' }
    ] }
  ],
  tunnel: [
    { src: new URL('./setup-images/tunnel-create.png', import.meta.url).href, spots: [
      { text: 'Name it', box: [3.1, 15.8, 93.8, 5.3] },
      { text: 'Pick your ChatGPT workspace', box: [3.1, 75.3, 93.8, 6.8] },
      { text: 'Click Create', box: [86.4, 92, 10.5, 5.4] }
    ] },
    { src: new URL('./setup-images/tunnel-id.png', import.meta.url).href, spots: [
      { text: 'Copy the tunnel ID', box: [92.6, 40, 5.6, 26] }
    ] }
  ],
  key: [
    { src: new URL('./setup-images/api-key-create.png', import.meta.url).href, spots: [
      { text: 'Pick your project', box: [4.4, 59, 91.1, 6.1] },
      { text: 'Choose Restricted', box: [14.4, 90.1, 20.2, 5.7] }
    ] },
    { src: new URL('./setup-images/api-key-tunnels.png', import.meta.url).href, spots: [
      { text: 'Tunnels: Read and Use', box: [51.4, 40.8, 47.4, 51] }
    ] }
  ],
  plugin: [
    { src: new URL('./setup-images/plugin-add.png', import.meta.url).href, spots: [
      { text: 'Add → Create MCP App', box: [8.7, 70.1, 82.6, 16] }
    ] },
    { src: new URL('./setup-images/plugin-new.png', import.meta.url).href, spots: [
      { text: 'Paste the name exactly', box: [3.3, 20, 93.3, 5.2] },
      { text: 'Tunnel, then yours', box: [3.3, 38.7, 93.3, 15.1] },
      { text: 'No authentication', box: [3.3, 59.4, 93.3, 5.1] },
      { text: 'Accept, then Create', box: [84.3, 92, 12.4, 5.3] }
    ] },
    // So tasks are not paused for approval: the plugin's own permissions page, in ChatGPT's words.
    { src: new URL('./setup-images/plugin-permissions.png', import.meta.url).href, spots: [
      { text: 'Permissions: Allow all tools', box: [3.1, 76.9, 93.9, 13.5] }
    ] },
    // The first tool call asks for approval; this is where the app's one-time reminder points too.
    { src: new URL('./setup-images/tool-approval.jpg', import.meta.url).href, spots: [
      { text: 'First run: Allow → Always allow', box: [85.5, 79.6, 12.2, 14.6] }
    ] }
  ],
  developer: [
    { src: new URL('./setup-images/developer-mode.png', import.meta.url).href, spots: [
      { text: 'Security and login', box: [2, 68.6, 26, 5.8] },
      { text: 'Turn Developer mode on', box: [88.8, 44.9, 5.7, 3.8] }
    ] }
  ]
};

/** A picture with its click targets marked, numbered from `first` so pins match the moves. */
function picture(shot: Shot, first: number): HTMLElement {
  const frame = el('span', 'guide-picture');
  const img = document.createElement('img');
  img.src = shot.src;
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  frame.append(img);
  shot.spots.forEach((spot, index) => {
    const [x, y, width, height] = spot.box;
    const mark = el('span', 'guide-spot');
    mark.dataset.spot = String(first + index);
    Object.assign(mark.style, { left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%` });
    const pin = el('span', 'guide-pin', String(first + index + 1));
    if (spot.pin) pin.dataset.corner = spot.pin;
    mark.append(pin);
    frame.append(mark);
  });
  return frame;
}

/**
 * The step's moves beside its pictures. Pointing at a move (or focusing it) shows the picture
 * it happens in and lights its place there; the picture itself opens full size.
 */
function guide(host: HTMLElement, shots: Shot[], enlarge: (shot: Shot, first: number) => void): void {
  const moves = el('ol', 'guide-moves');
  const stage = el('div', 'guide-stage');
  const frames: HTMLButtonElement[] = [];
  const dots = el('div', 'guide-dots');
  const firsts: number[] = [];
  let next = 0;
  for (const shot of shots) { firsts.push(next); next += shot.spots.length; }

  const show = (shotIndex: number, spot: number | null) => {
    frames.forEach((frame, index) => { frame.hidden = index !== shotIndex; });
    for (const mark of stage.querySelectorAll<HTMLElement>('.guide-spot')) {
      mark.classList.toggle('is-lit', spot !== null && Number(mark.dataset.spot) === spot);
    }
    for (const move of moves.querySelectorAll<HTMLElement>('.guide-move')) {
      move.classList.toggle('is-lit', spot !== null && Number(move.dataset.spot) === spot);
      move.classList.toggle('is-here', Number(move.dataset.shot) === shotIndex);
    }
    [...dots.children].forEach((dot, index) => dot.setAttribute('aria-pressed', String(index === shotIndex)));
    stage.classList.toggle('has-lit', spot !== null);
  };

  shots.forEach((shot, shotIndex) => {
    const frame = el('button', 'guide-frame') as HTMLButtonElement;
    frame.type = 'button';
    ui(frame, 'aria-label', () => t('Enlarge image'));
    frame.append(picture(shot, firsts[shotIndex]!), icon('i-zoom-in', 'ico guide-zoom'));
    frame.addEventListener('click', () => enlarge(shot, firsts[shotIndex]!));
    frames.push(frame);
    stage.append(frame);
    shot.spots.forEach((spot, index) => {
      const move = el('li', 'guide-move');
      move.tabIndex = 0;
      move.dataset.shot = String(shotIndex);
      move.dataset.spot = String(firsts[shotIndex]! + index);
      move.append(el('span', 'guide-pin', String(firsts[shotIndex]! + index + 1)), el('span', 'guide-move-text', () => t(spot.text)));
      const light = () => show(shotIndex, firsts[shotIndex]! + index);
      move.addEventListener('pointerenter', light);
      move.addEventListener('focus', light);
      move.addEventListener('click', light);
      moves.append(move);
    });
    if (shots.length > 1) {
      const dot = el('button', 'guide-dot') as HTMLButtonElement;
      dot.type = 'button';
      ui(dot, 'aria-label', () => t('Picture {0} of {1}', [shotIndex + 1, shots.length]));
      dot.addEventListener('click', () => show(shotIndex, null));
      dots.append(dot);
    }
  });
  moves.addEventListener('pointerleave', () => show(frames.findIndex(frame => !frame.hidden), null));
  if (shots.length > 1) stage.append(dots);
  show(0, null);
  // A step may keep its moves in its own column, apart from the pictures beside them.
  const slot = host.dataset.movesInto ? document.getElementById(host.dataset.movesInto) : null;
  if (slot) { slot.append(moves); host.append(stage); } else host.append(moves, stage);
}

/** Pictures sit small beside their moves; each opens full size, pins and all, in one dialog. */
export function initSetupGuide(): void {
  initToolApprovalNotice(window.api?.onToolApprovalNotice);
  const dialog = document.createElement('dialog');
  dialog.className = 'setup-image-dialog';
  ui(dialog, 'aria-label', () => t('Setup screenshot'));
  const close = el('button', 'btn', () => t('Close'));
  close.setAttribute('type', 'button');
  close.addEventListener('click', () => dialog.close());
  const large = el('div', 'guide-large');
  dialog.append(close, large);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => large.replaceChildren());
  document.body.append(dialog);

  const enlarge = (shot: Shot, first: number) => {
    const legend = el('ol', 'guide-moves');
    shot.spots.forEach((spot, index) => {
      const move = el('li', 'guide-move');
      move.append(el('span', 'guide-pin', String(first + index + 1)), el('span', 'guide-move-text', () => t(spot.text)));
      legend.append(move);
    });
    large.replaceChildren(picture(shot, first), legend);
    dialog.showModal();
  };
  for (const host of document.querySelectorAll<HTMLElement>('[data-setup-guide]')) {
    const shots = guides[host.dataset.setupGuide!] ?? [];
    if (shots.length) guide(host, shots, enlarge);
  }
}
