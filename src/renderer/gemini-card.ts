import { joinOriginWithSurfacePath, normalizeHttpsOrigin } from '../shared/gemini-bridge.js';
import type { AppState, ExternalClientStatus, GeminiBridgeMode, GeminiBridgeStatus, SurfaceStatus } from '../shared/types.js';
import { ago, disclosureChevron, el, icon } from './dom.js';
import { currentLanguage, t, uiText } from './i18n.js';

export interface GeminiCardDeps {
  copyRow: (label: string | (() => string), value: string, what: string) => HTMLElement;
  copyText: (value: string, toastMessage: string) => Promise<void> | void;
  setAllowExternalCalls: (allowed: boolean) => Promise<boolean> | boolean;
  setTunnelKindCloudflared: () => Promise<boolean> | boolean;
  setPersistentUrls: (enabled: boolean) => Promise<boolean> | boolean;
  setGeminiBridge: (mode: GeminiBridgeMode) => Promise<boolean> | boolean;
  setGeminiPublicOrigin: (origin: string) => Promise<boolean> | boolean;
  setGeminiTunnelToken: (token: string) => Promise<void> | void;
  refreshGeminiBridge: () => Promise<void> | void;
  openExternalUrl: (url: string) => Promise<boolean | void> | void;
  openSetupStep: (step: 'access' | 'connect') => void;
  openExternalCallSettings: () => void;
}

interface RemoteSurfaceEndpoint {
  surface: SurfaceStatus;
  url: string;
  isLocalOnly: boolean;
}

interface GeminiCardUiState {
  originDraft?: string;
  originSavedBaseline?: string;
  originError?: string | null;
  tokenDraft?: string;
}

const uiStateByContainer = new WeakMap<HTMLElement, GeminiCardUiState>();

function uiStateFor(container: HTMLElement): GeminiCardUiState {
  let state = uiStateByContainer.get(container);
  if (!state) {
    state = {};
    uiStateByContainer.set(container, state);
  }
  return state;
}

/** Appends or replaces the `?client=gemini` query parameter on an MCP connector URL. */
export function buildGeminiMcpUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.searchParams.set('client', 'gemini');
    return parsed.toString();
  } catch {
    const hashIndex = trimmed.indexOf('#');
    const beforeHash = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
    const hash = hashIndex >= 0 ? trimmed.slice(hashIndex) : '';
    const cleaned = beforeHash.replace(/([?&])client=[^&]*&?/g, '$1').replace(/[?&]$/, '');
    const sep = cleaned.includes('?') ? '&' : '?';
    return `${cleaned}${sep}client=gemini${hash}`;
  }
}

/** Formats Gemini's `mcpServers.<name>.httpUrl` JSON snippet for a given surface and URL. */
export function buildGeminiMcpConfigJson(surfaceId: string, geminiUrl: string): string {
  const safeSuffix = surfaceId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  const serverName = !safeSuffix || safeSuffix === 'core' ? 'chat-on-steroids' : `chat-on-steroids-${safeSuffix}`;
  return JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          httpUrl: geminiUrl
        }
      }
    },
    null,
    2
  );
}

function activeBridgeMode(next: AppState): GeminiBridgeMode {
  return next.config.mcp?.geminiBridge ?? 'tunnel';
}

function activeBridgeStatus(next: AppState, mode: GeminiBridgeMode): GeminiBridgeStatus | null {
  const bridge = next.status.geminiBridge;
  if (!bridge || bridge.mode !== mode) return null;
  return bridge;
}

