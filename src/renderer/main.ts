import { initBrowserSetup } from './setup-browser.js';
import { currentLanguage, ui, uiText, t, initLanguage, onLanguageChange } from './i18n.js';
import { CONNECTOR_SUFFIX_MAX, CONNECTOR_SUFFIX_PATTERN } from '../shared/connector-names.js';
import { displayLocalServer } from './local-url.js';
import { paintPluginRefreshReminder } from './plugin-refresh-reminder.js';
import { initUsage, refreshUsage } from './usage.js';
import { initSidebarResize } from './sidebar-resize.js';
import { initPlugins, applyPluginsState } from './plugins.js';
import { initBrowserPreferences } from './browser-preferences.js';
import { initSetupGuide } from './setup-guide.js';
import { initAppearance } from './appearance.js';
import { initKeychainNotice } from './keychain-notice.js';
import { initPet } from './pet.js';
import { initPets } from './pets.js';
import { initSkillsLibrary } from './skills-library.js';
import { initSettingsSearch } from './settings-search.js';
import type { AppearanceSettings } from '../shared/appearance.js';
import type { BrowserBridgePort } from '../shared/browser-bridge.js';
import { parseCommandAllowlistText } from '../shared/command-allowlist.js';
/**
 * Renderer. No Node, no filesystem, no network — everything goes through window.api.
 *
 * The DOM skeleton lives in index.html; this fills it in and never rebuilds a control
 * the user might be typing into. The permission rows are the one exception: they are
 * generated from CAPABILITIES so a new capability appears without touching markup.
 *
 * Two rules the layout depends on. The window is a fixed frame, so nothing here may
 * change the height of anything outside its own scroll pane — that is why only one
 * permission group is expanded at a time. And the two live numbers tick locally every
 * second, so "verified 8s ago" keeps counting between the 15s reports from the main
 * process instead of freezing at a number that is quietly going stale.
 */

import type { AppApi, SettingsPatch } from '../preload/index.js';
import { requiresApprovedFilesystemRoot } from '../shared/capabilities.js';
import type { AppState, Capability, ChatBrowser, Config, LogEntry, SurfaceStatus } from '../shared/types.js';
import { opensInCosBrowser } from '../shared/cos-browser-sites.js';
import {
  browserExtensionRequired,
  isNewer,
  CAPABILITY_DETAILS,
  CAPABILITY_LABELS,
  capabilityTools,
  DESKTOP_CAPABILITIES,
  WRITE_CAPABILITIES
} from '../shared/types.js';
import type { SwarmState } from '../shared/session.js';
import { $, ago, disclosureChevron, el, icon, run, shortAgo, toast } from './dom.js';
import { chatApply, chatSettingsPatch, chatVisible, initChat, openChatView } from './chat.js';
import { publishStopNoticeTexts } from './stop-notices.js';
import { publishMainTexts } from './main-texts.js';

declare global {
  interface Window {
    api: AppApi;
  }
}

const api = window.api;
// First: main announces a Keychain read before it starts and may not get through again until it ends.
initKeychainNotice(api);
initLanguage();
publishStopNoticeTexts(texts => api.setStopNoticeTexts(texts));
// The tray menu and desktop notices come from the main process, which has no catalogs.
publishMainTexts(texts => api.setMainTexts?.(texts));
// The browser extension shows its texts in the app's language, not Chrome's; the app hands it on.
const publishUiLanguage = (): void => { void Promise.resolve(api.setUiLanguage?.(currentLanguage())).catch(() => undefined); };
publishUiLanguage();
onLanguageChange(publishUiLanguage);
const pet = initPet(api, () => showTab('pets'));
const settingsSearch = initSettingsSearch({
  open: tab => showTab(tab),
  shown: () => document.querySelector<HTMLElement>('.app')!.dataset.screen === 'settings'
});
initSetupGuide();
const browserSetup = initBrowserSetup({
  choose: chooseChatBrowser,
  repaint: () => { setupOpenStep = 'browser'; if (state) apply(state); },
  open: (browser, page) => run(api.openSetupBrowser(browser, page))
});
// Escape the translucent sidebar's backdrop-filter containing block.
document.body.append($('connectionPopover'));
const appearance = initAppearance(patch => { void save(patch); });

/** Same shape the platform uses; mirrored here only to grey out the tunnel step until it is valid. */
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

interface Group {
  id: string;
  title: string;
  /** Sprite id from index.html. */
  icon: string;
  blurb: string;
  caps: Capability[];
}

const GROUPS: Group[] = [
  {
    id: 'read',
    title: "Look at files",
    icon: 'i-eye',
    blurb: "Read and search inside the folders you approved.",
    caps: ['browse', 'search', 'read', 'metadata']
  },
  {
    id: 'write',
    title: "Change files",
    icon: 'i-pencil',
    blurb: "Create, edit, move, delete and save ChatGPT files, inside those folders only.",
    caps: ['create', 'edit', 'move', 'deleteFile']
  },
  {
    id: 'desktop',
    title: "Browser and desktop control",
    icon: 'i-monitor',
    blurb: "Background browser tabs, DOM, console and network; native windows and input where supported.",
    caps: ['screen', 'control', 'clipboardRead', 'clipboardWrite']
  },
  {
    id: 'run',
    title: "Run programs",
    icon: 'i-terminal',
    blurb: "Start commands as you. The most powerful setting here.",
    caps: ['command']
  }
];

let state: AppState | null = null;
/** Guards against saving while we are writing values into the controls. */
let applying = false;

/**
 * Applies persisted form state without erasing a value the user is currently editing.
 *
 * `state:changed` is primarily a live status push, but it carries the whole config object. A
 * focused field can therefore differ from the last persisted config for several seconds before
 * its `change` event saves it. Only that exact dirty case is protected; an idle/focused-but-clean
 * field still follows persisted state normally.
 */
function applyValue(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, next: string, previous?: string): void {
  const dirty = document.activeElement === control && previous !== undefined && control.value !== previous;
  if (!dirty) control.value = next;
}

function applyChecked(control: HTMLInputElement, next: boolean, previous?: boolean): void {
  const dirty = document.activeElement === control && previous !== undefined && control.checked !== previous;
  if (!dirty) control.checked = next;
}
/** The one expanded permission group, or null. One at a time keeps the layout still. */
let openGroup: string | null = null;
/** Null follows setup completion; an explicit guide choice survives status pushes. */
/** The Setup step the user opened from the rail or with Back/Next; null follows the first unfinished one. */
let setupOpenStep: string | null = null;
/** The steps this setup shows, in order, and the one open now: what Back and Next move between. */
let setupSteps: string[] = [];
let setupOpen: string | null = null;
let setupProfileBusy = false;
let setupKeySave: Promise<boolean> = Promise.resolve(true);

// ------------------------------------------------------------------- tabs

let openSkillsLibrary: () => void = () => undefined;

/**
 * Beside each Setup button that opens a ChatGPT or OpenAI page in the built-in browser, the same
 * page in the system's own browser, for anyone signed in there instead. Shown only while the
 * built-in browser is the chosen one; otherwise the button itself already opens it there.
 */
const externalSetupLinks = [...document.querySelectorAll<HTMLButtonElement>('#wizard button[data-link]')]
  .filter(button => opensInCosBrowser(button.dataset.link!))
  .map(button => {
    const other = el('button', 'btn', () => t('Open in another browser'));
    other.setAttribute('type', 'button');
    other.dataset.linkExternal = button.dataset.link!;
    other.hidden = true;
    button.after(other);
    return other;
  });

function showTab(name: string): void {
  if (name === 'skills') openSkillsLibrary();
  const library = name === 'plugins' || name === 'skills' || name === 'pets';
  const settings = name !== 'chat' && !library;
  document.querySelector<HTMLElement>('.app')!.dataset.screen = library ? 'library' : settings ? 'settings' : 'chat';
  document.querySelector<HTMLElement>('.sidebar-brand')!.hidden = settings;
  $('sidebarPrimary').hidden = settings;
  $('workspaceSettings').hidden = false;
  $('workspaceSettings').classList.toggle('is-sel', settings);
  if (name === 'usage') void refreshUsage();
  $('tabs').hidden = !settings;
  $('settingsFindBox').hidden = !settings;
  // A page opened any way leaves the search; the page list comes back.
  settingsSearch.reset();
  $('backToChat').hidden = !settings;
  document.querySelector<HTMLElement>('.sidebar-sessions')!.hidden = settings;
  $('newChat').hidden = settings;

  for (const tab of document.querySelectorAll<HTMLElement>('nav button')) {
    tab.classList.toggle('is-sel', tab.dataset.tab === name);
  }
  for (const item of document.querySelectorAll<HTMLElement>('[data-sidebar-page]')) item.classList.toggle('is-sel', item.dataset.sidebarPage === name);
  for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
    panel.classList.toggle('is-active', panel.dataset.panel === (name === 'settings' ? 'chat' : name));
  }
  // After the panel shows: the chat and Agents & automation share its scroll pane, and a hidden
  // pane cannot be scrolled to where each view starts.
  if (name === 'settings') openChatView('settings');
  else if (name === 'chat') openChatView('timeline');
  // The Chat panel is the only one that costs anything to keep fresh, so it only
  // reloads while it is on screen.
  chatVisible(name === 'chat' || name === 'settings');
  // A feed that was appended to while its panel was hidden could not be scrolled then —
  // a hidden element has no scroll height. Pin it now that it has one, so a panel always
  // opens on the newest line rather than on whatever was oldest in the buffer.
  for (const id of FEEDS) stickToNewest(id);
}

function setConnectionPopover(open: boolean): void {
  const popover = $('connectionPopover');
  const trigger = $('sidebarConnection');
  popover.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
  if (open) {
    positionConnectionPopover();
    paintClock();
  }
}

/** Keep the connection controls anchored to the status button and inside the viewport. */
function positionConnectionPopover(): void {
  const popover = $('connectionPopover');
  if (popover.hidden) return;
  const trigger = $('sidebarConnection').getBoundingClientRect();
  const margin = 12;
  const width = popover.getBoundingClientRect().width;
  const preferredLeft = trigger.left + trigger.width / 2 - width / 2;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  popover.style.left = `${Math.min(Math.max(margin, preferredLeft), maxLeft)}px`;
  popover.style.bottom = `${Math.max(margin, window.innerHeight - trigger.top + 8)}px`;
}

window.addEventListener('resize', () => positionConnectionPopover());

$('backToChat').addEventListener('click', () => showTab('chat'));
$('workspaceSettings').addEventListener('click', () => showTab('home'));
$('sidebarConnection').addEventListener('click', () => {
  setConnectionPopover(Boolean($('connectionPopover').hidden));
});
$('chatSettingsBtn').addEventListener('click', () => showTab('settings'));
$('sessionList').addEventListener('click', event => {
  if ((event.target as HTMLElement).closest('[data-id], [data-new-project]')) showTab('chat');
}, { capture: true });
$('newChat').addEventListener('click', () => showTab('chat'));
$('sidebarPlugins').addEventListener('click', () => showTab('plugins'));
$('sidebarPets').addEventListener('click', () => showTab('pets'));
$('sidebarSkills').addEventListener('click', () => showTab('skills'));
$('viewPets').addEventListener('click', () => { ($('viewMenu') as HTMLDetailsElement).open = false; pet.toggle(); });
api.onPetOverlayOpenOwner(screen => showTab(screen));
$('addProject').addEventListener('click', () => showTab('chat'));
$('composerFolder').addEventListener('click', () => $('addProject').click());
let zoomFactor = 1;
let zoomEdited = false;
void api.getZoom().then(result => {
  if (zoomEdited || !result.ok || typeof result.data !== 'number' || !Number.isFinite(result.data)) return;
  zoomFactor = result.data;
  $('zoomReset').textContent = `${Math.round(zoomFactor * 100)}%`;
});
async function zoom(next: number): Promise<void> {
  zoomEdited = true;
  const result = await run(api.setZoom(Math.min(1.5, Math.max(.75, next))));
  if (result !== null) { zoomFactor = result; $('zoomReset').textContent = `${Math.round(result * 100)}%`; }
}
$('zoomOut').addEventListener('click', () => void zoom(zoomFactor - .1));
$('zoomIn').addEventListener('click', () => void zoom(zoomFactor + .1));
$('zoomActualSize').addEventListener('click', () => void zoom(1));
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || !['+', '=', '-', '0'].includes(event.key)) return;
  event.preventDefault(); void zoom(event.key === '0' ? 1 : zoomFactor + (event.key === '-' ? -.1 : .1));
});
$('tabs').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
  if (button?.dataset.tab) showTab(button.dataset.tab);
});

// ------------------------------------------------------------ permissions

/**
 * Builds the permission rows once: a name that expands the group, and a switch that
 * turns the whole group on or off. Expanding scrolls the row just into view rather
 * than pushing the cards below it, because the window cannot grow.
 */
