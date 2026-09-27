import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImage } from 'electron';
import { readDurable, writeDurableSoon } from './durable.js';
import {
  COS_PET_ANIMATION_NAMES,
  COS_PET_ATLAS,
  COS_PET_FRAME_LAYOUT,
  COS_PET_LOOPING,
  type PetAnimationManifest,
  type PetAnimationName,
  type PetLibraryState,
  type PetRecord,
  type PetRuntimeAsset
} from '../shared/pets.js';

export const PET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BUILTIN_PET_ID = 'tur-tur-sahur';
const STATE_KEY = 'pet-library';
const STATE_VERSION = 1;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_ATLAS_BYTES = 12 * 1024 * 1024;
const MAX_PACKAGES = 100;

interface StoredPetLibraryState {
  version: 1;
  enabled: string[];
  favorites: string[];
}

interface InspectedPet {
  record: Omit<PetRecord, 'enabled' | 'favorite'>;
  atlas: string;
  manifest: PetAnimationManifest;
}

let directory = '';
let stored: StoredPetLibraryState = { version: STATE_VERSION, enabled: [], favorites: [] };
const listeners = new Set<(state: PetLibraryState) => void>();

const builtin: Omit<PetRecord, 'enabled' | 'favorite'> = {
  id: BUILTIN_PET_ID,
  displayName: 'Tur Tur Sahur',
  description: 'The built-in Chat On Steroids companion.',
  kind: 'builtin',
  builtin: true
};

function validPreferenceIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string =>
    typeof value === 'string' && (value === BUILTIN_PET_ID || PET_ID_PATTERN.test(value))))];
}

function persist(): void {
  writeDurableSoon(STATE_KEY, stored);
}

export async function initPetLibrary(userData: string): Promise<void> {
  directory = path.join(userData, 'pets');
  fs.mkdirSync(directory, { recursive: true });
  const restored = await readDurable<Partial<StoredPetLibraryState>>(STATE_KEY);
  if (restored?.version === STATE_VERSION) {
    stored = {
      version: STATE_VERSION,
      enabled: validPreferenceIds(restored.enabled),
      favorites: validPreferenceIds(restored.favorites)
    };
  }
}

export function onPetLibraryChange(listener: (state: PetLibraryState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): PetLibraryState {
  const state = petLibraryState();
  for (const listener of listeners) listener(state);
  return state;
}

function ensureReady(): string {
  if (!directory) throw new Error('The pet library is not ready.');
  return directory;
}

function readJson(file: string): Record<string, unknown> {
  const info = fs.statSync(file);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_JSON_BYTES) throw new Error('Pet metadata is invalid.');
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pet metadata must be a JSON object.');
  return value as Record<string, unknown>;
}