function remoteEndpointsFor(next: AppState): RemoteSurfaceEndpoint[] {
  const mode = activeBridgeMode(next);
  const tunnelKind = next.config.tunnel.kind;
  const bridge = activeBridgeStatus(next, mode);
  const out: RemoteSurfaceEndpoint[] = [];

  for (const surface of next.status.surfaces) {
    if (surface.id === 'plugins' || !surface.available) continue;

    if (mode === 'local') {
      if (!surface.localUrl) continue;
      out.push({ surface, url: surface.localUrl, isLocalOnly: true });
      continue;
    }

    if (mode === 'tailscale') {
      const origin = bridge?.state === 'live' ? bridge.publicOrigin : null;
      if (!origin || !surface.localUrl) continue;
      const url = joinOriginWithSurfacePath(origin, surface.localUrl);
      if (url) out.push({ surface, url, isLocalOnly: false });
      continue;
    }

    if (mode === 'custom') {
      const configured = normalizeHttpsOrigin(next.config.mcp?.geminiPublicOrigin ?? '');
      const origin = bridge?.publicOrigin || configured || null;
      if (!origin || !surface.localUrl) continue;
      const url = joinOriginWithSurfacePath(origin, surface.localUrl);
      if (url) out.push({ surface, url, isLocalOnly: false });
      continue;
    }

    if (tunnelKind === 'openai') continue;
    const url = surface.publicUrl ?? (tunnelKind === 'manual' ? surface.localUrl : null);
    if (!url) continue;
    out.push({ surface, url, isLocalOnly: !surface.publicUrl && Boolean(surface.localUrl) });
  }
  return out;
}

function geminiClientStatus(next: AppState): ExternalClientStatus | null {
  return next.status.externalClients?.find((client) => client.id === 'gemini') ?? null;
}

function formatGeminiStatusText(gemini: ExternalClientStatus | null): string {
  if (!gemini || gemini.lastRequestAt === null) {
    return t('Waiting for Gemini — paste the URL or JSON above into Gemini and run one prompt.');
  }
  if (gemini.lastToolCallAt !== null) {
    return gemini.connected
      ? t('Gemini connected — ran a tool {0}.', [ago(gemini.lastToolCallAt)])
      : t('Gemini ran a tool {0} in an earlier run.', [ago(gemini.lastToolCallAt)]);
  }
  return gemini.connected
    ? t('Gemini connected {0}, waiting for its first tool call.', [ago(gemini.lastRequestAt)])
    : t('Gemini reached an earlier run {0} without calling a tool.', [ago(gemini.lastRequestAt)]);
}

function createActionButton(
  label: () => string,
  solid: boolean,
  onClick: () => Promise<unknown> | unknown
): HTMLButtonElement {
  const button = el('button', solid ? 'btn btn-solid' : 'btn', label) as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', () => {
    void (async () => {
      button.disabled = true;
      try {
        await onClick();
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    })();
  });
  return button;
}

function loopbackOrigin(localUrl: string | null): string | null {
  if (!localUrl) return null;
  try {
    return new URL(localUrl).origin;
  } catch {
    return null;
  }
}

function buildModeSection(next: AppState, deps: GeminiCardDeps): HTMLElement {
  const mode = activeBridgeMode(next);
  const box = el('div', 'gemini-card-section');
  const head = el('div', 'gemini-mode-head');
  head.append(
    el('span', 'gemini-guide-title', () => t('Gemini access mode')),
    el('span', 'hint', () => t('Runs in parallel with ChatGPT on its own URL.'))
  );

  const bar = el('div', 'gemini-mode-bar');
  bar.setAttribute('role', 'radiogroup');
  bar.setAttribute('aria-label', t('Gemini access mode'));

  const choices: Array<{ mode: GeminiBridgeMode; title: () => string; sub: () => string }> = [
    { mode: 'tailscale', title: () => t('Tailscale'), sub: () => t('Fixed HTTPS, no domain') },
    { mode: 'custom', title: () => t('Custom HTTPS'), sub: () => t('Your domain or Named Tunnel') },
    { mode: 'local', title: () => t('Local'), sub: () => t('This PC only') },
    { mode: 'tunnel', title: () => t('Share ChatGPT tunnel'), sub: () => t('Uses active Step 4 tunnel') }
  ];

  for (const choice of choices) {
    const selected = mode === choice.mode;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `gemini-mode-btn${selected ? ' is-selected' : ''}`;
    btn.dataset.geminiMode = choice.mode;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    btn.append(
      el('span', 'gemini-mode-title', choice.title),
      el('span', 'gemini-mode-sub', choice.sub)
    );
    btn.addEventListener('click', () => {
      if (choice.mode === mode) return;
      void deps.setGeminiBridge(choice.mode);
    });
    bar.append(btn);
  }

  box.append(head, bar);
  return box;
}

