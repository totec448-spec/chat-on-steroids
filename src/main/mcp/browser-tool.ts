import { z } from 'zod';
import {
  browserUseAgentOverview,
  browserUseAgentPendingApproval,
  browserUseHistory,
  BrowserUseProtocolError,
  closeBrowserUseTab,
  finishBrowserUseAgentMission,
  keyBrowserUseTab,
  navigateBrowserUseTab,
  observeBrowserUseTab,
  openBrowserUseTab,
  performBrowserUsePointerAction,
  requestBrowserUsePanel,
  scrollBrowserUseTab,
  selectBrowserUseTab,
  touchBrowserUseAgentMission,
  typeBrowserUseRef,
  waitForBrowserUseTab,
  withBrowserUseAgentActivity
} from '../browser-use.js';
import { fail, type SurfaceRegistrar, type ToolContent, type ToolResult } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';
import { BROWSER_SURFACE_ROUTING, BROWSER_USE_SCOPE } from '../../shared/browser-routing.js';

const tabId = z.number().int().positive();
const snapshotId = z.number().int().positive();
const elementRef = z.string().regex(/^e\d+$/);

/**
 * One compact schema instead of one object per action. Core discovery is a scarce surface; the
 * refinement keeps action-specific validation exact without repeating tab_id/ref descriptions in
 * tools/list a dozen times.
 */
const inputSchema = z.object({
  action: z.enum(['list', 'open', 'close', 'select', 'navigate', 'back', 'forward', 'reload', 'state', 'click', 'double_click', 'hover', 'move', 'drag', 'swipe', 'long_press', 'type', 'key', 'scroll', 'wait', 'done'])
    .describe('Use list/state to inspect, an explicit control action to act, and done to finish the mission.'),
  tab_id: tabId.optional().describe('Required except for list, open, done, and state on the active tab.'),
  url: z.string().min(1).max(4096).optional(),
  snapshot_id: snapshotId.optional().describe('Latest snapshot_id from state; required by every input action, including scroll.'),
  ref: elementRef.optional(),
  x: z.number().finite().min(0).max(100_000).optional(),
  y: z.number().finite().min(0).max(100_000).optional(),
  target_ref: elementRef.optional(),
  target_x: z.number().finite().min(0).max(100_000).optional(),
  target_y: z.number().finite().min(0).max(100_000).optional(),
  pointer: z.enum(['mouse', 'touch']).optional(),
  duration_ms: z.number().int().min(50).max(5000).optional(),
  text: z.string().max(20_000).optional(),
  replace: z.boolean().optional(),
  key: z.string().min(1).max(80).optional(),
  delta_y: z.number().finite().min(-10_000).max(10_000).optional(),
  screenshot: z.boolean().optional(),
  compact: z.boolean().optional(),
  ms: z.number().int().min(50).max(5000).optional().describe('Wait bound in milliseconds. wait defaults to 1000 when omitted.')
}).strict().superRefine((input, ctx) => {
  if (!['list', 'open', 'done', 'state'].includes(input.action) && input.tab_id === undefined) {
    ctx.addIssue({ code: 'custom', path: ['tab_id'], message: `${input.action} requires tab_id` });
  }
  if (input.action === 'navigate' && input.url === undefined) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'navigate requires url' });
  }
  if (['click', 'double_click', 'hover', 'move', 'drag', 'swipe', 'long_press', 'type', 'key', 'scroll'].includes(input.action) && input.snapshot_id === undefined) {
    ctx.addIssue({ code: 'custom', path: ['snapshot_id'], message: `${input.action} requires snapshot_id from the latest state` });
  }
  const hasPoint = input.x !== undefined && input.y !== undefined;
  const hasPartialPoint = (input.x !== undefined) !== (input.y !== undefined);
  const hasTargetPoint = input.target_x !== undefined && input.target_y !== undefined;
  const hasPartialTargetPoint = (input.target_x !== undefined) !== (input.target_y !== undefined);
  if (hasPartialPoint) ctx.addIssue({ code: 'custom', path: ['x'], message: 'x and y must be supplied together' });
  if (hasPartialTargetPoint) ctx.addIssue({ code: 'custom', path: ['target_x'], message: 'target_x and target_y must be supplied together' });
  if (['click', 'double_click', 'hover', 'move', 'long_press'].includes(input.action) && input.ref === undefined && !hasPoint) {
    ctx.addIssue({ code: 'custom', path: ['ref'], message: `${input.action} requires ref or x and y` });
  }
  if (['drag', 'swipe'].includes(input.action)) {
    if (input.ref === undefined && !hasPoint) ctx.addIssue({ code: 'custom', path: ['ref'], message: `${input.action} requires a start ref or x and y` });
    if (input.target_ref === undefined && !hasTargetPoint) ctx.addIssue({ code: 'custom', path: ['target_ref'], message: `${input.action} requires target_ref or target_x and target_y` });
  }
  if (input.action === 'type' && input.ref === undefined) ctx.addIssue({ code: 'custom', path: ['ref'], message: 'type requires ref' });
  if (input.action === 'type' && input.text === undefined) ctx.addIssue({ code: 'custom', path: ['text'], message: 'type requires text' });
  if (input.action === 'key' && input.key === undefined) ctx.addIssue({ code: 'custom', path: ['key'], message: 'key requires key' });
  if (input.action === 'scroll' && input.delta_y === undefined) ctx.addIssue({ code: 'custom', path: ['delta_y'], message: 'scroll requires delta_y' });
});

