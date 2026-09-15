import { z } from 'zod';
import {
  browserUseAgentOverview,
  browserUseHistory,
  BrowserUseProtocolError,
  clickBrowserUseRef,
  closeBrowserUseTab,
  finishBrowserUseAgentMission,
  hoverBrowserUseRef,
  keyBrowserUseTab,
  navigateBrowserUseTab,
  observeBrowserUseTab,
  openBrowserUseTab,
  requestBrowserUsePanel,
  scrollBrowserUseTab,
  touchBrowserUseAgentMission,
  typeBrowserUseRef,
  withBrowserUseAgentActivity
} from '../browser-use.js';
import { fail, type SurfaceRegistrar, type ToolContent, type ToolResult } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';

const tabId = z.number().int().positive();
const snapshotId = z.number().int().positive();
const elementRef = z.string().regex(/^e\d+$/);

/**
 * One compact schema instead of one object per action. Core discovery is a scarce surface; the
 * refinement keeps action-specific validation exact without repeating tab_id/ref descriptions in
 * tools/list a dozen times.
 */
const inputSchema = z.object({
  action: z.enum(['list', 'open', 'close', 'navigate', 'back', 'forward', 'reload', 'state', 'click', 'hover', 'type', 'key', 'scroll', 'wait', 'done']),
  tab_id: tabId.optional(),
  url: z.string().min(1).max(4096).optional(),
  snapshot_id: snapshotId.optional(),
  ref: elementRef.optional(),
  text: z.string().max(20_000).optional(),
  replace: z.boolean().optional(),
  key: z.string().min(1).max(80).optional(),
  delta_y: z.number().finite().min(-10_000).max(10_000).optional(),
  screenshot: z.boolean().optional(),
  compact: z.boolean().optional(),
  ms: z.number().int().min(50).max(5000).optional()
}).strict().superRefine((input, ctx) => {
  if (!['list', 'open', 'done', 'state'].includes(input.action) && input.tab_id === undefined) {
    ctx.addIssue({ code: 'custom', path: ['tab_id'], message: `${input.action} requires tab_id` });
  }
  if (input.action === 'navigate' && input.url === undefined) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'navigate requires url' });
  }
  if (['click', 'hover', 'type', 'key', 'scroll'].includes(input.action) && input.snapshot_id === undefined) {
    ctx.addIssue({ code: 'custom', path: ['snapshot_id'], message: `${input.action} requires snapshot_id from the latest state` });
  }
  if (['click', 'hover', 'type'].includes(input.action) && input.ref === undefined) {
    ctx.addIssue({ code: 'custom', path: ['ref'], message: `${input.action} requires ref` });
  }
  if (input.action === 'type' && input.text === undefined) ctx.addIssue({ code: 'custom', path: ['text'], message: 'type requires text' });
  if (input.action === 'key' && input.key === undefined) ctx.addIssue({ code: 'custom', path: ['key'], message: 'key requires key' });
  if (input.action === 'scroll' && input.delta_y === undefined) ctx.addIssue({ code: 'custom', path: ['delta_y'], message: 'scroll requires delta_y' });
  if (input.action === 'wait' && input.ms === undefined) ctx.addIssue({ code: 'custom', path: ['ms'], message: 'wait requires ms' });
});

function valueResult(value: unknown, images: ToolContent[] = []): ToolResult {
  const normalized = value ?? null;
  return {
    content: [{ type: 'text', text: JSON.stringify(normalized) }, ...images],
    structuredContent: { value: normalized }
  };
}

function protocolErrorResult(error: BrowserUseProtocolError): ToolResult {
  const value = { error: error.code, message: error.message };
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true
  };
}