function buildBridgePanel(
  container: HTMLElement,
  next: AppState,
  activeSurface: SurfaceStatus | null,
  deps: GeminiCardDeps,
  repaint: () => void
): HTMLElement | null {
  const mode = activeBridgeMode(next);
  const bridge = activeBridgeStatus(next, mode);
  const tunnelKind = next.config.tunnel.kind;
  const serverRunning = Boolean(activeSurface?.localUrl || next.status.localUrl);

  if (mode === 'tunnel') {
    if (tunnelKind !== 'openai') return null;
    const box = el('div', 'gemini-card-section');
    box.append(
      el('p', 'hint is-warn', () =>
        t('ChatGPT uses the OpenAI tunnel. Choose Tailscale, Custom HTTPS, or Local above to run Gemini at the same time.')
      )
    );
    const actions = el('div', 'gemini-card-actions');
    actions.append(
      createActionButton(() => t('Use Tailscale (Permanent HTTPS)'), true, () => deps.setGeminiBridge('tailscale'))
    );
    box.append(actions);
    return box;
  }

  if (mode === 'tailscale') {
    const box = el('div', 'gemini-card-section');
    if (bridge?.state === 'live' && bridge.publicOrigin) {
      box.append(
        el('p', 'hint is-ok', () =>
          t('Permanent Tailscale Funnel active at {0} alongside ChatGPT.', [bridge.publicOrigin!])
        )
      );
      return box;
    }
    if (bridge?.state === 'starting') {
      box.append(el('p', 'hint', () => t('Checking Tailscale Funnel…')));
      return box;
    }
    if (bridge?.state === 'error') {
      box.append(el('p', 'hint is-warn', bridge.detail));
      const actions = el('div', 'gemini-card-actions');
      if (bridge.actionUrl) {
        const actionUrl = bridge.actionUrl;
        actions.append(
          createActionButton(() => t('Open Tailscale link'), true, () => deps.openExternalUrl(actionUrl))
        );
      }
      actions.append(createActionButton(() => t('Retry'), !bridge.actionUrl, () => deps.refreshGeminiBridge()));
      box.append(actions);
      return box;
    }
    if (!serverRunning) {
      box.append(el('p', 'hint', () => t('Use the Connect step to get an address for Gemini.')));
      const actions = el('div', 'gemini-card-actions');
      actions.append(createActionButton(() => t('Open Connect step'), false, () => deps.openSetupStep('connect')));
      box.append(actions);
      return box;
    }
    return null;
  }

  if (mode === 'local') {
    const box = el('div', 'gemini-card-section');
    box.append(
      el('p', serverRunning ? 'hint is-ok' : 'hint', () =>
        serverRunning
          ? t('Using your permanent local URL on this PC alongside ChatGPT.')
          : t('Use the Connect step to get an address for Gemini.')
      )
    );
    if (!serverRunning) {
      const actions = el('div', 'gemini-card-actions');
      actions.append(createActionButton(() => t('Open Connect step'), false, () => deps.openSetupStep('connect')));
      box.append(actions);
    }
    return box;
  }

  // Custom HTTPS mode
  const box = el('div', 'gemini-card-section');
  const uiState = uiStateFor(container);
  const savedOrigin = next.config.mcp?.geminiPublicOrigin ?? '';
  if (uiState.originSavedBaseline !== savedOrigin) {
    uiState.originSavedBaseline = savedOrigin;
    uiState.originDraft = savedOrigin;
    uiState.originError = null;
  }

  const originField = el('div', 'gemini-input-field');
  const originLabel = el('label', '', () => t('Permanent HTTPS address'));
  const originRow = el('div', 'gemini-input-row');
  const originInput = document.createElement('input');
  originInput.type = 'url';
  originInput.className = 'gemini-text-input';
  originInput.dataset.geminiOriginInput = '1';
  originInput.placeholder = 'https://mcp.example.com';
  originInput.value = uiState.originDraft ?? savedOrigin;
  originInput.setAttribute('aria-label', t('Permanent HTTPS address'));
  originInput.addEventListener('input', () => {
    uiState.originDraft = originInput.value;
    uiState.originError = null;
  });

  const saveOriginBtn = createActionButton(() => t('Save'), true, async () => {
    const raw = originInput.value.trim();
    const normalized = raw ? normalizeHttpsOrigin(raw) : '';
    if (raw && !normalized) {
      uiState.originDraft = raw;
      uiState.originError = t('Enter a valid HTTPS origin such as https://mcp.example.com');
      repaint();
      return;
    }
    uiState.originError = null;
    uiState.originDraft = normalized;
    await deps.setGeminiPublicOrigin(normalized);
  });

  originRow.append(originInput, saveOriginBtn);
  originField.append(originLabel, originRow);
  box.append(originField);

  if (uiState.originError) {
    box.append(el('p', 'hint is-warn', uiState.originError));
  }

  const localOrigin = loopbackOrigin(activeSurface?.localUrl ?? next.status.localUrl);
  if (localOrigin) {
    box.append(
      el('p', 'hint', () =>
        t('Point your reverse proxy or Cloudflare Named Tunnel to {0}. No host header rewrite is needed.', [
          localOrigin
        ])
      )
    );
  }

  const tokenField = el('div', 'gemini-input-field');
  const tokenHead = el('div', 'gemini-json-head');
  tokenHead.append(el('label', '', () => t('Cloudflare Tunnel token (optional)')));
  if (next.hasGeminiTunnelToken) {
    tokenHead.append(el('span', 'tag is-optional', () => t('Saved in OS key store')));
  }
  const tokenRow = el('div', 'gemini-input-row');
  const tokenInput = document.createElement('input');
  tokenInput.type = 'password';
  tokenInput.autocomplete = 'off';
  tokenInput.className = 'gemini-text-input';
  tokenInput.dataset.geminiTokenInput = '1';
  tokenInput.placeholder = next.hasGeminiTunnelToken ? '••••••••••••••••' : 'eyJhIjoi...';
  tokenInput.value = uiState.tokenDraft ?? '';
  tokenInput.setAttribute('aria-label', t('Cloudflare Tunnel token (optional)'));
  tokenInput.addEventListener('input', () => {
    uiState.tokenDraft = tokenInput.value;
  });

  const saveTokenBtn = createActionButton(() => t('Save token'), false, async () => {
    const token = tokenInput.value.trim();
    if (!token) return;
    uiState.tokenDraft = '';
    tokenInput.value = '';
    await deps.setGeminiTunnelToken(token);
  });

  tokenRow.append(tokenInput, saveTokenBtn);
  if (next.hasGeminiTunnelToken) {
    tokenRow.append(
      createActionButton(() => t('Clear token'), false, async () => {
        uiState.tokenDraft = '';
        tokenInput.value = '';
        await deps.setGeminiTunnelToken('');
      })
    );
  }
  tokenField.append(tokenHead, tokenRow);
  tokenField.append(
    el('p', 'hint', () =>
      t('Paste a Cloudflare Named Tunnel token to start it automatically alongside ChatGPT, or leave blank if your own reverse proxy forwards traffic here.')
    )
  );
  box.append(tokenField);

  if (bridge?.state === 'error' && bridge.detail && !uiState.originError) {
    box.append(el('p', 'hint is-warn', bridge.detail));
    const actions = el('div', 'gemini-card-actions');
    actions.append(createActionButton(() => t('Retry'), false, () => deps.refreshGeminiBridge()));
    box.append(actions);
  } else if (bridge?.state === 'starting' && bridge.detail) {
    box.append(el('p', 'hint', bridge.detail));
  }

  return box;
}

