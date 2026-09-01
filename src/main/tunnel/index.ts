/**
 * Connection adapters.
 *
 * The MCP server knows nothing about tunnels; it just serves a loopback URL. An
 * adapter's whole job is to make that URL reachable from ChatGPT and report state.
 * Adding another provider means adding one function here, not touching the tools.
 *
 * Two adapters ship:
 *  - openai: OpenAI's Secure MCP Tunnel. Outbound-only, nothing is published.
 *  - cloudflared: a generic HTTPS quick tunnel, for plans or accounts that cannot
 *    use the OpenAI tunnel. This one does create a public URL, so the secret path
 *    token in the URL is what keeps it private.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionState, TunnelHealth, TunnelSettings } from '../../shared/types.js';
import { childEnv, terminateProcessTree } from '../exec.js';
import { logError, logInfo, logWarn } from '../logger.js';
import { ago, POLL_FRESH_MS, readClientStatus, readPollHealth } from './health.js';
import { locateBinary } from './locate.js';

export interface TunnelReport {
  state: ConnectionState;
  detail: string;
  publicUrl?: string | null;
  /** Epoch ms of the last proven round trip to OpenAI, when the adapter knows one. */
  handshakeAt?: number | null;
  health?: TunnelHealth | null;
}

export interface TunnelStartOptions {
  /** Loopback MCP URL, including the secret path segment. */
  localUrl: string;
  settings: TunnelSettings;
  /** OpenAI control-plane API key, only for the openai adapter. */
  apiKey: string | null;
  /** Headers added only to tunnel-client's own MCP discovery/startup probes. */
  discoveryHeaders?: Record<string, string>;
  /**
   * Which connector this tunnel carries, for the log. Two of them run at once, so
   * without it every line appeared twice with nothing to say which one it was about.
   */
  label?: string;
  report: (report: TunnelReport) => void;
}

export interface TunnelHandle {
  stop: () => Promise<void>;
  /** Loopback base URL of the client's own health/metrics server, when it has one. */
  healthBase?: () => string | null;
}

export class TunnelError extends Error {}

export const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

/** Terminates an owned tunnel tree and waits for the child handle to observe exit. */
async function stopTree(child: ChildProcess | null, timeoutMs = 3_000): Promise<boolean> {
  if (!child || child.pid === undefined || child.exitCode !== null) return true;
  const closed = new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) resolve(true);
    else child.once('close', () => resolve(true));
  });
  await terminateProcessTree(child.pid).catch(() => {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  });
  return Promise.race([closed, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
}

function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let carry = '';
  return (chunk: Buffer) => {
    carry += chunk.toString('utf8');
    let at = carry.indexOf('\n');
    while (at !== -1) {
      const line = carry.slice(0, at).trimEnd();
      carry = carry.slice(at + 1);
      if (line) onLine(line);
      at = carry.indexOf('\n');
    }
    if (carry.length > 16_384) carry = '';
  };
}

const AUTH_FAILURE = /\b(401|403|unauthorized|invalid[_ ]api[_ ]key|invalid_request_error|forbidden)\b/i;

/**
 * Errors that mean "this PC cannot reach OpenAI right now", as opposed to "the tunnel
 * is broken".
 *
 * tunnel-client polls the control plane continuously and retries these itself with its
 * own backoff, so they must change what the user is told without provoking a restart.
 * They are also the *only* signal that the connection is down: the client's /readyz is
 * a local health check that stays green throughout an outage, because from its point
 * of view nothing local has failed.
 */
const UNREACHABLE =
  /poll (?:failed|timed out)|no such host|dial tcp|i\/o timeout|connection (was )?(aborted|refused|reset)|network is (unreachable|down)|no route to host|tls handshake timeout|temporary failure in name resolution|forcibly closed/i;

/** Turns a Go network error into something worth showing a person. */
export function describeNetworkError(raw: string): string {
  if (/no such host|name resolution/i.test(raw)) return 'no internet connection';
  if (/connection (was )?(aborted|reset)|forcibly closed/i.test(raw)) return 'the connection dropped';
  if (/refused/i.test(raw)) return 'the connection was refused';
  if (/timeout/i.test(raw)) return 'the connection timed out';
  if (/network is (unreachable|down)|no route to host/i.test(raw)) return 'the network is unreachable';
  return 'a network error';
}

