# SSH Projects Implementation Plan (#1469)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project can be a folder on a server reached over SSH: ChatGPT reads, searches, patches files and runs commands there through Core, and the app's terminal opens there, with the same containment rules as a local folder.

**Architecture:** A remote project is an approved root with a `remote` address. Path resolution keeps the virtual `/name/...` model; for a remote root the real path is a POSIX path on the server, proven contained by SFTP `realpath`. File tools reach the disk only through `src/main/codex/filesystem.ts`; that module becomes one implementation (`localFs`) of a `ProjectFs` interface, and `sftpFs` is the other, built on part 1's `SftpClient`. Commands and the terminal run `ssh` with `remoteCommand(folder, command)` instead of a local shell.

**Tech Stack:** TypeScript (Electron main), the system OpenSSH client, SFTP v3 (`src/main/remote/sftp.ts`), vitest.

**Spec:** No spec file. Design approved by the user on 2026-10-14 21:43 UTC ("full"), restated in Global Constraints. Part 1 (transport + SFTP client) is commit 60a837cb on `feat/ssh-transport`.

## Global Constraints

- Connections only through the system `ssh` (`sshProgram()`), so `~/.ssh/config`, agent, ProxyJump and known_hosts apply; `BatchMode=yes` always: key or agent login only, never a password prompt.
- Nothing is installed on the server. Files go over one SFTP session per address (`sftpFor`); commands over `ssh <host> <remoteCommand>`.
- Same containment as local roots: no `..`, no symlink escaping the project folder (proved with SFTP `realpath`), no path outside the root.
- Git worktrees stay local-only in v1: sub-agent worktree isolation, the project Git panel and file watching are refused for SSH projects with a clear sentence, never silently local.
- Windows: one ssh connection per command (no ControlMaster); macOS/Linux may reuse the SFTP session for files.
- Every user-visible text translated into the 12 catalogs; English UI screenshots in PRs.
- No secrets in config: the address is `user@host[:port]` or an ssh-config alias only.

## Review Focus

1. Host key unknown or changed → the first connection fails with `sshFailure()`'s "not trusted yet" sentence, nothing hangs; tested in Task 1 (address check) and Task 3 (start failure).
2. A symlink inside the remote project that points outside → refused like locally; tested in Task 2.
3. SFTP session dropped mid-work (server reboot, Wi-Fi change) → the next call reopens it once; a file write is atomic (temp + rename) so an interrupted write never leaves half a file; tested in Task 3.
4. A long command whose ssh connection dies → `exec_command` reports the exit like a local crash, `write_stdin` answers "session ended"; tested in Task 6.
5. Paths with spaces, quotes, `~` and non-ASCII on the server → `shellQuote`/`remoteCommand` and SFTP paths round-trip; tested in Tasks 2 and 6.

---

### Task 1: Remote roots and projects

**Files:**
- Modify: `src/shared/types.ts` (`Root.remote?: RemoteFolder`), `src/shared/projects.ts` (`LocalProject.remote?: RemoteFolder`)
- Modify: `src/main/projects.ts` (`addRemoteProject`), `src/main/sandbox.ts` (`validateNewRemoteRoot`)
- Modify: `src/main/ipc.ts`, `src/preload/index.ts` (`projects:addRemote`)
- Test: `test/remote-projects.test.ts`

**Interfaces:**
- Consumes: `parseRemote(address, folder): RemoteFolder`, `sftpFor(remote)` from part 1.
- Produces: `addRemoteProject(address: string, folder: string, deps?: { sftp?: typeof sftpFor }): Promise<LocalProject>` — parses, opens SFTP, `realpath`s the folder, requires a directory, adds root `{ name, path: '<host>:<realpath>', remote: { host, port?, path: realpath } }` and the project; `isRemoteRoot(root): root is Root & { remote: RemoteFolder }`.

- [ ] **Step 1: Write the failing test**

