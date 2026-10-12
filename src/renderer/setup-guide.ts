import { el, icon } from './dom.js';
import { currentLanguage, onLanguageChange, t, ui, type Language } from './i18n.js';
import { quoted } from './extension-pictures.js';
import pages from './setup-images/pages/manifest.json';
import { initToolApprovalNotice } from './tool-approval.js';

/** One place to click: a few words, and where it is on the picture as percentages of its size. */
type Spot = { text: () => string; box: [number, number, number, number]; pin?: 'top-left' | 'bottom-left' | 'outside-left' };
type Shot = { src: string; spots: Spot[] };
type Box = [number, number, number, number];
type Capture = { file: string; size: [number, number]; labels: Record<string, string>; spots: Record<string, Box> };
/** A page captured by scripts/capture-setup-pages.mjs: its own words fill the move texts. */
type Page = { scene: string; spots: Array<{ key: string; text: (labels: Record<string, string>) => string; pin?: Spot['pin'] }> };
type Still = { src: string; spots: Array<{ text: string | (() => string); box: Box; pin?: Spot['pin'] }> };

const pageFiles = import.meta.glob('./setup-images/pages/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** The capture of a page in the app's language (ChatGPT's own words there), else in English. */
function capture(scene: string, language: Language = currentLanguage()): Capture | null {
  const scenes = pages as unknown as Record<string, Partial<Record<Language, Capture>>>;
  return scenes[scene]?.[language] ?? scenes[scene]?.en ?? null;
}

/** A label ChatGPT shows in the app's language, else its English one: for steps without a capture of their own. */
function label(scene: string, key: string): string {
  const scenes = pages as unknown as Record<string, Partial<Record<Language, { labels: Record<string, string> }>>>;
  return scenes[scene]?.[currentLanguage()]?.labels[key] ?? scenes[scene]!.en!.labels[key]!;
}

// Only reviewed, redacted captures belong here: placeholders stand in for every name, address and id.
// The ChatGPT and OpenAI Platform pages are re-captured with scripts/capture-setup-pages.mjs.
const guides: Record<string, Array<Page | Still>> = {
  signin: [
    { src: new URL('./setup-images/cos-browser-sign-in.png', import.meta.url).href, spots: [
      // Two places side by side: the pins take opposite corners so neither covers the other.
      { text: () => t('Click {0}', [quoted(label('signin', 'login'))]), box: [72, 11.7, 8.7, 10.6], pin: 'bottom-left' },
      { text: 'Green dot: the app is connected', box: [77.2, 2.6, 2.9, 5.1] }
    ] }
  ],
  'external-browser': [
    { src: new URL('./setup-images/external-browser-chatgpt.png', import.meta.url).href, spots: [
      { text: 'Review extension', box: [96.1, 2.8, 2.6, 5.1], pin: 'outside-left' },
      { text: () => t('Click {0}', [quoted(label('signin', 'login'))]), box: [91.2, 12.1, 7.5, 11.1], pin: 'bottom-left' }
    ] }
  ],
  tunnel: [
    { scene: 'tunnel-create', spots: [
      { key: 'name', text: () => t('Name it') },
      { key: 'workspace', text: () => t('Pick your ChatGPT workspace') },
      { key: 'create', text: labels => t('Click {0}', [quoted(labels.create!)]) }
    ] },
    { scene: 'tunnel-id', spots: [{ key: 'copy', text: () => t('Copy the tunnel ID') }] }
  ],
  key: [
    { scene: 'api-key-create', spots: [
      { key: 'project', text: () => t('Pick your project') },
      { key: 'restricted', text: labels => t('Choose {0}', [quoted(labels.restricted!)]) }
    ] },
    { scene: 'api-key-tunnels', spots: [
      { key: 'tunnels', text: labels => t('{0}: {1} and {2}', [quoted(labels.tunnels!), quoted(labels.read!), quoted(labels.use!)]) }
    ] }
  ],
  plugin: [
    { scene: 'plugin-add', spots: [{ key: 'item', text: labels => `${quoted(labels.add!)} → ${quoted(labels.item!)}` }] },
    { scene: 'plugin-new', spots: [
      { key: 'name', text: () => t('Paste the name exactly') },
      { key: 'connection', text: labels => t('{0}, then your tunnel ID', [quoted(labels.tunnel!)]) },
      { key: 'auth', text: labels => quoted(labels.noAuth!) },
      { key: 'create', text: labels => t('{0}, then {1}', [quoted(labels.consent!), quoted(labels.create!)]) }
    ] },
    // So tasks are not paused for approval: the plugin's own permissions page, where ChatGPT has one.
    { src: new URL('./setup-images/plugin-permissions.png', import.meta.url).href, spots: [
      { text: 'Where the plugin offers permissions: allow all tools', box: [3.1, 76.9, 93.9, 13.5] }
    ] },
    // The first tool call asks for approval; this is where the app's one-time reminder points too.
    { src: new URL('./setup-images/tool-approval.jpg', import.meta.url).href, spots: [
      { text: 'First tool call: allow it, always for this plugin', box: [85.5, 79.6, 12.2, 14.6] }
    ] }
  ]
};

/** The pictures and move texts of a guide in the app's current language. */
function shots(group: string): Shot[] {
  return (guides[group] ?? []).flatMap(entry => {
    if ('src' in entry) return [{ src: entry.src, spots: entry.spots.map(spot => ({ ...spot, text: typeof spot.text === 'string' ? () => t(spot.text as string) : spot.text })) }];
    const page = capture(entry.scene);
    const src = page ? pageFiles[`./setup-images/pages/${page.file}`] : undefined;
    if (!page || !src) return [];
    return [{ src, spots: entry.spots.flatMap(spot => page.spots[spot.key]
      ? [{ box: page.spots[spot.key]!, pin: spot.pin, text: () => spot.text(capture(entry.scene)?.labels ?? page.labels) }] : []) }];
  });
}

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
      move.append(el('span', 'guide-pin', String(firsts[shotIndex]! + index + 1)), el('span', 'guide-move-text', spot.text));
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
      move.append(el('span', 'guide-pin', String(first + index + 1)), el('span', 'guide-move-text', spot.text));
      legend.append(move);
    });
    large.replaceChildren(picture(shot, first), legend);
    dialog.showModal();
  };
  // Captured pages change with the language (ChatGPT's own words and screens), so the guides are
  // built again on a language change, the moves a step keeps in its own column included.
  const build = (): void => {
    for (const host of document.querySelectorAll<HTMLElement>('[data-setup-guide]')) {
      host.replaceChildren();
      const slot = host.dataset.movesInto ? document.getElementById(host.dataset.movesInto) : null;
      slot?.querySelector(':scope > .guide-moves')?.remove();
      const pictures = shots(host.dataset.setupGuide!);
      if (pictures.length) guide(host, pictures, enlarge);
    }
  };
  build();
  onLanguageChange(build);
}
