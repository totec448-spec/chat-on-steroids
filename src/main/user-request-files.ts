import { promises as fs } from 'node:fs';
import type { UserRequest, UserRequestFound } from '../shared/user-requests.js';

/**
 * Whether a step's expected files exist (#1695): name, size and time, never their contents. Only
 * paths placed inside an approved folder when the step was recorded are looked at, and a link is
 * not followed. A server folder's files are not checked.
 */
export async function userRequestFound(request: UserRequest): Promise<UserRequestFound[]> {
  return Promise.all(request.expected.map(async (file): Promise<UserRequestFound> => {
    if (request.remote || !file.real) return { path: file.path, state: 'unchecked' };
    try {
      const stat = await fs.lstat(file.real);
      return { path: file.path, state: 'found', size: stat.size, modifiedAt: stat.mtimeMs };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { path: file.path, state: 'missing' };
      return { path: file.path, state: 'unchecked' };
    }
  }));
}
