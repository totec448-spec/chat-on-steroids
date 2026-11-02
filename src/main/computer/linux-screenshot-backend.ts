import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logInfo } from '../logger.js';

/** Screenshots are the ONLY native Linux operations admitted in this stage. */
export type LinuxScreenshotCommand = { kind: 'version' } | { kind: 'screenshot'; display: number };
export interface LinuxDesktopEnvelope {
  ok: boolean;
  command: string;
  data?: unknown;
  error?: unknown;
}

const MAX_OUTPUT = 12 * 1024 * 1024;
export function linuxScreenshotArgs(command: LinuxScreenshotCommand): string[] {
  if (command.kind === 'version') return ['version'];
  if (!Number.isInteger(command.display) || command.display < 0 || command.display > 32)
    throw new Error('Invalid display index');
  return ['screenshot', '--screen', String(command.display)];
}

/** The backend runs without a shell, arbitrary arguments or physical-input commands. */
export function runLinuxScreenshot(
  command: LinuxScreenshotCommand,
  binary = join(homedir(), '.local', 'bin', 'agent-desktop')
): Promise<LinuxDesktopEnvelope> {
  const args = linuxScreenshotArgs(command);
  const timeout = command.kind === 'screenshot' ? 45_000 : 15_000;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: string | null = null;
    const timer = setTimeout(() => {
      failure = 'Linux screenshot backend timed out; the portal request was not repeated';
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        failure = 'Linux screenshot response exceeded the size limit';
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    // A backend error can contain application titles or displayed text.
    child.stderr.resume();
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Cannot start the verified Linux screenshot backend'));
    });
    child.once('close', () => {
      clearTimeout(timer);
      if (failure) return reject(new Error(failure));
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' ||
            typeof (value as LinuxDesktopEnvelope).ok !== 'boolean' ||
            typeof (value as LinuxDesktopEnvelope).command !== 'string') throw new Error();
        if ((value as LinuxDesktopEnvelope).command !== command.kind) {
          logInfo('linux screenshot backend: refused because the response command did not match the requested command');
          throw new Error();
        }
        resolve(value as LinuxDesktopEnvelope);
      } catch {
        reject(new Error('Linux screenshot backend returned an invalid response'));
      }
    });
  });
}

/** Only the reviewed Linux agent-desktop 1.0.2 screenshot contract is accepted. */
export async function checkLinuxScreenshotVersion(binary?: string): Promise<void> {
  const result = await runLinuxScreenshot({ kind: 'version' }, binary);
  const value = result.data as { os?: unknown; version?: unknown } | undefined;
  if (!result.ok || value?.os !== 'linux' || value.version !== '1.0.2')
    throw new Error('Unsupported Linux screenshot backend; requires agent-desktop 1.0.2');
}
