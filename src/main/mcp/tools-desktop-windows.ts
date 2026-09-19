/** Codex Window2 vocabulary backed by this app's existing native Desktop owner. */
import { z } from 'zod';
import { act, getWindowState, ComputerError } from '../computer/index.js';
import { createWindowsComputerApi, parseWindowsKeyChord, WINDOWS_API_METHODS, WINDOWS_API_SCHEMAS, type WindowsComputerApi } from '../computer/windows-api.js';
import { browserTabChord, isBrowserProcess } from '../computer/browser-chords.js';
import { currentCall, noteCount } from './call-context.js';
import { getConfig } from '../config.js';
import { requestCorrelation } from '../session/correlation.js';
import { fail, type SurfaceRegistrar, type ToolContent, type ToolResult } from './kernel.js';
import { WINDOWS_COMPUTER_READ_METHODS, WINDOWS_COMPUTER_STATE_INPUT_METHODS } from '../../shared/windows-computer.js';
import { toolDeclaration } from './tool-declarations.js';

const READ_METHODS = new Set<string>(WINDOWS_COMPUTER_READ_METHODS);
const STATE_INPUT_METHODS = new Set<string>(WINDOWS_COMPUTER_STATE_INPUT_METHODS);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024 - 64 * 1024;
// Only disposable observation indexes/geometry live here; the native frame/ref owner still
// validates generation, identity and current geometry. Explicitly allowed unattributed
// calls keep a request-scoped context; they never borrow another unresolved request's or an
// identified chat's observations. Late exact proof aliases that context to the durable session.
// No images or userData are persisted.
const contexts = new Map<string, WindowsComputerApi>();
const MAX_CONTEXTS = 32;

function apiForCaller(method: string): WindowsComputerApi {
  const call = currentCall();
  const caller = call?.caller;
  const allowUnattributed = call?.allowUnattributed ?? getConfig().multiAgent.allowUnattributedCalls;
  const principals: string[] = [];
  if (caller?.sessionId) principals.push(`session:${caller.sessionId}`);
  else if (caller?.conversationId) principals.push(`chat:${caller.conversationId}`);
  if (allowUnattributed && caller?.requestId) principals.push(`request:${caller.requestId}`);
  if (allowUnattributed && principals.length === 0) principals.push('unattributed');
  if (!principals.length) {
    contexts.delete('unattributed');
    if (STATE_INPUT_METHODS.has(method)) {
      throw new ComputerError('CALLER_IDENTITY_REQUIRED: indexed and coordinate input requires exact companion identity or Allow unattributed calls enabled in app settings; no input ran.');
    }
    // Unattributed reads/simple exact-window operations remain useful, but never publish
    // an implicit latest-observation authority that another anonymous call could consume.
    return createWindowsComputerApi();
  }
  let api: WindowsComputerApi | undefined;
  for (const principal of principals) {
    api = contexts.get(principal);
    if (api) break;
  }
  // Exact proof may land after the observation call returned. A later turn from that durable
  // session can still adopt the request-scoped observation by consulting the correlation map.
  if (!api && caller?.sessionId) {
    for (const [principal, candidate] of [...contexts.entries()].reverse()) {
      if (!principal.startsWith('request:')) continue;
      if (requestCorrelation(principal.slice('request:'.length))?.sessionId !== caller.sessionId) continue;
      api = candidate;
      break;
    }
  }
  if (!api) api = createWindowsComputerApi();
  for (const principal of principals) {
    contexts.delete(principal);
    contexts.set(principal, api);
  }
  while (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value!);
  return api;
}

