/**
 * Which settings differ from their default, and a way back to it from the row itself.
 *
 * "Default" is the fresh-install value (`defaultConfig()` in main, read once over IPC), not what an
 * older config happens to read as: a config from before automatic plugin refresh, for example,
 * reads Off there while a new install starts On, so that row is marked and its button says
 * "for new installs". Only plain preferences are listed. Paths, tunnel IDs, keys, profiles, models
 * the account offers and the language are never offered for reset.
 *
 * Reset sets the control as if it had been picked and fires its `change`, so the page's own save
 * runs exactly as for a click; the marks follow the saved config on the next repaint.
 */
import type { Config } from '../shared/types.js';
import { icon } from './dom.js';
import { t, ui } from './i18n.js';

type Shown = string | boolean;

/** Each control's value as the page shows it for a config, keyed by the control's id. */
const SHOWN: Readonly<Record<string, (config: Config) => Shown>> = {
  followOutput: c => c.ui.followOutput !== false,
  turnNotifications: c => c.ui.turnNotifications !== false,
  followUp: c => c.ui.followUp ?? 'steer',
  enterSends: c => c.ui.enterSends === false ? 'modifier' : 'enter',
  keepAwake: c => c.ui.keepAwake === false ? 'off' : c.ui.keepScreenAwake === true ? 'screen' : 'computer',
  playfulStatus: c => c.ui.playfulStatus === true,
  playfulContinue: c => c.ui.playfulContinue === true,
  mentionCore: c => c.ui.mentionCore !== false,
  mentionPlugins: c => c.ui.mentionPlugins === true,
  secretsShield: c => c.ui.secretsShield !== false,
  privacyScreenshots: c => c.ui.privacyScreenshots === true,
  announceTurns: c => c.ui.announceTurns === true,
  developerMode: c => c.ui.developerMode === true,
  mcpPersistentUrls: c => c.mcp?.persistentUrls === true,
  controlApiEnabled: c => c.controlApi?.enabled === true,
  controlApiAllowActions: c => c.controlApi?.allowActions === true,
  localAppUsage: c => c.ui.localAppUsage !== false,
  autoContinue: c => c.ui.autoContinue !== false,
  rotateTurnMinutes: c => String(c.ui.rotateTurnMinutes ?? 30),
  rotateStopFallback: c => c.ui.rotateStopFallback === true,
  finishHoldOnStop: c => c.ui.finishHoldOnStop === true,
  planBackend: c => c.ui.planBackend ?? 'chatgpt',
  autoSelectSkills: c => c.ui.autoSelectSkills === true,
  finishTool: c => c.ui.finishTool === true,
  finishLeadMinutes: c => String(c.ui.finishLeadMinutes ?? 5),
  chatBrowser: c => c.ui.chatBrowser ?? 'chrome',
  cosBrowserMinimize: c => c.ui.cosBrowserMinimize ?? 'taskbar',
  browserBridgePort: c => String(c.ui.browserBridgePort ?? 'auto'),
  backgroundChats: c => c.ui.backgroundChats === true,
  backgroundPlacement: c => c.ui.backgroundPlacement ?? 'window',
  autoRefreshPlugins: c => c.ui.autoRefreshPlugins === true,
  browserOnly: c => c.ui.browserOnly === true
};

type Control = HTMLInputElement | HTMLSelectElement;

/** The listed controls whose saved value is not the fresh-install default, in table order. */
export function changedSettings(config: Config, defaults: Config): string[] {
  return Object.entries(SHOWN).filter(([, shown]) => shown(config) !== shown(defaults)).map(([id]) => id);
}

const ownReset = (row: HTMLElement): HTMLButtonElement | undefined =>
  [...row.children].find((child): child is HTMLButtonElement => child.classList.contains('setting-reset'));

function resetButton(row: HTMLElement, control: Control, value: Shown): HTMLButtonElement {
  let button = ownReset(row);
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn setting-reset';
    button.append(icon('i-zoom-reset'));
    ui(button, 'title', () => t('Reset to the default for new installs'));
    // Several rows can show one at once, so each says which setting it resets. The name is read when
    // the label is (re)written, after a language change has translated the row's own text.
    const name = row.querySelector('.setting-text > b');
    ui(button, 'aria-label', () => t('Reset {0} to the default for new installs', [name?.textContent?.replace(/\s+/g, ' ').trim() ?? '']));
    // Just before the control, so reading and Tab order match what is drawn. A row that is a <label>
    // names its first labelable descendant, which would now be this button: point it at the control.
    if (row.tagName === 'LABEL') row.setAttribute('for', control.id);
    row.insertBefore(button, [...row.children].find(child => child === control || child.contains(control)) ?? null);
  }
  button.onclick = event => {
    // Inside a <label>, the click must not also reach the row's switch.
    event.preventDefault();
    if (control.type === 'checkbox') (control as HTMLInputElement).checked = value === true;
    else control.value = String(value);
    control.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return button;
}

/** Marks each listed row whose saved value differs from its default and shows its reset. */
export function paintSettingDefaults(config: Config, defaults: Config, root: ParentNode = document): void {
  const changed = new Set(changedSettings(config, defaults));
  for (const [id, shown] of Object.entries(SHOWN)) {
    const control = root.querySelector<Control>(`#${id}`);
    const row = control?.closest<HTMLElement>('.setting');
    if (!control || !row) continue;
    const differs = changed.has(id);
    row.classList.toggle('is-changed', differs);
    if (!differs && !ownReset(row)) continue;
    // A control the page has switched off (no API, a port fixed by the environment) keeps its mark
    // but offers no reset: its save would be refused or ignored.
    const button = resetButton(row, control, shown(defaults));
    const hide = !differs || control.disabled;
    // The repaint after a reset hides the button that was just used: keep the keyboard on its row.
    if (hide && !button.hidden && document.activeElement === button) {
      if (control.disabled) { row.tabIndex = -1; row.focus(); } else control.focus();
    }
    button.hidden = hide;
  }
}
