/**
 * The names this install's connectors carry in ChatGPT.
 *
 * ChatGPT records a connector's tool calls under the exact name the user typed for it (the call
 * path, `invocation.server` and `invoked_resource.app_name` all carry it unchanged, parentheses
 * and spaces included; checked on 2026-10-04). The extension recognizes this app's own traffic
 * by those exact names, never by prefix, so it never vouches for another connector's calls.
 *
 * One ChatGPT account used on two computers needs two connectors per surface, and they cannot
 * share a name: a suffix names this computer's set, e.g. "Chat On Steroids Core (Windows)".
 */
export const CONNECTOR_BRAND = 'Chat On Steroids';
export const CONNECTOR_SUFFIX_MAX = 32;
/** Letters, digits, spaces, dots, dashes and underscores; the app adds the parentheses. */
export const CONNECTOR_SUFFIX_PATTERN = /^[\p{L}\p{N} ._-]*$/u;

export type ConnectorSurface = 'core' | 'desktop' | 'plugins';
const SURFACE_WORD: Record<ConnectorSurface, string> = { core: 'Core', desktop: 'Desktop', plugins: 'Plugins' };

/** A usable suffix, or '' for anything empty, too long or outside the allowed characters. */
export function normalizeConnectorSuffix(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length <= CONNECTOR_SUFFIX_MAX && CONNECTOR_SUFFIX_PATTERN.test(trimmed) ? trimmed : '';
}

export function connectorName(surface: ConnectorSurface, suffix: unknown = ''): string {
  const plain = `${CONNECTOR_BRAND} ${SURFACE_WORD[surface]}`;
  const tag = normalizeConnectorSuffix(suffix);
  return tag ? `${plain} (${tag})` : plain;
}

export function connectorNames(suffix: unknown = ''): Record<ConnectorSurface, string> {
  return { core: connectorName('core', suffix), desktop: connectorName('desktop', suffix), plugins: connectorName('plugins', suffix) };
}
