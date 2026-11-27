import { t, ui } from './i18n.js';
import type { AppState } from '../shared/types.js';

/** Main owns the choice; renderer only translates and binds the supplied display key. */
export function applyAppBrand(displayName: NonNullable<AppState['displayName']>): void {
  for (const node of document.querySelectorAll('[data-app-display-name]')) {
    ui(node, 'textContent', () => t(displayName));
  }
}
