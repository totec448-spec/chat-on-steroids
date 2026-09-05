/**
 * The Desktop connector: seeing and driving the native desktop.
 *
 * Two tools, and they are deliberately not on Core. Desktop control is gated on permissions
 * most users leave off, its schemas are the largest this app publishes, and the majority of
 * coding sessions never touch the desktop — so folding it into Core would put its weight
 * into every no-query discovery of the coding surface for a capability nobody asked for.
 * Separate connector, separate discovery boundary (`docs/tool-surface.md` §6.4).
 *
 * The split between the two is looking versus touching, and it is load-bearing rather than
 * cosmetic: `observe` never requires the foreground and can never fail for lack of it, while
 * `computer` is the only tool allowed to demand focus. That asymmetry is what makes the
 * recovery path work — when something else steals focus, you can still look, see what took
 * it, and act on that.
 */

import { z } from 'zod';
import {
  ComputerError,
  DEFAULT_SCREENSHOT_WIDTH,
  MAX_SCREENSHOT_WIDTH,
  actAndCapture,
  activeWindow,
  findUi,
  getWindowState,
  listWindows,
  screenshot,
  waitForWindow,
  type Action,
  type VerificationSpec
} from '../computer/index.js';
import { browserTabChord, isBrowserProcess } from '../computer/browser-chords.js';
import { logInfo } from '../logger.js';
import { currentCall, noteCount, noteDetail } from './call-context.js';
import { runBrowserCommand } from '../browser-control.js';
import {
  cropArg,
  fail,
  guard,
  imageCoordinateArg,
  mouseButtonArg,
  ok,
  pointArg,
  toolDisabledMessage,
  windowIdArg,
  type SurfaceRegistrar,
  type ToolContent
} from './kernel.js';

const DEFAULT_WINDOW_RESULTS = 60;

/**
 * Refuses a keyboard chord that would manage a browser's tabs or windows.
 *
 * The browser on this desktop is very likely the one holding this app's own ChatGPT chats, and
 * the model cannot see which tab a chord lands on: on 2026-09-02 the prime, testing its game in
 * a tab beside its chats, closed its own chat with ctrl+w and later walked the worker chats
 * with ctrl+tab and typed a URL into one. The window the keys would reach is the last one a
 * focus action in this batch named, else the one in front now.
 */
function newBrowserWindowHint(): string {
  return process.platform === 'darwin'
    ? 'open -na "Google Chrome" --args --new-window "$url"'
    : "Start-Process chrome.exe -ArgumentList '--new-window', $url";
}

/**
 * The sentence a caller fenced out of a browser window most needs, and never saw.
 *
 * `computer` cannot click *into* a web page that has nothing focused yet: the fence asks the
 * application which control has keyboard focus, a browser answers only when the page exposes one,
 * and the click that would create that focus is itself what is being fenced. That is the fence
 * failing closed on honest ignorance of where input would land, which is what it is for — the
 * macOS helper carries a long note saying so and warning the next reader not to file it as a bug.
 *
 * The note is right and the refusal is correct. What neither said is the way out, which exists
 * and is one tool away: `browser` speaks CDP and needs none of this. A QA run met these refusals
 * five times in a row against a browser window, re-observing and retrying between each, and the
 * report's closing judgement was that the app's failures are loud, correct, and read as a pattern
 * of not working. A refusal that names its own remedy is the cheapest answer to that, and it
 * costs no fence — this only appends a sentence to a refusal that has already happened.
 *
 * Best effort by construction: it runs only on the failure path, and any error looking up the
 * window is swallowed, because failing to enrich a message is no reason to replace the real
 * refusal with a worse one.
 */
async function browserInputHint(actions: Action[], targetWindow: number | undefined): Promise<string> {
  try {
    let focused: number | null = targetWindow ?? null;
    for (const action of actions) if (action.type === 'focus') focused = action.window;
    const target =
      focused === null
        ? (await activeWindow()).window
        : ((await listWindows()).windows.find((window) => window.id === focused) ?? null);
    if (!target || !isBrowserProcess(target.process)) return '';
    return (
      ` The window is a browser ("${target.title}"), and desktop input cannot reach a web page ` +
      'that has no focused control yet — the click that would give it one is the click being ' +
      'refused. Use the browser tool for the page itself: it drives Chrome directly and needs ' +
      'no desktop focus.'
    );
  } catch {
    return '';
  }
}

/**
 * Refusals that mean "desktop input could not be aimed", which is the browser case above.
 *
 * `INPUT_TARGET_REQUIRED` joined them after a QA round hit it twice in four minutes while trying
 * to drive a browser window. It already names its own remedy and names it well — supply
 * targetWindow, a window-bound frame, a semantic ref, or focus in the batch — but every one of
 * those is a way to aim desktop input at a page, and against a browser the better answer is not
 * to aim desktop input at all.
 *
 * `STALE_FRAME` is deliberately absent. That one is about a capture whose geometry moved, which
 * is a real answer about the screenshot rather than about where input would land, and it says so.
 */
const INPUT_FENCE_CODES = [
  'INPUT_TARGET_LOST',
  'INPUT_TARGET_REQUIRED',
  'STALE_UI_SNAPSHOT',
  'FOCUS_FAILED'
];

/**
 * Runs the batch, and on an input-fence refusal against a browser adds the way out.
 *
 * A rethrow rather than a mutation, because `ComputerError` carries the partial-batch accounting
 * a caller needs to know how far it got — losing `completedCount` to improve a sentence would
 * trade a fact for a nicety. Anything that is not one of those refusals is rethrown untouched.
 */