const DESCRIPTIONS: Record<string, string> = {
  list_windows: 'List Windows app/window objects with current state (foreground, open or minimized). Choose one returned window before input. A minimized window needs text-only inspection or activation before a screenshot.',
  get_window: 'Resolve a returned window by id and optional app identity.',
  list_apps: 'List installed and running Windows apps with their exact owned windows.',
  launch_app: 'Launch an observed app id or explicit .exe path/name, without command arguments. Observe its window afterward.',
  get_window_state: 'Observe without activation. Images default on; include_text adds controls. query matches name/automation id; role filters type; max_elements limits matches. Search implies text. include_screenshot:false skips pixels. Use returned image coordinates.',
  click: 'Click image-pixel x/y in the selected screenshot or current element_index; supports mouse_button and click_count. Omit screenshotId for the main image. Refresh state after input.',
  press_key: 'Press a keysym-style key or chord (Control_L+s) in the exact window. The plus key accepts plus, + or Control_L++. Automatically activates its target.',
  type_text: 'Type literal text in the exact window. Multiline text uses clipboard paste and the existing clipboard-write permission.',
  scroll: 'Scroll by horizontal/vertical wheel deltas at image-pixel x/y in the selected screenshot; positive Y scrolls down.',
  set_value: 'Replace the value of an indexed editable control from the latest accessibility state.',
  drag: 'Drag smoothly between two image-pixel coordinates in the selected screenshot, then release.',
  perform_secondary_action: 'Perform an advertised accessibility action on an element_index; action labels are case-insensitive.',
  activate_window: 'Activate an exact returned window. Input methods already activate their target automatically. This consumes prior observation indexes and coordinates; get_window_state again before using them.'
};

function desktopResult(method: string, value: unknown): ToolResult {
  const content: ToolContent[] = [];
  let metadata = value;
  if (method === 'get_window_state' && value && typeof value === 'object' && 'screenshots' in value) {
    const state = value as { screenshots: Array<{ url: string; [key: string]: unknown }> };
    metadata = { ...state, screenshots: state.screenshots.map(({ url: _url, ...shot }) => shot) };
    for (const shot of state.screenshots) {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(shot.url);
      if (!match) throw new ComputerError('IMAGE_INVALID: native screenshot was not a PNG data URL.');
      content.push({ type: 'image', mimeType: 'image/png', data: match[1]! });
    }
  }
  // Pixels have one transport owner: native MCP image blocks. Returning the same
  // data URLs in value made text(state) overflow code mode's text budget and
  // discarded an otherwise successful observation, including its emitted images.
  const normalized = metadata ?? null;
  content.unshift({ type: 'text', text: metadata === undefined ? `${method}: input accepted; observe to verify the result.` : JSON.stringify(metadata) });
  const result: ToolResult = { content, structuredContent: { value: normalized } };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ComputerError('DESKTOP_RESULT_TOO_LARGE: this observation exceeds the combined image/metadata limit. Reobserve without text or screenshot.');
  }
  return result;
}

async function refuseBrowserChord(key: string, window: { id: number }): Promise<string | null> {
  const chord = browserTabChord(parseWindowsKeyChord(key));
  if (!chord) return null;
  // Popup HWNDs may be absent from the ordinary top-level window list.
  const target = (await getWindowState({ window: window.id, includeScreenshot: false, includeUi: false })).window;
  if (!isBrowserProcess(target.process)) return null;
  return `BROWSER_TAB_CHORD: ${chord} manages browser tabs/windows or history in ${JSON.stringify(target.title)} (${target.process}). No keys were sent. Use browser_tabs list to choose an exact tab; browser_snapshot reads it directly. Use browser_tabs new for a requested test page, or attach then browser_navigate for an existing eligible tab. These operations run in the background without changing the user's selected tab.`;
}

