import { el } from './dom.js';
import { t, ui } from './i18n.js';

type Callout = { text: string; at: [number, number]; box: [number, number, number, number] };
type Shot = { src: string; title: string; portrait?: boolean; notes: Callout[] };

// Only reviewed, redacted assets belong here. Overlays explain clicks; they never hide secrets.
const guides: Record<string, Shot[]> = {
  tunnel: [
    { src: new URL('./setup-images/workspace.png', import.meta.url).href,
      title: 'Select the workspace you use in ChatGPT, then create the tunnel and copy its ID.', notes: [
        { text: '1 · Name your tunnel', at: [75, 16], box: [6, 18, 88.5, 5.2] },
        { text: '2 · Add a description', at: [75, 29], box: [6, 31.5, 88.5, 11.3] },
        { text: '3 · Choose your ChatGPT workspace here', at: [70, 71.5], box: [6, 74, 88.5, 19.3] }
      ] }
  ],
  key: [
    { src: new URL('./setup-images/api-key.png', import.meta.url).href, portrait: true,
      title: 'Choose Restricted, then enable Read and Use under Tunnels. Leave other permissions at None.', notes: [
        { text: '1 · Select a project', at: [82, 24], box: [3, 26, 62, 3] },
        { text: '2 · Restricted', at: [82, 37], box: [10, 39, 14, 3] },
        { text: '3 · Tunnels: Read + Use', at: [80, 80], box: [52, 86, 46, 6] }
      ] }
  ],
  developer: [
    { src: new URL('./setup-images/developer-mode.png', import.meta.url).href,
      title: 'Settings → Security and login → Developer mode. Turn the switch on.', notes: [
        { text: '1 · Security and login', at: [16, 65], box: [2, 68.6, 26, 5.8] },
        { text: '2 · Turn Developer mode on', at: [70, 36], box: [88.8, 44.9, 5.7, 3.8] }
      ] }
  ],
  plugin: [
    { src: new URL('./setup-images/plugins-page.png', import.meta.url).href,
      title: 'Open the ChatGPT Plugins page and click + at the top right.', notes: [
        { text: 'Click + to add your plugin', at: [68, 39], box: [91.3, 12.3, 4.8, 11.8] }
      ] },
    { src: new URL('./setup-images/new-plugin.png', import.meta.url).href, portrait: true,
      title: 'Copy the Core name and description below. Choose Tunnel, select your tunnel, choose No Auth, accept the notice and click Create.', notes: [
        { text: '1 · Choose Tunnel', at: [63, 36.5], box: [72.4, 39.2, 16.2, 3.5] },
        { text: '2 · Pick your tunnel', at: [64, 55], box: [12, 47, 77, 4.7] },
        { text: '3 · No Auth', at: [73, 67], box: [12, 60.8, 77, 4.7] },
        { text: '4 · Accept, then Create', at: [45, 86.5], box: [76.6, 90, 12, 4.4] }
      ] }
  ]
};

function screenshot(shot: Shot): HTMLElement {
  const figure = el('figure', 'setup-figure');
  const frame = el('div', `setup-shot${shot.portrait ? ' is-portrait' : ''}`);
  const img = document.createElement('img');
  img.src = shot.src;
  img.alt = ''; // The adjacent caption and text overlays describe the image in reading order.
  img.decoding = 'async';
  frame.append(img);
  for (const note of shot.notes) {
    const [x, y, width, height] = note.box;
    const box = el('span', 'setup-target');
    box.setAttribute('aria-hidden', 'true');
    Object.assign(box.style, { left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%` });
    const [startX, startY] = note.at;
    const down = startY < y;
    const label = el('span', 'setup-callout', () => t(note.text));
    Object.assign(label.style, {
      left: `${startX}%`, top: `${startY}%`,
      maxWidth: `${Math.min(startX, 100 - startX) * 2 - 4}%`,
      transform: `translate(-50%, ${down ? '-100%' : '0'})`
    });
    // The label's anchored edge is also the arrow's start, independent of wrapping/language.
    const endX = Math.max(x + 2, Math.min(startX, x + width - 2));
    const endY = down ? y : y + height;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'setup-arrow');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(svg.namespaceURI, 'path');
    const tipY = endY + (down ? -1.2 : 1.2);
    line.setAttribute('d', `M${startX} ${startY} L${endX} ${endY} M${endX - 0.8} ${tipY} L${endX} ${endY} L${endX + 0.8} ${tipY}`);
    svg.append(line);
    frame.append(svg, box, label);
  }
  const caption = el('figcaption');
  caption.append(el('p', '', () => t(shot.title)));
  figure.append(frame, caption);
  return figure;
}

/** All instructions stay visible together; each figure can open in a native larger view. */
export function initSetupGuide(): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'setup-image-dialog';
  ui(dialog, 'aria-label', () => t('Setup screenshot'));
  const close = el('button', 'btn', () => t('Close'));
  close.setAttribute('type', 'button');
  close.addEventListener('click', () => dialog.close());
  const large = el('div');
  dialog.append(close, large);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => large.replaceChildren());
  document.body.append(dialog);

  for (const host of document.querySelectorAll<HTMLElement>('[data-setup-guide]')) {
    const shots = guides[host.dataset.setupGuide!] ?? [];
    if (!shots.length) continue;
    const gallery = el('div', `setup-gallery${shots.length > 1 ? ' has-pair' : ''}`);
    for (const shot of shots) {
      const figure = screenshot(shot);
      const enlarge = el('button', 'btn setup-enlarge', () => t('Enlarge image'));
      enlarge.setAttribute('type', 'button');
      enlarge.addEventListener('click', () => { large.replaceChildren(screenshot(shot)); dialog.showModal(); });
      figure.querySelector('figcaption')!.append(enlarge);
      gallery.append(figure);
    }
    host.append(gallery);
  }
}
