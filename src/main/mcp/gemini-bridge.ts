/**
 * Independent Gemini remote/local access bridge running alongside the primary ChatGPT tunnel.
 *
 * Keeps ChatGPT's active transport undisturbed while giving Gemini a stable endpoint via:
 * - `'tailscale'`: zero-domain HTTPS via `tailscale funnel` (selects an unused port cleanly)
 * - `'custom'`: fixed HTTPS origin (with optional Cloudflare Named Tunnel `TUNNEL_TOKEN`)
 * - `'local'`: direct loopback URL for local Gemini CLI / IDE agents
 * - `'tunnel'`: shares the active Cloudflare/Manual tunnel when one is configured
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { GeminiBridgeMode, GeminiBridgeStatus, TunnelKind } from '../../shared/types.js';
import { hostsForOrigin, normalizeHttpsOrigin } from '../../shared/gemini-bridge.js';
import { pathEntries } from '../env.js';
import { childEnv, terminateProcessTree } from '../exec.js';
import { logInfo, logWarn } from '../logger.js';
import { locateBinary } from '../tunnel/locate.js';

const FUNNEL_PORT_CANDIDATES = [443, 8443, 10000] as const;
const TAILSCALE_STATUS_TIMEOUT_MS = 6_000;
const TAILSCALE_FUNNEL_TIMEOUT_MS = 20_000;
const TAILSCALE_ACTION_WAIT_MS = 1_500;
const NAMED_TUNNEL_READY_TIMEOUT_MS = 25_000;
const NAMED_TUNNEL_CONNECTING =
  /\b(?:Registered tunnel connection|Connection [a-f0-9-]+ registered)\b/i;

export interface ManagedTailscaleFunnel {
  binaryPath: string;
  httpsPort: number;
  localTarget: string;
}

export interface TailscaleStatusSummary {
  backendState: string;
  running: boolean;
  dnsName: string | null;
}

export interface TailscaleExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface TailscaleExecOptions {
  timeoutMs?: number;
  /** Abort early when output contains an interactive approval URL. */
  onOutputChunk?: (combined: string) => void;
}

export interface GeminiBridgeDeps {
  locateTailscale?: () => string | null;
  execTailscale?: (
    binaryPath: string,
    args: string[],
    opts?: TailscaleExecOptions
  ) => Promise<TailscaleExecResult>;
  locateCloudflared?: (hint?: string) => string | null;
  spawnNamedCloudflared?: (
    binaryPath: string,
    token: string
  ) => ChildProcess;
}

export interface GeminiBridgeStartOptions {
  mode: GeminiBridgeMode;
  localUrl: string;
  publicOrigin?: string;
  tunnelToken?: string | null;
  cloudflaredPathHint?: string;
  tunnelKind: TunnelKind;
  tunnelPublicUrl: string | null;
  previousManagedFunnel?: ManagedTailscaleFunnel | null;
  report: (status: GeminiBridgeStatus) => void;
  deps?: GeminiBridgeDeps;
}

export interface GeminiBridgeHandle {
  status: GeminiBridgeStatus;
  allowedHosts: ReadonlySet<string>;
  managedFunnel: ManagedTailscaleFunnel | null;
  stop: () => Promise<void>;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the Tailscale CLI executable on PATH or standard OS install locations. */
export function locateTailscaleBinary(): string | null {
  const fileName = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale';
  for (const dir of pathEntries()) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"|"$/g, ''), fileName);
    if (isExecutableFile(candidate)) return candidate;
  }

  const candidates: string[] =
    process.platform === 'win32'
      ? [
          path.win32.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
          path.win32.join(
            process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
            'Tailscale',
            'tailscale.exe'
          ),
          ...(process.env.LOCALAPPDATA
            ? [path.win32.join(process.env.LOCALAPPDATA, 'Programs', 'Tailscale', 'tailscale.exe')]
            : [])
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
            '/opt/homebrew/bin/tailscale',
            '/usr/local/bin/tailscale',
            path.posix.join(os.homedir(), 'bin', 'tailscale')
          ]
        : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/snap/bin/tailscale'];

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Parses `tailscale status --json` output into backend state and normalized MagicDNS hostname. */
export function parseTailscaleStatusJson(raw: string): TailscaleStatusSummary | null {
  try {
    const parsed = JSON.parse(raw) as {
      BackendState?: unknown;
      Self?: { DNSName?: unknown } | null;
    };
    if (!parsed || typeof parsed !== 'object') return null;
    const backendState = typeof parsed.BackendState === 'string' ? parsed.BackendState : '';
    const rawDns = typeof parsed.Self?.DNSName === 'string' ? parsed.Self.DNSName : '';
    const trimmedDns = rawDns.trim().replace(/\.+$/, '').toLowerCase();
    const dnsName = trimmedDns.includes('.') ? trimmedDns : null;
    return {
      backendState,
      running: backendState === 'Running',
      dnsName
    };
  } catch {
    return null;
  }
}

