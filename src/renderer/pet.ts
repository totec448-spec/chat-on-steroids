import type { AppApi } from '../preload/index.js';
import type { PetLibraryState, PetOverlayControlState } from '../shared/pets.js';

/** The composer pet's old preference, and the built-in pet it becomes on the desktop. */
const COMPOSER_PET_KEY = 'cos.ui.turTurPet.v1';
const BUILTIN_PET_ID = 'tur-tur-sahur';

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
    if (libraryReply.ok) await adoptComposerPet();
  };

  // Until 2.1.16 the built-in pet lived inside the composer and remembered whether it was shown.
  // Whoever had it out keeps it: it moves to the desktop once, and the old preference is retired.
  const adoptComposerPet = async (): Promise<void> => {
    let shown = false;
    try {
      const raw = localStorage.getItem(COMPOSER_PET_KEY);
      if (raw === null) return;
      shown = (JSON.parse(raw) as { visible?: unknown } | null)?.visible === true;
    } catch { /* A malformed or unavailable preference means nothing to carry over. */ }
    try { localStorage.removeItem(COMPOSER_PET_KEY); } catch { /* Retried on the next launch. */ }
    const builtin = library.pets.find(pet => pet.id === BUILTIN_PET_ID);
    if (!shown || !builtin || builtin.enabled || disposed) return;
    const reply = await api.petsSetEnabled(BUILTIN_PET_ID, true);
    if (!disposed && reply.ok) applyLibraryState(reply.data);
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
