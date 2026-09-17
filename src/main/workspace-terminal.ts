import { spawn, type IPty } from 'node-pty';
import { defaultUserShell } from './codex/shell.js';
import { normalizeEnvironment, deleteEnvValue } from './env.js';
import { projectWorkspace } from './projects.js';
import { getConfig, effectiveCapabilities } from './config.js';
import type { WorkspaceTerminalEvent, WorkspaceTerminalInfo } from '../shared/workspace-terminal.js';

type Entry = { projectId: string; cwd: string; pty: IPty; unacked: number; paused: boolean };
/** Human-operated shells belong to one renderer lifetime, never an MCP caller or its output queue. */
export class WorkspaceTerminals {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, symbol>();
  constructor(private readonly emit: (event: WorkspaceTerminalEvent) => void) {}

  private allowed(): void {
    if (!effectiveCapabilities(getConfig()).command) throw new Error('Command execution is disabled in Settings');
  }

  async create(id: string, projectId: string, cols: number, rows: number): Promise<WorkspaceTerminalInfo> {
    this.allowed();
    if (this.entries.has(id) || this.pending.has(id)) throw new Error('Terminal already exists');
    if (this.entries.size + this.pending.size >= 8) throw new Error('Close a terminal before opening another (maximum 8)');
    const ticket = Symbol(); this.pending.set(id, ticket);
    try {
      const { real: cwd } = await projectWorkspace(projectId);
      this.allowed();
      if (this.pending.get(id) !== ticket) throw new Error('Terminal opening was cancelled');
      const shell = defaultUserShell();
      const env = normalizeEnvironment(); deleteEnvValue(env, 'ELECTRON_RUN_AS_NODE');
      const pty = spawn(shell.shellPath, shell.shellType === 'powershell' ? ['-NoLogo'] : [], {
        name: 'xterm-256color', cols, rows, cwd, env, useConpty: true
      });
      const entry: Entry = { projectId, cwd, pty, unacked: 0, paused: false };
      this.entries.set(id, entry);
      pty.onData(data => {
        if (this.entries.get(id) !== entry) return;
        // Renderer acknowledgements follow xterm's parser, bounding IPC and hidden-tab output.
        for (let at = 0; at < data.length; at += 16_384) {
          const chunk = data.slice(at, at + 16_384); entry.unacked += chunk.length;
          this.emit({ id, data: chunk });
        }
        if (entry.unacked >= 262_144 && !entry.paused) { entry.paused = true; pty.pause(); }
      });
      pty.onExit(({ exitCode }) => {
        if (this.entries.get(id) !== entry) return;
        this.entries.delete(id); this.emit({ id, exitCode });
      });
      return { id, projectId, cwd, shell: shell.shellType };
    } finally { if (this.pending.get(id) === ticket) this.pending.delete(id); }
  }

  async write(id: string, data: string): Promise<void> {
    this.allowed();
    const entry = this.entries.get(id); if (!entry) throw new Error('Terminal is closed');
    const current = await projectWorkspace(entry.projectId);
    this.allowed();
    if (this.entries.get(id) !== entry || current.real !== entry.cwd) throw new Error('Terminal project changed');
    entry.pty.write(data);
  }
  resize(id: string, cols: number, rows: number): void { this.entries.get(id)?.pty.resize(cols, rows); }
  acknowledge(id: string, count: number): void {
    const entry = this.entries.get(id); if (!entry) return;
    entry.unacked = Math.max(0, entry.unacked - count);
    if (entry.paused && entry.unacked < 65_536) { entry.paused = false; entry.pty.resume(); }
  }
  close(id: string): void {
    this.pending.delete(id);
    const entry = this.entries.get(id); this.entries.delete(id);
    try { entry?.pty.kill(); } catch { /* Already exited. */ }
  }
  dispose(): void { this.pending.clear(); for (const id of this.entries.keys()) this.close(id); }
}
