/**
 * Owns the lifecycle: local MCP server up, then tunnel(s) up, then connected.
 * Everything the UI shows about connection state comes from here.
 *
 * There is one local server and one or two published connectors. The Core connector is
 * what the app is for and is always published; Desktop is optional, is published only
 * when the user has both granted desktop permissions and configured a way to reach it,
 * and its absence is never allowed to fail the connection — a user who never wants
 * desktop control should not see a broken app because of a connector they did not create.
 */

import type { ConnectionStatus, SurfaceStatus, TunnelSettings } from '../shared/types.js';
import { requiresApprovedFilesystemRoot } from '../shared/capabilities.js';
import { prewarmComputerHelper } from './computer/index.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { logError, logInfo, logWarn } from './logger.js';
import { lastRequestAt, startMcpServer, tunnelProbeHeaders, type McpEndpoint } from './mcp/server.js';
import { lastToolCallAt } from './mcp/tools.js';
import { SURFACE_LIST, surfaceIsUseful, type SurfaceId } from './mcp/surfaces.js';
import { getSecret } from './secrets.js';
import { startTunnel, TunnelError, type TunnelHandle } from './tunnel/index.js';
import { desktopAutomationSupported } from './platform.js';

let endpoint: McpEndpoint | null = null;
/** The Core tunnel. Also the only tunnel on the cloudflared and manual paths. */
let tunnel: TunnelHandle | null = null;
/** The Desktop tunnel, on the OpenAI path only, and only when one is configured. */
let desktopTunnel: TunnelHandle | null = null;
/** The tunnel id `desktopTunnel` was started for, so a changed id is detectable. */
let desktopTunnelId: string | null = null;
/** Core-affecting transport settings the current run actually started with. */
let activeCoreTransport: Pick<TunnelSettings, 'kind' | 'tunnelId' | 'binaryPath'> | null = null;
let status: ConnectionStatus = {
  state: 'disconnected',
  detail: '',
  publicUrl: null,
  localUrl: null,
  handshakeAt: null,
  lastRequestAt: null,
  lastToolCallAt: null,
  health: null,
  surfaces: []
};

const listeners = new Set<(status: ConnectionStatus) => void>();
// Connect/disconnect can be triggered by the renderer, tray, auto-connect and app
// shutdown. Serialize those lifecycle transitions so a fast double click or a
// connect racing shutdown cannot stop resources another connect just created.
let lifecycleQueue: Promise<void> = Promise.resolve();
/** Invalidates late async reports from a tunnel that has already been replaced/stopped. */
let connectionGeneration = 0;
/**
 * Final app shutdown is a terminal lifecycle boundary, unlike an ordinary Disconnect.
 *
 * Merely enqueueing shutdown behind an in-flight connect let that connect finish publishing an
 * MCP endpoint/tunnel first. Cmd+Q can arrive while startMcpServer/startTunnel/Keychain awaits;
 * mark shutdown synchronously so each resumed await tears down what it just created instead of
 * briefly bringing a connector online while the app is already leaving.
 */
let shutdownRequested = false;

function enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
  const run = lifecycleQueue.then(operation, operation);
  lifecycleQueue = run.catch(() => {});
  return run;
}

export function getStatus(): ConnectionStatus {
  // Read live rather than trusting the last stored copy: both clocks are set by
  // incoming requests, which do not go past setStatus, so a stored value would lag
  // behind reality by up to one tunnel report. The surface cards are rebuilt for the
  // same reason — what each connector would advertise follows the permission
  // checkboxes, which change without any connection event to recompute them.
  return {
    ...status,
    lastRequestAt: lastRequestAt(),
    lastToolCallAt: lastToolCallAt(),
    surfaces: describeSurfaces()
  };
}

export function onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setStatus(next: Partial<ConnectionStatus>): void {
  status = { ...status, ...next };
  for (const listener of listeners) listener(status);
}

/**
 * The setup-facing description of every connector, whether or not it is running.
 *
 * Built even while disconnected, because this is what the setup screen reads: the user
 * needs the exact name and description to paste into ChatGPT *before* anything is live,
 * and asking them to invent either is how a connector ends up named "my pc" — a name the
 * model cannot address and a description it cannot route on.
 */
