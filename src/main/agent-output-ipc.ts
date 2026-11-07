import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { z } from 'zod';
import { AGENT_OUTPUT_FLUSH_MS, AgentOutputStream, exitSummary } from './agent-output.js';
import { unifiedExecManager } from './codex/manager.js';
import { runningExecProcesses } from './codex/ownership.js';
import { getConfig } from './config.js';
import { logInfo } from './logger.js';
import { sessionSecretsShieldOff } from './projects.js';
import type { AgentOutputEvent } from '../shared/background-exec.js';

/** Views open at once; a ninth closes nothing and is refused. */
const MAX_VIEWS = 8;

/**
 * The window's read-only views of agent commands (#1920). Only a command the chat's own session
 * started can be opened; the view never writes to it and never stops it (Stop has its own path).
 */
export function registerAgentOutputIpc(getWindow: () => BrowserWindow | null): void {
  let owner: WebContents | null = null;
  const views = new Map<string, { stop: () => void }>();
  const closeAll = (): void => { for (const view of views.values()) view.stop(); views.clear(); owner = null; };
  app.on('before-quit', closeAll);
  const request = z.discriminatedUnion('action', [
    z.object({ action: z.literal('open'), id: z.string().uuid(), sessionId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
      processId: z.number().int().min(1_000).max(99_999), incarnation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
    z.object({ action: z.literal('close'), id: z.string().uuid() }).strict()
  ]);
  /** A refusal: its message goes to the window, its reason to the log, never the request (CodeRabbit on #2052). */
  class Refusal extends Error { constructor(message: string, readonly reason: string) { super(message); } }
  ipcMain.handle('agentOutput:request', async (event, payload: unknown) => {
    let what = 'a request';
    let held: { id: string; entry: { stop: () => void } } | null = null;
    try {
      const target = getWindow();
      if (!target || target.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame) {
        throw new Refusal('The window is unavailable', 'it did not come from the app window');
      }
      const parsed = request.safeParse(payload);
      if (!parsed.success) throw new Refusal('The request was not valid', 'it was not a valid request');
      const args = parsed.data;
      what = args.action === 'open' ? 'to open a view' : 'to close a view';
      if (owner !== event.sender) {
        closeAll(); owner = event.sender;
        const current = owner;
        const retire = (): void => { if (owner === current) closeAll(); };
        current.once('destroyed', retire); current.once('did-start-loading', retire);
      }
      if (args.action === 'close') { views.get(args.id)?.stop(); views.delete(args.id); return { ok: true, data: true }; }
      if (views.has(args.id)) return { ok: true, data: true };
      if (views.size >= MAX_VIEWS) throw new Refusal('Close an agent output tab first', `${MAX_VIEWS} views are already open`);
      if (!runningExecProcesses(args.sessionId).some(process => process.processId === args.processId && process.incarnation === args.incarnation)) {
        throw new Refusal('This command is no longer running', 'the command is no longer running');
      }
      // The slot is taken before the wait below, so a close that arrives meanwhile finds it and
      // nothing is watched for a tab already gone (CodeRabbit on #2052).
      const reservation = { stop: () => undefined };
      views.set(args.id, reservation);
      held = { id: args.id, entry: reservation };
      const reserved = (): boolean => views.get(args.id) === reservation;
      let shield: boolean;
      try {
        shield = getConfig().ui.secretsShield !== false && !await sessionSecretsShieldOff(args.sessionId).catch(() => false);
      } finally {
        if (!reserved()) logInfo(`agent output: a view was closed before it opened; nothing is watched`);
      }
      if (!reserved()) return { ok: true, data: true };
      const sender = owner!;
      const send = (value: AgentOutputEvent): void => { if (owner === sender && !sender.isDestroyed()) sender.send('agentOutput:event', value); };
      const stream = new AgentOutputStream(shield, text => send({ id: args.id, data: text }),
        reason => logInfo(`agent output: command ${args.processId}: ${reason}`));
      let timer: NodeJS.Timeout | null = null;
      const finish = (): void => { if (timer) clearInterval(timer); timer = null; };
      const watched = unifiedExecManager.watchOutput(args.processId, args.incarnation, chunk => stream.push(chunk), completion => {
        stream.flush(Date.now(), true);
        finish();
        send({ id: args.id, exit: exitSummary(completion.exitCode, completion.durationMs) });
      });
      if (!watched) { views.delete(args.id); throw new Refusal('This command is no longer running', 'the command is no longer running'); }
      stream.start(watched.history);
      timer = setInterval(() => stream.flush(), AGENT_OUTPUT_FLUSH_MS);
      views.set(args.id, { stop: () => { finish(); watched.unsubscribe(); } });
      logInfo(`agent output: the person opened command ${args.processId}'s output read-only${shield ? '' : ' (secrets shield off)'}`);
      return { ok: true, data: true };
    } catch (error) {
      // Any failure after the slot was taken gives it back.
      if (held && views.get(held.id) === held.entry) views.delete(held.id);
      logInfo(`agent output: refused ${what}: ${error instanceof Refusal ? error.reason : 'it failed'}`);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
