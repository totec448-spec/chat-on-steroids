import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
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
    try {
      if (!bundle.endsWith('.app')) throw new Error('not an installed app bundle');
      await access(path.dirname(bundle), constants.W_OK);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R',
        'identifier "com.chatonsteroids.app" and anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', bundle]);
      await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle]);
      logInfo('update: this writable Developer ID Mac installation can use native updates');
      return true;
    } catch {
      logInfo('update: Mac installation is not writable and publisher-trusted; keeping the manual download path');
      return false;
    }
  })();
}

/**
 * The existing updater selects a version and its published digest. Squirrel owns the download,
 * digest/signature verification and atomic replacement; no second timer or installer is added.
 * A loopback feed supplies only public release metadata, not an app/file/tool endpoint.
 */
export async function stageMacUpdate(version: string, url: string, sha256: string): Promise<void> {
  if (!listeningForErrors) {
    listeningForErrors = true;
    autoUpdater.on('error', err => {
      logWarn(`update: native Mac updater failed: ${err.message}`);
      // Draining and durable flush already completed before a requested native restart.
      if (restarting) app.exit(0);
    });
  }
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/feed') { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url, name: version, sha256 }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    server.unref();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('native update feed did not bind to loopback');
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
        autoUpdater.setFeedURL({ url: `http://127.0.0.1:${address.port}/feed` });
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
