import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logInfo } from '../logger.js';

/** An installer may launch us with a TMPDIR that disappears when the installer exits. */
export async function createTunnelWorkDir(): Promise<string> {
  try {
    return await fs.mkdtemp(path.join(os.tmpdir(), 'cglf-'));
  } catch (err) {
    // Do not disguise an access, disk-space or other failure as a missing directory, and
    // never recreate an arbitrary inherited installer path or change the process environment.
    if (process.platform !== 'darwin' || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const canonical = await new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 3_000 }, (error, stdout) => {
        if (error) { reject(error); return; }
        const dir = stdout.trim();
        if (!path.isAbsolute(dir) || /[\r\n\0]/.test(dir)) {
          reject(new Error('macOS returned no usable user temporary directory'));
          return;
        }
        resolve(dir);
      });
    });
    const workDir = await fs.mkdtemp(path.join(canonical, 'cglf-'));
    logInfo('tunnel: inherited temporary directory is missing; using the macOS user temporary directory');
    return workDir;
  }
}
