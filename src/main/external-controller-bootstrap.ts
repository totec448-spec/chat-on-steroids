import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  onExternalControllerPersist,
  onExternalControllerPersistNow,
  restoreExternalController,
  snapshotExternalController,
  type ExternalControllerSnapshot
} from './external-controller.js';
import { startExternalControllerServer, type ExternalControllerServer } from './external-controller-server.js';
import { logError, logInfo, logWarn } from './logger.js';

const STATE_FILE = 'external-controller-state.json';
const userDataDir = app.getPath('userData');
let server: ExternalControllerServer | null = null;
let writeTimer: NodeJS.Timeout | null = null;
let writeFlight: Promise<void> = Promise.resolve();

/**
 * Restore ownership synchronously at module load. The bridge restores its independently durable
 * browser commands during app startup; those commands must see their external run owner before
 * deciding whether an old row is stale. This reads one small local JSON file and performs no I/O
 * beyond that bounded startup read.
 */
function restoreStateBeforeBridge(): void {
  const target = path.join(userDataDir, STATE_FILE);
  try {
    const saved = JSON.parse(readFileSync(target, 'utf8')) as ExternalControllerSnapshot;
    restoreExternalController(saved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      restoreExternalController(null);
      return;
    }
    restoreExternalController(null);
    logWarn(`external controller state was not restored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

restoreStateBeforeBridge();

async function writeState(snapshot: ExternalControllerSnapshot): Promise<void> {
  const target = path.join(userDataDir, STATE_FILE);
  const temp = `${target}.tmp`;
  const payload = JSON.stringify(snapshot) + '\n';
  writeFlight = writeFlight.then(async () => {
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(temp, payload, { mode: 0o600 });
    await fs.rename(temp, target);
    if (process.platform !== 'win32') await fs.chmod(target, 0o600);
  });
  return writeFlight;
}

function scheduleStateWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void writeState(snapshotExternalController()).catch((error) => {
      logError(`external controller state write failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 50);
  writeTimer.unref?.();
}

async function start(): Promise<void> {
  onExternalControllerPersist(scheduleStateWrite);
  onExternalControllerPersistNow(writeState);
  server = await startExternalControllerServer(userDataDir);
  logInfo('external controller ready');
}

void app.whenReady().then(start).catch((error) => {
  logError(`external controller failed to start: ${error instanceof Error ? error.message : String(error)}`);
});

app.on('before-quit', () => {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  void writeState(snapshotExternalController()).catch(() => undefined);
  const active = server;
  server = null;
  void active?.close().catch(() => undefined);
});
