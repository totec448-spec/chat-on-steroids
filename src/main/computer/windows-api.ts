/** Windows Window2 interface over the existing native capture/input owner. */
import { z } from 'zod';
import { WINDOWS_COMPUTER_METHODS } from '../../shared/windows-computer.js';
import { act, ComputerError, getWindowState, listDesktopApps, listWindows, type Action, type Screenshot, type UiActionName, type WindowInfo } from './index.js';

const windowSchema = z.object({ app: z.string().min(1), id: z.number().int().positive(), title: z.string().optional() });
const point = { x: z.number().finite(), y: z.number().finite() };
const wheelDelta = z.number().finite().min(-1_200_000).max(1_200_000);
const screenshotId = z.string().min(1).optional();
export const WINDOWS_API_SCHEMAS = {
  list_windows: z.object({}),
  get_window: z.object({ id: z.number().int().positive(), app: z.string().min(1).optional() }),
  list_apps: z.object({}),
  launch_app: z.object({ app: z.string().min(1).max(32768) }),
  get_window_state: z.object({ window: windowSchema, include_screenshot: z.boolean().optional(), include_text: z.boolean().optional() }),
  click: z.object({ window: windowSchema, click_count: z.number().int().min(1).max(3).optional(), element_index: z.number().int().nonnegative().optional(), mouse_button: z.enum(['left', 'right', 'middle', 'l', 'r', 'm']).optional(), screenshotId, x: point.x.optional(), y: point.y.optional() }),
  press_key: z.object({ window: windowSchema, key: z.string().min(1).max(200) }),
  type_text: z.object({ window: windowSchema, text: z.string().max(100000) }),
  scroll: z.object({ window: windowSchema, screenshotId, ...point, scrollX: wheelDelta, scrollY: wheelDelta }),
  set_value: z.object({ window: windowSchema, element_index: z.number().int().nonnegative(), value: z.string().max(100000) }),
  drag: z.object({ window: windowSchema, from_x: point.x, from_y: point.y, to_x: point.x, to_y: point.y, screenshotId }),
  perform_secondary_action: z.object({ window: windowSchema, element_index: z.number().int().nonnegative(), action: z.string().min(1).max(100) }),
  activate_window: z.object({ window: windowSchema })
} as const;
export const WINDOWS_API_METHODS = WINDOWS_COMPUTER_METHODS;
export type WindowsWindow = z.infer<typeof windowSchema>;
export interface WindowsWindowState {
  window: WindowsWindow;
  focused: boolean | null;
  accessibility: null | { tree: string; truncated: boolean | null; document_text?: string; focused_element?: string; selected_elements?: string[]; selected_text?: string };
  accessibility_error?: { code: string; message: string };
  screenshots: Array<{ id: string; url: string; width: number; height: number; originX: number; originY: number; zIndex: number }>;
}
export interface WindowsComputerBackend {
  act: typeof act;
  getWindowState: typeof getWindowState;
  listDesktopApps: typeof listDesktopApps;
  listWindows: typeof listWindows;
}
const labels: Record<UiActionName, string> = { invoke: 'Invoke', toggle: 'Toggle', select: 'Select', expand: 'Expand', collapse: 'Collapse', focus: 'Raise', scroll_up: 'Scroll Up', scroll_down: 'Scroll Down', scroll_left: 'Scroll Left', scroll_right: 'Scroll Right', scroll_into_view: 'Scroll Into View' };
type Frame = Pick<Screenshot, 'frameId' | 'width' | 'height' | 'windowId'> & { app: string };
type State = { app: string; frames: Map<string, Frame>; primary?: string; refs: Array<{ ref: string; actions: UiActionName[] }> };
function publicWindow(value: WindowInfo): WindowsWindow {
  const app = value.app || value.appUserModelId || value.processPath;
  if (!app) throw new ComputerError('WINDOW_IDENTITY_UNAVAILABLE: observe a window with an exact native app identity.');
  return { app, id: value.id, title: value.title };
}
function targetableWindows(values: WindowInfo[]): WindowsWindow[] {
  return values.filter(value => value.app || value.appUserModelId || value.processPath).map(publicWindow);
}

