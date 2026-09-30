import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';

/** The files release.yml publishes, in its SHA256SUMS.txt order. */
export const RELEASE_FILES = [
  'Chat-On-Steroids-Setup-x64.exe',
  'Chat-On-Steroids-Setup-arm64.exe',
  'Chat-On-Steroids-macOS-x64.dmg',
  'Chat-On-Steroids-macOS-x64.zip',
  'Chat-On-Steroids-macOS-arm64.dmg',
  'Chat-On-Steroids-macOS-arm64.zip',
  'Chat-On-Steroids-Linux-x64.AppImage',
  'Chat-On-Steroids-Linux-x64.deb',
  'Chat-On-Steroids-Linux-arm64.AppImage',
  'Chat-On-Steroids-Linux-arm64.deb',
  'Chat-On-Steroids-Extension.zip',
  'Chat-On-Steroids-Native-Sources.tar.gz'
];
const EXTENSION = 'Chat-On-Steroids-Extension.zip';

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * What a user downloads, checked after publishing: every file is there and matches the published
 * checksum, and the standalone extension is the tagged version with its build stamp (#568, #572).
 * Returns the problems in plain sentences; an empty list means the release is sound.
 */
export async function verifyReleaseAssets({ dir, tag }) {
  const sumsFile = path.join(dir, 'SHA256SUMS.txt');
  if (!existsSync(sumsFile)) return ['SHA256SUMS.txt is missing from the release.'];
  const sums = new Map(readFileSync(sumsFile, 'utf8').split('\n').map(line => line.trim().split(/\s+\*?/)).filter(parts => parts.length === 2)
    .map(([hash, name]) => [name, hash.toLowerCase()]));
  const problems = [];
  for (const name of RELEASE_FILES) {
    const file = path.join(dir, name);
    if (!existsSync(file)) { problems.push(`${name} is missing from the release.`); continue; }
    if (!sums.has(name)) { problems.push(`${name} is not listed in SHA256SUMS.txt.`); continue; }
    if (await sha256(file) !== sums.get(name)) problems.push(`${name} does not match its SHA256SUMS.txt checksum.`);
  }
  const extension = path.join(dir, EXTENSION);
  if (existsSync(extension)) {
    const entries = unzipSync(readFileSync(extension));
    const stamp = entries['build-stamp.txt'] ? strFromU8(entries['build-stamp.txt']).trim() : '';
    if (!stamp) problems.push(`${EXTENSION} is missing build-stamp.txt.`);
    const version = entries['manifest.json'] ? JSON.parse(strFromU8(entries['manifest.json'])).version : null;
    const wanted = tag.replace(/^v/, '');
    if (version !== wanted) problems.push(`The extension in ${EXTENSION} is version ${version ?? 'unknown'}, not ${wanted}.`);
  }
  return problems;
}

async function main() {
  const [dir, tag, report] = process.argv.slice(2);
  if (!dir || !tag) throw new Error('Usage: node scripts/verify-release-assets.mjs <folder> <tag> [report.md]');
  const problems = await verifyReleaseAssets({ dir, tag });
  if (report) writeFileSync(report, problems.map(problem => `- ${problem}`).join('\n') + '\n');
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  } else console.log(`${tag}: all ${RELEASE_FILES.length} files match SHA256SUMS.txt and the extension is the tagged build.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