async function withBrowserInputHint<T>(
  actions: Action[],
  targetWindow: number | undefined,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof ComputerError)) throw err;
    if (!INPUT_FENCE_CODES.some((code) => err.message.includes(code))) throw err;
    const hint = await browserInputHint(actions, targetWindow);
    if (!hint) throw err;
    throw new ComputerError(`${err.message}${hint}`, {
      ...(typeof err.completedCount === 'number' ? { completedCount: err.completedCount } : {}),
      ...(typeof err.failedIndex === 'number' ? { failedIndex: err.failedIndex } : {}),
      ...(Array.isArray(err.completedRoutes) ? { completedRoutes: err.completedRoutes } : {})
    });
  }
}

async function browserChordRefusal(actions: Action[]): Promise<string | null> {
  let focused: number | null = null;
  for (const action of actions) {
    if (action.type === 'focus') focused = action.window;
    if (action.type !== 'keypress') continue;
    const chord = browserTabChord(action.keys);
    if (!chord) continue;
    const target =
      focused === null
        ? (await activeWindow()).window
        : ((await listWindows()).windows.find((window) => window.id === focused) ?? null);
    if (!target || !isBrowserProcess(target.process)) continue;
    return (
      `BROWSER_TAB_CHORD: ${chord} would close, open or switch tabs or windows of "${target.title}" (${target.process}). ` +
      'A browser here may be holding the ChatGPT chats this app runs, and a chord cannot tell which tab it lands on, so ' +
      'tab and window chords are refused in every browser window. Open the page you are testing in a browser window of its ' +
      `own (${newBrowserWindowHint()}), keep that window in front, and drive it there — ` +
      'navigate with set_value on its address bar, never by keyboard tab or window chords.'
    );
  }
  return null;
}
const MAX_WINDOW_RESULTS = 100;
const MAX_CLIPBOARD_LINE_CHARS = 16_000;
const MAX_CLIPBOARD_OUTPUT_CHARS = 64_000;
const MAX_MCP_RESPONSE_BYTES = 8 * 1024 * 1024;
const MCP_RESPONSE_ENVELOPE_RESERVE_BYTES = 64 * 1024;

/**
 * The image and its observation text share one MCP response budget. The capture layer can
 * bound PNG bytes, but only this final assembly layer knows the actual control metadata.
 */
function desktopImageResult(text: string, data: string): { content: ToolContent[] } {
  const result = {
    content: [
      { type: 'text', text } as ToolContent,
      { type: 'image', data, mimeType: 'image/png' } as ToolContent
    ]
  };
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  const limit = MAX_MCP_RESPONSE_BYTES - MCP_RESPONSE_ENVELOPE_RESERVE_BYTES;
  if (bytes > limit) {
    throw new ComputerError(
      `DESKTOP_RESULT_TOO_LARGE: combined screenshot and control metadata are ${bytes} bytes; limit ${limit}. Retry with a smaller max_width or max_elements.`
    );
  }
  return result;
}

/**
 * Web-page control, which is a different problem from desktop control.
 *
 * The desktop driver can already click anywhere in a browser window, but it cannot see a web
 * page: Chromium keeps its renderer accessibility tree off until a real assistive client asks
 * for it, so a UIA/AX walk returns the toolbar and one opaque pane. Inside a page the desktop
 * driver has pixels and nothing else — which is exactly where refs stop being available.
 *
 * So this addresses elements by ref from `observe`, and the driver re-resolves a ref against
 * the live document immediately before acting on it. Coordinates remain available for the
 * cases refs cannot express, and they are in the screenshot's own pixels: the driver captures
 * at a scale where one image pixel is one CSS pixel is one input unit.
 */
/** One scroll step, bounded the same on both surfaces: the two disagreed, and a page
 * coordinate is a page coordinate whichever driver moves the pointer. */
const scrollDeltaArg = z.number().int().min(-10_000).max(10_000);

const browserActionArg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('observe') }).strict().describe('Page, refs, screenshot.'),
  // The driver has always been able to let go of a tab and the command channel has always
  // carried the message; only this schema never offered it, so a model could take control of a
  // page and had no way to give it back. QA reached for the extension popup instead and clicked
  // it with desktop automation, which is neither reliable nor what anyone should have to do.
  z.object({ type: z.literal('detach') }).strict().describe('Let go of the tab.'),
  z.object({ type: z.literal('status') }).strict().describe('Which tab is held.'),
  z.object({ type: z.literal('navigate'), url: z.string().min(1).max(2_000) }).strict().describe('Go to a URL.'),
  z.object({ type: z.literal('back') }).strict().describe('Back.'),
  z.object({ type: z.literal('forward') }).strict().describe('Forward.'),
  z.object({ type: z.literal('reload') }).strict().describe('Reload.'),
  // 32, not 16: refs now carry the observation generation that minted them (e.g. "g12_e4"), so a
  // stale one from an earlier observation never coincidentally matches a live one after a later
  // observation recycles the same short index.
  z.object({ type: z.literal('click_ref'), ref: z.string().min(1).max(32), button: mouseButtonArg.optional() }).strict().describe('Click a ref.'),
  // The select half is worth its bytes: a native dropdown cannot be driven by clicking, because
  // Chrome paints it outside the page, and a QA run burned a step discovering that the hard way.
  z.object({ type: z.literal('set_value'), ref: z.string().min(1).max(32), text: z.string().max(20_000) }).strict().describe('Replace a field by ref. On a select, picks the option with that label or value.'),
  z.object({ type: z.literal('click'), x: imageCoordinateArg, y: imageCoordinateArg, button: mouseButtonArg.optional() }).strict().describe('Click at pixels.'),
  z.object({ type: z.literal('double_click'), x: imageCoordinateArg, y: imageCoordinateArg }).strict().describe('Double-click at pixels.'),
  z.object({ type: z.literal('move'), x: imageCoordinateArg, y: imageCoordinateArg }).strict().describe('Move the pointer.'),
  z.object({ type: z.literal('move_ref'), ref: z.string().min(1).max(32) }).strict().describe('Hover a ref, pressing nothing.'),
  z.object({ type: z.literal('drag'), path: z.array(pointArg).min(2).max(64), button: mouseButtonArg.optional() }).strict().describe('Drag along a path.'),
  z.object({ type: z.literal('scroll'), x: imageCoordinateArg, y: imageCoordinateArg, scroll_x: scrollDeltaArg.optional(), scroll_y: scrollDeltaArg.optional() }).strict().describe('Scroll at a point.'),
  z.object({ type: z.literal('type'), text: z.string().max(4_000) }).strict().describe('Type into focus.'),
  z.object({ type: z.literal('keypress'), keys: z.array(z.string().max(20)).min(1).max(6) }).strict().describe('Press keys.'),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(10_000).optional() }).strict().describe('Pause.')
]);

