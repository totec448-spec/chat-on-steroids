export interface BrowserUseBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserUseTabState {
  id: number;
  active: boolean;
  loading: boolean;
  title: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserUsePermission {
  id: string;
  origin: string;
  url: string;
}

export interface BrowserUseState {
  open: boolean;
  ready: boolean;
  agentActive: boolean;
  activeTabId: number | null;
  tabs: BrowserUseTabState[];
  permission: BrowserUsePermission | null;
}

export type BrowserUseRequest =
  | { action: 'query' }
  | { action: 'show'; bounds: BrowserUseBounds }
  | { action: 'hide' }
  | { action: 'create'; url?: string }
  | { action: 'select'; tabId: number }
  | { action: 'close'; tabId: number }
  | { action: 'navigate'; tabId: number; url: string }
  | { action: 'back'; tabId: number }
  | { action: 'forward'; tabId: number }
  | { action: 'reload'; tabId: number }
  | { action: 'approve'; id: string; decision: 'once' | 'always' | 'deny' };

export interface BrowserUseElement {
  ref: string;
  tag: string;
  role: string;
  name: string;
  value?: string;
  disabled: boolean;
  checked?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserUseObservation {
  tabId: number;
  snapshotId: number;
  url: string;
  title: string;
  loading: boolean;
  viewport: { width: number; height: number };
  text: string;
  elements: BrowserUseElement[];
  screenshot?: string;
}
