import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, getConfig, initConfigPath, loadConfig, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { addRemoteProject, listProjects, projectWorkspace } from '../src/main/projects.js';
import { closeRemoteSessions, setSftpOpenerForTests } from '../src/main/remote/ssh.js';
import { createProjectEntry, listProjectDirectory, previewProjectFile, projectFileTarget, renameProjectEntry, saveProjectTextFile } from '../src/main/project-files.js';
import { readProjectGitSnapshot } from '../src/main/project-git.js';
import { SftpClient } from '../src/main/remote/sftp.js';

/**
 * #1469 part 2: a folder on a server becomes a project and an approved root, by its real path on
 * that server. OpenSSH's own sftp-server stands in for the server: its working directory plays
 * the remote home, so `~/app` resolves the way `ssh -s sftp` resolves it there.
 */
const SERVER = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/sftp-server'].find(existsSync);
const real = describe.skipIf(!SERVER);

let directory: string, home: string;
const servers: ChildProcessWithoutNullStreams[] = [];
const clients: SftpClient[] = [];
const connect = async (): Promise<SftpClient> => {
  const server = spawn(SERVER!, [], { cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
  servers.push(server);
  const client = await SftpClient.start(server.stdout, server.stdin);
  clients.push(client);
  return client;
};

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-remote-projects-')));
  home = path.join(directory, 'home');
  await fs.mkdir(path.join(home, 'app', 'src'), { recursive: true });
  await fs.writeFile(path.join(home, 'notes.txt'), 'x');
  initConfigPath(directory); initDurableStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [] });
});
afterEach(async () => {
  closeRemoteSessions();
  setSftpOpenerForTests(null);
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) server.kill();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

real('projects on a server', () => {
  it('adds a server folder as a project and an approved root, by its real path', async () => {
    const project = await addRemoteProject('me@devbox', '~/app', { connect });
    const realPath = path.join(home, 'app');
    expect(project).toMatchObject({ name: 'app', remote: { host: 'me@devbox', path: realPath } });
    expect(getConfig().roots).toEqual([{ name: 'app', path: `me@devbox:${realPath}`, remote: { host: 'me@devbox', path: realPath } }]);
    expect(await listProjects()).toEqual([project]);
    // The same folder again, spelled differently, is the same project.
    expect((await addRemoteProject('me@devbox', `${realPath}/`, { connect })).id).toBe(project.id);
    expect(getConfig().roots).toHaveLength(1);
  });

  // The saved settings with a server folder load again unchanged: a root that is not a local
  // path must not read as an invalid file (which would reset the settings to defaults).
  it('keeps a server folder across a restart of the app', async () => {
    const project = await addRemoteProject('me@devbox:2222', '~/app', { connect });
    const before = getConfig().roots;
    const loaded = await loadConfig();
    expect(loaded.roots).toEqual(before);
    expect(loaded.roots[0]).toMatchObject({ remote: { host: 'me@devbox', port: 2222, path: path.join(home, 'app') } });
    expect((await listProjects()).find(row => row.id === project.id)?.remote).toEqual(loaded.roots[0]!.remote);
  });

  it('keeps the port and refuses a file, a missing folder and an address that is not one', async () => {
    const project = await addRemoteProject('me@devbox:2222', '~/app/src', { connect });
    expect(project.remote).toEqual({ host: 'me@devbox', port: 2222, path: path.join(home, 'app', 'src') });
    await expect(addRemoteProject('me@devbox', '~/notes.txt', { connect })).rejects.toThrow(/not a folder/);
    await expect(addRemoteProject('me@devbox', '~/missing', { connect })).rejects.toThrow(/not found/i);
    await expect(addRemoteProject('-oProxyCommand=x', '/srv', { connect })).rejects.toThrow(/SSH address/);
    await expect(addRemoteProject('me@devbox', 'relative/app', { connect })).rejects.toThrow(/absolute path/);
  });

  // A chat bound to a server project works in that folder: its workspace is the server root.
  it('gives a server project its workspace, and says why when the folder is gone', async () => {
    setSftpOpenerForTests(connect);
    const project = await addRemoteProject('me@devbox', '~/app', { connect });
    expect(await projectWorkspace(project.id)).toEqual({ virtual: '/app', real: path.join(home, 'app') });
    await fs.rm(path.join(home, 'app'), { recursive: true });
    await expect(projectWorkspace(project.id)).rejects.toThrow(/server folder is unavailable: .*not available on the server/);
  });

  // The Files panel browses a server project over the same SFTP session; editing from the app
  // waits for a later version and says so instead of acting on this computer's disk.
  it('lists and previews a server project in Files, and refuses editing it there', async () => {
    setSftpOpenerForTests(connect);
    await fs.writeFile(path.join(home, 'app', 'README.md'), '# hi\nthere\n');
    await fs.mkdir(path.join(home, 'app', '.git'));
    await fs.writeFile(path.join(home, 'app', 'src', 'a.ts'), 'export {};\n');
    await fs.writeFile(path.join(home, 'app', 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const project = await addRemoteProject('me@devbox', '~/app', { connect });
    const top = await listProjectDirectory(project.id);
    expect(top.entries.map(entry => entry.name).sort()).toEqual(['README.md', 'pixel.png', 'src']);
    expect((await listProjectDirectory(project.id, 'src')).entries).toMatchObject([{ name: 'a.ts', path: 'src/a.ts', kind: 'file' }]);
    expect(await previewProjectFile(project.id, 'README.md')).toMatchObject({ name: 'README.md', binary: false, text: '# hi\nthere' });
    expect(await previewProjectFile(project.id, 'pixel.png')).toMatchObject({ binary: true, text: null, note: expect.stringMatching(/server/) });
    await expect(listProjectDirectory(project.id, '../home')).rejects.toThrow();
    await expect(createProjectEntry(project.id, '', 'new.ts', 'file')).rejects.toThrow(/server/);
    await expect(renameProjectEntry(project.id, 'README.md', 'X.md')).rejects.toThrow(/server/);
    await expect(saveProjectTextFile(project.id, 'README.md', 'x', '', 0, '')).rejects.toThrow(/server/);
    expect(await fs.readFile(path.join(home, 'app', 'README.md'), 'utf8')).toBe('# hi\nthere\n');
    // Everything that works on this computer's disk (Git, the file watcher) refuses the server
    // project's root instead of acting on a local path that happens to have the same name.
    await expect(projectFileTarget(project.id, '', { allowRoot: true })).rejects.toThrow(/server/);
    expect(await readProjectGitSnapshot(project.id)).toMatchObject({ state: 'unavailable', message: expect.stringMatching(/server/) });
  });
});