function contained(base: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Invalid pet file path.');
  const root = fs.realpathSync(base);
  const candidate = path.resolve(base, relative);
  if (!candidate.startsWith(path.resolve(base) + path.sep)) throw new Error('A pet file escapes its package.');
  const info = fs.lstatSync(candidate);
  if (info.isSymbolicLink()) throw new Error('Pet packages may not use symbolic links.');
  const real = fs.realpathSync(candidate);
  if (!real.startsWith(root + path.sep)) throw new Error('A pet file escapes its package.');
  return real;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactFrames(value: unknown, expected: readonly number[]): value is number[] {
  return Array.isArray(value) && value.length === expected.length && value.every((frame, index) => frame === expected[index]);
}

function parseAnimations(raw: Record<string, unknown>): PetAnimationManifest {
  if (
    raw['version'] !== 1 || raw['image'] !== 'atlas.png' ||
    raw['width'] !== COS_PET_ATLAS.width || raw['height'] !== COS_PET_ATLAS.height ||
    raw['columns'] !== COS_PET_ATLAS.columns || raw['cellWidth'] !== COS_PET_ATLAS.cellWidth ||
    raw['cellHeight'] !== COS_PET_ATLAS.cellHeight || raw['frameCount'] !== COS_PET_ATLAS.frameCount
  ) throw new Error('animations.json must use the CoS Pets atlas layout.');
  const anchor = raw['anchor'];
  if (!Array.isArray(anchor) || anchor.length !== 2 || anchor[0] !== 80 || anchor[1] !== 136) {
    throw new Error('animations.json anchor must be [80, 136].');
  }
  const sourceAnimations = object(raw['animations']);
  if (!sourceAnimations) throw new Error('animations.json is missing its animations object.');
  const animations = {} as Record<PetAnimationName, PetAnimationManifest['animations'][PetAnimationName]>;
  for (const name of COS_PET_ANIMATION_NAMES) {
    const source = object(sourceAnimations[name]);
    const expected = COS_PET_FRAME_LAYOUT[name];
    if (!source || !exactFrames(source['frames'], expected) || source['loop'] !== COS_PET_LOOPING[name]) {
      throw new Error(`animations.json ${name} must use the required CoS Pets frame range and loop behavior.`);
    }
    const ms = source['ms'];
    if (!Array.isArray(ms) || ms.length !== expected.length || !ms.every(value => Number.isFinite(value) && Number(value) > 0 && Number(value) <= 10_000)) {
      throw new Error(`animations.json ${name} needs one positive duration per frame.`);
    }
    animations[name] = { frames: [...expected], ms: ms.map(Number), loop: COS_PET_LOOPING[name] };
  }
  const sourceHands = object(raw['hands']);
  if (!sourceHands) throw new Error('animations.json needs hand anchors for frames 69–84.');
  const hands: PetAnimationManifest['hands'] = {};
  for (let frame = 69; frame <= 84; frame += 1) {
    const value = sourceHands[String(frame)];
    if (
      !Array.isArray(value) || value.length !== 3 ||
      !Number.isFinite(value[0]) || !Number.isFinite(value[1]) ||
      Number(value[0]) < 0 || Number(value[0]) > 160 || Number(value[1]) < 0 || Number(value[1]) > 160 ||
      (value[2] !== 1 && value[2] !== -1)
    ) throw new Error(`animations.json needs a valid [x, y, side] hand anchor for frame ${frame}.`);
    hands[String(frame)] = [Number(value[0]), Number(value[1]), value[2]];
  }
  return {
    version: 1,
    image: 'atlas.png',
    width: 1280,
    height: 1920,
    columns: 8,
    cellWidth: 160,
    cellHeight: 160,
    frameCount: 96,
    anchor: [80, 136],
    animations,
    hands
  };
}

function inspectPackage(folder: string, expectedId?: string): InspectedPet {
  const info = fs.lstatSync(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Choose a pet package folder.');
  const metadata = readJson(contained(folder, 'pet.json'));
  const id = metadata['id'];
  const displayName = metadata['displayName'];
  const description = metadata['description'];
  if (
    typeof id !== 'string' || !PET_ID_PATTERN.test(id) || (expectedId && id !== expectedId) ||
    metadata['format'] !== 'cos-pet' || metadata['version'] !== 1 ||
    typeof displayName !== 'string' || !displayName.trim() ||
    typeof description !== 'string'
    ) throw new Error('The folder needs a valid CoS Pets pet.json manifest.');

  const atlas = contained(folder, 'atlas.png');
  const atlasInfo = fs.statSync(atlas);
  if (!atlasInfo.isFile() || atlasInfo.size <= 0 || atlasInfo.size > MAX_ATLAS_BYTES) throw new Error('atlas.png is empty or too large.');
  const bytes = fs.readFileSync(atlas);
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('atlas.png could not be decoded.');
  const size = image.getSize();
  if (size.width !== COS_PET_ATLAS.width || size.height !== COS_PET_ATLAS.height) {
    throw new Error(`atlas.png must be ${COS_PET_ATLAS.width}×${COS_PET_ATLAS.height}px.`);
  }
  const authored = parseAnimations(readJson(contained(folder, 'animations.json')));
  const preview = image.crop({ x: 7 * COS_PET_ATLAS.cellWidth, y: 0, width: COS_PET_ATLAS.cellWidth, height: COS_PET_ATLAS.cellHeight }).resize({ width: 96, height: 96, quality: 'good' });
  return {
    record: {
      id,
      displayName: displayName.trim().slice(0, 100),
      description: description.trim().slice(0, 500),
      kind: 'cos',
      previewDataUrl: preview.toDataURL()
    },
    atlas,
    manifest: authored
  };
}

function installedPet(id: string): InspectedPet {
  if (!PET_ID_PATTERN.test(id)) throw new Error('Invalid pet id.');
  const root = ensureReady();
  const folder = path.join(root, id);
  const info = fs.lstatSync(folder, { throwIfNoEntry: false });
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Pet is not installed.');
  const realRoot = fs.realpathSync(root);
  const realFolder = fs.realpathSync(folder);
  if (!realFolder.startsWith(realRoot + path.sep)) throw new Error('Pet package escapes the library.');
  return inspectPackage(realFolder, id);
}

function exists(id: string): boolean {
  if (id === BUILTIN_PET_ID) return true;
  try { installedPet(id); return true; } catch { return false; }
}

function preference(record: Omit<PetRecord, 'enabled' | 'favorite'>): PetRecord {
  return {
    ...record,
    enabled: stored.enabled.includes(record.id),
    favorite: stored.favorites.includes(record.id)
  };
}

export function petLibraryState(): PetLibraryState {
  const root = ensureReady();
  const pets: PetRecord[] = [preference(builtin)];
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (count >= MAX_PACKAGES || entry.name === BUILTIN_PET_ID || !entry.isDirectory() || !PET_ID_PATTERN.test(entry.name)) continue;
    count += 1;
    try { pets.push(preference(installedPet(entry.name).record)); } catch { /* Invalid packages remain unavailable. */ }
  }
  pets.sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.displayName.localeCompare(b.displayName));
  return { pets };
}