const computerActionArg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click_ref'), ref: z.string().min(1).max(64) }).strict().describe('Click a control by ref from observe.'),
  z
    .object({ type: z.literal('set_value'), ref: z.string().min(1).max(64), text: z.string().max(20_000) })
    .strict()
    .describe('Set a text control’s value directly by ref.'),
  z
    .object({ type: z.literal('click'), x: imageCoordinateArg, y: imageCoordinateArg, button: mouseButtonArg.optional() })
    .strict()
    .describe('Click at image coordinates.'),
  z
    .object({
      type: z.literal('double_click'),
      x: imageCoordinateArg,
      y: imageCoordinateArg,
      button: mouseButtonArg.optional()
    })
    .strict()
    .describe('Double-click at image coordinates.'),
  z.object({ type: z.literal('move'), x: imageCoordinateArg, y: imageCoordinateArg }).strict().describe('Move the pointer.'),
  z
    .object({ type: z.literal('drag'), path: z.array(pointArg).min(2).max(64), button: mouseButtonArg.optional() })
    .strict()
    .describe('Press, follow the path, release.'),
  z
    .object({
      type: z.literal('scroll'),
      x: imageCoordinateArg,
      y: imageCoordinateArg,
      scroll_x: z.number().int().min(-10_000).max(10_000).optional(),
      scroll_y: scrollDeltaArg.optional()
    })
    .strict()
    .describe('Scroll at a point.'),
  z.object({ type: z.literal('type'), text: z.string().max(4000) }).strict().describe('Type text into target.'),
  z
    .object({ type: z.literal('keypress'), keys: z.array(z.string().max(20)).min(1).max(6) })
    .strict()
    .describe(
      'Press keys together, e.g. ["ctrl","s"] (Windows) or ["command","s"] (macOS). Browser tab/window/address-bar chords are refused; use set_value on the address bar.'
    ),
  z.object({ type: z.literal('focus'), window: windowIdArg }).strict().describe('Bring a window to the front.'),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(10_000).optional() }).strict().describe('Pause.'),
  z.object({ type: z.literal('read_clipboard') }).strict().describe('Return the clipboard text.'),
  z
    .object({ type: z.literal('write_clipboard'), text: z.string().max(100_000) })
    .strict()
    .describe('Replace the clipboard text; paste with command+v on macOS or ctrl+v on Windows/Linux.')
]);

const verificationArg = z
  .object({
    until: z.enum(['foreground', 'window_exists', 'window_closed', 'ui_appears', 'ui_disappears']),
    window: windowIdArg.optional(),
    match: z.string().min(1).max(300).optional(),
    role: z.string().min(1).max(100).optional(),
    timeout_ms: z.number().int().min(0).max(10_000).optional(),
    capture: z.enum(['on_change', 'always', 'never']).optional()
  })
  .strict();

