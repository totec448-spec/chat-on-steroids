/**
 * The browser driver's contract.
 *
 * The extension ships as plain JavaScript because that is what a browser loads, but the app's
 * tests and tooling are typed, and a driver that can click and type on any page is the last
 * place to leave a shape implicit.
 */

export declare class BrowserDriverError extends Error {
  code: string;
}

export declare const DRIVEN_GROUP_TITLE: string;
export declare const REFUSED_HOSTS: string[];
export declare const BROWSER_PERMISSIONS: { permissions: string[]; origins: string[] };
export declare const COLLECT_SOURCE: string;
export declare const MODIFIERS: Record<string, number>;

/** Whether browser control refuses to attach to this page at all. */
export declare function refusedUrl(url: unknown): boolean;

/** False where the browser exposes no DevTools protocol to extensions. */
export declare function browserControlSupported(): Promise<boolean>;
export declare function hasBrowserPermissions(): Promise<boolean>;
/** Must be called from a user gesture; Chrome refuses the prompt otherwise. */
export declare function requestBrowserPermissions(): Promise<boolean>;

export declare function cdpButton(name?: unknown): 'left' | 'right' | 'middle' | 'back' | 'forward';
export declare function buttonMask(name?: unknown): number;
export declare function keyDescriptor(name: string): {
  key: string;
  code?: string;
  vk: number;
  text?: string;
};

export interface BrowserSessionStatus {
  attached: boolean;
  tabId: number | null;
  url: string | null;
  title: string | null;
  /** The driven-tab group, when one is held — the blue band a person sees above the tab. */
  groupId?: number | null;
}

export interface BrowserElement {
  /** Name this in a ref action; only the newest observation's refs are addressable. */
  ref: string;
  role: string;
  name: string;
  value: string;
  disabled: boolean;
  checked: string;
  /** Centre of the element, in CSS pixels — the same space input and screenshots use. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserObservation {
  tabId: number;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scrollY: number;
  scrollHeight: number;
  elements: BrowserElement[];
  /** Base64 PNG in which one pixel is one CSS pixel, or null when not requested. */
  screenshot: { data: string; width: number; height: number } | null;
}

export type BrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' }
  | { type: 'move'; x: number; y: number; modifiers?: string[] }
  | { type: 'click' | 'double_click'; x: number; y: number; button?: string; modifiers?: string[] }
  | { type: 'drag'; path: Array<{ x: number; y: number }>; button?: string; modifiers?: string[] }
  | { type: 'scroll'; x: number; y: number; scroll_x?: number; scroll_y?: number; modifiers?: string[] }
  | { type: 'type'; text: string }
  | { type: 'keypress'; keys: string[]; modifiers?: string[] }
  | { type: 'wait'; ms?: number }
  | { type: 'click_ref'; ref: string; button?: string }
  | { type: 'set_value'; ref: string; text: string };

export declare const browserDriver: {
  status(): Promise<BrowserSessionStatus>;
  ensureAttached(openUrl?: string | null): Promise<void>;
  assertPageStillAllowed(): Promise<void>;
  attach(tabId: number): Promise<BrowserSessionStatus>;
  detach(): Promise<BrowserSessionStatus>;
  forget(tabId: number): void;
  act(action: BrowserAction): Promise<Record<string, unknown>>;
  /** Where a ref points now — refused rather than guessed when the element has gone. */
  resolveRef(ref: string): Promise<{ x: number; y: number }>;
  observe(options?: { includeScreenshot?: boolean }): Promise<BrowserObservation>;
};

export declare function installBrowserDriverLifecycle(): void;