/** Describe a usable next observation without dispatching another action. */
function nativeFailure(error: unknown): ToolResult | null {
  if (!(error instanceof ComputerError)) return null;
  // Partial completion wraps the native code. Keep the original message and exact
  // completed-action evidence; zero completed actions does not prove zero effects.
  const code = /^(?:PARTIAL_BATCH:[^\r\n]*?\. )?([A-Z][A-Z0-9_]*):/.exec(error.message)?.[1];
  if (!code) return null;
  let recovery: string;
  switch (code) {
    case 'CAPTURE_FAILED':
      recovery = 'Use get_window_state({window,include_screenshot:false,include_text:true}) for accessible controls. Inspect list_windows for the current state. A minimized target can be restored with activate_window when needed for the task, then observed again. Repeating the same capture cannot restore it.';
      break;
    case 'WINDOW_NOT_FOUND':
    case 'STALE_WINDOW':
    case 'WINDOW_APP_MISMATCH':
    case 'RELATED_WINDOW_GONE':
      recovery = 'Call list_windows and select the current returned app/window identity. A closed window or dialog needs a new target; do not reuse its old id.';
      break;
    case 'FOCUS_FAILED':
      recovery = 'Call list_windows to inspect the foreground and get_window_state on the target and its owned dialogs. Resolve the relevant dialog or window state before another action.';
      break;
    case 'STALE_FRAME':
    case 'STALE_SCREENSHOT':
    case 'STALE_WINDOW_STATE':
    case 'STALE_REF':
    case 'STALE_UI_REF':
    case 'STALE_UI_SNAPSHOT':
    case 'UNKNOWN_UI_REF':
      recovery = 'Call get_window_state on the current target and inspect the result. Choose fresh screenshot coordinates or indexes from include_text:true; the previous observation no longer authorizes input.';
      break;
    case 'ELEMENT_NOT_FOUND':
      recovery = 'Use get_window_state with include_text:true and query (control name or automation id) or role to locate the control beyond a truncated tree. Use an index from that new result.';
      break;
    case 'UIA_FAILED':
      recovery = 'Use get_window_state({window,include_text:false}) to inspect the target pixels. An unavailable accessibility provider does not imply screenshots or other tools are disabled.';
      break;
    default:
      return null;
  }
  const detail = { code, message: error.message, recovery, completed_count: error.completedCount ?? null,
    failed_index: error.failedIndex ?? null, completed_routes: error.completedRoutes ?? null };
  return { ...fail(`${error.message}\nNext step: ${recovery}\nDo not repeat completed input. Inspect the current result before deciding which action is still needed.`),
    structuredContent: { error: detail } };
}

export function registerWindowsDesktopTools(reg: SurfaceRegistrar): void {
  for (const method of WINDOWS_API_METHODS) {
    const read = READ_METHODS.has(method);
    const capability = read ? 'screen' : 'control';
    if (!reg.exposedCaps[capability]) continue;
    reg.register(method, toolDeclaration(method, () => ({
      description: DESCRIPTIONS[method]!,
      inputSchema: WINDOWS_API_SCHEMAS[method],
      annotations: { readOnlyHint: read, destructiveHint: !read, idempotentHint: read, openWorldHint: true }
    }), 'windows'), input => reg.guarded(capability, method, async () => {
      // The schema is checked by the same registrar for direct calls and code-mode children.
      if (method === 'type_text' && 'text' in input && /[\r\n]/.test(String(input.text)) && !reg.caps.clipboardWrite) {
        return fail('TOOL_DISABLED: multiline text needs the existing Replace clipboard text permission. No input ran.');
      }
      if (method === 'press_key') {
        const keys = input as { key: string; window: { id: number } };
        try {
          const refusal = await refuseBrowserChord(keys.key, keys.window);
          if (refusal) return fail(refusal);
        } catch (error) {
          const failure = nativeFailure(error);
          if (failure) return failure;
          throw error;
        }
      }
      const api = apiForCaller(method);
      const invoke = api[method] as (args: unknown) => Promise<unknown>;
      let value: unknown;
      try { value = await invoke(input); }
      catch (error) {
        const failure = nativeFailure(error);
        if (failure) return failure;
        throw error;
      }
      if (Array.isArray(value)) noteCount(value.length);
      return desktopResult(method, value);
    }));
  }

  if (reg.exposedCaps.clipboardRead) reg.register('read_clipboard', toolDeclaration('read_clipboard', () => ({
    description: 'Read this computer’s clipboard text.', inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  })), () => reg.guarded('clipboardRead', 'read_clipboard', async () => {
    const value = (await act([{ type: 'read_clipboard' }])).clipboard[0] ?? '';
    if (value.length > 64_000) throw new ComputerError('CLIPBOARD_TOO_LARGE: clipboard text exceeds the response limit.');
    return desktopResult('read_clipboard', value);
  }));
  if (reg.exposedCaps.clipboardWrite) reg.register('write_clipboard', toolDeclaration('write_clipboard', () => ({
    description: 'Replace this computer’s clipboard text.', inputSchema: z.object({ text: z.string().max(100_000) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  })), input => reg.guarded('clipboardWrite', 'write_clipboard', async () => {
    await act([{ type: 'write_clipboard', text: input.text }]);
    return { content: [{ type: 'text', text: 'Clipboard text replaced.' }], structuredContent: { value: null } };
  }));
}