export function registerDesktopTools(reg: SurfaceRegistrar): void {
  const { ctx, caps, exposedCaps } = reg;

  // ---------------------------------------------------------------- observe

  if (exposedCaps.screen) {
    reg.register(
      'observe',
      {
        title: 'Look at the desktop',
        description:
          'Look at the desktop without touching it. With no arguments, returns the foreground window, its picture and snapshot-scoped UI controls. ' +
          'what=windows lists windows; what=window inspects one; what=ui returns controls; wait_for waits for a title. ' +
          'Pass refs to computer click_ref/set_value and screenshot frameId with pixel coordinates. ' +
          'Window capture never focuses; a labeled visible-screen fallback may be occluded.',
        inputSchema: z
          .object({
            what: z
              .enum(['active', 'windows', 'window', 'ui'])
              .optional()
              .describe('Default active: the foreground window, its screenshot and its controls.'),
            window: windowIdArg.optional().describe('Window id for what=window or what=ui.'),
            match: z.string().max(300).optional().describe('Filter: title/process for windows, control name/role for ui.'),
            wait_for: z.string().min(1).max(300).optional().describe('Wait until a window with this title substring exists.'),
            timeout_ms: z.number().int().min(0).max(60_000).optional().describe('With wait_for. Default 10000.'),
            screenshot: z.boolean().optional().describe('Include a picture. Default true for active and window.'),
            max_width: z
              .number()
              .int()
              .min(320)
              .max(MAX_SCREENSHOT_WIDTH)
              .optional()
              .describe(`Screenshot width. Default ${DEFAULT_SCREENSHOT_WIDTH}.`),
            max_elements: z
              .number()
              .int()
              .min(1)
              .max(MAX_WINDOW_RESULTS)
              .optional()
              .describe('Maximum controls or windows returned. Default 60.')
          })
          .superRefine((input, ctx) => {
            const what = input.wait_for ? (input.what ?? 'window') : (input.what ?? 'active');
            if (input.timeout_ms !== undefined && input.wait_for === undefined) {
              ctx.addIssue({ code: 'custom', path: ['timeout_ms'], message: 'timeout_ms requires wait_for' });
            }
            if (input.window !== undefined && input.wait_for !== undefined) {
              ctx.addIssue({ code: 'custom', path: ['window'], message: 'window cannot be combined with wait_for, which selects the window' });
            } else if (input.window !== undefined && what !== 'window' && what !== 'ui') {
              ctx.addIssue({ code: 'custom', path: ['window'], message: `window is not used with what=${what}` });
            }
            if (input.match !== undefined && what !== 'windows' && what !== 'ui') {
              ctx.addIssue({ code: 'custom', path: ['match'], message: 'match is only used with what=windows or what=ui' });
            }
            if ((what === 'windows' || what === 'ui') && input.screenshot === true) {
              ctx.addIssue({ code: 'custom', path: ['screenshot'], message: `screenshot=true is not used with what=${what}` });
            }
            const capturesImage = what !== 'windows' && what !== 'ui' && input.screenshot !== false;
            if (input.max_width !== undefined && !capturesImage) {
              ctx.addIssue({ code: 'custom', path: ['max_width'], message: 'max_width requires a screenshot-producing observation' });
            }
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async (input) =>
        reg.guarded('screen', 'observe', async () => {
          // wait_for happens first and then answers the ordinary question about whatever it
          // found, so "wait for the installer, then look at it" is one call rather than a
          // wait followed by a second call that races the window closing again.
          let target = input.window;
          let waited: string | null = null;
          if (input.wait_for) {
            const found = await waitForWindow({
              title: input.wait_for,
              foreground: false,
              timeoutMs: input.timeout_ms
            });
            target = found.id;
            waited = `Found "${found.title}" (${found.process}) as window ${found.id}.`;
          }

          const what = input.wait_for ? (input.what ?? 'window') : (input.what ?? 'active');

          if (what === 'windows') {
            const { windows, screen } = await listWindows();
            const needle = input.match?.toLowerCase() ?? null;
            const matching = needle
              ? windows.filter(
                  (w) => w.title.toLowerCase().includes(needle) || w.process.toLowerCase().includes(needle)
                )
              : windows;
            const limit = Math.min(MAX_WINDOW_RESULTS, Math.max(1, Math.floor(input.max_elements ?? DEFAULT_WINDOW_RESULTS)));
            const shown = matching.slice(0, limit);
            noteCount(shown.length);
            logInfo(`tool observe windows (${shown.length}/${matching.length} matched, ${windows.length} total)`);
            if (shown.length === 0) return ok(prefix(waited, 'No visible windows match.'));
            const lines = shown.map(
              (w) => `${w.id}  ${w.process}  ${w.x},${w.y}  ${w.width}x${w.height}  ${w.state}  ${w.title}`
            );
            if (shown.length < matching.length) {
              lines.push(`… showing ${shown.length} of ${matching.length} matching windows; narrow match or raise max_elements`);
            }
            return ok(
              prefix(
                waited,
                `Desktop ${screen.width}x${screen.height}\nid  program  position  size  state  title\n${lines.join('\n')}`
              )
            );
          }

          if (what === 'ui' && input.match) {
            const result = await findUi({ window: target, query: input.match, maxResults: input.max_elements });
            noteCount(result.elements.length);
            if (result.elements.length === 0) {
              return ok(prefix(waited, `No controls in window ${result.window} match "${input.match}".`));
            }
            const lines = result.elements.map((element, index) => {
              const desktop = `${element.bounds.x},${element.bounds.y} ${element.bounds.width}x${element.bounds.height}`;
              const image = element.imageCenter ? ` image_center=${element.imageCenter.x},${element.imageCenter.y}` : '';
              const id = element.automationId ? ` id=${JSON.stringify(element.automationId)}` : '';
              const flags = `${element.enabled ? '' : ' disabled'}${element.offscreen ? ' offscreen' : ''}`;
              return `${index + 1}. ${element.ref} ${element.role} ${JSON.stringify(element.name)}${id} desktop=${desktop}${image}${flags}`;
            });
            return ok(prefix(waited, `window: ${result.window}\nsnapshot: ${result.snapshotId}\n${lines.join('\n')}`));
          }

          // A bare "what is on screen right now" with no window at all: cheapest possible
          // answer, and the only one that still works when there is no foreground window.
          if (what === 'active' && target === undefined && input.screenshot === false) {
            const { window, screen, foregroundIsSelf } = await activeWindow();
            if (!window) {
              // "None" and "this app" are different answers, and reporting the second as the
              // first made a deliberate refusal look like a defect. Chat On Steroids hides its
              // own windows from everything the model can see, on purpose: it must not be able
              // to drive the app that is driving it.
              const reason = foregroundIsSelf
                ? 'Chat On Steroids itself is in front. Its own windows are never exposed, so there is nothing here to act on — switch to another application first.'
                : 'No foreground window.';
              return ok(prefix(waited, `Desktop ${screen.width}x${screen.height}\n${reason}`));
            }
            return ok(prefix(waited, describeWindow(window)));
          }

          const wantsShot = what === 'ui' ? false : input.screenshot !== false;
          let state: Awaited<ReturnType<typeof getWindowState>>;
          try {
            state = await getWindowState({
              window: target,
              maxWidth: input.max_width,
              maxElements: input.max_elements,
              includeScreenshot: wantsShot,
              includeUi: true
            });
          } catch (err) {
            // "There is no foreground window" is a real native desktop state — a
            // locked screen, a shell restart, everything minimised — and it is not a reason
            // to refuse to look. Fall back to the monitor, which is the honest answer.
            if (
              target !== undefined ||
              !(err instanceof ComputerError) ||
              !err.message.startsWith('WINDOW_NOT_FOUND:')
            ) {
              throw err;
            }
            const shot = await screenshot({ maxWidth: input.max_width });
            // Why there is no window matters here as much as on the bare query, and this
            // path was missed when that one was fixed — which is why QA still saw the old
            // wording. Asked separately because the failure above tells us nothing about it.
            let selfInFront = false;
            try {
              selfInFront = (await activeWindow())?.foregroundIsSelf === true;
            } catch {
              // Best effort. This only chooses between two ways of saying the same fallback, and
              // failing to learn which would be a poor reason to fail the screenshot itself.
            }
            return desktopImageResult(
              prefix(
                waited,
                `${selfInFront ? 'Chat On Steroids itself is in front and its own windows are never exposed, so this is the whole primary monitor.' : 'No foreground window, so this is the whole primary monitor.'}\nframe: ${shot.frameId}  ${shot.width}x${shot.height} — pass frameId ${shot.frameId} with any coordinates you read off it`
              ),
              shot.data
            );
          }
          noteCount(state.elements.length);
          logInfo(`tool observe ${what} window=${state.window.id} (${state.elements.length} controls)`);

          const lines = [
            `window: ${state.window.id}  ${state.window.process}  ${state.window.state}  ${state.window.title}`,
            `bounds: ${state.window.x},${state.window.y} ${state.window.width}x${state.window.height}`
          ];
          if (state.snapshotId !== null) lines.push(`snapshot: ${state.snapshotId}`);
          if (state.screenshot) {
            lines.push(
              `frame: ${state.screenshot.frameId}  ${state.screenshot.width}x${state.screenshot.height} — pass frameId ${state.screenshot.frameId} with any coordinates you read off it`
            );
            if (state.screenshot.captureMode === 'screen_fallback') {
              lines.push(
                'note: background window capture was unavailable, so these are visible screen pixels and may show something covering the target.'
              );
            }
          }
          if (state.elements.length > 0) {
            lines.push('controls:');
            for (const element of state.elements) {
              const image = element.imageCenter ? ` image_center=${element.imageCenter.x},${element.imageCenter.y}` : '';
              const automation = element.automationId ? ` id=${JSON.stringify(element.automationId)}` : '';
              const flags = `${element.enabled ? '' : ' disabled'}${element.offscreen ? ' offscreen' : ''}`;
              lines.push(`${element.ref}  ${element.role} ${JSON.stringify(element.name)}${automation}${image}${flags}`);
            }
          } else if (state.uiUnavailable) {
            lines.push(`controls: unavailable (${state.uiUnavailable.code}) — ${state.uiUnavailable.message}`);
          } else {
            lines.push('controls: none exposed by the platform accessibility API');
          }

          const text = prefix(waited, lines.join('\n'));
          if (!state.screenshot) return ok(text);
          return desktopImageResult(text, state.screenshot.data);
        })
    );
  }

  // --------------------------------------------------------------- computer

  // Clipboard access lives here too, so a user who granted only the clipboard still gets
  // it. The individual actions are checked against their own permission when they run.
  if (exposedCaps.control || exposedCaps.clipboardRead || exposedCaps.clipboardWrite) {
    reg.register(
      'computer',
      {
        title: 'Control mouse and keyboard',
        description:
          'One desktop decision. Prefer refs; pixels need frameId. Pointer/text needs a target; system keys stay global.',
        inputSchema: z
          .object({
            actions: z
              .array(computerActionArg)
              .min(1)
              .max(20)
              // Stated here rather than only in the rejection below: a run was spent discovering
              // this rule by being refused. Kept terse — this surface has a discovery budget.
              .describe('One UI-changing action per call; focus/move/wait/clipboard may accompany it.'),
            frameId: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe('Required for coordinate actions or captureCrop.'),
            targetWindow: windowIdArg.optional(),
            verify: verificationArg.optional(),
            captureAfter: z.boolean().optional().describe('Capture result; default on for mutations.'),
            captureWindow: windowIdArg.optional().describe('Result capture: this window.'),
            captureFull: z.boolean().optional().describe('Result capture: all monitors.'),
            captureMaxWidth: z
              .number()
              .int()
              .min(320)
              .max(MAX_SCREENSHOT_WIDTH)
              .optional()
              .describe(`Result capture width. Default ${DEFAULT_SCREENSHOT_WIDTH}.`),
            captureCrop: cropArg.optional().describe('Result crop in the input frame.')
          })
          .superRefine((input, ctx) => {
            const decisionActions = input.actions.filter((action) =>
              action.type !== 'wait' &&
              action.type !== 'read_clipboard' &&
              action.type !== 'write_clipboard' &&
              action.type !== 'move' &&
              action.type !== 'focus'
            );
            if (decisionActions.length > 1) {
              ctx.addIssue({
                code: 'custom',
                path: ['actions'],
                message: 'Use one UI-changing decision per computer call; focus/move/wait/clipboard setup may accompany it.'
              });
            }
            if (input.verify) {
              const needsWindow = input.verify.until === 'foreground';
              const needsMatch = input.verify.until !== 'foreground';
              const isUi = input.verify.until === 'ui_appears' || input.verify.until === 'ui_disappears';
              if (needsWindow && input.verify.window === undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'window'], message: 'foreground verification requires window' });
              }
              if (needsMatch && input.verify.match === undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'match'], message: `${input.verify.until} verification requires match` });
              }
              if (!isUi && input.verify.role !== undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'role'], message: 'role is only used by UI verification' });
              }
              if (!isUi && input.verify.until !== 'foreground' && input.verify.window !== undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'window'], message: 'window is only used by foreground or UI verification' });
              }
              if (input.verify.until === 'foreground' && input.verify.match !== undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'match'], message: 'match is not used by foreground verification' });
              }
            }
            const verifyCapture = input.verify?.capture === 'always' || input.verify?.capture === 'on_change';
            const autoCapture =
              caps.screen &&
              input.captureAfter !== false &&
              input.actions.some((action) =>
                action.type !== 'wait' && action.type !== 'read_clipboard' && action.type !== 'write_clipboard' && action.type !== 'move'
              );
            const willCapture = input.captureAfter === true || verifyCapture || autoCapture;
            const captureFields = ['captureWindow', 'captureFull', 'captureMaxWidth', 'captureCrop'] as const;
            if (!willCapture) {
              for (const field of captureFields) {
                if (input[field] !== undefined) {
                  ctx.addIssue({ code: 'custom', path: [field], message: `${field} requires captureAfter=true or verify.capture` });
                }
              }
              return;
            }
            if (input.captureCrop !== undefined && input.frameId === undefined) {
              ctx.addIssue({ code: 'custom', path: ['frameId'], message: 'frameId is required with captureCrop' });
            }
            const targetCount = Number(input.captureWindow !== undefined) + Number(input.captureFull === true) + Number(input.captureCrop !== undefined);
            if (targetCount > 1) {
              ctx.addIssue({
                code: 'custom',
                path: ['captureAfter'],
                message: 'captureWindow, captureFull=true, and captureCrop are mutually exclusive capture targets'
              });
            }
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ actions, frameId, targetWindow, verify, captureAfter, captureWindow, captureFull, captureMaxWidth, captureCrop }) =>
        guard('computer', async () => {
          // Not reg.guarded: this tool covers two permissions. Pointer and keyboard steps
          // need "control", the clipboard steps need their own, and one blanket refusal
          // would hide which of them the user actually has to switch on.
          if (!caps.control && actions.some((a) => a.type !== 'wait' && !a.type.endsWith('_clipboard'))) {
            return fail(toolDisabledMessage(ctx.readOnly, 'control', 'mouse and keyboard control', 'Control mouse and keyboard'));
          }
          const parsed: Action[] = [];
          for (const a of actions) {
            switch (a.type) {
              case 'click_ref':
                parsed.push({ type: 'click_ref', ref: a.ref });
                break;
              case 'set_value':
                parsed.push({ type: 'set_value', ref: a.ref, text: a.text });
                break;
              case 'click':
              case 'double_click':
                parsed.push({ type: a.type, x: a.x, y: a.y, button: a.button });
                break;
              case 'move':
                parsed.push({ type: 'move', x: a.x, y: a.y });
                break;
              case 'scroll':
                parsed.push({ type: 'scroll', x: a.x, y: a.y, scroll_x: a.scroll_x, scroll_y: a.scroll_y });
                break;
              case 'drag':
                parsed.push({ type: 'drag', path: a.path, button: a.button });
                break;
              case 'type':
                parsed.push({ type: 'type', text: a.text });
                break;
              case 'keypress':
                parsed.push({ type: 'keypress', keys: a.keys });
                break;
              case 'focus':
                parsed.push({ type: 'focus', window: a.window });
                break;
              case 'wait':
                parsed.push({ type: 'wait', ms: a.ms });
                break;
              case 'read_clipboard':
                // Gated here rather than by leaving the variant out of the schema: the
                // schema is cached by ChatGPT, and a tool that quietly changes shape when
                // a checkbox moves is worse than one that says plainly it is switched off.
                if (!caps.clipboardRead) {
                  return fail(toolDisabledMessage(ctx.readOnly, 'clipboardRead', 'read_clipboard', 'Read the clipboard'));
                }
                parsed.push({ type: 'read_clipboard' });
                break;
              case 'write_clipboard':
                if (!caps.clipboardWrite) {
                  return fail(toolDisabledMessage(ctx.readOnly, 'clipboardWrite', 'write_clipboard', 'Replace clipboard text'));
                }
                parsed.push({ type: 'write_clipboard', text: a.text });
                break;
            }
          }
          const chordRefusal = await browserChordRefusal(parsed);
          if (chordRefusal) return fail(chordRefusal);
          logInfo(`tool computer ${parsed.map((a) => a.type).join(', ')}`);
          noteDetail(parsed.map((a) => a.type).join(', '));
          const verifyCapture = verify?.capture === 'always' || verify?.capture === 'on_change';
          const mutatesDesktop = parsed.some((action) =>
            action.type !== 'wait' && action.type !== 'read_clipboard' && action.type !== 'write_clipboard' && action.type !== 'move'
          );
          const autoCapture = caps.screen && captureAfter !== false && mutatesDesktop;
          const wantsCapture = captureAfter === true || verifyCapture || autoCapture;
          if ((verify || wantsCapture) && !caps.screen) {
            return fail('TOOL_DISABLED: verification and result capture need the See the screen permission.');
          }
          const parsedVerify: VerificationSpec | undefined = verify
            ? verify.until === 'foreground'
              ? { until: 'foreground', window: verify.window!, timeoutMs: verify.timeout_ms }
              : verify.until === 'window_exists' || verify.until === 'window_closed'
                ? { until: verify.until, match: verify.match!, timeoutMs: verify.timeout_ms }
                : {
                    until: verify.until,
                    window: verify.window,
                    match: verify.match!,
                    role: verify.role,
                    timeoutMs: verify.timeout_ms
                  }
            : undefined;
          // One lock, one operation: the picture that verifies these actions must be taken
          // before anyone else can touch the desktop.
          const result = await withBrowserInputHint(parsed, targetWindow, () => actAndCapture(parsed, {
            frameId,
            targetWindow,
            verify: parsedVerify,
            capture:
              wantsCapture
                ? {
                    window: captureWindow ?? (captureFull === true || captureCrop !== undefined ? undefined : targetWindow),
                    full: captureFull,
                    maxWidth: captureMaxWidth ?? (autoCapture ? 1600 : undefined),
                    crop: captureCrop,
                    preferActiveWindow:
                      ctx.privacyScreenshots ||
                      (autoCapture && captureWindow === undefined && targetWindow === undefined && captureFull !== true && captureCrop === undefined)
                  }
                : undefined
          }));
          const cursor = result.cursor;
          const pointer = cursor
            ? cursor.image
              ? `Pointer image: ${cursor.image.x},${cursor.image.y} (frame ${cursor.frameId}, ${cursor.imageSize?.width}x${cursor.imageSize?.height}); desktop: ${cursor.screen.x},${cursor.screen.y}.`
              : cursor.frameId === null
                ? `Pointer desktop: ${cursor.screen.x},${cursor.screen.y}. No screenshot frame is active.`
                : `Pointer desktop: ${cursor.screen.x},${cursor.screen.y}. It is outside frame ${cursor.frameId}, so it has no position in that image.`
            : 'Pointer position was not queried because this batch used only local wait/clipboard actions.';
          // Clipboard reads are the one action that returns something, so they are quoted
          // back in order rather than folded into the "Done:" line.
          const clipboardLines: string[] = [];
          let clipboardBudget = MAX_CLIPBOARD_OUTPUT_CHARS;
          for (const [index, text] of result.clipboard.entries()) {
            if (clipboardBudget <= 0) {
              clipboardLines.push(`… ${result.clipboard.length - index} more clipboard read(s) omitted by the output cap`);
              break;
            }
            const prefixText = `Clipboard read ${index + 1}: `;
            const rendered = text === '' ? '(empty)' : JSON.stringify(text);
            const payloadCap = Math.max(0, Math.min(MAX_CLIPBOARD_LINE_CHARS, clipboardBudget - prefixText.length - 80));
            const payload =
              rendered.length <= payloadCap
                ? rendered
                : `${rendered.slice(0, payloadCap)}… [truncated; ${text.length} chars original]`;
            const line = `${prefixText}${payload}`.slice(0, clipboardBudget);
            clipboardLines.push(line);
            clipboardBudget -= line.length + 1;
          }
          const clipboard = clipboardLines.join('\n');
          const routeSummary = [...new Set(result.routes)].join('+') || 'local';
          const verified = result.verification
            ? `\nVerified ${result.verification.until} in ${result.verification.elapsedMs} ms: ${result.verification.detail}.`
            : '';
          const captureFallback = result.captureFallback ? `\nCapture note: ${result.captureFallback}.` : '';
          // A scroll that reports only "sent" cannot be told apart from an application ignoring
          // the wheel — and the window server delivers a wheel to whatever is under the pointer,
          // which need not be the leased window. So say where it landed and whether it travelled.
          const scroll = result.scroll
            ? `
Scroll: ${
                result.scroll['reachedTarget'] === false
                  ? `the wheel went to another window (${String(result.scroll['hitRole'] ?? 'unknown role')}, pid ${String(result.scroll['hitPid'] ?? '?')}), not the one leased`
                  : `reached the leased window (${String(result.scroll['hitRole'] ?? 'unknown role')})`
              }; ${
                result.scroll['moved'] === true
                  ? `it moved, ${String(result.scroll['positionBefore'])} → ${String(result.scroll['positionAfter'])}`
                  : result.scroll['moved'] === false
                    ? `nothing moved, still at ${String(result.scroll['positionAfter'])}`
                    : `whether it moved is unreadable (${String(result.scroll['movedUnknown'] ?? 'no scroller')})`
              }. ${JSON.stringify(result.scroll)}`
            : '';
          // Same reasoning as scroll's `moved`: a click_ref's semantic press can report success
          // at the accessibility-API level while the control it named never actually changed —
          // measured against a real System Settings toggle that answered success and stayed put
          // until a coordinate click on the same spot moved it. Silence here would let that
          // recur unnoticed on every other control shaped like it.
          const uiChange =
            result.uiChanged === true
              ? '\nClick: the control’s reported value changed.'
              : result.uiChanged === false
                ? '\nClick: the accessibility action reported success, but the control’s reported value did not change. Try clicking the same coordinates instead.'
                : '';
          const done = `Done ${result.completedCount}/${parsed.length} via ${routeSummary}: ${parsed.map((a) => a.type).join(', ')}. ${pointer}${clipboard ? `\n${clipboard}` : ''}${verified}${captureFallback}${scroll}${uiChange}`;
          const shot = result.screenshot;
          if (shot) {
            return desktopImageResult(
              `${done}\nCaptured frame ${shot.frameId}, ${shot.width}x${shot.height}. Use this frame for the next coordinates.`,
              shot.data
            );
          }
          return ok(done);
        })
    );

    /**
     * Web-page control, carried out by the extension rather than the operating system.
     *
     * Everything here goes through the ChatGPT page that issued the call: the app parks one
     * action, that page collects it on its next activity poll, and the extension's service
     * worker performs it over the DevTools protocol. The worker is the only part that can hold
     * such a session, and a DevTools session is the only route to trusted input — events a
     * content script dispatches are `isTrusted: false` and real pages reject them.
     *
     * Refused for ChatGPT's own tabs before anything else, in the driver: the model asking for
     * this is sitting in one, and a driver able to attach there could drive its own
     * conversation.
     */
    if (exposedCaps.control) reg.register(
      'browser',
      {
        title: 'Control a web page',
        description:
          'Drive a web page. observe first: refs plus a screenshot whose pixels are the coordinates. ' +
          'Prefer refs — re-resolved before use, so a moved element is hit and a vanished one refuses. ' +
          'No attach step: navigate starts a run, taking the newest ordinary tab or opening ' +
          'one; ChatGPT tabs are never driven. Needs browser control on in the extension popup.',
        inputSchema: z.object({ actions: z.array(browserActionArg).min(1).max(20) }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async (input) =>
        reg.guarded('control', 'browser', async () => {
          // The conversation is the address: the action is delivered to the page showing it,
          // which is the same evidence every identity-sensitive route in this app uses.
          const conversationId = currentCall()?.caller.conversationId ?? null;
          if (!conversationId) {
            return fail(
              'CALLER_IDENTITY_REQUIRED: browser control is delivered to the ChatGPT page that asked for it, ' +
                'and this call could not be attributed to a conversation. No browser action was taken.'
            );
          }

          // One block per action rather than one flat list, because an earlier observation has
          // to be removable at the end: the driver keeps only the newest observation's refs
          // addressable and replaces that map wholesale each time. Printing every observation's
          // refs hands back a list whose earlier half is already dead, with nothing marking
          // which half — a model would pick one, be refused, and have no reason why.
          const blocks: Array<{ observed: boolean; lines: string[] }> = [];
          let shot: { data: string; width: number; height: number } | null = null;
          for (const [index, action] of input.actions.entries()) {
            const reply = await runBrowserCommand(conversationId, action as Record<string, unknown>);
            if (!reply.ok) {
              // Stops at the first failure rather than pressing on: later actions were chosen
              // for a page state that this one did not produce.
              return fail(
                // The detail is a sentence written by the driver and often ends in one already;
                // appending a second full stop produced "let go of.." in a run's report. Small,
                // but it is the kind of thing that makes an error message look unfinished.
                `${reply.error ?? 'BROWSER_FAILED'}: ` +
                  `${(reply.detail ?? 'the browser action did not complete').replace(/\.\s*$/, '')}. ` +
                  `Completed ${index} of ${input.actions.length}.`
              );
            }
            const data = reply.data ?? {};
            const rendered = renderBrowserAction(action.type, data);
            blocks.push({ observed: rendered.observed, lines: rendered.lines });
            if (rendered.screenshot) shot = rendered.screenshot;
          }

          const newestObservation = blocks.reduce(
            (latest, block, index) => (block.observed ? index : latest),
            -1
          );
          const body = blocks
            .flatMap((block, index) =>
              block.observed && index !== newestObservation
                ? ['observe: superseded by a later observation in this call; those refs are gone']
                : block.lines
            )
            .join('\n');
          if (shot) {
            return desktopImageResult(
              `${body}\nScreenshot ${shot.width}x${shot.height}; its pixels are the coordinates for this page.`,
              shot.data
            );
          }
          return ok(body);
        })
    );
  }
}