/** The head of a permission row: the expander, its title, and its switch. */
function groupShell(id: string, title: string, iconId: string, box: HTMLInputElement): HTMLElement {
  const root = el('div', 'perm');
  root.dataset.group = id;

  const main = document.createElement('button');
  main.className = 'perm-main';
  main.type = 'button';
  const text = el('span');
  text.append(el('b', '', () => t(title)), el('em', 'group-count'));
  main.append(disclosureChevron('ico chev'), icon(iconId), text);
  main.addEventListener('click', () => {
    openGroup = openGroup === id ? null : id;
    paintGroups();
    if (openGroup === id) root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  const sw = el('span', 'sw');
  sw.append(box, el('i'));

  const head = el('div', 'perm-head');
  head.append(main, sw);
  root.append(head);
  return root;
}

/**
 * The tools this group hands ChatGPT, named exactly as the model sees them.
 *
 * The permission copy used to carry the tool names inside its prose, which is where they
 * went stale: the surface was consolidated to `read` / `apply_patch` / `exec_command` and
 * a sentence in a different file kept describing the old one. Here the names come from
 * capabilityTools, including the host's shared Desktop method lists.
 */
function toolNames(names: readonly string[]): HTMLElement {
  const row = el('div', 'tool-names');
  for (const name of names) row.append(el('code', '', name));
  return row;
}

function buildCommandAllowlist(): HTMLElement {
  const section = el('div', 'command-allowlist');
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.id = 'commandAllowlistEnabled';
  const toggle = el('label', 'tool command-allowlist-toggle');
  const body = el('span');
  const description = el('em');
  description.id = 'commandPolicyDescription';
  body.append(
    el('strong', '', () => t('Limit command launches')),
    description
  );
  toggle.append(enabled, body);

  const mode = el('div', 'seg command-policy-mode');
  mode.id = 'commandPolicyMode';
  mode.setAttribute('role', 'radiogroup');
  ui(mode, 'aria-label', () => t('Command policy mode'));
  for (const [value, text] of [['allow', 'Allowlist'], ['deny', 'Denylist']] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = value === 'allow' ? 'commandPolicyAllow' : 'commandPolicyDeny';
    button.dataset.commandPolicyMode = value;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(value === 'allow'));
    button.classList.toggle('is-sel', value === 'allow');
    ui(button, 'textContent', () => t(text));
    button.addEventListener('click', () => {
      paintCommandPolicyMode(value);
      if (!applying) void save();
    });
    mode.append(button);
  }

  const label = el('label', 'command-allowlist-label');
  label.id = 'commandPolicyRulesLabel';
  label.setAttribute('for', 'commandAllowlistRules');
  const rules = document.createElement('textarea');
  rules.id = 'commandAllowlistRules';
  rules.rows = 5;
  rules.placeholder = 'git status\ngit diff *\ndotnet build *\ndotnet test *';
  const help = el('p', 'hint', () => t('Use an exact command or a trailing standalone * for additional arguments. Compound shell syntax is rejected. Allowed programs and their child processes remain trusted; this is not an OS sandbox.'));
  const error = el('p', 'command-allowlist-error');
  error.id = 'commandAllowlistError';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const changed = (): void => { if (!applying) void save(); };
  enabled.addEventListener('change', changed);
  rules.addEventListener('change', changed);
  rules.addEventListener('input', () => readCommandAllowlist());
  ui(description, 'textContent', () => t(readCommandPolicyMode() === 'deny'
    ? 'Commands matching any of these rules may not start.'
    : 'Only commands matching one of these rules may start.'));
  ui(label, 'textContent', () => t(readCommandPolicyMode() === 'deny'
    ? 'Blocked commands (one rule per line)'
    : 'Allowed commands (one rule per line)'));
  section.append(toggle, mode, label, rules, help, error);
  return section;
}

function readCommandPolicyMode(): 'allow' | 'deny' {
  return document.getElementById('commandPolicyDeny')?.getAttribute('aria-checked') === 'true' ? 'deny' : 'allow';
}

function paintCommandPolicyMode(mode: 'allow' | 'deny'): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command-policy-mode]')) {
    const selected = button.dataset.commandPolicyMode === mode;
    button.setAttribute('aria-checked', String(selected));
    button.classList.toggle('is-sel', selected);
  }
  $('commandPolicyRulesLabel').textContent = t(mode === 'deny'
    ? 'Blocked commands (one rule per line)'
    : 'Allowed commands (one rule per line)');
  $('commandPolicyDescription').textContent = t(mode === 'deny'
    ? 'Commands matching any of these rules may not start.'
    : 'Only commands matching one of these rules may start.');
}

function readCommandAllowlist(): SettingsPatch['commandAllowlist'] | null {
  const parsed = parseCommandAllowlistText($<HTMLTextAreaElement>('commandAllowlistRules').value);
  const error = $('commandAllowlistError');
  const first = parsed.issues[0];
  error.textContent = first ? t('Line {0}: {1}', [first.line, first.message]) : '';
  error.hidden = !first;
  return first ? null : {
    enabled: $<HTMLInputElement>('commandAllowlistEnabled').checked,
    mode: readCommandPolicyMode(),
    rules: parsed.rules
  };
}

function buildGroups(): void {
  const permissionGroups = GROUPS.map((group) => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'group-box';
    ui(box, 'title', () => t("Turn everything in \"{0}\" on or off", [t(group.title)]));
    box.addEventListener('change', () => {
      for (const cap of group.caps) {
        const input = capInput(cap);
        if (!input.disabled) input.checked = box.checked;
      }
      void save();
    });
    const root = groupShell(group.id, group.title, group.icon, box);

    const tools = el('div', 'tools');
    for (const cap of group.caps) {
      const label = el('label', 'tool');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.cap = cap;
      input.addEventListener('change', () => void save());
      const body = el('span');
      body.append(el('strong', '', () => t(CAPABILITY_LABELS[cap])), el('em', '', () => t(CAPABILITY_DETAILS[cap])));
      label.append(input, body);
      tools.append(label);
    }
    tools.append(toolNames([]));
    if (group.id === 'run') tools.append(buildCommandAllowlist());

    root.append(tools);
    return root;
  });

  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.id = 'homeMaEnabled';
  ui(enabled, 'title', () => t("Expose or hide the sub-agent tools in ChatGPT"));
  // The only multi-agent exposure control there is. Chat settings used to carry a second
  // checkbox for the same flag, which this one had to mirror by hand.
  enabled.addEventListener('change', () => void save());
  const agents = groupShell('agents', 'Sub-agents', 'i-agents', enabled);

  const tools = el('div', 'tools');
  const agentTools: Array<[string, string]> = [
    ['spawn', 'Open worker ChatGPT conversations for parts of the task, on one shared context.'],
    ['message', 'Steer one worker or several at once, or report back to prime.'],
    ['status', 'See every worker, and collect messages not yet delivered on a tool result.'],
    ['finish', 'Hand the worker result back to prime and close that slot.']
  ];
  for (const [name, detail] of agentTools) {
    const row = el('div', 'tool is-static');
    const body = el('span');
    body.append(el('strong', '', name), el('em', '', () => t(detail)));
    row.append(body);
    tools.append(row);
  }
  tools.append(toolNames(['agents']));
  agents.append(tools);

  $('groups').replaceChildren(...permissionGroups, agents);
}

function capInput(cap: Capability): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`[data-cap="${cap}"]`)!;
}

/** Refreshes counts, the tri-state switches, and what read-only mode has locked. */
function paintGroups(): void {
  if (!state) return;
  const { readOnly } = state.config;
  const desktopSupported = state.platform?.desktopAutomation ?? true;

  for (const group of GROUPS) {
    const root = document.querySelector<HTMLElement>(`[data-group="${group.id}"]`)!;
    root.hidden = false;
    root.classList.toggle('is-open', openGroup === group.id);

    const names = [...new Set(group.caps.flatMap((cap) => capabilityTools(cap, state!.platform?.family)))];
    if (group.id === 'desktop' && names.length > 0) names.push('exec');
    const namesRow = root.querySelector<HTMLElement>('.tool-names')!;
    if (Array.from(namesRow.children, child => child.textContent).join('\n') !== names.join('\n')) {
      namesRow.replaceChildren(...names.map(name => el('code', '', name)));
    }

    const usable = group.caps.filter((cap) => !(readOnly && WRITE_CAPABILITIES.includes(cap)) &&
      (desktopSupported || cap !== 'clipboardRead' && cap !== 'clipboardWrite'));
    const on = group.caps.filter((cap) => capInput(cap).checked);

    const box = root.querySelector<HTMLInputElement>('.group-box')!;
    box.checked = usable.length > 0 && usable.every((cap) => capInput(cap).checked);
    box.indeterminate = !box.checked && on.length > 0;
    box.disabled = usable.length === 0;

    ui(root.querySelector<HTMLElement>('.group-count')!, 'textContent', () => usable.length === 0
        ? t("off in read-only mode")
        : on.length === 0
          ? 'off'
          : on.length === group.caps.length
            ? t(on.length === 1 ? '{0} permission' : '{0} permissions', [on.length])
            : t("{0} of {1} permissions", [on.length, group.caps.length]));

    root.classList.toggle('is-on', on.length > 0);
    root.classList.toggle('is-locked', usable.length === 0);
  }

  for (const cap of WRITE_CAPABILITIES) capInput(cap).disabled = readOnly;
  for (const cap of ['clipboardRead', 'clipboardWrite'] as const) {
    capInput(cap).disabled = !desktopSupported || (readOnly && WRITE_CAPABILITIES.includes(cap));
  }

  // The feature group. apply() already passed its switch through the
  // focused/dirty-field guard. Recopying state here undid that protection and visibly
  // flipped a user's just-clicked toggle back when an unsolicited stale state push
  // arrived before save completed, so this only reads them.
  for (const [id, onText] of [['agents', 'agents tool exposed']] as Array<[string, string]>) {
    const root = document.querySelector<HTMLElement>(`[data-group="${id}"]`);
    if (!root) continue;
    const box = root.querySelector<HTMLInputElement>('.sw input')!;
    root.classList.toggle('is-open', openGroup === id);
    root.classList.toggle('is-on', box.checked);
    ui(root.querySelector<HTMLElement>('.group-count')!, 'textContent', () => t(box.checked ? onText : 'off'));
  }
}

function paintDesktopAccess(next: AppState): void {
  const box = $('desktopAccess');
  const access = next.desktopAccess;
  const needsScreen = next.config.capabilities.screen;
  const needsAccessibility = next.config.capabilities.control && !next.config.readOnly;
  if (next.platform?.family !== 'macos' || (!needsScreen && !needsAccessibility) || !access) {
    box.hidden = true;
    return;
  }

  const missing: string[] = [];
  if (needsScreen && access.screen !== 'granted') missing.push(t("Screen Recording: {0}", [access.screen]));
  if (needsAccessibility && access.accessibility !== 'granted') {
    missing.push(t("Accessibility: {0}", [access.accessibility]));
  }
  box.hidden = missing.length === 0;
  if (box.hidden) return;

  ui($('desktopAccessTitle'), 'textContent', () => t("Desktop access needs attention"));
  ui($('desktopAccessDetail'), 'textContent', () => t("{0}. These are live verdicts from the native backend executing inside Chat On Steroids. ", [missing.join(' · ')]) +
    t("Grant the missing macOS permission, then fully quit and reopen the app."));
  $<HTMLButtonElement>('openDesktopScreen').hidden =
    !needsScreen || access.screen === 'granted';
  $<HTMLButtonElement>('openDesktopAccessibility').hidden =
    !needsAccessibility || access.accessibility === 'granted';
  $<HTMLButtonElement>('requestDesktopAccessibility').hidden =
    !needsAccessibility || access.accessibility === 'granted';
}

/**
 * How many MCP tools this app can expose in total, across both connectors.
 *
 * Taken from the surfaces the main process reports rather than recomputed from the
 * checkboxes, so this number cannot drift away from what the servers actually register.
 */
function toolsOn(next: AppState): number {
  return next.status.surfaces
    .filter((surface) => surface.available)
    .reduce((sum, surface) => sum + surface.tools.length, 0);
}

// ------------------------------------------------------------------ save

// A settings save is a full snapshot, even though the main process applies it as a patch.
// Capture each requested snapshot immediately, but derive it from the latest *requested* state
// rather than only the latest acknowledged state. Then serialize IPC delivery. This handles both
// halves of the race: a later save cannot inherit stale readOnly/theme, and the first save's reply
// cannot repaint a control before the later save has captured what the user changed there.
let settingsSaveQueue: Promise<void> = Promise.resolve();
let requestedSettings: SettingsPatch | null = null;