/** Create once per caller principal. Cached state contains no image bytes or UI text. */
export function createWindowsComputerApi(backend: WindowsComputerBackend = { act, getWindowState, listDesktopApps, listWindows }) {
  // Pending observations occupy the same bounded map. Replacing an entry fences late results.
  const states = new Map<number, { state?: State }>();
  const parse = <K extends keyof typeof WINDOWS_API_SCHEMAS>(method: K, input: unknown): z.infer<(typeof WINDOWS_API_SCHEMAS)[K]> => WINDOWS_API_SCHEMAS[method].parse(input ?? {}) as z.infer<(typeof WINDOWS_API_SCHEMAS)[K]>;
  async function current(window: WindowsWindow): Promise<void> {
    const found = publicWindow((await backend.getWindowState({ window: window.id, includeScreenshot: false, includeUi: false, includeRelated: false })).window);
    if (found.app !== window.app) throw new ComputerError('STALE_WINDOW: app identity changed; get the window again.');
  }
  function stateFor(window: WindowsWindow): State {
    const state = states.get(window.id)?.state;
    if (!state || state.app !== window.app) throw new ComputerError('STALE_WINDOW_STATE: call get_window_state before using indexes or coordinates.');
    return state;
  }
  function element(window: WindowsWindow, index: number) {
    const ref = stateFor(window).refs[index];
    if (!ref) throw new ComputerError('ELEMENT_NOT_FOUND: index is absent from the latest window state.');
    return ref;
  }
  function coordinate(window: WindowsWindow, id: string | undefined, x: number, y: number) {
    const state = stateFor(window);
    const frame = state.frames.get(id ?? state.primary ?? '');
    if (!frame || frame.windowId === null) throw new ComputerError('STALE_SCREENSHOT: screenshotId is absent from the latest window state.');
    // Point at the pixels actually returned. The native frame owner already maps
    // capture pixels to screen pixels, including resizing, DPI and popup origin.
    x = Math.round(x); y = Math.round(y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
      throw new ComputerError('COORDINATE_OUT_OF_BOUNDS: use coordinates inside the selected screenshot region.');
    }
    const opts = { frameId: frame.frameId, window: frame.windowId, app: frame.app, ...(frame.windowId === window.id ? {} : { ownerWindow: window.id, ownerApp: window.app }) };
    return { x, y, opts };
  }
  async function mutate(window: WindowsWindow | undefined, action: Action, opts?: Parameters<typeof act>[1]) {
    const expected = window ? states.get(window.id) : undefined;
    if (window) await current(window);
    if (window && states.get(window.id) !== expected) throw new ComputerError('STALE_WINDOW_STATE: observation changed before input.');
    // A submitted input consumes observation authority even if the native operation fails.
    states.clear();
    await backend.act([action], opts ?? (window ? { window: window.id, app: window.app } : {}));
  }
  return {
    target: 'windows' as const,
    async list_windows(input: unknown = {}): Promise<WindowsWindow[]> {
      parse('list_windows', input);
      return targetableWindows((await backend.listWindows()).windows);
    },
    async get_window(input: unknown): Promise<WindowsWindow> {
      const args = parse('get_window', input);
      const found = publicWindow((await backend.getWindowState({ window: args.id, includeScreenshot: false, includeUi: false, includeRelated: false })).window);
      if (args.app !== undefined && args.app !== found.app) throw new ComputerError('WINDOW_NOT_FOUND: app does not own this window.');
      return found;
    },
    async list_apps(input: unknown = {}) {
      parse('list_apps', input);
      const result = await backend.listDesktopApps({ limit: 4096 });
      if (result.truncated) throw new ComputerError('APP_LIST_TRUNCATED: native app catalog exceeded its bounded result.');
      return result.apps.map(app => ({ id: app.id, displayName: app.displayName, isRunning: app.isRunning ?? (app.windows?.length ?? 0) > 0, windows: targetableWindows(app.windows ?? []) }));
    },
    async launch_app(input: unknown): Promise<void> {
      const args = parse('launch_app', input); await mutate(undefined, { type: 'launch_app', app: args.app });
    },
    async get_window_state(input: unknown): Promise<WindowsWindowState> {
      const args = parse('get_window_state', input);
      const includeScreenshot = args.include_screenshot !== false;
      const includeUi = args.include_text === true;
      if (!includeScreenshot && !includeUi) throw new ComputerError('At least one of include_screenshot or include_text must be true.');
      const pending: { state?: State } = {};
      states.delete(args.window.id); states.set(args.window.id, pending);
      while (states.size > 32) states.delete(states.keys().next().value!);
      const result = await backend.getWindowState({ window: args.window.id, includeScreenshot, includeUi, includeRelated: includeScreenshot, maxElements: 100 });
      if (states.get(args.window.id) !== pending) throw new ComputerError('STALE_WINDOW_STATE: observation was superseded.');
      const window = publicWindow(result.window);
      if (window.app !== args.window.app) throw new ComputerError('STALE_WINDOW: app identity changed.');
      const state: State = { app: window.app, frames: new Map(), refs: result.elements.map(e => ({ ref: e.ref, actions: [...(e.actions ?? [])] })) };
      const screenshots: WindowsWindowState['screenshots'] = [];
      // EnumWindows supplies related windows from highest to lowest z-order.
      const shots = [result.screenshot, ...(result.related ?? []).map(r => r.screenshot).reverse()];
      for (const shot of shots) {
        if (!shot) continue;
        const id = `frame-${shot.frameId}`;
        const frameWindow = shot === result.screenshot ? result.window : result.related?.find(r => r.screenshot === shot)?.window;
        if (!frameWindow) throw new ComputerError('WINDOW_IDENTITY_UNAVAILABLE: screenshot has no window owner.');
        state.frames.set(id, { frameId: shot.frameId, width: shot.width, height: shot.height, windowId: shot.windowId, app: publicWindow(frameWindow).app });
        if (shot === result.screenshot) state.primary = id;
        screenshots.push({ id, url: `data:image/png;base64,${shot.data}`, width: shot.width, height: shot.height, originX: shot.region.x, originY: shot.region.y, zIndex: screenshots.length });
      }
      const lines = result.elements.map((e, i) => `${'\t'.repeat(Math.min(30, e.depth ?? 0))}${i}: ${e.role} ${JSON.stringify(e.name)}${e.actions?.length ? ` [${e.actions.map(a => labels[a]).join(', ')}]` : ''}${e.offscreen ? ' [offscreen]' : ''}${e.enabled === false ? ' [disabled]' : ''}`);
      const focusedIndex = result.elements.findIndex(e => e.ref === result.accessibility?.focusedElement || e.focused);
      const selected = lines.filter((_line, i) => result.elements[i]?.selected);
      const accessibility = !includeUi || result.uiUnavailable ? null : {
        truncated: result.uiTruncated ?? null,
        tree: lines.join('\n'),
        ...(result.accessibility?.documentText === undefined ? {} : { document_text: result.accessibility.documentText }),
        ...(focusedIndex < 0 ? {} : { focused_element: lines[focusedIndex] }),
        ...(selected.length ? { selected_elements: selected } : {}),
        ...(result.accessibility?.selectedText === undefined ? {} : { selected_text: result.accessibility.selectedText })
      };
      pending.state = state;
      // Preserve native evidence instead of hiding failed focus/text behind a
      // successful screenshot. Put pointing metadata before the longer UI tree.
      return {
        window,
        focused: result.screenshot?.focused ?? (result.window.state ? result.window.state === 'foreground' : null),
        screenshots,
        ...(includeUi && result.uiUnavailable ? { accessibility_error: result.uiUnavailable } : {}),
        accessibility
      };
    },
    async click(input: unknown): Promise<void> {
      const a = parse('click', input);
      const button = ({ l: 'left', r: 'right', m: 'middle' } as Record<string, string>)[a.mouse_button ?? 'left'] ?? a.mouse_button ?? 'left';
      if (a.element_index !== undefined) {
        if (a.x !== undefined || a.y !== undefined || a.screenshotId !== undefined) throw new ComputerError('Choose element_index or screenshot coordinates.');
        await mutate(a.window, { type: 'click_ref', ref: element(a.window, a.element_index).ref, button, count: a.click_count ?? 1 });
      } else {
        if (a.x === undefined || a.y === undefined) throw new ComputerError('Coordinate click requires x and y.');
        const p = coordinate(a.window, a.screenshotId, a.x, a.y);
        await mutate(a.window, { type: 'click', x: p.x, y: p.y, button, count: a.click_count ?? 1 }, p.opts);
      }
    },
    async press_key(input: unknown): Promise<void> {
      const a = parse('press_key', input); const keys = a.key.split('+').map(k => k.trim());
      if (keys.length > 6 || keys.some(k => !k || k.length > 20)) throw new ComputerError('Invalid key chord: use up to six key names of at most twenty characters.');
      await mutate(a.window, { type: 'keypress', keys });
    },
    async type_text(input: unknown): Promise<void> {
      const a = parse('type_text', input); await mutate(a.window, { type: /[\r\n]/.test(a.text) ? 'paste' : 'type', text: a.text });
    },
    async scroll(input: unknown): Promise<void> {
      const a = parse('scroll', input); const p = coordinate(a.window, a.screenshotId, a.x, a.y);
      await mutate(a.window, { type: 'scroll', x: p.x, y: p.y, scroll_x: Math.round(a.scrollX), scroll_y: Math.round(a.scrollY), scrollUnit: 'wheel' }, p.opts);
    },
    async set_value(input: unknown): Promise<void> {
      const a = parse('set_value', input); await mutate(a.window, { type: 'set_value', ref: element(a.window, a.element_index).ref, text: a.value });
    },
    async drag(input: unknown): Promise<void> {
      const a = parse('drag', input); const from = coordinate(a.window, a.screenshotId, a.from_x, a.from_y); const to = coordinate(a.window, a.screenshotId, a.to_x, a.to_y);
      await mutate(a.window, { type: 'drag', path: [{ x: from.x, y: from.y }, { x: to.x, y: to.y }] }, from.opts);
    },
    async perform_secondary_action(input: unknown): Promise<void> {
      const a = parse('perform_secondary_action', input); const ref = element(a.window, a.element_index);
      const action = ref.actions.find(key => labels[key].toLowerCase() === a.action.trim().toLowerCase());
      if (!action) throw new ComputerError('ACTION_UNAVAILABLE: choose an action label from the latest element.');
      await mutate(a.window, { type: 'ui_action', ref: ref.ref, action });
    },
    async activate_window(input: unknown): Promise<void> {
      const a = parse('activate_window', input); await mutate(a.window, { type: 'focus', window: a.window.id });
    }
  };
}
export type WindowsComputerApi = ReturnType<typeof createWindowsComputerApi>;
