import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PetLibraryState, PetOverlayControlState } from '../src/shared/pets.js';
import type { PetController } from '../src/renderer/pet.js';

let dom: JSDOM; let controller: PetController | undefined;
const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
beforeEach(() => {
  dom = new JSDOM('<body><div class="composer-toolbar"><div class="composer-options"></div></div></body>', { url: 'https://pet-controller.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
});
afterEach(() => { controller?.(); controller = undefined; dom.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it('keeps the main renderer as a thin overlay controller', async () => {
  const library: PetLibraryState = { pets: [{ id: 'tur-tur-sahur', displayName: 'Tur Tur Sahur', description: '', kind: 'builtin', builtin: true, enabled: true, favorite: false }] };
  let state: PetOverlayControlState = { visible: true, ready: true, activeCount: 1, activityCount: 2 };
  let onState: ((next: PetOverlayControlState) => void) | null = null;
  const openLibrary = vi.fn();
  const setVisible = vi.fn((visible: boolean) => { state = { ...state, visible }; return ok(state); });
  const api: any = {
    petsList: () => ok(library), petsOverlayState: () => ok(state), petsSetOverlayVisible: setVisible,
    onPetOverlayStateChanged: (listener: (next: PetOverlayControlState) => void) => { onState = listener; return vi.fn(); }
  };
  const { initPet } = await import('../src/renderer/pet.js');
  controller = initPet(api, openLibrary); await Promise.resolve(); await Promise.resolve();
  expect(dom.window.document.getElementById('petLauncher')).toBeNull();
  expect(controller.isVisible()).toBe(true); expect(dom.window.document.querySelector('.pet-layer')).toBeNull();
  controller.toggle(); expect(setVisible).toHaveBeenCalledWith(false);
  onState!({ ...state, visible: true }); expect(controller.isVisible()).toBe(true);
});

it('opens the library when no pet is enabled', async () => {
  const library: PetLibraryState = { pets: [{ id: 'tur-tur-sahur', displayName: 'Tur Tur Sahur', description: '', kind: 'builtin', builtin: true, enabled: false, favorite: false }] };
  const openLibrary = vi.fn(); const setVisible = vi.fn();
  const api: any = { petsList: () => ok(library), petsOverlayState: () => ok({ visible: false, ready: true, activeCount: 0, activityCount: 0 }), petsSetOverlayVisible: setVisible, onPetOverlayStateChanged: () => vi.fn() };
  const { initPet } = await import('../src/renderer/pet.js'); controller = initPet(api, openLibrary); await Promise.resolve(); await Promise.resolve();
  controller.toggle(); expect(openLibrary).toHaveBeenCalledTimes(1); expect(setVisible).not.toHaveBeenCalled();
});

it('restores a temporarily hidden active pet through the View toggle', async () => {
  const library: PetLibraryState = { pets: [{ id: 'tur-tur-sahur', displayName: 'Tur Tur Sahur', description: '', kind: 'builtin', builtin: true, enabled: true, favorite: false }] };
  let state: PetOverlayControlState = { visible: false, ready: true, activeCount: 1, activityCount: 0 };
  const openLibrary = vi.fn();
  const setVisible = vi.fn((visible: boolean) => { state = { ...state, visible }; return ok(state); });
  const api: any = {
    petsList: () => ok(library), petsOverlayState: () => ok(state), petsSetOverlayVisible: setVisible,
    onPetOverlayStateChanged: () => vi.fn()
  };
  const { initPet } = await import('../src/renderer/pet.js');
  controller = initPet(api, openLibrary); await Promise.resolve(); await Promise.resolve();
  expect(controller.isVisible()).toBe(false);
  controller.toggle();
  expect(setVisible).toHaveBeenCalledWith(true);
  expect(openLibrary).not.toHaveBeenCalled();
});

it('keeps Pets in the sidebar and gives the Chats action the refresh glyph', () => {
  const page = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'));
  expect(page.window.document.querySelector('#sidebarPets .ph-paw-print')).not.toBeNull();
  expect(page.window.document.querySelector('#chatRefresh .ph-arrow-clockwise')).not.toBeNull();
  page.window.close();
});