function buildPermissionSection(next: AppState, selectedSurface: SurfaceStatus | null, deps: GeminiCardDeps): HTMLElement {
  const box = el('div', 'gemini-card-section');
  const strict = Boolean(next.config.multiAgent.strictChatAllowlist);
  const allowed = Boolean(next.config.multiAgent.allowUnattributedCalls);

  if (strict) {
    box.append(
      el('p', 'hint is-warn', () =>
        t('Blocked: "Only selected chats" is turned on in Settings, so Gemini cannot run tools.')
      )
    );
    const actions = el('div', 'gemini-card-actions');
    actions.append(createActionButton(() => t('Review in Settings'), false, () => deps.openExternalCallSettings()));
    box.append(actions);
    return box;
  }

  if (!allowed) {
    box.append(
      el('p', 'hint is-warn', () =>
        t('Gemini tool calls are currently blocked. Allow external callers for Gemini to use your tools.')
      )
    );
    const actions = el('div', 'gemini-card-actions');
    actions.append(createActionButton(() => t('Allow Gemini calls'), true, () => deps.setAllowExternalCalls(true)));
    box.append(actions);
    return box;
  }

  const toolCount = selectedSurface?.tools.length ?? 0;
  const accessSummary = el('p', 'hint', () =>
    next.config.readOnly
      ? t('Gemini calls allowed (Read-only mode — browsing and reading only).')
      : t('Gemini calls allowed ({0} tools enabled on the selected server).', [toolCount])
  );
  const actions = el('div', 'gemini-card-actions');
  actions.append(
    createActionButton(() => t('Change access'), false, () => deps.openSetupStep('access')),
    createActionButton(() => t('Turn off external calls'), false, () => deps.setAllowExternalCalls(false))
  );
  box.append(accessSummary, actions);
  return box;
}

