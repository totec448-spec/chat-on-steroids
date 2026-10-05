/** Toolbar of a CoS browser window: its state in, tab actions out. Main checks every action. */
import { contextBridge, ipcRenderer } from 'electron';
import type { CosBrowserToolbarState } from '../main/cos-browser/host.js';

type ToolbarAction = 'activate' | 'close' | 'reload' | 'stop' | 'back' | 'forward' | 'extension';

contextBridge.exposeInMainWorld('cosBrowser', {
  act: (action: ToolbarAction, tabId?: number): void => ipcRenderer.send('cos-browser:toolbar', action, tabId),
  onState: (listener: (state: CosBrowserToolbarState) => void): void => {
    ipcRenderer.on('cos-browser:state', (_event, state: CosBrowserToolbarState) => listener(state));
  }
});
