export const QUICK_CHAT_SHORTCUT = 'CommandOrControl+Shift+E';
/** The compact shell has its own UI drafts and sidebar state, but shares the durable backend. */
export const QUICK_CHAT_PARTITION = 'persist:cos-quick-chat';
export type QuickChatCapture = { kind: 'selection'; text: string; replacementAvailable: boolean; source: string; title: string; application: string } | { kind: 'screenshot'; base64?: string; text: string; title: string; application: string };
export type QuickChatAnswerRef = { id: string; turnId?: string; messageId?: string };
type Bounds = { x: number; y: number; width: number; height: number };

/** Keep the compact window reachable on the display where it was invoked, including small screens. */
export function quickChatBounds(area: Bounds, previous: Bounds | null): Bounds {
  const width = Math.min(area.width, Math.max(360, previous?.width ?? 440));
  const height = Math.min(area.height, Math.max(380, previous?.height ?? 580));
  const x = previous && previous.x < area.x + area.width && previous.x + previous.width > area.x ? previous.x : area.x + area.width - width - 16;
  const y = previous && previous.y < area.y + area.height && previous.y + previous.height > area.y ? previous.y : area.y + 16;
  return { x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)), width, height };
}
