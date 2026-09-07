/**
 * Orchestration for `download_artifact`: resolve → fetch → write → publish.
 *
 * Mirrors devspace `downloadIncomingArtifact` (src/artifact-tools.ts:127-218) with two
 * local adaptations: path resolution goes through `resolveIn` (approved roots +
 * per-chat workspace, the sandbox remaining the single authority), and the secure
 * target is the koffi-free `artifact-target.ts`.
 */

import { createHash } from 'node:crypto';
import nodePath from 'node:path';
import { rawPromises as fs } from '../rawfs.js';
import { resolveIn } from './kernel.js';
import type { Root } from '../../shared/types.js';
import {
  ArtifactFetchError,
  normalizeOpenAIFileReference,
  validateOpenAIFileUrl,
  openArtifactFile,
  type OpenAIFileAdapterOptions
} from './artifact-fetch.js';
import { ArtifactTargetError, openArtifactTarget } from './artifact-target.js';

export interface SavedArtifact {
  /** Normalised virtual path, always "/root/..." with forward slashes. */
  virtual: string;
  size: number;
  sha256: string;
}

export interface DownloadArtifactOptions extends OpenAIFileAdapterOptions {
  maxFileBytes: number;
}

/**
 * Stream one ChatGPT-injected file value to `requestedPath` inside an approved root.
 * The destination must name a file in an existing directory and must not already exist.
 * Throws ArtifactFetchError / ArtifactTargetError / SandboxError on refusal;
 * the caller maps those to model-facing failures without leaking real paths.
 */
export async function downloadArtifactFile(
  roots: readonly Root[],
  requestedPath: string,
  file: unknown,
  options: DownloadArtifactOptions
): Promise<SavedArtifact> {
  const { maxFileBytes } = options;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new ArtifactTargetError('Artifact file-size limit must be a positive integer.');
  }
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    throw new ArtifactTargetError('Artifact destination is invalid.');
  }
  if (/[/\\]$/.test(requestedPath.trim())) {
    throw new ArtifactTargetError('Artifact destination must name a file, not a folder.');
  }

  const reference = normalizeOpenAIFileReference(file);
  validateOpenAIFileUrl(reference.download_url);
  if (reference.size !== undefined && reference.size > maxFileBytes) throw new ArtifactFetchError('ChatGPT file exceeds the configured per-file limit.');
  const resolved = await resolveIn(roots as Parameters<typeof resolveIn>[0], requestedPath, {
    allowMissing: true
  });
  const parentReal = nodePath.dirname(resolved.real);
  const name = nodePath.basename(resolved.real);
  const rootReal = await fs.realpath(resolved.root.path);
  const target = await openArtifactTarget({ parentReal, rootReal, name, maxFileBytes });
  let opened: Awaited<ReturnType<typeof openArtifactFile>> | undefined;
  const hash = createHash('sha256');
  let size = 0;
  try {
    opened = await openArtifactFile(file, options);
    if (opened.size !== undefined && opened.size > maxFileBytes) throw new ArtifactFetchError('ChatGPT file exceeds the configured per-file limit.');
    for await (const value of opened.stream) {
      const chunk =
        typeof value === 'string' ? Buffer.from(value) : Buffer.from(value as Uint8Array);
      if (size + chunk.length > maxFileBytes) {
        throw new ArtifactFetchError('ChatGPT file exceeds the configured per-file limit.');
      }
      await target.writeAll(chunk, size);
      hash.update(chunk);
      size += chunk.length;
    }
    if (opened.size !== undefined && opened.size !== size) {
      throw new ArtifactFetchError('ChatGPT file metadata did not match the downloaded content.');
    }
    await target.syncAndVerify(size);
    await target.publish();
    return { virtual: resolved.virtual, size, sha256: `sha256:${hash.digest('hex')}` };
  } finally {
    opened?.stream.destroy();
    await target.close().catch(() => undefined);
  }
}