function buildEndpointSection(
  container: HTMLElement,
  next: AppState,
  endpoints: RemoteSurfaceEndpoint[],
  selected: RemoteSurfaceEndpoint | null,
  activeSurface: SurfaceStatus | null,
  deps: GeminiCardDeps,
  repaintsOnSelect: () => void
): HTMLElement | null {
  const box = el('div', 'gemini-card-section');
  const mode = activeBridgeMode(next);
  const tunnelKind = next.config.tunnel.kind;

  if (!selected) {
    if (mode === 'tunnel' && tunnelKind === 'openai') return null;
    if (mode === 'tailscale' || mode === 'local') return null;
    if (mode === 'custom' && activeSurface?.localUrl) return null;
    box.append(el('p', 'hint', () => t('Use the Connect step to generate your public HTTPS URL for Gemini.')));
    const actions = el('div', 'gemini-card-actions');
    actions.append(createActionButton(() => t('Open Connect step'), false, () => deps.openSetupStep('connect')));
    box.append(actions);
    return box;
  }

  if (endpoints.length > 1) {
    const pickerField = el('div', 'gemini-json-field');
    const select = document.createElement('select');
    select.className = 'gemini-surface-select';
    select.setAttribute('aria-label', t('Server to copy'));
    for (const entry of endpoints) {
      const opt = document.createElement('option');
      opt.value = entry.surface.id;
      opt.textContent = entry.surface.connectorName;
      opt.selected = entry.surface.id === selected.surface.id;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      container.dataset.geminiSurfaceId = select.value;
      delete container.dataset.geminiRenderKey;
      repaintsOnSelect();
    });
    pickerField.append(el('label', '', () => t('Server to copy')), select);
    box.append(pickerField);
  }

  const geminiUrl = buildGeminiMcpUrl(selected.url);
  box.append(deps.copyRow(() => t('Gemini MCP URL'), geminiUrl, 'Gemini MCP URL'));

  if (selected.isLocalOnly && mode === 'tunnel') {
    box.append(
      el('p', 'hint is-warn', () =>
        t('Manual mode shows your local address. Expose it over HTTPS before pasting it into remote Gemini.')
      )
    );
  }

  const jsonText = buildGeminiMcpConfigJson(selected.surface.id, geminiUrl);
  const jsonField = el('div', 'gemini-json-field');
  const jsonHead = el('div', 'gemini-json-head');
  const copyJson = document.createElement('button');
  copyJson.type = 'button';
  copyJson.className = 'btn copy-btn';
  copyJson.append(icon('i-copy'), uiText(() => t('Copy JSON')));
  copyJson.addEventListener('click', () => {
    void deps.copyText(jsonText, t('{0} copied', [t('Gemini MCP config')]));
  });
  jsonHead.append(el('label', '', () => t('Gemini MCP config (JSON)')), copyJson);
  const preview = document.createElement('textarea');
  preview.className = 'gemini-json-preview';
  preview.readOnly = true;
  preview.spellcheck = false;
  preview.rows = 7;
  preview.value = jsonText;
  preview.setAttribute('aria-label', t('Gemini MCP config (JSON)'));
  jsonField.append(jsonHead, preview);
  box.append(jsonField);

  const persistent = Boolean(next.config.mcp?.persistentUrls);
  if (mode === 'tunnel' && tunnelKind === 'cloudflared') {
    if (!persistent) {
      box.append(
        el('p', 'hint', () =>
          t('Cloudflare gives a fresh URL on each restart. Turn on Keep URL tokens to keep the token path stable across restarts.')
        )
      );
      const actions = el('div', 'gemini-card-actions');
      actions.append(createActionButton(() => t('Keep URL tokens'), false, () => deps.setPersistentUrls(true)));
      box.append(actions);
    } else {
      box.append(
        el('p', 'hint', () =>
          t('URL tokens stay fixed across restarts. Free Cloudflare quick-tunnel hostnames still change on restart unless you use Manual with your own domain.')
        )
      );
    }
  } else if (!persistent) {
    box.append(
      el('p', 'hint is-warn', () =>
        t('URL tokens still rotate on restart unless Keep URL tokens is on.')
      )
    );
    const actions = el('div', 'gemini-card-actions');
    actions.append(createActionButton(() => t('Keep URL tokens'), false, () => deps.setPersistentUrls(true)));
    box.append(actions);
  } else {
    box.append(
      el('p', 'hint is-ok', () =>
        t('Permanent URL active — your copied Gemini link and port stay fixed across restarts.')
      )
    );
  }

  return box;
}

