import { cp, copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIREFOX_ADDON_ID, FIREFOX_UPDATE_URL } from './firefox-update-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(root, 'extension');
const releaseRoot = path.join(root, 'release');
const defaultOutput = path.join(releaseRoot, 'firefox-extension');

/**
 * Firefox and Chromium share the extension runtime. Generate only the Gecko packaging delta
 * from the canonical Chromium manifest so the runtime files and permission declarations cannot
 * silently become two independently maintained products. This stages package bytes only; it is
 * not evidence that the shared runtime has been exercised under Firefox's MV3 lifecycle.
 *
 * Adapted from @nabeel2k11's Firefox package groundwork in PR #47.
 */
export function firefoxManifest(source, build = '') {
  const manifest = structuredClone(source);
  // Mozilla signs each version once. When it already holds this one (2.1.43 was signed from a tag
  // that later moved), the release names a Firefox-only fourth part: 2.1.43.1, same code.
  if (build) {
    if (!/^[1-9]\d{0,2}$/.test(build)) throw new Error(`Not a Firefox build number: ${build}`);
    manifest.version = `${source.version}.${build}`;
  }
  delete manifest.minimum_chrome_version;
  // Firefox has no DevTools protocol for extensions; Browser control and focus emulation say so at runtime.
  manifest.permissions = manifest.permissions.filter(permission => permission !== 'debugger');
  manifest.background = { scripts: ['background.js'], type: 'module' };
  manifest.content_security_policy = { extension_pages: "script-src 'self'; object-src 'self'" };
  manifest.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ADDON_ID,
      // 140 is the ESR line, and the first with tab groups and data_collection_permissions.
      strict_min_version: '140.0',
      update_url: FIREFOX_UPDATE_URL,
      data_collection_permissions: {
        required: ['personalCommunications', 'websiteContent']
      }
    },
    // Firefox for Android supports data_collection_permissions only from 142; without this the
    // 140 minimum above draws Mozilla's validator warning (seen on the 2.1.38 submission).
    gecko_android: { strict_min_version: '142.0' }
  };
  return manifest;
}

async function safeOutput(output) {
  const resolved = path.resolve(output);
  const relative = path.relative(releaseRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Firefox extension staging must stay inside ${releaseRoot}`);
  }
  // A lexical descendant can still traverse a junction/symlink outside release.
  // Check the release directory itself and every existing destination component before removal.
  let current = releaseRoot;
  for (const part of ['', ...relative.split(path.sep)]) {
    current = path.join(current, part);
    let entry;
    try { entry = await lstat(current); }
    catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (entry.isSymbolicLink()) throw new Error('Firefox extension staging cannot traverse a symbolic link or junction');
  }
  return resolved;
}

export async function stageFirefoxExtension(output = defaultOutput, build = process.env.FIREFOX_BUILD ?? '') {
  const target = await safeOutput(output);
  const sourceManifest = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));

  await mkdir(releaseRoot, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(extensionRoot, target, { recursive: true, force: true });
  await writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(firefoxManifest(sourceManifest, build), null, 2)}\n`, 'utf8');
  await copyFile(path.join(root, 'LICENSE'), path.join(target, 'LICENSE'));
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = await stageFirefoxExtension(process.argv[2] ?? defaultOutput);
  process.stdout.write(`${target}\n`);
}
