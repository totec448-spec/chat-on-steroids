import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { z } from 'zod';
import { WorkspaceTerminals } from './workspace-terminal.js';

export function registerWorkspaceTerminalIpc(getWindow: () => BrowserWindow | null): void {
  let owner: WebContents | null = null;
  let terminals: WorkspaceTerminals | null = null;
  const dispose = (): void => { terminals?.dispose(); terminals = null; owner = null; };
  app.on('before-quit', dispose);
  const request = z.discriminatedUnion('action', [
    z.object({ action: z.literal('create'), id: z.string().uuid(), projectId: z.string().uuid(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }).strict(),
    z.object({ action: z.literal('write'), id: z.string().uuid(), data: z.string().max(65_536) }).strict(),
    z.object({ action: z.literal('resize'), id: z.string().uuid(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }).strict(),
    z.object({ action: z.literal('ack'), id: z.string().uuid(), count: z.number().int().min(0).max(65_536) }).strict(),
    z.object({ action: z.literal('close'), id: z.string().uuid() }).strict()
  ]);
  ipcMain.handle('workspaceTerminal:request', async (event, payload: unknown) => {
    try {
      const target = getWindow();
      if (!target || target.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame) throw new Error('Terminal window is unavailable');
      const args = request.parse(payload);
      if (owner !== event.sender) {
        dispose(); owner = event.sender;
        const current = owner;
        terminals = new WorkspaceTerminals(value => { if (owner === current && !current.isDestroyed()) current.send('workspaceTerminal:event', value); });
        const retire = (): void => { if (owner === current) dispose(); };
        current.once('destroyed', retire); current.once('did-start-loading', retire);
      }
      const service = terminals!;
      const data = args.action === 'create' ? await service.create(args.id, args.projectId, args.cols, args.rows)
        : args.action === 'write' ? await service.write(args.id, args.data)
        : args.action === 'resize' ? service.resize(args.id, args.cols, args.rows)
        : args.action === 'ack' ? service.acknowledge(args.id, args.count) : service.close(args.id);
      return { ok: true, data };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });
}
