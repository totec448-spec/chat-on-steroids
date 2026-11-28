import { t, ui } from './i18n.js';
import { APP_DISPLAY_NAME } from '../shared/app-brand-name.js';
import type { AppState } from '../shared/types.js';
/**
 * Main owns the choice; renderer only translates and binds the supplied display key.
 *
 * A development build is shown on the page as the plain name with a DEV badge beside it, which reads
 * faster than a suffix glued to the name. The window title, the tray and the About box cannot hold a
 * badge, so they keep the "(dev)" text main supplied; the title element here is one of those.
 */
export function applyAppBrand(displayName: NonNullable<AppState['displayName']>): void {
  const development = displayName !== APP_DISPLAY_NAME;
  for (const node of document.querySelectorAll('[data-app-display-name]')) {
    const inPage = node.tagName !== 'TITLE';
    ui(node, 'textContent', () => t(inPage && development ? APP_DISPLAY_NAME : displayName));
    const next = node.nextElementSibling;
    const badge = next?.hasAttribute('data-app-badge') ? next : null;
    if (!inPage || !development) { badge?.remove(); continue; }
    if (badge) continue;
    const added = document.createElement('span');
    added.className = 'app-badge';
    added.setAttribute('data-app-badge', '');
    ui(added, 'textContent', () => t('DEV'));
    node.after(added);
  }
}
