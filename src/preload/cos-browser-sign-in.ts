/** Google sign-in panel of a CoS browser tab: its state in, button presses out. Main checks every action. */
import { contextBridge, ipcRenderer } from 'electron';
import type { CosBrowserSignInState } from '../main/cos-browser/host.js';

type SignInAction = 'choose' | 'reopen' | 'back' | 'cancel';

contextBridge.exposeInMainWorld('cosSignIn', {
  act: (action: SignInAction, value?: string): void => ipcRenderer.send('cos-browser:sign-in', action, value),
  onState: (listener: (state: CosBrowserSignInState) => void): void => {
    ipcRenderer.on('cos-browser-sign-in:state', (_event, state: CosBrowserSignInState) => listener(state));
  },
  onLeave: (listener: () => void): void => { ipcRenderer.on('cos-browser-sign-in:leave', () => listener()); }
});
