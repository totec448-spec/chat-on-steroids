/** Drops the virtual root segment, which is the same on every line and adds nothing. */
export function shortPath(virtualPath: string): string {
  const parts = String(virtualPath ?? '').split('/').filter(Boolean);
  if (parts.length <= 1) return `/${parts.join('/')}`;
  return parts.slice(1).join('/');
}