function save(over: { readOnly?: boolean; theme?: 'light' | 'dark'; appearance?: AppearanceSettings } = {}): Promise<void> {
  if (applying || !state) return Promise.resolve();

  const previous: AppState['config'] = requestedSettings
    ? { ...state.config, ...requestedSettings }
    : state.config;
  const commandAllowlist = readCommandAllowlist();
  if (!commandAllowlist) return Promise.resolve();
  const capabilities = { ...previous.capabilities };
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) {
    const capability = input.dataset.cap as Capability;
    // Unsupported hosts hide Desktop automation while preserving any choices stored in this
    // config. A hidden disabled checkbox is presentation,
    // not a user edit: copying its forced-false value into every unrelated settings save
    // would erase those choices merely because the config was opened on another OS.
    if (!(state.platform?.desktopAutomation ?? true) && DESKTOP_CAPABILITIES.includes(capability) && capability !== 'screen' && capability !== 'control') continue;
    capabilities[capability] = input.checked;
  }
  const readOnly = over.readOnly ?? previous.readOnly;
  const chatPatch = chatSettingsPatch(previous);
  const selectedBridgePort = $<HTMLSelectElement>('browserBridgePort').value;
  const patch: SettingsPatch = {
    connectorSuffix: connectorSuffixDraft(previous),
    capabilities,
    readOnly,
    commandAllowlist,
    tunnel: {
      profileId: previous.tunnel.profileId,
      profileEpoch: previous.tunnel.profileEpoch,
      kind: $<HTMLSelectElement>('tunnelKind').value as 'openai' | 'cloudflared' | 'manual',
      tunnelId: $<HTMLInputElement>('tunnelId').value.trim(),
      desktopTunnelId: $<HTMLInputElement>('desktopTunnelId').value.trim(),
      pluginsTunnelId: previous.tunnel.pluginsTunnelId ?? '',
      binaryPath: $<HTMLInputElement>('binaryPath').value.trim()
    },
    ui: {
      ...previous.ui,
      defaultChatModel: $<HTMLSelectElement>('defaultChatModel').value || undefined,
      defaultChatReasoning: ($<HTMLSelectElement>('defaultChatReasoning').value || undefined) as Config['ui']['defaultChatReasoning'],
      chatBrowser: $<HTMLSelectElement>('chatBrowser').value as ChatBrowser,
      finishTool: $<HTMLInputElement>('finishTool').checked,
      planBackend: $<HTMLSelectElement>('planBackend').value as 'chatgpt' | 'api',
      finishLeadMinutes: Number($<HTMLSelectElement>('finishLeadMinutes').value),
      backgroundChats: $<HTMLInputElement>('backgroundChats').checked,
      browserBridgePort: (selectedBridgePort === 'auto' ? 'auto' : Number(selectedBridgePort)) as BrowserBridgePort,
      autoContinue: $<HTMLInputElement>('autoContinue').checked,
      browserOnly: $<HTMLInputElement>('browserOnly').checked,
      autoRefreshPlugins: $<HTMLInputElement>('autoRefreshPlugins').checked,
      autoSelectSkills: $<HTMLInputElement>('autoSelectSkills').checked,
      autoConnect: $<HTMLInputElement>('autoConnect').checked,
      startAtLogin: $<HTMLInputElement>('startAtLogin').checked,
      minimizeToTray: $<HTMLInputElement>('minimizeToTray').checked,
      developerMode: $<HTMLInputElement>('developerMode').checked,
      playfulStatus: $<HTMLInputElement>('playfulStatus').checked,
      followOutput: $<HTMLInputElement>('followOutput').checked,
      mentionCore: $<HTMLInputElement>('mentionCore').checked,
      privacyScreenshots: $<HTMLInputElement>('privacyScreenshots').checked,
      theme: over.theme ?? previous.ui.theme,
      appearance: over.appearance ?? previous.ui.appearance
    },
    controlApi: { enabled: $<HTMLInputElement>('controlApiEnabled').checked, allowActions: $<HTMLInputElement>('controlApiAllowActions').checked },
    ...chatPatch
  };
  requestedSettings = patch;

  const work = settingsSaveQueue.then(
    () => saveSnapshot(patch, previous),
    () => saveSnapshot(patch, previous)
  );
  settingsSaveQueue = work.then(
    () => undefined,
    () => undefined
  );
  return work;
}

async function saveSnapshot(patch: SettingsPatch, previous: AppState['config']): Promise<void> {
  const toolSurfaceChanged =
    previous.multiAgent.enabled !== patch.multiAgent.enabled ||
    (Object.keys(patch.capabilities) as Capability[]).some((cap) => {
      const before = previous.capabilities[cap] && !(previous.readOnly && WRITE_CAPABILITIES.includes(cap));
      const after = patch.capabilities[cap] && !(patch.readOnly && WRITE_CAPABILITIES.includes(cap));
      return before !== after;
    });
  const base: SettingsPatch = {
    connectorSuffix: previous.connectorSuffix ?? '',
    capabilities: previous.capabilities,
    readOnly: previous.readOnly,
    commandAllowlist: previous.commandAllowlist,
    tunnel: previous.tunnel,
    ui: previous.ui,
    sessions: previous.sessions,
    compaction: previous.compaction,
    mcp: previous.mcp ?? { instructions: '' },
    controlApi: previous.controlApi ?? { enabled: false, allowActions: false },
    multiAgent: previous.multiAgent,
    goal: previous.goal
  };
  const next = await run(api.saveSettings(patch, base));
  // Retire this request before repaint, while a newer queued preference still wins.
  if (requestedSettings === patch) requestedSettings = null;
  if (next) {
    apply(next);
    if (previous.multiAgent.enabled && !patch.multiAgent.enabled) {
      // A cached snapshot keeps offering the `agents` tool until the connector is
      // reloaded. Say so plainly rather than letting it look sticky.
      toast(t("Multi-agent off. Reconnect the connector in ChatGPT (then start a new chat) to drop the agents tool."));
    } else if (toolSurfaceChanged) {
      toast(t("Tools changed. Start a new ChatGPT conversation to guarantee the new tool list is loaded."));
    }
  } else {
    await refresh();
    // A rejected select remains focused. Restore it even though ordinary pushes protect dirty
    // controls, unless a later save explicitly requested a different port. Unchanged queued
    // snapshots keep their original base so main's three-way merge cannot retry this rejection.
    if (state && (!requestedSettings || requestedSettings.ui.browserBridgePort === patch.ui.browserBridgePort)) {
      $<HTMLSelectElement>('browserBridgePort').value = String(state.config.ui.browserBridgePort ?? 'auto');
    }
    // The same for the control API switches: a box that stayed ticked after a failed save would
    // send its value again with the next unrelated save, and grant what was never saved.
    if (state && (!requestedSettings || requestedSettings.controlApi?.allowActions === patch.controlApi?.allowActions)) {
      $<HTMLInputElement>('controlApiAllowActions').checked = state.config.controlApi?.allowActions === true;
    }
    if (state && (!requestedSettings || requestedSettings.controlApi?.enabled === patch.controlApi?.enabled)) {
      $<HTMLInputElement>('controlApiEnabled').checked = state.config.controlApi?.enabled === true;
    }
  }
}

// ---------------------------------------------------------------- helpers

const STATUS_TEXT: Record<AppState['status']['state'], string> = {
  disconnected: "Not connected",
  disconnecting: "Disconnecting",
  'starting-server': "Starting",
  'connecting-tunnel': "Connecting",
  connected: "Connected",
  offline: "No internet",
  'auth-failed': "Sign-in failed",
  'tunnel-unavailable': "Tunnel unavailable"
};

const METHOD_HINT: Record<string, string> = {
  openai:
    "ChatGPT reaches this computer through an OpenAI tunnel. Nothing is exposed to the open internet.",
  cloudflared:
    "Creates a temporary public https address with Cloudflare. The address changes on every restart.",
  manual: "This app only listens on localhost. You are responsible for exposing it."
};

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/**
 * True while the bridge is up and Disconnect is the meaningful action. Offline
 * counts: the tunnel is still alive and retrying, it just cannot reach OpenAI.
 */
function isRunning(value: AppState['status']['state']): boolean {
  return (
    value === 'connected' ||
    value === 'offline' ||
    value === 'starting-server' ||
    value === 'connecting-tunnel'
  );
}

interface SetupConnectionValues { tunnelId: string; hasApiKey: boolean }

/** What still has to happen before connecting can work, in the order of the wizard. */
function missingStep(
  next: AppState,
  values: SetupConnectionValues = { tunnelId: next.config.tunnel.tunnelId, hasApiKey: next.hasApiKey }
): { step: string; text: string } | null {
  const { config } = next;
  // This is the same capability rule as the main-process admission gate. Desktop and
  // clipboard may legitimately be rootless; enabling one must not hide a root still needed
  // by an effective file/patch/command capability on Core.
  if (config.roots.length === 0 && requiresApprovedFilesystemRoot(config)) {
    return { step: 'folder', text: t("Choose a folder to share — step 2.") };
  }
  if (config.tunnel.kind === 'openai') {
    if (!TUNNEL_ID_PATTERN.test(values.tunnelId)) {
      return { step: 'tunnel', text: t("Create a tunnel and paste its ID — step 3.") };
    }
    if (!(next.secureStorage?.available ?? true) && !values.hasApiKey) {
      return { step: 'key', text: next.secureStorage?.detail ?? t("Secure credential storage is unavailable.") };
    }
    if (!values.hasApiKey) {
      return { step: 'key', text: t("Add a restricted API key — step 4.") };
    }
  } else if (!next.resolvedBinary && config.tunnel.kind === 'cloudflared') {
    return { step: 'connect', text: t("cloudflared was not found on this computer.") };
  }
  return null;
}

/**
 * Readiness for a click the user can make now, including a Tunnel ID or API key still typed into
 * Setup. Persisted state stays authoritative everywhere else; this only keeps Connect enabled so
 * the click itself can store those drafts (see `persistSetupDraftsForConnection`). Adapted from
 * @Haz4rdovisk's #345: before, typing both and clicking Connect did nothing, because the values
 * were only stored on blur and the button was still disabled when the click landed.
 */
function currentSetupMissingStep(next: AppState): { step: string; text: string } | null {
  const key = $<HTMLInputElement>('apiKey');
  return missingStep(next, {
    tunnelId: $<HTMLInputElement>('tunnelId').value.trim(),
    hasApiKey: next.hasApiKey || (next.secureStorage?.available !== false && key.value !== '')
  });
}

/**
 * This computer's connector name suffix as typed, checked here so one invalid character cannot
 * reject the whole settings save it rides in. Invalid keeps the saved value and says why.
 */
function connectorSuffixValid(): string | null {
  const input = $<HTMLInputElement>('connectorSuffix');
  const value = input.value.trim().replace(/\s+/g, ' ');
  const valid = value.length <= CONNECTOR_SUFFIX_MAX && CONNECTOR_SUFFIX_PATTERN.test(value);
  input.setAttribute('aria-invalid', String(!valid));
  $('connectorSuffixError').hidden = valid;
  return valid ? value : null;
}
function connectorSuffixDraft(previous: Config): string {
  return connectorSuffixValid() ?? previous.connectorSuffix ?? '';
}

interface RootRenameState {
  targetName: string;
  targetPath: string;
  draft: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: 'forward' | 'backward' | 'none' | null;
  focused: boolean;
  committing: boolean;
}

let rootRename: RootRenameState | null = null;
let repaintingRoots = false;

/**
 * The rename editor is transient DOM, but the draft is user state. Whole-state pushes repaint
 * the folder list, so capture that state before the old input is detached and recreate the
 * editor only while the exact authoritative root still exists unchanged.
 */
function captureRootRenameInput(input: HTMLInputElement, rename: RootRenameState): void {
  if (rootRename !== rename) return;
  rename.draft = input.value;
  rename.focused = document.activeElement === input;
  if (rename.focused) {
    rename.selectionStart = input.selectionStart;
    rename.selectionEnd = input.selectionEnd;
    rename.selectionDirection = input.selectionDirection;
  }
}

function cancelRootRename(): void {
  rootRename = null;
  if (state) paintRoots(state.config.roots);
}

async function commitRootRename(input: HTMLInputElement, rename: RootRenameState): Promise<void> {
  if (rootRename !== rename || rename.committing) return;
  captureRootRenameInput(input, rename);
  const nextName = rename.draft.trim().toLowerCase();
  if (!nextName || nextName === rename.targetName) {
    cancelRootRename();
    return;
  }

  rename.committing = true;
  input.disabled = true;
  const result = await run(api.renameRoot(rename.targetName, nextName));
  // An authoritative state push can remove or rename the target while IPC is in flight. Never
  // resurrect that cancelled editor when this older request finishes.
  if (rootRename !== rename) return;
  if (result) {
    rootRename = null;
    apply(result);
    return;
  }

  // Failure is retryable user input, not a reason to throw the draft away.
  rename.committing = false;
  paintRoots(state?.config.roots ?? []);
}

