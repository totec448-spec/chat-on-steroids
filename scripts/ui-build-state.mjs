// Whether the built app (out/) can be trusted by a UI check that loads it. Without a build those
// checks waited out their timeout; with a stale one they passed against old code.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// The entry files, not their folders: an interrupted build can leave the folders empty.
const BUILT = ['out/renderer/index.html', 'out/main/index.js', 'out/preload/index.js'];

/** True when a check's source loads the built app rather than the source files. */
export function needsBuild(source) {
  return /['"`]out\/(?:renderer|preload|main)\b|['"`]out['"`]\s*,\s*['"`](?:renderer|preload|main)['"`]/.test(source);
}

function newestFile(directory, root) {
  let newest = null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const candidate = entry.isDirectory() ? newestFile(full, root) : { file: full, at: statSync(full).mtimeMs };
    if (candidate && (!newest || candidate.at > newest.at)) newest = candidate;
  }
  return newest;
}

/** Null when out/ is present and newer than every file in src/; otherwise the problem, in words. */
export function buildProblem(root) {
  const missing = BUILT.find(relative => !existsSync(path.join(root, relative)));
  if (missing) return `there is no build (${missing}); run npm run build first`;
  const builtAt = statSync(path.join(root, 'out/renderer/index.html')).mtimeMs;
  const source = existsSync(path.join(root, 'src')) ? newestFile(path.join(root, 'src'), root) : null;
  if (source && source.at > builtAt) return `the build is older than ${path.relative(root, source.file).split(path.sep).join('/')}; run npm run build first`;
  return null;
}
