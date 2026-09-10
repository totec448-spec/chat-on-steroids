import type { Root } from '../shared/types.js';
import { updateConfig } from './config.js';
import { logInfo } from './logger.js';
import { RESERVED_ROOT_NAMES, SandboxError, uniqueRootName, validateNewRoot } from './sandbox.js';
import { forgetWorkspaceRoot, renameWorkspaceRoot } from './workspace.js';

/**
 * Application service for approved-folder authority.
 *
 * Electron dialogs belong to the transport adapter in ipc.ts; permission mutation does not.
 * Keeping the state transition here means browser/CLI/IPC entry points can all share the same
 * validation and workspace repair without growing another handler-specific state machine.
 */
export async function approveFolder(folderPath: string): Promise<Root> {
  let real = '';
  const next = await updateConfig(async (config) => {
    real = await validateNewRoot(folderPath, config.roots);
    const existing = config.roots.find((root) => root.path === real);
    if (existing) return config;
    const root = { name: uniqueRootName(real, config.roots), path: real } satisfies Root;
    return { ...config, roots: [...config.roots, root] };
  });
  const approved = next.roots.find((root) => root.path === real);
  if (!approved) throw new Error('Folder approval did not produce a root');
  logInfo(`approved folder /${approved.name}`);
  return approved;
}

export async function removeApprovedFolder(name: string): Promise<void> {
  await updateConfig((config) => {
    if (!config.roots.some((root) => root.name === name)) throw new Error(`/${name} is not an approved folder`);
    return { ...config, roots: config.roots.filter((root) => root.name !== name) };
  });
  forgetWorkspaceRoot(name);
  logInfo(`removed folder /${name}`);
}

export async function renameApprovedFolder(name: string, newName: string): Promise<void> {
  if (RESERVED_ROOT_NAMES.has(newName)) {
    throw new SandboxError(`/${newName} is reserved by Chat On Steroids and cannot be used as a folder name`);
  }
  await updateConfig((config) => {
    if (!config.roots.some((root) => root.name === name)) throw new Error(`/${name} is not an approved folder`);
    if (config.roots.some((root) => root.name !== name && root.name === newName)) {
      throw new Error(`/${newName} is already used`);
    }
    return {
      ...config,
      roots: config.roots.map((root) => (root.name === name ? { ...root, name: newName } : root))
    };
  });
  renameWorkspaceRoot(name, newName);
}