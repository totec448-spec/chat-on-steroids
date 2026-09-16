import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noticeDirectory = path.join(root, 'docs', 'licenses', 'native');
const inventory = JSON.parse(await fs.readFile(path.join(noticeDirectory, 'sources.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const componentNotices = await fs.readFile(path.join(noticeDirectory, 'COMPONENT-NOTICES.txt'));
if (createHash('sha256').update(componentNotices).digest('hex') !== inventory.componentNoticesSha256) {
  throw new Error('Native component notice bytes differ from the reviewed inventory');
}
for (const [name, version] of Object.entries(inventory.packages)) {
  if (lock.packages[`node_modules/${name}`]?.version !== version) {
    throw new Error(`Native source review does not cover locked ${name}; expected ${version}`);
  }
}
const filenames = new Set();
for (const source of inventory.sources) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9+._-]*$/.test(source.file) || filenames.has(source.file)) {
    throw new Error(`Invalid or duplicate native source filename: ${source.file}`);
  }
  filenames.add(source.file);
  if (!source.url.startsWith('https://') || !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > 256 * 1024 * 1024) {
    throw new Error(`Incomplete native source identity: ${source.file}`);
  }
}
if (process.argv.includes('--check')) {
  console.log(`Validated ${inventory.sources.length} pinned native source archives and patches.`);
  process.exit(0);
}

const output = path.join(root, 'release', 'native-sources');
const archives = path.join(output, 'archives');
await fs.mkdir(archives, { recursive: true });
let index = 0;
let completed = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (index < inventory.sources.length) {
    const source = inventory.sources[index++];
    const destination = path.join(archives, source.file);
    let bytes;
    try { bytes = await fs.readFile(destination); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!bytes) {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`Native source download failed: ${source.file}: HTTP ${response.status}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > source.bytes) throw new Error(`Native source exceeds reviewed size: ${source.file}`);
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    }
    if (bytes.length !== source.bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
      throw new Error(`Native source checksum mismatch: ${source.file}`);
    }
    await fs.writeFile(destination, bytes);
    if (++completed % 50 === 0) console.log(`Verified ${completed}/${inventory.sources.length} source files.`);
  }
}));
for (const name of ['sources.json', 'README.md', 'SOURCE-BUILD.md', 'COMPONENT-NOTICES.txt', 'LGPL-3.0.txt', 'GPL-3.0.txt', 'MPL-2.0.txt']) {
  await fs.copyFile(path.join(noticeDirectory, name), path.join(output, name));
}
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), inventory.sources.map(source => `${source.sha256}  archives/${source.file}`).join('\n') + '\n');
const destination = path.join(root, 'release', 'Chat-On-Steroids-Native-Sources.tar.gz');
// List the reviewed files explicitly: stale files from an older local build cannot enter the release.
const files = ['sources.json', 'README.md', 'SOURCE-BUILD.md', 'COMPONENT-NOTICES.txt', 'LGPL-3.0.txt', 'GPL-3.0.txt', 'MPL-2.0.txt', 'SHA256SUMS.txt',
  ...inventory.sources.map(source => `archives/${source.file}`)];
const list = path.join(root, 'release', 'native-source-files.txt');
await fs.writeFile(list, files.join('\n') + '\n');
const result = spawnSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', destination, '-C', output, '-T', list], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Native source archive failed: ${result.status}`);
console.log(`Built ${path.basename(destination)} with ${inventory.sources.length} verified source files.`);
