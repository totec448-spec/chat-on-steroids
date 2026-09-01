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
import type { AppState, Capability, LogEntry, SurfaceStatus } from '../shared/types.js';
import {
  browserExtensionRequired,
  isNewer,
  RELEASES_PAGE,
  CAPABILITY_DETAILS,
  CAPABILITY_LABELS,
  CAPABILITY_TOOLS,
  DESKTOP_CAPABILITIES,
  WRITE_CAPABILITIES
} from '../shared/types.js';
import type { SwarmState } from '../shared/session.js';
import { $, ago, el, icon, run, shortAgo, toast } from './dom.js';
import { chatApply, chatSettingsPatch, chatVisible, initChat } from './chat.js';

declare global {
  interface Window {
    api: AppApi;
  }
}

const api = window.api;

/** Same shape the platform uses; mirrored here only to grey out step 2 until it is valid. */
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
    title: 'Look at files',
    icon: 'i-eye',
    blurb: 'Read and search inside the folders you approved.',
    caps: ['browse', 'search', 'read', 'metadata']
  },
  {
    id: 'write',
    title: 'Change files',
    icon: 'i-pencil',
    blurb: 'Create, edit, move and delete, inside those folders only.',
    caps: ['create', 'edit', 'move', 'deleteFile']
  },
  {
    id: 'desktop',
    title: 'See and use the desktop',
    icon: 'i-monitor',
    blurb: 'Screenshots, the list of open windows, and the mouse and keyboard.',
    caps: ['screen', 'control', 'clipboardRead', 'clipboardWrite']
  },
  {
    id: 'run',
    title: 'Run programs',
    icon: 'i-terminal',
    blurb: 'Start commands as you. The most powerful setting here.',
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
function applyValue(control: HTMLInputElement | HTMLSelectElement, next: string, previous?: string): void {
  const dirty = document.activeElement === control && previous !== undefined && control.value !== previous;
  if (!dirty) control.value = next;
}

function applyChecked(control: HTMLInputElement, next: boolean, previous?: boolean): void {
  const dirty = document.activeElement === control && previous !== undefined && control.checked !== previous;
  if (!dirty) control.checked = next;
}
/** The one expanded permission group, or null. One at a time keeps the layout still. */
let openGroup: string | null = null;
/** Whether the finished setup steps are unfolded again. Reset on every app start. */
let showAllSteps = false;

// ------------------------------------------------------------------- tabs

function showTab(name: string): void {
  for (const tab of document.querySelectorAll<HTMLElement>('nav button')) {
    tab.classList.toggle('is-sel', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
    panel.classList.toggle('is-active', panel.dataset.panel === name);
  }
  // The Chat panel is the only one that costs anything to keep fresh, so it only
  // reloads while it is on screen.
  chatVisible(name === 'chat');
  // A feed that was appended to while its panel was hidden could not be scrolled then —
  // a hidden element has no scroll height. Pin it now that it has one, so a panel always
  // opens on the newest line rather than on whatever was oldest in the buffer.
  for (const id of FEEDS) stickToNewest(id);
}

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
  text.append(el('b', '', title), el('em', 'group-count'));
  main.append(icon('i-chev', 'ico chev'), icon(iconId), text);
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
 * CAPABILITY_TOOLS, so a renamed tool is renamed once.
 */
function toolNames(names: readonly string[]): HTMLElement {
  const row = el('div', 'tool-names');
  for (const name of names) row.append(el('code', '', name));
  return row;
}

function buildGroups(): void {
  const permissionGroups = GROUPS.map((group) => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'group-box';
    box.title = `Turn everything in "${group.title}" on or off`;
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
      body.append(el('strong', '', CAPABILITY_LABELS[cap]), el('em', '', CAPABILITY_DETAILS[cap]));
      label.append(input, body);
      tools.append(label);
    }
    tools.append(toolNames([...new Set(group.caps.flatMap((cap) => CAPABILITY_TOOLS[cap]))]));

    root.append(tools);
    return root;
  });

  // Recording and sub-agents are tool surfaces exactly like the file and desktop
  // permissions — `session` and `agents` are two of the nine tools ChatGPT can discover —
  // and they used to be checkboxes buried in a settings pane behind a gear. Every switch
  // that decides what ChatGPT can reach now lives in this one list. Chat settings keeps
  // only the numbers that tune them.
  const record = document.createElement('input');
  record.type = 'checkbox';
  record.id = 'sessRecord';
  record.title = 'Record this chat locally, and expose the session tool in ChatGPT';
  record.addEventListener('change', () => void save());
  const recording = groupShell('recording', 'Session recording', 'i-steps', record);
  const recordTools = el('div', 'tools');
  for (const [name, detail] of [
    ['search', 'List recent recordings or find past and concurrent work by text.'],
    ['read', 'Read one explicit recording, continue it, or expand one short T… tool reference.']
  ] as Array<[string, string]>) {
    const row = el('div', 'tool is-static');
    const body = el('span');
    body.append(el('strong', '', name), el('em', '', detail));
    row.append(body);
    recordTools.append(row);
  }
  recordTools.append(toolNames(['session']));
  recording.append(recordTools);

  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.id = 'homeMaEnabled';
  enabled.title = 'Expose or hide the sub-agent tools in ChatGPT';
  // The only multi-agent exposure control there is. Chat settings used to carry a second
  // checkbox for the same flag, which this one had to mirror by hand.
  enabled.addEventListener('change', () => void save());
  const agents = groupShell('agents', 'Sub-agents', 'i-bolt', enabled);

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
    body.append(el('strong', '', name), el('em', '', detail));
    row.append(body);
    tools.append(row);
  }
  tools.append(toolNames(['agents']));
  agents.append(tools);

  $('groups').replaceChildren(...permissionGroups, recording, agents);
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
    const supported = group.id !== 'desktop' || desktopSupported;
    root.hidden = !supported;
    if (!supported) {
      for (const cap of group.caps) capInput(cap).disabled = true;
      continue;
    }
    root.classList.toggle('is-open', openGroup === group.id);

    const usable = group.caps.filter((cap) => !(readOnly && WRITE_CAPABILITIES.includes(cap)));
    const on = group.caps.filter((cap) => capInput(cap).checked);

    const box = root.querySelector<HTMLInputElement>('.group-box')!;
    box.checked = usable.length > 0 && usable.every((cap) => capInput(cap).checked);
    box.indeterminate = !box.checked && on.length > 0;
    box.disabled = usable.length === 0;

    root.querySelector<HTMLElement>('.group-count')!.textContent =
      usable.length === 0
        ? 'off in read-only mode'
        : on.length === 0
          ? 'off'
          : on.length === group.caps.length
            ? `${on.length} permission${on.length === 1 ? '' : 's'}`
            : `${on.length} of ${group.caps.length} permissions`;

    root.classList.toggle('is-on', on.length > 0);
    root.classList.toggle('is-locked', usable.length === 0);
  }

  for (const cap of WRITE_CAPABILITIES) capInput(cap).disabled = readOnly;

  // The two feature groups. apply() already passed both switches through the
  // focused/dirty-field guard. Recopying state here undid that protection and visibly
  // flipped a user's just-clicked toggle back when an unsolicited stale state push
  // arrived before save completed, so this only reads them.
  for (const [id, onText] of [
    ['recording', 'session tool exposed'],
    ['agents', 'agents tool exposed']
  ] as Array<[string, string]>) {
    const root = document.querySelector<HTMLElement>(`[data-group="${id}"]`);
    if (!root) continue;
    const box = root.querySelector<HTMLInputElement>('.sw input')!;
    root.classList.toggle('is-open', openGroup === id);
    root.classList.toggle('is-on', box.checked);
    root.querySelector<HTMLElement>('.group-count')!.textContent = box.checked ? onText : 'off';
  }
}

