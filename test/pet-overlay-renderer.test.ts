import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PetLibraryState, PetOverlayBounds, PetOverlayPointer, PetOverlaySnapshot } from '../src/shared/pets.js';
import authoredManifest from '../src/renderer/pet-assets/animations.json';

let dom: JSDOM;
let rafCallbacks: Map<number, FrameRequestCallback>;
let timerCallbacks: Map<number, { callback: () => void; delay: number }>;
let nextWakeId: number;
const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

const overlayBody = `
  <div id="petStage"></div>
  <section class="pet-tray" id="petTray" hidden>
    <div class="pet-tray-head"><strong>Tasks</strong><span id="petTrayCount"></span><button id="petTrayClose">×</button></div>
    <div id="petCards"></div>
  </section>`;

beforeEach(() => {
  dom = new JSDOM(`<body>${overlayBody}</body>`, { url: 'https://pet-overlay.test', pretendToBeVisual: true });
  const w = dom.window, capture = new Set<number>();
  rafCallbacks = new Map();
  timerCallbacks = new Map();
  nextWakeId = 1;
  const media = { matches: false, addEventListener: vi.fn() };
  Object.defineProperty(w, 'matchMedia', { configurable: true, value: () => media });
  w.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const id = nextWakeId++;
    timerCallbacks.set(id, { callback: callback as () => void, delay: Number(delay ?? 0) });
    return id;
  }) as typeof w.setTimeout;
  w.clearTimeout = ((id?: number) => { if (id) timerCallbacks.delete(id); }) as typeof w.clearTimeout;
  w.HTMLElement.prototype.setPointerCapture = id => { capture.add(id); };
  w.HTMLElement.prototype.hasPointerCapture = id => capture.has(id);
  w.HTMLElement.prototype.releasePointerCapture = id => { capture.delete(id); };
  for (const [key, value] of Object.entries({
    window: w, document: w.document, localStorage: w.localStorage, innerWidth: 1000, innerHeight: 800,
    devicePixelRatio: 1, AbortController: w.AbortController,
    matchMedia: () => media,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      const id = nextWakeId++;
      rafCallbacks.set(id, callback);
      return id;
    }),
    cancelAnimationFrame: vi.fn((id: number) => { rafCallbacks.delete(id); })
  })) vi.stubGlobal(key, value);
});