function rootRow(root: AppState['config']['roots'][number]): HTMLElement {
  const row = el('div', 'root');
  const renameState =
    rootRename?.targetName === root.name && rootRename.targetPath === root.path ? rootRename : null;
  const name = el('b', '', `/${root.name}`);
  let label: HTMLElement = name;

  if (renameState) {
    const input = document.createElement('input');
    input.className = 'root-rename';
    input.value = renameState.draft;
    input.maxLength = 32;
    input.disabled = renameState.committing;
    ui(input, 'aria-label', () => t("Rename /{0}", [root.name]));
    input.addEventListener('input', () => captureRootRenameInput(input, renameState));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void commitRootRename(input, renameState);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRootRename();
      }
    });
    input.addEventListener('blur', () => {
      // replaceChildren() may itself blur the old node in a real browser. paintRoots already
      // captured its draft/focus/caret immediately before detaching it, so treating that blur
      // as user intent would both lose focus restoration and accidentally commit on a status push.
      if (repaintingRoots) return;
      captureRootRenameInput(input, renameState);
      void commitRootRename(input, renameState);
    });
    label = input;
  }

  const rename = document.createElement('button');
  rename.className = 'btn';
  rename.type = 'button';
  ui(rename, 'title', () => t("Rename /{0}", [root.name]));
  rename.append(icon('i-pencil'));
  rename.addEventListener('click', () => {
    rootRename = {
      targetName: root.name,
      targetPath: root.path,
      draft: root.name,
      selectionStart: 0,
      selectionEnd: root.name.length,
      selectionDirection: 'none',
      focused: true,
      committing: false
    };
    paintRoots(state?.config.roots ?? []);
  });

  const remove = document.createElement('button');
  remove.className = 'btn';
  remove.type = 'button';
  ui(remove, 'title', () => t("Stop sharing /{0}", [root.name]));
  remove.append(icon('i-trash'));
  remove.addEventListener('click', async () => {
    const result = await run(api.removeRoot(root.name));
    if (result) apply(result);
  });
  const path = el('span', '', root.path);
  path.title = root.path;
  row.append(icon('i-folder'), label, path, rename, remove);
  return row;
}

function paintRoots(roots: AppState['config']['roots']): void {
  const active = document.querySelector<HTMLInputElement>('.root-rename');
  if (active && rootRename) captureRootRenameInput(active, rootRename);

  if (
    rootRename &&
    !roots.some((root) => root.name === rootRename!.targetName && root.path === rootRename!.targetPath)
  ) {
    rootRename = null;
  }

  repaintingRoots = true;
  try {
    $('rootList').replaceChildren(...roots.map(rootRow));
  } finally {
    repaintingRoots = false;
  }

  if (!rootRename?.focused) return;
  const input = document.querySelector<HTMLInputElement>('.root-rename');
  if (!input) return;
  input.focus();
  if (rootRename.selectionStart !== null && rootRename.selectionEnd !== null) {
    input.setSelectionRange(
      rootRename.selectionStart,
      rootRename.selectionEnd,
      rootRename.selectionDirection ?? undefined
    );
  }
}

// ----------------------------------------------------------------- render

/** How the one update sentence reads: nothing to do, something in progress, something wrong. */
type UpdateTone = 'ok' | 'work' | 'bad';

/** The update notification is news, and news is told once per window. */
let announced = false;

/**
 * Everything this window knows about being current, as one sentence and one tone.
 *
 * Two facts feed it and this owns neither: what the update service found (state.update, which
 * reports a `latest` only when it is genuinely newer, so nothing here compares versions), and
 * the last extension version observed by the bridge. A protocol mismatch can prevent presence,
 * so an observed older version remains actionable until a current companion reports in.
 *
 * Null is the one silence that is not an answer: GitHub has not replied yet in this run, so
 * "up to date" would be a claim nobody has checked. That is what `checkedAt` is for.
 *
 * `notice` is the narrower question of whether the header bar carries the sentence at all. That
 * bar is for what the user can act on - a version to fetch by hand, an extension to reload -
 * while the Activity line reports every state, including the good one.
 */
function updateSummary({ bridge, update, config, status }: AppState): { text: string; tone: UpdateTone; notice: boolean; extensionAction: string | null } | null {
  // Only an extension older than this app is the user's to fix. The other direction is an app
  // that has not caught up yet - normal while an update downloads - and telling that user to
  // load the bundled folder again would talk them into downgrading a working extension. The
  // app sentence already owns being behind.
  const stale =
    bridge.extensionVersion && isNewer(update.current, bridge.extensionVersion)
      ? bridge.extensionVersion
      : null;
  // A mismatched companion can fail the protocol gate before it becomes present.
  // Retain its last observed version until a matching companion actually reports in.
  const missing = !stale && bridge.running && !bridge.present && isRunning(status.state) && browserExtensionRequired(config);
  if (!stale && !missing && !update.latest && update.stage === 'idle' && !update.checkedAt) return null;

  const lines: string[] = [];
  let tone: UpdateTone = 'work';
  if (update.latest) {
    // `latest` set with a stage of `idle` is the deliberate case: a new version exists and this
    // installation - a Linux .deb, macOS, a development tree, an architecture with no artifact -
    // is not one the app can update by itself. That is when the button matters.
    lines.push(
      update.stage === 'checking'
        ? t("Checking for the latest update…")
        : update.stage === 'ready'
        ? t("Chat On Steroids {0} is downloaded and ready. Install it now, or it installs the next time you quit.", [update.latest])
        : update.stage === 'downloading'
          ? t("Chat On Steroids {0} is downloading. Keep working; you can install it when it lands.", [update.latest])
          : update.stage === 'failed'
            ? t("Chat On Steroids {0} could not be downloaded: {1}.", [update.latest, update.error ?? t("the download stopped")])
            : t("Chat On Steroids {0} is out. This installation has to be updated by hand.", [update.latest])
    );
    if (update.stage === 'failed') tone = 'bad';
  } else if (update.stage === 'failed') {
    lines.push(t("Could not check for a newer version: {0}.", [update.error ?? t("the check stopped")]));
    tone = 'bad';
  } else if (update.stage === 'checking') {
    lines.push(t("Checking for a newer version…"));
  } else if (!stale && !missing) {
    const extension = bridge.present && bridge.extensionVersion ? t(" · extension {0}", [bridge.extensionVersion]) : '';
    lines.push(t("Up to date! Chat On Steroids {0}{1}", [update.current, extension]));
    tone = 'ok';
  }
  if (stale) {
    lines.push(
      t("Update your browser extension: {0} → {1}. ", [stale, update.current]) +
        t("Reload the extension from this app’s folder, then refresh ChatGPT.")
    );
    tone = 'bad';
  }
  if (missing) { lines.push(t("Browser extension not connected. Open ChatGPT and check the companion in Setup to load models and send messages.")); tone = 'bad'; }
  return { text: lines.join(' '), tone, notice: Boolean(update.latest || stale || missing), extensionAction: stale ? t("Update extension") : missing ? t("Check extension") : null };
}

/** The header bar, the Activity line and the one notification, from that single sentence. */
function paintUpdate(next: AppState): void {
  const summary = updateSummary(next);
  const notice = $('updateNotice');
  const line = $('updateLine');
  if (!summary) {
    notice.hidden = true;
    line.hidden = true;
    $('updateExtension').hidden = true;
    return;
  }
  const { update } = next;
  ui($('updateText'), 'textContent', () => updateSummary(next)?.text ?? '');
  $('updateExtension').hidden = !summary.extensionAction;
  ui($('updateExtension'), 'textContent', () => updateSummary(next)?.extensionAction ?? t("Update extension"));
  $<HTMLButtonElement>('updateGet').hidden = !update.latest || update.stage === 'checking' || update.stage === 'downloading' || update.stage === 'ready';
  // `ready` is the only state with a verified artifact on disk, and therefore the only one in
  // which pressing Install can do anything. Both buttons ask the same question of the same fact.
  const installable = update.stage === 'ready';
  $<HTMLButtonElement>('updateInstall').hidden = !installable;
  $<HTMLButtonElement>('installUpdate').hidden = !installable;
  notice.hidden = !summary.notice;
  ui(line, 'textContent', () => updateSummary(next)?.text ?? '');
  line.className = `upline${summary.tone === 'ok' ? ' is-ok' : summary.tone === 'bad' ? ' is-bad' : ''}`;
  line.hidden = false;
  // One notification per window, on the first answer that is an outcome rather than progress.
  // The Activity line keeps the sentence afterwards, so repeating it as a toast on every state
  // push would be the same news arriving over and over.
  if (!announced && update.stage !== 'checking' && update.stage !== 'downloading') {
    announced = true;
    toast(summary.text);
  }
}

function paintSetupProfiles(next: AppState): void {
  const tunnel = next.config.tunnel;
  const select = $<HTMLButtonElement>('setupProfile');
  const menu = $('setupProfileMenu');
  const profiles = [{ id: tunnel.profileId ?? 'default', name: tunnel.profileName ?? t('Default') }, ...(next.config.setupProfiles ?? [])];
  const signature = JSON.stringify(profiles);
  if (select.dataset.profiles !== signature) {
    menu.replaceChildren(...profiles.map(profile => {
      const row = el('div', 'setup-profile-option');
      const choose = document.createElement('button');
      choose.type = 'button'; choose.className = 'btn'; choose.textContent = profile.name;
      choose.translate = false;
      choose.dataset.profileId = profile.id;
      choose.setAttribute('aria-pressed', String(profile.id === (tunnel.profileId ?? 'default')));
      choose.addEventListener('click', () => void changeSetupProfile('select', profile.id));
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'btn'; remove.dataset.removeProfileId = profile.id;
      ui(remove, 'title', () => t('Delete profile: {0}', [profile.name]));
      ui(remove, 'aria-label', () => t('Delete profile: {0}', [profile.name]));
      remove.append(icon('i-trash'));
      remove.addEventListener('click', () => void changeSetupProfile('remove', profile.id));
      row.append(choose, remove); return row;
    }));
    select.dataset.profiles = signature;
  }
  $('setupProfileCurrent').textContent = profiles[0]!.name;
  select.disabled = setupProfileBusy;
  for (const button of menu.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = setupProfileBusy || (button.dataset.removeProfileId !== undefined && profiles.length === 1);
  }
  $<HTMLButtonElement>('setupProfileAdd').disabled = setupProfileBusy || profiles.length >= 12;
  $<HTMLInputElement>('setupProfileName').disabled = setupProfileBusy;
  for (const id of ['tunnelId', 'desktopTunnelId']) $<HTMLInputElement>(id).disabled = setupProfileBusy;
  $<HTMLInputElement>('apiKey').disabled = setupProfileBusy || next.secureStorage?.available === false;
  $<HTMLButtonElement>('removeApiKey').disabled = setupProfileBusy || next.secureStorage?.available === false;
}

async function changeSetupProfile(action: 'add' | 'select' | 'remove', id?: string): Promise<void> {
  if (!state || setupProfileBusy) return;
  const nameInput = $<HTMLInputElement>('setupProfileName');
  const name = nameInput.value.trim();
  if (action === 'add' && !name) { nameInput.focus(); return; }
  setupProfileBusy = true; paintSetupProfiles(state);
  try {
    await settingsSaveQueue;
    if (!(await setupKeySave)) return;
    const next = await run(action === 'add' ? api.addSetupProfile(name)
      : action === 'remove' ? api.removeSetupProfile(id!) : api.selectSetupProfile(id!));
    if (!next) return;
    requestedSettings = null;
    $<HTMLInputElement>('apiKey').value = '';
    if (action === 'add') {
      if (nameInput.value.trim() === name) nameInput.value = '';
      $<HTMLDialogElement>('setupProfileDialog').close();
    }
    $('setupProfileMenu').hidePopover();
    setupOpenStep = null;
    apply(next);
  } finally {
    setupProfileBusy = false;
    if (state) paintSetupProfiles(state);
  }
}
$('setupProfileAdd').addEventListener('click', () => {
  $<HTMLDialogElement>('setupProfileDialog').showModal();
  $('setupProfileName').focus();
});
$('setupProfileCancel').addEventListener('click', () => $<HTMLDialogElement>('setupProfileDialog').close());
$('setupProfileForm').addEventListener('submit', event => { event.preventDefault(); void changeSetupProfile('add'); });

function paintSetupFields(): void {
  for (const id of ['tunnelId', 'apiKey']) {
    const input = $<HTMLInputElement>(id);
    const stored = id === 'apiKey' && state?.hasApiKey === true;
    input.classList.toggle('is-empty', !stored && input.value.trim() === '');
    input.setAttribute('aria-required', String(!stored));
  }
  if (state) paintConnectButtons(state);
}

/** Connect is enabled from the persisted state or from valid drafts still in the fields. */
function paintConnectButtons(next: AppState): void {
  const running = isRunning(next.status.state), disconnecting = next.status.state === 'disconnecting';
  const missing = currentSetupMissingStep(next);
  for (const id of ['connectionPopoverToggle', 'wizConnect']) {
    const button = $<HTMLButtonElement>(id);
    button.disabled = disconnecting || (!running && missing !== null);
    button.title = !running && missing ? missing.text : '';
  }
}