export function setPetEnabled(id: string, enabled: boolean): PetLibraryState {
  if (!exists(id)) throw new Error('Pet is not installed.');
  const next = new Set(stored.enabled);
  if (enabled) next.add(id); else next.delete(id);
  stored = { ...stored, enabled: [...next] };
  persist();
  return changed();
}

export function setPetFavorite(id: string, favorite: boolean): PetLibraryState {
  if (!exists(id)) throw new Error('Pet is not installed.');
  const next = new Set(stored.favorites);
  if (favorite) next.add(id); else next.delete(id);
  stored = { ...stored, favorites: [...next] };
  persist();
  return changed();
}

export function deletePet(id: string): PetLibraryState {
  if (id === BUILTIN_PET_ID) throw new Error('The built-in pet cannot be deleted.');
  if (!PET_ID_PATTERN.test(id)) throw new Error('Invalid pet id.');
  const root = ensureReady();
  const folder = path.join(root, id);
  const info = fs.lstatSync(folder, { throwIfNoEntry: false });
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Pet is not installed.');
  const realRoot = fs.realpathSync(root);
  const realFolder = fs.realpathSync(folder);
  if (!realFolder.startsWith(realRoot + path.sep)) throw new Error('Pet package escapes the library.');
  fs.rmSync(realFolder, { recursive: true, force: false });
  stored = {
    ...stored,
    enabled: stored.enabled.filter(value => value !== id),
    favorites: stored.favorites.filter(value => value !== id)
  };
  persist();
  return changed();
}

export function importPet(sourceFolder: string): PetLibraryState {
  const source = fs.realpathSync(sourceFolder);
  const inspected = inspectPackage(source);
  if (inspected.record.id === BUILTIN_PET_ID) throw new Error('That pet id is reserved for the built-in companion.');
  const root = ensureReady();
  const destination = path.join(root, inspected.record.id);
  if (fs.existsSync(destination)) throw new Error(`${inspected.record.displayName} is already imported.`);
  const temporary = path.join(root, `.import-${randomUUID()}`);
  fs.mkdirSync(temporary);
  try {
    fs.copyFileSync(inspected.atlas, path.join(temporary, 'atlas.png'));
    fs.writeFileSync(path.join(temporary, 'pet.json'), JSON.stringify({
      format: 'cos-pet',
      version: 1,
      id: inspected.record.id,
      displayName: inspected.record.displayName,
      description: inspected.record.description
    }, null, 2));
    fs.writeFileSync(path.join(temporary, 'animations.json'), JSON.stringify(inspected.manifest, null, 2));
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return changed();
}

export function loadPetAsset(id: string, preview: boolean): PetRuntimeAsset {
  const inspected = installedPet(id);
  const bytes = fs.readFileSync(inspected.atlas);
  if (!preview) {
    return { id, kind: 'cos', atlasDataUrl: `data:image/png;base64,${bytes.toString('base64')}`, manifest: inspected.manifest };
  }
  const image = nativeImage.createFromBuffer(bytes).resize({ width: 512, height: 768, quality: 'good' });
  return { id, kind: 'cos', atlasDataUrl: `data:image/png;base64,${image.toPNG().toString('base64')}`, manifest: inspected.manifest };
}