function describeSurfaces(): SurfaceStatus[] {
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  // A remembered surface report belongs to the currently running local endpoint. Once that
  // endpoint is gone, carrying its state/public URL forward makes a completed disconnect
  // internally contradictory: the headline says disconnected while a connector card can
  // still say live and expose the dead tunnel URL. Preserve reports only while there is an
  // endpoint for them to describe; a fresh connect will populate its own generation again.
  const running = endpoint !== null;
  return SURFACE_LIST.map((surface) => {
    const available = surfaceIsUseful(surface.id, caps);
    const previous = status.surfaces.find((entry) => entry.id === surface.id);
    return {
      id: surface.id,
      connectorName: surface.connectorName,
      description: surface.description,
      cardSummary: surface.cardSummary,
      optional: !surface.required,
      available,
      localUrl: endpoint?.urls[surface.id] ?? null,
      publicUrl: running ? (previous?.publicUrl ?? null) : null,
      tools: toolsFor(surface.id),
      state: available && running ? (previous?.state ?? 'off') : 'off',
      detail: available ? (running ? (previous?.detail ?? '') : '') : desktopUnavailableDetail(surface.id),
      // Per connector, because a Core call proves nothing about whether the user ever
      // created the Desktop connector in ChatGPT. Publication is our side of the wire;
      // these two are the only evidence of the other side.
      lastRequestAt: lastRequestAt(surface.id),
      lastToolCallAt: lastToolCallAt(surface.id)
    };
  });
}

function desktopUnavailableDetail(id: SurfaceId): string {
  if (id === 'desktop' && !desktopAutomationSupported()) {
    return 'Desktop automation is not available on this operating system. Core files, terminal, sessions and sub-agents remain available.';
  }
  return id === 'desktop'
    ? 'Turn on "See the screen", "Control mouse and keyboard" or a clipboard permission to use this connector.'
    : '';
}

/** The tools this surface would advertise right now, for the "what you get" list. */
function toolsFor(id: SurfaceId): string[] {
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  if (id === 'desktop') {
    const computer = caps.control || caps.clipboardRead || caps.clipboardWrite;
    return [...(caps.screen ? ['observe'] : []), ...(computer ? ['computer'] : [])];
  }
  const tools: string[] = [];
  if (caps.read || caps.browse || caps.metadata) tools.push('read');
  if (caps.read) tools.push('view_image');
  if (!caps.command && caps.search) tools.push('find');
  if (caps.create || caps.edit || caps.move || caps.deleteFile) tools.push('apply_patch');
  if (caps.command) tools.push('exec_command', 'write_stdin');
  if (config.sessions.record) tools.push('session');
  if (config.multiAgent.enabled) tools.push('agents');
  return tools;
}

function updateSurface(id: SurfaceId, next: Partial<SurfaceStatus>): void {
  setStatus({
    surfaces: status.surfaces.map((entry) => (entry.id === id ? { ...entry, ...next } : entry))
  });
}

/** Projects a whole-connection tunnel report onto one connector card. */
function surfaceStateForConnection(state: ConnectionStatus['state']): SurfaceStatus['state'] {
  if (state === 'connected') return 'live';
  if (state === 'starting-server' || state === 'connecting-tunnel') return 'starting';
  return 'error';
}

/**
 * Settings whose change means the existing Core tunnel can no longer represent the config.
 *
 * `desktopTunnelId` is intentionally absent: that second OpenAI tunnel is hot-swappable.
 * Irrelevant fields are normalised out too, so editing a hidden OpenAI id while Cloudflare is
 * active does not bounce a perfectly good connection.
 */
function coreTransport(settings: TunnelSettings): Pick<TunnelSettings, 'kind' | 'tunnelId' | 'binaryPath'> {
  return {
    kind: settings.kind,
    tunnelId: settings.kind === 'openai' ? settings.tunnelId : '',
    binaryPath: settings.kind === 'manual' ? '' : settings.binaryPath
  };
}