function apply(next: AppState): void {
  // An older key/status response must not restore a profile retired by a newer switch.
  if ((next.config.tunnel.profileEpoch ?? 0) < (state?.config.tunnel.profileEpoch ?? 0)) return;
  applyPluginsState(next);
  const previousState = state;
  state = next;
  applying = true;
  const { config, status } = next;

  const connected = status.state === 'connected';
  const offline = status.state === 'offline';
  const disconnecting = status.state === 'disconnecting';
  const busy = disconnecting || status.state === 'starting-server' || status.state === 'connecting-tunnel';
  const failed = status.state === 'auth-failed' || status.state === 'tunnel-unavailable';
  const running = isRunning(status.state);
  const missing = currentSetupMissingStep(next);

  // ---- theme
  const appearanceUi = requestedSettings?.ui ?? config.ui;
  appearance.apply(appearanceUi);

  const headerConnect = $<HTMLButtonElement>('headerConnect');
  const wasVisible = !headerConnect.hidden;
  headerConnect.hidden = connected;
  headerConnect.disabled = busy;
  ui(headerConnect, 'textContent', () => disconnecting ? t('Disconnecting…') : busy ? t('Connecting…') : t('Connect'));
  if (connected && wasVisible && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) $('sidebarConnection').animate([
    { boxShadow: '0 0 0 0 var(--green)' }, { boxShadow: '0 0 0 12px transparent' }
  ], { duration: 850, iterations: 2 });

  // ---- global connection surface
  const connectionTone = connected ? 'is-connected' : offline ? 'is-offline' : busy ? 'is-busy' : failed ? 'is-error' : '';
  const sidebarConnection = $('sidebarConnection');
  sidebarConnection.className = `sidebar-connection${connectionTone ? ` ${connectionTone}` : ''}`;
  const connectionPopover = $('connectionPopover');
  connectionPopover.className = `connection-popover scroll${connectionTone ? ` ${connectionTone}` : ''}`;
  ui($('connectionPopoverTitle'), 'textContent', () => t(STATUS_TEXT[status.state]));

  const id = config.tunnel.tunnelId;
  ui($('headerSub'), 'textContent', () => config.tunnel.kind === 'openai'
      ? TUNNEL_ID_PATTERN.test(id)
        ? `${id.slice(0, 11)}…${id.slice(-4)}`
        : t("No tunnel yet")
      : (status.publicUrl ?? status.localUrl ?? config.tunnel.kind));

  const connectBtn = $<HTMLButtonElement>('connectionPopoverToggle');
  ui(connectBtn, 'textContent', () => disconnecting ? t('Disconnecting…') : running ? t("Disconnect") : t("Connect"));
  connectBtn.disabled = disconnecting || (!running && missing !== null);
  connectBtn.title = !running && missing ? missing.text : '';

  // ---- out of date, app or extension
  paintUpdate(next);
  paintPluginRefreshReminder(next.connectorSchemas ?? {});

  // ---- health numbers and facts
  paintClock();
  $('facts').replaceChildren(...facts(next));

  // ---- permissions
  $('readOnlyBtn').classList.toggle('is-on', config.readOnly);
  $('readOnlyBtn').setAttribute('aria-pressed', String(config.readOnly));
  // The lock reads like a state; the title says which way a click goes and what it changes.
  ui($('readOnlyBtn'), 'title', () => config.readOnly
    ? t('Read-only is on: ChatGPT can only look. Click to allow changes again.')
    : t('Switch to read-only: ChatGPT can still look at files and the screen, but can’t create, edit, move or delete files, run programs or control this computer.'));
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) {
    const cap = input.dataset.cap as Capability;
    const supported = (next.platform?.desktopAutomation ?? true) || !DESKTOP_CAPABILITIES.includes(cap) || cap === 'screen' || cap === 'control';
    applyChecked(input, supported && config.capabilities[cap], previousState?.config.capabilities[cap]);
  }
  applyChecked(
    $<HTMLInputElement>('homeMaEnabled'),
    config.multiAgent.enabled,
    previousState?.config.multiAgent.enabled
  );
  applyChecked(
    $<HTMLInputElement>('commandAllowlistEnabled'),
    config.commandAllowlist.enabled,
    previousState?.config.commandAllowlist.enabled
  );
  const previousCommandPolicyMode = previousState?.config.commandAllowlist.mode;
  const focusedCommandPolicyMode = (document.activeElement as HTMLElement | null)?.dataset.commandPolicyMode;
  if (!focusedCommandPolicyMode || previousCommandPolicyMode === undefined || focusedCommandPolicyMode === previousCommandPolicyMode) {
    paintCommandPolicyMode(config.commandAllowlist.mode);
  }
  applyValue(
    $<HTMLTextAreaElement>('commandAllowlistRules'),
    config.commandAllowlist.rules.join('\n'),
    previousState?.config.commandAllowlist.rules.join('\n')
  );
  readCommandAllowlist();
  paintGroups();
  paintDesktopAccess(next);

  // ---- folders
  paintRoots(config.roots);
  $('rootsEmpty').hidden = config.roots.length > 0;

  // ---- nav badge
  $('setupBadge').hidden = missing === null;

  // ---- wizard
  applyValue(
    $<HTMLSelectElement>('tunnelKind'),
    config.tunnel.kind,
    previousState?.config.tunnel.kind
  );
  ui($('methodHint'), 'textContent', () => t(METHOD_HINT[config.tunnel.kind] ?? ''));
  applyValue($<HTMLInputElement>('tunnelId'), config.tunnel.tunnelId, previousState?.config.tunnel.tunnelId);
  applyValue($<HTMLInputElement>('connectorSuffix'), config.connectorSuffix ?? '', previousState?.config.connectorSuffix ?? '');
  // A computer that has a name shows it, so the cards' suffixed names never come unexplained.
  if (config.connectorSuffix && !previousState?.config.connectorSuffix) $<HTMLDetailsElement>('connectorSuffixField').open = true;
  applyValue(
    $<HTMLInputElement>('desktopTunnelId'),
    config.tunnel.desktopTunnelId,
    previousState?.config.tunnel.desktopTunnelId
  );
  applyValue($<HTMLInputElement>('binaryPath'), config.tunnel.binaryPath, previousState?.config.tunnel.binaryPath);
  applyValue($<HTMLSelectElement>('chatBrowser'), config.ui.chatBrowser ?? 'chrome', previousState?.config.ui.chatBrowser ?? 'chrome');
  $<HTMLSelectElement>('planBackend').value = config.ui.planBackend ?? 'chatgpt';
  applyChecked($<HTMLInputElement>('finishTool'), config.ui.finishTool === true, previousState?.config.ui.finishTool);
  applyValue($<HTMLSelectElement>('finishLeadMinutes'), String(config.ui.finishLeadMinutes ?? 5), String(previousState?.config.ui.finishLeadMinutes ?? 5));
  $<HTMLSelectElement>('finishLeadMinutes').disabled = config.ui.finishTool !== true;
  applyChecked($<HTMLInputElement>('backgroundChats'), config.ui.backgroundChats === true, previousState?.config.ui.backgroundChats);
  const bridgePortControl = $<HTMLSelectElement>('browserBridgePort');
  applyValue(bridgePortControl, String(config.ui.browserBridgePort ?? 'auto'), String(previousState?.config.ui.browserBridgePort ?? 'auto'));
  bridgePortControl.disabled = next.bridge.portOverridden === true;
  ui($('browserBridgePortHint'), 'textContent', () => next.bridge.portOverridden
    ? t('Controlled by CLF_BRIDGE_PORTS. Change the environment override to choose a port here.')
    : t('Auto uses the first available port. A fixed port must be available.'));
  applyChecked($<HTMLInputElement>('autoContinue'), config.ui.autoContinue !== false, previousState?.config.ui.autoContinue);
  applyChecked($<HTMLInputElement>('browserOnly'), config.ui.browserOnly === true, previousState?.config.ui.browserOnly);
  applyChecked($<HTMLInputElement>('autoRefreshPlugins'), config.ui.autoRefreshPlugins === true, previousState?.config.ui.autoRefreshPlugins);
  applyChecked($<HTMLInputElement>('autoSelectSkills'), config.ui.autoSelectSkills === true, previousState?.config.ui.autoSelectSkills);
  $('startAtLoginRow').hidden = next.loginStartupAvailable !== true;
  $<HTMLInputElement>('startAtLogin').disabled = next.loginStartupAvailable !== true;
  applyChecked($<HTMLInputElement>('startAtLogin'), config.ui.startAtLogin === true, previousState?.config.ui.startAtLogin);
  applyChecked($<HTMLInputElement>('autoConnect'), config.ui.autoConnect, previousState?.config.ui.autoConnect);
  applyChecked($<HTMLInputElement>('developerMode'), config.ui.developerMode === true, previousState?.config.ui.developerMode);
  applyChecked($<HTMLInputElement>('playfulStatus'), config.ui.playfulStatus === true, previousState?.config.ui.playfulStatus);
  applyChecked($<HTMLInputElement>('followOutput'), config.ui.followOutput !== false, previousState?.config.ui.followOutput);
  applyChecked($<HTMLInputElement>('mentionCore'), config.ui.mentionCore !== false, previousState?.config.ui.mentionCore);
  applyChecked($<HTMLInputElement>('controlApiEnabled'), config.controlApi?.enabled === true, previousState?.config.controlApi?.enabled);
  applyChecked($<HTMLInputElement>('controlApiAllowActions'), config.controlApi?.allowActions === true, previousState?.config.controlApi?.allowActions);
  // Actions need the API itself, so the switch stays off and disabled until it is on.
  $<HTMLInputElement>('controlApiAllowActions').disabled = config.controlApi?.enabled !== true;
  applyChecked(
    $<HTMLInputElement>('minimizeToTray'),
    config.ui.minimizeToTray,
    previousState?.config.ui.minimizeToTray
  );
  applyChecked(
    $<HTMLInputElement>('privacyScreenshots'),
    config.ui.privacyScreenshots,
    previousState?.config.ui.privacyScreenshots
  );
  $('privacyScreenshotsSetting').hidden = !(next.platform?.desktopAutomation ?? true);
  if (next.platform?.family === 'macos') {
    ui($('backgroundRunningCopy'), 'textContent', () => t("Leave it running while you use the connector. It stays available from the menu bar and Dock when you close the window."));
    ui($('minimizeToTrayCopy'), 'textContent', () => t("Hide the window to the menu bar when closed"));
  } else {
    ui($('backgroundRunningCopy'), 'textContent', () => t("Leave it running while you use the connector. It stays in the tray when you close the window."));
    ui($('minimizeToTrayCopy'), 'textContent', () => t("Keep running in the tray when closed"));
  }

  const openai = config.tunnel.kind === 'openai';
  const browserRequired = browserExtensionRequired(config);
  step('tunnel').hidden = !openai;
  step('key').hidden = !openai;
  step('browser').hidden = !browserRequired;
  const cosBrowser = (config.ui.chatBrowser ?? 'chrome') === 'cos';
  const browserProgress = browserSetup.render(next);
  for (const other of externalSetupLinks) other.hidden = !cosBrowser;
  // Only this method needs a tunnel per connector. Cloudflare and manual publish the
  // whole address, so both connectors already ride the one tunnel on their own paths.
  const desktopSurface = status.surfaces.find((surface) => surface.id === 'desktop');
  $('desktopTunnelField').hidden = !openai || !desktopSurface?.available;

  // The add button is the call to action until a folder is shared, then it quiets to done.
  $('wizAddFolder').dataset.tone = config.roots.length > 0 ? 'ok' : 'off';
  // One folder per line: they are paths, and a row of them wraps mid-name.
  $('wizFolders').replaceChildren(...(config.roots.length === 0
    ? [(() => {
      // Empty is an invitation, not a hole: the whole area chooses a folder, like the button.
      const row = el('li', 'is-empty');
      const pick = el('button', 'folder-empty');
      pick.setAttribute('type', 'button');
      pick.append(icon('i-folder'), el('span', '', () => t("No folder shared yet. Choose one to start.")));
      pick.addEventListener('click', () => void addFolder());
      row.append(pick);
      return row;
    })()]
    : config.roots.map((root) => { const row = el('li'); row.append(icon('i-folder'), el('span', '', `/${root.name}`)); return row; })));
  const secureStorageAvailable = next.secureStorage?.available ?? true;
  const apiKey = $<HTMLInputElement>('apiKey');
  ui(apiKey, 'placeholder', () => next.hasApiKey ? t("•••••••• stored") : 'sk-…');
  apiKey.disabled = !secureStorageAvailable;
  paintSetupFields();
  paintSetupProfiles(next);
  ui($('apiKeyState'), 'textContent', () => !secureStorageAvailable
    ? (next.secureStorage?.detail ?? t("Secure credential storage is unavailable."))
    : next.hasApiKey
      ? t("A key is stored with secure OS credential storage. Type a new one to replace it, or use Remove stored API key.")
      : t("Stored with secure OS credential storage. It is never shown again and never leaves this app."));
  $('apiKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('removeApiKey').disabled = !next.hasApiKey || !secureStorageAvailable;

  // The tunnel's state in one glance: a coloured badge, and the button that changes it. Only a
  // failure says more, since only then is there something to do about it.
  const wizConnect = $<HTMLButtonElement>('wizConnect');
  const tone = failed ? 'bad' : status.state === 'connected' ? 'ok' : running || disconnecting ? 'wait' : 'off';
  ui($('wizConnectLabel'), 'textContent', () => disconnecting ? t('Disconnecting…') : running ? t("Disconnect") : t("Connect"));
  wizConnect.disabled = connectBtn.disabled;
  wizConnect.dataset.tone = tone;
  const pill = $('wizStatusPill');
  pill.dataset.tone = tone;
  ui(pill, 'textContent', () => t(STATUS_TEXT[status.state]));
  const detail = $('wizStatus');
  detail.hidden = !failed || !status.detail;
  ui(detail, 'textContent', () => failed ? status.detail : '');

  // The pictures show the tunnel path; only a published URL needs saying in words.
  $('chatgptConn').hidden = openai;
  $('chatgptConn').replaceChildren(
    openai
      ? frag("For the connection, choose ", "Tunnel", " and pick the tunnel you made in step 3.")
      : frag("For the connection, paste the URL below into ", "MCP server URL", '.')
  );

  // Says plainly whether the connector has ever reached this app, because a
  // FORBIDDEN inside one ChatGPT conversation is not the same as a broken setup.
  // The middle case is the one that costs hours: ChatGPT connects and reads the tool
  // list, but the model is never allowed to call anything — Developer mode is off.
  // Every connector this app is publishing that ChatGPT has never reached. Computed here
  // because it decides three things at once: the summary line, whether the ChatGPT step counts as
  // done, and whether the cards stay on screen after the wizard tidies itself away.
  // This run's evidence, else the lasting proof kept for the tunnel each connector uses now:
  // a plugin that worked yesterday is still created in ChatGPT after a restart.
  const surfaces = status.surfaces.map(withEvidence);
  const newest = (times: Array<number | null>) => times.reduce<number | null>((best, at) => at !== null && (best === null || at > best) ? at : best, null);
  const reachedAt = status.lastRequestAt ?? newest(surfaces.map(surface => surface.lastRequestAt));
  const ranAt = status.lastToolCallAt ?? newest(surfaces.map(surface => surface.lastToolCallAt));
  // Created is the plugin existing in ChatGPT: ChatGPT reached it, or listed it as installed.
  const unverified = surfaces.filter((surface) => surface.available && !pluginCreated(surface));
  const chatgptNote = $('wizChatgpt');
  chatgptNote.hidden = reachedAt === null && unverified.length === surfaces.filter(surface => surface.available).length;
  chatgptNote.classList.toggle(
    'is-warn',
    reachedAt !== null && (ranAt === null || unverified.length > 0)
  );
  ui(chatgptNote, 'textContent', () => reachedAt === null
      ? unverified.length < surfaces.filter(surface => surface.available).length
        ? t("The plugin is in your ChatGPT. It runs the first time a chat asks for it.")
        : ''
      : ranAt === null
        ? t("ChatGPT connected {0} but has never run a tool. Check that the CoS app is enabled in ChatGPT → Plugins.", [ago(reachedAt)])
        : unverified.length > 0
          ? // One connector working is not the whole setup. Naming the missing one is the
            // difference between "something is off" and knowing what to go and create.
            t(unverified.length === 1
              ? "ChatGPT ran a tool {0}, but {1} has never been called — create it in ChatGPT to use it."
              : "ChatGPT ran a tool {0}, but {1} have never been called — create them in ChatGPT to use them.",
            [ago(ranAt), new Intl.ListFormat(currentLanguage(), { type: 'conjunction' })
              .format(unverified.map((surface) => `“${surface.connectorName}”`))])
          : t("ChatGPT ran a tool {0} — the whole chain works.", [ago(ranAt)]));

  const cards = $('connectorCards');
  cards.replaceChildren(...connectorCards(next));

  // Step marks: everything before the first unfinished step counts as done.
  const order = ['browser', 'folder', 'tunnel', 'key', 'connect', 'chatgpt'];
  const done = new Set<string>();
  if (config.roots.length > 0 || missingStep(next)?.step !== 'folder') done.add('folder');
  if (!openai || TUNNEL_ID_PATTERN.test(config.tunnel.tunnelId)) done.add('tunnel');
  if (!openai || next.hasApiKey) done.add('key');
  if (connected) done.add('connect');
  // The only honest proof the ChatGPT step is finished: ChatGPT has actually called the connectors
  // this app cannot work without. Judged per surface, because a Core request says nothing
  // about whether the Desktop connector was ever created. An optional connector never
  // blocks completion — a user may enable clipboard access and still not want a second
  // connector — but it is reported separately below rather than quietly counted as done.
  const requiredUnverified = surfaces.some(
    (surface) => surface.available && !surface.optional && !pluginCreated(surface)
  );
  if (!requiredUnverified && (reachedAt !== null || surfaces.some(surface => surface.available && pluginCreated(surface)))) done.add('chatgpt');
  // External installation and the selected execution path must both be ready.
  if (!browserRequired || browserProgress.ready) done.add('browser');
  const current = order.find((name) => !done.has(name)) ?? null;
  for (const name of order) {
    const node = step(name);
    node.classList.toggle('is-done', done.has(name));
    node.classList.toggle('is-current', name === current);
  }
  // Progress over the steps this setup actually shows (the browser step is hidden when unused).
  const shown = order.filter(name => !step(name).hidden);
  const finished = shown.filter(name => done.has(name)).length;
  const progress = $('setupProgress');
  progress.setAttribute('aria-valuemax', String(shown.length));
  progress.setAttribute('aria-valuenow', String(finished));
  progress.classList.toggle('is-complete', finished === shown.length);
  ui($('setupProgressText'), 'textContent', () => finished === shown.length
    ? t('All {0} steps done', [shown.length])
    : t('{0} of {1} steps done', [finished, shown.length]));

  // One step open at a time: the one the user picked, else the first unfinished. Past the last
  // task comes Ready, which reads every check back, so a finished setup opens on its proof.
  // Following the first unfinished step is what moves the page on as each step completes.
  const path = [...shown, 'ready'];
  const open = setupOpenStep !== null && path.includes(setupOpenStep) ? setupOpenStep : current ?? 'ready';
  setupSteps = path;
  setupOpen = open;
  const allSet = current === null;
  for (const name of path) {
    step(name).classList.toggle('is-open', name === open);
    // Its place among the steps shown: only the open one is on screen, so no CSS counter can count it.
    const mark = step(name).querySelector<HTMLElement>('.step-mark');
    if (mark) mark.dataset.number = String(path.indexOf(name) + 1);
  }
  step('ready').classList.toggle('is-done', allSet);
  for (const button of document.querySelectorAll<HTMLButtonElement>('.setup-rail [data-rail-step]')) {
    const name = button.dataset.railStep!;
    const item = button.closest('li')!;
    item.hidden = !path.includes(name);
    item.classList.toggle('is-done', name === 'ready' ? allSet : done.has(name));
    item.classList.toggle('is-current', name === current);
    if (name === open) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  for (const nav of document.querySelectorAll<HTMLElement>('#wizard .step-nav')) {
    const name = nav.closest<HTMLElement>('.step')!.dataset.step!;
    const at = path.indexOf(name);
    nav.querySelector<HTMLButtonElement>('[data-step-nav="back"]')!.hidden = at <= 0;
    nav.querySelector<HTMLButtonElement>('[data-step-nav="next"]')!.hidden = at < 0 || at === path.length - 1;
    nav.classList.toggle('is-ready', done.has(name));
    if (name === 'browser') {
      nav.hidden = !browserProgress.choosingLocation;
      nav.querySelector<HTMLButtonElement>('[data-step-nav="next"]')!.disabled = !browserProgress.ready;
    }
  }
  paintReady(shown, done, cosBrowser, allSet);

  const needsBinary = config.tunnel.kind !== 'manual';
  ui($('binaryState'), 'textContent', () => !needsBinary
    ? t("Not needed for this method.")
    : next.resolvedBinary
      ? t("Using {0}", [next.resolvedBinary])
      : t("Not found. Install it, or choose the file with Browse."));
  ui($('versionLine'), 'textContent', () => next.bundledTunnelVersion
    ? t("Recent activity only — no file contents, no credentials. Bundled tunnel-client {0}.", [next.bundledTunnelVersion])
    : t("Recent activity only. File contents and credentials are never recorded."));

  chatApply(next, previousState?.config);

  applying = false;
}

const SURFACE_STATE_TEXT: Record<SurfaceStatus['state'], string> = {
  off: "Not published",
  starting: "Connecting…",
  live: "Published",
  error: "Problem"
};

/** One copyable value with its own button, so nothing has to be retyped by hand. */
function copyRow(label: string | (() => string), value: string, what: string): HTMLElement {
  const field = el('div', 'field');
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.spellcheck = false;
  input.value = value;
  const button = el('button', 'btn btn-solid');
  (button as HTMLButtonElement).type = 'button';
  button.append(icon('i-copy'), uiText(() => t("Copy")));
  button.addEventListener('click', async () => {
    const copied = await run(api.writeClipboard(value));
    if (copied) toast(t('{0} copied', [t(what)]));
  });
  const row = el('div', 'row-inline');
  row.append(input, button);
  field.append(el('label', '', label), row);
  return field;
}

/**
 * One card per connector, with the exact strings to paste into ChatGPT.
 *
 * The name and the description are offered as copyable text rather than described in
 * prose, because both are load-bearing: ChatGPT matches on the name to address the
 * connector and reads the description to decide whether to load its tools at all. A
 * connector called "my pc" with a description the user invented is one the model may
 * never reach for, and that failure looks exactly like the app being broken.
 */
function connectorCards(next: AppState): HTMLElement[] {
  const { status, config } = next;
  return status.surfaces
    .filter((surface) => surface.id !== 'plugins')
    .map((surface) => {
    // Every connector shows what to copy, Desktop beside Core: folded away, it read as optional
    // reading rather than a plugin to create.
    const card = el('div');
    card.className = `connector is-${surface.state}`;

    const head = el('div');
    head.className = 'connector-head';
    // The tag and the state wrap together, so every card's badges sit the same way under a long name.
    const badges = el('span', 'connector-badges');
    badges.append(
      el('span', `tag${surface.optional ? ' is-optional' : ''}`, () => t(surface.optional ? 'optional' : 'required')),
      el('span', `pill is-${surface.state}`, () => t(SURFACE_STATE_TEXT[surface.state]))
    );
    head.append(el('h4', '', surface.connectorName), badges);
    card.append(head, el('p', 'hint', () => t(surface.cardSummary)));

    if (!surface.available) {
      card.append(el('p', 'hint', () => t(surface.detail)));
      return card;
    }

    card.append(copyRow(() => t("Name"), surface.connectorName, 'Name'));
    card.append(copyRow(() => t("Description"), surface.description, 'Description'));

    // On the OpenAI method the connector is picked from a list of tunnels instead of
    // pasted as a URL, so showing a loopback address there would only mislead.
    const url =
      surface.publicUrl ?? (config.tunnel.kind === 'manual' ? surface.localUrl : null);
    if (url) {
      card.append(copyRow(() => t("MCP server URL"), url, 'URL'));
      card.append(
        el('p', 'hint', () => t("Anyone with this URL can use your enabled tools. Do not share it."))
      );
    } else if (config.tunnel.kind === 'openai') {
      card.append(
        el(
          'p',
          'hint',
          () => t("Select the tunnel for this connector.")
        )
      );
    }

    if (surface.detail && surface.state === 'error') card.append(el('p', 'hint is-warn', () => t(surface.detail)));

    // Published is only half the story. "Live" says this app is serving the connector;
    // it says nothing about whether the user ever created it in ChatGPT, and with two
    // connectors a single app-wide "ChatGPT called us" line cannot tell them apart.
    if (surface.state === 'live') {
      const { lastRequestAt, lastToolCallAt } = withEvidence(surface);
      card.append(
        lastRequestAt === null
          ? pluginCreated(surface)
            ? el('p', 'hint', () => t("Added in ChatGPT. Its tools have not run yet."))
            : el('p', 'hint is-warn', () => t("Not created in ChatGPT yet — ChatGPT has never called this connector."))
          : el(
              'p',
              'hint',
              () => lastToolCallAt === null
                ? t("ChatGPT connected {0} but has not run one of its tools yet.", [ago(lastRequestAt)])
                : t("ChatGPT ran one of its tools {0}.", [ago(lastToolCallAt)])
            )
      );
    }

    // The tool list is reference, not a step: it stays on hand as the card title's tooltip.
    if (surface.tools.length > 0) ui(head, 'title', () => t("Tools: {0}", [surface.tools.join(', ')]));
    return card;
    });
}

/**
 * The Health card's plain-fact list: what is actually happening in the background,
 * in the order you would ask about it. A field the tunnel could not report shows a
 * dash rather than a plausible-looking number.
 */
function facts(next: AppState): HTMLElement[] {
  const { status, config } = next;
  const rows: [string, () => string, boolean?][] = [];
  const health = status.health;

  if (isRunning(status.state)) {
    rows.push(['Route to OpenAI', () => health?.route ?? t('Starting…')]);
    rows.push([
      'Poll errors',
      () => health?.pollErrors === null || health?.pollErrors === undefined
        ? '—'
        : String(health.pollErrors),
      (health?.pollErrors ?? 0) > 0
    ]);
    const probe = health?.probe ?? null;
    rows.push([
      'Tunnel → this app',
      () => probe ?? t('Checking…'),
      probe !== null && probe !== 'ok' && probe !== 'success' && probe !== 'healthy'
    ]);
    rows.push(['Tunnel uptime', () => duration(health?.uptimeSeconds ?? null)]);
    // Requests but no tool call is what an account with Developer mode switched off
    // looks like from here, and it is invisible in every other number on this card.
    if (status.lastRequestAt !== null) {
      rows.push([
        'ChatGPT ran a tool',
        () => status.lastToolCallAt === null ? t("never — check the app in ChatGPT → Plugins") : ago(status.lastToolCallAt),
        status.lastToolCallAt === null
      ]);
    }
    if (health?.clientVersion) rows.push(['Tunnel client', () => health.clientVersion!]);
    if (status.localUrl) rows.push(['Local server', () => displayLocalServer(status.localUrl!)]);
  } else {
    rows.push(['Route to OpenAI', () => t('not running')]);
  }

  rows.push([
    'Tools across Core + Desktop',
    () => t(config.roots.length === 1 ? '{0} total · {1} folder' : '{0} total · {1} folders', [toolsOn(next), config.roots.length])
  ]);

  return rows.map(([label, value, bad]) => {
    const row = el('div', 'fact');
    const code = el('code', bad ? 'is-bad' : '', value);
    // The row is cut to fit, so the full value has to stay reachable somehow.
    ui(code, 'title', value);
    row.append(el('span', '', () => t(label)), code);
    return row;
  });
}

/**
 * Repaints only what ages: the two numbers and status tooltips. Runs every second so
 * "verified 8s ago" keeps counting between reports instead of freezing.
 */
function paintClock(): void {
  if (!state) return;
  const { status, bridge } = state;
  const running = isRunning(status.state);
  const connected = status.state === 'connected';
  const disconnecting = status.state === 'disconnecting';

  const handshake = $('bigHandshake');
  handshake.textContent = shortAgo(status.handshakeAt);
  handshake.className = connected ? '' : status.state === 'offline' ? 'is-bad' : 'is-cold';

  const request = $('bigRequest');
  request.textContent = shortAgo(status.lastRequestAt);
  request.className = status.lastRequestAt === null ? 'is-cold' : '';

  const core = status.surfaces.find((surface) => surface.id === 'core');
  ui($('connectionPopoverConnector'), 'textContent', () => disconnecting ? t('Disconnecting…') : !running
    ? t("Not connected")
    : core?.lastRequestAt
      ? t("Reached")
      : connected
        ? t("waiting")
        : t(STATUS_TEXT[status.state]));
  ui($('connectionPopoverBrowser'), 'textContent', () => bridge.present
    ? t("Connected")
    : bridge.paired ? t("Paired · not active") : t("Not connected"));

  const connectorRow = $('connectionPopoverConnector').parentElement!;
  const browserRow = $('connectionPopoverBrowser').parentElement!;
  connectorRow.dataset.tone = connected ? 'ok' : disconnecting || status.state === 'starting-server' || status.state === 'connecting-tunnel' ? 'wait' : 'bad';
  browserRow.dataset.tone = bridge.present ? 'ok' : bridge.paired ? 'wait' : 'bad';
  ui(connectorRow, 'title', () => core?.lastRequestAt ? t("Reached {0}", [ago(core.lastRequestAt)]) : $('connectionPopoverConnector').textContent ?? '');
  ui(browserRow, 'title', () => bridge.lastSeenAt ? t("Seen {0}", [ago(bridge.lastSeenAt)]) : $('connectionPopoverBrowser').textContent ?? '');
  ui($('connectionPopoverTitle'), 'title', () => disconnecting ? t('Closing connection…') : status.handshakeAt !== null ? t("verified {0}", [ago(status.handshakeAt)]) : t("no handshake yet"));

  const triggerText = status.handshakeAt !== null && running
    ? `${t(STATUS_TEXT[status.state])} · ${t("verified {0}", [ago(status.handshakeAt)])}`
    : t(STATUS_TEXT[status.state]);
  ui($('sidebarConnection'), 'aria-label', () => triggerText);
  ui($('sidebarConnection'), 'title', () => triggerText);
}

window.setInterval(paintClock, 1000);

function step(name: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-step="${name}"]`)!;
}

/** What each finished step proves, in the words Ready reads them back with. */
const READY_CHECKS: Record<string, { done: string; cos?: string }> = {
  browser: { done: 'Browser connected', cos: 'Signed in to ChatGPT' },
  folder: { done: 'Folder shared' },
  tunnel: { done: 'Tunnel created' },
  key: { done: 'API key stored' },
  connect: { done: 'Tunnel running' },
  chatgpt: { done: 'Plugin added in ChatGPT' }
};

/**
 * Ready: every check of the steps above, passed or not. All passing says so plainly and offers the
 * chat; anything still open is listed as a way back to its step, never as a failure.
 */
function paintReady(shown: string[], done: Set<string>, cosBrowser: boolean, allSet: boolean): void {
  ui($('readyTitle'), 'textContent', () => allSet ? t('You’re all set!') : t('Almost there'));
  ui($('readyLead'), 'textContent', () => allSet
    ? t('ChatGPT can now work in your folders. Ask it anything in a new chat.')
    : t('Finish the steps still open below.'));
  $('readyStart').hidden = !allSet;
  step('ready').classList.toggle('is-all-set', allSet);
  const list = $('readyChecks');
  const rows = shown.map(name => {
    const check = READY_CHECKS[name]!;
    const passed = done.has(name);
    const row = el('li', `ready-check${passed ? ' is-passed' : ''}`);
    const label = () => t(cosBrowser && check.cos ? check.cos : check.done);
    if (passed) {
      row.append(icon('i-check-circle'), el('span', '', label));
    } else {
      const go = el('button', 'ready-go');
      go.setAttribute('type', 'button');
      go.append(el('span', 'ready-pending', () => t('Step {0}', [shown.indexOf(name) + 1])), el('span', '', label), icon('i-arrow-right'));
      go.addEventListener('click', () => openSetupStep(name));
      row.append(go);
    }
    return row;
  });
  list.replaceChildren(...rows);
}

/** A connector's newest evidence that ChatGPT uses it: this run's, else what earlier runs proved. */
function withEvidence(surface: SurfaceStatus): SurfaceStatus {
  return {
    ...surface,
    lastRequestAt: surface.lastRequestAt ?? surface.proof?.requestAt ?? null,
    lastToolCallAt: surface.lastToolCallAt ?? surface.proof?.toolCallAt ?? null
  };
}

/** Whether this connector's plugin exists in ChatGPT: ChatGPT reached it, or ChatGPT listed it. */
function pluginCreated(surface: SurfaceStatus): boolean {
  return surface.lastRequestAt !== null || (surface.proof?.installedAt ?? null) !== null;
}

/** Shows Setup on one step, out of the finished summary if need be, and brings it into view. */
function openSetupStep(name: string): void {
  // Picking the first unfinished step is following progress, so the page moves on when it is done.
  setupOpenStep = step(name).classList.contains('is-current') ? null : name;
  if (state) apply(state);
  showTab('setup');
  document.querySelector('.setup-track')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Back and Next under each step, built once: every step moves the same way.
for (const body of document.querySelectorAll<HTMLElement>('#wizard > .step > .step-body')) {
  const nav = el('div', 'step-nav');
  // The label is its own span: a language switch rewrites only the words, never the arrow.
  const back = el('button', 'btn step-back');
  back.setAttribute('type', 'button');
  back.dataset.stepNav = 'back';
  back.append(icon('i-arrow-left'), el('span', '', () => t('Back')));
  const forward = el('button', 'btn step-next');
  forward.setAttribute('type', 'button');
  forward.dataset.stepNav = 'next';
  forward.append(el('span', '', () => t('Next')), icon('i-arrow-right'));
  nav.append(back, forward);
  if (body.closest<HTMLElement>('.step')?.dataset.step === 'browser') {
    nav.insertBefore($('browserBack'), forward);
  }
  body.append(nav);
}
document.querySelector('.setup-rail')!.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-rail-step]');
  if (button) openSetupStep(button.dataset.railStep!);
});
$('wizard').addEventListener('click', event => {
  const nav = (event.target as HTMLElement).closest<HTMLElement>('[data-step-nav]');
  if (!nav || setupOpen === null) return;
  const next = setupSteps[setupSteps.indexOf(setupOpen) + (nav.dataset.stepNav === 'next' ? 1 : -1)];
  if (next) openSetupStep(next);
});

/** Builds "text <strong>bold</strong> text" without touching innerHTML. */
function frag(before: string, bold: string, after: string): DocumentFragment {
  const f = document.createDocumentFragment();
  f.append(uiText(() => t(before)), el('strong', '', () => t(bold)), uiText(() => t(after)));
  return f;
}

// ------------------------------------------------------------------- log

/**
 * Anything the user might have to act on, counted so problems are never buried.
 *
 * Counted from the rows the feed still holds, not from everything that ever arrived.
 * The feed keeps 500 lines and drops the rest, so a running total drifted away from
 * what the Problems filter could actually show: "4 problems" above an empty list,
 * which reads as the filter being broken rather than as the rows having aged out.
 */
function paintProblems(): void {
  const problems = $('fullFeed').querySelectorAll('p.bad').length;
  for (const id of ['homeProblems', 'logProblems']) {
    const badge = $(id);
    badge.hidden = problems === 0;
    ui(badge, 'textContent', () => t(problems === 1 ? '{0} problem' : '{0} problems', [problems]));
  }
}

/**
 * Splits a log line into a short subject and the rest, so the eye can scan the left
 * column. "tunnel: no such host" and "request POST /mcp → 200" both work.
 */
function splitMessage(message: string): [string, string] {
  const colon = message.indexOf(': ');
  if (colon > 0 && colon <= 24) return [message.slice(0, colon), message.slice(colon + 2)];
  const space = message.indexOf(' ');
  if (space > 0 && space <= 24) return [message.slice(0, space), message.slice(space + 1)];
  return [message, ''];
}

function logRow(entry: LogEntry): HTMLElement {
  const [what, rest] = splitMessage(entry.message);
  const line = el('p', entry.level === 'info' ? '' : 'bad');
  if (entry.agent) line.dataset.agent = entry.agent;
  const time = document.createElement('time');
  // Bound like other copy, so lines already shown follow a language change instead of keeping
  // the old clock format next to new lines in the new one.
  ui(time, 'textContent', () => new Date(entry.time).toLocaleTimeString(currentLanguage()));
  line.append(time, el('span', 'what', what), el('span', 'rest', rest));
  return line;
}

const FEEDS = ['homeFeed', 'fullFeed'];

/**
 * Whether each feed is following the newest line.
 *
 * Remembered rather than measured on every append, because a feed inside a panel that is
 * not on screen has no geometry to measure: `clientHeight` and `scrollHeight` are both 0,
 * every arriving line looks like it was appended at the bottom, and the pin is written as
 * `scrollTop = 0`. That is exactly what the Activity panel did — every line of a session
 * arrived while Home was showing, so opening Activity landed on the oldest line in the
 * buffer and stayed there. A feed is pinned until the user scrolls it up themselves, and
 * scrolling back to the bottom re-pins it.
 */
const pinned = new Map<string, boolean>(FEEDS.map((id) => [id, true]));

function atBottom(view: HTMLElement): boolean {
  return view.scrollTop + view.clientHeight >= view.scrollHeight - 24;
}

/** Puts a feed back on its newest line. Safe on a hidden panel: it is re-applied on show. */
function stickToNewest(id: string): void {
  if (pinned.get(id) === false) return;
  const view = $(id);
  view.scrollTop = view.scrollHeight;
}

for (const id of FEEDS) {
  // Only a real user scroll may unpin. `scroll` also fires for the programmatic pin
  // above, which is harmless: that one always lands at the bottom and re-pins.
  $(id).addEventListener('scroll', () => {
    const view = $(id);
    // A hidden panel reports zeroes; never let that be read as "scrolled away".
    if (view.clientHeight === 0) return;
    pinned.set(id, atBottom(view));
  });
}

function addLogLine(entry: LogEntry): void {
  let evicted = false;
  for (const id of FEEDS) {
    const view = $(id);
    const row = logRow(entry);
    // Home always shows everything; only the Activity panel has the agent filter.
    if (id === 'fullFeed' && agentFilter !== null) row.hidden = entry.agent !== agentFilter;
    view.append(row);
    while (view.childElementCount > 500) {
      if (id === 'fullFeed' && view.firstElementChild?.classList.contains('bad')) evicted = true;
      view.firstElementChild?.remove();
    }
    stickToNewest(id);
  }
  // After the eviction above, so the badge counts what is there rather than what arrived.
  // A quiet run of 500 info lines retires old problems just as surely as a new one adds
  // to them, so both directions have to repaint.
  if (entry.level !== 'info' || evicted) paintProblems();
}

$('logFilter').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
  if (!button) return;
  for (const other of $('logFilter').querySelectorAll('button')) {
    other.classList.toggle('is-sel', other === button);
  }
  $('fullFeed').classList.toggle('only-bad', button.dataset.filter === 'bad');
  // Hiding most of the rows changes what "the bottom" is, so re-pin rather than leaving
  // the view parked at an offset that now belongs to a line the filter removed.
  stickToNewest('fullFeed');
});

/**
 * Agent filter for the Activity panel.
 *
 * Only exists while a swarm is running: with no workers there is nothing to separate,
 * and the plain single view is the one people already know. null means "All".
 */
let agentFilter: string | null = null;

function applyAgentFilter(): void {
  for (const row of $('fullFeed').querySelectorAll<HTMLElement>('p')) {
    row.hidden = agentFilter !== null && (row.dataset.agent ?? null) !== agentFilter;
  }
}

function paintAgentFilter(swarm: SwarmState): void {
  const box = $('logAgentFilter');
  if (!swarm.running) {
    box.hidden = true;
    box.replaceChildren();
    if (agentFilter !== null) {
      agentFilter = null;
      applyAgentFilter();
    }
    return;
  }
  // Prime first, then workers in creation order — the order the broker reports them.
  const choices: Array<{ id: string | null; label: string }> = [{ id: null, label: t("All") }];
  for (const agent of swarm.agents) choices.push({ id: agent.id, label: agent.label || agent.id });
  if (agentFilter !== null && !swarm.agents.some((agent) => agent.id === agentFilter)) {
    agentFilter = null;
  }
  box.replaceChildren(
    ...choices.map((choice) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = choice.label;
      button.classList.toggle('is-sel', choice.id === agentFilter);
      button.addEventListener('click', () => {
        agentFilter = choice.id;
        paintAgentFilter(swarm);
        applyAgentFilter();
      });
      return button;
    })
  );
  box.hidden = false;
  applyAgentFilter();
}

// --------------------------------------------------------------- wiring

async function addFolder(): Promise<void> {
  const next = await run(api.addRoot());
  if (next) apply(next);
}

/** Whether a drag carries files at all, which is the only kind the Folders card accepts. */
function dragHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/** Every dropped entry is offered as a folder; the main process says no to anything else. */
async function dropFolders(event: DragEvent): Promise<void> {
  const files = Array.from(event.dataTransfer?.files ?? []);
  for (const file of files) {
    const next = await run(api.addRootPath(file));
    if (next) apply(next);
  }
}

async function toggleConnection(): Promise<void> {
  if (!state || state.status.state === 'disconnecting') return;
  if (!isRunning(state.status.state) && !(await persistSetupDraftsForConnection())) {
    const missing = state ? missingStep(state) : null;
    // The wizard shows one step at a time: open the one that still needs the person.
    if (missing) openSetupStep(missing.step);
    return;
  }
  if (!state) return;
  // Mirrors the button label exactly, so a click always does what it says.
  const next = await run(isRunning(state.status.state) ? api.disconnect() : api.connect());
  if (next) apply(next);
}

/** Runs the main-process self-test and lists a line per link in the chain. */
async function runChecks(): Promise<void> {
  const button = $<HTMLButtonElement>('runChecks');
  button.disabled = true;
  ui($('runChecksLabel'), 'textContent', () => t("Checking…"));
  try {
    const result = await run(api.runDiagnostics());
    if (!result) return;
    ui($('checksSummary'), 'textContent', () => t(result.summary));
    $('checkList').replaceChildren(
      ...result.checks.map((check) => {
        const li = el(
          'li',
          check.status === 'pass'
            ? 'check is-ok'
            : check.status === 'fail'
              ? 'check is-bad'
              : `check is-${check.status}`
        );
        const mark = el(
          'span',
          'check-mark',
          check.status === 'pass' ? '✓' : check.status === 'fail' ? '!' : check.status === 'skipped' ? '–' : '…'
        );
        const body = el('div');
        body.append(el('strong', '', () => t(check.name)), el('p', '', () => t(check.detail)));
        li.append(mark, body);
        return li;
      })
    );
    $('checksBox').hidden = false;
    $('checksBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } finally {
    button.disabled = false;
    ui($('runChecksLabel'), 'textContent', () => t("Run checks"));
  }
}

$('runChecks').addEventListener('click', () => void runChecks());
$('requestDesktopAccessibility').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('requestDesktopAccessibility');
  button.disabled = true;
  try {
    const next = await run(api.requestDesktopAccessibility());
    if (next) apply(next);
  } finally {
    button.disabled = false;
  }
});
$('closeChecks').addEventListener('click', () => {
  $('checksBox').hidden = true;
});

$('readOnlyBtn').addEventListener('click', () => {
  if (!state) return;
  const current = requestedSettings?.readOnly ?? state.config.readOnly;
  void save({ readOnly: !current });
});

$('addFolder').addEventListener('click', () => void addFolder());
$('wizAddFolder').addEventListener('click', () => void addFolder());
$('wizManageFolders').addEventListener('click', () => {
  showTab('home');
  $('foldersCard').scrollIntoView({ block: 'nearest' });
  $('addFolder').focus({ preventScroll: true });
});

// Dropping a file anywhere on an Electron window otherwise navigates the whole window to
// it. The Folders card and chat attachment owner handle their own file drops; this fence
// prevents navigation for every remaining target.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
{
  const card = $('foldersCard');
  card.addEventListener('dragover', (event) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
    card.classList.add('drop-target');
  });
  card.addEventListener('dragleave', (event) => {
    if (!card.contains(event.relatedTarget as Node | null)) card.classList.remove('drop-target');
  });
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    card.classList.remove('drop-target');
    if (dragHasFiles(event)) void dropFolders(event);
  });
}

$('updateGet').addEventListener('click', () => void run(api.downloadUpdate()));

/**
 * Install the update that is already downloaded.
 *
 * The app quits to do it — that is the only moment an installer can replace files nothing is
 * holding open — so say so before it happens rather than leaving a window that vanishes on a
 * click looking like a crash. Both buttons are the same action; either can be the one pressed.
 */
function installUpdate(): void {
  toast(t("Installing the update. Chat On Steroids closes and starts again as the new version."));
  void run(api.installUpdate());
}

$('updateInstall').addEventListener('click', installUpdate);
$('installUpdate').addEventListener('click', installUpdate);
$('headerConnect').addEventListener('click', async () => {
  if (!state) return;
  if (missingStep(state)) { showTab('setup'); return; }
  if (isRunning(state.status.state)) {
    const disconnected = await run(api.disconnect()); if (!disconnected) return; apply(disconnected);
  }
  const connected = await run(api.connect()); if (connected) apply(connected);
});
$('connectionPopoverToggle').addEventListener('click', () => void toggleConnection());
$('wizConnect').addEventListener('click', () => void toggleConnection());
$('readyStart').addEventListener('click', () => showTab('chat'));
$('showCosBrowser').addEventListener('click', event => void run(
  (event.currentTarget as HTMLElement).dataset.signedIn === 'true' ? api.signOutChatGpt() : api.showCosBrowser()));
/** Setup's browser choice is the same save as choosing it in Settings, so both share one rule. */
function chooseChatBrowser(browser: ChatBrowser): void {
  const choice = $<HTMLSelectElement>('chatBrowser');
  if (choice.value === browser) return;
  choice.value = browser;
  choice.dispatchEvent(new Event('change', { bubbles: true }));
}
$('pickBinary').addEventListener('click', async () => {
  const next = await run(api.pickBinary());
  if (next) apply(next);
});


for (const id of ['copyLog', 'copyLogText']) {
  $(id).addEventListener('click', async () => {
    const text = await run(api.getLogText());
    if (text === null) return;
    const copied = await run(api.writeClipboard(text));
    if (copied) toast(t('Activity copied'));
  });
}

// One file for a bug report; the main process removes personal details and shows the saved file.
$('saveDiagnosticsReport').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('saveDiagnosticsReport');
  button.disabled = true;
  try {
    const result = await run(api.saveDiagnosticsReport());
    if (result?.saved) toast(t('Diagnostics report saved as {0}. Read it before you share it.', [result.name]));
  } finally {
    button.disabled = false;
  }
});

$('copyLogJson').addEventListener('click', async () => {
  const text = await run(api.getLogJson());
  if (text === null) return;
  const copied = await run(api.writeClipboard(text));
  if (copied) toast(t('Activity JSON copied'));
});

// The API key is written on blur so it is not saved keystroke by keystroke.
for (const id of ['tunnelId', 'apiKey']) $(id).addEventListener('input', paintSetupFields);
function storeSetupApiKeyDraft(): Promise<boolean> {
  const input = $<HTMLInputElement>('apiKey');
  const submitted = input.value;
  if (submitted === '') return Promise.resolve(true);
  const owner = state?.config.tunnel.profileId;
  setupKeySave = (async () => {
    const next = await run(api.setApiKey(submitted, owner));
    if (next) {
    // Do not erase a newer value typed while safeStorage/IPC was still resolving the previous
    // blur. On failure keep the submitted value too, so the user can retry instead of losing it.
      if (state?.config.tunnel.profileId === owner) {
        if (input.value === submitted) input.value = '';
        apply(next);
      }
      toast(t('API key stored'));
    }
    return next !== null;
  })();
  return setupKeySave;
}
$('apiKey').addEventListener('blur', () => { void storeSetupApiKeyDraft(); });

/**
 * Store the Tunnel ID and API key still typed into Setup before connecting. Blur and change are
 * conveniences; a Connect click must work without them.
 */
async function persistSetupDraftsForConnection(): Promise<boolean> {
  if (!state) return false;
  await settingsSaveQueue;
  if (!state) return false;
  if ($<HTMLInputElement>('tunnelId').value.trim() !== state.config.tunnel.tunnelId) await save();
  await settingsSaveQueue;
  if (!state || $<HTMLInputElement>('tunnelId').value.trim() !== state.config.tunnel.tunnelId) return false;
  // A blur right before the click may already own this write; drain it, then store a newer draft.
  await setupKeySave;
  if ($<HTMLInputElement>('apiKey').value !== '' && !(await storeSetupApiKeyDraft())) return false;
  await setupKeySave;
  return state !== null && missingStep(state) === null;
}

$('removeApiKey').addEventListener('click', async () => {
  const next = await run(api.setApiKey('', state?.config.tunnel.profileId));
  if (next) {
    apply(next);
    toast(t('API key removed'));
  }
});

for (const id of [
  'autoConnect',
  'startAtLogin',
  'minimizeToTray',
  'developerMode',
  'playfulStatus',
  'followOutput',
  'mentionCore',
  'controlApiEnabled',
  'controlApiAllowActions',
  'privacyScreenshots',
  'tunnelKind',
  'tunnelId',
  'desktopTunnelId',
  'connectorSuffix'
]) {
  $(id).addEventListener('change', () => void save());
}
$('connectorSuffix').addEventListener('input', () => { connectorSuffixValid(); });

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (!target.closest('.connection-anchor') && !$('connectionPopover').contains(target) && !$('connectionPopover').hidden) setConnectionPopover(false);
  const external = target.closest<HTMLElement>('[data-link-external]');
  if (external?.dataset.linkExternal) void run(api.openLink(external.dataset.linkExternal, { external: true }));
  const link = target.closest<HTMLElement>('[data-link]');
  if (link?.dataset.link) void run(api.openLink(link.dataset.link));
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || $('connectionPopover').hidden) return;
  setConnectionPopover(false);
  $('sidebarConnection').focus();
});

$('bridgeDownload').addEventListener('click', () => void run(api.downloadExtension()));
$('updateExtension').addEventListener('click', () => {
  step('browser').hidden = false;
  openSetupStep('browser');
});

api.onStateChanged(apply);
// Lines logged while the startup snapshot loads arrive live and are in the snapshot too. Hold
// them until it lands, so each shows once and after the lines that came before it.
let heldLogLines: LogEntry[] | null = [];
api.onLogEntry(entry => { if (heldLogLines) heldLogLines.push(entry); else addLogLine(entry); });
api.onSwarmChanged(paintAgentFilter);

async function refresh(): Promise<void> {
  const next = await run(api.getState());
  if (next) apply(next);
}

buildGroups();
initSidebarResize();
initUsage();
initPlugins(apply);
initPets(api, pet);
openSkillsLibrary = initSkillsLibrary(api);
initBrowserPreferences();
initChat({ save: () => save(), state: () => state });

void (async () => {
  await refresh();
  // A first run has nothing set up, so open on the wizard rather than an empty Home.
  showTab(state && missingStep(state)?.step === 'folder' ? 'setup' : 'chat');
  const entries = await run(api.getLog());
  const key = (entry: LogEntry): string => `${entry.time}\0${entry.level}\0${entry.agent ?? ''}\0${entry.message}`;
  const shown = new Map<string, number>();
  for (const entry of entries ?? []) { addLogLine(entry); shown.set(key(entry), (shown.get(key(entry)) ?? 0) + 1); }
  const held = heldLogLines ?? [];
  heldLogLines = null;
  for (const entry of held) {
    const left = shown.get(key(entry)) ?? 0;
    if (left > 0) shown.set(key(entry), left - 1); else addLogLine(entry);
  }
  const swarm = await run(api.getSwarm());
  if (swarm) paintAgentFilter(swarm);
})();