export interface TailscaleServeStatusShape {
  Web?: Record<
    string,
    {
      Handlers?: Record<string, { Proxy?: string }>;
    }
  >;
  TCP?: Record<string, unknown>;
  AllowFunnel?: Record<string, boolean>;
}

/** Parses `tailscale serve status --json`, defaulting safely to `{}` on blank output. */
export function parseTailscaleServeStatusJson(raw: string): TailscaleServeStatusShape {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as TailscaleServeStatusShape) : {};
  } catch {
    return {};
  }
}

function normalizeProxyTarget(raw: string): string {
  try {
    return new URL(raw.trim()).origin.toLowerCase();
  } catch {
    return raw.trim().replace(/\/+$/, '').toLowerCase();
  }
}

export interface FunnelPortSelection {
  port: number;
  alreadyLive: boolean;
}

/**
 * Picks an available Tailscale Funnel HTTPS port (`443`, `8443`, `10000`) without
 * overwriting any unrelated `serve` or `funnel` target already bound there.
 */
export function pickTailscaleFunnelPort(
  serveConfig: TailscaleServeStatusShape,
  dnsName: string,
  localTarget: string,
  preferredPort?: number | null
): FunnelPortSelection | null {
  const web = serveConfig.Web && typeof serveConfig.Web === 'object' ? serveConfig.Web : {};
  const tcp = serveConfig.TCP && typeof serveConfig.TCP === 'object' ? serveConfig.TCP : {};
  const allowFunnel =
    serveConfig.AllowFunnel && typeof serveConfig.AllowFunnel === 'object'
      ? serveConfig.AllowFunnel
      : {};
  const normalizedTarget = normalizeProxyTarget(localTarget);
  const hostLower = dnsName.trim().replace(/\.+$/, '').toLowerCase();

  const orderedPorts: number[] = [];
  if (preferredPort && FUNNEL_PORT_CANDIDATES.includes(preferredPort as (typeof FUNNEL_PORT_CANDIDATES)[number])) {
    orderedPorts.push(preferredPort);
  }
  for (const port of FUNNEL_PORT_CANDIDATES) {
    if (!orderedPorts.includes(port)) orderedPorts.push(port);
  }

  for (const port of orderedPorts) {
    const tcpKey = Object.keys(tcp).find((key) => {
      const lower = key.toLowerCase();
      return lower === String(port) || lower.endsWith(`:${port}`);
    });
    const tcpEntry = tcpKey ? (tcp[tcpKey] as { HTTPS?: unknown; TCPForward?: unknown } | null | undefined) : undefined;
    const isHttpsTcpMarker = Boolean(
      tcpEntry && typeof tcpEntry === 'object' && tcpEntry.HTTPS === true && !tcpEntry.TCPForward
    );
    if (tcpKey && !isHttpsTcpMarker) continue;
    const exactKey = `${hostLower}:${port}`;
    const matchingKey = Object.keys(web).find((key) => {
      const lower = key.toLowerCase().replace(/\.+:/, ':');
      return lower === exactKey || lower.endsWith(`:${port}`);
    });
    const entry = matchingKey ? web[matchingKey] : undefined;
    const handlers = entry?.Handlers && typeof entry.Handlers === 'object' ? entry.Handlers : null;
    const handlerEntries = handlers ? Object.entries(handlers) : [];
    if (handlerEntries.length === 0) {
      if (tcpKey) continue;
      return { port, alreadyLive: false };
    }

    const rootProxy = handlers?.['/']?.Proxy;
    const funnelKey =
      Object.keys(allowFunnel).find((key) => {
        const lower = key.toLowerCase().replace(/\.+:/, ':');
        return lower === exactKey || lower.endsWith(`:${port}`);
      }) ?? exactKey;
    const servesOurTarget =
      handlerEntries.length === 1 &&
      typeof rootProxy === 'string' &&
      normalizeProxyTarget(rootProxy) === normalizedTarget;
    if (servesOurTarget) {
      // Our own exact loopback target: reuse it. When Funnel was switched off for it (only a
      // tailnet-private serve remains), re-enable Funnel on that same port instead of reporting
      // every port as taken by "other local apps".
      return { port, alreadyLive: allowFunnel[funnelKey] === true };
    }
  }
  return null;
}

