import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { PetLibraryState } from '../src/shared/pets.js';
import authoredManifest from '../src/renderer/pet-assets/animations.json';

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; vi.unstubAllGlobals(); vi.resetModules(); });

const initial: PetLibraryState = { pets: [
  { id: 'tur-tur-sahur', displayName: 'Tur Tur Sahur', description: 'Bundled friend', kind: 'builtin', builtin: true, enabled: true, favorite: false },
  { id: 'willow', displayName: 'Willow', description: 'Forest friend', kind: 'cos', enabled: false, favorite: false, previewDataUrl: 'data:image/png;base64,c3RpbGw=' }
] };

it('renders the plugin-style library and wires import, multi-enable, favorite, delete and animated preview', async () => {
  dom = new JSDOM(`<!doctype html><body>
    <input id="petsSearch"><button id="petsImport"></button><button id="petsFormatGuide"></button>
    <dialog id="petFormatDialog"><button id="petsFormatClose"></button><button id="petsCopyInstructions"></button><pre id="petsFormatInstructions"></pre></dialog>
    <span id="petsCount"></span>
    <section id="petsFavoritesSection" hidden><span id="petsFavoritesCount"></span><div id="petsFavorites"></div></section>
    <div id="petsInstalled"></div>
  </body>`, { url: 'https://pets.test/' });
  const w = dom.window;
  for (const [key, value] of Object.entries({ window: w, document: w.document, HTMLElement: w.HTMLElement, HTMLButtonElement: w.HTMLButtonElement, HTMLDialogElement: w.HTMLDialogElement })) vi.stubGlobal(key, value);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };

  let state = structuredClone(initial);
  const petsSetFavorite = vi.fn(async (id: string, favorite: boolean) => {
    state = { pets: state.pets.map(pet => pet.id === id ? { ...pet, favorite } : pet) }; return { ok: true as const, data: state };
  });
  const petsSetEnabled = vi.fn(async (id: string, enabled: boolean) => {
    state = { pets: state.pets.map(pet => pet.id === id ? { ...pet, enabled } : pet) }; return { ok: true as const, data: state };
  });
  const petsDelete = vi.fn(async (id: string) => {
    state = { pets: state.pets.filter(pet => pet.id !== id) }; return { ok: true as const, data: state };
  });
  const petsImport = vi.fn(async () => ({ ok: true as const, data: state }));
  const petsAsset = vi.fn(async (id: string) => ({ ok: true as const, data: { id, kind: 'cos' as const, atlasDataUrl: 'data:image/png;base64,YXRsYXM=', manifest: authoredManifest } }));
  const writeClipboard = vi.fn(async (_text: string) => ({ ok: true as const, data: true }));
  const api: any = { petsList: () => Promise.resolve({ ok: true as const, data: state }), petsSetFavorite, petsSetEnabled, petsDelete, petsImport, petsAsset, writeClipboard };
  const runtime = { applyLibraryState: vi.fn() } as any;
  const { initPets } = await import('../src/renderer/pets.js'); initPets(api, runtime);

  await vi.waitFor(() => expect(w.document.querySelectorAll('.pet-library-card')).toHaveLength(2));
  expect(w.document.getElementById('petsCount')!.textContent).toContain('2 pets');
  (w.document.getElementById('petsFormatGuide') as HTMLButtonElement).click();
  expect((w.document.getElementById('petFormatDialog') as HTMLDialogElement).open).toBe(true);
  (w.document.getElementById('petsFormatClose') as HTMLButtonElement).click();
  expect((w.document.getElementById('petFormatDialog') as HTMLDialogElement).open).toBe(false);
  expect(w.document.getElementById('petsFormatInstructions')!.textContent).toContain('All 96 frame slots are present');
  expect(w.document.getElementById('petsFormatInstructions')!.textContent).toContain('every string key "69" through "84"');
  expect(w.document.getElementById('petsFormatInstructions')!.textContent).toContain('<describe your character here>');
  expect(w.document.getElementById('petsFormatInstructions')!.textContent).toContain('$hatch-pet');
  expect(w.document.getElementById('petsFormatInstructions')!.textContent).toContain('https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet');
  expect(w.document.getElementById('petsFormatInstructions')!.textContent).toContain('The skill name is the invocation');
  expect(w.document.getElementById('petsFormatInstructions')!.textContent).toContain('intentionally differs from the Codex 8×9 pet format');
  expect(w.document.getElementById('petsFormatInstructions')!.textContent).toContain('running/start → spawn');
  expect(w.document.getElementById('petsFormatInstructions')!.textContent).toContain('OpenAI → ClosedAI');
  expect(w.document.getElementById('petsFormatInstructions')!.textContent).toContain('Anthropic → trash');
  expect(w.document.getElementById('petsFormatInstructions')!.textContent).not.toContain('AI-assisted creation');
  expect(w.document.getElementById('petsFormatInstructions')!.textContent).not.toContain('Tur Tur');
  await vi.waitFor(() => expect(w.document.querySelector('[data-pet-id="willow"] .pet-library-preview-frame')!.classList.contains('is-animated')).toBe(true));
  expect(petsAsset).toHaveBeenCalledWith('willow', true);

  const willowMenu = w.document.querySelector<HTMLDetailsElement>('[data-pet-id="willow"] .plugin-menu')!;
  willowMenu.open = true;
  w.document.body.click();
  expect(willowMenu.open).toBe(false);
  willowMenu.open = true;
  willowMenu.querySelector('summary')!.click();
  expect(willowMenu.open).toBe(false);

  (w.document.querySelector('[data-pet-id="willow"] .pet-favorite') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(petsSetFavorite).toHaveBeenCalledWith('willow', true));
  await vi.waitFor(() => expect(runtime.applyLibraryState).toHaveBeenCalledWith(expect.objectContaining({ pets: expect.arrayContaining([expect.objectContaining({ id: 'willow', favorite: true })]) })));
  await vi.waitFor(() => expect(w.document.getElementById('petsFavoritesSection')!.hasAttribute('hidden')).toBe(false));
  expect(w.document.querySelectorAll('#petsFavorites [data-pet-id="willow"]')).toHaveLength(1);
  expect(w.document.querySelectorAll('#petsInstalled [data-pet-id="willow"]')).toHaveLength(0);

  (w.document.querySelector('[data-pet-id="willow"] .plugin-menu-actions .btn') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(petsSetEnabled).toHaveBeenCalledWith('willow', true));
  expect(state.pets.filter(pet => pet.enabled)).toHaveLength(2);

  (w.document.querySelector('[data-pet-id="willow"] .plugin-destructive') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(w.document.getElementById('petDialog')).not.toBeNull());
  expect(w.document.querySelector('#petDialog .pet-delete-identity h3')!.textContent).toBe('Willow');
  expect(w.document.querySelector('#petDialog .pet-delete-warning')!.textContent).toContain('local library');
  expect(w.document.activeElement).toBe(w.document.querySelector('#petDialog .pet-delete-cancel'));
  (w.document.querySelector('#petDialog .pet-delete-cancel') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(w.document.getElementById('petDialog')).toBeNull());
  expect(petsDelete).not.toHaveBeenCalled();

  (w.document.querySelector('[data-pet-id="willow"] .plugin-destructive') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(w.document.getElementById('petDialog')).not.toBeNull());
  (w.document.querySelector('#petDialog .plugin-destructive') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(petsDelete).toHaveBeenCalledWith('willow'));
  await vi.waitFor(() => expect(w.document.getElementById('petDialog')).toBeNull());

  (w.document.getElementById('petsImport') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(petsImport).toHaveBeenCalledTimes(1));

  (w.document.getElementById('petsCopyInstructions') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(writeClipboard).toHaveBeenCalledTimes(1));
  expect(writeClipboard.mock.calls[0]![0]).toBe(w.document.getElementById('petsFormatInstructions')!.textContent);
});