/** True when this machine can still resolve OpenAI's control plane. */
export function isUnreachableError(raw: string): boolean {
  return UNREACHABLE.test(raw);
}

export async function startTunnel(opts: TunnelStartOptions): Promise<TunnelHandle> {
  switch (opts.settings.kind) {
    case 'openai':
      return startOpenAiTunnel(opts);
    case 'cloudflared':
      return startCloudflared(opts);
    case 'manual':
      opts.report({
        state: 'connected',
        detail: 'Local server running. Expose it with your own tunnel and use the URL below.',
        publicUrl: null
      });
      return { stop: async () => {} };
    default:
      throw new TunnelError('Unknown connection type');
  }
}

// ------------------------------------------------------------------ OpenAI

/** How often /readyz is re-checked once the tunnel is up. */
const WATCH_INTERVAL_MS = 15_000;
/** How long a fresh tunnel-client gets to reach ready before we call it a failure. */
const READY_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
/** How often to look again while the control plane is unreachable. */
const OFFLINE_RECHECK_MS = 5_000;
/**
 * How long a run of "cannot reach OpenAI" complaints must go without a completed poll
 * before the user is told the connection is down.
 *
 * One failed poll is not an outage. The client long-polls with a 30s timeout and retries
 * on its own backoff, so a single dropped read — routine on home Wi-Fi — used to flip the
 * UI to offline and log an alarming pair of lines, with "tunnel connected" following six
 * seconds later. Nothing had been wrong. What proves an outage is not the complaint, it
 * is the last *completed* poll failing to advance while the complaints keep coming, so a
 * run has to outlive a full poll cycle before it counts.
 */
const UNREACHABLE_CONFIRM_MS = 35_000;

/** A run of unreachable complaints not yet contradicted by a completed poll. */
export interface UnreachableRun {
  /** When the run began, or 0 when there is no run in progress. */
  since: number;
  /** The last completed poll known when it began; null if there had never been one. */
  handshakeBefore: number | null;
}

export const NO_OUTAGE: UnreachableRun = { since: 0, handshakeBefore: null };

/** True once a run has gone unanswered long enough to be an outage, not a retry. */
export function outageConfirmed(run: UnreachableRun, nowMs: number): boolean {
  return run.since !== 0 && nowMs - run.since >= UNREACHABLE_CONFIRM_MS;
}

/**
 * True when a poll has completed since the run began, which ends it.
 *
 * A run that started before the client had ever polled successfully ends on the first
 * success of any age; otherwise the timestamp has to have actually moved.
 */
export function outageRecovered(run: UnreachableRun, lastHandshake: number | null): boolean {
  if (run.since === 0 || lastHandshake === null) return false;
  return run.handshakeBefore === null || lastHandshake > run.handshakeBefore;
}

export type RouteObservation = 'connected' | 'offline' | 'unknown';

/** Missing metrics prove neither recovery nor failure. */
export function routeObservation(
  read: number | null,
  lastHandshake: number | null,
  run: UnreachableRun,
  nowMs: number
): RouteObservation {
  if (read === null) return 'unknown';
  if (outageConfirmed(run, nowMs)) return 'offline';
  if (lastHandshake === null) return 'unknown';
  return nowMs - lastHandshake > POLL_FRESH_MS ? 'offline' : 'connected';
}

/**
 * Runs tunnel-client and keeps it running.
 *
 * The previous version reported "connected" once and then never looked again, so a
 * tunnel that died — or came up and later went unready — left the app claiming to be
 * connected while ChatGPT got nothing. Readiness is therefore re-checked on a timer
 * for as long as the connection is meant to be up, and a client that stops or goes
 * unready is restarted with backoff instead of being abandoned.
 */
