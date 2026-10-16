import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRemote, remoteCommand, shellQuote, sshArgs, sshFailure, openSftp, closeRemoteSessions, sftpFor } from '../src/main/remote/ssh.js';
import { makeTempDir, removeTempDir } from './helpers.js';

describe('SSH project addresses', () => {
  it('accepts ssh config aliases, user@host, a port and an absolute path', () => {
    expect(parseRemote('dev', '/srv/app')).toEqual({ host: 'dev', path: '/srv/app' });
    expect(parseRemote(' me@10.0.0.5 ', '/home/me/app/')).toEqual({ host: 'me@10.0.0.5', path: '/home/me/app' });
    expect(parseRemote('me@box:2222', '/x')).toEqual({ host: 'me@box', port: 2222, path: '/x' });
    expect(parseRemote('[fe80::1]:2200', '/x')).toEqual({ host: 'fe80::1', port: 2200, path: '/x' });
    expect(parseRemote('ssh://me@box:2201', '/x')).toEqual({ host: 'me@box', port: 2201, path: '/x' });
    expect(parseRemote('box', '~/app')).toEqual({ host: 'box', path: '~/app' });
  });

  it('refuses anything ssh could read as an option or that is not a plain address', () => {
    for (const host of ['-oProxyCommand=evil', ' -p', 'a b', 'box;rm', 'bo\nx', '', 'me@', '@box', 'box:0', 'box:70000']) {
      expect(() => parseRemote(host, '/x'), host).toThrow();
    }
    for (const folder of ['relative', '', '/a/../b', '/a\0b', '/a\nb']) expect(() => parseRemote('box', folder), folder).toThrow();
  });

  it('puts the host after "--" and never lets ssh ask for a password', () => {
    const args = sshArgs({ host: 'me@box', port: 2222, path: '/srv' }, ['-s'], ['sftp']);
    expect(args).toContain('BatchMode=yes');
    expect(args.slice(-3)).toEqual(['--', 'me@box', 'sftp']);
    expect(args[args.indexOf('-p') + 1]).toBe('2222');
  });

  it('quotes a remote command so the folder and the command reach the shell intact', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(remoteCommand('/srv/my app', 'npm test')).toBe(`cd -- '/srv/my app' && exec "\${SHELL:-/bin/sh}" -lc 'npm test'`);
    expect(remoteCommand('~/app', 'ls')).toBe(`cd -- ~/'app' && exec "\${SHELL:-/bin/sh}" -lc 'ls'`);
  });

  it('turns ssh’s own failures into what to do about them', () => {
    expect(sshFailure('me@box: Permission denied (publickey).')).toMatch(/key/i);
    expect(sshFailure('Host key verification failed.')).toMatch(/ssh box|trust/i);
    expect(sshFailure('ssh: Could not resolve hostname nope: nodename nor servname provided')).toMatch(/not found/i);
    expect(sshFailure('ssh: connect to host box port 22: Connection refused')).toMatch(/refused/i);
    expect(sshFailure('subsystem request failed on channel 0')).toMatch(/SFTP/);
  });
});

const SERVER = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/sftp-server'].find(existsSync);

describe.skipIf(!SERVER || process.platform === 'win32')('opening SFTP through an ssh program', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.realpath(await makeTempDir('clf-ssh-')); });
  afterEach(async () => { closeRemoteSessions(); await removeTempDir(dir); });

  it('starts SFTP through the ssh binary and shares one session per address', async () => {
    // A stand-in for ssh: it records its arguments and runs OpenSSH's sftp-server.
    const fake = path.join(dir, 'fake-ssh');
    await fs.writeFile(fake, `#!/bin/sh\necho "$@" >> "${dir}/args"\nexec ${SERVER}\n`, { mode: 0o755 });
    await fs.writeFile(path.join(dir, 'hello.txt'), 'hi');
    const remote = { host: 'me@box', path: dir };
    const sftp = await openSftp(remote, { ssh: fake });
    expect((await sftp.readFile(path.join(dir, 'hello.txt'))).toString()).toBe('hi');
    sftp.close();
    const shared = await sftpFor(remote, { ssh: fake });
    expect(await sftpFor(remote, { ssh: fake })).toBe(shared);
    expect(await fs.readFile(path.join(dir, 'args'), 'utf8')).toContain('-s -- me@box sftp');
  });

  // On Windows a child outlives the app that started it; ssh also need not exit when its stream
  // ends. Closing the sessions (as quitting does) ends the ssh processes themselves.
  it('ends the ssh processes when the sessions are closed', async () => {
    const fake = path.join(dir, 'fake-ssh');
    await fs.writeFile(fake, `#!/bin/sh\necho $$ > "${dir}/pid"\n${SERVER}\nsleep 30\n`, { mode: 0o755 });
    await sftpFor({ host: 'me@box', path: dir }, { ssh: fake });
    const pid = Number((await fs.readFile(path.join(dir, 'pid'), 'utf8')).trim());
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive()).toBe(true);
    closeRemoteSessions();
    const end = Date.now() + 3000;
    while (alive() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
    expect(alive()).toBe(false);
  });

  it('reports why ssh could not connect', async () => {
    const fake = path.join(dir, 'fake-ssh');
    await fs.writeFile(fake, '#!/bin/sh\necho "me@box: Permission denied (publickey)." >&2\nexit 255\n', { mode: 0o755 });
    await expect(openSftp({ host: 'me@box', path: '/' }, { ssh: fake })).rejects.toThrow(/key/i);
  });
});
