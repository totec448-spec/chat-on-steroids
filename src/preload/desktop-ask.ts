import { contextBridge, ipcRenderer } from 'electron';

/** The ask-before-mouse-and-keyboard question (#1804): its page can only answer it. */
contextBridge.exposeInMainWorld('cosAsk', {
  answer: (choice: 'go' | 'not-now'): void => ipcRenderer.send('desktop-ask:answer', choice === 'go' ? 'go' : 'not-now')
});