function sameCoreTransport(
  left: Pick<TunnelSettings, 'kind' | 'tunnelId' | 'binaryPath'>,
  right: Pick<TunnelSettings, 'kind' | 'tunnelId' | 'binaryPath'>
): boolean {
  return left.kind === right.kind && left.tunnelId === right.tunnelId && left.binaryPath === right.binaryPath;
}

/**
 * Derives a second surface's public URL from the first one's.
 *
 * Only correct for a transport that publishes a whole origin — cloudflared and a manual
 * reverse proxy — where both surfaces are already reachable at their own paths on the URL
 * the user was given. It is deliberately not used for the OpenAI tunnel, where a tunnel id
 * maps to one local URL and the second surface genuinely needs its own tunnel.
 */
function siblingPublicUrl(publicUrl: string | null, localUrl: string | null): string | null {
  if (!publicUrl || !localUrl) return null;
  try {
    const target = new URL(publicUrl);
    target.pathname = new URL(localUrl).pathname;
    return target.toString();
  } catch {
    return null;
  }
}

async function connectImpl(): Promise<void> {
  if (shutdownRequested) return;
  // Offline counts as running: the tunnel is alive and retrying on its own.
  if (
    status.state === 'connected' ||
    status.state === 'offline' ||
    status.state === 'starting-server' ||
    status.state === 'connecting-tunnel'
  ) {
    return;
  }
  await disconnectImpl();
  // disconnectImpl can itself await a live endpoint/tunnel. Final shutdown may be requested
  // while that stop is in progress; never mint a fresh generation afterwards and thereby undo
  // the synchronous invalidation performed by shutdownConnection().
  if (shutdownRequested) return;
  const generation = ++connectionGeneration;

  const config = getConfig();
  const caps = effectiveCapabilities(config);
  // A root is required by the capabilities that actually cross the filesystem boundary,
  // not by the mere presence or absence of Desktop. Otherwise enabling screen/clipboard
  // could accidentally waive the root needed by Core's file or command semantics.
  if (config.roots.length === 0 && requiresApprovedFilesystemRoot(config)) {
    setStatus({ state: 'disconnected', detail: 'Add a folder before connecting.' });
    return;
  }

  try {
    setStatus({ state: 'starting-server', detail: 'Starting the local server…', publicUrl: null });
    const startedEndpoint = await startMcpServer(() => {
      const live = getConfig();
      return {
        roots: live.roots,
        caps: effectiveCapabilities(live),
        readOnly: live.readOnly,
        privacyScreenshots: live.ui.privacyScreenshots
      };
    });
    if (shutdownRequested || generation !== connectionGeneration) {
      await startedEndpoint.stop({ forceAfterMs: 30_000 }).catch(() => {});
      return;
    }
    endpoint = startedEndpoint;
    setStatus({ localUrl: endpoint.url, surfaces: describeSurfaces() });
    if (desktopAutomationSupported() && (caps.screen || caps.control)) void prewarmComputerHelper();
    updateSurface('core', { state: 'starting', detail: 'Connecting…' });

    const apiKey = await getSecret('openaiApiKey');
    if (shutdownRequested || generation !== connectionGeneration) {
      await disconnectImpl(30_000);
      return;
    }
    activeCoreTransport = coreTransport(config.tunnel);
    const startedTunnel = await startTunnel({
      localUrl: endpoint.url,
      settings: config.tunnel,
      apiKey,
      discoveryHeaders: tunnelProbeHeaders(),
      label: 'core',
      report: (report) => {
        if (generation !== connectionGeneration) return;
        setStatus({
          state: report.state,
          detail: report.detail,
          lastRequestAt: lastRequestAt(),
          ...(report.publicUrl === undefined ? {} : { publicUrl: report.publicUrl }),
          ...(report.handshakeAt === undefined ? {} : { handshakeAt: report.handshakeAt }),
          ...(report.health === undefined ? {} : { health: report.health })
        });
        updateSurface('core', {
          state: surfaceStateForConnection(report.state),
          detail: report.detail,
          ...(report.publicUrl === undefined ? {} : { publicUrl: report.publicUrl })
        });
        // On a whole-origin transport the Desktop surface is already published by this
        // same tunnel; it just needs its own path on the URL the user was handed.
        if (config.tunnel.kind !== 'openai' && report.publicUrl !== undefined) {
          const desktop = status.surfaces.find((entry) => entry.id === 'desktop');
          if (desktop?.available) {
            updateSurface('desktop', {
              publicUrl: siblingPublicUrl(report.publicUrl, desktop.localUrl),
              state: surfaceStateForConnection(report.state),
              detail: report.detail
            });
          }
        }
      }
    });
    if (shutdownRequested || generation !== connectionGeneration) {
      await startedTunnel.stop().catch(() => {});
      await disconnectImpl(30_000);
      return;
    }
    tunnel = startedTunnel;

    await startDesktopTunnel(generation, config.tunnel, apiKey);
  } catch (err) {
    if (shutdownRequested || generation !== connectionGeneration) {
      await disconnectImpl(30_000);
      return;
    }
    const message = err instanceof TunnelError ? err.message : (err as Error).message;
    logError(`connect failed: ${message}`);
    await disconnectImpl();
    setStatus({
      state: err instanceof TunnelError ? 'tunnel-unavailable' : 'disconnected',
      detail: message
    });
  }
}

