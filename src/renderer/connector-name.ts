import { t } from './i18n.js';
import type { SurfaceStatus } from '../shared/types.js';

/**
 * The extra Setup-card line for a connector renamed in ChatGPT.
 *
 * The card's Name row keeps the configured name: it is what the user types when creating the
 * connector. Once a served call proves ChatGPT shows another name (connector-identity.ts), this line
 * says so, so the user recognizes their renamed app. Nothing when the names agree or none is known.
 */
export function chatgptNameLine(surface: Pick<SurfaceStatus, 'connectorName' | 'chatgptName'>): string | null {
  const name = surface.chatgptName;
  return typeof name === 'string' && name && name !== surface.connectorName ? t('In ChatGPT: {0}', [name]) : null;
}
