import { JSDOM } from 'jsdom';
import type { Root } from 'react-dom/client';

export const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
export const fail = (error: string) => Promise.resolve({ ok: false as const, error });

export function installRendererDom(api: unknown): { dom: JSDOM; container: HTMLElement } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><svg id="iconSprite"></svg></body></html>', {
    url: 'https://local.test/',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  Object.defineProperty(w, 'api', { value: api, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    localStorage: w.localStorage,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    Event: w.Event,
    MouseEvent: w.MouseEvent,
    KeyboardEvent: w.KeyboardEvent,
    CustomEvent: w.CustomEvent,
    MutationObserver: w.MutationObserver,
    getComputedStyle: w.getComputedStyle.bind(w),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  if (!globalThis.crypto?.randomUUID) Object.assign(globalThis, { crypto: w.crypto });
  if (!('ResizeObserver' in globalThis)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
  }
  if (!('getAnimations' in w.Element.prototype)) {
    Object.defineProperty(w.Element.prototype, 'getAnimations', { value: () => [], configurable: true });
  }
  if (!w.requestAnimationFrame) w.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
  Object.assign(globalThis, {
    requestAnimationFrame: w.requestAnimationFrame.bind(w),
    cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
  });
  return { dom, container: w.document.getElementById('root')! };
}

export function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Native value setter is unavailable');
  setter.call(element, value);
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}

export async function flushReact(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

export async function createRendererRoot(container: HTMLElement): Promise<Root> {
  // React DOM performs DOM-capability detection when its runtime module is first evaluated.
  // Import it only after installRendererDom() has installed this test's browser globals.
  const { createRoot } = await import('react-dom/client');
  return createRoot(container);
}
