/** Explicit independent new-chat drafts; legacy `new` and `project:<id>` stay unchanged. */
export function newIndependentDraftKey(projectId: string | null, uuid: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) throw new Error('Invalid draft ID');
  const key = projectId === null ? `draft:new:${uuid}` : `draft:project:${encodeURIComponent(projectId)}:${uuid}`;
  if (key.length > 200) throw new Error('Draft key is too long');
  return key;
}
export function parseIndependentDraftKey(key: string): { projectId: string | null } | null {
  if (key.startsWith('draft:new:')) return /^[0-9a-f-]{36}$/i.test(key.slice(10)) ? { projectId: null } : null;
  if (!key.startsWith('draft:project:')) return null;
  const separator = key.lastIndexOf(':');
  if (separator < 14 || !/^[0-9a-f-]{36}$/i.test(key.slice(separator + 1))) return null;
  try {
    const projectId = decodeURIComponent(key.slice(14, separator));
    return projectId && newIndependentDraftKey(projectId, key.slice(separator + 1)) === key ? { projectId } : null;
  } catch { return null; }
}