export function updateGeminiLiveText(container: HTMLElement, next: AppState): void {
  const statusEl = container.querySelector<HTMLElement>('[data-gemini-status]');
  if (!statusEl) return;
  statusEl.textContent = formatGeminiStatusText(geminiClientStatus(next));
}

function buildGuideSection(
  endpointReady: boolean,
  permissionOk: boolean,
  geminiSeen: boolean,
  geminiRanTool: boolean
): HTMLElement {
  const box = el('div', 'gemini-card-section gemini-guide-section');
  box.append(el('p', 'gemini-guide-title', () => t('How to add it in Gemini')));

  const list = el('ol', 'guide-moves gemini-guide-moves');
  const steps: Array<{ done: boolean; label: () => string }> = [
    {
      done: endpointReady,
      label: () =>
        t('Pick Tailscale, Custom HTTPS, or Local above (runs alongside ChatGPT) and connect in the Connect step.')
    },
    {
      done: permissionOk,
      label: () => t('Make sure external calls are enabled with Allow Gemini calls below.')
    },
    {
      done: geminiSeen,
      label: () =>
        t('Copy Gemini MCP URL (for web/custom integrations) or Copy JSON (for mcpServers.httpUrl configs). Keep ?client=gemini at the end.')
    },
    {
      done: geminiRanTool,
      label: () =>
        t('Ask Gemini to run a tool on your workspace. The status badge turns green and Gemini appears in the connection list and inbox.')
    }
  ];

  steps.forEach((step, index) => {
    const item = el('li', `guide-move${step.done ? ' is-done' : ''}`);
    item.append(el('span', 'guide-pin', String(index + 1)), el('span', 'guide-move-text', step.label));
    list.append(item);
  });

  box.append(list);
  return box;
}