/** Extracts an HTTPS Tailscale approval or login link printed by `tailscale funnel`. */
export function extractTailscaleActionUrl(text: string): string | null {
  const matches = text.match(/https:\/\/[^\s"'<>)]+/gi) ?? [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:!?)'"]+$/, '');
    try {
      const parsed = new URL(cleaned);
      const host = parsed.hostname.toLowerCase();
      if (host === 'login.tailscale.com' || host === 'tailscale.com' || host.endsWith('.tailscale.com')) {
        return parsed.toString();
      }
    } catch {
      /* ignore malformed URL fragment */
    }
  }
  return null;
}

async function execTailscaleCli(
  binaryPath: string,
  args: string[],
  opts: TailscaleExecOptions = {}
): Promise<TailscaleExecResult> {
  const timeoutMs = opts.timeoutMs ?? TAILSCALE_STATUS_TIMEOUT_MS;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let actionGraceTimer: NodeJS.Timeout | null = null;
    let child: ChildProcess | null = null;

    const finish = (exitCode: number | null, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (actionGraceTimer) clearTimeout(actionGraceTimer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };

    try {
      child = spawn(binaryPath, args, {
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv()
      });
    } catch (err) {
      stderr = err instanceof Error ? err.message : String(err);
      finish(null, false);
      return;
    }

    const maybeHandleChunk = (): void => {
      const combined = `${stdout}\n${stderr}`;
      opts.onOutputChunk?.(combined);
      if (extractTailscaleActionUrl(combined) && !actionGraceTimer) {
        actionGraceTimer = setTimeout(() => {
          if (settled) return;
          if (child?.pid) void terminateProcessTree(child.pid, true);
          finish(null, true);
        }, TAILSCALE_ACTION_WAIT_MS);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      maybeHandleChunk();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      maybeHandleChunk();
    });
    child.once('error', (err) => {
      stderr += err.message;
      finish(null, false);
    });
    child.once('exit', (code) => {
      finish(code, false);
    });

    timer = setTimeout(() => {
      if (settled) return;
      if (child?.pid) void terminateProcessTree(child.pid, true);
      finish(null, true);
    }, timeoutMs);
  });
}

function portServesTarget(
  serveConfig: TailscaleServeStatusShape,
  httpsPort: number,
  localTarget: string
): boolean {
  const web = serveConfig.Web && typeof serveConfig.Web === 'object' ? serveConfig.Web : {};
  const normalizedTarget = normalizeProxyTarget(localTarget);
  for (const [key, entry] of Object.entries(web)) {
    const lowerKey = key.toLowerCase().replace(/\.+:/, ':');
    if (lowerKey !== String(httpsPort) && !lowerKey.endsWith(`:${httpsPort}`)) continue;
    const handlers = entry?.Handlers && typeof entry.Handlers === 'object' ? entry.Handlers : null;
    const entries = handlers ? Object.entries(handlers) : [];
    const rootProxy = handlers?.['/']?.Proxy;
    if (
      entries.length === 1 &&
      typeof rootProxy === 'string' &&
      normalizeProxyTarget(rootProxy) === normalizedTarget
    ) {
      return true;
    }
  }
  return false;
}

