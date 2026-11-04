/** The reviewed agent-desktop 1.0.2 ref form, bounded for subprocess arguments. */
export const MAX_LINUX_DESKTOP_REF_LENGTH = 128;
export const LINUX_DESKTOP_REF_PATTERN = /^@s[A-Za-z0-9]+:e[0-9]+$/;

export function validLinuxDesktopRef(ref: string): boolean {
  return ref.length <= MAX_LINUX_DESKTOP_REF_LENGTH && LINUX_DESKTOP_REF_PATTERN.test(ref);
}
