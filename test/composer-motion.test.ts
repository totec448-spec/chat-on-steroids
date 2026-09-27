import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installComposerHeightMotion } from '../src/renderer/composer-motion.js';

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
