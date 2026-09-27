export const COS_PET_ATLAS = {
  width: 1280,
  height: 1920,
  columns: 8,
  rows: 12,
  cellWidth: 160,
  cellHeight: 160,
  frameCount: 96
} as const;

export const COS_PET_ANIMATION_NAMES = [
  'spawn', 'idle', 'look', 'walk', 'held', 'landing', 'poke',
  'angry', 'punch', 'heavy', 'grab', 'carry', 'throw', 'celebrate'
] as const;

export type PetAnimationName = typeof COS_PET_ANIMATION_NAMES[number];
export type PetKind = 'builtin' | 'cos';
export type PetActivityLevel = 'idle' | 'running' | 'waiting' | 'failed' | 'review';

export interface PetActivity {
  id: string;
  title: string;
  body: string;
  level: PetActivityLevel;
  sessionId?: string;
}

export interface PetAnimationClip {
  frames: number[];
  ms: number[];
  loop: boolean;
}

export interface PetAnimationManifest {
  version: 1;
  image: 'atlas.png';
  width: 1280;
  height: 1920;
  columns: 8;
  cellWidth: 160;
  cellHeight: 160;
  frameCount: 96;
  anchor: [number, number];
  animations: Record<PetAnimationName, PetAnimationClip>;
  hands: Record<string, [number, number, 1 | -1]>;
}

export const COS_PET_FRAME_LAYOUT: Readonly<Record<PetAnimationName, readonly number[]>> = {
  spawn: [0, 1, 2, 3],
  idle: [4, 5, 6, 7],
  look: [8, 9, 10, 11],
  walk: [12, 13, 14, 15, 16, 17, 18, 19],
  held: [20, 21, 22, 23],
  landing: [24, 25, 26, 27],
  poke: [28, 29, 30, 31],
  angry: [32, 33, 34, 35, 36, 37],
  punch: [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55],
  heavy: [56, 57, 58, 59, 60, 61, 62, 63, 64, 65],
  grab: [66, 67, 68, 69, 70, 71],
  carry: [72, 73, 74, 75, 76, 77, 78, 79],
  throw: [80, 81, 82, 83, 84, 85, 86, 87],
  celebrate: [88, 89, 90, 91, 92, 93, 94, 95]
};

export const COS_PET_LOOPING: Readonly<Record<PetAnimationName, boolean>> = {
  spawn: false,
  idle: true,
  look: false,
  walk: true,
  held: false,
  landing: false,
  poke: false,
  angry: false,
  punch: false,
  heavy: false,
  grab: false,
  carry: true,
  throw: false,
  celebrate: false
};

export interface PetRecord {
  id: string;
  displayName: string;
  description: string;
  kind: PetKind;
  enabled: boolean;
  favorite: boolean;
  builtin?: true;
  previewDataUrl?: string;
}

export interface PetLibraryState {
  pets: PetRecord[];
}

export interface PetRuntimeAsset {
  id: string;
  kind: 'cos';
  atlasDataUrl: string;
  manifest: PetAnimationManifest;
}

export interface PetOverlayControlState {
  visible: boolean;
  ready: boolean;
  activeCount: number;
  activityCount: number;
}

export interface PetOverlayPointer {
  x: number;
  y: number;
}

/** Window-local native hit region. The fullscreen surface remains click-through outside these bounds. */
export interface PetOverlayHitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PetOverlayBounds {
  width: number;
  height: number;
  scaleFactor: number;
}

export interface PetOverlaySnapshot {
  visible: boolean;
  dismissedPetIds: string[];
  level: PetActivityLevel;
  activities: PetActivity[];
  theme: 'light' | 'dark';
  appearance: import('./appearance.js').AppearanceSettings;
}