afterEach(() => {
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function pointer(target: HTMLElement, type: string, x: number, y: number, id = 1): void {
  const event = new dom.window.MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(event, 'pointerId', { value: id });
  target.dispatchEvent(event);
}

async function flushOverlay(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

it('uses one spritesheet body per pet while preserving specials, multi-pet tasks, drag, and click-through', async () => {
  const library: PetLibraryState = { pets: [
    { id: 'tur-tur-sahur', displayName: 'Tur Tur Sahur', description: '', kind: 'builtin', builtin: true, enabled: true, favorite: false },
    { id: 'willow', displayName: 'Willow', description: '', kind: 'cos', enabled: true, favorite: true }
  ] };
  let snapshotListener: ((snapshot: PetOverlaySnapshot) => void) | null = null;
  let pointerListener: ((point: PetOverlayPointer) => void) | null = null;
  let boundsListener: ((bounds: PetOverlayBounds) => void) | null = null;
  const setInteractive = vi.fn(), focusOwner = vi.fn(), openActivity = vi.fn(), openLibrary = vi.fn();
  const hidePet = vi.fn();
  const petApi = {
    listPets: () => ok(library),
    petAsset: (id: string) => ok({ id, kind: 'cos' as const, atlasDataUrl: 'data:image/png;base64,YXRsYXM=', manifest: authoredManifest }),
    hidePet, setInteractive, focusOwner, openLibrary, openActivity,
    onSnapshot: (listener: (snapshot: PetOverlaySnapshot) => void) => { snapshotListener = listener; return vi.fn(); },
    onLibraryChanged: () => vi.fn(),
    onPointer: (listener: (point: PetOverlayPointer) => void) => { pointerListener = listener; return vi.fn(); },
    onBounds: (listener: (bounds: PetOverlayBounds) => void) => { boundsListener = listener; return vi.fn(); }
  };
  Object.defineProperty(dom.window, 'petApi', { configurable: true, value: petApi });
  await import('../src/renderer/pet-overlay.js');
  await flushOverlay();
  boundsListener!({ width: 1000, height: 800, scaleFactor: 1 });
  const runningSnapshot: PetOverlaySnapshot = {
    visible: true, dismissedPetIds: [], level: 'running',
    activities: [{ id: 'task-1', title: 'Prime', body: 'Working', level: 'running', sessionId: 'session-one' }],
    theme: 'dark',
    appearance: {
      light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
      dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
      font: 'system', fontSize: 14, translucentSidebar: true
    }
  };
  snapshotListener!(runningSnapshot);
  await Promise.resolve(); await Promise.resolve();

  const shells = [...dom.window.document.querySelectorAll<HTMLElement>('.pet-shell')];
  expect(shells).toHaveLength(2);
  expect(setInteractive.mock.lastCall?.[0]).toBe(false);
  expect(setInteractive.mock.lastCall?.[1]).toEqual([]);
  expect(dom.window.document.querySelectorAll('.pet-body')).toHaveLength(2);
  expect(dom.window.document.querySelector('canvas,.pet-canvas,.pet-sprite,.pet-bat')).toBeNull();
  for (const shell of shells) {
    const body = shell.querySelector<HTMLElement>('.pet-body')!;
    const frame = Number(shell.dataset.frame);
    expect(body.style.backgroundSize).toBe('1280px 1920px');
    expect(body.style.backgroundPosition).toBe(`${-(frame % 8) * 160}px ${-Math.floor(frame / 8) * 160}px`);
  }

  const badges = shells.map(shell => shell.querySelector<HTMLButtonElement>('.pet-badge')!).filter(node => !node.hidden);
  expect(badges).toHaveLength(1);
  expect((badges[0]!.closest('.pet-shell') as HTMLElement | null)?.dataset.petId).toBe('willow');
  badges[0]!.click();
  expect((dom.window.document.getElementById('petTray') as HTMLElement).hidden).toBe(false);
  (dom.window.document.querySelector('.pet-card') as HTMLButtonElement).click();
  expect(openActivity).toHaveBeenCalledWith('session-one');

  snapshotListener!({
    ...runningSnapshot,
    level: 'review',
    activities: [{ ...runningSnapshot.activities[0]!, body: 'Ready for review', level: 'review' }]
  });
  expect(dom.window.document.querySelector<HTMLElement>('.pet-shell[data-pet-id="willow"]')?.dataset.level).toBe('review');
  expect(badges[0]!.hidden).toBe(false);
  expect(badges[0]!.textContent).toBe('1');
  snapshotListener!(runningSnapshot);

  const tur = dom.window.document.querySelector<HTMLElement>('.pet-shell[data-pet-id="tur-tur-sahur"]')!;
  expect(tur.style.left).toBe('');
  expect(tur.style.top).toBe('');
  expect(tur.style.transform).toMatch(/^translate3d\(/);
  tur.dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 220, clientY: 180, bubbles: true }));
  const menuButtons = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.pet-menu button')];
  expect(menuButtons.map(button => button.textContent)).toContain('OpenAI → ClosedAI');
  expect(menuButtons.map(button => button.textContent)).toContain('Hide pet');
  menuButtons.find(button => button.textContent === 'OpenAI → ClosedAI')!.click();
  expect(tur.dataset.action).toBe('openai');
  expect(tur.dataset.state).toBe('walk');
  expect(dom.window.document.querySelector('.pet-target')?.textContent).toBe('OpenAI');

  const [, petX, petY] = tur.style.transform.match(/^translate3d\(([-\d.]+)px, ([-\d.]+)px/) ?? [];
  expect(petX).toBeDefined(); expect(petY).toBeDefined();
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('mousemove', {
    clientX: Number(petX) + 80, clientY: Number(petY) + 80, bubbles: true
  }));
  expect(setInteractive).toHaveBeenLastCalledWith(true, expect.arrayContaining([
    expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) })
  ]));
  pointer(tur, 'pointerdown', 120, 120, 7);
  pointer(tur, 'pointermove', 190, 150, 7);
  expect(tur.dataset.state).toBe('held');
  pointerListener!({ x: 700, y: 700 });
  expect(setInteractive).toHaveBeenLastCalledWith(true, expect.any(Array));
  pointer(tur, 'pointerup', 190, 150, 7);
  expect(tur.dataset.state).toBe('landing');
  expect(focusOwner).not.toHaveBeenCalled();
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('mousemove', { clientX: 700, clientY: 700, bubbles: true }));
  expect(setInteractive).toHaveBeenLastCalledWith(false, []);

  pointer(tur, 'pointerdown', 120, 120, 8);
  pointer(tur, 'pointerup', 120, 120, 8);
  expect(tur.dataset.state).toBe('poke');
  expect(focusOwner).toHaveBeenCalledOnce();

  const willow = dom.window.document.querySelector<HTMLElement>('.pet-shell[data-pet-id="willow"]')!;
  willow.dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 320, clientY: 280, bubbles: true }));
  const hide = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.pet-menu button')]
    .find(button => button.textContent === 'Hide pet')!;
  hide.click();
  expect(hidePet).toHaveBeenCalledWith('willow');
  snapshotListener!({ ...runningSnapshot, dismissedPetIds: ['willow'] });
  expect(dom.window.document.querySelectorAll('.pet-shell')).toHaveLength(1);
  expect(tur.querySelector<HTMLButtonElement>('.pet-badge')?.hidden).toBe(false);
  expect(library.pets.every(pet => pet.enabled)).toBe(true);
  snapshotListener!(runningSnapshot);
  await flushOverlay();
  expect(dom.window.document.querySelectorAll('.pet-shell')).toHaveLength(2);
  expect(dom.window.document.querySelector<HTMLButtonElement>('.pet-shell[data-pet-id="willow"] .pet-badge')?.hidden).toBe(false);
});