async function startOpenAiTunnel(opts: TunnelStartOptions): Promise<TunnelHandle> {
  const binary = locateBinary('tunnel-client', opts.settings.binaryPath);
  if (!binary) {
    throw new TunnelError(
      'tunnel-client was not found. Install it from github.com/openai/tunnel-client, or point at it in Connection settings.'
    );
  }
  if (!TUNNEL_ID_PATTERN.test(opts.settings.tunnelId)) {
    throw new TunnelError('Enter a tunnel ID that looks like tunnel_ followed by 32 hex characters.');
  }
  if (!opts.apiKey) {
    throw new TunnelError('Add your OpenAI tunnel API key first.');
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cglf-'));
  const healthFile = path.join(workDir, 'health.url');

  const args = [
    'run',
    '--control-plane.tunnel-id',
    opts.settings.tunnelId,
    '--health.listen-addr',
    '127.0.0.1:0',
    '--health.url-file',
    healthFile,
    '--log.format',
    'json',
    '--log.level',
    'info'
  ];

  interface ClientRun {
    proc: ChildProcess;
    lastError: string;
    unreachableReason: string;
    outage: UnreachableRun;
    lastHandshake: number | null;
    pollErrors: number;
    healthBase: string | null;
    health: TunnelHealth | null;
    shown: 'connected' | 'offline' | 'unknown' | null;
  }

  let stopped = false;
  let current: ClientRun | null = null;
  let timer: NodeJS.Timeout | null = null;
  let retirement: Promise<void> = Promise.resolve();
  /** Consecutive failed attempts, which is what the backoff grows on. */
  let attempts = 0;
  /** Names this connector in the log, since core and desktop both run one of these. */
  const tag = opts.label ? `${opts.label} tunnel` : 'tunnel';

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const showConnected = (run: ClientRun): void => {
    if (stopped || current !== run) return;
    const first = run.shown !== 'connected';
    run.shown = 'connected';
    if (first) logInfo(`${tag} connected`);
    // Re-reported on every tick, so the UI can show how fresh the proof is.
    opts.report({
      state: 'connected',
      detail: run.lastHandshake
        ? `Connected. Last verified handshake with OpenAI ${ago(run.lastHandshake)}. Pick the tunnel in ChatGPT.`
        : 'Connected. Pick the tunnel in ChatGPT.',
      handshakeAt: run.lastHandshake,
      health: run.health
    });
  };

  const showOffline = (run: ClientRun): void => {
    if (stopped || current !== run) return;
    const first = run.shown !== 'offline';
    run.shown = 'offline';
    if (first) {
      logWarn(`${tag} offline: ${run.unreachableReason} (last verified handshake ${ago(run.lastHandshake)})`);
    }
    // The state may be unchanged while the health snapshot advances. Re-report it so the UI
    // never freezes on the first offline sample.
    opts.report({
      state: 'offline',
      detail: `This PC cannot reach OpenAI — ${run.unreachableReason}. Last verified handshake ${ago(run.lastHandshake)}. ChatGPT cannot use the connector until it is back; the tunnel keeps retrying on its own.`,
      handshakeAt: run.lastHandshake,
      health: run.health
    });
  };

  const showUnknown = (run: ClientRun): void => {
    if (stopped || current !== run) return;
    run.shown = 'unknown';
    opts.report({
      state: 'connecting-tunnel',
      detail: 'Tunnel client is locally ready, but its OpenAI poll metrics are temporarily unavailable.',
      handshakeAt: run.lastHandshake,
      health: run.health
    });
  };

  /**
   * Refreshes the snapshot the UI shows, from the two local endpoints the client
   * publishes. Called on the same tick that decides connected-vs-offline, so the
   * numbers on screen are never older than the state next to them.
   */
  const refreshHealth = async (run: ClientRun): Promise<number | null | undefined> => {
    const base = run.healthBase;
    if (!base) return null;
    const [poll, client] = await Promise.all([readPollHealth(base), readClientStatus(base)]);
    if (stopped || current !== run) return undefined;
    if (poll?.lastSuccessMs) run.lastHandshake = poll.lastSuccessMs;
    // A poll completing after the complaints began is proof the link came back, so the
    // run ends here and the blip is never shown to anyone.
    if (outageRecovered(run.outage, run.lastHandshake)) {
      run.outage = NO_OUTAGE;
      run.unreachableReason = '';
    }
    run.health = {
      pollErrors: poll?.errors ?? null,
      uptimeSeconds: client?.uptimeSeconds ?? null,
      route: client?.route ?? null,
      probe: client?.probe ?? null,
      clientVersion: client?.version ?? null
    };
    if (poll && poll.errors !== null && poll.errors > run.pollErrors) {
      // Rate-limited by definition: only a rising count says anything new. Info, not
      // warn: the client retries these itself, and `showOffline` covers the case where
      // the retries stop working.
      logInfo(
        `${tag}: ${poll.errors - run.pollErrors} more poll error(s) from the control plane (${poll.errors} total)`
      );
      run.pollErrors = poll.errors;
    }
    return poll === null ? null : (poll.lastSuccessMs ?? 0);
  };

  /**
   * Records a "cannot reach OpenAI" complaint from the client's own log.
   *
   * Deliberately does not change what the user sees. The client retries these itself and
   * usually wins within seconds; `watch` is what decides, once the run has outlived a poll
   * cycle with nothing completing. One line per run is logged so a genuine outage still
   * leaves a trail, without a paragraph of Go socket text per attempt.
   */
  const noteUnreachable = (run: ClientRun, raw: string): void => {
    if (stopped || current !== run) return;
    const complainedAt = Date.now();
    run.unreachableReason = describeNetworkError(raw);
    if (run.outage.since === 0) {
      run.outage = { since: complainedAt, handshakeBefore: run.lastHandshake };
      logInfo(`${tag}: ${run.unreachableReason}; the client is retrying`);
    }
  };

  /** The caller that wins this CAS is the only restart owner for the process. */
  const restart = (run: ClientRun, detail: string, terminate: boolean): void => {
    if (stopped || current !== run) return;
    current = null;
    clearTimer();
    attempts += 1;
    const wait = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (attempts - 1));
    opts.report({
      state: 'connecting-tunnel',
      detail: `${detail} Reconnecting in ${Math.round(wait / 1000)}s…`
    });
    retirement = (async () => {
      const retired = !terminate || (await stopTree(run.proc));
      if (stopped) return;
      if (!retired) {
        // Starting B without proof that A stopped would create two owned tunnel trees. Fail
        // closed and let an explicit reconnect create a fresh supervisor instead.
        opts.report({
          state: 'tunnel-unavailable',
          detail: 'The previous tunnel client could not be stopped safely. Disconnect and reconnect to try again.'
        });
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        void launch();
      }, wait);
      timer.unref?.();
    })();
  };

  /**
   * Watches the client for as long as it is meant to be up.
   *
   * Two different failures have to be told apart. A client that goes unready is broken
   * and gets restarted. A client that cannot reach OpenAI is fine and is already
   * retrying — restarting it would only slow the recovery down — so that one is
   * reported and waited out. /readyz cannot distinguish them, because it stays green
   * while the machine is offline.
   *
   * What can distinguish them is the client's own poll metric: the timestamp of the
   * last control-plane poll that actually completed. Fresh means a live round trip to
   * OpenAI happened within the last poll cycle, which is the only honest basis for
   * saying "connected". The log lines only supply the wording for *why* it is down.
   */
  const watch = (run: ClientRun): void => {
    if (stopped || current !== run || !run.healthBase) return;
    clearTimer();
    timer = setTimeout(
      () => {
        void (async () => {
          if (stopped || current !== run || !run.healthBase) return;
          const ready = await probe(`${run.healthBase}/readyz`);
          if (stopped || current !== run) return;
          if (!ready.ok) {
            logWarn(`${tag} went unready: ${ready.detail}`);
            restart(run, ready.detail || 'The tunnel stopped responding.', true);
            return;
          }

          const read = await refreshHealth(run);
          if (read === undefined || stopped || current !== run) return;

          const observation = routeObservation(read, run.lastHandshake, run.outage, Date.now());
          if (observation === 'offline') {
            if (!run.unreachableReason) run.unreachableReason = 'it stopped answering';
            showOffline(run);
          } else if (observation === 'connected') {
            showConnected(run);
          } else {
            showUnknown(run);
          }
          watch(run);
        })();
      },
      run.shown === 'offline' ? OFFLINE_RECHECK_MS : WATCH_INTERVAL_MS
    );
    timer.unref?.();
  };

  const launch = async (): Promise<void> => {
    if (stopped || current) return;
    clearTimer();
    // A stale URL from the previous run would otherwise be read as this run's.
    await fs.rm(healthFile, { force: true }).catch(() => {});
    if (stopped || current) return;

    opts.report({
      state: 'connecting-tunnel',
      detail: attempts === 0 ? 'Starting tunnel client…' : 'Reconnecting…'
    });

    // The API key goes in the child's environment, never on the command line, so it
    // cannot be read out of the process list by other software on the machine.
    const discoveryHeaders = Object.entries(opts.discoveryHeaders ?? {})
      .map(([name, value]) => `${name}: ${value}`)
      .join(', ');
    const proc = spawn(binary, args, {
      // Keep both credentials and the secret local MCP path out of argv/process listings.
      // tunnel-client officially supports these environment-backed configuration fields.
      env: childEnv({
        CONTROL_PLANE_API_KEY: opts.apiKey ?? '',
        MCP_SERVER_URL: `url=${opts.localUrl},channel=main`,
        ...(discoveryHeaders ? { MCP_DISCOVERY_EXTRA_HEADERS: discoveryHeaders } : {})
      }),
      windowsHide: true,
      // Own a POSIX process group so stopTree terminates any helpers the client starts.
      // Windows uses taskkill /T and keeps its existing launch semantics.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const run: ClientRun = {
      proc,
      lastError: '',
      unreachableReason: '',
      outage: NO_OUTAGE,
      lastHandshake: null,
      pollErrors: 0,
      healthBase: null,
      health: null,
      shown: null
    };
    current = run;

    const handleLine = (line: string): void => {
      if (stopped || current !== run) return;
      if (AUTH_FAILURE.test(line)) {
        // A bad key or tunnel ID will not fix itself, so this one is terminal.
        stopped = true;
        current = null;
        clearTimer();
        retirement = stopTree(proc).then(() => undefined);
        opts.report({
          state: 'auth-failed',
          detail: 'The tunnel rejected the API key or tunnel ID. Check both in Connection settings.'
        });
        return;
      }

      // tunnel-client emits structured JSON. Do not treat the mere presence of an
      // `error` field as an ERROR-level event: some healthy startup WARN records carry
      // internal diagnostics there. In particular, loopback Harpoon auto-registration
      // warnings are followed by a healthy /readyz and are not actionable for users.
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const level = String(event['level'] ?? '').toUpperCase();
        const message = String(event['msg'] ?? 'tunnel-client event');
        if (
          level === 'WARN' &&
          message === 'harpoon host auto-registration failed' &&
          event['inclusion_reason'] === 'loopback'
        ) {
          return;
        }
        if (level === 'ERROR' || level === 'FATAL' || level === 'WARN') {
          const errText = event['error'] ? String(event['error']) : '';
          run.lastError = `${level} ${message}${errText ? `: ${errText}` : ''}`.slice(0, 400);
          if (isUnreachableError(message) || isUnreachableError(errText)) {
            // Retry chatter. noteUnreachable logs one plain line per run rather than a
            // socket dump per attempt, and the state it leads to is decided in `watch`.
            noteUnreachable(run, errText || message);
          } else {
            logWarn(`${tag}: ${run.lastError}`);
          }
        }
        return;
      } catch {
        // Older clients or crash paths may still print plain text.
      }
      if (/\b(error|fatal|warn)\b/i.test(line)) {
        run.lastError = line.slice(0, 400);
        if (isUnreachableError(line)) noteUnreachable(run, line);
        else logWarn(`${tag}: ${run.lastError}`);
      }
    };

    proc.stdout.on('data', lineReader(handleLine));
    proc.stderr.on('data', lineReader(handleLine));

    proc.on('exit', (code) => {
      if (stopped || current !== run) return;
      logWarn(`${tag} client exited with code ${code}`);
      restart(run, run.lastError || `Tunnel client stopped (exit ${code}).`, false);
    });

    proc.on('error', (err) => {
      if (stopped || current !== run) return;
      logError(`${tag} client failed to start: ${err.message}`);
      restart(run, `Could not start tunnel-client: ${err.message}`, true);
    });

    // /readyz on the client's own health server is the authoritative "it works"
    // signal; the process being alive proves nothing.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!stopped && current === run && Date.now() < deadline) {
      const base = await readHealthUrl(healthFile);
      if (stopped || current !== run) return;
      if (base) {
        const ready = await probe(`${base}/readyz`);
        if (stopped || current !== run) return;
        if (ready.ok) {
          attempts = 0;
          run.healthBase = base;
          const read = await refreshHealth(run);
          if (read === undefined || stopped || current !== run) return;
          const observation = routeObservation(read, run.lastHandshake, run.outage, Date.now());
          if (observation === 'offline') {
            if (!run.unreachableReason) run.unreachableReason = 'it stopped answering';
            showOffline(run);
          } else if (observation === 'connected') {
            showConnected(run);
          } else {
            showUnknown(run);
          }
          watch(run);
          return;
        }
        run.lastError = ready.detail || run.lastError;
      }
      await delay(1000);
    }
    if (!stopped && current === run) {
      restart(run, run.lastError || 'The tunnel did not become ready within 60 seconds.', true);
    }
  };

  void launch();

  return {
    healthBase: () => current?.healthBase ?? null,
    stop: async () => {
      stopped = true;
      clearTimer();
      const active = current;
      current = null;
      await Promise.all([retirement, stopTree(active?.proc ?? null)]);
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

async function readHealthUrl(file: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(file, 'utf8')).trim();
    return text.startsWith('http') ? text.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

interface ProbeResult {
  ok: boolean;
  /** The body tunnel-client returned, which names the reason it is not ready. */
  detail: string;
}

async function probe(url: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    // /readyz answers 503 with the reason in the body — "oauth discovery failed: …",
    // "mcp probe failed: …" — which is far more useful than a generic message.
    const body = await res.text().catch(() => '');
    return { ok: res.ok, detail: body.trim().slice(0, 200) };
  } catch {
    return { ok: false, detail: '' };
  } finally {
    clearTimeout(timer);
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- cloudflared

async function startCloudflared(opts: TunnelStartOptions): Promise<TunnelHandle> {
  const binary = locateBinary('cloudflared', opts.settings.binaryPath);
  if (!binary) {
    throw new TunnelError(
      'cloudflared was not found. It ships alongside tunnel-client, or install it from Cloudflare, then point at it in Connection settings.'
    );
  }

  const local = new URL(opts.localUrl);
  const origin = `${local.protocol}//${local.host}`;

  const args = [
    'tunnel',
    '--no-autoupdate',
    '--url',
    origin,
    // Without this the origin would see the public trycloudflare hostname and our
    // loopback Host check would reject the request.
    '--http-host-header',
    local.host
  ];

  opts.report({ state: 'connecting-tunnel', detail: 'Starting cloudflared…' });

  const child = spawn(binary, args, {
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Tunnel providers need the ordinary OS environment, never credentials inherited
    // from a terminal that happened to launch Electron.
    env: childEnv()
  });

  let settled = false;
  let stopped = false;
  let lastError = '';

  const handleLine = (line: string): void => {
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line);
    if (match && !settled) {
      settled = true;
      const publicUrl = `${match[0]}${local.pathname}`;
      logInfo('quick tunnel connected');
      opts.report({
        state: 'connected',
        detail: 'Connected. Paste the URL below into ChatGPT as a custom connector.',
        publicUrl
      });
      return;
    }
    if (/\berr\b|\berror\b|\bfatal\b/i.test(line)) {
      lastError = line.slice(0, 400);
      logWarn(`cloudflared: ${lastError}`);
    }
  };

  child.stdout.on('data', lineReader(handleLine));
  child.stderr.on('data', lineReader(handleLine));

  child.on('exit', (code) => {
    if (stopped) return;
    settled = true;
    opts.report({
      state: 'tunnel-unavailable',
      detail: lastError || `cloudflared stopped (exit ${code}).`
    });
  });
  child.on('error', (err) => {
    settled = true;
    opts.report({ state: 'tunnel-unavailable', detail: `Could not start cloudflared: ${err.message}` });
  });

  const startupTimer = setTimeout(() => {
    if (!settled && !stopped) {
      opts.report({
        state: 'tunnel-unavailable',
        detail: lastError || 'cloudflared did not report a public URL within 45 seconds.'
      });
    }
  }, 45_000);
  startupTimer.unref?.();

  return {
    stop: async () => {
      stopped = true;
      clearTimeout(startupTimer);
      await stopTree(child);
    }
  };
}
