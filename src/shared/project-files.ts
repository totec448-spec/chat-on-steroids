export type ProjectFileKind = 'file' | 'directory' | 'other';

/** One direct child of a project folder. Paths are always project-relative POSIX spellings. */
export interface ProjectFileEntry {
  name: string;
  path: string;
  kind: ProjectFileKind;
  bytes: number | null;
}

export interface ProjectDirectoryListing {
  projectId: string;
  projectName: string;
  directory: string;
  entries: ProjectFileEntry[];
  truncated: boolean;
}

export interface ProjectFilePreview {
  projectId: string;
  projectName: string;
  path: string;
  name: string;
  bytes: number;
  modifiedAt: string;
  /** Exact bounded text/content and file-identity revision required for editor saves. */
  revision?: string;
  binary: boolean;
  text: string | null;
  /** Inline preview payload for bounded, explicitly supported raster image formats. */
  imageDataUrl?: string;
  imageMimeType?: string;
  /** Base64 PDF bytes for the bounded in-app PDF viewer. Native paths never reach renderer. */
  pdfDataBase64?: string;
  truncated: boolean;
  note?: string;
}

export interface ProjectFileMutationResult {
  projectId: string;
  path: string;
  kind: 'file' | 'directory';
}

/** Result of an in-place text edit. Returning a fresh preview refreshes size/mtime/text atomically
 * from the renderer's point of view and gives the next save a new optimistic-concurrency token. */
export interface ProjectFileSaveResult {
  preview: ProjectFilePreview;
}

/** A watched project directory changed on disk. Paths stay project-relative. */
export interface ProjectFilesChanged {
  projectId: string;
  directory: string;
}
