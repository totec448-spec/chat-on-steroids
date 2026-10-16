import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePath, SandboxError } from '../src/main/sandbox.js';
import { closeRemoteSessions, setSftpOpenerForTests } from '../src/main/remote/ssh.js';
import { SftpClient } from '../src/main/remote/sftp.js';
import type { Root } from '../src/shared/types.js';

/**
 * #1469 part 2: a path in a server folder resolves inside that folder exactly as a local one does:
 * no "..", no link that leaves it, missing files only where a write allows them. The server is
 * OpenSSH's own sftp-server; its realpath is what proves where a link really goes.
 */
const SERVER = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/sftp-server'].find(existsSync);
const real = describe.skipIf(!SERVER || process.platform === 'win32');

let directory: string, app: string, root: Root;
/** Only callers that work on a server folder say so; see the refusal below. */
const on = { remote: true } as const;
const servers: ChildProcessWithoutNullStreams[] = [];

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-remote-sandbox-')));
  app = path.join(directory, 'app');
  await fs.mkdir(path.join(app, 'src'), { recursive: true });
  await fs.mkdir(path.join(directory, 'outside'));
  await fs.writeFile(path.join(app, 'src', 'a.ts'), 'export {};\n');
  await fs.writeFile(path.join(app, 'with space ü.txt'), 'x');
  await fs.symlink(path.join(directory, 'outside'), path.join(app, 'escape'));
  await fs.symlink(path.join(app, 'src'), path.join(app, 'inside'));
  root = { name: 'app', path: `me@devbox:${app}`, remote: { host: 'me@devbox', path: app } };
  setSftpOpenerForTests(async () => {
    const server = spawn(SERVER!, [], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    servers.push(server);
    return SftpClient.start(server.stdout, server.stdin);
  });
});
afterEach(async () => {
  closeRemoteSessions();
  setSftpOpenerForTests(null);
  for (const server of servers.splice(0)) server.kill();
  await fs.rm(directory, { recursive: true, force: true });
});

real('paths in a folder on a server', () => {
  it('resolves files and folders by their path on the server', async () => {
    expect(await resolvePath([root], '/app/src/a.ts', on)).toEqual({ real: path.join(app, 'src', 'a.ts'), virtual: '/app/src/a.ts', root });
    expect(await resolvePath([root], '/app', on)).toMatchObject({ real: app, virtual: '/app' });
    expect((await resolvePath([root], '/app/with space ü.txt', on)).real).toBe(path.join(app, 'with space ü.txt'));
    // A link that stays inside resolves to where it points.
    expect((await resolvePath([root], '/app/inside/a.ts', on)).real).toBe(path.join(app, 'src', 'a.ts'));
  });

  it('refuses traversal, a link leaving the folder and a missing file unless a write allows it', async () => {
    await expect(resolvePath([root], '/app/../outside', on)).rejects.toThrow(SandboxError);
    await expect(resolvePath([root], '/app/escape', on)).rejects.toThrow(/escapes its approved folder/);
    await expect(resolvePath([root], '/app/escape/new.txt', { ...on, allowMissing: true })).rejects.toThrow(/escapes its approved folder/);
    await expect(resolvePath([root], '/app/src/new.ts', on)).rejects.toThrow(/Not found: \/app\/src\/new.ts/);
    expect(await resolvePath([root], '/app/src/new/deeper.ts', { ...on, allowMissing: true }))
      .toMatchObject({ real: path.join(app, 'src', 'new', 'deeper.ts'), virtual: '/app/src/new/deeper.ts' });
  });

  // A link to something that does not exist reads as missing, and a write through it would create
  // its target wherever the link points: refused, never treated as a new file.
  it('refuses a dangling link instead of treating it as a new file', async () => {
    await fs.symlink(path.join(directory, 'outside', 'planted.txt'), path.join(app, 'dangling'));
    await expect(resolvePath([root], '/app/dangling', { ...on, allowMissing: true })).rejects.toThrow(/link that could not be resolved/);
    await expect(resolvePath([root], '/app/dangling/deeper.txt', { ...on, allowMissing: true })).rejects.toThrow(/link that could not be resolved/);
  });

  // A caller written for this computer's disk would act on a local path that only exists on the
  // server: it never receives one.
  it('refuses a server folder to a caller that does not work on servers', async () => {
    await expect(resolvePath([root], '/app/src/a.ts')).rejects.toThrow(/only in folders on this computer/);
    await expect(resolvePath([root], '/app/new.ts', { allowMissing: true })).rejects.toThrow(/only in folders on this computer/);
  });

  // The model reads the server's own paths in command output (`pwd`) and copies them back.
  it('takes a path as the server prints it, with the same rules as the virtual one', async () => {
    expect(await resolvePath([root], `${app}/src/a.ts`, on)).toMatchObject({ real: path.join(app, 'src', 'a.ts'), virtual: '/app/src/a.ts' });
    expect(await resolvePath([root], app, on)).toMatchObject({ virtual: '/app' });
    await expect(resolvePath([root], `${app}/../outside`, on)).rejects.toThrow(SandboxError);
    await expect(resolvePath([root], `${app}/escape/x`, { ...on, allowMissing: true })).rejects.toThrow(/escapes its approved folder/);
    // Only at a segment boundary: a sibling whose name merely starts the same is not inside.
    await expect(resolvePath([root], `${app}-other/x`, on)).rejects.toThrow(SandboxError);
    // A caller that does not work on servers still never receives it.
    await expect(resolvePath([root], `${app}/src/a.ts`)).rejects.toThrow(/only in folders on this computer/);
  });

  it('says so when the folder is gone from the server', async () => {
    await fs.rm(app, { recursive: true, force: true });
    await expect(resolvePath([root], '/app/src/a.ts', on)).rejects.toThrow(/not available on the server/);
  });
});
