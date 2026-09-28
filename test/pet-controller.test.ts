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

it('keeps Pets in the sidebar and Desktop Pets in the View menu', () => {
  const page = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'));
  expect(page.window.document.querySelector('#sidebarPets .ico.ph-paw-print')).not.toBeNull();
  expect(page.window.document.querySelector('#viewMenu #viewPets')).not.toBeNull();
  page.window.close();
});

it.each([
  ['shown', JSON.stringify({ visible: true, x: 10, y: 10 }), true],
  ['hidden', JSON.stringify({ visible: false, x: 10, y: 10 }), false],
  ['malformed', '{', false]
] as const)('moves a %s composer pet to the desktop once and retires its old preference', async (_name, saved, enable) => {
  dom.window.localStorage.setItem('cos.ui.turTurPet.v1', saved);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  const library: PetLibraryState = { pets: [{ id: 'tur-tur-sahur', displayName: 'Tur Tur Sahur', description: '', kind: 'builtin', builtin: true, enabled: false, favorite: false }] };
  const setEnabled = vi.fn((id: string, enabled: boolean) => ok({ pets: library.pets.map(pet => pet.id === id ? { ...pet, enabled } : pet) }));
  const api: any = { petsList: () => ok(library), petsOverlayState: () => ok({ visible: false, ready: true, activeCount: 0, activityCount: 0 }),
    petsSetOverlayVisible: vi.fn(), petsSetEnabled: setEnabled, onPetOverlayStateChanged: () => vi.fn() };
  const { initPet } = await import('../src/renderer/pet.js');
  controller = initPet(api, vi.fn());
  await controller.refresh();
  if (enable) expect(setEnabled).toHaveBeenCalledWith('tur-tur-sahur', true); else expect(setEnabled).not.toHaveBeenCalled();
  expect(dom.window.localStorage.getItem('cos.ui.turTurPet.v1')).toBeNull();
  setEnabled.mockClear();
  await controller.refresh();
  expect(setEnabled).not.toHaveBeenCalled();
});
