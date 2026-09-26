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

export interface BrowserUseDesignSourceCandidate {
  kind: 'component' | 'style';
  framework: 'React' | 'Vue' | 'CSS';
  label: string;
  url: string;
  line: number | null;
  column: number | null;
}

export interface BrowserUseDesignSelection {
  id: number;
  tag: string;
  role: string;
  name: string;
  selector: string;
  classes: string[];
  width: number;
  height: number;
  boxModel: {
    margin: [string, string, string, string];
    border: [string, string, string, string];
    padding: [string, string, string, string];
    contentWidth: number;
    contentHeight: number;
  };
  styles: Array<{ property: string; value: string }>;
  sources: BrowserUseDesignSourceCandidate[];
}

export interface BrowserUseDesignContext {
  tabId: number;
  selectionId: number;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  selection: BrowserUseDesignSelection;
  screenshot: {
    name: string;
    dataUrl: string;
    width: number;
    height: number;
  };
}

export interface BrowserUseDesignState {
  active: boolean;
  tabId: number | null;
  selection: BrowserUseDesignSelection | null;
}

export interface BrowserUseState {
  open: boolean;
  ready: boolean;
  agentActive: boolean;
  activeTabId: number | null;
  tabs: BrowserUseTabState[];
  permission: BrowserUsePermission | null;
  design: BrowserUseDesignState;
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
  | { action: 'inspect'; tabId: number; enabled: boolean }
  | { action: 'approve'; id: string; decision: 'once' | 'always' | 'deny' };

export interface BrowserUseElement {
  ref: string;
  tag: string;
  role: string;
  name: string;
  href?: string;
  context?: string;
  value?: string;
  disabled: boolean;
  checked?: boolean | 'mixed';
  expanded?: boolean;
  pressed?: boolean | 'mixed';
  selected?: boolean;
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