```ts
it('adds a server folder as a project and root, by its real path', async () => {
  const sftp = fakeSftp({ '/home/me/app': { isDirectory: true } }, { realpath: { '~/app': '/home/me/app' } });
  const project = await addRemoteProject('me@devbox', '~/app', { sftp: async () => sftp });
  expect(project).toMatchObject({ name: 'app', remote: { host: 'me@devbox', path: '/home/me/app' } });
  expect(getConfig().roots.at(-1)).toMatchObject({ name: 'app', remote: { host: 'me@devbox', path: '/home/me/app' } });
});
it('refuses a file, a missing folder and an address that is not one', async () => {
  const sftp = fakeSftp({ '/home/me/notes.txt': { isFile: true } });
  await expect(addRemoteProject('me@devbox', '/home/me/notes.txt', { sftp: async () => sftp })).rejects.toThrow(/folder/);
  await expect(addRemoteProject('-oProxyCommand=x', '/srv', { sftp: async () => sftp })).rejects.toThrow(/SSH address/);
});
```

- [ ] **Step 2:** `npx vitest run test/remote-projects.test.ts` → FAIL (`addRemoteProject` not exported).
- [ ] **Step 3:** Implement `addRemoteProject` in `projects.ts` following `addProject` (same mutation queue, 200 limit, duplicate = same host+realpath), and `validateNewRemoteRoot` (unique root name via `uniqueRootName`).
- [ ] **Step 4:** Tests pass; `npm run typecheck`.
- [ ] **Step 5:** Commit `SSH projects, part 2: remote roots and projects (#1469)`.

### Task 2: Resolving paths in a remote root

**Files:** Modify `src/main/sandbox.ts` (`resolvePath` branch); Test `test/remote-sandbox.test.ts`

**Interfaces:**
- Consumes: `isRemoteRoot`, `sftpFor`.
- Produces: `resolvePath()` returns `{ real: '/home/me/app/src/a.ts', virtual: '/app/src/a.ts', root }` for a remote root; containment uses `path.posix` and SFTP `realpath` of the deepest existing part (mirror of `realpathDeepest`).

- [ ] **Step 1: Write the failing tests** — resolves `/app/src/a.ts`; refuses `/app/../etc/passwd`; refuses `/app/link` whose `realpath` is `/etc`; `allowMissing` for a new file; a name with spaces and `ü` round-trips.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `remoteRealpathDeepest(client, candidate)` and the remote branch in `resolvePath` (no `fs.realpath` for remote roots; `toVirtualPath` with `path.posix.relative`).
- [ ] **Step 4:** Pass; local resolve tests unchanged.
- [ ] **Step 5:** Commit.

### Task 3: `ProjectFs` and the SFTP file system