/**
 * How many MCP tools ChatGPT can currently discover, across both connectors.
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

function save(over: { readOnly?: boolean; theme?: 'light' | 'dark' } = {}): Promise<void> {
  if (applying || !state) return Promise.resolve();

  const previous: AppState['config'] = requestedSettings
    ? { ...state.config, ...requestedSettings }
    : state.config;
  const capabilities = { ...previous.capabilities };
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) {
    const capability = input.dataset.cap as Capability;
    // The macOS/Linux port deliberately hides Desktop automation while preserving any
    // Windows choices stored in this config. A hidden disabled checkbox is presentation,
    // not a user edit: copying its forced-false value into every unrelated settings save
    // would erase those choices merely because the config was opened on another OS.
    if (!(state.platform?.desktopAutomation ?? true) && DESKTOP_CAPABILITIES.includes(capability)) continue;
    capabilities[capability] = input.checked;
  }
  const readOnly = over.readOnly ?? previous.readOnly;
  const chatPatch = chatSettingsPatch(previous);
  const patch: SettingsPatch = {
    capabilities,
    readOnly,
    tunnel: {
      kind: $<HTMLSelectElement>('tunnelKind').value as 'openai' | 'cloudflared' | 'manual',
      tunnelId: $<HTMLInputElement>('tunnelId').value.trim(),
      desktopTunnelId: $<HTMLInputElement>('desktopTunnelId').value.trim(),
      binaryPath: $<HTMLInputElement>('binaryPath').value.trim()
    },
    ui: {
      autoConnect: $<HTMLInputElement>('autoConnect').checked,
      minimizeToTray: $<HTMLInputElement>('minimizeToTray').checked,
      privacyScreenshots: $<HTMLInputElement>('privacyScreenshots').checked,
      theme: over.theme ?? previous.ui.theme
    },
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
    previous.sessions.record !== patch.sessions.record ||
    previous.multiAgent.enabled !== patch.multiAgent.enabled ||
    (Object.keys(patch.capabilities) as Capability[]).some((cap) => {
      const before = previous.capabilities[cap] && !(previous.readOnly && WRITE_CAPABILITIES.includes(cap));
      const after = patch.capabilities[cap] && !(patch.readOnly && WRITE_CAPABILITIES.includes(cap));
      return before !== after;
    });
  const base: SettingsPatch = {
    capabilities: previous.capabilities,
    readOnly: previous.readOnly,
    tunnel: previous.tunnel,
    ui: previous.ui,
    sessions: previous.sessions,
    compaction: previous.compaction,
    multiAgent: previous.multiAgent,
    goal: previous.goal
  };
  const next = await run(api.saveSettings(patch, base));
  if (next) {
    apply(next);
    if (previous.multiAgent.enabled && !patch.multiAgent.enabled) {
      // A cached snapshot keeps offering the `agents` tool until the connector is
      // reloaded. Say so plainly rather than letting it look sticky.
      toast('Multi-agent off. Reconnect the connector in ChatGPT (then start a new chat) to drop the agents tool.');
    } else if (toolSurfaceChanged) {
      toast('Tools changed. Start a new ChatGPT conversation to guarantee the new tool list is loaded.');
    }
  } else await refresh();
  // Do not erase the desired state of a newer queued save when an older one completes.
  if (requestedSettings === patch) requestedSettings = null;
}

// ---------------------------------------------------------------- helpers

const STATUS_TEXT: Record<AppState['status']['state'], string> = {
  disconnected: 'Not connected',
  'starting-server': 'Starting',
  'connecting-tunnel': 'Connecting',
  connected: 'Connected',
  offline: 'No internet',
  'auth-failed': 'Sign-in failed',
  'tunnel-unavailable': 'Tunnel unavailable'
};

const METHOD_HINT: Record<string, string> = {
  openai:
    'ChatGPT reaches this computer through an OpenAI tunnel. Nothing is exposed to the open internet.',
  cloudflared:
    'Creates a temporary public https address with Cloudflare. The address changes on every restart.',
  manual: 'This app only listens on localhost. You are responsible for exposing it.'
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

/** What still has to happen before connecting can work, in the order of the wizard. */
function missingStep(next: AppState): { step: string; text: string } | null {
  const { config } = next;
  // This is the same capability rule as the main-process admission gate. Desktop and
  // clipboard may legitimately be rootless; enabling one must not hide a root still needed
  // by an effective file/patch/command capability on Core.
  if (config.roots.length === 0 && requiresApprovedFilesystemRoot(config)) {
    return { step: 'folder', text: 'Choose a folder to share — step 1.' };
  }
  if (config.tunnel.kind === 'openai') {
    if (!TUNNEL_ID_PATTERN.test(config.tunnel.tunnelId)) {
      return { step: 'tunnel', text: 'Create a tunnel and paste its ID — step 2.' };
    }
    if (!(next.secureStorage?.available ?? true) && !next.hasApiKey) {
      return { step: 'key', text: next.secureStorage?.detail ?? 'Secure credential storage is unavailable.' };
    }
    if (!next.hasApiKey) {
      return { step: 'key', text: 'Add a restricted API key — step 3.' };
    }
  } else if (!next.resolvedBinary && config.tunnel.kind === 'cloudflared') {
    return { step: 'connect', text: 'cloudflared was not found on this computer.' };
  }
  return null;
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
    input.setAttribute('aria-label', `Rename /${root.name}`);
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
  rename.title = `Rename /${root.name}`;
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
  remove.title = `Stop sharing /${root.name}`;
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
 * the version of the extension the bridge is talking to. An extension that is not present has
 * no version worth reporting - a stale number from a browser that has since closed would nag
 * about nothing.
 *
 * Null is the one silence that is not an answer: GitHub has not replied yet in this run, so
 * "up to date" would be a claim nobody has checked. That is what `checkedAt` is for.
 *
 * `notice` is the narrower question of whether the header bar carries the sentence at all. That
 * bar is for what the user can act on - a version to fetch by hand, an extension to reload -
 * while the Activity line reports every state, including the good one.
 */
function updateSummary({ bridge, update }: AppState): { text: string; tone: UpdateTone; notice: boolean } | null {
  // Only an extension older than this app is the user's to fix. The other direction is an app
  // that has not caught up yet - normal while an update downloads - and telling that user to
  // load the bundled folder again would talk them into downgrading a working extension. The
  // app sentence already owns being behind.
  const stale =
    bridge.present && bridge.extensionVersion && isNewer(update.current, bridge.extensionVersion)
      ? bridge.extensionVersion
      : null;
  if (!stale && !update.latest && update.stage === 'idle' && !update.checkedAt) return null;

  const lines: string[] = [];
  let tone: UpdateTone = 'work';
  if (update.latest) {
    // `latest` set with a stage of `idle` is the deliberate case: a new version exists and this
    // installation - a Linux .deb, macOS, a development tree, an architecture with no artifact -
    // is not one the app can update by itself. That is when the button matters.
    lines.push(
      update.stage === 'ready'
        ? `Chat On Steroids ${update.latest} is downloaded and installs the next time you start the app.`
        : update.stage === 'downloading'
          ? `Chat On Steroids ${update.latest} is downloading. Keep working; it installs on your next start.`
          : update.stage === 'failed'
            ? `Chat On Steroids ${update.latest} could not be downloaded: ${update.error ?? 'the download stopped'}.`
            : `Chat On Steroids ${update.latest} is out. This installation has to be updated by hand.`
    );
    if (update.stage === 'failed') tone = 'bad';
  } else if (update.stage === 'failed') {
    lines.push(`Could not check for a newer version: ${update.error ?? 'the check stopped'}.`);
    tone = 'bad';
  } else if (update.stage === 'checking') {
    lines.push('Checking for a newer version…');
  } else if (!stale) {
    const extension = bridge.present && bridge.extensionVersion ? ` · extension ${bridge.extensionVersion}` : '';
    lines.push(`Up to date! Chat On Steroids ${update.current}${extension}`);
    tone = 'ok';
  }
  if (stale) {
    lines.push(
      `The browser extension is ${stale} and this app is ${update.current}. ` +
        'Load the extension folder again in Chrome.'
    );
    tone = 'bad';
  }
  return { text: lines.join(' '), tone, notice: Boolean(update.latest || stale) };
}

/** The header bar, the Activity line and the one notification, from that single sentence. */
function paintUpdate(next: AppState): void {
  const summary = updateSummary(next);
  const notice = $('updateNotice');
  const line = $('updateLine');
  if (!summary) {
    notice.hidden = true;
    line.hidden = true;
    return;
  }
  const { update } = next;
  $('updateText').textContent = summary.text;
  $<HTMLButtonElement>('updateGet').hidden = !update.latest || update.stage === 'downloading' || update.stage === 'ready';
  notice.hidden = !summary.notice;
  line.textContent = summary.text;
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

function apply(next: AppState): void {
  const previousState = state;
  state = next;
  applying = true;
  const { config, status } = next;

  const connected = status.state === 'connected';
  const offline = status.state === 'offline';
  const busy = status.state === 'starting-server' || status.state === 'connecting-tunnel';
  const failed = status.state === 'auth-failed' || status.state === 'tunnel-unavailable';
  const running = isRunning(status.state);
  const missing = missingStep(next);

  // ---- theme
  const dark = config.ui.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('themeIcon').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('themeBtn').title = dark ? 'Switch to light mode' : 'Switch to dark mode';

  // ---- header
  const live = $('live');
  live.className = `live${
    connected ? ' is-connected' : offline ? ' is-offline' : busy ? ' is-busy' : failed ? ' is-error' : ''
  }`;
  $('liveState').textContent = STATUS_TEXT[status.state];

  const id = config.tunnel.tunnelId;
  $('headerSub').textContent =
    config.tunnel.kind === 'openai'
      ? TUNNEL_ID_PATTERN.test(id)
        ? `${id.slice(0, 11)}…${id.slice(-4)}`
        : 'No tunnel yet'
      : (status.publicUrl ?? status.localUrl ?? config.tunnel.kind);

  const connectBtn = $<HTMLButtonElement>('connectBtn');
  connectBtn.classList.toggle('is-running', running);
  $('connectLabel').textContent = running ? 'Disconnect' : 'Connect';
  connectBtn.disabled = !running && missing !== null;
  connectBtn.title = !running && missing ? missing.text : '';

  // ---- out of date, app or extension
  paintUpdate(next);

  // ---- health numbers and facts
  paintClock();
  $('facts').replaceChildren(...facts(next));

  // ---- permissions
  $('readOnlyBtn').classList.toggle('is-on', config.readOnly);
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) {
    const cap = input.dataset.cap as Capability;
    const supported = (next.platform?.desktopAutomation ?? true) || !DESKTOP_CAPABILITIES.includes(cap);
    applyChecked(input, supported && config.capabilities[cap], previousState?.config.capabilities[cap]);
  }
  applyChecked(
    $<HTMLInputElement>('homeMaEnabled'),
    config.multiAgent.enabled,
    previousState?.config.multiAgent.enabled
  );
  // Recording is a tool switch like the rest of this list, so it goes through the same
  // dirty-field guard rather than being assigned outright from the Chat panel.
  applyChecked(
    $<HTMLInputElement>('sessRecord'),
    config.sessions.record,
    previousState?.config.sessions.record
  );
  paintGroups();

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
  $('methodHint').textContent = METHOD_HINT[config.tunnel.kind] ?? '';
  applyValue($<HTMLInputElement>('tunnelId'), config.tunnel.tunnelId, previousState?.config.tunnel.tunnelId);
  applyValue(
    $<HTMLInputElement>('desktopTunnelId'),
    config.tunnel.desktopTunnelId,
    previousState?.config.tunnel.desktopTunnelId
  );
  applyValue($<HTMLInputElement>('binaryPath'), config.tunnel.binaryPath, previousState?.config.tunnel.binaryPath);
  applyChecked($<HTMLInputElement>('autoConnect'), config.ui.autoConnect, previousState?.config.ui.autoConnect);
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
    $('backgroundRunningCopy').textContent =
      'Leave it running while you use the connector. It stays available from the menu bar and Dock when you close the window.';
    $('minimizeToTrayCopy').textContent = 'Hide the window to the menu bar when closed';
  } else {
    $('backgroundRunningCopy').textContent =
      'Leave it running while you use the connector. It stays in the tray when you close the window.';
    $('minimizeToTrayCopy').textContent = 'Keep running in the tray when closed';
  }

  const openai = config.tunnel.kind === 'openai';
  const browserRequired = browserExtensionRequired(config);
  step('tunnel').hidden = !openai;
  step('key').hidden = !openai;
  step('browser').hidden = !browserRequired;
  // Only this method needs a tunnel per connector. Cloudflare and manual publish the
  // whole address, so both connectors already ride the one tunnel on their own paths.
  const desktopSurface = status.surfaces.find((surface) => surface.id === 'desktop');
  $('desktopTunnelField').hidden = !openai || !desktopSurface?.available;

  $('wizFolders').textContent =
    config.roots.length === 0 ? 'None yet' : config.roots.map((r) => `/${r.name}`).join('  ');
  const secureStorageAvailable = next.secureStorage?.available ?? true;
  const apiKey = $<HTMLInputElement>('apiKey');
  apiKey.placeholder = next.hasApiKey ? '•••••••• stored' : 'sk-…';
  apiKey.disabled = !secureStorageAvailable;
  $('apiKeyState').textContent = !secureStorageAvailable
    ? (next.secureStorage?.detail ?? 'Secure credential storage is unavailable.')
    : next.hasApiKey
      ? 'A key is stored with secure OS credential storage. Type a new one to replace it, or use Remove stored API key.'
      : 'Stored with secure OS credential storage. It is never shown again and never leaves this app.';
  $('apiKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('removeApiKey').disabled = !next.hasApiKey || !secureStorageAvailable;

  const wizConnect = $<HTMLButtonElement>('wizConnect');
  wizConnect.textContent = running ? 'Disconnect' : 'Connect';
  wizConnect.disabled = connectBtn.disabled;
  $('wizStatus').textContent = running || failed ? status.detail || STATUS_TEXT[status.state] : '';

  $('chatgptConn').replaceChildren(
    openai
      ? frag('For the connection, choose ', 'Tunnel', ' and pick the tunnel you made in step 2.')
      : frag('For the connection, paste the URL below into ', 'MCP server URL', '.')
  );

  // Says plainly whether the connector has ever reached this app, because a
  // FORBIDDEN inside one ChatGPT conversation is not the same as a broken setup.
  // The middle case is the one that costs hours: ChatGPT connects and reads the tool
  // list, but the model is never allowed to call anything — Developer mode is off.
  // Every connector this app is publishing that ChatGPT has never reached. Computed here
  // because it decides three things at once: the summary line, whether step 5 counts as
  // done, and whether the cards stay on screen after the wizard tidies itself away.
  const unverified = status.surfaces.filter((surface) => surface.available && surface.lastRequestAt === null);
  const chatgptNote = $('wizChatgpt');
  chatgptNote.classList.toggle(
    'is-warn',
    status.lastRequestAt !== null && (status.lastToolCallAt === null || unverified.length > 0)
  );
  chatgptNote.textContent =
    status.lastRequestAt === null
      ? 'ChatGPT has not called this app yet.'
      : status.lastToolCallAt === null
        ? `ChatGPT connected ${ago(status.lastRequestAt)} but has never run a tool. If it says “does not support developer MCPs”, switch Developer mode back on in ChatGPT → Settings → Apps & Connectors → Advanced.`
        : unverified.length > 0
          ? // One connector working is not the whole setup. Naming the missing one is the
            // difference between "something is off" and knowing what to go and create.
            `ChatGPT ran a tool ${ago(status.lastToolCallAt)}, but ${unverified
              .map((surface) => `“${surface.connectorName}”`)
              .join(' and ')} has never been called — create it in ChatGPT to use it.`
          : `ChatGPT ran a tool ${ago(status.lastToolCallAt)} — the whole chain works.`;

  const cards = $('connectorCards');
  // A connector the user has switched on but never created in ChatGPT is unfinished setup,
  // so its card must survive the tidy collapse instead of disappearing behind "Show all
  // steps" — otherwise a half-done Desktop setup reads as a complete one.
  cards.classList.toggle('has-unfinished', unverified.length > 0);
  cards.replaceChildren(...connectorCards(next));

  // Step marks: everything before the first unfinished step counts as done.
  const order = ['folder', 'tunnel', 'key', 'connect', 'chatgpt', 'browser'];
  const done = new Set<string>();
  if (config.roots.length > 0 || missingStep(next)?.step !== 'folder') done.add('folder');
  if (!openai || TUNNEL_ID_PATTERN.test(config.tunnel.tunnelId)) done.add('tunnel');
  if (!openai || next.hasApiKey) done.add('key');
  if (connected) done.add('connect');
  // The only honest proof step 5 is finished: ChatGPT has actually called the connectors
  // this app cannot work without. Judged per surface, because a Core request says nothing
  // about whether the Desktop connector was ever created. An optional connector never
  // blocks completion — a user may enable clipboard access and still not want a second
  // connector — but it is reported separately below rather than quietly counted as done.
  const requiredUnverified = status.surfaces.some(
    (surface) => surface.available && !surface.optional && surface.lastRequestAt === null
  );
  if (status.lastRequestAt !== null && !requiredUnverified) done.add('chatgpt');
  // Pairing is durable authorization, not liveness. A token surviving an app restart says
  // only that this extension is allowed to connect; setup is complete when a required browser
  // has actually checked in during this process. If no enabled feature needs the browser,
  // this optional step is hidden and deliberately cannot block the wizard.
  if (!browserRequired || next.bridge.present) done.add('browser');
  const current = order.find((name) => !done.has(name)) ?? null;
  for (const name of order) {
    const node = step(name);
    node.classList.toggle('is-done', done.has(name));
    node.classList.toggle('is-current', name === current);
  }

  // Setup that is finished should stop reading like a to-do list: the instructions
  // collapse away so the page fits without scrolling, and come back on request.
  const allDone = current === null;
  $('wizard').classList.toggle('is-tidy', allDone && !showAllSteps);
  const expand = $<HTMLButtonElement>('wizExpand');
  expand.hidden = !allDone;
  expand.textContent = showAllSteps ? 'Hide finished steps' : 'Show all steps';

  const needsBinary = config.tunnel.kind !== 'manual';
  $('binaryState').textContent = !needsBinary
    ? 'Not needed for this method.'
    : next.resolvedBinary
      ? `Using ${next.resolvedBinary}`
      : 'Not found. Install it, or choose the file with Browse.';
  $('versionLine').textContent = next.bundledTunnelVersion
    ? `Recent activity only — no file contents, no credentials. Bundled tunnel-client ${next.bundledTunnelVersion}.`
    : 'Recent activity only. File contents and credentials are never recorded.';

  chatApply(next, previousState?.config);

  applying = false;
}

const SURFACE_STATE_TEXT: Record<SurfaceStatus['state'], string> = {
  off: 'Not published',
  starting: 'Connecting…',
  live: 'Published',
  error: 'Problem'
};

/** One copyable value with its own button, so nothing has to be retyped by hand. */
function copyRow(label: string, value: string, what: string): HTMLElement {
  const field = el('div', 'field');
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.spellcheck = false;
  input.value = value;
  const button = el('button', 'btn btn-solid');
  (button as HTMLButtonElement).type = 'button';
  button.append(icon('i-copy'), document.createTextNode('Copy'));
  button.addEventListener('click', async () => {
    const copied = await run(api.writeClipboard(value));
    if (copied) toast(`${what} copied`);
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
    .filter((surface) => surface.id !== 'desktop' || (next.platform?.desktopAutomation ?? true))
    .map((surface) => {
    const card = el('div', `connector is-${surface.state}`);

    const head = el('div', 'connector-head');
    head.append(
      el('h4', '', surface.connectorName),
      el('span', 'tag', surface.optional ? 'optional' : 'required'),
      el('span', `pill is-${surface.state}`, SURFACE_STATE_TEXT[surface.state])
    );
    card.append(head, el('p', 'hint', surface.cardSummary));

    if (!surface.available) {
      card.append(el('p', 'hint', surface.detail));
      return card;
    }

    card.append(copyRow('Name', surface.connectorName, 'Name'));
    card.append(copyRow('Description', surface.description, 'Description'));

    // On the OpenAI method the connector is picked from a list of tunnels instead of
    // pasted as a URL, so showing a loopback address there would only mislead.
    const url =
      surface.publicUrl ?? (config.tunnel.kind === 'manual' ? surface.localUrl : null);
    if (url) {
      card.append(copyRow('MCP server URL', url, 'URL'));
      card.append(
        el('p', 'hint', 'Anyone with this URL can use your enabled tools. Do not share it.')
      );
    } else if (config.tunnel.kind === 'openai') {
      card.append(
        el(
          'p',
          'hint',
          surface.id === 'desktop' && !config.tunnel.desktopTunnelId
            ? 'Pick this connector’s own tunnel — paste its ID in step 2 first.'
            : 'Choose Tunnel, then pick this connector’s tunnel.'
        )
      );
    }

    if (surface.detail && surface.state === 'error') card.append(el('p', 'hint is-warn', surface.detail));

    // Published is only half the story. "Live" says this app is serving the connector;
    // it says nothing about whether the user ever created it in ChatGPT, and with two
    // connectors a single app-wide "ChatGPT called us" line cannot tell them apart.
    if (surface.state === 'live') {
      card.append(
        surface.lastRequestAt === null
          ? el('p', 'hint is-warn', 'Not created in ChatGPT yet — ChatGPT has never called this connector.')
          : el(
              'p',
              'hint',
              surface.lastToolCallAt === null
                ? `ChatGPT connected ${ago(surface.lastRequestAt)} but has not run one of its tools yet.`
                : `ChatGPT ran one of its tools ${ago(surface.lastToolCallAt)}.`
            )
      );
    }

    if (surface.tools.length > 0) {
      card.append(el('p', 'hint', `Tools: ${surface.tools.join(', ')}`));
    }
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
  const rows: [string, string, boolean?][] = [];
  const health = status.health;

  if (isRunning(status.state)) {
    rows.push(['Route to OpenAI', health?.route ?? 'starting…']);
    rows.push([
      'Poll errors',
      health?.pollErrors === null || health?.pollErrors === undefined
        ? '—'
        : String(health.pollErrors),
      (health?.pollErrors ?? 0) > 0
    ]);
    const probe = health?.probe ?? null;
    rows.push([
      'Tunnel → this app',
      probe ?? 'checking…',
      probe !== null && probe !== 'ok' && probe !== 'success' && probe !== 'healthy'
    ]);
    rows.push(['Tunnel uptime', duration(health?.uptimeSeconds ?? null)]);
    // Requests but no tool call is what an account with Developer mode switched off
    // looks like from here, and it is invisible in every other number on this card.
    if (status.lastRequestAt !== null) {
      rows.push([
        'ChatGPT ran a tool',
        status.lastToolCallAt === null ? 'never — check Developer mode' : ago(status.lastToolCallAt),
        status.lastToolCallAt === null
      ]);
    }
    if (health?.clientVersion) rows.push(['Tunnel client', health.clientVersion]);
    if (status.localUrl) rows.push(['Local server', status.localUrl.replace(/^https?:\/\//, '')]);
  } else {
    rows.push(['Route to OpenAI', 'not running']);
  }

  rows.push([
    'Tools ChatGPT can see',
    `${toolsOn(next)} available · ${config.roots.length} folder${config.roots.length === 1 ? '' : 's'}`
  ]);

  return rows.map(([label, value, bad]) => {
    const row = el('div', 'fact');
    const code = el('code', bad ? 'is-bad' : '', value);
    // The row is cut to fit, so the full value has to stay reachable somehow.
    code.title = value;
    row.append(el('span', '', label), code);
    return row;
  });
}

/**
 * Repaints only what ages: the two numbers and the header note. Runs every second so
 * "verified 8s ago" keeps counting between reports instead of freezing.
 */
function paintClock(): void {
  if (!state) return;
  const { status } = state;
  const running = isRunning(status.state);
  const connected = status.state === 'connected';

  const handshake = $('bigHandshake');
  handshake.textContent = shortAgo(status.handshakeAt);
  handshake.className = connected ? '' : status.state === 'offline' ? 'is-bad' : 'is-cold';

  const request = $('bigRequest');
  request.textContent = shortAgo(status.lastRequestAt);
  request.className = status.lastRequestAt === null ? 'is-cold' : '';

  $('liveNote').textContent = running
    ? status.handshakeAt === null
      ? 'no handshake yet'
      : `verified ${ago(status.handshakeAt)}`
    : '';
}

window.setInterval(paintClock, 1000);

function step(name: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-step="${name}"]`)!;
}

/** Builds "text <strong>bold</strong> text" without touching innerHTML. */
function frag(before: string, bold: string, after: string): DocumentFragment {
  const f = document.createDocumentFragment();
  f.append(before, el('strong', '', bold), after);
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
    badge.textContent = `${problems} problem${problems === 1 ? '' : 's'}`;
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
  time.textContent = new Date(entry.time).toLocaleTimeString();
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
  const choices: Array<{ id: string | null; label: string }> = [{ id: null, label: 'All' }];
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
  if (!state) return;
  // Mirrors the button label exactly, so a click always does what it says.
  const next = await run(isRunning(state.status.state) ? api.disconnect() : api.connect());
  if (next) apply(next);
}

/** Runs the main-process self-test and lists a line per link in the chain. */
async function runChecks(): Promise<void> {
  const button = $<HTMLButtonElement>('runChecks');
  button.disabled = true;
  $('runChecksLabel').textContent = 'Checking…';
  try {
    const result = await run(api.runDiagnostics());
    if (!result) return;
    $('checksSummary').textContent = result.summary;
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
        body.append(el('strong', '', check.name), el('p', '', check.detail));
        li.append(mark, body);
        return li;
      })
    );
    $('checksBox').hidden = false;
    $('checksBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } finally {
    button.disabled = false;
    $('runChecksLabel').textContent = 'Run checks';
  }
}

$('runChecks').addEventListener('click', () => void runChecks());
$('closeChecks').addEventListener('click', () => {
  $('checksBox').hidden = true;
});

$('themeBtn').addEventListener('click', () => {
  if (!state) return;
  // A save can still be waiting on main-process lifecycle work. Toggle from the latest
  // requested value, not merely the last acknowledged state, or two quick clicks both choose
  // the same target and behave like one click.
  const current = requestedSettings?.ui.theme ?? state.config.ui.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  // Applied immediately so the click feels instant; the save confirms it.
  document.documentElement.dataset.theme = next;
  void save({ theme: next });
});

$('readOnlyBtn').addEventListener('click', () => {
  if (!state) return;
  const current = requestedSettings?.readOnly ?? state.config.readOnly;
  void save({ readOnly: !current });
});

$('addFolder').addEventListener('click', () => void addFolder());
$('wizAddFolder').addEventListener('click', () => void addFolder());

// Dropping a file anywhere on an Electron window otherwise navigates the whole window to
// it. Only the Folders card accepts drops, and everything else swallows them.
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

$('wizExpand').addEventListener('click', () => {
  showAllSteps = !showAllSteps;
  if (state) apply(state);
});
$('updateGet').addEventListener('click', () => void run(api.openLink(RELEASES_PAGE)));
$('connectBtn').addEventListener('click', () => void toggleConnection());
$('wizConnect').addEventListener('click', () => void toggleConnection());

$('pickBinary').addEventListener('click', async () => {
  const next = await run(api.pickBinary());
  if (next) apply(next);
});


for (const id of ['copyLog', 'copyLogText']) {
  $(id).addEventListener('click', async () => {
    const text = await run(api.getLogText());
    if (text === null) return;
    const copied = await run(api.writeClipboard(text));
    if (copied) toast('Activity copied');
  });
}

$('copyLogJson').addEventListener('click', async () => {
  const text = await run(api.getLogJson());
  if (text === null) return;
  const copied = await run(api.writeClipboard(text));
  if (copied) toast('Activity JSON copied');
});

// The API key is written on blur so it is not saved keystroke by keystroke.
$('apiKey').addEventListener('blur', async () => {
  const input = $<HTMLInputElement>('apiKey');
  const submitted = input.value;
  if (submitted === '') return;
  const next = await run(api.setApiKey(submitted));
  if (next) {
    // Do not erase a newer value typed while safeStorage/IPC was still resolving the previous
    // blur. On failure keep the submitted value too, so the user can retry instead of losing it.
    if (input.value === submitted) input.value = '';
    apply(next);
    toast('API key stored');
  }
});

$('removeApiKey').addEventListener('click', async () => {
  const next = await run(api.setApiKey(''));
  if (next) {
    apply(next);
    toast('API key removed');
  }
});

for (const id of [
  'autoConnect',
  'minimizeToTray',
  'privacyScreenshots',
  'tunnelKind',
  'tunnelId',
  'desktopTunnelId'
]) {
  $(id).addEventListener('change', () => void save());
}

document.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest<HTMLElement>('[data-link]');
  if (link?.dataset.link) void run(api.openLink(link.dataset.link));
});

$('bridgeDownload').addEventListener('click', () => void run(api.downloadExtension()));

api.onStateChanged(apply);
api.onLogEntry(addLogLine);
api.onSwarmChanged(paintAgentFilter);

async function refresh(): Promise<void> {
  const next = await run(api.getState());
  if (next) apply(next);
}

buildGroups();
initChat({ save: () => save(), state: () => state });

void (async () => {
  await refresh();
  // A first run has nothing set up, so open on the wizard rather than an empty Home.
  if (state && missingStep(state)?.step === 'folder') showTab('setup');
  const entries = await run(api.getLog());
  for (const entry of entries ?? []) addLogLine(entry);
  const swarm = await run(api.getSwarm());
  if (swarm) paintAgentFilter(swarm);
})();
