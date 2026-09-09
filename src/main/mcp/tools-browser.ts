/**
 * The browser connector tool: driving a real web page through the companion extension.
 *
 * Separate from tools-desktop because the two answer different questions. The desktop driver
 * can click anywhere in a browser window but cannot see a web page: it has no refs, no DOM and
 * no way to tell a link from the pixels around it. This tool speaks to the page itself.
 *
 * Kept in its own module so the capability is reviewable on its own terms: its tab ownership,
 * its live capability gate and its bounded output are all here, and none of it is entangled
 * with native desktop input.
 */

import { z } from 'zod';
import { runBrowserCommand } from '../browser-control.js';
import { currentCall } from './call-context.js';
import { desktopImageResult } from './tools-desktop.js';
import {
  fail,
  imageCoordinateArg,
  mouseButtonArg,
  ok,
  pointArg,
  type SurfaceRegistrar
} from './kernel.js';

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

export function registerBrowserTool(reg: SurfaceRegistrar): void {
  const { exposedCaps } = reg;
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
