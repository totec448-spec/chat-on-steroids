/**
 * A self-test that answers "where exactly is this broken", one hop at a time.
 *
 * The chain from ChatGPT to a file on this PC has four links, and a failure in any of
 * them looks identical from the outside — ChatGPT just says it cannot use the
 * connector. So each link is checked separately, in order, and reported as its own
 * line: the local MCP server, the tunnel process, the tunnel's route to OpenAI, and
 * whether ChatGPT has ever actually arrived here.
 *
 * Everything is loopback-only. Nothing is sent to OpenAI, and the results contain no
 * secrets: the session token in the local URL is never included.
 */

import { getStatus, isServerRunning, tunnelHealthBase } from './connection.js';

import { effectiveCapabilities, getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import { lastRequestAt, selfTestHeaders } from './mcp/server.js';
import { lastToolCallAt } from './mcp/tools.js';
import {
  ago,
  POLL_FRESH_MS,
  readClientStatus,
  readPollHealth,
  type PollHealth
} from './tunnel/health.js';

import type { Capabilities, Check, Diagnosis, MacOSDesktopAccessStatus } from '../shared/types.js';
import { surfaceIsUseful } from './mcp/surfaces.js';
import { refreshMacOSDesktopAccess } from './computer/index.js';

async function fetchJson(
  url: string,
  body: unknown,
  timeoutMs = 5000
): Promise<{ status: number; json: unknown; text: string } | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'content-type': 'application/json',
        // Streamable HTTP servers may answer either way; accept both.
        accept: 'application/json, text/event-stream',
        // Identifies these as our own probes, so they are not counted as ChatGPT
        // having reached this app. Otherwise running the self-test would make the
        // one check that proves the connector works pass because of the self-test.
        ...selfTestHeaders()
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, json: parseRpc(text), text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Accepts a plain JSON body or an SSE stream carrying one JSON-RPC message. */
export function parseRpc(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const PROTOCOL_VERSION = '2025-06-18';

/**
 * Reports the client → OpenAI link without calling a tunnel that is still starting broken.
 *
 * The first control-plane poll is a long poll with a 30s timeout, so a client that came up
 * four seconds ago genuinely has no completed handshake yet. Reading that as "Not verified"
 * put a red problem on the self-test every single time the app started, for a connection
 * that was about to work — and it contradicted the tunnel supervisor, which already gives
 * the first poll exactly this grace before it will say a word about an outage.
 */
export function describeRoute(
  health: PollHealth | null,
  uptimeSeconds: number | null,
  nowMs = Date.now()
): Check {
  const name = 'Route to OpenAI';
  if (health === null) return { name, status: 'not-run', ok: null, detail: 'The tunnel did not report its metrics.' };

  const errors = `${health.errors ?? 0} poll error${health.errors === 1 ? '' : 's'} since start`;
  if (health.lastSuccessMs !== null && nowMs - health.lastSuccessMs <= POLL_FRESH_MS) {
    return {
      name,
      status: 'pass',
      ok: true,
      detail: `Verified — last completed handshake ${ago(health.lastSuccessMs, nowMs)}; ${errors}.`
    };
  }
  // Only a client that has *never* polled successfully gets the benefit of the doubt. One
  // that managed it once and then went quiet is a real outage, however young it is.
  if (health.lastSuccessMs === null && uptimeSeconds !== null && uptimeSeconds * 1000 < POLL_FRESH_MS) {
    return {
      name,
      status: 'not-run',
      ok: null,
      detail: `Still starting — the first poll of the control plane takes up to 30s; ${errors}.`
    };
  }
  return {
    name,
    status: 'fail',
    ok: false,
    detail: `Not verified — last completed handshake ${ago(health.lastSuccessMs, nowMs)}; ${errors}.`
  };
}

/** Pure projection used by both the live self-test and targeted regressions. */
export function describeMacOSDesktopAccess(
  access: MacOSDesktopAccessStatus | null,
  caps: Pick<Capabilities, 'screen' | 'control'>
): Check[] {
  const checks: Check[] = [];
  if (!caps.screen && !caps.control) return checks;
  if (access === null) {
    return [{
      name: 'macOS Desktop permissions',
      status: 'not-run',
      ok: null,
      detail: 'The in-process native backend has not reported its Screen Recording or Accessibility state yet.'
    }];
  }

  const check = (
    name: string,
    state: MacOSDesktopAccessStatus['screen'],
    missing: string
  ): Check => ({
    name,
    status: state === 'granted' ? 'pass' : state === 'missing' ? 'fail' : 'not-run',
    ok: state === 'granted' ? true : state === 'missing' ? false : null,
    detail:
      state === 'granted'
        ? 'Granted to the in-process Desktop backend.'
        : state === 'missing'
          ? `${missing} Fully quit and reopen the app after changing the macOS permission.`
          : access.error ?? 'The in-process Desktop backend could not determine the live TCC decision.'
  });

  if (caps.screen) {
    checks.push(check(
      'macOS Screen Recording',
      access.screen,
      'macOS denied Screen Recording to the current Desktop process. Open Privacy & Security → Device Control and Data Access.'
    ));
  }
  if (caps.control) {
    checks.push(check(
      'macOS Accessibility',
      access.accessibility,
      'macOS denied AXUIElement access to the in-process Chat On Steroids.app backend. Open Privacy & Security → Accessibility (Device Control and Data Access on newer macOS).'
    ));
  }
  return checks;
}

/** Runs an initialize + tools/list against our own loopback endpoint. */
async function checkLocalServer(url: string): Promise<Check> {
  const init = await fetchJson(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'self-test', version: '1' }
    }
  });
  if (init === null) {
    return { name: 'Local server', status: 'fail', ok: false, detail: 'No answer on the loopback address.' };
  }
  const initObj = init.json as { error?: { message?: string } } | null;
  if (init.status >= 400 || initObj?.error) {
    return {
      name: 'Local server',
      status: 'fail',
      ok: false,
      detail: `initialize failed: HTTP ${init.status} ${initObj?.error?.message ?? init.text.slice(0, 120)}`
    };
  }

  const list = await fetchJson(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listObj = list?.json as
    | { result?: { tools?: Array<{ name?: string }> }; error?: { message?: string } }
    | null;
  const tools = listObj?.result?.tools;
  if (!Array.isArray(tools)) {
    return {
      name: 'Local server',
      status: 'fail',
      ok: false,
      detail: `tools/list failed: ${listObj?.error?.message ?? `HTTP ${list?.status ?? 0}`}`
    };
  }
  const names = tools.map((t) => t.name).filter(Boolean);
  return {
    name: 'Local server',
    status: 'pass',
    ok: true,
    detail: `Answers on loopback and offers ${names.length} tool${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
  };
}

async function probeText(url: string): Promise<{ status: number; body: string } | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 3000);
  try {
    const res = await fetch(url, { signal: abort.signal });
    return { status: res.status, body: (await res.text()).trim().slice(0, 200) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tells apart "everything works" from the one failure that mimics it.
 *
 * When Developer mode is off in ChatGPT — and a ChatGPT update has been seen to switch
 * it off on its own — the connector still handshakes: this app is asked to initialize
 * and to list its tools, so every other check here goes green, while the model itself
 * is refused with FORBIDDEN and never calls a single tool. Requests arriving with no
 * tool call ever following is that exact fingerprint.
 *
 * It is not proof, because it also describes a connector nobody has used yet, so this
 * never reports a hard failure. It names the suspicion, which is the part that costs
 * an hour to work out from scratch.
 */
function developerMode(seen: number | null, called: number | null): Check {
  if (called !== null) {
    return {
      name: 'ChatGPT allowed to use the tools',
      status: 'pass',
      ok: true,
      detail: `Yes — ChatGPT last ran a tool ${ago(called)}, so Developer mode is on and the whole chain works.`
    };
  }
  if (seen === null) {
    return {
      name: 'ChatGPT allowed to use the tools',
      status: 'not-run',
      ok: null,
      detail: 'Unknown — ChatGPT has not reached this app at all yet, so there is nothing to judge.'
    };
  }
  return {
    name: 'ChatGPT allowed to use the tools',
    status: 'not-run',
    ok: null,
    detail:
      'Cannot tell — ChatGPT connected and read the tool list, but has never run a tool. ' +
      'That is normal if you have not asked it to do anything yet. If you have asked and it ' +
      'answered “does not support developer MCPs”, the cause is on ChatGPT’s side: turn ' +
      'Developer mode back on in ChatGPT → Settings → Apps & Connectors → Advanced. It can ' +
      'switch itself off after a ChatGPT update.'
  };
}

export async function runDiagnostics(): Promise<Diagnosis> {
  const checks: Check[] = [];
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  const status = getStatus();

  // 1. Is there anything to serve at all?
  const enabled = Object.entries(caps)
    .filter(([, on]) => on)
    .map(([name]) => name);
  checks.push({
    name: 'Permissions',
    status:
      enabled.length > 0 && (config.roots.length > 0 || surfaceIsUseful('desktop', caps)) ? 'pass' : 'fail',
    ok: enabled.length > 0 && (config.roots.length > 0 || surfaceIsUseful('desktop', caps)),
    detail:
      enabled.length === 0
        ? 'Nothing is switched on, so the connector would expose no tools.'
        : `${config.roots.length} folder${config.roots.length === 1 ? '' : 's'} shared; on: ${enabled.join(', ')}${config.readOnly ? ' (read-only)' : ''}`
  });

  // Ask the in-process backend that performs protected operations. A settings row or the
  // parent prompt API alone is not an authorization verdict.
  if (process.platform === 'darwin' && (caps.screen || caps.control)) {
    const access = await refreshMacOSDesktopAccess();
    checks.push(...describeMacOSDesktopAccess(access, caps));
  }

  // 2. Our own server, end to end, over the same URL the tunnel uses.
  if (!isServerRunning() || !status.localUrl) {
    checks.push({
      name: 'Local server',
      status: 'fail',
      ok: false,
      detail: 'Not running. Press Connect first.'
    });
  } else {
    checks.push(await checkLocalServer(status.localUrl));
  }

  // 3. The tunnel process itself.
  const base = tunnelHealthBase();
  if (config.tunnel.kind !== 'openai') {
    checks.push({
      name: 'Tunnel',
      status: 'skipped',
      ok: null,
      detail: `Using the ${config.tunnel.kind} path, which has no local health endpoint.`
    });
  } else if (!base) {
    checks.push({
      name: 'Tunnel',
      status: 'fail',
      ok: false,
      detail: 'The tunnel program is not running or has not reported a health address yet.'
    });
  } else {
    const ready = await probeText(`${base}/readyz`);
    checks.push({
      name: 'Tunnel',
      status: ready?.status === 200 ? 'pass' : 'fail',
      ok: ready?.status === 200,
      detail:
        ready === null
          ? 'The tunnel program is not answering on its local health address.'
          : ready.status === 200
            ? 'Running and ready.'
            : `Not ready: HTTP ${ready.status} ${ready.body}`
    });

    // 4. The link the outage actually breaks: client → OpenAI, and 5. what the tunnel
    //    thinks of us. Read together because the route check needs the client's uptime
    //    to tell "not working" apart from "has not finished starting".
    const [health, client] = await Promise.all([readPollHealth(base), readClientStatus(base)]);
    checks.push(describeRoute(health, client?.uptimeSeconds ?? null));

    if (client) {
      checks.push({
        name: 'Tunnel → this app',
        status: client.probe === null ? 'not-run' : client.probe === 'ok' ? 'pass' : 'fail',
        ok: client.probe === null ? null : client.probe === 'ok',
        detail:
          client.probe === null
            ? 'The tunnel did not report a probe result for the main channel.'
            : `Probe of the local MCP server: ${client.probe}.`
      });
      if (client.metadataError) {
        checks.push({
          name: 'Last tunnel error',
          status: 'fail',
          ok: false,
          detail: client.metadataError.slice(0, 300)
        });
      }
    }
  }

  // 6. The only end-to-end proof there is.
  const seen = lastRequestAt();
  checks.push({
    name: 'ChatGPT reaching this PC',
    status: seen === null ? 'not-run' : 'pass',
    ok: seen === null ? null : true,
    detail:
      seen === null
        ? 'No request has arrived since the server started. If ChatGPT reports an error, it never got as far as this app — that failure is on ChatGPT’s side, not here.'
        : `Last request from ChatGPT ${ago(seen)}.`
  });

  // 7. The failure that looks exactly like success: ChatGPT connects, this app
  //    answers, and the model is still not allowed to call anything.
  checks.push(developerMode(seen, lastToolCallAt()));

  const broken = checks.filter((c) => c.status === 'fail');
  const incomplete = checks.filter((c) => c.status === 'not-run');
  const summary =
    broken.length > 0
      ? `${broken.length} problem${broken.length === 1 ? '' : 's'}: ${broken.map((c) => c.name).join(', ')}.`
      : incomplete.length > 0
        ? `No failed checks · ${incomplete.length} not verified yet.`
        : 'Every required check passed.';

  logInfo(`self-test: ${summary}`);
  for (const check of checks) {
    const line = `self-test ${check.name}: ${check.detail}`;
    if (check.ok === false) logWarn(line);
    else logInfo(line);
  }

  return { checks, summary };
}