it('sleeps between authored deadlines and uses display frames only for continuous motion', async () => {
  const library: PetLibraryState = { pets: [
    { id: 'tur-tur-sahur', displayName: 'Tur Tur Sahur', description: '', kind: 'builtin', builtin: true, enabled: true, favorite: true }
  ] };
  let snapshotListener: ((snapshot: PetOverlaySnapshot) => void) | null = null;
  const petApi = {
    listPets: () => ok(library),
    petAsset: () => Promise.resolve({ ok: false as const, error: 'not used' }),
    hidePet: vi.fn(), setInteractive: vi.fn(), focusOwner: vi.fn(), openLibrary: vi.fn(), openActivity: vi.fn(),
    onSnapshot: (listener: (snapshot: PetOverlaySnapshot) => void) => { snapshotListener = listener; return vi.fn(); },
    onLibraryChanged: () => vi.fn(), onPointer: () => vi.fn(), onBounds: () => vi.fn()
  };
  Object.defineProperty(dom.window, 'petApi', { configurable: true, value: petApi });
  await import('../src/renderer/pet-overlay.js');
  await flushOverlay();

  snapshotListener!({
    visible: true, dismissedPetIds: [], level: 'idle', activities: [], theme: 'dark',
    appearance: {
      light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
      dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
      font: 'system', fontSize: 14, translucentSidebar: true
    }
  });

  expect(dom.window.document.querySelectorAll('.pet-shell')).toHaveLength(1);
  expect(rafCallbacks.size).toBe(0);
  expect(timerCallbacks.size).toBe(1);
  const [timerId, pending] = [...timerCallbacks.entries()][0]!;
  expect(pending.delay).toBeGreaterThan(0);
  timerCallbacks.delete(timerId);
  pending.callback();
  expect(rafCallbacks.size).toBe(1);

  const [frameId, frame] = [...rafCallbacks.entries()][0]!;
  rafCallbacks.delete(frameId);
  frame(performance.now() + pending.delay);
  expect(rafCallbacks.size).toBe(0);
  expect(timerCallbacks.size).toBe(1);

  const shell = dom.window.document.querySelector<HTMLElement>('.pet-shell')!;
  shell.dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 220, clientY: 180, bubbles: true }));
  (dom.window.document.querySelector('.pet-menu button') as HTMLButtonElement).click();
  expect(timerCallbacks.size).toBe(0);
  expect(rafCallbacks.size).toBe(1);

  const [movingId, movingFrame] = [...rafCallbacks.entries()][0]!;
  rafCallbacks.delete(movingId);
  movingFrame(performance.now() + pending.delay + 16);
  expect(rafCallbacks.size).toBe(1);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  expect(rafCallbacks.size).toBe(0);
  expect(timerCallbacks.size).toBe(0);
});
