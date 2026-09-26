import { contextBridge, ipcRenderer } from 'electron';
import type { PetLibraryState, PetOverlayBounds, PetOverlayHitRegion, PetOverlayPointer, PetOverlaySnapshot, PetRuntimeAsset } from '../shared/pets.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
const call = <T>(channel: string, payload?: unknown): Promise<Reply<T>> => ipcRenderer.invoke(channel, payload) as Promise<Reply<T>>;

const api = {
  listPets: () => call<PetLibraryState>('pets:list'),
  petAsset: (id: string) => call<PetRuntimeAsset>('pets:asset', { id, preview: false }),
  hidePet: (id: string): void => ipcRenderer.send('pet-overlay:hidePet', id),
  setInteractive: (interactive: boolean, regions: PetOverlayHitRegion[] = []): void =>
    ipcRenderer.send('pet-overlay:interactive', { interactive: interactive === true, regions }),
  focusOwner: (): void => ipcRenderer.send('pet-overlay:focusOwner'),
  openLibrary: (): void => ipcRenderer.send('pet-overlay:openLibrary'),
  openActivity: (sessionId: string): void => ipcRenderer.send('pet-overlay:openActivity', { sessionId }),
  onSnapshot: (listener: (snapshot: PetOverlaySnapshot) => void): (() => void) => {
    const wrapped = (_event: unknown, snapshot: PetOverlaySnapshot): void => listener(snapshot);
    ipcRenderer.on('pet-overlay:snapshot', wrapped);
    return () => ipcRenderer.removeListener('pet-overlay:snapshot', wrapped);
  },
  onLibraryChanged: (listener: (state: PetLibraryState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: PetLibraryState): void => listener(state);
    ipcRenderer.on('pet-overlay:libraryChanged', wrapped);
    return () => ipcRenderer.removeListener('pet-overlay:libraryChanged', wrapped);
  },
  onPointer: (listener: (point: PetOverlayPointer) => void): (() => void) => {
    const wrapped = (_event: unknown, point: PetOverlayPointer): void => listener(point);
    ipcRenderer.on('pet-overlay:pointer', wrapped);
    return () => ipcRenderer.removeListener('pet-overlay:pointer', wrapped);
  },
  onBounds: (listener: (bounds: PetOverlayBounds) => void): (() => void) => {
    const wrapped = (_event: unknown, bounds: PetOverlayBounds): void => listener(bounds);
    ipcRenderer.on('pet-overlay:bounds', wrapped);
    return () => ipcRenderer.removeListener('pet-overlay:bounds', wrapped);
  }
};

export type PetOverlayApi = typeof api;
contextBridge.exposeInMainWorld('petApi', api);