function buildHelpDisclosure(openInitially: boolean): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'setup-optional gemini-help';
  if (openInitially) details.open = true;

  const summary = document.createElement('summary');
  summary.append(
    disclosureChevron('details-chevron'),
    uiText(() => t('Using Gemini with this app & troubleshooting')),
    el('span', 'tag is-optional', () => t('guide'))
  );

  const body = el('div', 'setup-optional-body');
  const tips = [
    () =>
      t('Use Tailscale for a free fixed *.ts.net HTTPS URL with no domain (even while ChatGPT stays on the OpenAI tunnel), Custom HTTPS for your own domain, or Local for Gemini tools on this PC.'),
    () =>
      t('URL vs JSON: For Gemini clients that ask for an endpoint URL, paste Gemini MCP URL and choose No Auth — the secret token inside the URL is your credential. For config files, use Copy JSON, which outputs Gemini’s mcpServers.httpUrl format.'),
    () =>
      t('Core and Desktop servers: Connect Core first for project files, search, and commands. If Desktop access is turned on, switch Server to copy to Desktop and add it as a second server in Gemini.'),
    () =>
      t('Custom domain & Tailscale: Fixed URLs survive app restarts when Keep URL tokens is on. Tailscale Funnel stays active while connected and closes automatically when you disconnect.'),
    () =>
      t('If Gemini connects but cannot run tools: Check that Allow Gemini calls is enabled here, Only selected chats is off in Settings, and Read-only mode is off if you want Gemini to edit files or run commands.')
  ];
  for (const tip of tips) {
    body.append(el('p', 'hint', tip));
  }
  details.append(summary, body);
  return details;
}

