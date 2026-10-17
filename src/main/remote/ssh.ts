import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SftpClient, SftpError } from './sftp.js';

/**
 * The SSH side of SSH projects (#1469): the person's own `ssh` program makes every connection,
 * so their `~/.ssh/config` (aliases, users, ports, ProxyJump), agent, keys and known hosts all
 * apply, and nothing is installed on the server. Login is by key or agent only: `BatchMode`
 * makes ssh fail instead of asking for a password or a new host key the app could not answer.
 */

import type { RemoteFolder } from '../../shared/types.js';
export type { RemoteFolder };

/** An alias, a hostname or IPv4, optionally `user@`; IPv6 only in brackets. */
const HOST = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\])$/;

export function parseRemote(address: string, folder: string): RemoteFolder {
  let host = address.trim().replace(/^ssh:\/\//i, '');
  let port: number | undefined;
  const withPort = /^(.*):(\d+)$/.exec(host);
  if (withPort && (!host.includes('[') || host.includes(']:'))) {
    port = Number(withPort[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The port must be between 1 and 65535.');
    host = withPort[1]!;
  }
  if (!HOST.test(host)) throw new Error('Enter an SSH address such as dev, me@server or me@server:2222.');
  host = host.replace(/^\[(.*)\]$/, '$1').replace(/@\[(.*)\]$/, '@$1');
  const trimmed = folder.trim().replace(/(.)\/+$/, '$1');
  // eslint-disable-next-line no-control-regex
  if (!/^(?:\/|~(?:\/|$))/.test(trimmed) || /[\x00-\x1f]/.test(trimmed) || trimmed.split('/').includes('..')) {
    throw new Error('Enter the folder on the server as an absolute path, such as /srv/app or ~/app.');
  }
  return port ? { host, port, path: trimmed } : { host, path: trimmed };
}

/** The identity a server folder is stored under, in its root and project: `host[:port]:/path`. */
export function remoteIdentity(remote: RemoteFolder): string {
  return `${remote.host}${remote.port ? `:${remote.port}` : ''}:${remote.path}`;
}

/** Arguments for `ssh`: options, then `--`, the host and the remote part. */
export function sshArgs(remote: RemoteFolder, options: string[], rest: string[]): string[] {
  return [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    ...(remote.port ? ['-p', String(remote.port)] : []), ...options, '--', remote.host, ...rest
  ];
}

export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** A folder for `cd`: a leading `~` stays unquoted so the server's shell expands it. */
const quoteFolder = (folder: string): string =>
  folder === '~' ? '~' : folder.startsWith('~/') ? `~/${shellQuote(folder.slice(2))}` : shellQuote(folder);

/**
 * Characters every common login shell keeps as written inside single quotes: sh, bash, zsh, fish
 * and csh/tcsh. sshd hands the remote part to the account's login shell, which must parse it;
 * fish reads `\\` and `\'` inside single quotes and has no `${…}`, csh ends a quote at a newline
 * and has no `:-`, and `%` and a leading `-` mean something to printf.
 */
const PORTABLE = /^[A-Za-z0-9 .,:/=_+@]$/;

/**
 * A POSIX script, as a remote command any of those login shells runs unchanged: every other byte
 * travels as a printf octal escape, and `/bin/sh` decodes and runs it.
 */
export function viaPosixShell(script: string): string {
  let format = '';
  for (const byte of Buffer.from(script, 'utf8')) {
    const char = String.fromCharCode(byte);
    format += byte < 0x80 && PORTABLE.test(char) ? char : `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `exec /bin/sh -c 'eval "$(printf "$0")"' '${format}'`;
}

/**
 * The command line the server runs: in the project folder, in a login shell for the account's
 * environment. As on this computer (`detectShellType`), the command runs in the account's shell only
 * when that is bash, zsh or sh; any other (fish, csh, dash, ksh) gets bash, then zsh, then /bin/sh,
 * since the model writes POSIX shell commands.
 */
export function remoteCommand(folder: string, command: string): string {
  return viaPosixShell(`cd -- ${quoteFolder(folder)} && s=\${SHELL:-/bin/sh} && case \${s##*/} in bash|zsh|sh) ;; ` +
    `*) s=$(command -v bash 2>/dev/null || command -v zsh 2>/dev/null) || s=/bin/sh ;; esac && exec "$s" -lc ${shellQuote(command)}`);
}

/** An interactive login shell in the project folder, for the workspace terminal: the account's own. */
export function remoteLoginShell(folder: string): string {
  return viaPosixShell(`cd -- ${quoteFolder(folder)} && exec "\${SHELL:-/bin/sh}" -l`);
}

/** What ssh's own error output means for the person, in one sentence. */
export function sshFailure(stderr: string): string {
  const text = stderr.trim();
  if (/Permission denied/i.test(text)) return 'The server did not accept your SSH key. Add the key to your SSH agent or ~/.ssh/config so `ssh <address>` works without a password.';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return 'This server is not trusted yet. Run `ssh <address>` once in a terminal and confirm its host key.';
  if (/Could not resolve hostname/i.test(text)) return 'The server was not found. Check the address or its Host entry in ~/.ssh/config.';
  if (/Connection refused/i.test(text)) return 'The server refused the connection. Check that SSH runs on it and the port is right.';
  if (/timed out/i.test(text)) return 'The server did not answer in time.';
  if (/subsystem request failed/i.test(text)) return 'The server does not offer SFTP, which SSH projects need for files.';
  return text.split('\n').filter(Boolean).at(-1)?.slice(0, 300) || 'SSH could not connect.';
}

let programOverride: string | null = null;
/** Test seam: runs this program instead of the system's ssh; null restores it. */
export function setSshProgramForTests(program: string | null): void { programOverride = program; }

/** The system's own OpenSSH client. */
export function sshProgram(): string {
  if (programOverride) return programOverride;
  if (process.platform === 'win32') {
    const builtin = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (existsSync(builtin)) return builtin;
  }
  return 'ssh';
}

export interface SshOptions { ssh?: string }

/**
 * The ssh processes behind open SFTP sessions. Closing a session's stream need not end its ssh, and
 * on Windows a child outlives the app that started it, so `closeRemoteSessions` ends them itself.
 */
const sftpProcesses = new Set<ChildProcess>();

/** One SFTP session over `ssh -s <host> sftp`; ssh's error output explains a failed start. */
export async function openSftp(remote: RemoteFolder, options: SshOptions = {}): Promise<SftpClient> {
  const child = spawn(options.ssh ?? sshProgram(), sshArgs(remote, ['-s'], ['sftp']), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  sftpProcesses.add(child);
  child.once('exit', () => sftpProcesses.delete(child));
  child.once('error', () => sftpProcesses.delete(child));
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
  // 'close' comes after ssh's output is read to its end: 'exit', and the end of stdout, can come
  // before ssh's error text has arrived, and the reason would be lost.
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const exited = new Promise<never>((_resolve, reject) => {
    child.once('error', error => reject(new SftpError('ENOENT', `SSH is not available on this computer (${error.message})`)));
    void closed.then(() => reject(new SftpError('ECONNREFUSED', sshFailure(stderr))));
  });
  exited.catch(() => undefined);
  try {
    const client = await Promise.race([SftpClient.start(child.stdout, child.stdin, { handshakeMs: 30_000 }), exited]);
    child.once('exit', () => client.close());
    return client;
  } catch (error) {
    // A handshake that failed because the stream ended waits briefly for ssh to finish saying why.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); })]);
    clearTimeout(timer);
    child.kill();
    // A start that failed because ssh exited says why; the handshake's own error does not.
    if (error instanceof SftpError && error.code !== 'ECONNREFUSED' && stderr.trim()) throw new SftpError('ECONNREFUSED', sshFailure(stderr));
    throw error;
  }
}

const sessions = new Map<string, Promise<SftpClient>>();
let opener: (remote: RemoteFolder, options: SshOptions) => Promise<SftpClient> = openSftp;

/** Test seam: opens sessions with this instead of ssh; null restores ssh. */
export function setSftpOpenerForTests(open: ((remote: RemoteFolder) => Promise<SftpClient>) | null): void {
  opener = open ?? openSftp;
  sessions.clear();
}
const sessionKey = (remote: RemoteFolder) => `${remote.host}\u0000${remote.port ?? ''}`;

/** The shared SFTP session for this address, opened on first use and again after it closed. */
export function sftpFor(remote: RemoteFolder, options: SshOptions = {}): Promise<SftpClient> {
  const key = sessionKey(remote);
  const known = sessions.get(key);
  if (known) return known.then(client => client.closed ? (sessions.delete(key), sftpFor(remote, options)) : client);
  const opening = opener(remote, options);
  sessions.set(key, opening);
  opening.catch(() => { if (sessions.get(key) === opening) sessions.delete(key); });
  return opening;
}

/** Closes every SFTP session and ends the ssh processes behind them (quit, tests). */
export function closeRemoteSessions(): void {
  for (const session of sessions.values()) session.then(client => client.close(), () => undefined);
  sessions.clear();
  for (const child of sftpProcesses) { try { child.kill(); } catch { /* already gone */ } }
  sftpProcesses.clear();
}