**Files:** Create `src/main/remote/project-fs.ts`; Modify `src/main/codex/filesystem.ts` (export `localFs`), `src/main/remote/sftp.ts` (atomic `writeFile`, reconnect once); Test `test/remote-project-fs.test.ts` (runs against OpenSSH `sftp-server` like part 1's test, skipped when absent).

**Interfaces:**
- Produces:
```ts
export interface ProjectFs {
  getMetadata(path: string): Promise<FileMetadata>;
  readDirectory(path: string): Promise<ReadDirectoryEntry[]>;
  readFileStream(path: string): AsyncGenerator<Buffer>;
  readFile(path: string, maxBytes?: number): Promise<Buffer>;
  writeFile(path: string, contents: Buffer | string): Promise<void>;
  createDirectory(path: string, options: CreateDirectoryOptions): Promise<void>;
  remove(path: string, options: RemoveOptions): Promise<void>;
  walk(root: string, options: WalkOptions): Promise<WalkOutcome>;
}
export const localFs: ProjectFs;          // the existing functions
export function sftpFs(remote: RemoteFolder): ProjectFs;
export function fsForRoot(root: Root): ProjectFs;
```
- [ ] Steps: failing tests for metadata/readdir/stream/read/write(atomic, mode kept)/mkdir -p/remove recursive/walk limits/reconnect after the session closes → implement → pass → commit.

### Task 4: read, view_image and apply_patch through `ProjectFs`

**Files:** Modify `src/main/codex/read-backend.ts`, `src/main/codex/view-image.ts`, `src/main/codex/apply-patch/index.ts`, `src/main/codex/apply-patch/file-update.ts`, `src/main/mcp/tools-core.ts` (pass `fsForRoot(resolved.root)`; patch rollback snapshots through the same fs); Test `test/remote-tools.test.ts` (tools against an in-memory `ProjectFs`).

- [ ] Steps: failing tests — `read` of a remote file with line ranges, a binary refusal, `view_image` of a PNG, `apply_patch` add/update/delete/move inside the remote root and its rollback on a failed hunk → thread the fs parameter (default `localFs`, so local behavior is byte-identical) → full suite → commit.

### Task 5: `find` in a remote root

**Files:** Modify `src/main/search.ts` (remote branch: `fs.walk` + in-process matching with the same limits and excludes; ripgrep stays local-only); Test `test/remote-search.test.ts`.

- [ ] Steps: failing tests for name glob, content regex, excludes (`node_modules`), the 5,000-file scan limit message → implement → commit.

### Task 6: `exec_command` and `write_stdin` over ssh

**Files:** Modify `src/main/mcp/tools-core.ts` (remote workspace → `command = [sshProgram(), ...sshArgs(remote, tty ? ['-tt'] : ['-T'], [remoteCommand(cwd, commandText)])]`, local `cwd` = app temp dir), `src/main/codex/unified-exec.ts` (no change expected); Test `test/remote-exec.test.ts` (fake `ssh` script that records argv and runs the command locally).

- [ ] Steps: failing tests — argv for a plain and a tty command; cwd with spaces and `~`; exit code and output passed through; `write_stdin` into a `-tt` session; ssh dying mid-command reports the exit; Windows uses one connection per command → implement → commit.

### Task 7: The workspace terminal over ssh

**Files:** Modify `src/main/workspace-terminal.ts` (remote project → pty running `ssh -tt <host> 'cd -- <folder> && exec "${SHELL:-/bin/sh}" -l'`); Test `test/workspace-terminal.test.ts` (new remote case with a fake ssh).

- [ ] Steps: failing test → implement → `npm run verify:ui -- workspace-terminal` → commit.

### Task 8: What SSH projects do not do in v1, said clearly

**Files:** `src/main/agent-admission.ts`/worktree allocation (refuse isolation for remote roots: "Sub-agents in an SSH project share its folder; separate worktrees are only available for local projects."), `src/main/project-git.ts` (Git panel message), `src/main/project-file-watcher.ts` (no watcher; manual refresh), `src/main/project-files.ts` (file tree via `ProjectFs.readDirectory`); Tests in the matching test files.

- [ ] Steps: one failing test per refusal/fallback → implement → commit.

### Task 9: Adding an SSH project in the app

**Files:** `src/renderer/index.html`, `src/renderer/main.ts` (Add project menu: "Folder on a server (SSH)…" → dialog with address, folder, "Test and add"; errors from `sshFailure()` shown inline; SSH badge on the project row), `src/renderer/styles.css`, 12 locale catalogs; Tests `test/renderer-state.test.ts`, a real-Electron check `scripts/verify-ssh-project-dialog.cjs`.

- [ ] Steps: failing renderer tests (dialog flow, error text, badge) → implement → UI check + screenshots (English) → commit.

### Task 10: Docs and live verification

- [ ] README + `docs/setup.md` section "Projects on a server (SSH)": requirements (OpenSSH client, key/agent login, SFTP on the server), what works, what is local-only.
- [ ] Live on macOS and the Windows VM against the homelab server: add project, `read`, `find`, `apply_patch`, `exec_command` (incl. a 2-minute command and `write_stdin`), terminal, host-key-unknown error, server reboot mid-session.
- [ ] Commit; PR per task group (parts 2–6), each with its tests and, for UI, screenshots.

## Self-review

- Spec coverage: connection model (T1/T3/T6/T7), containment (T2), files (T3–T5), commands (T6), terminal (T7), local-only limits (T8), UI (T9), docs + live (T10).
- Types: `RemoteFolder` (part 1) is used unchanged by T1–T7; `ProjectFs` (T3) is consumed by T4/T5/T8; `fsForRoot` by T4/T5/T8.
- Execution: inline (executing-plans) by the maintainer's agent, one PR per part, as the earlier multi-part features.
