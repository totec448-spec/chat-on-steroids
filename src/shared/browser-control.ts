/** Tab handles name one browser incarnation, never the selected/foreground tab. */
export const BROWSER_READ_TOOLS = ['browser_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_network'] as const;
export const BROWSER_WRITE_TOOLS = ['browser_navigate', 'browser_action', 'browser_evaluate'] as const;
export const BROWSER_TOOLS = [...BROWSER_READ_TOOLS, ...BROWSER_WRITE_TOOLS] as const;
export type BrowserTool = (typeof BROWSER_TOOLS)[number];

export const BROWSER_LIMITS = {
  clients: 8, pending: 32, timeoutMs: 25_000, presenceMs: 75_000,
  textChars: 24_000, resultBytes: 1_800_000, imageBytes: 1_200_000
} as const;

export interface BrowserCommand {
  id: string;
  epoch: string;
  owner: string;
  conversationId: string | null;
  tool: BrowserTool;
  args: Record<string, unknown>;
  expiresAt: number;
}

export interface BrowserResult {
  value?: unknown;
  image?: { data: string; mimeType: 'image/jpeg' | 'image/png' };
  error?: string;
}

/** Tabs lifecycle contains both observation/custody and page mutations. */
export function browserToolWrites(tool: BrowserTool, args: Record<string, unknown>): boolean {
  return (BROWSER_WRITE_TOOLS as readonly string[]).includes(tool) ||
    (tool === 'browser_tabs' && ['new', 'close'].includes(String(args.action)));
}
