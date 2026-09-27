import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';

/**
 * A managed copy of uv for installing Python plugins.
 *
 * Most people do not have uv, and a desktop app cannot ask them to open a terminal. When uv is
 * not on PATH, CoS downloads one pinned release from uv's official GitHub releases, checks its
 * size and SHA-256 against the values below, and keeps only the uv and uvx executables in the
 * app's data folder. Nothing else from the archive is written, and nothing runs until the
 * checksum matches. uv is MIT/Apache-2.0 licensed (https://github.com/astral-sh/uv).
 */
export const UV_VERSION = '0.12.19';
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;

const ASSETS: Readonly<Record<string, { file: string; sha256: string }>> = {
  'darwin-arm64': { file: 'uv-aarch64-apple-darwin.tar.gz', sha256: 'a9a8df1eedeb192f2e47e40e2faabfb387db4b850209118786d42f89dde3e0ba' },
  'darwin-x64': { file: 'uv-x86_64-apple-darwin.tar.gz', sha256: 'cb5fa57bafe68fc0fb94b17f06bee0b0b9a7feb94ccbd110445afa0696e39273' },
  'linux-x64': { file: 'uv-x86_64-unknown-linux-gnu.tar.gz', sha256: '23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8' },
  'linux-arm64': { file: 'uv-aarch64-unknown-linux-gnu.tar.gz', sha256: '0804e9b164c64b6914182d5920c08551958a095986f10a3731056df701126436' },
  'win32-x64': { file: 'uv-x86_64-pc-windows-msvc.zip', sha256: '6dbb02d79e419522f1c500f0adb1cddcff0cda7d59b0d66ea7f5e3b4a1b2f5f0' },
  'win32-arm64': { file: 'uv-aarch64-pc-windows-msvc.zip', sha256: '115b54cb823bc48260670f5782001add6067ac8d98d18c8263a833704e287de9' }
};

let root: string | null = null;
let pending: Promise<string> | null = null;

export function initUvRuntime(userData: string): void { root = path.join(userData, 'runtimes', 'uv', UV_VERSION); }

/** The managed uv folder if it is installed, for plugin PATH lookup. */
export function managedUvDirectory(): string | null { return root; }

function executable(name: 'uv' | 'uvx', platform = process.platform): string { return platform === 'win32' ? `${name}.exe` : name; }

export function uvAsset(platform = process.platform, arch = process.arch): { file: string; sha256: string; url: string } | null {
  const asset = ASSETS[`${platform}-${arch}`];
  return asset ? { ...asset, url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset.file}` } : null;
}

/** Reads the two executables out of an uncompressed ustar stream; every other entry is ignored. */
export function extractUvFromTar(tar: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = `${field(345, 155) ? `${field(345, 155)}/` : ''}${field(0, 100)}`;
    const size = parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('The uv archive is malformed');
    const type = String.fromCharCode(header[156] || 48);
    const base = name.split('/').filter(Boolean).at(-1);
    if ((type === '0' || type === '\0') && (base === 'uv' || base === 'uvx') && name.split('/').filter(Boolean).length === 2)
      out.set(base, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

export function extractUvFromZip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const files = unzipSync(zip, { filter: file => /^(?:[^/]+\/)?uvx?\.exe$/.test(file.name) });
  for (const [name, bytes] of Object.entries(files)) out.set(path.posix.basename(name, '.exe'), Buffer.from(bytes));
  return out;
}

async function download(url: string, fetcher: typeof fetch): Promise<Buffer> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Could not download uv (HTTP ${response.status})`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) throw new Error('The uv download is larger than expected');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ARCHIVE_BYTES) { await reader.cancel(); throw new Error('The uv download is larger than expected'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

/** The managed uv executable, downloading and verifying it on first use. */
export function ensureManagedUv(fetcher: typeof fetch = fetch, platform = process.platform, arch = process.arch): Promise<string> {
  if (!root) return Promise.reject(new Error('The uv runtime folder is not ready'));
  const directory = root;
  pending ??= (async () => {
    const target = path.join(directory, executable('uv', platform));
    try { if ((await fs.stat(target)).isFile()) return target; } catch { /* Not installed yet. */ }
    const asset = uvAsset(platform, arch);
    if (!asset) throw new Error(`No uv build is available for ${platform} ${arch}; install uv and try again`);
    const archive = await download(asset.url, fetcher);
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== asset.sha256) throw new Error('The downloaded uv did not match its published checksum; nothing was installed');
    const files = asset.file.endsWith('.zip') ? extractUvFromZip(archive) : extractUvFromTar(gunzipSync(archive, { maxOutputLength: 200 * 1024 * 1024 }));
    if (!files.get('uv')) throw new Error('The uv archive did not contain uv');
    const stage = `${directory}.${randomUUID()}.tmp`;
    await fs.mkdir(stage, { recursive: true });
    try {
      for (const [name, bytes] of files) await fs.writeFile(path.join(stage, executable(name as 'uv' | 'uvx', platform)), bytes, { mode: 0o755, flag: 'wx' });
      await fs.mkdir(path.dirname(directory), { recursive: true });
      try { await fs.rename(stage, directory); }
      catch (error) { if ((await fs.stat(target).catch(() => null))?.isFile()) return target; throw error; }
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
    return target;
  })().finally(() => { pending = null; });
  return pending;
}
