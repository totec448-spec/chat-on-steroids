import { execFile } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { app, autoUpdater } from 'electron';
import { logInfo, logWarn } from './logger.js';

let eligibility: Promise<boolean> | null = null;
let listeningForErrors = false;
let restarting = false;

const run = (file: string, args: string[]): Promise<void> => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 15_000 }, err => err ? reject(err) : resolve());
});

/** Ad-hoc, unassessed, read-only and development installations keep their manual update path. */
export function canUpdateMac(): Promise<boolean> {
  if (process.platform !== 'darwin' || !app.isPackaged || !['x64', 'arm64'].includes(process.arch)) return Promise.resolve(false);
  return eligibility ??= (async () => {
    const bundle = path.dirname(path.dirname(path.dirname(process.execPath)));
    let reason = 'not an installed app bundle';
    try {
      if (!bundle.endsWith('.app')) throw new Error('not an installed app bundle');
      reason = 'bundle parent is not writable';
      await access(path.dirname(bundle), constants.W_OK);
      reason = 'no valid CoS Developer ID signature';
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R',
        'identifier "com.chatonsteroids.app" and anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', bundle]);
      reason = 'Gatekeeper did not accept the installation';
      await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle]);
      logInfo('update: this writable Developer ID Mac installation can use native updates');
      return true;
    } catch {
      logInfo(`update: ${reason}; keeping the manual Mac download path`);
      return false;
    }
  })();
}

/**
 * The existing updater has already downloaded and checksum-verified this ZIP. Electron 44.3
 * ignores a feed's sha256 field, so never delegate download integrity to that field. Squirrel
 * receives only these verified bytes, and owns signature verification and atomic replacement.
 */
export async function stageMacUpdate(version: string, file: string): Promise<void> {
  const size = (await stat(file)).size;
  if (!listeningForErrors) {
    listeningForErrors = true;
    autoUpdater.on('error', err => {
      logWarn(`update: native Mac updater failed: ${err.message}`);
      // Draining and durable flush already completed before a requested native restart.
      if (restarting) app.exit(0);
    });
  }
  let feedUrl = '';
  const server = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(404).end(); return; }
    if (req.url === '/release.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size });
      const stream = createReadStream(file);
      stream.on('error', err => res.destroy(err));
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } else if (req.url === '/feed') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ url: `${feedUrl}/release.zip`, name: version }));
    } else res.writeHead(404).end();
  });
  server.on('error', err => {
    logWarn(`update: native update feed failed: ${err.message}`);
    server.closeAllConnections(); // Native transport still owns whether the transfer completed.
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    server.unref();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('native update feed did not bind to loopback');
    feedUrl = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        autoUpdater.removeListener('update-downloaded', downloaded);
        autoUpdater.removeListener('update-not-available', unavailable);
        autoUpdater.removeListener('error', failed);
      };
      const downloaded = () => { cleanup(); resolve(); };
      const failed = (err: Error) => { cleanup(); reject(err); };
      const unavailable = () => failed(new Error('macOS did not stage the selected release'));
      autoUpdater.once('update-downloaded', downloaded);
      autoUpdater.once('update-not-available', unavailable);
      autoUpdater.once('error', failed);
      try {
        autoUpdater.setFeedURL({ url: `${feedUrl}/feed` });
        autoUpdater.checkForUpdates();
      } catch (err) { failed(err as Error); }
    });
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

/** Called only at the final exit boundary, after every app-owned shutdown phase and log flush. */
export function restartForMacUpdate(): void {
  restarting = true;
  autoUpdater.quitAndInstall();
}
