// One in-process fence for Remove, Trust and outbox admission.
const removingSessions = new Set<string>();

export function isSessionRemoving(id: string): boolean {
  return removingSessions.has(id);
}

export function assertSessionNotRemoving(id: string): void {
  if (isSessionRemoving(id)) throw new Error('This session is already being deleted');
}

export async function withSessionRemoval<T>(id: string, remove: () => Promise<T>): Promise<T> {
  assertSessionNotRemoving(id);
  removingSessions.add(id);
  try { return await remove(); }
  finally { removingSessions.delete(id); }
}