/** Cleanly removes only the Tailscale Funnel port listener still pointing at `managed.localTarget`. Returns true when the record may be cleared. */
export async function stopManagedTailscaleFunnel(
  managed: ManagedTailscaleFunnel | null | undefined,
  execTailscale: (binaryPath: string, args: string[], opts?: TailscaleExecOptions) => Promise<TailscaleExecResult> = execTailscaleCli
): Promise<boolean> {
  if (!managed) return true;
  try {
    const statusRes = await execTailscale(managed.binaryPath, ['serve', 'status', '--json'], {
      timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS
    });
    const raw = statusRes.stdout.trim();
    let parsed: TailscaleServeStatusShape | null = null;
    if (statusRes.exitCode === 0) {
      if (!raw) parsed = {};
      else {
        try {
          const obj = JSON.parse(raw) as unknown;
          if (obj && typeof obj === 'object') parsed = obj as TailscaleServeStatusShape;
        } catch {
          parsed = null;
        }
      }
    }
    if (!parsed) {
      logWarn(
        `skipping Tailscale Funnel off on port ${managed.httpsPort}: could not verify live serve status (keeping record pending cleanup)`
      );
      return false;
    }
    if (!portServesTarget(parsed, managed.httpsPort, managed.localTarget)) {
      logInfo(
        `skipping Tailscale Funnel off on port ${managed.httpsPort}: live mapping no longer targets ${managed.localTarget} (clearing record)`
      );
      return true;
    }
    const offRes = await execTailscale(managed.binaryPath, ['funnel', `--https=${managed.httpsPort}`, 'off'], {
      timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS
    });
    if (offRes.exitCode !== 0) {
      logWarn(
        `failed to stop Tailscale Funnel on port ${managed.httpsPort}: exit ${offRes.exitCode ?? 'null'} (keeping record pending cleanup)`
      );
      return false;
    }
    logInfo(`stopped Tailscale Funnel on port ${managed.httpsPort} for ${managed.localTarget}`);
    return true;
  } catch (err) {
    logWarn(
      `failed to stop Tailscale Funnel on port ${managed.httpsPort}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

function loopbackOrigin(rawLocalUrl: string): string {
  try {
    return new URL(rawLocalUrl).origin;
  } catch {
    return rawLocalUrl.replace(/\/+$/, '');
  }
}

function redactSecret(text: string, secret: string | null | undefined): string {
  const token = secret?.trim();
  if (!token) return text;
  return text.split(token).join('[REDACTED]');
}

function spawnNamedCloudflaredDefault(binaryPath: string, token: string): ChildProcess {
  const env = childEnv();
  env.TUNNEL_TOKEN = token;
  return spawn(binaryPath, ['tunnel', '--no-autoupdate', 'run'], {
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  });
}

function makeTunnelModeStatus(
  tunnelKind: TunnelKind,
  tunnelPublicUrl: string | null
): GeminiBridgeStatus {
  if (tunnelKind === 'openai') {
    return {
      mode: 'tunnel',
      state: 'off',
      publicOrigin: null,
      detail:
        'ChatGPT is using the OpenAI tunnel. Pick Tailscale, Custom HTTPS, or Local to run Gemini at the same time.'
    };
  }
  const normalized = tunnelPublicUrl ? normalizeHttpsOrigin(tunnelPublicUrl) : '';
  if (normalized) {
    return {
      mode: 'tunnel',
      state: 'live',
      publicOrigin: normalized,
      detail: 'Sharing the active HTTPS tunnel alongside ChatGPT.'
    };
  }
  return {
    mode: 'tunnel',
    state: tunnelKind === 'cloudflared' ? 'starting' : 'off',
    publicOrigin: null,
    detail:
      tunnelKind === 'cloudflared'
        ? 'Waiting for Cloudflare tunnel address.'
        : 'Enter a manual HTTPS tunnel address or pick Tailscale or Custom HTTPS for Gemini.'
  };
}

/**
 * Starts (or resolves) the configured Gemini bridge against `localUrl` without
 * disturbing any active ChatGPT tunnel.
 */
export async function startGeminiBridge(
  options: GeminiBridgeStartOptions
): Promise<GeminiBridgeHandle> {
  const execTailscale = options.deps?.execTailscale ?? execTailscaleCli;
  const locateTailscale = options.deps?.locateTailscale ?? locateTailscaleBinary;
  const locateCloudflared =
    options.deps?.locateCloudflared ??
    ((hint?: string) => locateBinary('cloudflared', hint));
  const spawnCloudflared =
    options.deps?.spawnNamedCloudflared ?? spawnNamedCloudflaredDefault;

  const localTarget = loopbackOrigin(options.localUrl);

  let retainedFunnel: ManagedTailscaleFunnel | null = null;
  const cleanupPreviousFunnelIfStale = async (): Promise<void> => {
    const prev = options.previousManagedFunnel;
    if (!prev) return;
    if (options.mode !== 'tailscale' || normalizeProxyTarget(prev.localTarget) !== normalizeProxyTarget(localTarget)) {
      const cleaned = await stopManagedTailscaleFunnel(prev, execTailscale);
      if (!cleaned) retainedFunnel = prev;
    }
  };

  await cleanupPreviousFunnelIfStale();

  const emit = (next: GeminiBridgeStatus): GeminiBridgeStatus => {
    options.report(next);
    return next;
  };

  if (options.mode === 'tunnel') {
    const status = emit(makeTunnelModeStatus(options.tunnelKind, options.tunnelPublicUrl));
    return {
      status,
      allowedHosts: new Set<string>(),
      managedFunnel: retainedFunnel,
      stop: async () => {
        await stopManagedTailscaleFunnel(retainedFunnel, execTailscale);
      }
    };
  }

  if (options.mode === 'local') {
    const status = emit({
      mode: 'local',
      state: 'live',
      publicOrigin: localTarget,
      detail: 'Ready for local Gemini CLI or IDE tools while ChatGPT stays connected.'
    });
    return {
      status,
      allowedHosts: new Set<string>(),
      managedFunnel: retainedFunnel,
      stop: async () => {
        await stopManagedTailscaleFunnel(retainedFunnel, execTailscale);
      }
    };
  }

  if (options.mode === 'custom') {
    const origin = normalizeHttpsOrigin(options.publicOrigin ?? '');
    if (!origin) {
      const status = emit({
        mode: 'custom',
        state: 'error',
        publicOrigin: null,
        detail: 'Enter a permanent HTTPS address (for example https://mcp.example.com).'
      });
      return {
        status,
        allowedHosts: new Set<string>(),
        managedFunnel: retainedFunnel,
        stop: async () => {
          await stopManagedTailscaleFunnel(retainedFunnel, execTailscale);
        }
      };
    }

    const allowedHosts = new Set(hostsForOrigin(origin));
    const token = options.tunnelToken?.trim() ?? '';
    if (!token) {
      const status = emit({
        mode: 'custom',
        state: 'live',
        publicOrigin: origin,
        detail: `Accepting requests for ${origin} via your reverse proxy or external tunnel.`
      });
      return {
        status,
        allowedHosts,
        managedFunnel: retainedFunnel,
        stop: async () => {
          await stopManagedTailscaleFunnel(retainedFunnel, execTailscale);
        }
      };
    }

    const cloudflaredPath = locateCloudflared(options.cloudflaredPathHint);
    if (!cloudflaredPath) {
      const status = emit({
        mode: 'custom',
        state: 'error',
        publicOrigin: origin,
        detail: 'cloudflared was not found to run your saved Cloudflare Tunnel token.'
      });
      return {
        status,
        allowedHosts,
        managedFunnel: retainedFunnel,
        stop: async () => {
          await stopManagedTailscaleFunnel(retainedFunnel, execTailscale);
        }
      };
    }

    let stopped = false;
    let readyTimer: NodeJS.Timeout | null = null;
    let lastError = '';
    const child = spawnCloudflared(cloudflaredPath, token);

    let currentStatus = emit({
      mode: 'custom',
      state: 'starting',
      publicOrigin: origin,
      detail: `Starting Cloudflare Named Tunnel for ${origin}...`
    });

    const handleLine = (rawLine: string): void => {
      if (stopped) return;
      const line = redactSecret(rawLine, token).trim();
      if (!line) return;
      if (NAMED_TUNNEL_CONNECTING.test(line)) {
        if (readyTimer) {
          clearTimeout(readyTimer);
          readyTimer = null;
        }
        currentStatus = emit({
          mode: 'custom',
          state: 'live',
          publicOrigin: origin,
          detail: `Connected to ${origin} via Cloudflare Named Tunnel.`
        });
        return;
      }
      if (/\b(?:ERR|error|failed|unauthorized|invalid)\b/i.test(line)) {
        lastError = line.slice(0, 220);
      }
    };

    if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', handleLine);
    if (child.stderr) readline.createInterface({ input: child.stderr }).on('line', handleLine);

    child.once('error', (err) => {
      if (stopped) return;
      if (readyTimer) clearTimeout(readyTimer);
      currentStatus = emit({
        mode: 'custom',
        state: 'error',
        publicOrigin: origin,
        detail: `Could not start cloudflared: ${err.message}`
      });
    });

    child.once('exit', (code) => {
      if (stopped) return;
      if (readyTimer) clearTimeout(readyTimer);
      currentStatus = emit({
        mode: 'custom',
        state: 'error',
        publicOrigin: origin,
        detail: lastError || `Cloudflare Named Tunnel stopped (exit ${code ?? 'unknown'}).`
      });
    });

    readyTimer = setTimeout(() => {
      if (stopped || currentStatus.state !== 'starting') return;
      logWarn(`Gemini Named Tunnel did not log registration within ${NAMED_TUNNEL_READY_TIMEOUT_MS}ms; check token and hostname routing.`);
    }, NAMED_TUNNEL_READY_TIMEOUT_MS);

    return {
      status: currentStatus,
      allowedHosts,
      managedFunnel: retainedFunnel,
      stop: async () => {
        if (!stopped) {
          stopped = true;
          if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = null;
          }
          if (child.pid && child.exitCode === null) {
            await terminateProcessTree(child.pid, true);
          }
        }
        await stopManagedTailscaleFunnel(retainedFunnel, execTailscale);
      }
    };
  }

  // Tailscale Funnel mode
  let carriedFunnel: ManagedTailscaleFunnel | null =
    options.mode === 'tailscale' &&
    options.previousManagedFunnel &&
    normalizeProxyTarget(options.previousManagedFunnel.localTarget) === normalizeProxyTarget(localTarget)
      ? options.previousManagedFunnel
      : null;
  const tailscaleErrorHandle = (status: GeminiBridgeStatus): GeminiBridgeHandle => ({
    status,
    allowedHosts: new Set<string>(),
    managedFunnel: carriedFunnel,
    stop: async () => {
      await stopManagedTailscaleFunnel(carriedFunnel, execTailscale);
    }
  });

  emit({
    mode: 'tailscale',
    state: 'starting',
    publicOrigin: null,
    detail: 'Checking Tailscale Funnel availability...'
  });

  const tailscalePath = locateTailscale();
  if (!tailscalePath) {
    const status = emit({
      mode: 'tailscale',
      state: 'error',
      publicOrigin: null,
      detail: 'Tailscale was not found on this PC. Install and sign in to Tailscale, then click Retry.',
      actionUrl: 'https://tailscale.com/download'
    });
    return tailscaleErrorHandle(status);
  }

  const tsStatusRes = await execTailscale(tailscalePath, ['status', '--json'], {
    timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS
  });
  const summary = parseTailscaleStatusJson(tsStatusRes.stdout);
  if (!summary) {
    const detail = redactSecret(tsStatusRes.stderr || tsStatusRes.stdout, null).trim();
    const status = emit({
      mode: 'tailscale',
      state: 'error',
      publicOrigin: null,
      detail: detail || 'Could not read Tailscale status. Make sure Tailscale is open and running.'
    });
    return tailscaleErrorHandle(status);
  }

  if (!summary.running) {
    const status = emit({
      mode: 'tailscale',
      state: 'error',
      publicOrigin: null,
      detail:
        summary.backendState === 'NeedsLogin'
          ? 'Sign in to Tailscale first, then click Retry.'
          : `Tailscale is currently ${summary.backendState || 'stopped'}. Turn it on and click Retry.`
    });
    return tailscaleErrorHandle(status);
  }

  if (!summary.dnsName) {
    const status = emit({
      mode: 'tailscale',
      state: 'error',
      publicOrigin: null,
      detail: 'Enable MagicDNS and HTTPS certificates in your Tailscale admin console, then click Retry.',
      actionUrl: 'https://login.tailscale.com/admin/dns'
    });
    return tailscaleErrorHandle(status);
  }

  const serveRes = await execTailscale(tailscalePath, ['serve', 'status', '--json'], {
    timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS
  });
  const serveConfig = parseTailscaleServeStatusJson(serveRes.stdout);
  if (carriedFunnel && serveRes.exitCode === 0 && !portServesTarget(serveConfig, carriedFunnel.httpsPort, localTarget)) {
    logInfo(
      `clearing stale Tailscale Funnel record on port ${carriedFunnel.httpsPort}: live mapping no longer targets ${localTarget}`
    );
    carriedFunnel = null;
  }
  const preferredPort =
    carriedFunnel
      ? carriedFunnel.httpsPort
      : null;
  const selection = pickTailscaleFunnelPort(serveConfig, summary.dnsName, localTarget, preferredPort);
  if (!selection) {
    const status = emit({
      mode: 'tailscale',
      state: 'error',
      publicOrigin: null,
      detail: 'Tailscale Funnel ports 443, 8443, and 10000 are already serving other local apps.'
    });
    return tailscaleErrorHandle(status);
  }

  const origin = normalizeHttpsOrigin(
    selection.port === 443
      ? `https://${summary.dnsName}`
      : `https://${summary.dnsName}:${selection.port}`
  );
  if (!origin) {
    const status = emit({
      mode: 'tailscale',
      state: 'error',
      publicOrigin: null,
      detail: 'Tailscale reported an invalid MagicDNS hostname.'
    });
    return tailscaleErrorHandle(status);
  }

  let createdByUs = false;
  if (!selection.alreadyLive) {
    const funnelRes = await execTailscale(
      tailscalePath,
      ['funnel', '--bg', `--https=${selection.port}`, '--yes', localTarget],
      { timeoutMs: TAILSCALE_FUNNEL_TIMEOUT_MS }
    );
    if (funnelRes.exitCode !== 0) {
      const combined = `${funnelRes.stdout}\n${funnelRes.stderr}`.trim();
      const actionUrl = extractTailscaleActionUrl(combined);
      const status = emit({
        mode: 'tailscale',
        state: 'error',
        publicOrigin: null,
        detail: actionUrl
          ? 'Open the Tailscale approval link to enable Funnel for this tailnet, then click Retry.'
          : combined.split(/\r?\n/).find((line) => line.trim())?.slice(0, 220) ||
            'Could not enable Tailscale Funnel on this device.',
        actionUrl
      });
      return tailscaleErrorHandle(status);
    }
    createdByUs = true;
    logInfo(`Gemini Tailscale Funnel live at ${origin} -> ${localTarget}`);
  } else if (preferredPort === selection.port) {
    // Adopted our own funnel mapping across an in-place refresh on the exact same target.
    createdByUs = true;
  }

  const managedFunnel: ManagedTailscaleFunnel | null = createdByUs
    ? { binaryPath: tailscalePath, httpsPort: selection.port, localTarget }
    : null;
  const status = emit({
    mode: 'tailscale',
    state: 'live',
    publicOrigin: origin,
    detail: `Permanent Tailscale Funnel URL active at ${origin} while ChatGPT runs independently.`
  });

  return {
    status,
    allowedHosts: new Set(hostsForOrigin(origin)),
    managedFunnel,
    stop: async () => {
      await stopManagedTailscaleFunnel(managedFunnel, execTailscale);
    }
  };
}