function pointerTarget(input: z.infer<typeof inputSchema>, target = false): { ref: string } | { x: number; y: number } {
  const ref = target ? input.target_ref : input.ref;
  if (ref) return { ref };
  return target ? { x: input.target_x!, y: input.target_y! } : { x: input.x!, y: input.y! };
}

function valueResult(value: unknown, images: ToolContent[] = []): ToolResult {
  const normalized = value ?? null;
  return {
    content: [{ type: 'text', text: JSON.stringify(normalized) }, ...images],
    structuredContent: { value: normalized }
  };
}

function protocolErrorResult(error: BrowserUseProtocolError): ToolResult {
  const recoverable = error.code === 'APPROVAL_REQUIRED' || error.code === 'APPROVAL_PENDING' ||
    error.code === 'STALE_BROWSER_STATE' || error.code === 'BROWSER_STATE_TIMEOUT';
  const value = {
    status: error.code === 'STALE_BROWSER_STATE' ? 'target_lost' :
      error.code === 'BROWSER_STATE_TIMEOUT' ? 'timeout' : recoverable ? 'approval_required' : 'blocked',
    error: error.code,
    message: error.message,
    ...error.details
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(recoverable ? {} : { isError: true })
  };
}

function actionResult(tabId: number, action: string, extra: Record<string, unknown> = {}): ToolResult {
  const overview = browserUseAgentOverview();
  const tab = overview.tabs.find(candidate => candidate.id === tabId) ?? null;
  return valueResult({
    status: action === 'select' ? 'success' : 'action_dispatched',
    tab_id: tabId,
    action,
    tab,
    verification: action === 'select' ? 'selected' : 'state_required',
    next: tab && tab.loading === true ? 'wait' : 'state',
    mission_active: true,
    ...extra
  });
}

