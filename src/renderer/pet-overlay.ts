import './icons.css';
import type {
  PetAnimationManifest,
  PetLibraryState,
  PetOverlayBounds,
  PetOverlayHitRegion,
  PetOverlayPointer,
  PetOverlaySnapshot,
  PetRecord
} from '../shared/pets.js';
import type { PetOverlayApi } from '../preload/pet-overlay.js';
import { applyAppearance } from './appearance.js';
import { carriedText, thrownText, throwRelease } from './pet-choreography.js';
import { PetMachine } from './pet-machine.js';
import bundledManifestJson from './pet-assets/animations.json';

declare global { interface Window { petApi: PetOverlayApi; } }

interface PetView {
  record: PetRecord;
  manifest: PetAnimationManifest;
  machine: PetMachine;
  shell: HTMLElement;
  body: HTMLElement;
  props: HTMLElement;
  badge: HTMLButtonElement;
  target: HTMLSpanElement | null;
  bin: HTMLSpanElement | null;
  spark: HTMLSpanElement | null;
  propScene: object | null;
  targetWidth: number;
}

const api = window.petApi;
const stage = document.getElementById('petStage') as HTMLElement;
const tray = document.getElementById('petTray') as HTMLElement;
const trayCount = document.getElementById('petTrayCount') as HTMLElement;
const trayClose = document.getElementById('petTrayClose') as HTMLButtonElement;
const cards = document.getElementById('petCards') as HTMLElement;
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
const bundledManifest = bundledManifestJson as unknown as PetAnimationManifest;
const bundledAtlas = new URL('./pet-assets/atlas-desktop.png', import.meta.url).href;
const PET_SIZE = 160;
const INTERACTION_PAD = 42;

let library: PetLibraryState = { pets: [] };
let snapshot: PetOverlaySnapshot | null = null;
let bounds: PetOverlayBounds = { width: innerWidth, height: innerHeight, scaleFactor: devicePixelRatio };
let pointer: PetOverlayPointer = { x: -1000, y: -1000 };
let interactive = false;
let interactiveSignature = '';
let trayOpen = false;
let trayAnchorId: string | null = null;
let menuTargetId: string | null = null;
let disposed = false;
let raf = 0;
let timer = 0;
let lastUpdateAt: number | null = null;
const views = new Map<string, PetView>();
const loading = new Map<string, symbol>();

const menu = document.createElement('div');
menu.className = 'pet-menu';
menu.hidden = true;
document.body.append(menu);

function enabledPets(): PetRecord[] {
  const dismissed = new Set(snapshot?.dismissedPetIds ?? []);
  return library.pets.filter(pet => pet.enabled && !dismissed.has(pet.id));
}
function positionKey(id: string): string { return `cos.ui.petDesktop.${id}.v1`; }

function clampPosition(next: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(Math.max(4, Math.min(Math.max(4, bounds.width - PET_SIZE - 4), next.x))),
    y: Math.round(Math.max(4, Math.min(Math.max(4, bounds.height - PET_SIZE - 4), next.y)))
  };
}

function initialPosition(id: string, slot: number): { x: number; y: number } {
  try {
    const value = JSON.parse(localStorage.getItem(positionKey(id)) ?? 'null') as { x?: unknown; y?: unknown } | null;
    if (value && typeof value.x === 'number' && Number.isFinite(value.x) && typeof value.y === 'number' && Number.isFinite(value.y)) {
      return clampPosition({ x: value.x, y: value.y });
    }
  } catch { /* optional UI preference */ }
  return clampPosition({
    x: bounds.width - PET_SIZE - 44 - (slot % 4) * 46,
    y: bounds.height - PET_SIZE - 52 - Math.floor(slot / 4) * 46
  });
}

function persistPosition(view: PetView): void {
  try { localStorage.setItem(positionKey(view.record.id), JSON.stringify(view.machine.position)); } catch { /* optional UI preference */ }
}