/**
 * One browser action, rendered as the driver answered it.
 *
 * Pulled out of the tool so it can be tested. It was inline, reachable only through a live
 * extension and a real browser, and it silently replaced every reply but observe and status with
 * the word `ok` — discarding `hit`, `covered`, and the driver build. The driver had a suite that
 * proved those fields, the helper had one too, and the piece between them had none, so a QA run
 * found it instead of a test. Being a plain function of its input is what fixes that.
 */
export function renderBrowserAction(
  type: string,
  data: Record<string, unknown>
): { observed: boolean; lines: string[]; screenshot?: { data: string; width: number; height: number } } {
  if (type === 'observe') {
            const elements = Array.isArray(data['elements']) ? (data['elements'] as Array<Record<string, unknown>>) : [];
            const picture = data['screenshot'] as { data: string; width: number; height: number } | null | undefined;
            return ({
              observed: true,
              ...(picture && typeof picture.data === 'string' ? { screenshot: picture } : {}),
              lines: [
              `page: ${String(data['url'] ?? '')}`,
              `title: ${String(data['title'] ?? '')}`,
              ...elements.map(
                (element) =>
                  `${String(element['ref'])} ${String(element['role'])} ${JSON.stringify(String(element['name'] ?? ''))}` +
                  // What the control currently holds. The driver has collected both since it was
                  // written and neither was ever printed, so a checkbox that is already ticked
                  // looked exactly like one that is not — and the only way to find out was to
                  // click it, which is also the way to get it wrong. Same for a field that
                  // already contains the text a caller is about to set.
                  `${element['checked'] ? ` checked=${String(element['checked'])}` : ''}` +
                  `${element['value'] ? ` value=${JSON.stringify(String(element['value']))}` : ''}` +
                  `${element['disabled'] === true ? ' disabled' : ''} at ${String(element['x'])},${String(element['y'])}`
              )
            ] });
          } else if (type === 'detach' || type === 'status') {
            // These answer a question about the session rather than doing something to a page,
            // so "ok" is not an answer. Say which tab is held, or that none is.
            const attached = data['attached'] === true;
            const released = data['released'] as Record<string, unknown> | undefined;
            // The digest of the driver Chrome is actually running. Installing a package
            // rewrites the extension folder, but Chrome keeps the copy it already loaded until
            // someone reloads it by hand — so a run can measure old code while reading new
            // release notes, and has. This is the only place a caller can ask which code
            // answered, which is why it belongs on the answer that reports the session.
            const build = data['build'] === undefined || data['build'] === null
              ? '; driver build unreported'
              : `; driver build ${String(data['build'])}`;
            return ({ observed: false, lines: [
              attached
                ? `${type}: holding tab ${String(data['tabId'])} — ${String(data['title'] ?? '')} ` +
                  `(${String(data['url'] ?? '')})` +
                  // The group is the visible claim that this tab is being driven. Saying it here
                  // is what lets the caller check that claim instead of a person having to look
                  // at the tab strip.
                  (data['groupId'] === null || data['groupId'] === undefined
                    ? ', not in a driven group'
                    : `, in driven group ${String(data['groupId'])}`)
                : released
                  ? `${type}: let go of tab ${String(released['tabId'])} — ` +
                    `${String(released['title'] ?? '')} (${String(released['url'] ?? '')}); ` +
                    'no tab is under control'
                  : `${type}: no tab is under control`
            ].map((line) => line + build) });
          } else {
            // Everything the driver answered with, rather than the fields this renderer
            // happens to know about. `ok` threw away three separate pieces of evidence a QA
            // run needed — `hit`, `covered`, and the driver build — and no test could catch
            // it, because all three existed and were correct one layer below. A run then
            // reported working fixes as missing, twice. Reading the answer instead of
            // enumerating it means the next field a driver adds arrives on its own.
            const said = Object.entries(data)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => {
                const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
                return `${key}=${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
              })
              .join(' ');
            return ({ observed: false, lines: [`${type}: ${said || 'ok'}`] });
          }
}

function prefix(note: string | null, body: string): string {
  return note ? `${note}\n\n${body}` : body;
}

function describeWindow(window: {
  id: number;
  process: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: string;
}): string {
  return (
    `window: ${window.id}\nprocess: ${window.process}\ntitle: ${window.title}\n` +
    `bounds: ${window.x},${window.y} ${window.width}x${window.height}\nstate: ${window.state}`
  );
}
