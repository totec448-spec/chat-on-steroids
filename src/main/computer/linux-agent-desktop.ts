import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validLinuxDesktopRef } from './linux-desktop-ref.js';

/** The adapter is deliberately separate from authorization and MCP registration. */
export type LinuxDesktopCommand =
  | { kind: 'version' }
  | { kind: 'status' }
  | { kind: 'windows' }
  | { kind: 'apps' }
  | { kind: 'displays' }
  | { kind: 'snapshot'; windowId: string; session: string }
  | { kind: 'screenshot'; display: number }
  | { kind: 'click'; ref: string; session: string }
  | { kind: 'setValue'; ref: string; session: string; value: string };

export interface LinuxDesktopEnvelope {
  ok: boolean;
  command: string;
  data?: unknown;
  error?: unknown;
}

export class LinuxDesktopError extends Error {}

const MAX_OUTPUT = 12 * 1024 * 1024;
const NORMAL_TIMEOUT_MS = 15_000;
// The Wayland screenshot portal itself can wait at least 30 seconds for consent.
const SCREENSHOT_TIMEOUT_MS = 45_000;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;

function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new LinuxDesktopError('Invalid desktop identifier');
  return value;
}

/** Only commands admitted here can reach the executable; never use a shell. */
export function linuxDesktopArgs(command: LinuxDesktopCommand): string[] {
  switch (command.kind) {
    case 'version': return ['version'];
    case 'status': return ['status'];
    case 'windows': return ['list-windows'];
    case 'apps': return ['list-apps'];
    case 'displays': return ['list-displays'];
    case 'snapshot': return ['snapshot', '--window-id', identifier(command.windowId), '--session', identifier(command.session), '--interactive-only', '--compact'];
    case 'screenshot':
      if (!Number.isInteger(command.display) || command.display < 0 || command.display > 32) throw new LinuxDesktopError('Invalid display index');
      return ['screenshot', '--screen', String(command.display)];
    case 'click':
    case 'setValue': {
      if (!validLinuxDesktopRef(command.ref)) throw new LinuxDesktopError('Invalid accessibility reference');
      const args = [command.kind === 'click' ? 'click' : 'set-value', '--session', identifier(command.session), '--', command.ref];
      if (command.kind === 'setValue') {
        if (command.value.length > 4000 || command.value.includes('\0')) throw new LinuxDesktopError('Invalid text value');
        args.push(command.value);
      }
      return args;
    }
  }
}

/**
 * One bounded process. A timeout or broken response after an action is an unknown outcome;
 * callers must not retry it automatically. Backend error envelopes are returned unchanged.
 */
export function runLinuxDesktop(command: LinuxDesktopCommand, binary = join(homedir(), '.local', 'bin', 'agent-desktop')): Promise<LinuxDesktopEnvelope> {
  const args = linuxDesktopArgs(command);
  const timeout = command.kind === 'screenshot' ? SCREENSHOT_TIMEOUT_MS : NORMAL_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: string | null = null;
    const timer = setTimeout(() => { failure = 'Desktop backend timed out; an action may have been delivered'; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { failure = 'Desktop backend output exceeded its limit; an action may have been delivered'; child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    // Drain stderr but never log it: it may contain application data.
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new LinuxDesktopError('Cannot start agent-desktop; check its installation')); });
    child.once('close', () => {
      clearTimeout(timer);
      if (failure) return reject(new LinuxDesktopError(failure));
      try {
        const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!result || typeof result !== 'object' || typeof (result as LinuxDesktopEnvelope).ok !== 'boolean' || typeof (result as LinuxDesktopEnvelope).command !== 'string') throw new Error();
        resolve(result as LinuxDesktopEnvelope);
      } catch {
        reject(new LinuxDesktopError('Desktop backend returned an invalid response; an action may have been delivered'));
      }
    });
  });
}

/** Version 1.0.2 is the only backend whose Linux contract has been examined for this adapter. */
export async function checkLinuxDesktopVersion(binary?: string): Promise<void> {
  const result = await runLinuxDesktop({ kind: 'version' }, binary);
  const data = result.data as { os?: unknown; version?: unknown } | undefined;
  if (!result.ok || result.command !== 'version' || data?.os !== 'linux' || data.version !== '1.0.2') {
    throw new LinuxDesktopError('Unsupported agent-desktop version or operating system; this adapter requires Linux version 1.0.2');
  }
}
