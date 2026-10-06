import type { MainText } from '../shared/main-texts.js';
import type { SurfaceId } from './mcp/surfaces.js';

interface Notice {
  on(event: 'click', listener: () => void): unknown;
  show(): void;
}

export interface ConnectionLossNoticeDeps {
  isQuitting(): boolean;
  isFocused(): boolean;
  isSupported(): boolean;
  text(source: MainText): string;
  create(options: { title: string; body: string }): Notice;
  showWindow(): void;
}

const TITLES: Record<SurfaceId, MainText> = {
  core: 'Core connection lost',
  desktop: 'Desktop connection lost',
  plugins: 'Plugins connection lost'
};

const BODY: MainText = 'The tunnel disconnected unexpectedly. Open Chat On Steroids to check the connection.';

/** Electron presentation adapter kept separate from connection lifecycle/state. */
export function showConnectionLossNotice(surface: SurfaceId, deps: ConnectionLossNoticeDeps): boolean {
  if (deps.isQuitting() || deps.isFocused() || !deps.isSupported()) return false;
  const notice = deps.create({ title: deps.text(TITLES[surface]), body: deps.text(BODY) });
  notice.on('click', deps.showWindow);
  notice.show();
  return true;
}
