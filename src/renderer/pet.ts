import type { AppApi } from '../preload/index.js';
import type { PetLibraryState, PetOverlayControlState } from '../shared/pets.js';

export interface PetController {
  (): void;
  toggle(): void;
  isVisible(): boolean;
  isReady(): boolean;
  refresh(): Promise<void>;
  applyLibraryState(state: PetLibraryState): void;
}

/** Thin main-window controller. All visual/runtime work lives in the native desktop overlay. */
export function initPet(api: AppApi, openLibrary: () => void): PetController {
  let disposed = false;
  let library: PetLibraryState = { pets: [] };
  let overlay: PetOverlayControlState = { visible: false, ready: true, activeCount: 0, activityCount: 0 };

  const activeCount = (): number => library.pets.filter(pet => pet.enabled).length;
  const applyLibraryState = (next: PetLibraryState): void => { library = next; };
  const applyOverlayState = (next: PetOverlayControlState): void => { overlay = next; };
  const stopOverlay = api.onPetOverlayStateChanged(applyOverlayState);

  const refresh = async (): Promise<void> => {
    const [libraryReply, overlayReply] = await Promise.all([api.petsList(), api.petsOverlayState()]);
    if (disposed) return;
    if (libraryReply.ok) applyLibraryState(libraryReply.data);
    if (overlayReply.ok) applyOverlayState(overlayReply.data);
  };

  const toggle = (): void => {
    if (!activeCount()) { openLibrary(); return; }
    const wanted = !overlay.visible;
    applyOverlayState({ ...overlay, visible: wanted, ready: wanted ? overlay.ready : true });
    void api.petsSetOverlayVisible(wanted).then(reply => {
      if (!disposed && reply.ok) applyOverlayState(reply.data);
    });
  };

  const dispose = (): void => {
    disposed = true;
    stopOverlay();
  };
  void refresh();
  return Object.assign(dispose, {
    toggle,
    isVisible: () => overlay.visible && activeCount() > 0,
    isReady: () => overlay.ready,
    refresh,
    applyLibraryState
  });
}
