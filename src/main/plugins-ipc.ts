import { app, dialog, shell, type BrowserWindow } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import { pluginManager } from './plugins/manager.js';
import { refreshPluginPublication } from './connection.js';

const values = z.record(z.string().min(1).max(128), z.string().max(16_384)).refine(value => Object.keys(value).length <= 64, 'At most 64 configuration fields');
const source = z.object({
  kind: z.enum(['npm', 'python', 'command', 'remote', 'mcpb', 'github']),
  package: z.string().max(256).optional(), version: z.string().max(128).optional(),
  dependencies: z.array(z.object({ package: z.string().min(1).max(256), version: z.string().min(1).max(128) }).strict()).max(16).optional(),
  command: z.string().max(4096).optional(), args: z.array(z.string().max(4096)).max(128).optional(),
  url: z.string().max(4096).optional(), path: z.string().max(4096).optional(), auth: z.literal('oauth').optional()
}).strict();
const patch = z.object({ source: source.optional(), name: z.string().min(1).max(100).optional(), config: values.optional(), credentials: values.optional() }).strict();
const install = patch.extend({ catalogId: z.string().max(80).optional() });
const identity = z.object({ id: z.string().min(1).max(80) });
type Register = <T>(channel: string, fn: (payload: unknown) => Promise<T>) => void;

/** Named, validated operations; credentials cross IPC only toward encrypted storage. */
export function registerPluginIpc(handle: Register, getWindow: () => BrowserWindow | null): void {
  handle('plugins:legalNotices', async () => {
    const error = await shell.openPath(path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'THIRD-PARTY-NOTICES.txt'));
    if (error) throw new Error('Could not open the bundled Third-party Notices file.');
  });
  handle('plugins:snapshot', async () => pluginManager.snapshot());
  handle('plugins:install', async payload => { await pluginManager.install(install.parse(payload)); return pluginManager.snapshot(); });
  handle('plugins:configure', async payload => {
    const input = identity.extend({ patch }).strict().parse(payload);
    await pluginManager.configure(input.id, input.patch); return pluginManager.snapshot();
  });
  for (const action of ['restart', 'update', 'uninstall', 'authenticate', 'cancelAuthentication'] as const) handle(`plugins:${action}`, async payload => {
    await pluginManager[action](identity.strict().parse(payload).id); return pluginManager.snapshot();
  });
  handle('plugins:enabled', async payload => {
    const input = identity.extend({ enabled: z.boolean() }).strict().parse(payload);
    await pluginManager.setEnabled(input.id, input.enabled); return pluginManager.snapshot();
  });
  handle('plugins:tool', async payload => {
    const input = identity.extend({ name: z.string().min(1).max(256), enabled: z.boolean() }).strict().parse(payload);
    await pluginManager.setToolEnabled(input.id, input.name, input.enabled); return pluginManager.snapshot();
  });
  handle('plugins:importBundle', async () => {
    const result = await dialog.showOpenDialog({ title: 'Import MCP bundle', properties: ['openFile'], filters: [{ name: 'MCP bundles', extensions: ['mcpb'] }] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  pluginManager.onChanged(() => {
    refreshPluginPublication('plugins');
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('plugins:changed', pluginManager.snapshot());
  });
}