/** Renders the dedicated remote Gemini MCP setup card outside `#connectorCards`. */
export function paintGeminiSetupCard(container: HTMLElement, next: AppState, deps: GeminiCardDeps): void {
  const activeEl = document.activeElement;
  if (
    activeEl instanceof HTMLInputElement &&
    !activeEl.readOnly &&
    container.contains(activeEl)
  ) {
    updateGeminiLiveText(container, next);
    return;
  }

  const mode = activeBridgeMode(next);
  const bridge = activeBridgeStatus(next, mode);
  const endpoints = remoteEndpointsFor(next);
  const preferredId = container.dataset.geminiSurfaceId || 'core';
  const selected = endpoints.find((e) => e.surface.id === preferredId) ?? endpoints[0] ?? null;
  if (selected) container.dataset.geminiSurfaceId = selected.surface.id;

  const fallbackSurface =
    next.status.surfaces.find((s) => s.id === 'core') ??
    next.status.surfaces.find((s) => s.id !== 'plugins' && s.available) ??
    null;
  const activeSurface = selected?.surface ?? fallbackSurface;
  const gemini = geminiClientStatus(next);
  const uiState = uiStateFor(container);

  const renderKey = JSON.stringify([
    currentLanguage(),
    next.config.tunnel.kind,
    mode,
    next.config.mcp?.geminiPublicOrigin ?? '',
    Boolean(next.hasGeminiTunnelToken),
    bridge ? [bridge.state, bridge.publicOrigin, bridge.detail, bridge.actionUrl ?? null] : null,
    next.status.localUrl,
    uiState.originError ?? null,
    next.config.readOnly,
    Boolean(next.config.mcp?.persistentUrls),
    Boolean(next.config.multiAgent.strictChatAllowlist),
    Boolean(next.config.multiAgent.allowUnattributedCalls),
    selected?.surface.id ?? 'none',
    endpoints.map((e) => `${e.surface.id}:${e.url}:${e.surface.tools.length}`),
    gemini ? [gemini.connected, gemini.lastRequestAt, gemini.lastToolCallAt] : null
  ]);

  if (container.dataset.geminiRenderKey === renderKey) {
    updateGeminiLiveText(container, next);
    return;
  }
  container.dataset.geminiRenderKey = renderKey;
  const wasHelpOpen = container.querySelector<HTMLDetailsElement>('.gemini-help')?.open ?? false;

  const strict = Boolean(next.config.multiAgent.strictChatAllowlist);
  const allowed = Boolean(next.config.multiAgent.allowUnattributedCalls);
  const blocked = strict || !allowed;
  const permissionOk = !blocked;
  const endpointReady = Boolean(selected && (mode === 'local' || !selected.isLocalOnly));
  const cardState = gemini?.connected
    ? 'live'
    : bridge?.state === 'error' || blocked
      ? 'warn'
      : endpointReady
        ? 'ready'
        : 'idle';

  const card = el('div', `connector gemini-card is-${cardState}`);
  const head = el('div', 'connector-head');
  const badges = el('span', 'connector-badges');

  let pillClass = 'pill is-idle';
  let pillLabel = () => t('Ready for Gemini');
  if (gemini?.connected) {
    pillClass = 'pill is-live';
    pillLabel = () => t('Gemini connected');
  } else if (mode !== 'tunnel' && bridge?.state === 'error') {
    pillClass = 'pill is-error';
    pillLabel = () => t('Needs attention');
  } else if (mode !== 'tunnel' && bridge?.state === 'starting') {
    pillClass = 'pill is-idle';
    pillLabel = () => t('Starting Gemini URL…');
  } else if (!selected) {
    pillClass = 'pill is-off';
    pillLabel = () => t('Not ready');
  } else if (blocked) {
    pillClass = 'pill is-error';
    pillLabel = () => t('Access paused');
  } else if (mode === 'tailscale' && bridge?.state === 'live') {
    pillClass = 'pill is-live';
    pillLabel = () => t('Tailscale ready');
  } else if (mode === 'local') {
    pillClass = 'pill is-live';
    pillLabel = () => t('Local ready');
  }

  const transportTag =
    mode === 'local'
      ? () => t('Local URL')
      : mode === 'tailscale' || mode === 'custom'
        ? () => t('Permanent URL')
        : () => t('HTTPS URL');

  badges.append(
    el('span', 'tag is-optional', transportTag),
    el('span', pillClass, pillLabel)
  );
  head.append(el('h4', '', () => t('Gemini (Remote MCP)')), badges);

  const liveLine = el('p', 'hint', () => formatGeminiStatusText(gemini));
  liveLine.dataset.geminiStatus = '1';

  const repaintNow = (): void => {
    delete container.dataset.geminiRenderKey;
    paintGeminiSetupCard(container, next, deps);
  };

  const bridgePanel = buildBridgePanel(container, next, activeSurface, deps, repaintNow);

  card.append(
    head,
    el('p', 'hint', () =>
      t('Paste one HTTPS URL or JSON config into Gemini. The ?client=gemini parameter identifies Gemini separately from ChatGPT.')
    ),
    buildModeSection(next, deps),
    ...(bridgePanel ? [bridgePanel] : []),
    buildGuideSection(
      endpointReady,
      permissionOk,
      Boolean(gemini?.lastRequestAt !== null && gemini !== null),
      Boolean(gemini?.lastToolCallAt !== null && gemini !== null)
    ),
    buildPermissionSection(next, activeSurface, deps)
  );

  const endpointSection = buildEndpointSection(
    container,
    next,
    endpoints,
    selected,
    activeSurface,
    deps,
    repaintNow
  );
  if (endpointSection) card.append(endpointSection);

  card.append(liveLine, buildHelpDisclosure(wasHelpOpen));

  container.replaceChildren(card);
}
