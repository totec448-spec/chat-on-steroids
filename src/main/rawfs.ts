import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Real operating-system filesystem semantics for user-approved paths.
 *
 * Electron patches node:fs so any *.asar file looks like a virtual directory. That
 * behaviour is useful for loading the app itself but wrong for a general-purpose
 * filesystem connector: listing or stat'ing a user's archive must describe the real
 * file and must not open it as an Electron package. Electron exposes `original-fs`
 * specifically for the unpatched behaviour.
 *
 * Tests run under ordinary Node, where `original-fs` does not exist, so they use the
 * normal node:fs implementation. The runtime require is intentionally dynamic so the
 * build does not try to resolve Electron's special module at bundle time.
 */
const rawFs: typeof nodeFs = (() => {
  if (!process.versions.electron) return nodeFs;
  const runtimeRequire = createRequire(path.join(process.cwd(), '__clf_runtime__.cjs'));
  return runtimeRequire('original-fs') as typeof nodeFs;
})();

export const rawPromises = rawFs.promises;
export const rawCreateReadStream = rawFs.createReadStream;

/**
 * Windows' native final-path canonicalizer.
 *
 * `fs.promises.realpath()` uses Node's portable implementation, which can preserve an NTFS 8.3
 * spelling such as `CHATGP~1`. `realpath.native()` asks Windows for the final path and expands
 * that alias, which is the identity the sandbox needs when comparing a native path copied from
 * command output with an approved long-form root. `original-fs` exposes the same callback API in
 * packaged Electron, so keep the wrapper here beside the other raw filesystem primitives.
 */
export function rawRealpathNative(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    rawFs.realpath.native(target, (error, resolved) => {
      if (error) reject(error);
      else resolve(resolved);
    });
  });
}