export function registerBrowserTool(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.browserUse) return;
  reg.register(
    'browser',
    toolDeclaration('browser', () => ({
      title: 'Browser Use',
      description:
        'Browser Use. state may omit tab_id to bind the current active tab. compact omits text. Reobserve after actions; done ends mission.',
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    })),
    async input => reg.guarded('browserUse', 'browser', async () => {
      try {
        if (input.action === 'list') {
          touchBrowserUseAgentMission();
          const overview = browserUseAgentOverview();
          return valueResult({ tabs: overview.tabs, active_tab_id: overview.activeTabId, mission_active: overview.agentActive });
        }
        if (input.action === 'done') {
          await finishBrowserUseAgentMission();
          return valueResult({ done: true, mission_active: false });
        }
        return await withBrowserUseAgentActivity(async () => {
          if (input.action === 'open') {
            await openBrowserUseTab(input.url, 'agent');
            const overview = browserUseAgentOverview();
            return valueResult({ tabs: overview.tabs, active_tab_id: overview.activeTabId, mission_active: true });
          }
          if (input.action === 'close') {
            closeBrowserUseTab(input.tab_id!);
            const overview = browserUseAgentOverview();
            return valueResult({ tabs: overview.tabs, active_tab_id: overview.activeTabId, mission_active: true });
          }
          if (input.action === 'navigate') {
            requestBrowserUsePanel();
            await navigateBrowserUseTab(input.tab_id!, input.url!, 'agent');
            return valueResult({ tab_id: input.tab_id!, tabs: browserUseAgentOverview().tabs, mission_active: true });
          }
          if (input.action === 'back' || input.action === 'forward' || input.action === 'reload') {
            requestBrowserUsePanel();
            await browserUseHistory(input.tab_id!, input.action, 'agent');
            return valueResult({ tab_id: input.tab_id!, tabs: browserUseAgentOverview().tabs, mission_active: true });
          }
          if (input.action === 'state') {
            const tabId = input.tab_id ?? browserUseAgentOverview().activeTabId;
            if (tabId === null) return fail('NO_ACTIVE_TAB: Browser Use has no active tab. Open a tab before observing.');
            const observed = await observeBrowserUseTab(tabId, input.screenshot === true, input.compact !== true);
            const { screenshot, text, ...metadata } = observed;
            return valueResult(
              { ...metadata, ...(input.compact === true ? {} : { text }), mission_active: true },
              screenshot ? [{ type: 'image', mimeType: 'image/png', data: screenshot }] : []
            );
          }
          if (input.action === 'click') {
            await clickBrowserUseRef(input.tab_id!, input.snapshot_id!, input.ref!);
            return valueResult({ tab_id: input.tab_id!, action: 'click', ref: input.ref!, next: 'state', mission_active: true });
          }
          if (input.action === 'hover') {
            await hoverBrowserUseRef(input.tab_id!, input.snapshot_id!, input.ref!);
            return valueResult({ tab_id: input.tab_id!, action: 'hover', ref: input.ref!, next: 'state', mission_active: true });
          }
          if (input.action === 'type') {
            await typeBrowserUseRef(input.tab_id!, input.snapshot_id!, input.ref!, input.text!, input.replace !== false);
            return valueResult({ tab_id: input.tab_id!, action: 'type', ref: input.ref!, next: 'state', mission_active: true });
          }
          if (input.action === 'key') {
            await keyBrowserUseTab(input.tab_id!, input.snapshot_id!, input.key!, input.ref);
            return valueResult({ tab_id: input.tab_id!, action: 'key', key: input.key!, next: 'state', mission_active: true });
          }
          if (input.action === 'scroll') {
            await scrollBrowserUseTab(input.tab_id!, input.snapshot_id!, input.delta_y!, input.ref);
            return valueResult({ tab_id: input.tab_id!, action: 'scroll', next: 'state', mission_active: true });
          }
          if (input.action === 'wait') {
            requestBrowserUsePanel();
            await new Promise(resolve => setTimeout(resolve, input.ms!));
            return valueResult({ tab_id: input.tab_id!, waited_ms: input.ms!, next: 'state', mission_active: true });
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
