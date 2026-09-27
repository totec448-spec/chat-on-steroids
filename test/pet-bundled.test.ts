import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const durable = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../src/main/durable.js', () => ({
  readDurable: async () => durable.value,
  writeDurableSoon: (_name: string, value: unknown) => { durable.value = structuredClone(value); }
}));
// Real PNGs: read the IHDR size, as nativeImage would.
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: (bytes: Buffer) => {
      const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const size = png ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : { width: 0, height: 0 };
      return {
        isEmpty: () => !size.width || !size.height, getSize: () => size,
        crop: () => ({ resize: () => ({ toDataURL: () => 'data:image/png;base64,cHJldmlldw==' }) }),
        resize: () => ({ toPNG: () => Buffer.from('preview-sheet') })
      };
    }
  }
}));

const { deletePet, importPet, initPetLibrary, loadPetAsset, petLibraryState, setPetEnabled } = await import('../src/main/pet-library.js');
const bundled = path.resolve('pets');
let temporary = '';
beforeEach(async () => { durable.value = null; temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-pets-bundled-')); await initPetLibrary(temporary, bundled); });
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

it.each([['hammy', 'Hammy'], ['capy', 'Capy']])('ships %s as a valid bundled pet that is off until enabled', (id, displayName) => {
  const pet = petLibraryState().pets.find(entry => entry.id === id);
  expect(pet).toMatchObject({ id, displayName, builtin: true, enabled: false });
  expect(setPetEnabled(id, true).pets.find(entry => entry.id === id)?.enabled).toBe(true);
  const asset = loadPetAsset(id, false);
  expect(asset.atlasDataUrl.startsWith('data:image/png;base64,')).toBe(true);
  expect(Object.keys(asset.manifest.animations)).toHaveLength(14);
});

it('keeps bundled pets from being deleted or shadowed by an import', () => {
  expect(() => deletePet('hammy')).toThrow('Bundled pets cannot be deleted');
  const source = path.join(temporary, 'source'); fs.mkdirSync(source);
  for (const file of ['pet.json', 'atlas.png', 'animations.json']) fs.copyFileSync(path.join(bundled, 'hammy', file), path.join(source, file));
  expect(() => importPet(source)).toThrow('reserved for a bundled pet');
});
