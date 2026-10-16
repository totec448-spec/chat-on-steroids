import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRemote, remoteCommand, remoteLoginShell, shellQuote, sshArgs, sshFailure, openSftp, closeRemoteSessions, sftpFor } from '../src/main/remote/ssh.js';
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

  // sshd hands the remote part to the account's login shell. fish and csh read single quotes and
  // `${…}` differently from sh, so the part they see holds only characters all of them keep.
  it('sends a remote command any login shell passes on unchanged', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const remote = remoteCommand("/srv/my app's $x", 'printf "%s\\n" \'a\\b\' && echo ü\nexit 3');
    const quoted = /^exec \/bin\/sh -c 'eval "\$\(printf "\$0"\)"' '(.*)'$/.exec(remote)?.[1];
    expect(quoted).toBeDefined();
    expect(quoted).toMatch(/^(?:[A-Za-z0-9 .,:/=_+@]|\\[0-7]{3})*$/);
    expect(remoteLoginShell('~/app')).toMatch(/^exec \/bin\/sh -c 'eval "\$\(printf "\$0"\)"' '(?:[A-Za-z0-9 .,:/=_+@]|\\[0-7]{3})*'$/);
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

  // ssh's output can close before its error text is read (seen on Linux CI): the reason still
  // has to come through, not a bare "connection closed".
  it('reports why ssh could not connect even when its output closes first', async () => {
    const fake = path.join(dir, 'fake-ssh');
    await fs.writeFile(fake, '#!/bin/sh\nexec 1>&-\nsleep 0.3\necho "me@box: Permission denied (publickey)." >&2\nexit 255\n', { mode: 0o755 });
    await expect(openSftp({ host: 'me@box', path: '/' }, { ssh: fake })).rejects.toThrow(/key/i);
  });

  it('reports why ssh could not connect', async () => {
    const fake = path.join(dir, 'fake-ssh');
    await fs.writeFile(fake, '#!/bin/sh\necho "me@box: Permission denied (publickey)." >&2\nexit 255\n', { mode: 0o755 });
    await expect(openSftp({ host: 'me@box', path: '/' }, { ssh: fake })).rejects.toThrow(/key/i);
  });
});

// What a server runs, under every login shell this computer has: sshd runs `$SHELL -c <remote>`.
// The command itself runs in bash, zsh or sh, as on this computer; fish and csh get bash.
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash', '/usr/bin/dash', '/bin/tcsh', '/bin/csh', '/usr/bin/fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish']
  .filter(existsSync);
describe.skipIf(process.platform === 'win32')('a remote command under each login shell', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.realpath(await makeTempDir('clf-login-')); });
  afterEach(async () => { await removeTempDir(dir); });
  const run = (shell: string, remote: string, home: string) => new Promise<{ out: string; code: number | null }>(resolve => {
    const child = spawn(shell, ['-c', remote], { cwd: '/', env: { PATH: process.env.PATH, HOME: home, SHELL: shell } });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { out += chunk; });
    child.on('close', code => resolve({ out, code }));
  });
  it.each(SHELLS)('runs a command with quotes, a heredoc and Unicode in the folder under %s', async shell => {
    const folder = path.join(dir, "my app ü 'q' $x");
    await fs.mkdir(folder);
    const command = `printf '%s|' "$PWD" 'c'"'"'d' "e\\\\f" '%d'; echo\ncat <<'EOF'\nline ! \\ "two" \${x} \`y\` ü€\nEOF\nexit 7`;
    const { out, code } = await run(shell, remoteCommand(folder, command), dir);
    expect(out).toBe(`${folder}|c'd|e\\f|%d|\nline ! \\ "two" \${x} \`y\` ü€\n`);
    expect(code).toBe(7);
  });
  it.each(SHELLS)('finds a folder under ~ with %s as the login shell', async shell => {
    await fs.mkdir(path.join(dir, 'app'));
    const { out } = await run(shell, remoteCommand('~/app', 'pwd'), dir);
    expect(out.trim()).toBe(path.join(dir, 'app'));
  });
});