export function registerBrowserTool(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.browserUse) return;
  reg.register(
    'browser',
    toolDeclaration('browser', () => ({
      title: 'Browser Use',
      description:
        `${BROWSER_USE_SCOPE} ${BROWSER_SURFACE_ROUTING} Start with list; list/state stay passive after done. select changes tabs explicitly. state returns snapshot_id; every input action (click, double_click, hover, move, drag, swipe, long_press, type, key, scroll) requires that latest snapshot_id. Navigation, reload, resize, or one completed input invalidates it. Follow the returned next action: loading means wait, then state; wait defaults to 1000 ms when ms is omitted. New origins return approval_required immediately; after the user approves in the panel, retry the supplied navigation. state observes without selecting; prefer compact=true for target discovery and revalidation, and request full page text only when needed. Inside exec, emit result.structuredContent.value instead of the whole nested result to avoid duplicating the payload. done ends only the agent-driving mission; it does not close the panel or tabs.`,
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    })),
    async input => reg.guarded('browserUse', 'browser', async () => {
      try {
        if (input.action === 'list') {
          touchBrowserUseAgentMission();
          const overview = browserUseAgentOverview();
          return valueResult({ status: 'observed', tabs: overview.tabs, active_tab_id: overview.activeTabId, mission_active: overview.agentActive });
        }
        if (input.action === 'done') {
          await finishBrowserUseAgentMission();
          const overview = browserUseAgentOverview();
          return valueResult({
            status: 'mission_finished',
            done: true,
            mission_active: false,
            tabs_preserved: true,
            panel_closed: false,
            tabs: overview.tabs,
            active_tab_id: overview.activeTabId
          });
        }
        if (input.action === 'state') {
          touchBrowserUseAgentMission();
          const tabId = input.tab_id ?? browserUseAgentOverview().activeTabId;
          if (tabId === null) {
            const overview = browserUseAgentOverview();
            return valueResult({
              status: 'no_active_tab',
              tabs: overview.tabs,
              active_tab_id: null,
              next: 'open',
              message: 'Browser Use has no active tab. Open one before observing.',
              mission_active: overview.agentActive
            });
          }
          const pendingApproval = browserUseAgentPendingApproval();
          if (pendingApproval?.tab_id === tabId) {
            return valueResult({ ...pendingApproval, mission_active: browserUseAgentOverview().agentActive });
          }
          const projected = browserUseAgentOverview().tabs.find(tab => tab.id === tabId);
          if (projected?.loading === true) return valueResult({
            status: 'loading',
            tab_id: tabId,
            tab: projected,
            next: 'wait',
            message: 'The selected tab is still loading. Wait for its loading boundary before observing.',
            mission_active: browserUseAgentOverview().agentActive
          });
          const observed = await observeBrowserUseTab(tabId, input.screenshot === true, input.compact !== true);
          const { screenshot, text, ...metadata } = observed;
          return valueResult(
            {
              status: 'observed',
              ...metadata,
              ...(input.compact === true ? {} : { text }),
              mission_active: browserUseAgentOverview().agentActive
            },
            screenshot ? [{ type: 'image', mimeType: 'image/png', data: screenshot }] : []
          );
        }
        return await withBrowserUseAgentActivity(async () => {
          if (input.action === 'open') {
            await openBrowserUseTab(input.url, 'agent');
            const overview = browserUseAgentOverview();
            if (overview.activeTabId === null) return valueResult({ status: 'no_active_tab', tabs: overview.tabs, active_tab_id: null, next: 'open', mission_active: true });
            return actionResult(overview.activeTabId, 'open');
          }
          if (input.action === 'close') {
            closeBrowserUseTab(input.tab_id!);
            const overview = browserUseAgentOverview();
            return valueResult({ status: 'success', action: 'close', closed_tab_id: input.tab_id!, tabs: overview.tabs, active_tab_id: overview.activeTabId, mission_active: true });
          }
          if (input.action === 'select') {
            requestBrowserUsePanel();
            selectBrowserUseTab(input.tab_id!);
            return actionResult(input.tab_id!, 'select');
          }
          if (input.action === 'navigate') {
            requestBrowserUsePanel();
            await navigateBrowserUseTab(input.tab_id!, input.url!, 'agent');
            return actionResult(input.tab_id!, 'navigate');
          }
          if (input.action === 'back' || input.action === 'forward' || input.action === 'reload') {
            requestBrowserUsePanel();
            const before = browserUseAgentOverview().tabs.find(tab => tab.id === input.tab_id!);
            if ((input.action === 'back' && before?.can_go_back === false) ||
                (input.action === 'forward' && before?.can_go_forward === false)) {
              return valueResult({ status: 'no_effect', tab_id: input.tab_id!, action: input.action, tab: before ?? null, next: 'state', mission_active: true });
            }
            await browserUseHistory(input.tab_id!, input.action, 'agent');
            return actionResult(input.tab_id!, input.action);
          }
          if (input.action === 'click' || input.action === 'double_click' || input.action === 'hover' || input.action === 'move' || input.action === 'long_press') {
            const kind = input.action === 'double_click' ? 'click' : input.action === 'hover' ? 'move' : input.action;
            await performBrowserUsePointerAction(input.tab_id!, input.snapshot_id!, {
              kind,
              target: pointerTarget(input),
              ...(kind === 'click' ? { count: input.action === 'double_click' ? 2 as const : 1 as const, pointer: input.pointer } : {}),
              ...(kind === 'long_press' ? { durationMs: input.duration_ms, pointer: input.pointer } : {}),
              ...(kind === 'move' ? { durationMs: input.duration_ms } : {})
            });
            return actionResult(input.tab_id!, input.action, { target: pointerTarget(input) });
          }
          if (input.action === 'drag' || input.action === 'swipe') {
            await performBrowserUsePointerAction(input.tab_id!, input.snapshot_id!, {
              kind: input.action,
              from: pointerTarget(input),
              to: pointerTarget(input, true),
              durationMs: input.duration_ms,
              pointer: input.pointer
            });
            return actionResult(input.tab_id!, input.action, { from: pointerTarget(input), to: pointerTarget(input, true) });
          }
          if (input.action === 'type') {
            await typeBrowserUseRef(input.tab_id!, input.snapshot_id!, input.ref!, input.text!, input.replace !== false);
            return actionResult(input.tab_id!, 'type', { ref: input.ref! });
          }
          if (input.action === 'key') {
            await keyBrowserUseTab(input.tab_id!, input.snapshot_id!, input.key!, input.ref);
            return actionResult(input.tab_id!, 'key', { key: input.key! });
          }
          if (input.action === 'scroll') {
            await scrollBrowserUseTab(input.tab_id!, input.snapshot_id!, input.delta_y!, input.ref);
            return actionResult(input.tab_id!, 'scroll');
          }
          if (input.action === 'wait') {
            requestBrowserUsePanel();
            const waitMs = input.ms ?? 1000;
            const status = await waitForBrowserUseTab(input.tab_id!, waitMs);
            return valueResult({
              status,
              tab_id: input.tab_id!,
              waited_ms: waitMs,
              tab: browserUseAgentOverview().tabs.find(tab => tab.id === input.tab_id!) ?? null,
              next: 'state',
              mission_active: true
            });
          }
          return fail('Unknown browser action.');
        });
      } catch (error) {
        if (error instanceof BrowserUseProtocolError) return protocolErrorResult(error);
        return fail(error instanceof Error ? error.message : String(error));
      }
    })
  );
}