/**
 * Publishes the Desktop connector on the OpenAI path, when there is one to publish.
 *
 * Every failure here is contained. Desktop is optional, the user may not have created its
 * connector yet, and the coding connector must not go down because a second tunnel id was
 * mistyped — so this reports the problem on the Desktop card and leaves the connection up.
 */
async function startDesktopTunnel(
  generation: number,
  settings: TunnelSettings,
  apiKey: string | null
): Promise<void> {
  if (settings.kind !== 'openai') return;
  const desktop = status.surfaces.find((entry) => entry.id === 'desktop');
  if (!desktop?.available || !endpoint) return;
  if (!settings.desktopTunnelId) {
    updateSurface('desktop', {
      state: 'off',
      detail: 'Not published yet. Create a second Secure Tunnel for it and paste its tunnel id in Settings.'
    });
    return;
  }

  updateSurface('desktop', { state: 'starting', detail: 'Connecting…' });
  try {
    desktopTunnelId = settings.desktopTunnelId;
    const startedDesktopTunnel = await startTunnel({
      localUrl: endpoint.urls.desktop,
      settings: { ...settings, tunnelId: settings.desktopTunnelId },
      apiKey,
      discoveryHeaders: tunnelProbeHeaders(),
      label: 'desktop',
      report: (report) => {
        if (generation !== connectionGeneration) return;
        updateSurface('desktop', {
          state: surfaceStateForConnection(report.state),
          detail: report.detail,
          ...(report.publicUrl === undefined ? {} : { publicUrl: report.publicUrl })
        });
      }
    });
    if (shutdownRequested || generation !== connectionGeneration) {
      await startedDesktopTunnel.stop().catch(() => {});
      desktopTunnelId = null;
      return;
    }
    desktopTunnel = startedDesktopTunnel;
  } catch (err) {
    if (shutdownRequested || generation !== connectionGeneration) {
      desktopTunnelId = null;
      return;
    }
    const message = err instanceof TunnelError ? err.message : (err as Error).message;
    logWarn(`desktop connector not published: ${message}`);
    desktopTunnelId = null;
    updateSurface('desktop', { state: 'error', detail: message });
  }
}

/** Stops the Desktop tunnel, if one is running, and says so on its card. */
async function stopDesktopTunnel(detail: string): Promise<void> {
  if (!desktopTunnel) return;
  await desktopTunnel.stop().catch(() => {});
  desktopTunnel = null;
  desktopTunnelId = null;
  logInfo('desktop connector unpublished');
  updateSurface('desktop', { state: 'off', detail, publicUrl: null });
}

/**
 * Re-applies connector settings to a connection that is already up.
 *
 * Desktop-only settings are applied without disturbing Core. A setting that actually changes
 * Core's transport is different: leaving the old tunnel running made saved config, setup cards
 * and the transport doing the work disagree, and could even start a new-method Desktop tunnel
 * beside an old-method Core tunnel. Those deliberate connection-setting changes reconnect the
 * serialized lifecycle here; unrelated settings saves do not.
 */
