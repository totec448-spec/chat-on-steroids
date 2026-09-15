export interface InternalBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type InternalBrowserDockRequest =
  | { action: 'query' }
  | { action: 'show'; bounds: InternalBrowserBounds }
  | { action: 'layout'; bounds: InternalBrowserBounds }
  | { action: 'hide' }
  | { action: 'select'; tabId: number }
  | { action: 'close'; tabId: number };

export interface InternalBrowserTabState {
  id: number;
  active: boolean;
  status: 'loading' | 'complete';
  title: string;
  url: string;
}

export interface InternalBrowserDockState {
  open: boolean;
  ready: boolean;
  tabId: number | null;
  tabs: InternalBrowserTabState[];
}