function place(el: HTMLElement, x: number, y: number, extra = ''): void {
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) ${extra}`;
}

function clearProps(view: PetView): void {
  view.props.replaceChildren();
  view.target = null;
  view.bin = null;
  view.spark = null;
  view.propScene = null;
  view.targetWidth = 0;
}

function paintProps(view: PetView): void {
  const { machine, manifest } = view;
  const scene = machine.scene;
  if (!scene) { if (view.propScene) clearProps(view); return; }
  if (view.propScene !== scene) {
    clearProps(view);
    view.propScene = scene;
    view.target = document.createElement('span');
    view.target.className = 'pet-target';
    view.props.append(view.target);
    view.spark = document.createElement('span');
    view.spark.className = 'pet-hit';
    view.props.append(view.spark);
    if (scene.kind === 'anthropic') {
      view.bin = document.createElement('span');
      view.bin.className = 'pet-bin';
      view.bin.setAttribute('aria-hidden', 'true');
      view.props.append(view.bin);
    }
  }
  const frame = machine.frame, dir = scene.facing;
  const label = scene.kind === 'openai'
    ? (machine.state === 'celebrate' || machine.state === 'heavy' && frame >= 61 ? 'ClosedAI' : 'OpenAI')
    : 'Anthropic';
  if (view.target!.textContent !== label) {
    view.target!.textContent = label;
    view.targetWidth = view.target!.offsetWidth;
  }
  view.target!.hidden = false;
  view.spark!.hidden = true;
  let x = scene.target.x, y = scene.target.y, rotation = 0, scale = 1;
  if (scene.kind === 'openai') {
    const hit = machine.state === 'punch' && [40, 46, 52].includes(frame) || machine.state === 'heavy' && frame === 61;
    view.spark!.hidden = !hit;
    place(view.spark!, x - dir * 25, y - 8, `scale(${frame === 61 ? 1.5 : 1})`);
    if (hit) { x += dir * 7; rotation = dir * 8; }
  } else if (view.bin) {
    place(view.bin, scene.bin.x - 16, scene.bin.y - 48);
    view.bin.classList.toggle('is-open', machine.state === 'throw');
    if (machine.state === 'grab' && frame >= 69 || machine.state === 'carry') {
      const hand = carriedText(machine.state as 'grab' | 'carry', machine.elapsed, view.targetWidth, manifest);
      const attachedX = machine.position.x + 80 + dir * (hand.x - 80);
      const attachedY = machine.position.y + hand.y;
      const blend = machine.state === 'grab' ? Math.min(1, Math.max(0, (machine.elapsed - 370) / 320)) : 1;
      x += (attachedX - x) * blend;
      y += (attachedY - y) * blend;
    }
    if (machine.state === 'throw') {
      const release = throwRelease(manifest);
      const flight = thrownText(machine.position, dir, machine.elapsed, view.targetWidth, scene.bin, manifest);
      x = flight.x; y = flight.y;
      if (machine.elapsed < release) {
        const hand = carriedText('throw', machine.elapsed, view.targetWidth, manifest);
        x = machine.position.x + 80 + dir * (hand.x - 80);
        y = machine.position.y + hand.y;
      }
      rotation = dir * flight.progress * 100;
      scale = 1 - flight.progress * .7;
      view.target!.hidden = flight.progress >= 1;
      view.bin.classList.toggle('is-hit', flight.progress >= 1 && machine.elapsed < release + 830);
    }
    if (machine.state === 'celebrate') {
      view.target!.hidden = true;
      view.bin.classList.remove('is-hit');
    }
  }
  place(view.target!, x, y, `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`);
}

function paintView(view: PetView): void {
  const { machine, manifest, shell, body } = view;
  shell.hidden = !machine.visible;
  if (!machine.visible) return;
  shell.style.transform = `translate3d(${machine.position.x}px, ${machine.position.y}px, 0)`;
  shell.dataset.state = machine.state;
  shell.dataset.action = machine.scene?.kind ?? '';
  const frame = machine.frame;
  const column = frame % manifest.columns;
  const row = Math.floor(frame / manifest.columns);
  shell.dataset.frame = String(frame);
  // The atlas contract is one native 160px cell per 160px body: no percentage scaling.
  body.style.backgroundPosition = `${-column * manifest.cellWidth}px ${-row * manifest.cellHeight}px`;
  body.style.setProperty('--pet-facing', String(machine.facing));
  paintProps(view);
  if (trayOpen && trayAnchorId === view.record.id) placeTray();
}

function cancelWake(): void {
  if (timer) window.clearTimeout(timer);
  if (raf) cancelAnimationFrame(raf);
  timer = 0;
  raf = 0;
}

function canAnimate(): boolean {
  return !disposed && !document.hidden && views.size > 0 && snapshot?.visible !== false;
}

function advance(now: number): void {
  const delta = lastUpdateAt === null ? 0 : Math.max(0, now - lastUpdateAt);
  lastUpdateAt = now;
  for (const view of views.values()) {
    const before = view.machine.state;
    view.machine.tick(delta);
    paintView(view);
    if (view.machine.state === 'idle' && before !== 'idle') persistPosition(view);
  }
  syncInteractiveRegions();
}

function step(now: number): void {
  raf = 0;
  if (!canAnimate()) { lastUpdateAt = null; return; }
  advance(now);
  scheduleWake();
}

function scheduleWake(): void {
  cancelWake();
  if (!canAnimate()) { lastUpdateAt = null; return; }
  lastUpdateAt ??= performance.now();
  let delay = Infinity;
  for (const view of views.values()) delay = Math.min(delay, view.machine.nextUpdateIn);
  if (!Number.isFinite(delay)) return;
  // The overlay owns one wake for every pet. Static authored frames and autonomous
  // decisions use a timer; only actual travel/prop interpolation runs per display frame.
  if (delay > 0) {
    timer = window.setTimeout(() => {
      timer = 0;
      if (canAnimate()) raf = requestAnimationFrame(step);
      else lastUpdateAt = null;
    }, delay);
  } else {
    raf = requestAnimationFrame(step);
  }
}

function reschedule(mutator?: () => void): void {
  if (canAnimate()) advance(performance.now());
  mutator?.();
  for (const view of views.values()) paintView(view);
  scheduleWake();
}

function disposeView(view: PetView): void {
  persistPosition(view);
  clearProps(view);
  view.shell.remove();
  view.props.remove();
}

function createView(record: PetRecord, atlasUrl: string, manifest: PetAnimationManifest, slot: number): PetView {
  const start = initialPosition(record.id, slot);
  const machine = new PetMachine({ ...start, visible: true }, bounds.width, bounds.height, Math.random, manifest);
  machine.setReducedMotion(motion.matches);
  const shell = document.createElement('div');
  shell.className = 'pet-shell';
  shell.dataset.petId = record.id;
  shell.dataset.state = machine.state;
  shell.tabIndex = 0;
  shell.setAttribute('aria-label', `${record.displayName} desktop pet`);
  const body = document.createElement('div');
  body.className = 'pet-body';
  body.setAttribute('aria-hidden', 'true');
  body.style.backgroundImage = `url("${atlasUrl}")`;
  body.style.backgroundSize = `${manifest.width}px ${manifest.height}px`;
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'pet-badge';
  badge.hidden = true;
  badge.textContent = '0';
  const props = document.createElement('div');
  props.className = 'pet-props';
  props.dataset.petId = record.id;
  shell.append(body, badge);
  stage.append(shell, props);
  const view: PetView = { record, manifest, machine, shell, body, props, badge, target: null, bin: null, spark: null, propScene: null, targetWidth: 0 };

  shell.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.pet-badge')) return;
    closeMenu();
    if (canAnimate()) advance(performance.now());
    if (!machine.beginPointer(event.pointerId, { x: event.clientX, y: event.clientY })) {
      scheduleWake();
      return;
    }
    shell.setPointerCapture(event.pointerId);
    shell.dataset.dragging = 'true';
    setInteractive(true);
    scheduleWake();
  });
  shell.addEventListener('pointermove', event => {
    if (machine.pointer?.id !== event.pointerId) return;
    if (canAnimate()) advance(performance.now());
    machine.movePointer(event.pointerId, { x: event.clientX, y: event.clientY });
    paintView(view);
    syncInteractiveRegions();
    scheduleWake();
  });
  shell.addEventListener('pointerup', event => {
    if (machine.pointer?.id !== event.pointerId) return;
    if (canAnimate()) advance(performance.now());
    const clicked = !machine.pointer.dragging;
    machine.endPointer(event.pointerId);
    shell.dataset.dragging = 'false';
    try { shell.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    persistPosition(view);
    paintView(view);
    updateInteraction(pointer);
    scheduleWake();
    if (clicked) api.focusOwner();
  });
  shell.addEventListener('pointercancel', event => {
    if (machine.pointer?.id !== event.pointerId) return;
    if (canAnimate()) advance(performance.now());
    machine.endPointer(event.pointerId, true);
    shell.dataset.dragging = 'false';
    persistPosition(view);
    paintView(view);
    updateInteraction(pointer);
    scheduleWake();
  });
  shell.addEventListener('contextmenu', event => {
    event.preventDefault();
    openMenu(view, event.clientX, event.clientY);
  });
  badge.addEventListener('click', event => {
    event.stopPropagation();
    trayAnchorId = record.id;
    setTray(!(trayOpen && trayAnchorId === record.id));
  });
  paintView(view);
  return view;
}

function closeMenu(): void {
  menu.hidden = true;
  menuTargetId = null;
  updateInteraction(pointer);
}

function menuButton(label: string, run: (view: PetView) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => {
    const view = menuTargetId ? views.get(menuTargetId) : null;
    closeMenu();
    if (view) reschedule(() => run(view));
  });
  return button;
}

function menuSeparator(): HTMLDivElement {
  const separator = document.createElement('div');
  separator.className = 'pet-menu-separator';
  separator.setAttribute('aria-hidden', 'true');
  return separator;
}

function openMenu(view: PetView, x: number, y: number): void {
  menuTargetId = view.record.id;
  menu.replaceChildren(
    menuButton('OpenAI → ClosedAI', target => { target.machine.startAction('openai'); }),
    menuButton('Anthropic → trash', target => { target.machine.startAction('anthropic'); }),
    menuButton('Reset position', target => { target.machine.reset(); persistPosition(target); paintView(target); }),
    menuSeparator(),
    menuButton('Hide pet', target => { api.hidePet(target.record.id); }),
    menuButton('Open pet library', () => api.openLibrary())
  );
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const width = rect.width || 176;
  const height = rect.height || 174;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, x))}px`;
  menu.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, y))}px`;
  setInteractive(true);
}

function activityAnchorId(): string | null {
  return enabledPets()
    .sort((a, b) => Number(b.favorite) - Number(a.favorite))
    .map(pet => pet.id)
    .find(id => views.has(id)) ?? null;
}

function renderBadges(): void {
  const anchor = activityAnchorId();
  const count = snapshot?.activities.length ?? 0;
  const level = snapshot?.level ?? 'idle';
  for (const [id, view] of views) {
    view.shell.dataset.level = level;
    view.badge.hidden = id !== anchor || count === 0;
    view.badge.textContent = count > 9 ? '9+' : String(count);
    view.badge.setAttribute('aria-label', `${trayOpen && trayAnchorId === id ? 'Hide' : 'Show'} task activity, ${count} ${count === 1 ? 'item' : 'items'}`);
  }
  if (!anchor || count === 0) {
    trayOpen = false;
    tray.hidden = true;
  } else if (trayOpen && trayAnchorId !== anchor) {
    trayAnchorId = anchor;
    placeTray();
  }
}

function renderCards(): void {
  const rows = snapshot?.activities ?? [];
  trayCount.textContent = `${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}`;
  cards.replaceChildren(...rows.map(activity => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pet-card';
    button.dataset.level = activity.level;
    const dot = document.createElement('i'); dot.className = 'pet-card-dot';
    const copy = document.createElement('span'); copy.className = 'pet-card-copy';
    const title = document.createElement('strong'); title.textContent = activity.title;
    const body = document.createElement('span'); body.textContent = activity.body;
    copy.append(title, body);
    button.append(dot, copy);
    if (activity.sessionId) button.addEventListener('click', () => api.openActivity(activity.sessionId!));
    else button.disabled = true;
    return button;
  }));
}

function placeTray(): void {
  if (!trayOpen || tray.hidden || !trayAnchorId) return;
  const view = views.get(trayAnchorId);
  if (!view) return;
  const width = Math.min(256, Math.max(220, bounds.width - 20));
  const estimatedHeight = Math.min(206, 32 + Math.max(1, snapshot?.activities.length ?? 1) * 34);
  const leftPreferred = view.machine.position.x - width - 14;
  const rightPreferred = view.machine.position.x + PET_SIZE + 14;
  const left = leftPreferred >= 10 ? leftPreferred : Math.min(bounds.width - width - 10, rightPreferred);
  const top = Math.min(Math.max(10, view.machine.position.y + PET_SIZE / 2 - estimatedHeight / 2), Math.max(10, bounds.height - estimatedHeight - 10));
  tray.style.left = `${Math.max(10, left)}px`;
  tray.style.top = `${top}px`;
}

function setTray(open: boolean): void {
  trayOpen = open && (snapshot?.activities.length ?? 0) > 0;
  if (trayOpen && !trayAnchorId) trayAnchorId = activityAnchorId();
  tray.hidden = !trayOpen;
  renderBadges();
  if (trayOpen) { renderCards(); placeTray(); }
  updateInteraction(pointer);
}

function rectNear(rect: DOMRect, point: PetOverlayPointer, padding = 0): boolean {
  return point.x >= rect.left - padding && point.x <= rect.right + padding && point.y >= rect.top - padding && point.y <= rect.bottom + padding;
}

function petNear(view: PetView, point: PetOverlayPointer): boolean {
  const { x, y } = view.machine.position;
  return point.x >= x - INTERACTION_PAD && point.x <= x + PET_SIZE + INTERACTION_PAD
    && point.y >= y - INTERACTION_PAD && point.y <= y + PET_SIZE + INTERACTION_PAD;
}

function hitRegion(left: number, top: number, right: number, bottom: number, padding = 0): PetOverlayHitRegion | null {
  const quantum = 8;
  const x = Math.max(0, Math.floor((left - padding) / quantum) * quantum);
  const y = Math.max(0, Math.floor((top - padding) / quantum) * quantum);
  const edgeX = Math.min(bounds.width, Math.ceil((right + padding) / quantum) * quantum);
  const edgeY = Math.min(bounds.height, Math.ceil((bottom + padding) / quantum) * quantum);
  return edgeX > x && edgeY > y ? { x, y, width: edgeX - x, height: edgeY - y } : null;
}

function elementRegion(element: HTMLElement, padding: number): PetOverlayHitRegion | null {
  if (element.hidden) return null;
  const rect = element.getBoundingClientRect();
  return hitRegion(rect.left, rect.top, rect.right, rect.bottom, padding);
}

function interactionRegions(): PetOverlayHitRegion[] {
  const regions: PetOverlayHitRegion[] = [];
  for (const view of views.values()) {
    if (!view.machine.visible) continue;
    const { x, y } = view.machine.position;
    const pet = hitRegion(x, y, x + PET_SIZE, y + PET_SIZE, INTERACTION_PAD);
    if (pet) regions.push(pet);
    for (const prop of [view.target, view.bin, view.spark]) {
      if (!prop || prop.hidden) continue;
      const region = elementRegion(prop, 8);
      if (region) regions.push(region);
    }
  }
  if (trayOpen && !tray.hidden) {
    const region = elementRegion(tray, 18);
    if (region) regions.push(region);
  }
  if (!menu.hidden) {
    const region = elementRegion(menu, 10);
    if (region) regions.push(region);
  }
  return regions;
}

function setInteractive(next: boolean): void {
  const regions = next ? interactionRegions() : [];
  const signature = JSON.stringify([next, regions]);
  if (interactive === next && interactiveSignature === signature) return;
  interactive = next;
  interactiveSignature = signature;
  api.setInteractive(next, regions);
}

function syncInteractiveRegions(): void {
  if (interactive) setInteractive(true);
}

function updateInteraction(next: PetOverlayPointer): void {
  pointer = next;
  if ([...views.values()].some(view => view.machine.pointer)) { setInteractive(true); return; }
  const nearPet = [...views.values()].some(view => petNear(view, next));
  const nearTray = trayOpen && !tray.hidden && rectNear(tray.getBoundingClientRect(), next, 18);
  const nearMenu = !menu.hidden && rectNear(menu.getBoundingClientRect(), next, 10);
  setInteractive(nearPet || nearTray || nearMenu);
}

function syncLibrary(): void {
  if (disposed || !snapshot) return;
  const active = new Map(enabledPets().map((pet, index) => [pet.id, { pet, index }]));
  for (const id of loading.keys()) if (!active.has(id)) loading.delete(id);
  for (const [id, view] of views) {
    if (!active.has(id)) { disposeView(view); views.delete(id); }
  }
  for (const [id, item] of active) {
    if (views.has(id) || loading.has(id)) continue;
    if (item.pet.kind === 'builtin') {
      views.set(id, createView(item.pet, bundledAtlas, bundledManifest, item.index));
      continue;
    }
    const token = Symbol(id);
    loading.set(id, token);
    void api.petAsset(id).then(reply => {
      if (disposed || loading.get(id) !== token) return;
      loading.delete(id);
      const current = library.pets.find(pet => pet.id === id);
      if (!reply.ok || !current?.enabled || current.kind !== 'cos' || !enabledPets().some(pet => pet.id === id)) return;
      views.set(id, createView(current, reply.data.atlasDataUrl, reply.data.manifest, item.index));
      renderBadges();
      updateInteraction(pointer);
      scheduleWake();
    });
  }
  renderBadges();
  updateInteraction(pointer);
  scheduleWake();
}

function applyLibrary(next: PetLibraryState): void {
  if (canAnimate()) advance(performance.now());
  library = next;
  syncLibrary();
}

function applySnapshot(next: PetOverlaySnapshot): void {
  if (canAnimate()) advance(performance.now());
  const previous = snapshot?.level;
  snapshot = next;
  applyAppearance(next.theme, next.appearance);
  syncLibrary();
  if (previous !== undefined && previous !== next.level) {
    for (const view of views.values()) {
      if (next.level === 'running') view.machine.react('spawn');
      else if (next.level === 'waiting') view.machine.react('look');
      else if (next.level === 'failed') view.machine.react('angry');
      else if (next.level === 'review') view.machine.react('celebrate');
    }
  }
  renderCards();
  renderBadges();
  scheduleWake();
}

api.onLibraryChanged(applyLibrary);
api.onSnapshot(applySnapshot);
api.onPointer(updateInteraction);
// Ignored transparent windows forward mouse movement on Windows/macOS. This
// keeps proximity entirely in the renderer instead of waking main every 50 ms.
document.addEventListener('mousemove', event => updateInteraction({ x: event.clientX, y: event.clientY }), { passive: true });
api.onBounds(next => {
  reschedule(() => {
    bounds = next;
    for (const view of views.values()) view.machine.resize(bounds.width, bounds.height);
  });
  placeTray();
  syncInteractiveRegions();
});

trayClose.addEventListener('click', () => setTray(false));
tray.addEventListener('pointerenter', () => setInteractive(true));
tray.addEventListener('pointerleave', () => updateInteraction(pointer));
document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node)) closeMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!menu.hidden) closeMenu();
    else if (trayOpen) setTray(false);
  }
});
motion.addEventListener('change', () => {
  reschedule(() => {
    for (const view of views.values()) view.machine.setReducedMotion(motion.matches);
  });
});
document.addEventListener('visibilitychange', () => {
  lastUpdateAt = null;
  scheduleWake();
});

void api.listPets().then(reply => { if (reply.ok && !disposed) applyLibrary(reply.data); });

window.addEventListener('pagehide', () => {
  disposed = true;
  setInteractive(false);
  loading.clear();
  cancelWake();
  for (const view of views.values()) disposeView(view);
  views.clear();
  menu.remove();
});
