import { cp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(root, 'extension');
const releaseRoot = path.join(root, 'release');
const defaultOutput = path.join(releaseRoot, 'firefox-extension');

/**
 * Firefox and Chromium consume the same runtime JavaScript, but Firefox's signed AMO package
 * needs a Gecko-specific MV3 manifest. Keep that small compatibility delta generated from the
 * canonical extension manifest so browser releases cannot silently drift apart.
 */
export function firefoxManifest(source) {
  const manifest = structuredClone(source);
  delete manifest.minimum_chrome_version;
  manifest.background = {
    scripts: ['background.js'],
    type: 'module'
  };
  manifest.content_security_policy = {
    extension_pages: "script-src 'self'; object-src 'self'"
  };
  manifest.browser_specific_settings = {
    gecko: {
      id: 'chat-on-steroids-companion@local',
      strict_min_version: '128.0',
      data_collection_permissions: {
        required: ['personalCommunications', 'websiteContent']
      }
    }
  };
  return manifest;
}

function safeOutput(output) {
  const resolved = path.resolve(output);
  const relative = path.relative(releaseRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Firefox extension staging must stay inside ${releaseRoot}; got ${resolved}`);
  }
  return resolved;
}

export async function stageFirefoxExtension(output = defaultOutput) {
  const target = safeOutput(output);
  const sourceManifest = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));

  await mkdir(releaseRoot, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(extensionRoot, target, { recursive: true, force: true });
  await writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(firefoxManifest(sourceManifest), null, 2)}\n`, 'utf8');
  await copyFile(path.join(root, 'LICENSE'), path.join(target, 'LICENSE'));
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = await stageFirefoxExtension(process.argv[2] ?? defaultOutput);
  process.stdout.write(`${target}\n`);
}