async function applySettingsImpl(): Promise<void> {
  if (shutdownRequested) return;
  if (!endpoint) return;
  const config = getConfig();
  const desiredCoreTransport = coreTransport(config.tunnel);
  if (activeCoreTransport && !sameCoreTransport(activeCoreTransport, desiredCoreTransport)) {
    logInfo('core connection settings changed; reconnecting');
    await disconnectImpl();
    await connectImpl();
    return;
  }
  const caps = effectiveCapabilities(config);
  const available = surfaceIsUseful('desktop', caps);
  if (desktopAutomationSupported() && (caps.screen || caps.control)) void prewarmComputerHelper();
  // Rebuild the cards first: permissions may have changed which tools each surface would
  // advertise, and on a whole-origin transport that is all there is to do.
  setStatus({ surfaces: describeSurfaces() });

  if (config.tunnel.kind !== 'openai') {
    if (available) {
      const desktop = status.surfaces.find((entry) => entry.id === 'desktop');
      updateSurface('desktop', {
        publicUrl: siblingPublicUrl(status.publicUrl, desktop?.localUrl ?? null),
        state: surfaceStateForConnection(status.state),
        detail: status.detail
      });
    }
    return;
  }

  if (!available) {
    await stopDesktopTunnel('Turn a desktop permission back on to publish this connector.');
    return;
  }
  if (desktopTunnel && desktopTunnelId === config.tunnel.desktopTunnelId) return;
  await stopDesktopTunnel('Reconnecting with the new tunnel…');
  await startDesktopTunnel(connectionGeneration, config.tunnel, await getSecret('openaiApiKey'));
}

/** Applies a settings change to a live connection. Safe to call while disconnected. */
export function applySettings(): Promise<void> {
  return enqueueLifecycle(applySettingsImpl);
}

async function disconnectImpl(endpointForceAfterMs?: number): Promise<void> {
  // Invalidate callbacks first; stopping a child can itself cause exit/health events.
  connectionGeneration += 1;
  // Stop local admission first and let accepted MCP calls finish recording before any
  // command process or durable writer is retired by the app-wide shutdown sequence.
  // The public tunnel may briefly see the now-closed loopback endpoint, which is preferable
  // to accepting a mutation after shutdown has already begun.
  if (endpoint) {
    const stopping = endpoint;
    endpoint = null;
    if (endpointForceAfterMs === undefined) await stopping.stop().catch(() => {});
    else await stopping.stop({ forceAfterMs: endpointForceAfterMs }).catch(() => {});
  }
  if (desktopTunnel) {
    await desktopTunnel.stop().catch(() => {});
    desktopTunnel = null;
  }
  desktopTunnelId = null;
  if (tunnel) {
    await tunnel.stop().catch(() => {});
    tunnel = null;
  }
  activeCoreTransport = null;
  if (status.state !== 'disconnected') logInfo('disconnected');
  setStatus({
    state: 'disconnected',
    detail: '',
    publicUrl: null,
    localUrl: null,
    handshakeAt: null,
    health: null,
    surfaces: describeSurfaces()
  });
}

export function connect(): Promise<void> {
  if (shutdownRequested) return Promise.resolve();
  return enqueueLifecycle(connectImpl);
}

export function disconnect(): Promise<void> {
  return enqueueLifecycle(disconnectImpl);
}

/**
 * Final app shutdown may bound the HTTP drain because the process itself is about to exit.
 * User disconnects and settings reconnects deliberately do not use this path: they keep
 * running afterward, so dropping a committed response there could make ChatGPT retry it.
 */
export function shutdownConnection(): Promise<void> {
  // Invalidate reports/publication immediately rather than after the lifecycle queue catches up.
  // Ordinary disconnect does not set this flag, so Settings can still disconnect/reconnect.
  shutdownRequested = true;
  connectionGeneration += 1;
  return enqueueLifecycle(() => disconnectImpl(30_000));
}

/** The running tunnel's own local health address, for the self-test. Null if none. */
export function tunnelHealthBase(): string | null {
  return tunnel?.healthBase?.() ?? null;
}

/** True while the local server is listening, regardless of tunnel state. */
export function isServerRunning(): boolean {
  return endpoint !== null;
}
