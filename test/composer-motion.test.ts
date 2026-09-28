import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installComposerDockMotion, installComposerHeightMotion } from '../src/renderer/composer-motion.js';

type PendingAnimation = {
  animation: Animation;
  finish: () => void;
  cancel: ReturnType<typeof vi.fn>;
};

describe('composer height motion', () => {
  let dom: JSDOM;
  let composer: HTMLElement;
  let height: number;
  let resize: (() => void) | null;
  let animations: PendingAnimation[];
  let reduced: boolean;

  beforeEach(() => {
    dom = new JSDOM('<form id="composer"></form>', { pretendToBeVisual: true });
    composer = dom.window.document.getElementById('composer')!;
    height = 80;
    resize = null;
    animations = [];
    reduced = false;
    Object.defineProperty(composer, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 600, bottom: height, width: 600, height, toJSON: () => ({}) })
    });
    Object.defineProperty(dom.window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })
    });
    Object.defineProperty(composer, 'animate', {
      configurable: true,
      value: vi.fn(() => {
        let finish!: () => void;
        const finished = new Promise<void>(resolve => { finish = resolve; });
        const cancel = vi.fn();
        const animation = { finished, cancel } as unknown as Animation;
        animations.push({ animation, finish, cancel });
        return animation;
      })
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resize = () => callback([], this as unknown as ResizeObserver); }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    });
  });

  afterEach(() => {
    dom.window.close();
    vi.unstubAllGlobals();
  });

  const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

  it('animates between native composer heights and releases height back to CSS', async () => {
    const dispose = installComposerHeightMotion(composer);
    resize!();
    height = 128;
    resize!();

    expect(composer.animate).toHaveBeenCalledWith(
      [{ height: '80px' }, { height: '128px' }],
      { duration: 220, easing: 'cubic-bezier(.16, 1, .3, 1)' }
    );
    expect(composer.classList.contains('is-resizing')).toBe(true);

    animations[0]!.finish();
    await flush();
    expect(composer.classList.contains('is-resizing')).toBe(false);
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    dispose();
  });

  it('converges to content added while an earlier resize is in flight', async () => {
    installComposerHeightMotion(composer);
    resize!();
    height = 112;
    resize!();
    height = 164;
    resize!();
    expect(animations).toHaveLength(1);

    animations[0]!.finish();
    await flush();
    expect(animations).toHaveLength(2);
    expect(composer.animate).toHaveBeenLastCalledWith(
      [{ height: '112px' }, { height: '164px' }],
      { duration: 220, easing: 'cubic-bezier(.16, 1, .3, 1)' }
    );
  });

  it('establishes a fresh baseline after a hidden view instead of animating stale geometry', () => {
    installComposerHeightMotion(composer);
    resize!();
    composer.hidden = true;
    height = 0;
    resize!();
    composer.hidden = false;
    height = 142;
    resize!();
    expect(composer.animate).not.toHaveBeenCalled();
  });

  it('keeps reduced-motion resizing immediate', () => {
    reduced = true;
    installComposerHeightMotion(composer);
    resize!();
    height = 128;
    resize!();
    expect(composer.animate).not.toHaveBeenCalled();
    expect(composer.classList.contains('is-resizing')).toBe(false);
  });
});

describe('composer dock motion', () => {
  let dom: JSDOM, dock: HTMLElement, body: HTMLElement;
  let height: number, paintedHeight: number, resize: () => void;
  let animations: PendingAnimation[];
  let reduced: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
  let observe: ReturnType<typeof vi.fn>, disconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dom = new JSDOM('<style>#dock { border: 0; }</style><div id="dock"><div class="composer-dock-body"></div></div>');
    dock = dom.window.document.getElementById('dock')!;
    body = dock.firstElementChild as HTMLElement;
    height = 0; paintedHeight = 0; animations = [];
    reduced = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    Object.defineProperty(dom.window, 'matchMedia', { value: () => reduced });
    body.getBoundingClientRect = () => ({ height } as DOMRect);
    dock.getBoundingClientRect = () => ({ height: paintedHeight } as DOMRect);
    dock.animate = vi.fn(() => {
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      const cancel = vi.fn();
      const animation = { finished, cancel } as unknown as Animation;
      animations.push({ animation, finish, cancel });
      return animation;
    });
    observe = vi.fn(); disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe = observe;
      disconnect = disconnect;
    });
  });
  afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
  const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

  it('measures only natural content and releases the borrowed height after entering and leaving', async () => {
    installComposerDockMotion(dock); resize();
    expect(observe).toHaveBeenCalledWith(body);
    height = 76; resize();
    expect(dock.animate).toHaveBeenLastCalledWith([{ height: '0px' }, { height: '76px' }],
      { duration: 220, easing: 'cubic-bezier(.16, 1, .3, 1)' });
    animations[0]!.finish(); await flush();
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    height = 0; resize();
    expect(dock.animate).toHaveBeenLastCalledWith([{ height: '76px' }, { height: '0px' }], expect.anything());
    animations[1]!.finish(); await flush();
    expect(animations[1]!.cancel).toHaveBeenCalledOnce();
    expect(dock.style.height).toBe('');
    expect(dock.style.length).toBe(0);
  });

  it('retargets from the painted height and ignores an old completion', async () => {
    installComposerDockMotion(dock);
    height = 76; resize();
    paintedHeight = 30; height = 120; resize();
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(dock.animate).toHaveBeenLastCalledWith([{ height: '30px' }, { height: '120px' }], expect.anything());
    animations[0]!.finish(); await flush();
    expect(animations[1]!.cancel).not.toHaveBeenCalled();
  });

  it('leaves native plan collapse and its final removal in charge, without animating siblings twice', () => {
    installComposerDockMotion(dock);
    body.innerHTML = '<details class="agent-plan-shell" data-complete="true"></details><div>Queue</div>';
    height = 90; resize(); height = 55; resize(); height = 39; resize();
    body.firstElementChild!.remove(); height = 38; resize();
    expect(dock.animate).not.toHaveBeenCalled();
  });

  it('still animates the next panel when zero-height plan removal produced no resize delivery', () => {
    installComposerDockMotion(dock);
    body.innerHTML = '<details class="agent-plan-shell" data-complete="true"></details>';
    height = 40; resize(); height = 0; resize();
    body.replaceChildren(); // Same size: ResizeObserver need not run here.
    body.innerHTML = '<div>New queue</div>'; height = 76; resize();
    expect(dock.animate).toHaveBeenCalledOnce();
    expect(dock.animate).toHaveBeenLastCalledWith([{ height: '0px' }, { height: '76px' }], expect.anything());
  });

  it('cancels on hiding and on disposal without touching child animation owners', async () => {
    const dispose = installComposerDockMotion(dock);
    height = 76; resize(); dock.hidden = true; height = 0; resize();
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    dock.hidden = false; height = 40; resize();
    dispose(); animations[1]!.finish(); await flush();
    expect(animations[1]!.cancel).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    height = 99; resize(); expect(animations).toHaveLength(2);
  });

  it('honors reduced motion, including a preference changed during animation', () => {
    const dispose = installComposerDockMotion(dock);
    height = 76; resize(); reduced.matches = true;
    reduced.addEventListener.mock.calls[0]![1]();
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    height = 0; resize(); expect(animations).toHaveLength(1);
    dispose(); expect(reduced.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
