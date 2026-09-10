import type { LocalProject } from '../shared/projects.js';
import { getConfig } from './config.js';
import { approveFolder } from './folder-access.js';
import { addProject, assignSessionProject } from './projects.js';
import { resolvePath, SandboxError } from './sandbox.js';

export interface ProjectSelectionResult {
  project: LocalProject;
  approvalChanged: boolean;
}

/**
 * Application service for selecting one conversation's local project.
 *
 * The native picker is deliberately not here: Electron is only a transport. Once a path has
 * been selected, this service owns the product transition -- reuse existing permission where
 * possible, approve exactly the selected folder otherwise, create/reuse its durable project,
 * and bind that project to the exact local session when one was supplied.
 *
 * There is intentionally no eager conversation-workspace write here. The MCP kernel derives
 * cwd from the authenticated call's exact session project, so a stale ChatGPT document can
 * never acquire workspace authority merely because the desktop selected a folder.
 */
export async function selectProjectFolder(folderPath: string, sessionId?: string | null): Promise<ProjectSelectionResult> {
  let approvalChanged = false;
  try {
    await resolvePath(getConfig().roots, folderPath);
  } catch (error) {
    if (!(error instanceof SandboxError)) throw error;
    await approveFolder(folderPath);
    approvalChanged = true;
  }

  const project = await addProject(folderPath);
  if (sessionId) await assignSessionProject(sessionId, project.id);
  return { project, approvalChanged };
}
