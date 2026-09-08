import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const notices = [
  'Chat On Steroids — Third-party Notices',
  '',
  'CoS remains MIT licensed; see LICENSE. This inventory preserves the license and notice texts',
  'of the production npm components present when this build was prepared. Platform-specific',
  'Electron/Chromium, native image libraries, ripgrep and tunnel-client notices also accompany',
  'their respective packaged binaries. Optional packages for other targets are supplied by',
  'the packaging pipeline together with their notices.',
  '',
  'Catalog artwork: Copyright (c) 2026 Chat On Steroids contributors. MIT licensed, see LICENSE.',
  'Original illustrations are not official product logos. Product names identify independent',
  'integrations and do not imply affiliation or endorsement. External plugins installed by users',
  'are not bundled with CoS; their package directories retain their own licenses and notices.',
  ''
];
const missing = [];
let count = 0;
for (const [relative, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!relative || entry.dev === true) continue;
  const directory = path.join(root, relative);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); }
  catch (error) { if (entry.optional && error.code === 'ENOENT') continue; throw new Error(`Missing or invalid production dependency: ${relative}`); }
  if (manifest.version !== entry.version) throw new Error(`Production dependency version differs from lockfile: ${relative}`);
  const files = [];
  // Include package-supplied notices in subdirectories too. Nested dependencies are inventoried
  // separately, avoiding accidentally attributing a dependency's license to its parent package.
  async function walk(folder, depth = 0) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      if (item.isDirectory() && !['node_modules', '.git'].includes(item.name) && depth < 4) await walk(path.join(folder, item.name), depth + 1);
      else if (item.isFile() && /^(licen[sc]e|notice|copying|copyright)([._-].*)?$/i.test(item.name)) files.push(path.join(folder, item.name));
    }
  }
  await walk(directory);
  if (manifest.name === 'flora-colossus' && !files.length) files.push(path.join(root, 'docs/licenses/flora-colossus-LICENSE'));
  if (manifest.name.startsWith('@img/')) {
    // libvips distributions publish their composite attribution in README.md.
    try { await fs.access(path.join(directory, 'README.md')); files.push(path.join(directory, 'README.md')); } catch { /* package has separate licenses */ }
  }
  if (!files.length) missing.push(`${manifest.name}@${manifest.version}`);
  const license = typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? manifest.licenses ?? 'Not declared');
  notices.push('='.repeat(80), `${manifest.name}@${manifest.version}`, `Declared license: ${license}`, `Package: https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`, '');
  for (const file of files.sort()) notices.push(`--- ${file.startsWith(directory + path.sep) ? path.relative(directory, file).replaceAll('\\', '/') : 'Upstream license supplement (see docs/licenses/README.md)'} ---`, await fs.readFile(file, 'utf8'), '');
  count++;
}
if (missing.length) throw new Error(`Missing license texts for production packages: ${missing.join(', ')}`);
notices.push('='.repeat(80), 'Native image-library license supplements', 'The following texts accompany the LGPL/MPL components listed in the platform-specific sharp/libvips notices. They do not replace component copyright notices or corresponding-source obligations.', '');
for (const file of ['README.md', 'COMPONENT-NOTICES.txt', 'LGPL-3.0.txt', 'GPL-3.0.txt', 'MPL-2.0.txt']) {
  notices.push(`--- ${file} ---`, await fs.readFile(path.join(root, 'docs/licenses/native', file), 'utf8'), '');
}
// Catalog packages are optional downloads, but their reviewed license texts must
// also be reachable from the app's Legal Notices action before installation.
const catalogLicenses = JSON.parse(await fs.readFile(path.join(root, 'docs/licenses/plugins/inventory.json'), 'utf8'));
notices.push('='.repeat(80), 'Optional plugin catalog — separate installations and hosted services', 'Reviewed package licenses and hosted-service references follow. External server code is not bundled with CoS; custom installations and updates retain their own notices.', '');
for (const entry of catalogLicenses) {
  notices.push('='.repeat(80), entry.name ?? `${entry.package}@${entry.version}`, `License: ${entry.license}`, `Source: ${entry.repository}`);
  if (entry.endpoint) notices.push(`MCP endpoint: ${entry.endpoint}`);
  if (entry.terms) notices.push(`Service terms: ${entry.terms}`);
  notices.push('');
  for (const notice of entry.notices) {
    const bytes = await fs.readFile(path.join(root, 'docs/licenses/plugins', notice.file));
    if (createHash('sha256').update(bytes).digest('hex') !== notice.sha256) throw new Error(`Catalog license hash mismatch: ${notice.file}`);
    notices.push(`--- ${notice.file} ---`, bytes.toString('utf8'), '');
  }
}
// Each CI host inventories its own optional native packages. Packaging regenerates the
// shipped file on that host; comparing against another platform's text is not meaningful.
if (!process.argv.includes('--check')) await fs.writeFile(path.join(root, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
console.log(`Validated license notices for ${count} production packages and ${catalogLicenses.length} catalog entries.`);
