/** Ports discoverable by the companion extension without additional host permissions. */
export const BROWSER_BRIDGE_PORTS = [8765, 8766, 8767, 8768, 8769] as const;
export type BrowserBridgePort = 'auto' | (typeof BROWSER_BRIDGE_PORTS)[number];
