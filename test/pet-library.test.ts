import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import authoredManifest from '../src/renderer/pet-assets/animations.json';

const durable = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../src/main/durable.js', () => ({
  readDurable: async () => durable.value,
  writeDurableSoon: (_name: string, value: unknown) => { durable.value = structuredClone(value); }
}));
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: (bytes: Buffer) => {
      const size = JSON.parse(bytes.toString()) as { width: number; height: number };
      return {
        isEmpty: () => !size.width || !size.height,
        getSize: () => size,
        crop: () => ({ resize: () => ({ toDataURL: () => 'data:image/png;base64,cHJldmlldw==' }) }),
        resize: () => ({ toPNG: () => Buffer.from('preview-sheet') })
      };
    }
  }
}));

import {
  BUILTIN_PET_ID,
  deletePet,
  importPet,
  initPetLibrary,
  loadPetAsset,
  petLibraryState,
  setPetEnabled,
  setPetFavorite
} from '../src/main/pet-library.js';

let temporary = '';

function packagePet(
  id: string,
  overrides: Record<string, unknown> = {},
  dimensions = { width: 1280, height: 1920 },
  editAnimations?: (manifest: any) => void
): string {
  const folder = path.join(temporary, `source-${id}`); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'pet.json'), JSON.stringify({ format: 'cos-pet', version: 1, id, displayName: id[0]!.toUpperCase() + id.slice(1), description: `${id} friend`, ...overrides }));
  fs.writeFileSync(path.join(folder, 'atlas.png'), JSON.stringify(dimensions));
  const animations = structuredClone(authoredManifest); editAnimations?.(animations);
  fs.writeFileSync(path.join(folder, 'animations.json'), JSON.stringify(animations));
  fs.writeFileSync(path.join(folder, 'ignored.txt'), 'not imported');
  return folder;
}

beforeEach(async () => {
  durable.value = null;
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-pets-simple-'));
  await initPetLibrary(temporary);
});

afterEach(() => {
  const parent = path.resolve(os.tmpdir()), resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('cos-pets-simple-')) throw new Error('Unexpected test cleanup path.');
  fs.rmSync(resolved, { recursive: true, force: true });
});

describe('simple compatible pet library', () => {
  it('imports only a validated Tur Tur-compatible CoS Pet package into the managed library', () => {
    importPet(packagePet('willow'));
    const state = petLibraryState();
    expect(state.pets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: BUILTIN_PET_ID, builtin: true }),
      expect.objectContaining({ id: 'willow', kind: 'cos', previewDataUrl: 'data:image/png;base64,cHJldmlldw==' })
    ]));
    expect(fs.readdirSync(path.join(temporary, 'pets', 'willow')).toSorted()).toEqual(['animations.json', 'atlas.png', 'pet.json']);
  });

  it('allows several active pets and keeps favorites as presentation order only', () => {
    importPet(packagePet('willow')); importPet(packagePet('moss'));
    setPetEnabled(BUILTIN_PET_ID, true); setPetEnabled('willow', true); setPetEnabled('moss', true);
    const next = setPetFavorite('moss', true);
    expect(next.pets.filter(pet => pet.enabled).map(pet => pet.id).toSorted()).toEqual([BUILTIN_PET_ID, 'moss', 'willow'].toSorted());
    expect(next.pets[0]).toMatchObject({ id: 'moss', favorite: true, enabled: true });
  });

  it('deletes imported pets and never deletes the bundled pet', () => {
    importPet(packagePet('willow')); setPetEnabled('willow', true); setPetFavorite('willow', true);
    expect(() => deletePet(BUILTIN_PET_ID)).toThrow('cannot be deleted');
    const next = deletePet('willow');
    expect(next.pets.some(pet => pet.id === 'willow')).toBe(false);
    expect(fs.existsSync(path.join(temporary, 'pets', 'willow'))).toBe(false);
  });

  it('rejects legacy v2 packages, wrong atlas dimensions and incomplete Tur Tur hand anchors', () => {
    expect(() => importPet(packagePet('short', {}, { width: 1280, height: 1760 }))).toThrow('1280×1920');
    const legacy = packagePet('legacy');
    fs.writeFileSync(path.join(legacy, 'pet.json'), JSON.stringify({ id: 'legacy', displayName: 'Legacy', description: '', spriteVersionNumber: 2, spritesheetPath: 'spritesheet.webp' }));
    expect(() => importPet(legacy)).toThrow('valid CoS Pets pet.json');
    expect(() => importPet(packagePet('hands', {}, undefined, manifest => { delete manifest.hands['69']; }))).toThrow('frame 69');
    expect(() => importPet(packagePet(BUILTIN_PET_ID))).toThrow('reserved');
  });

  it('loads the same authored manifest with the runtime atlas and smaller preview atlas', () => {
    importPet(packagePet('willow'));
    const runtime = loadPetAsset('willow', false);
    expect(runtime.atlasDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(runtime.manifest.frameCount).toBe(96);
    expect(runtime.manifest.animations.punch.frames).toHaveLength(18);
    expect(loadPetAsset('willow', true).atlasDataUrl).toBe('data:image/png;base64,cHJldmlldy1zaGVldA==');
  });
});
