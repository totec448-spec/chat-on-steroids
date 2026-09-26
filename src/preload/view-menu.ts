import { contextBridge, ipcRenderer } from 'electron';
import type { ViewMenuCommand, ViewMenuSnapshot } from '../shared/view-menu.js';

const api = {
  command: (command: ViewMenuCommand): void => ipcRenderer.send('viewMenu:command', command),
  close: (): void => ipcRenderer.send('viewMenu:close'),
  onSnapshot: (listener: (snapshot: ViewMenuSnapshot) => void): (() => void) => {
    const wrapped = (_event: unknown, snapshot: ViewMenuSnapshot): void => listener(snapshot);
    ipcRenderer.on('viewMenu:snapshot', wrapped);
    return () => ipcRenderer.removeListener('viewMenu:snapshot', wrapped);
  }
};

export type ViewMenuApi = typeof api;
contextBridge.exposeInMainWorld('viewMenuApi', api);
