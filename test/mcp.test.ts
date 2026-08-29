/**
 * End-to-end test of the real MCP endpoint over real HTTP.
 *
 * Nothing here is mocked: it starts the same server the app starts, and speaks the
 * same wire protocol ChatGPT speaks. It covers both protocol eras the SDK serves —
 * the 2025-era requests ChatGPT sends today, and the 2026-07-28 envelope form — so
 * that a change in which era the client uses cannot silently break the connector.
 *
 * The other thing it exists to prove is the surface split. This app publishes two
 * independently discoverable MCP servers, Core and Desktop, and the whole point of that
 * design is that the boundary is *real*: a no-query tools/list against Core must not
 * reveal a single Desktop schema, and a Core tools/call for a Desktop tool must fail as
 * an unknown tool rather than being quietly forwarded. Those assertions live in
 * "surface boundaries" below and are the ones to look at first if this file goes red.
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectiveCapabilities, defaultConfig } from '../src/main/config.js';
import { lastRequestAt, selfTestHeaders, startMcpServer, tunnelProbeHeaders, type McpEndpoint } from '../src/main/mcp/server.js';
import { lastToolCallAt, type ToolContext } from '../src/main/mcp/tools.js';
import { friendlyError } from '../src/main/mcp/kernel.js';
import { SURFACE_LIST, surfaceDefinition, type SurfaceId } from '../src/main/mcp/surfaces.js';
import {
  appendEvent,
  createSession,
  initSessionStore,
  upsertMessageEvent,
  writeOverflowText
} from '../src/main/session/store.js';
import { resetWorkspaces, setWorkspaceFor } from '../src/main/workspace.js';
import { DEFAULT_CAPABILITIES, type Capabilities, type Root } from '../src/shared/types.js';
import { emptyEvidence, noteExec, noteOutcome, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { execOwner, noteExecOwner, resetExecOwnershipForTests } from '../src/main/codex/ownership.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { locateRipgrep } from '../src/main/ripgrep.js';
import { IS_WINDOWS, makeTempDir, removeTempDir, writeTree } from './helpers.js';

// ---------------------------------------------------------------- transport

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function rawPost(
  urlStr: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function rawGet(urlStr: string): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Streamable HTTP may answer as JSON or as a one-shot SSE stream. Accept both. */
function decode(res: RawResponse): any {
  const text = res.text.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const datas = [...text.matchAll(/^data:\s*(.*)$/gm)].map((m) => m[1] ?? '');
  const last = datas.at(-1);
  if (last !== undefined) {
    try {
      return JSON.parse(last);
    } catch {
      return text;
    }
  }
  return text;
}

let nextId = 1;

/**
 * A 2025-era request to one surface: a plain JSON-RPC body with no _meta envelope.
 *
 * Every request names its surface, because "which server answered" is the property most
 * of this file is about. There is no default-surface helper on purpose.
 */
async function call(surface: SurfaceId, method: string, params: unknown = {}): Promise<any> {
  const res = await rawPost(
    endpoint.urls[surface],
    JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  );
  return { status: res.status, body: decode(res) };
}

const core = (method: string, params: unknown = {}): Promise<any> => call('core', method, params);
const desktop = (method: string, params: unknown = {}): Promise<any> => call('desktop', method, params);

const PROTOCOL_2026 = '2026-07-28';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

/**
 * A 2026-07-28 request: the per-request _meta envelope plus the SEP-2243 standard
 * headers the spec requires the client to mirror the body with.
 */
async function modern(
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {}
): Promise<any> {
  const body = {
    jsonrpc: '2.0',
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        [META_VERSION]: PROTOCOL_2026,
        [META_CAPABILITIES]: {}
      }
    }
  };
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': PROTOCOL_2026,
    'Mcp-Method': method,
    ...extraHeaders
  };
  if (method === 'tools/call' && typeof params['name'] === 'string' && !('Mcp-Name' in headers)) {
    headers['Mcp-Name'] = params['name'];
  }
  const res = await rawPost(endpoint.urls.core, JSON.stringify(body), headers);
  return { status: res.status, body: decode(res) };
}

const toolNames = (reply: any): string[] =>
  ((reply.body?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name).sort();

const toolList = (reply: any): Array<Record<string, any>> => (reply.body?.result?.tools ?? []) as Array<Record<string, any>>;

const textOf = (reply: any): string =>
  ((reply.body?.result?.content ?? []) as Array<{ text?: string }>)
    .map((c) => c.text ?? '')
    .join('\n');

const failed = (reply: any): boolean => reply.body?.error !== undefined || reply.body?.result?.isError === true;

/** A patch that only adds one file, which is the cheapest way to prove apply_patch ran. */
const addPatch = (virtualPath: string, lines: string[]): string =>
  ['*** Begin Patch', `*** Add File: ${virtualPath}`, ...lines.map((line) => `+${line}`), '*** End Patch'].join('\n');

// ------------------------------------------------------------------ fixture

let base: string;
let approved: string;
let outside: string;
let endpoint: McpEndpoint;
let ctx: ToolContext;

function withCaps(overrides: Partial<Capabilities>): Capabilities {
  return { ...DEFAULT_CAPABILITIES, ...overrides };
}

/** Everything the user could possibly switch on, which is the worst case for discovery. */
function allCaps(): Capabilities {
  const caps = { ...DEFAULT_CAPABILITIES };
  for (const key of Object.keys(caps) as Array<keyof Capabilities>) caps[key] = true;
  return caps;
}

beforeAll(async () => {
  base = await makeTempDir('clf-mcp-');
  // This suite calls real tools, and calling a tool records it. Recording is on by
  // default now, so without a directory of its own the recorder wrote session folders
  // into the process's working directory — which for a test run is the repository.
  initSessionStore(base);
  approved = path.join(base, 'workspace');
  outside = path.join(base, 'private');
  await writeTree(approved, {
    'notes.txt': Array.from({ length: 50 }, (_, i) => `note line ${i + 1}`).join('\n') + '\n',
    'src/app.ts': 'export const name = "app";\n',
    'src/lib/util.ts': 'export const helper = 1;\n',
    'node_modules/pkg/noise.js': 'generated dependency noise\n'
  });
  await writeTree(outside, { 'passwords.txt': 'hunter2' });
  await fs.writeFile(
    path.join(approved, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  );

  ctx = {
    roots: [{ name: 'workspace', path: approved }] as Root[],
    caps: withCaps({}),
    readOnly: true,
    // Stated rather than inherited from the saved config. These two are whole features
    // with their own defaults — recording now starts on — and a capability-gating test
    // that silently changes meaning when a product default moves is not testing gating.
    // The tools they add are covered by their own suites.
    sessionTools: false,
    agentTools: false
  };
});

afterAll(async () => {
  if (endpoint) await endpoint.stop();
  // Every live exec test uses UnifiedExecProcessManager. The old teardown still stopped the
  // retired connector-native process manager, which meant it looked like this suite protected
  // the fixture from leaked shells while production sessions were completely untouched.
  await unifiedExecManager.terminateAllProcesses();
  await removeTempDir(base);
});

beforeEach(async () => {
  if (endpoint) await endpoint.stop();
  resetWorkspaces();
  ctx.caps = withCaps({});
  ctx.readOnly = true;
  ctx.roots = [{ name: 'workspace', path: approved }];
  ctx.sessionTools = false;
  ctx.agentTools = false;
  // A fresh endpoint gives every test a fresh ChatGPT tool-surface snapshot. Tests
  // that change permissions mid-flight still exercise the real live-config path.
  endpoint = await startMcpServer(() => ctx);
});

// ------------------------------------------------------------------- tests

describe('endpoint hardening', () => {
  it('does not expose native paths from uncommon filesystem errors', () => {
    const error = Object.assign(new Error(`ELOOP: too many symbolic links, realpath '${approved}\\loop\\file.txt'`), {
      code: 'ELOOP',
      path: path.join(approved, 'loop', 'file.txt'),
      syscall: 'realpath'
    });
    const text = friendlyError(error);
    expect(text).toBe('Filesystem error (ELOOP)');
    expect(text).not.toContain(approved);
  });

  it('binds to loopback only, and gives every surface its own path', () => {
    for (const surface of SURFACE_LIST) {
      const url = endpoint.urls[surface.id];
      expect(url.startsWith('http://127.0.0.1:'), surface.id).toBe(true);
      expect(new URL(url).pathname.startsWith(`/mcp/${surface.id}/`), surface.id).toBe(true);
    }
    expect(endpoint.url).toBe(endpoint.urls.core);
    expect(endpoint.urls.core).not.toBe(endpoint.urls.desktop);
  });

  it('gives each surface its own token, so handing out one does not hand out the other', async () => {
    const coreUrl = new URL(endpoint.urls.core);
    const desktopUrl = new URL(endpoint.urls.desktop);
    const coreToken = coreUrl.pathname.split('/').pop() ?? '';
    const desktopToken = desktopUrl.pathname.split('/').pop() ?? '';
    expect(coreToken).not.toBe(desktopToken);

    // Knowing Core's token must not be enough to reach Desktop. This is the property that
    // makes "share the Desktop connector" and "share everything" different acts.
    const swapped = new URL(endpoint.urls.desktop);
    swapped.pathname = `/mcp/desktop/${coreToken}`;
    const res = await rawPost(swapped.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('serves nothing at a path without the secret token', async () => {
    const wrong = new URL(endpoint.urls.core);
    for (const p of ['/', '/mcp', '/mcp/', '/mcp/core', '/mcp/core/', '/mcp/core/wrong-token', '/mcp/desktop/wrong']) {
      wrong.pathname = p;
      const res = await rawPost(wrong.toString(), '{}');
      expect(res.status, p).toBe(404);
    }
  });

  it('rejects a token of the right length but the wrong value', async () => {
    const url = new URL(endpoint.urls.core);
    const token = url.pathname.split('/').pop() ?? '';
    // Same length, so the comparison itself has to reject it.
    url.pathname = `/mcp/core/${'A'.repeat(token.length)}`;
    const res = await rawPost(url.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('rejects a non-loopback Host header on every surface', async () => {
    for (const surface of SURFACE_LIST) {
      const res = await rawPost(
        endpoint.urls[surface.id],
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { host: 'files.example.com' }
      );
      expect(res.status, surface.id).toBeGreaterThanOrEqual(400);
      expect(res.status, surface.id).toBeLessThan(500);
    }
  });

  it('rejects a cross-site Origin header on every surface', async () => {
    for (const surface of SURFACE_LIST) {
      const res = await rawPost(
        endpoint.urls[surface.id],
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { origin: 'https://evil.example.com' }
      );
      expect(res.status, surface.id).toBeGreaterThanOrEqual(400);
      expect(res.status, surface.id).toBeLessThan(500);
    }
  });

  it('never answers with a non-JSON body, whatever is asked for', async () => {
    // tunnel-client's OAuth discovery decodes these bodies as JSON regardless of the
    // status code. A plain-text "Not found" here is what broke discovery outright.
    const url = new URL(endpoint.urls.core);
    for (const p of ['/', '/mcp', '/mcp/core', '/favicon.ico', '/.well-known/oauth-protected-resource']) {
      url.pathname = p;
      const res = await rawGet(url.toString());
      expect(res.status, p).toBe(404);
      expect(res.headers['content-type'], p).toContain('application/json');
      expect(() => JSON.parse(res.text), p).not.toThrow();
    }
  });

  it('separates "ChatGPT arrived" from "ChatGPT was allowed to run a tool"', async () => {
    // The whole point of keeping two clocks: a connect that handshakes and lists
    // tools but never calls one is what Developer mode being off looks like here,
    // and it is indistinguishable from success on every other signal.
    expect(lastRequestAt()).toBeNull();
    expect(lastToolCallAt()).toBeNull();

    await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' }
    });
    await core('tools/list');
    expect(lastRequestAt()).not.toBeNull();
    expect(lastToolCallAt()).toBeNull();

    await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('counts a request to either surface as ChatGPT reaching this PC', async () => {
    expect(lastRequestAt()).toBeNull();
    await desktop('tools/list');
    expect(lastRequestAt()).not.toBeNull();
  });

  // With an optional second connector, one global clock cannot answer the question the
  // setup screen actually asks: did the user create THIS connector in ChatGPT? Core
  // traffic says nothing about Desktop, so each surface keeps its own pair.
  it('keeps a separate arrival and tool-call clock per surface', async () => {
    expect(lastRequestAt('core')).toBeNull();
    expect(lastRequestAt('desktop')).toBeNull();

    await core('tools/list');
    expect(lastRequestAt('core')).not.toBeNull();
    expect(lastRequestAt('desktop')).toBeNull();
    expect(lastToolCallAt('core')).toBeNull();

    await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(lastToolCallAt('core')).not.toBeNull();
    expect(lastToolCallAt('desktop')).toBeNull();

    ctx.caps = withCaps({ screen: true });
    await desktop('tools/list');
    expect(lastRequestAt('desktop')).not.toBeNull();
    expect(lastToolCallAt('desktop')).toBeNull();
  });

  it('counts a refused tool call, because the question is whether we were called', async () => {
    // A disabled tool still proves ChatGPT is allowed to reach the tool layer, which
    // is the only thing this clock is asked about.
    await core('tools/list');
    ctx.caps = withCaps({ read: false, browse: false, metadata: false });
    const res = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } });
    expect(JSON.stringify(res.body)).toContain('TOOL_DISABLED');
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('does not let the app’s own self-test count as ChatGPT reaching this PC', async () => {
    expect(lastRequestAt()).toBeNull();
    await rawPost(endpoint.urls.core, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), {
      ...selfTestHeaders()
    });
    expect(lastRequestAt()).toBeNull();

    // Anyone else claiming the header without the per-session value is just a caller.
    await rawPost(endpoint.urls.core, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), {
      'x-local-self-test': 'guessed'
    });
    expect(lastRequestAt()).not.toBeNull();
  });

  it('does not count tunnel-client discovery/startup probes as ChatGPT traffic', async () => {
    expect(lastRequestAt()).toBeNull();
    await rawPost(
      endpoint.urls.core,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }
      }),
      tunnelProbeHeaders()
    );
    expect(lastRequestAt()).toBeNull();
  });

  it('serves protected resource metadata per surface, naming that surface', async () => {
    for (const surface of SURFACE_LIST) {
      const url = new URL(endpoint.urls[surface.id]);
      url.pathname = `/.well-known/oauth-protected-resource${url.pathname}`;
      const res = await rawGet(url.toString());

      expect(res.status, surface.id).toBe(200);
      expect(res.headers['content-type'], surface.id).toContain('application/json');

      const metadata = JSON.parse(res.text);
      // RFC 9728 requires `resource`; it must name this exact endpoint.
      expect(metadata.resource, surface.id).toBe(endpoint.urls[surface.id]);
      expect(metadata.resource_name, surface.id).toBe(surface.connectorName);
      // No authorization server means "not OAuth protected", which is the truth here
      // and stops a client from starting a flow it can never complete.
      expect(metadata.authorization_servers, surface.id).toEqual([]);
    }
  });

  it('does not leak either secret token at the unauthenticated well-known root', async () => {
    const url = new URL(endpoint.urls.core);
    const tokens = SURFACE_LIST.map((surface) => new URL(endpoint.urls[surface.id]).pathname.split('/').pop() ?? '');
    url.pathname = '/.well-known/oauth-protected-resource';
    const res = await rawGet(url.toString());
    expect(res.status).toBe(404);
    for (const token of tokens) expect(res.text).not.toContain(token);
  });

  it('rejects a body that declares an oversized content-length', async () => {
    const url = new URL(endpoint.urls.core);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(64 * 1024 * 1024)
          }
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        }
      );
      req.on('error', reject);
      // Deliberately never finished: the guard must answer on the headers alone.
      req.write('{"jsonrpc":"2.0"');
    });
    expect(status).toBe(413);
  });

  it('enforces the same body cap on chunked requests with no content-length', async () => {
    const url = new URL(endpoint.urls.core);
    const status = await new Promise<number>((resolve, reject) => {
      let answered = false;
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json' }
        },
        (res) => {
          answered = true;
          resolve(res.statusCode ?? 0);
          res.resume();
        }
      );
      req.on('error', (error) => {
        if (!answered) reject(error);
      });
      req.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","padding":"');
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      for (let index = 0; index < 129; index++) req.write(chunk);
      req.end('"}');
    });
    expect(status).toBe(413);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });

  it('survives a malformed body and keeps serving', async () => {
    const res = await rawPost(endpoint.urls.core, '{ this is not json');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });

  it('survives a JSON body that is not a JSON-RPC message', async () => {
    const res = await rawPost(endpoint.urls.core, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });
});

// ---------------------------------------------------------------------------
// The design this whole redesign exists for.
// ---------------------------------------------------------------------------

describe('surface boundaries', () => {
  /** Turns everything on, so each surface advertises the most it ever can. */
  const everything = (): void => {
    ctx.caps = allCaps();
    ctx.readOnly = false;
    ctx.sessionTools = true;
    ctx.agentTools = true;
  };

  it('advertises exactly Core’s tools on Core, with nothing from Desktop', async () => {
    everything();
    const names = toolNames(await core('tools/list'));
    // find is absent because exec_command is present — they are mutually exclusive.
    expect(names).toEqual(['agents', 'apply_patch', 'exec_command', 'read', 'session', 'view_image', 'write_stdin']);
    for (const name of surfaceDefinition('desktop').tools) expect(names, name).not.toContain(name);
  });

  /**
   * The multi-agent field that no longer exists, everywhere it used to appear.
   *
   * Every tool once carried an optional `agent_key`, because a worker had to say who it was
   * on every call it made. A worker is now the chat it is in, so there is nothing for a model
   * to carry and nothing for one to invent — which is what this checks, since the prime
   * inventing a key for itself was a schema-reading failure, not a runtime one. The schema is
   * also the only thing ChatGPT caches per connector session, so a field absent here is a
   * field that cannot come back without a reconnect.
   */
  const keyFields = async (surface: 'core' | 'desktop'): Promise<string[]> => {
    return toolList(await call(surface, 'tools/list'))
      .filter((tool) => {
        const properties = Object.keys(tool.inputSchema?.properties ?? {});
        return properties.some((name) => name === 'agent_key' || name.endsWith('_key')) && tool.name !== 'agents';
      })
      .map((tool) => tool.name as string);
  };

  it('offers no key field on any tool, with multi-agent fully on', async () => {
    everything();
    expect(await keyFields('core')).toEqual([]);
    expect(await keyFields('desktop')).toEqual([]);

    // Not even on `agents`, which used to keep one for recovery. An agent is the ChatGPT
    // conversation it runs in, and there is now no argument anywhere that says otherwise.
    const agentsTool = toolList(await core('tools/list')).find((tool) => tool.name === 'agents')!;
    for (const field of Object.keys(agentsTool.inputSchema.properties)) {
      expect(field, field).not.toMatch(/key|secret|token/i);
    }

    // And an ordinary read from a worker's chat carries nothing at all.
    const call1 = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(failed(call1)).toBe(false);
  });

  it('removes the agents tool entirely once multi-agent is switched off', async () => {
    everything();
    expect(toolNames(await core('tools/list'))).toContain('agents');

    // The user switches the feature off and reconnects the connector, which is the one
    // reload the design is allowed to ask for. A fresh endpoint is what that reconnection
    // looks like from here.
    ctx.agentTools = false;
    await endpoint.stop();
    endpoint = await startMcpServer(() => ctx);

    expect(toolNames(await core('tools/list'))).not.toContain('agents');
    // And with it every word of the multi-agent vocabulary: nothing is left for a model to
    // aim a spawn or a handoff at.
    for (const surface of [toolList(await core('tools/list')), toolList(await desktop('tools/list'))]) {
      expect(JSON.stringify(surface)).not.toMatch(/prime|worker|swarm/i);
    }
  });

  it('advertises exactly Desktop’s tools on Desktop, with nothing from Core', async () => {
    everything();
    const names = toolNames(await desktop('tools/list'));
    expect(names).toEqual(['computer', 'observe']);
    for (const name of surfaceDefinition('core').tools) expect(names, name).not.toContain(name);
  });

  it('does not let Desktop discovery freeze Core’s mutually-exclusive tool shape', async () => {
    // Core has not been queried yet. A Desktop request must not count as a cached Core
    // snapshot, because ChatGPT caches these two connectors independently.
    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, screen: true });
    expect(toolNames(await desktop('tools/list'))).toEqual(['observe']);

    // Before Core's first discovery the user enables command execution. Core should make
    // its one-time find-vs-exec choice from *this* state, not the state Desktop happened to
    // observe earlier.
    ctx.caps = withCaps({ search: true, command: true, screen: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).toContain('write_stdin');
    expect(names).not.toContain('find');
  });

  it('never advertises a tool its surface does not declare', async () => {
    everything();
    for (const surface of SURFACE_LIST) {
      const declared = new Set(surface.tools);
      for (const name of toolNames(await call(surface.id, 'tools/list'))) {
        expect(declared.has(name), `${surface.id} advertised ${name}`).toBe(true);
      }
    }
  });

  it('leaks no Desktop schema text into a no-query Core discovery, and vice versa', async () => {
    everything();
    const coreBody = JSON.stringify((await core('tools/list')).body);
    const desktopBody = JSON.stringify((await desktop('tools/list')).body);

    // Not just the names: the action vocabulary of the other surface must be absent too,
    // because a schema fragment is what a discovery pull actually costs.
    for (const marker of ['computer', 'observe', 'click_ref', 'captureAfter', 'write_clipboard']) {
      expect(coreBody, marker).not.toContain(marker);
    }
    for (const marker of ['apply_patch', 'exec_command', 'write_stdin', 'save_handoff', 'Begin Patch']) {
      expect(desktopBody, marker).not.toContain(marker);
    }
  });

  it('fails a cross-surface tools/call as an unknown tool rather than forwarding it', async () => {
    everything();
    // Core has no `computer` handler registered at all, so this must die in the protocol
    // layer. If this ever starts succeeding, the split has become decoration.
    const onCore = await core('tools/call', { name: 'computer', arguments: { actions: [{ type: 'wait', ms: 0 }] } });
    expect(failed(onCore)).toBe(true);
    expect(JSON.stringify(onCore.body)).not.toContain('Done:');

    const onDesktop = await desktop('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(failed(onDesktop)).toBe(true);
    expect(textOf(onDesktop)).not.toContain('export const name');
    expect(JSON.stringify(onDesktop.body)).not.toContain('export const name');
  });

  it('has retired every tool name the old surface published', async () => {
    everything();
    const retired = [
      'list_roots',
      'read_file',
      'read_files',
      'list_directory',
      'search_files',
      'file_info',
      'create_file',
      'write_file',
      'write_binary_file',
      'edit_file',
      'edit_files',
      'move_path',
      'delete_file',
      'delete_directory',
      'run_command',
      'run_powershell',
      'launch_app',
      'open_url',
      'process',
      'screenshot',
      'list_windows',
      'wait_for_window',
      'find_ui',
      'read_clipboard',
      'write_clipboard',
      'resume_session',
      'session_history',
      'session_status',
      'save_handoff',
      'spawn_agents',
      'join_agent',
      'agent_message',
      'agent_status',
      'agent_inbox',
      'finish_agent'
    ];
    const advertised = new Set([...toolNames(await core('tools/list')), ...toolNames(await desktop('tools/list'))]);
    for (const name of retired) expect(advertised.has(name), name).toBe(false);

    // No aliases either. A retired name must be unknown to both servers, not silently
    // accepted by the one that used to own it.
    for (const name of ['read_file', 'edit_file', 'screenshot', 'join_agent']) {
      expect(failed(await core('tools/call', { name, arguments: {} })), name).toBe(true);
      expect(failed(await desktop('tools/call', { name, arguments: {} })), name).toBe(true);
    }
  });

  it('keeps the worst-case no-query discovery of each surface small', async () => {
    everything();
    const coreTools = toolList(await core('tools/list'));
    const desktopTools = toolList(await desktop('tools/list'));

    // Counts are the design: Core is capped at seven live schemas because find and the exec
    // pair cannot both exist, and Desktop is two.
    expect(coreTools).toHaveLength(7);
    expect(desktopTools).toHaveLength(2);

    // And the size, which is what a discovery pull actually costs the model on every
    // conversation that touches the connector. The ceilings sit just above what the
    // surface measures today (core 12.5k, desktop 7.9k on 2026-08-17) rather than at a
    // round number well above it: a budget with room to spare is a budget that never
    // catches the regression it exists to catch.
    const coreBytes = Buffer.byteLength(JSON.stringify(coreTools), 'utf8');
    const desktopBytes = Buffer.byteLength(JSON.stringify(desktopTools), 'utf8');
    expect(coreBytes, `core tools/list is ${coreBytes} bytes`).toBeLessThan(18_000);
    expect(desktopBytes, `desktop tools/list is ${desktopBytes} bytes`).toBeLessThan(8_500);

    // Per tool as well as per surface, so one schema cannot quietly eat the whole budget
    // while the total stays under it. `computer` is the largest by design: fourteen
    // discriminated action variants, each spelling out its own arguments, is what keeps
    // its validation errors small and its action set explicit. `exec_command` earns a narrow
    // exception for the `cmds` contract that removes whole connector round trips, including
    // the one-shell and per-command-exit semantics. `agents` is the other exception: its description is where the prime learns to write
    // shared context once instead of per worker, to batch messages into one call, and to
    // hand back RESULT/CHANGES/VALIDATION/BLOCKERS — bytes spent once at discovery to save
    // a great many in every run that follows.
    for (const tool of [...coreTools, ...desktopTools]) {
      const bytes = Buffer.byteLength(JSON.stringify(tool), 'utf8');
      const budget =
        tool.name === 'computer'
          ? 6_000
          : tool.name === 'apply_patch'
            ? 5_000
            : tool.name === 'agents'
              ? 3_400
              : tool.name === 'exec_command'
                ? 3_500
                : 3_000;
      expect(bytes, `${tool.name} schema is ${bytes} bytes`).toBeLessThan(budget);
    }
  });

  it('describes both surfaces well enough for a user to set them up and a model to find them', () => {
    for (const surface of SURFACE_LIST) {
      expect(surface.serverName, surface.id).toMatch(/^chat-on-steroids-/);
      expect(surface.connectorName, surface.id).toContain('Chat On Steroids');
      expect(surface.cardSummary.length, surface.id).toBeGreaterThan(20);
      // The description is the only thing the model has before discovery, so it has to
      // carry real vocabulary rather than a label.
      expect(surface.description.length, surface.id).toBeGreaterThan(120);
      expect(surface.tools.length, surface.id).toBeGreaterThan(0);
    }
    expect(surfaceDefinition('core').required).toBe(true);
    expect(surfaceDefinition('desktop').required).toBe(false);
    // Distinct names, because the connector name is also the retrieval handle.
    expect(surfaceDefinition('core').connectorName).not.toBe(surfaceDefinition('desktop').connectorName);
  });

  it('gives each surface its own server identity and instructions', async () => {
    everything();
    for (const surface of SURFACE_LIST) {
      const reply = await call(surface.id, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      });
      expect(reply.body.result.serverInfo.name, surface.id).toBe(surface.serverName);
      expect(reply.body.result.instructions, surface.id).toBeTruthy();
    }
  });
});

describe('2025-era clients', () => {
  it('answers the initialize handshake', async () => {
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    expect(reply.status).toBe(200);
    expect(reply.body.result.serverInfo.name).toBe('chat-on-steroids-core');
    expect(reply.body.result.protocolVersion).toBeTruthy();
  });

  it('exposes the Core server instructions', async () => {
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = reply.body.result.instructions ?? '';
    expect(instructions).toContain('/workspace');
    expect(instructions).toContain('start_line/end_line range applies to every file the call reads');
    if (IS_WINDOWS) {
      // The Windows glob gap, taught once here because it is what most shell retries were for.
      expect(instructions).toContain('PowerShell does not expand * or ? for native programs');
    } else {
      expect(instructions).toContain('normal POSIX shell');
      expect(instructions).not.toContain('PowerShell does not expand * or ? for native programs');
    }
    // Progress guidance lives once at server level rather than bloating every tool description.
    expect(instructions).toContain('Keep the user visibly informed more than usual while you work');
    // The two round-trip levers the recorded sessions actually pay for. Both are instructions
    // rather than tool descriptions because they are about *how many calls to make*, which is a
    // decision taken before any one tool's schema is read.
    expect(instructions).toContain('exec_command cmds');
    expect(instructions).toContain('read a file whole rather than in windows');
    // Short enough not to burn the model's context on every conversation. Everything added
    // since this bound was set paid for itself by tightening a line that said the same thing
    // at greater length; raise it only for guidance that removes calls, never for prose.
    expect(instructions.length).toBeLessThan(2500);
  });

  it('points at the other connector rather than pretending the capability does not exist', async () => {
    ctx.caps = withCaps({ screen: true, control: true });
    ctx.readOnly = false;
    const coreReply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    if (IS_WINDOWS || process.platform === 'darwin') {
      expect(coreReply.body.result.instructions).toContain(surfaceDefinition('desktop').connectorName);
    } else {
      expect(coreReply.body.result.instructions).not.toContain(surfaceDefinition('desktop').connectorName);
    }

    const desktopReply = await desktop('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    expect(desktopReply.body.result.instructions).toContain(surfaceDefinition('core').connectorName);
    expect(desktopReply.body.result.instructions).toContain('observe');
    // The most repeated desktop pattern in the recorded sessions was a batch containing
    // nothing but a fixed sleep and a screenshot, run again and again. `verify` is the
    // replacement, and it only helps if the instructions point at it by name.
    expect(desktopReply.body.result.instructions).toContain('Do not poll with a batch that only waits');
    expect(desktopReply.body.result.instructions).toContain('verify');
  });

  it('lists tools without an initialize handshake', async () => {
    const reply = await core('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('read');
  });

  it('calls a tool', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('exposes Codex view_image separately and returns native MCP image content', async () => {
    const tool = toolList(await core('tools/list')).find((entry) => entry.name === 'view_image');
    const schema = tool?.inputSchema;
    expect(Object.keys(schema?.properties ?? {})).toEqual(['path']);
    expect(schema?.required).toEqual(['path']);
    expect(schema?.additionalProperties).toBe(false);
    expect(tool?.outputSchema).toBeUndefined();

    const reply = await core('tools/call', {
      name: 'view_image',
      arguments: { path: '/workspace/pixel.png' }
    });
    expect(reply.status).toBe(200);
    const content = reply.body.result?.content as Array<Record<string, unknown>>;
    const image = content.find((item) => item.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(typeof image?.data).toBe('string');
    expect(Buffer.from(String(image?.data), 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(reply.body.result?.structuredContent).toBeUndefined();
  });
});

describe('2026-07-28 clients', () => {
  it('lists tools when the request carries the _meta envelope', async () => {
    const reply = await modern('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('read');
  });

  it('calls a tool', async () => {
    const reply = await modern('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('rejects a modern request whose headers disagree with its body', async () => {
    const reply = await modern('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } }, {
      'Mcp-Name': 'apply_patch'
    });
    expect(reply.status).toBe(400);
  });
});

describe('capability gating', () => {
  it('hides every writing and running tool in read-only mode', async () => {
    // Everything on, but read-only, which is the state that must still be safe.
    const config = { ...defaultConfig(), capabilities: allCaps(), readOnly: true };
    ctx.caps = effectiveCapabilities(config);
    ctx.readOnly = true;

    expect(toolNames(await core('tools/list'))).toEqual(['find', 'read', 'view_image']);
  });

  it('offers apply_patch only when a writing permission is on', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('apply_patch');
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');
  });

  it('enforces the create/edit/move/delete split inside one apply_patch schema', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: false, move: false, deleteFile: false });

    const added = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/split.txt', ['one']) }
    });
    expect(added.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');

    const addOverExisting = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/split.txt', ['overwritten through add']) }
    });
    expect(addOverExisting.body.result?.isError).toBe(true);
    expect(textOf(addOverExisting)).toContain('Edit files is disabled');
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');

    const updated = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: ['*** Begin Patch', '*** Update File: /workspace/split.txt', '@@', '-one', '+two', '*** End Patch'].join('\n')
      }
    });
    expect(updated.body.result?.isError).toBe(true);
    expect(textOf(updated)).toContain('Edit files is disabled');
    // Refused before anything was written, which is the whole promise of apply_patch.
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');

    const deleted = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/split.txt', '*** End Patch'].join('\n') }
    });
    expect(deleted.body.result?.isError).toBe(true);
    expect(textOf(deleted)).toContain('Delete files is disabled');
  });

  it('keeps command execution off unless it is explicitly enabled', async () => {
    ctx.readOnly = false;
    expect(toolNames(await core('tools/list'))).not.toContain('exec_command');

    ctx.caps = withCaps({ command: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).toContain('write_stdin');
  });

  it('drops find when exec_command can do the same job better', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true, search: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).not.toContain('find');
  });

  it('offers find when there is no shell to search with', async () => {
    ctx.caps = withCaps({ search: true, command: false });
    expect(toolNames(await core('tools/list'))).toContain('find');

    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'helper', mode: 'content' }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).toContain('results_returned:');
  });

  it('offers session and agents only when those features are on', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('session');
    expect(toolNames(await core('tools/list'))).not.toContain('agents');

    ctx.sessionTools = true;
    ctx.agentTools = true;
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('session');
    expect(names).toContain('agents');
  });

  it('rejects action-specific agent fields instead of silently ignoring them', async () => {
    ctx.agentTools = true;
    const reply = await core('tools/call', {
      name: 'agents',
      arguments: { action: 'status', result: 'this field belongs to finish' }
    });
    expect(failed(reply)).toBe(true);
  });

  it('discovers recent recordings and searches exact overflow text without caller identity', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'cross-chat discovery target', conversationId: null });
    const overflow = 'ordinary prefix followed by cross-session-deep-needle in the exact spilled result';
    const overflowId = await writeOverflowText(recorded.id, overflow);
    expect(overflowId).not.toBeNull();
    await appendEvent(recorded.id, {
      time: 2_000,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'internal-long-id-that-must-not-be-presented',
        tool: 'read',
        attribution: 'unattributed',
        requestId: null,
        conversationId: null,
        attributionMethod: 'unattributed',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'ordinary prefix', truncated: true, chars: overflow.length, assetId: overflowId! },
        outcome: 'ok',
        durationMs: 7,
        summary: { kind: 'read', tone: 'neutral', title: 'Read hidden payload' }
      }
    });

    const listed = await core('tools/call', { name: 'session', arguments: { action: 'search' } });
    expect(failed(listed), textOf(listed)).toBe(false);
    expect(textOf(listed)).toContain('Recorded sessions — newest first');
    expect(textOf(listed)).toContain(recorded.id);
    expect(textOf(listed)).toContain('cross-chat discovery target');

    const searched = await core('tools/call', {
      name: 'session',
      arguments: { action: 'search', query: 'cross-session-deep-needle' }
    });
    const searchText = textOf(searched);
    expect(failed(searched), searchText).toBe(false);
    expect(searchText).toContain(recorded.id);
    expect(searchText).toContain('matches: tools 1');
    expect(searchText).toMatch(/read_cursor: [A-Za-z0-9_-]+/);
    expect(searchText.length).toBeLessThanOrEqual(12_000);
  });

  it('reads exact user and assistant prose, filters headlines, and expands a short session-local tool ref', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'exact transcript target', conversationId: null });
    const userTail = 'USER-TAIL-MUST-SURVIVE';
    const assistantTail = 'ASSISTANT-TAIL-MUST-SURVIVE';
    const userText = `${'u'.repeat(900)}${userTail}`;
    const assistantText = `${'a'.repeat(900)}${assistantTail}`;
    await appendEvent(recorded.id, {
      time: 3_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: userText, truncated: false, chars: userText.length }
    });
    await appendEvent(recorded.id, {
      time: 3_001,
      source: 'extension',
      kind: 'assistant_message',
      message: { text: assistantText, truncated: false, chars: assistantText.length },
      final: true,
      state: 'final'
    });
    const call = await appendEvent(recorded.id, {
      time: 3_002,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'opaque-internal-call-id',
        tool: 'exec_command',
        attribution: 'request_id',
        requestId: 'opaque-request-id',
        conversationId: null,
        attributionMethod: 'request_id',
        args: { text: '{"cmd":"npm test"}', truncated: false, chars: 18 },
        result: { text: 'all targeted tests passed', truncated: false, chars: 25 },
        outcome: 'ok',
        durationMs: 123,
        summary: { kind: 'run', tone: 'good', title: 'Ran targeted tests', metric: '14 passed' }
      }
    });
    const shortRef = `T${call.seq.toString(36).toUpperCase()}`;

    const read = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id }
    });
    const readText = textOf(read);
    expect(failed(read), readText).toBe(false);
    expect(readText).toContain(userText);
    expect(readText).toContain(assistantText);
    expect(readText).toContain(`${shortRef} exec_command OK`);
    expect(readText).not.toContain('opaque-internal-call-id');
    expect(readText).not.toContain('opaque-request-id');
    expect(readText).toMatch(/update_cursor: [A-Za-z0-9_-]+/);

    const toolsOnly = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, include: ['tools'] }
    });
    expect(textOf(toolsOnly)).toContain(`${shortRef} exec_command OK`);
    expect(textOf(toolsOnly)).not.toContain(userTail);
    expect(textOf(toolsOnly)).not.toContain(assistantTail);

    const detail = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, tool_call: shortRef }
    });
    const detailText = textOf(detail);
    expect(failed(detail), detailText).toBe(false);
    expect(detailText).toContain(`${shortRef} — exec_command`);
    expect(detailText).toContain('{"cmd":"npm test"}');
    expect(detailText).toContain('all targeted tests passed');
    expect(detailText).not.toContain('opaque-internal-call-id');
  });

  it('losslessly pages a message larger than the five-thousand-token read budget', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'large exact message', conversationId: null });
    const message = `MESSAGE-BEGIN-${'0123456789'.repeat(2_300)}-MESSAGE-END`;
    await appendEvent(recorded.id, {
      time: 4_000,
      source: 'extension',
      kind: 'assistant_message',
      message: { text: message, truncated: false, chars: message.length },
      final: true,
      state: 'final'
    });

    let reply = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, include: ['assistant'] }
    });
    let combined = textOf(reply);
    expect(combined).toContain('MESSAGE-BEGIN');
    expect(combined.length).toBeLessThanOrEqual(20_000);
    for (let page = 0; page < 5 && !combined.includes('MESSAGE-END'); page++) {
      const cursor = /continuation_cursor: ([A-Za-z0-9_-]+)/.exec(textOf(reply))?.[1];
      expect(cursor).toBeTruthy();
      reply = await core('tools/call', {
        name: 'session',
        arguments: { action: 'read', session_id: recorded.id, cursor }
      });
      expect(textOf(reply).length).toBeLessThanOrEqual(20_000);
      combined += textOf(reply);
    }
    expect(combined).toContain('MESSAGE-END');
    expect(combined).not.toContain('…');
  });

  it('uses update cursors to return only new concurrent work and only the suffix of an unfinished answer', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'concurrent worker knowledge', conversationId: null });
    const prefix = 'I inspected the worker ledger and found';
    await upsertMessageEvent(recorded.id, {
      time: 5_000,
      source: 'extension',
      kind: 'assistant_message',
      message: { text: prefix, truncated: false, chars: prefix.length },
      messageId: 'stable-worker-answer',
      state: 'streaming',
      final: false
    });
    const initial = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id }
    });
    const updateCursor = /update_cursor: ([A-Za-z0-9_-]+)/.exec(textOf(initial))?.[1];
    expect(updateCursor).toBeTruthy();

    const tool = await appendEvent(recorded.id, {
      time: 5_001,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'worker-new-call',
        tool: 'exec_command',
        attribution: 'agent',
        requestId: null,
        conversationId: null,
        attributionMethod: 'unattributed',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: '14 tests passed', truncated: false, chars: 15 },
        outcome: 'ok',
        durationMs: 80,
        summary: { kind: 'run', tone: 'good', title: 'Worker tests passed' }
      }
    });
    const suffix = ' that the commit happens too early.';
    await upsertMessageEvent(recorded.id, {
      time: 5_002,
      source: 'extension',
      kind: 'assistant_message',
      message: { text: prefix + suffix, truncated: false, chars: prefix.length + suffix.length },
      messageId: 'stable-worker-answer',
      state: 'final',
      final: true
    });

    const update = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, cursor: updateCursor }
    });
    const updateText = textOf(update);
    expect(failed(update), updateText).toBe(false);
    expect(updateText).toContain(`T${tool.seq.toString(36).toUpperCase()} exec_command OK`);
    expect(updateText).toContain('ASSISTANT CONTINUED [final]');
    expect(updateText).toContain(suffix);
    expect(updateText).not.toContain(prefix);
    const nextCursor = /update_cursor: ([A-Za-z0-9_-]+)/.exec(updateText)?.[1];
    expect(nextCursor).toBeTruthy();

    const unchanged = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, cursor: nextCursor }
    });
    expect(textOf(unchanged)).toContain('No new recorded activity');
  });

  it('returns an update checkpoint even when a concurrent recording has no selected activity yet', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'worker before first result', conversationId: null });
    const empty = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, include: ['assistant', 'tools'] }
    });
    expect(failed(empty), textOf(empty)).toBe(false);
    expect(textOf(empty)).toContain('No recorded entries match');
    expect(textOf(empty)).toMatch(/update_cursor: [A-Za-z0-9_-]+/);
  });

  it('rejects the removed history/status contract and ambiguous read fields', async () => {
    ctx.sessionTools = true;
    const advertised = toolList(await core('tools/list')).find((tool) => tool.name === 'session');
    expect(advertised?.inputSchema).toMatchObject({
      properties: { action: { enum: ['search', 'read'] } },
      required: ['action']
    });
    expect(advertised?.inputSchema?.properties).not.toHaveProperty('limit');
    expect(advertised?.inputSchema?.properties).not.toHaveProperty('call_id');
    expect(advertised?.inputSchema?.properties).not.toHaveProperty('part');

    const oldHistory = await core('tools/call', {
      name: 'session',
      arguments: { action: 'history' }
    });
    expect(failed(oldHistory)).toBe(true);

    const missingSession = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read' }
    });
    expect(failed(missingSession)).toBe(true);

    const oldLimit = await core('tools/call', {
      name: 'session',
      arguments: { action: 'search', limit: 40 }
    });
    expect(failed(oldLimit)).toBe(true);
  });

  it('starts a fresh install with every capability effective', () => {
    // This assertion is about the product's fully-enabled fresh-install policy, not the
    // host running Vitest. Windows has no OS-version floor, so it is the deterministic
    // representative for a host with every declared capability.
    const config = defaultConfig('win32');
    expect(config.readOnly).toBe(false);
    expect(config.multiAgent.enabled).toBe(true);
    expect(Object.values(effectiveCapabilities(config, 'win32')).every(Boolean)).toBe(true);
  });

  it('refuses to call a tool that is not registered', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/notes.txt', '*** End Patch'].join('\n') }
    });
    // Either a JSON-RPC error or a tool error, but never a deletion.
    expect(failed(reply)).toBe(true);
    expect(await fs.readFile(path.join(approved, 'notes.txt'), 'utf8')).toContain('note line 1');
  });

  it('answers metadata-only permission with metadata rather than refusing the path', async () => {
    ctx.caps = withCaps({ read: false, browse: false, metadata: true });
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('/workspace/src/app.ts');
    expect(text).toContain('need the Read files permission');
    expect(text).not.toContain('export const name');
  });

  it('picks up a permission change on the very next request', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('apply_patch');
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');
  });

  it('keeps an already-exposed tool stable and returns TOOL_DISABLED after permission is revoked', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');

    ctx.caps = withCaps({ create: false });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/should-not-exist.txt', ['nope']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('TOOL_DISABLED');
    await expect(fs.stat(path.join(approved, 'should-not-exist.txt'))).rejects.toThrow();
  });

  // find and the exec pair are mutually exclusive: find exists so that a user who has
  // not granted command execution still gets a way to search. But `exposedCaps` only ever
  // widens, so deriving find's registration from the live "command is off" would DELETE a
  // tool from an already-cached ChatGPT snapshot the moment the user granted commands —
  // the exact stale-snapshot failure the monotonic rule exists to prevent.
  it('keeps find listed after command execution is switched on mid-run', async () => {
    ctx.caps = withCaps({ search: true, read: true, browse: true });
    expect(toolNames(await core('tools/list'))).toContain('find');

    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, read: true, browse: true, command: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('find');
    expect(names).toContain('exec_command');
  });

  it('does not add find to a surface that started with command execution on', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, read: true, command: true });
    expect(toolNames(await core('tools/list'))).not.toContain('find');

    ctx.caps = withCaps({ search: true, read: true, command: false });
    expect(toolNames(await core('tools/list'))).not.toContain('find');
  });

  it('always offers read, because that is what the app is for', async () => {
    ctx.caps = withCaps({ browse: false, search: false, read: false, metadata: false });
    // Nothing is registered when every reading permission is off — but the snapshot is
    // monotonic, so a surface that started with reading on keeps it and refuses instead.
    expect(toolNames(await core('tools/list'))).toEqual([]);
  });
});

describe('desktop capabilities', () => {
  it('advertises nothing until a desktop permission is turned on', async () => {
    ctx.readOnly = false;
    expect(toolNames(await desktop('tools/list'))).toEqual([]);
  });

  it('offers looking at the screen without offering control of it', async () => {
    ctx.caps = withCaps({ screen: true });
    const names = toolNames(await desktop('tools/list'));
    expect(names).toEqual(['observe']);
  });

  // Seeing the screen changes nothing, so it survives read-only mode; driving the
  // mouse and keyboard can do anything the user can, so it must not.
  it('keeps seeing but not touching in read-only mode', async () => {
    // Exercise the read-only capability split on a platform with a native Desktop backend rather
    // than making the result depend on the CI host.
    const config = { ...defaultConfig('win32'), capabilities: withCaps({ screen: true, control: true }) };

    ctx.readOnly = true;
    ctx.caps = effectiveCapabilities({ ...config, readOnly: true }, 'win32');
    expect(ctx.caps.screen).toBe(true);
    expect(ctx.caps.control).toBe(false);
    expect(toolNames(await desktop('tools/list'))).toEqual(['observe']);

    ctx.readOnly = false;
    ctx.caps = effectiveCapabilities({ ...config, readOnly: false }, 'win32');
    expect(toolNames(await desktop('tools/list'))).toContain('computer');
  });

  it('offers computer for the clipboard alone, and refuses the steps that need control', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ control: false, clipboardRead: true, clipboardWrite: false });
    expect(toolNames(await desktop('tools/list'))).toEqual(['computer']);

    const clicked = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'click', x: 5, y: 5 }] }
    });
    expect(clicked.body.result?.isError).toBe(true);
    expect(textOf(clicked)).toContain('mouse and keyboard control is disabled');

    const written = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'write_clipboard', text: 'nope' }] }
    });
    expect(written.body.result?.isError).toBe(true);
    expect(textOf(written)).toContain('Replace clipboard text permission');
  });

  it('marks observing read-only and control destructive', async () => {
    ctx.caps = withCaps({ screen: true, control: true });
    ctx.readOnly = false;
    const tools = toolList(await desktop('tools/list'));
    const observe = tools.find((t) => t.name === 'observe');
    const computer = tools.find((t) => t.name === 'computer');
    expect(observe?.annotations?.readOnlyHint).toBe(true);
    expect(computer?.annotations?.readOnlyHint).toBe(false);
    expect(computer?.annotations?.destructiveHint).toBe(true);
  });

  it('carries the clipboard actions in the computer schema rather than as tools of their own', async () => {
    ctx.caps = withCaps({ screen: true, control: true, clipboardRead: true, clipboardWrite: true });
    ctx.readOnly = false;
    const schema = JSON.stringify(toolList(await desktop('tools/list')).find((t) => t.name === 'computer'));
    expect(schema).toContain('read_clipboard');
    expect(schema).toContain('write_clipboard');
  });

  it('rejects a malformed action before it reaches the desktop', async () => {
    ctx.caps = withCaps({ screen: true, control: true });
    ctx.readOnly = false;
    // No coordinates, so there is nothing to click; this must fail as a tool error
    // rather than being passed on to the helper.
    const reply = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'click' }] }
    });
    expect(failed(reply)).toBe(true);
  });

  it('rejects unknown fields inside a desktop action instead of silently dropping them', async () => {
    ctx.caps = withCaps({ control: true });
    ctx.readOnly = false;
    const reply = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'wait', ms: 0, typo_that_must_not_be_ignored: true }] }
    });
    expect(failed(reply)).toBe(true);
  });

  it('rejects capture options that would otherwise be silently ignored', async () => {
    ctx.caps = withCaps({ control: true, screen: true });
    ctx.readOnly = false;
    const withoutCapture = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'wait', ms: 0 }], captureWindow: 123 }
    });
    expect(failed(withoutCapture)).toBe(true);

    const conflictingTargets = await desktop('tools/call', {
      name: 'computer',
      arguments: {
        actions: [{ type: 'wait', ms: 0 }],
        captureAfter: true,
        captureWindow: 123,
        captureFull: true
      }
    });
    expect(failed(conflictingTargets)).toBe(true);
  });

  it('validates compact computer postconditions and keeps screen permission live', async () => {
    ctx.caps = withCaps({ control: true, screen: true });
    ctx.readOnly = false;
    const malformed = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'wait', ms: 0 }], verify: { until: 'foreground' } }
    });
    expect(failed(malformed)).toBe(true);

    ctx.caps = withCaps({ control: true, screen: false });
    const disabled = await desktop('tools/call', {
      name: 'computer',
      arguments: {
        actions: [{ type: 'wait', ms: 0 }],
        verify: { until: 'foreground', window: 123, timeout_ms: 0 }
      }
    });
    expect(failed(disabled)).toBe(true);
    expect(textOf(disabled)).toContain('See the screen');
  });

  it('rejects observe options whose selected view would silently ignore them', async () => {
    ctx.caps = withCaps({ screen: true });
    const strayTimeout = await desktop('tools/call', {
      name: 'observe',
      arguments: { timeout_ms: 100 }
    });
    expect(failed(strayTimeout)).toBe(true);

    const unusedMatch = await desktop('tools/call', {
      name: 'observe',
      arguments: { what: 'active', match: 'Notepad' }
    });
    expect(failed(unusedMatch)).toBe(true);

    const impossibleShot = await desktop('tools/call', {
      name: 'observe',
      arguments: { what: 'ui', screenshot: true }
    });
    expect(failed(impossibleShot)).toBe(true);
  });
});

describe('tool annotations', () => {
  it('keeps connector annotations off copied Codex ToolSpecs', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ read: true, create: true, edit: true, move: true, deleteFile: true, command: true });
    const tools = toolList(await core('tools/list'));
    for (const name of ['view_image', 'apply_patch', 'exec_command', 'write_stdin']) {
      expect(tools.find((tool) => tool.name === name)?.annotations, name).toBeUndefined();
    }
  });

  it('retains annotations on connector-native tools', async () => {
    ctx.sessionTools = true;
    const read = toolList(await core('tools/list')).find((tool) => tool.name === 'read');
    const session = toolList(await core('tools/list')).find((tool) => tool.name === 'session');
    expect(read?.annotations?.readOnlyHint).toBe(true);
    expect(read?.annotations?.destructiveHint).toBe(false);
    // Both session actions are inspection only. Marking this as a write tool makes clients
    // apply confirmation/write semantics to searching and reading local recordings.
    expect(session?.annotations?.readOnlyHint).toBe(true);
    expect(session?.annotations?.destructiveHint).toBe(false);
  });
});

describe('sandbox enforcement through the tool layer', () => {
  const escapes = [
    '/workspace/../private/passwords.txt',
    '/workspace/../../private/passwords.txt',
    '\\workspace\\..\\private\\passwords.txt',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '/private/passwords.txt',
    '/workspace/notes.txt:stream'
  ];

  it('refuses every escape attempt on read', async () => {
    for (const attempt of escapes) {
      const reply = await core('tools/call', { name: 'read', arguments: { paths: [attempt] } });
      const text = textOf(reply);
      // One bad path is a per-path failure rather than a failed call, so the assertion is
      // that the content never arrives — not that the call errored.
      expect(text, attempt).toContain('ERROR');
      expect(text, attempt).not.toContain('hunter2');
    }
  });

  it('accepts a native filesystem path when it is inside an approved root', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: [path.join(approved, 'notes.txt')] }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(textOf(reply)).toContain('note line 1');
    expect(textOf(reply)).toContain('/workspace/notes.txt');
    expect(textOf(reply)).not.toContain(approved);
  });

  it('accepts native filesystem globs through read', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: [path.join(approved, 'src', '**', '*.ts')] }
    });
    expect(reply.body.result?.isError, textOf(reply)).not.toBe(true);
    expect(textOf(reply)).toContain('/workspace/src/app.ts');
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).not.toContain(approved);
  });

  it('accepts a native filesystem search scope through find', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'helper', mode: 'content', path: path.join(approved, 'src') }
    });
    expect(reply.body.result?.isError, textOf(reply)).not.toBe(true);
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).not.toContain(approved);
  });

  it('accepts a native filesystem image path through view_image', async () => {
    ctx.caps = withCaps({ read: true });
    const reply = await core('tools/call', {
      name: 'view_image',
      arguments: { path: path.join(approved, 'pixel.png') }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    const content = reply.body.result?.content as Array<Record<string, unknown>>;
    expect(content.find((item) => item.type === 'image')?.mimeType).toBe('image/png');
  });

  it('refuses escape attempts on find', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'hunter2', mode: 'content', path: '/workspace/../private' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).not.toContain('hunter2\n');
  });

  it('refuses to write outside a root even with writes enabled', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/../private/planted.txt', ['x']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(outside, 'planted.txt'))).rejects.toThrow();
  });

  it('refuses a relative patch path that climbs out of its base', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    // apply_patch used to join the base onto the path and `posix.normalize` the result
    // before the sandbox ever saw it, which erased the `..` that checkSegment exists to
    // refuse: `/workspace/../private/planted.txt` became a clean `/private/planted.txt`
    // and arrived looking like a path that had always been absolute. Patch paths now get
    // the same treatment as a path handed to read or exec.
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('../private/planted.txt', ['x']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(outside, 'planted.txt'))).rejects.toThrow();
  });

  it('does not advertise the retired apply_patch cwd argument', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const tool = toolList(await core('tools/list')).find((entry) => entry.name === 'apply_patch')!;
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['patch']);
    expect(tool.inputSchema.required).toEqual(['patch']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it('does not let a retired cwd field silently rebase relative patch paths', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    await fs.mkdir(path.join(approved, 'nested'), { recursive: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('../escaped.txt', ['x']), cwd: '/workspace/nested' }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(approved, 'escaped.txt'))).rejects.toThrow();
  });

  it('still applies an ordinary relative patch path against its base', async () => {
    // The refusals above must not have been bought by breaking shorthand itself.
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('relative-landed.txt', ['x']) }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'relative-landed.txt'), 'utf8')).toContain('x');
  });

  it('never reveals a real Windows path', async () => {
    const reply = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace'] } });
    const text = textOf(reply);
    expect(text).toContain('/workspace');
    expect(text).not.toContain(approved);
  });

  it('tells the model the approved roots and the current mode without spending a tool call', async () => {
    // list_roots is gone: the roots are one line of server instructions now, because a
    // round trip every conversation paid before it could do anything was pure overhead.
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = reply.body.result.instructions ?? '';
    expect(instructions).toContain('/workspace');
    expect(instructions).toContain('Read only');
  });
});

describe('bounded output', () => {
  it('expands a leading relative glob inside the proven chat workspace', async () => {
    const requestId = 'wfr_relative_glob';
    const conversationId = 'conv-relative-glob';
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId,
        sessionId: 'session-relative-glob',
        messageId: 'message-relative-glob',
        tool: 'read',
        observedAt: Date.now()
      })
    ).toBe('stored');
    setWorkspaceFor(`chat:${conversationId}`, {
      virtual: '/workspace/src',
      real: path.join(approved, 'src')
    });

    const reply = await modern(
      'tools/call',
      { name: 'read', arguments: { paths: ['**/*.ts'], start_line: 1, end_line: 1 } },
      { 'x-request-id': `${requestId}/att1` }
    );
    expect(failed(reply)).toBe(false);
    expect(textOf(reply)).toContain('/workspace/src/app.ts');
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
  });

  it('returns only the requested line range', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], start_line: 3, end_line: 5 }
    });
    const text = textOf(reply);
    expect(text).toContain('note line 3');
    expect(text).toContain('note line 5');
    expect(text).not.toContain('note line 6');
    expect(text).toContain('lines 3-5');
    // The total is unknown after a ranged read, so the model gets a resume point
    // instead of a misleading "of ?".
    expect(text).not.toContain('of ?');
    expect(text).toContain('continue from line 6');
  });

  it('honours a line range across every file it read, and says that it did', async () => {
    // The advertised contract has to match the runtime one, or the model learns the rule
    // from a failed call instead of from the tool list.
    const readTool = toolList(await core('tools/list')).find((tool) => tool.name === 'read')!;
    expect(String(readTool.description)).toMatch(/range applies to every file/i);
    expect(String(readTool.inputSchema.properties.start_line.description)).toMatch(/every file/i);
    expect(String(readTool.inputSchema.properties.end_line.description)).toMatch(/every file/i);

    // Refusing this was the single largest source of rejected calls in the recorded
    // sessions, and every one of them was a caller that had already said what it wanted.
    // The original objection was to dropping the range *silently* — so it is applied and
    // announced. What must never come back is a reply that looks like a whole-file read.
    const many = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt', '/workspace/src/app.ts'], start_line: 10, end_line: 12 }
    });
    expect(failed(many)).toBe(false);
    const text = textOf(many);
    expect(text).toContain('note line 10');
    expect(text).toContain('note line 12');
    expect(text).not.toContain('note line 9');
    expect(text).not.toContain('note line 13');
    // Announced in the body, and restated by the header of every section.
    expect(text).toMatch(/applied to each of the 2 files/i);
    expect(text).toMatch(/\/workspace\/notes\.txt — lines 10-12/);
    // The property the original refusal existed to protect: a file with nothing in that
    // range says so outright, so a short file can never read as a complete one.
    expect(text).toMatch(/\/workspace\/src\/app\.ts — no lines in that range/);

    // A glob is the usual way one path turns into several, so it must behave identically.
    const glob = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/**/*.ts'], start_line: 1, end_line: 1 }
    });
    expect(failed(glob)).toBe(false);
    expect(textOf(glob)).toMatch(/lines 1-1/);

    // One path is still one path: nothing is announced when there was nothing to spread.
    const single = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], start_line: 10, end_line: 12 }
    });
    expect(textOf(single)).not.toMatch(/applied to each/i);
    expect(textOf(single)).toContain('note line 10');
  });

  it('reports the total when the whole file was read', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('lines 1-1 of 1');
    expect(text).not.toContain('continue from line');
  });

  it('returns a whole small file when it fits inside the default read budget', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'] }
    });
    const text = textOf(reply);
    expect(text).toContain('lines 1-50 of 50');
    expect(text).toContain('note line 1');
    expect(text).toContain('note line 50');
    expect(text).not.toContain('truncated');
    expect(text).not.toContain('continue from line');
  });

  it('reads a typical 1,500-line source file whole by default and tells the model not to pre-paginate', async () => {
    const lines = Array.from({ length: 1_500 }, (_, index) =>
      `${String(index + 1).padStart(4, '0')} export const measuredDefaultReadLine = '${'x'.repeat(64)}';`
    );
    await fs.writeFile(path.join(approved, 'long-default-read.ts'), `${lines.join('\n')}\n`, 'utf8');

    const readTool = toolList(await core('tools/list')).find((tool) => tool.name === 'read')!;
    expect(String(readTool.description)).toMatch(/1,500-line source file/i);
    expect(String(readTool.description)).toMatch(/do not pre-paginate/i);

    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/long-default-read.ts'] }
    });
    const text = textOf(reply);
    expect(failed(reply), text).toBe(false);
    expect(text).toContain('lines 1-1500 of 1500');
    expect(text).toContain('1500 export const measuredDefaultReadLine');
    expect(text).not.toContain('continue from line');
  });

  /*
   * The line count is the header's answer to "how long is this file", and a range is exactly when
   * that matters: 3 lines with no denominator cannot be told apart from a whole file. The read
   * counts on past the range to fill it in.
   */
  it('states the file total on a ranged read, so a slice cannot read as the whole file', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], start_line: 3, end_line: 5 }
    });
    const text = textOf(reply);
    expect(text).toContain('lines 3-5 of 50');
    expect(text).toContain('more lines follow — continue from line 6');
  });

  it('lists a folder one level deep, marking what each entry is', async () => {
    // A folder read is one level and nothing more. Dependency folders are shown here —
    // hiding a directory the user can see in Explorer would be a lie — but nothing
    // descends into them, which is where the cost would actually have been.
    const reply = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace'] } });
    const text = textOf(reply);
    expect(text).toContain('one level');
    expect(text).toContain('d src');
    expect(text).toContain('f notes.txt');
    expect(text).not.toContain('noise.js');
    expect(text).not.toContain('app.ts');
  });

  it('validates tool arguments instead of trusting them', async () => {
    const reply = await core('tools/call', { name: 'read', arguments: { paths: [12345] } });
    expect(failed(reply)).toBe(true);
  });

  it('honours max_bytes instead of rejecting or silently ignoring the advertised read budget', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], max_bytes: 60 }
    });
    expect(failed(reply)).toBe(false);
    expect(textOf(reply)).toContain('continue from line');
    expect(textOf(reply)).not.toContain('note line 50');
  });

  it('rejects a whitespace-only find query instead of walking the workspace for everything', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: '   ', mode: 'content' }
    });
    expect(failed(reply)).toBe(true);
  });

  it('fails an exact oversized content search instead of recording an unsearched file as a successful no-match', async () => {
    ctx.caps = withCaps({ search: true });
    const oversized = path.join(approved, 'oversized-search.log');
    const handle = await fs.open(oversized, 'w');
    try {
      await handle.truncate(2 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    try {
      const reply = await core('tools/call', {
        name: 'find',
        arguments: { query: 'needle', mode: 'content', path: '/workspace/oversized-search.log' }
      });
      expect(failed(reply)).toBe(true);
      expect(textOf(reply)).toContain('File was not searched');
      expect(textOf(reply)).not.toContain('No matches');
    } finally {
      await fs.rm(oversized, { force: true });
    }
  });

  it('rejects find options that the selected mode would silently ignore', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'notes', mode: 'name', regex: true }
    });
    expect(failed(reply)).toBe(true);
  });

  it('reports a missing file plainly without losing the reads that worked', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts', '/workspace/nope.txt', '/workspace/src/lib/util.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('export const name = "app";');
    expect(text).toContain('/workspace/nope.txt — ERROR');
    expect(text).toMatch(/Not found/i);
    expect(text).toContain('export const helper = 1;');
  });

  it('fails when every explicit read target failed, while keeping partial multi-read useful', async () => {
    const allMissing = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/nope-a.txt', '/workspace/nope-b.txt'] }
    });
    expect(failed(allMissing)).toBe(true);
    expect(textOf(allMissing)).toContain('/workspace/nope-a.txt — ERROR');
    expect(textOf(allMissing)).toContain('/workspace/nope-b.txt — ERROR');

    const partial = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts', '/workspace/nope.txt'] }
    });
    expect(failed(partial)).toBe(false);
    expect(textOf(partial)).toContain('export const name = "app";');
    expect(textOf(partial)).toContain('/workspace/nope.txt — ERROR');
  });

  it('reads several files in one call', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts', '/workspace/src/lib/util.ts'] }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('export const name = "app";');
    expect(textOf(reply)).toContain('export const helper = 1;');
  });

  it('bounds line-number expansion inside the advertised read payload budget', async () => {
    const target = path.join(approved, 'many-empty-lines.txt');
    await fs.writeFile(target, '\n'.repeat(90_000));
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/many-empty-lines.txt'], max_bytes: 64 * 1024 }
    });
    const text = textOf(reply);
    expect(failed(reply)).toBe(false);
    // Raw bytes are cheap here; decimal line-number prefixes are not. The old path enforced
    // max_bytes before numbering and could turn a 64 KiB slice into hundreds of KiB on the wire.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(72 * 1024);
    expect(text).toContain('output cap reached');
  });

  it('renders an empty logical line instead of mistaking it for no line in the range', async () => {
    await fs.writeFile(path.join(approved, 'leading-empty-line.txt'), '\nsecond\n');
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/leading-empty-line.txt'], start_line: 1, end_line: 1 }
    });
    const text = textOf(reply);
    expect(failed(reply)).toBe(false);
    expect(text).toMatch(/\n1\t(?:\n|$)/);
    expect(text).toContain('lines 1-1 of 2');
  });

  it('reports an exhausted glob scan instead of claiming there were no matches', async () => {
    const broad = path.join(approved, 'glob-scan-cap');
    await fs.mkdir(broad, { recursive: true });
    try {
      // `walkFiles` is capped at 5,000 examined entries. Put the only matching file after that
      // boundary lexically so the old adapter dropped walk.truncated and lied with "no matches".
      for (let start = 0; start < 5_000; start += 200) {
        await Promise.all(
          Array.from({ length: Math.min(200, 5_000 - start) }, (_, offset) =>
            fs.writeFile(path.join(broad, `${String(start + offset).padStart(5, '0')}.txt`), '')
          )
        );
      }
      await fs.writeFile(path.join(broad, 'zzzzz.needle.ts'), 'export const needle = true;\n');

      const reply = await core('tools/call', {
        name: 'read',
        arguments: { paths: ['/workspace/glob-scan-cap/**/*.needle.ts'] }
      });
      const text = textOf(reply);
      expect(failed(reply)).toBe(false);
      expect(text).toContain('glob scan stopped after 5000 entries');
      expect(text).not.toContain(': no matches');
    } finally {
      await fs.rm(broad, { recursive: true, force: true });
    }
  });

  it('does not call an exactly-full glob result truncated until a 21st match actually exists', async () => {
    const folder = path.join(approved, 'exact-glob-cap');
    await fs.mkdir(folder, { recursive: true });
    for (let index = 0; index < 20; index++) {
      await fs.writeFile(path.join(folder, `match-${String(index).padStart(2, '0')}.ts`), `export const n = ${index};\n`);
    }

    const exact = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/exact-glob-cap/*.ts'] }
    });
    expect(failed(exact)).toBe(false);
    expect(textOf(exact)).not.toContain('more than 20 matches');

    await fs.writeFile(path.join(folder, 'match-20.ts'), 'export const n = 20;\n');
    const overflow = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/exact-glob-cap/*.ts'] }
    });
    expect(failed(overflow)).toBe(false);
    expect(textOf(overflow)).toContain('more than 20 matches');
  });

  it('expands a glob rather than making the model list the files itself', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/**/*.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('export const name = "app";');
    expect(text).toContain('export const helper = 1;');
  });

  it('says so when a glob matches nothing instead of failing the call', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/**/*.nothing'] }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('no matches');
  });
});

describe('apply_patch', () => {
  beforeEach(() => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: true, move: true, deleteFile: true });
  });

  it('resolves later hunks against files created earlier in the same patch', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Add File: /workspace/fresh-sequential.ts',
          '+const fresh = 1;',
          '*** Update File: /workspace/fresh-sequential.ts',
          '@@',
          '-const fresh = 1;',
          '+const fresh = 2;',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'fresh-sequential.ts'), 'utf8')).toBe('const fresh = 2;\n');
  });

  it('adds, updates, moves and deletes through one tool', async () => {
    const added = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/scratch.txt', ['first', 'second']) }
    });
    expect(added.body.result?.isError).toBeFalsy();
    expect(textOf(added)).toContain('A /workspace/scratch.txt');

    const edited = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: ['*** Begin Patch', '*** Update File: /workspace/scratch.txt', '@@', '-second', '+SECOND', '*** End Patch'].join('\n')
      }
    });
    expect(edited.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'scratch.txt'), 'utf8')).toContain('SECOND');

    const moved = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/scratch.txt',
          '*** Move to: /workspace/moved.txt',
          '@@',
          ' SECOND',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(moved.body.result?.isError).toBeFalsy();
    await expect(fs.stat(path.join(approved, 'scratch.txt'))).rejects.toThrow();

    const deleted = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/moved.txt', '*** End Patch'].join('\n') }
    });
    expect(deleted.body.result?.isError).toBeFalsy();
    await expect(fs.stat(path.join(approved, 'moved.txt'))).rejects.toThrow();
  });

  // Current Codex rejects an entirely empty Update hunk, so a pure rename carries one
  // context-only line. That line changes no content and must not quietly require Edit.
  it('renames without Edit, and still refuses to rewrite content', async () => {
    const source = path.join(approved, 'rename-me.txt');
    const occupied = path.join(approved, 'rename-occupied.txt');
    // A move-only permission must preserve bytes. The default Codex update mode normalizes
    // CRLF to LF, so this catches an implementation that performs a text rewrite just to rename.
    await fs.writeFile(source, 'keep this\r\n', 'utf8');
    await fs.writeFile(occupied, `do not replace${String.fromCharCode(10)}`, 'utf8');
    ctx.caps = withCaps({ move: true, edit: false });

    const overwrite = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/rename-me.txt',
          '*** Move to: /workspace/rename-occupied.txt',
          '@@',
          ' keep this',
          '*** End Patch'
        ].join(String.fromCharCode(10))
      }
    });
    expect(overwrite.body.result?.isError).toBe(true);
    expect(textOf(overwrite)).toContain('Edit files is disabled');
    expect(await fs.readFile(source, 'utf8')).toContain('keep this');
    expect(await fs.readFile(occupied, 'utf8')).toContain('do not replace');

    const moved = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/rename-me.txt',
          '*** Move to: /workspace/renamed.txt',
          '@@',
          ' keep this',
          '*** End Patch'
        ].join(String.fromCharCode(10))
      }
    });
    expect(moved.body.result?.isError, textOf(moved)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'renamed.txt'), 'utf8')).toBe('keep this\r\n');

    const rewritten = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/renamed.txt',
          '*** Move to: /workspace/renamed-again.txt',
          '@@',
          '-keep this',
          '+changed',
          '*** End Patch'
        ].join(String.fromCharCode(10))
      }
    });
    expect(rewritten.body.result?.isError).toBe(true);
    expect(textOf(rewritten)).toContain('TOOL_DISABLED');
    expect(await fs.readFile(path.join(approved, 'renamed.txt'), 'utf8')).toBe('keep this\r\n');
  });

  it('rejects an empty move-only Update hunk, matching current Codex', async () => {
    const source = path.join(approved, 'empty-move-source.txt');
    const target = path.join(approved, 'empty-move-target.txt');
    await fs.writeFile(source, 'keep this\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/empty-move-source.txt',
          '*** Move to: /workspace/empty-move-target.txt',
          '*** End Patch'
        ].join('\n')
      }
    });

    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain("Update file hunk for path '/workspace/empty-move-source.txt' is empty");
    expect(await fs.readFile(source, 'utf8')).toBe('keep this\n');
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('changes several files in one atomic patch', async () => {
    const a = path.join(approved, 'batch-a.txt');
    const b = path.join(approved, 'batch-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/batch-a.txt',
          '@@',
          '-alpha',
          '+ALPHA',
          '*** Update File: /workspace/batch-b.txt',
          '@@',
          '-beta',
          '+BETA',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('Success. Updated the following files:');
    expect(textOf(reply)).toContain('M /workspace/batch-a.txt');
    expect(textOf(reply)).toContain('M /workspace/batch-b.txt');
    expect(await fs.readFile(a, 'utf8')).toBe('ALPHA\n');
    expect(await fs.readFile(b, 'utf8')).toBe('BETA\n');
  });

  it.runIf(IS_WINDOWS)('rolls back earlier files when a later commit fails after verification', async () => {
    const a = path.join(approved, 'batch-runtime-fail-a.txt');
    const b = path.join(approved, 'batch-runtime-fail-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');
    // Read-only is ideal here: verification and patch matching can still read B, so the failure
    // occurs only at the second runtime write, after A has already committed in raw Codex.
    await fs.chmod(b, 0o444);
    try {
      const reply = await core('tools/call', {
        name: 'apply_patch',
        arguments: {
          patch: [
            '*** Begin Patch',
            '*** Update File: /workspace/batch-runtime-fail-a.txt',
            '@@',
            '-alpha',
            '+ALPHA',
            '*** Update File: /workspace/batch-runtime-fail-b.txt',
            '@@',
            '-beta',
            '+BETA',
            '*** End Patch'
          ].join('\n')
        }
      });
      expect(reply.body.result?.isError).toBe(true);
      expect(textOf(reply)).toContain('rolled back');
      expect(await fs.readFile(a, 'utf8')).toBe('alpha\n');
      expect(await fs.readFile(b, 'utf8')).toBe('beta\n');
    } finally {
      await fs.chmod(b, 0o666).catch(() => undefined);
    }
  });

  it('leaves every target untouched when one hunk in the patch does not apply', async () => {
    const a = path.join(approved, 'batch-fail-a.txt');
    const b = path.join(approved, 'batch-fail-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/batch-fail-a.txt',
          '@@',
          '-alpha',
          '+ALPHA',
          '*** Update File: /workspace/batch-fail-b.txt',
          '@@',
          '-missing',
          '+BETA',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(await fs.readFile(a, 'utf8')).toBe('alpha\n');
    expect(await fs.readFile(b, 'utf8')).toBe('beta\n');
  });

  it('matches Codex Add File semantics and overwrites an existing file', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/notes.txt', ['clobbered']) }
    });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'notes.txt'), 'utf8')).toBe('clobbered\n');
  });

  it('names the problem when the patch itself is malformed', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: 'just some text' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain("invalid patch: The first line of the patch must be '*** Begin Patch'");
  });

  it('rejects hidden environment selection in this single-environment adapter like Codex', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Environment ID: other',
      '*** Add File: env-selected.txt',
      '+should-not-land',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch } });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toBe('apply_patch environment selection is unavailable for this turn');
    await expect(fs.stat(path.join(approved, 'env-selected.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps Codex apply_patch output shape for a huge rewrite', async () => {
    const before = Array.from({ length: 1600 }, (_, index) => `old-${index}`);
    await fs.writeFile(path.join(approved, 'rewrite.txt'), `${before.join('\n')}\n`, 'utf8');
    const hunk = [
      '*** Begin Patch',
      '*** Update File: /workspace/rewrite.txt',
      '@@',
      ...before.map((line) => `-${line}`),
      ...before.map((_, index) => `+new-${index}`),
      '*** End Patch'
    ].join('\n');

    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch: hunk } });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(textOf(reply)).toContain('Exit code: 0');
    expect(textOf(reply)).toContain('Success. Updated the following files:');
    expect(textOf(reply)).toContain('M /workspace/rewrite.txt');
    expect(textOf(reply)).not.toContain('(~+');
  });

  it('returns a small image without applying the text-section byte default', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/pixel.png'] }
    });
    expect(textOf(reply)).not.toContain('image is too large to return');
    const content = reply.body.result?.content as Array<Record<string, unknown>>;
    expect(content.some((item) => item.type === 'image')).toBe(true);
  });

  it('charges base64 image content to the aggregate read cap and points large images to view_image', async () => {
    const target = path.join(approved, 'large-noise.png');
    await sharp(randomBytes(512 * 512 * 4), { raw: { width: 512, height: 512, channels: 4 } })
      .png({ compressionLevel: 0 })
      .toFile(target);

    const readReply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/large-noise.png'] }
    });
    expect(readReply.body.result?.isError).toBe(true);
    expect(textOf(readReply)).toMatch(/aggregate output cap.*view_image/i);

    const imageReply = await core('tools/call', {
      name: 'view_image',
      arguments: { path: '/workspace/large-noise.png' }
    });
    expect(imageReply.body.result?.isError, textOf(imageReply)).not.toBe(true);
    expect((imageReply.body.result?.content as Array<{ type: string }>).some((item) => item.type === 'image')).toBe(true);
  });

  it('accepts a native filesystem path inside apply_patch', async () => {
    const target = path.join(approved, 'native-patch.txt');
    const patch = [
      '*** Begin Patch',
      `*** Add File: ${target}`,
      '+native-patch-ok',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch } });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(target, 'utf8')).toBe('native-patch-ok\n');
    expect(textOf(reply)).toContain('A /workspace/native-patch.txt');
    expect(textOf(reply)).not.toContain(approved);
  });

  it('normalizes native filesystem update, move and delete paths inside apply_patch', async () => {
    const source = path.join(approved, 'native-patch-source.txt');
    const moved = path.join(approved, 'native-patch-moved.txt');
    await fs.writeFile(source, 'before\n', 'utf8');

    const movePatch = [
      '*** Begin Patch',
      `*** Update File: ${source}`,
      `*** Move to: ${moved}`,
      '@@',
      '-before',
      '+after',
      '*** End Patch'
    ].join('\n');
    const movedReply = await core('tools/call', { name: 'apply_patch', arguments: { patch: movePatch } });
    expect(movedReply.body.result?.isError, textOf(movedReply)).toBeFalsy();
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(moved, 'utf8')).toBe('after\n');
    expect(textOf(movedReply)).toContain('/workspace/native-patch-moved.txt');
    expect(textOf(movedReply)).not.toContain(approved);

    const deletePatch = ['*** Begin Patch', `*** Delete File: ${moved}`, '*** End Patch'].join('\n');
    const deletedReply = await core('tools/call', { name: 'apply_patch', arguments: { patch: deletePatch } });
    expect(deletedReply.body.result?.isError, textOf(deletedReply)).toBeFalsy();
    await expect(fs.stat(moved)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(textOf(deletedReply)).toContain('D /workspace/native-patch-moved.txt');
    expect(textOf(deletedReply)).not.toContain(approved);
  });

  it('does not leak the resolved real path when apply_patch fails after validation', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: /workspace/notes.txt/child.txt',
      '+cannot-land-under-a-file',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch } });
    expect(reply.body.result?.isError).toBe(true);
    // The host errno text differs here: Windows can retain the safe virtual spelling while
    // POSIX reports ENOTDIR without a path. The invariant is that neither form leaks `approved`.
    expect(textOf(reply)).toMatch(/\/workspace\/notes\.txt\/child\.txt|Filesystem error \(ENOTDIR\)/);
    expect(textOf(reply)).not.toContain(approved);
  });
});

describe('exec_command and write_stdin', () => {
  beforeEach(() => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true });
  });

  it('refuses an approved virtual path in opaque shell text instead of running against the drive root', async () => {
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: 'type /workspace/notes.txt', workdir: '/workspace' }
    });

    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('INVALID_COMMAND_PATH');
    expect(textOf(reply)).toContain('/workspace/notes.txt');
    expect(textOf(reply)).toMatch(/relative path|native filesystem path/i);
    expect(textOf(reply)).toContain('No command was run');
  });

  it('intercepts explicit apply_patch shell invocations through the Codex patch runtime', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: intercepted.txt',
      '+intercepted-ok',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH`,
        workdir: '/workspace'
      }
    });

    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(textOf(reply)).toContain('Wall time: 0.0000 seconds');
    expect(textOf(reply)).toContain('Exit code: 0');
    expect(textOf(reply)).toContain('A intercepted.txt');
    expect(await fs.readFile(path.join(approved, 'intercepted.txt'), 'utf8')).toBe('intercepted-ok\n');
    expect(reply.body.result?.structuredContent).toMatchObject({
      wall_time_seconds: 0,
      output: expect.stringContaining('Success. Updated the following files:')
    });
    expect(reply.body.result?.structuredContent).not.toHaveProperty('exit_code');
    expect(reply.body.result?.structuredContent).not.toHaveProperty('session_id');
  });

  it('applies intercepted cd workdir exactly once', async () => {
    await fs.mkdir(path.join(approved, 'nested'), { recursive: true });
    const patch = [
      '*** Begin Patch',
      '*** Add File: from-cd.txt',
      '+nested-ok',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `cd nested && apply_patch <<'PATCH'\n${patch}\nPATCH`,
        workdir: '/workspace'
      }
    });

    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'nested', 'from-cd.txt'), 'utf8')).toBe('nested-ok\n');
    await expect(fs.stat(path.join(approved, 'nested', 'nested', 'from-cd.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a raw patch body passed as command with Codex implicit-invocation wording', async () => {
    const patch = ['*** Begin Patch', '*** Add File: implicit.txt', '+nope', '*** End Patch'].join('\n');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: patch, workdir: '/workspace' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toBe(
      'apply_patch verification failed: patch detected without explicit call to apply_patch. Rerun as ["apply_patch", "<patch>"]'
    );
    await expect(fs.stat(path.join(approved, 'implicit.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not intercept through a missing cd target that the shell would have rejected', async () => {
    const missing = path.join(approved, 'missing-intercept-cwd');
    const patch = [
      '*** Begin Patch',
      '*** Add File: landed.txt',
      '+must-not-land',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `cd missing-intercept-cwd && apply_patch <<'PATCH'\n${patch}\nPATCH`,
        workdir: '/workspace'
      }
    });

    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toMatch(/not found/i);
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a native filesystem workdir inside an approved root', async () => {
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: IS_WINDOWS ? 'Write-Output native-workdir-ok' : "printf '%s\\n' native-workdir-ok",
        workdir: approved,
        yield_time_ms: 5_000
      }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(textOf(reply)).toContain('native-workdir-ok');
  });

  it('uses the shared scrubbed child environment and exposes bundled ripgrep', async () => {
    // Unified exec used to construct a second, almost-identical environment instead of using
    // childEnv(). That copy missed the secret scrubber and the bundled-rg PATH prefix. Both are
    // contract properties, not implementation details: model-run commands must never inherit a
    // connector credential, and `rg` is a runtime the app deliberately ships for those commands.
    const heldSecret = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-must-never-reach-exec-command';
    try {
      const secret = await core('tools/call', {
        name: 'exec_command',
        arguments: {
          cmd: IS_WINDOWS
            ? "if ($env:OPENAI_API_KEY) { Write-Output 'LEAKED' } else { Write-Output 'SCRUBBED' }"
            : "if [ -n \"${OPENAI_API_KEY:-}\" ]; then printf '%s\\n' LEAKED; else printf '%s\\n' SCRUBBED; fi",
          workdir: '/workspace',
          yield_time_ms: 5_000
        }
      });
      expect(failed(secret), textOf(secret)).toBe(false);
      expect(textOf(secret)).toContain('SCRUBBED');
      expect(textOf(secret)).not.toContain('LEAKED');
    } finally {
      if (heldSecret === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = heldSecret;
    }

    const bundled = locateRipgrep();
    if (!bundled) return;
    const rg = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: IS_WINDOWS
          ? "Get-Command rg -CommandType Application | Select-Object -First 1 -ExpandProperty Source"
          : 'command -v rg',
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(failed(rg), textOf(rg)).toBe(false);
    expect(textOf(rg).toLowerCase()).toContain(bundled.toLowerCase());
  });

  it.runIf(IS_WINDOWS)('binds bare PowerShell rg to the bundled binary instead of a shadowing function', async () => {
    const bundled = locateRipgrep();
    if (!bundled) return;
    await fs.writeFile(path.join(approved, 'rg-shadow-target.txt'), 'needle-from-real-ripgrep\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        // A profile function is the live failure mode; defining it inline makes the regression
        // deterministic without touching the user's real PowerShell profile. The app's `rg`
        // contract is the bundled runtime, so this function must never receive the invocation.
        cmd: "function rg { Write-Output 'SHADOWED-RG'; exit 17 }; rg -n needle-from-real-ripgrep rg-shadow-target.txt",
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });

    expect(failed(reply), textOf(reply)).toBe(false);
    expect(textOf(reply)).toContain('needle-from-real-ripgrep');
    expect(textOf(reply)).not.toContain('SHADOWED-RG');
    expect(reply.body.result?.structuredContent?.exit_code).toBe(0);
  });

  it.runIf(IS_WINDOWS)('expands a glob for the bundled ripgrep it just bound the command to', async () => {
    // Binding and expanding are two rewrites of the same command and they were composed in
    // the order that cancels one out: binding turns the leading `rg` into `& '<path>'`, which
    // the normalizer no longer recognises as ripgrep, so every ordinary `rg pattern *.txt`
    // went out with the asterisk still in it. Both halves had unit tests and both passed —
    // they were only ever called separately. This is the pair, through the real tool.
    const bundled = locateRipgrep();
    if (!bundled) return;
    await fs.writeFile(path.join(approved, 'glob-one.rgtxt'), 'needle-through-the-glob\n', 'utf8');
    await fs.writeFile(path.join(approved, 'glob-two.rgtxt'), 'nothing here\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'rg -n needle-through-the-glob *.rgtxt',
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });

    expect(failed(reply), textOf(reply)).toBe(false);
    expect(textOf(reply)).toContain('needle-through-the-glob');
    expect(textOf(reply)).toContain('glob-one.rgtxt');
    // The literal asterisk reaching ripgrep is the failure: it reports `os error 123` and the
    // search silently answers nothing.
    expect(textOf(reply)).not.toContain('os error 123');
    expect(reply.body.result?.structuredContent?.exit_code).toBe(0);
  });

  it.runIf(IS_WINDOWS)('normalizes the recorded child-glob and balanced-quote failures through the real tool', async () => {
    const bundled = locateRipgrep();
    if (!bundled) return;
    await fs.mkdir(path.join(approved, 'test'), { recursive: true });
    await fs.writeFile(path.join(approved, 'test', 'computer-one.test.ts'), 'from "fsops.js"\n', 'utf8');
    await fs.writeFile(path.join(approved, 'test', 'computer-two.test.ts'), 'nothing here\n', 'utf8');

    const glob = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'rg -n fsops test/computer*.test.ts',
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(failed(glob), textOf(glob)).toBe(false);
    expect(textOf(glob)).toContain('computer-one.test.ts');
    expect(textOf(glob)).not.toContain('os error 123');

    const quote = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: String.raw`rg -n "from ['\"][^'\"]*fsops\.js['\"]" test/computer-one.test.ts`,
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(failed(quote), textOf(quote)).toBe(false);
    expect(textOf(quote)).toContain('from "fsops.js"');
    expect(textOf(quote)).not.toContain('regex parse error');
  });

  it('fails closed when an explicit shell name is unknown instead of silently switching languages', async () => {
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'echo must-not-run',
        workdir: '/workspace',
        shell: 'definitely-not-a-shell'
      }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('SHELL_NOT_FOUND');
    expect(textOf(reply)).toContain('No command was run');
  });

  it.runIf(IS_WINDOWS)('does not replace a missing explicit pwsh path with Windows PowerShell 5.1', async () => {
    const missingPwsh = path.join(approved, 'missing', 'pwsh.exe');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'Write-Output one && Write-Output two',
        workdir: '/workspace',
        shell: missingPwsh
      }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('SHELL_NOT_FOUND');
    expect(textOf(reply)).not.toContain('valid statement separator');
  });

  it('advertises the current Codex exec_command and write_stdin schemas', async () => {
    const tools = toolList(await core('tools/list'));
    const exec = tools.find((tool) => tool.name === 'exec_command')!;
    const stdin = tools.find((tool) => tool.name === 'write_stdin')!;

    expect(Object.keys(exec.inputSchema.properties)).toEqual([
      'cmd',
      'cmds',
      'workdir',
      'tty',
      'yield_time_ms',
      'max_output_tokens',
      'shell',
      'login'
    ]);
    expect(exec.inputSchema.required ?? []).toEqual([]);
    expect(exec.inputSchema.additionalProperties).toBe(false);
    expect(exec.inputSchema.properties.workdir.type).toBe('string');
    expect(exec.inputSchema.properties.cmds.type).toBe('array');
    expect(exec.inputSchema.properties.cmds.items.type).toBe('string');
    expect(String(exec.inputSchema.properties.cmds.description)).toMatch(/one shell session/i);
    expect(String(exec.inputSchema.properties.cmds.description)).toMatch(/exit code/i);
    expect(exec.inputSchema.properties.tty.type).toBe('boolean');
    expect(exec.inputSchema.properties.yield_time_ms.type).toBe('number');
    expect(exec.inputSchema.properties.max_output_tokens.type).toBe('number');
    expect(exec.inputSchema.properties.shell.type).toBe('string');
    expect(exec.inputSchema.properties.login.type).toBe('boolean');
    for (const retired of ['cwd', 'env', 'cols', 'rows', 'max_lines']) {
      expect(exec.inputSchema.properties).not.toHaveProperty(retired);
    }
    expect(exec.outputSchema).toMatchObject({
      type: 'object',
      required: ['wall_time_seconds', 'output'],
      additionalProperties: false
    });

    expect(Object.keys(stdin.inputSchema.properties)).toEqual([
      'session_id',
      'chars',
      'yield_time_ms',
      'max_output_tokens'
    ]);
    expect(stdin.inputSchema.required).toEqual(['session_id']);
    expect(stdin.inputSchema.additionalProperties).toBe(false);
    expect(stdin.inputSchema.properties.session_id.type).toBe('number');
    expect(stdin.inputSchema.properties.chars.type).toBe('string');
    expect(stdin.inputSchema.properties.yield_time_ms.type).toBe('number');
    expect(stdin.inputSchema.properties.max_output_tokens.type).toBe('number');
    for (const retired of ['cursor', 'close', 'signal', 'env', 'max_lines']) {
      expect(stdin.inputSchema.properties).not.toHaveProperty(retired);
    }
    expect(stdin.outputSchema).toEqual(exec.outputSchema);
  });

  it('runs cmds sequentially in one shell with labeled per-command exit codes', async () => {
    const commands = IS_WINDOWS
      ? [
          "$measuredBatchValue='same-shell'",
          'Write-Output "value=$measuredBatchValue"; cmd /c exit 7',
          'Write-Output "after=$measuredBatchValue"'
        ]
      : [
          "measuredBatchValue='same-shell'",
          "printf 'value=%s\\n' \"$measuredBatchValue\"; sh -c 'exit 7'",
          "printf 'after=%s\\n' \"$measuredBatchValue\""
        ];
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmds: commands,
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    const text = textOf(reply);
    expect(failed(reply), text).toBe(false);
    expect(text).toContain('--- command 1/3 ---');
    expect(text).toContain('--- command 2/3 ---');
    expect(text).toContain('--- command 3/3 ---');
    expect(text).toContain('--- exit code 7 ---');
    expect(text).toContain('value=same-shell');
    expect(text).toContain('after=same-shell');
    expect(reply.body.result?.structuredContent).toMatchObject({ exit_code: 7 });

    for (const arguments_ of [{}, { cmd: 'echo one', cmds: ['echo two'] }]) {
      const invalid = await core('tools/call', { name: 'exec_command', arguments: arguments_ });
      expect(failed(invalid), textOf(invalid)).toBe(true);
      expect(textOf(invalid)).toMatch(/exactly one of cmd or cmds/i);
    }
  });

  it('reads a batch exit per command, so one search finding nothing is not a failure', async () => {
    // The batch that `cmds` exists for is several searches at once, and a search that finds
    // nothing exits 1. Handing the wrapper script to the single-command classifier would ask
    // whether a `for` loop is a search, so the batch used to report a plain failure and invite
    // the model to run all of it again — the exact round trip batching was meant to remove.
    const searches = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        // `notes.txt` is intentionally overwritten by an earlier apply_patch regression in
        // this same end-to-end suite. Search an immutable fixture so the test does not depend
        // on file-order side effects that happened to differ across hosts.
        cmds: ['rg -n "export const name" src/app.ts', 'rg -n "no-such-pattern-anywhere" src/app.ts'],
        workdir: '/workspace',
        yield_time_ms: 8_000
      }
    });
    const searchText = textOf(searches);
    expect(searchText).toContain('--- exit code 1 ---');
    // Named per command, because only one of the two is the one that found nothing.
    expect(searchText).toMatch(/Command 2: Exit code 1 from/);
    expect(searchText).toContain('is a result, not a failure');

    // A real failure inside a batch stays a failure and gets no exoneration.
    const broken = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmds: IS_WINDOWS ? ['Write-Output first', 'cmd /c exit 3'] : ["printf '%s\\n' first", "sh -c 'exit 3'"],
        workdir: '/workspace',
        yield_time_ms: 8_000
      }
    });
    const brokenText = textOf(broken);
    expect(brokenText).toContain('--- exit code 3 ---');
    expect(brokenText).not.toContain('is a result, not a failure');
  }, 60_000);

  it('uses Codex response and session semantics for quick and interactive commands', async () => {
    const quick = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: IS_WINDOWS ? "Write-Output 'quick-ok'" : "printf '%s\\n' quick-ok",
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(quick.body.result?.isError).not.toBe(true);
    expect(textOf(quick)).toContain('quick-ok');
    expect(textOf(quick)).toContain('Process exited with code 0');
    expect(textOf(quick)).toContain('Chunk ID:');
    expect(quick.body.result?.structuredContent).toMatchObject({
      exit_code: 0,
      output: expect.stringContaining('quick-ok')
    });
    expect(typeof quick.body.result?.structuredContent?.chunk_id).toBe('string');
    expect(typeof quick.body.result?.structuredContent?.wall_time_seconds).toBe('number');

    await fs.writeFile(
      path.join(approved, 'interactive-stdin.cjs'),
      "const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); let n=0; rl.on('line',(line)=>{n++; console.log((n===1?'first=':'second=')+line); if(n===2) rl.close();});\n",
      'utf8'
    );
    const started = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'node interactive-stdin.cjs',
        workdir: '/workspace',
        tty: true,
        yield_time_ms: 25
      }
    });
    expect(started.body.result?.isError).not.toBe(true);
    expect(textOf(started)).toContain('Process running with session ID');
    const sessionIdText = textOf(started).match(/Process running with session ID (\d+)/)?.[1];
    expect(sessionIdText).toBeTruthy();
    const sessionId = Number(sessionIdText);

    // write_stdin sends bytes exactly as supplied. Without a newline ReadLine must keep waiting.
    const partial = await core('tools/call', {
      name: 'write_stdin',
      arguments: {
        session_id: sessionId,
        chars: 'raw-no-newline',
        yield_time_ms: 250
      }
    });
    expect(partial.body.result?.isError).not.toBe(true);
    expect(textOf(partial)).toContain(`Process running with session ID ${sessionId}`);
    expect(textOf(partial)).not.toContain('first=');

    const first = await core('tools/call', {
      name: 'write_stdin',
      arguments: { session_id: sessionId, chars: '\r', yield_time_ms: 5_000 }
    });
    expect(first.body.result?.isError).not.toBe(true);
    expect(textOf(first)).toContain('first=raw-no-newline');
    expect(textOf(first)).toContain(`Process running with session ID ${sessionId}`);

    const second = await core('tools/call', {
      name: 'write_stdin',
      arguments: { session_id: sessionId, chars: 'done\r', yield_time_ms: 5_000 }
    });
    expect(second.body.result?.isError).not.toBe(true);
    expect(textOf(second)).toContain('second=done');
    expect(textOf(second)).toContain('Process exited with code 0');
    // The process buffer is drained per call; previously delivered output is not replayed.
    expect(textOf(second)).not.toContain('first=raw-no-newline');
  });

  it('runs in workdir and omits the old connector-specific cwd header', async () => {
    const readApp = IS_WINDOWS ? "Get-Content 'src/app.ts'" : "cat 'src/app.ts'";
    const named = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: readApp, workdir: '/workspace', yield_time_ms: 5_000 }
    });
    expect(named.body.result?.isError).not.toBe(true);
    expect(textOf(named)).toContain('export const name = "app";');
    expect(textOf(named)).not.toContain('cwd: /workspace');

    const defaulted = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: readApp, yield_time_ms: 5_000 }
    });
    expect(defaulted.body.result?.isError).not.toBe(true);
    expect(textOf(defaulted)).toContain('export const name = "app";');
    expect(textOf(defaulted)).not.toContain('default — no cwd was given');
  });

  it.runIf(IS_WINDOWS)('preserves Codex raw merged output instead of the retired connector CLIXML rewrite', async () => {
    const payload =
      '#< CLIXML<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<S S="Error">An empty pipe element is not allowed._x000D__x000A_</S></Objs>';
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `[Console]::Error.Write('${payload}')`,
        workdir: '/workspace',
        yield_time_ms: 8_000
      }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(textOf(reply)).toContain('Output:');
    expect(textOf(reply)).toContain('#< CLIXML');
    expect(textOf(reply)).toContain('_x000D__x000A_');
  });
});

describe('exec sessions belong to the chat that opened them', () => {
  beforeEach(() => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true });
    // `session status` lists the running commands, which is the other place one chat could
    // learn another's session ids.
    ctx.sessionTools = true;
    // Ownership is process-global with no natural lifetime boundary, and clearing it can only
    // make the guard more permissive — never the other way round.
    resetExecOwnershipForTests();
  });

  /** What the page reports once it has seen this connector request leave a given chat. */
  const prove = (requestId: string, conversationId: string) =>
    observeRequestCorrelation({
      requestId,
      conversationId,
      sessionId: '2026-08-20-execown',
      messageId: `msg-${requestId}`,
      tool: 'exec_command',
      observedAt: Date.now()
    });

  /** A tools/call carrying the `x-request-id` ChatGPT sends, so the caller is identifiable. */
  const asChat = (requestId: string | null, name: string, args: Record<string, unknown>) =>
    modern(
      'tools/call',
      { name, arguments: args },
      requestId ? { 'x-request-id': `${requestId}/att1` } : {}
    );

  it('refuses write_stdin from a chat that does not own the session, and keeps serving the one that does', async () => {
    expect(prove('wfr_execown_opener', 'conv-execown-opener')).toBe('stored');
    expect(prove('wfr_execown_stranger', 'conv-execown-stranger')).toBe('stored');

    await fs.writeFile(
      path.join(approved, 'owned-stdin.cjs'),
      "const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on('line',(line)=>{ console.log('echo='+line); if(line==='bye') rl.close(); });\n",
      'utf8'
    );

    const started = await asChat('wfr_execown_opener', 'exec_command', {
      cmd: 'node owned-stdin.cjs',
      workdir: '/workspace',
      tty: true,
      yield_time_ms: 25
    });
    expect(started.body.result?.isError).not.toBe(true);
    const sessionId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(sessionId)).toBe(true);

    // The other chat can name that small integer just as easily as its owner can. Codex never
    // has to think about this because its manager hangs off one conversation's services.
    const stranger = await asChat('wfr_execown_stranger', 'write_stdin', {
      session_id: sessionId,
      chars: 'stolen\r',
      yield_time_ms: 250
    });
    expect(stranger.body.result?.isError).toBe(true);
    expect(textOf(stranger)).toContain(
      `write_stdin failed: session ${sessionId} is not proven to belong to this ChatGPT conversation.`
    );
    expect(textOf(stranger)).not.toContain('echo=stolen');

    // Caller identity is the authorization boundary. An unattributed call must not inherit
    // the owner's authority merely because it can guess the small numeric session id.
    const unproven = await asChat(null, 'write_stdin', {
      session_id: sessionId,
      chars: 'anon\r',
      yield_time_ms: 1_000
    });
    expect(unproven.body.result?.isError).toBe(true);
    expect(textOf(unproven)).toContain('is not proven to belong to this ChatGPT conversation');
    expect(textOf(unproven)).not.toContain('echo=anon');

    // The replacement session contract exposes recordings only; the removed status action no
    // longer gives either owner or stranger a side channel into the process manager. Terminal
    // ownership remains entirely on write_stdin, where both refusals above exercised it.
    const recordings = await asChat('wfr_execown_stranger', 'session', { action: 'search' });
    expect(recordings.body.result?.isError).not.toBe(true);
    expect(textOf(recordings)).not.toMatch(new RegExp(`^\\s*${sessionId}\\s+pid `, 'm'));

    const owner = await asChat('wfr_execown_opener', 'write_stdin', {
      session_id: sessionId,
      chars: 'bye\r',
      yield_time_ms: 5_000
    });
    expect(owner.body.result?.isError).not.toBe(true);
    expect(textOf(owner)).toContain('echo=bye');
    expect(textOf(owner)).toContain('Process exited with code 0');
  });

  it('does not let a stale owner inherit a recycled process id during the new exec yield', async () => {
    // Model the real lifetime split directly: the manager has released an exited process id,
    // but the separate ownership registry still carries the chat that used to own it. Force
    // the next allocator pick to reuse that number so the race is deterministic instead of a
    // 1-in-99k lottery.
    await unifiedExecManager.terminateAllProcesses();
    const recycledId = 1_000;
    noteExecOwner(recycledId, 'conv-execown-old');
    expect(execOwner(recycledId)).toBe('conv-execown-old');
    expect(prove('wfr_execown_old_recycled', 'conv-execown-old')).toBe('stored');
    expect(prove('wfr_execown_new_recycled', 'conv-execown-new')).toBe('stored');

    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      // Block in the shell process itself. Spawning a second cold `node` here made this
      // ownership regression depend on hosted-runner process startup rather than on the
      // authority window it is meant to test. The shell is already the exec process and can
      // wait for one line of input without another child at all.
      const holdOpen = IS_WINDOWS
        ? "$line = [Console]::In.ReadLine(); Write-Output ('got=' + $line)"
        : "IFS= read -r line; printf 'got=%s\\n' \"$line\"";

      // Do not await. The process is registered while exec_command spends its initial yield
      // collecting output, which is the exact old authority window.
      const starting = asChat('wfr_execown_new_recycled', 'exec_command', {
        cmd: holdOpen,
        workdir: '/workspace',
        tty: true,
        yield_time_ms: 1_000
      });
      await vi.waitFor(
        () => {
          expect(unifiedExecManager.listProcesses().some((entry) => entry.processId === recycledId)).toBe(true);
        },
        { timeout: 5_000, interval: 10 }
      );

      // Allocation must have removed the stale principal before the new process became
      // writable. The old chat knows this integer from its own previous session, but it no
      // longer has authority over what now happens to occupy that slot.
      expect(execOwner(recycledId)).toBeNull();
      const stolen = await asChat('wfr_execown_old_recycled', 'write_stdin', {
        session_id: recycledId,
        chars: 'stolen\r',
        yield_time_ms: 50
      });
      expect(stolen.body.result?.isError).toBe(true);
      expect(textOf(stolen)).toContain('is not proven to belong to this ChatGPT conversation');

      const started = await starting;
      expect(started.body.result?.isError, textOf(started)).not.toBe(true);
      expect(Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1])).toBe(recycledId);
      expect(execOwner(recycledId)).toBe('conv-execown-new');
      expect(textOf(started)).not.toContain('got=');

      // Let the real owner release the shell normally. Besides proving the new principal did
      // receive authority, this keeps cleanup deterministic instead of spending the process
      // manager's kill grace period on an intentionally blocked test process.
      const owner = await asChat('wfr_execown_new_recycled', 'write_stdin', {
        session_id: recycledId,
        chars: 'owner\r',
        yield_time_ms: 5_000
      });
      expect(owner.body.result?.isError, textOf(owner)).not.toBe(true);
      expect(textOf(owner)).toContain('got=owner');
      expect(textOf(owner)).toContain('Process exited with code 0');
    } finally {
      random.mockRestore();
      await unifiedExecManager.terminateAllProcesses();
      resetExecOwnershipForTests();
    }
  });
});

describe('the outcome a shell command is recorded with', () => {
  /** Runs `noteExec` the way a tool does, and reports what the recorder would store. */
  const outcomeOf = (
    result: { exitCode: number | null; timedOut?: boolean },
    preset: 'ok' | 'error' | 'rejected' | null = null
  ) => {
    const context: CallContext = {
      startedAt: Date.now(),
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: null, conversationId: null },
      outcome: preset,
      evidence: emptyEvidence()
    };
    runInCallContext(context, () => noteExec(result));
    // Nothing set means the dispatcher's fallback applies, and for a non-error tool result
    // that fallback is `ok` — which is exactly the bug this covers.
    return context.outcome ?? 'ok';
  };

  it('calls a completed non-zero exit an error, not a success', () => {
    expect(outcomeOf({ exitCode: 1 })).toBe('error');
    expect(outcomeOf({ exitCode: 3 })).toBe('error');
  });

  it('leaves a clean exit and a still-running process alone', () => {
    expect(outcomeOf({ exitCode: 0 })).toBe('ok');
    // Still running: it has not failed yet, and saying it did would be a lie about a
    // dev server that is doing exactly what was asked of it.
    expect(outcomeOf({ exitCode: null })).toBe('ok');
  });

  it('calls a timeout an error even when no exit code arrived', () => {
    expect(outcomeOf({ exitCode: null, timedOut: true })).toBe('error');
  });

  it('never overwrites an outcome the tool layer set deliberately', () => {
    expect(outcomeOf({ exitCode: 1 }, 'rejected')).toBe('rejected');
  });

  it('does not let the guard downgrade a command error back to ok', () => {
    const context: CallContext = {
      startedAt: Date.now(),
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: null, conversationId: null },
      outcome: null,
      evidence: emptyEvidence()
    };
    runInCallContext(context, () => {
      noteExec({ exitCode: 7 });
      // This is what guard() does when the tool returns a normal ToolResult whose text says
      // the child exited non-zero. The more specific process outcome must survive it.
      noteOutcome('ok');
    });
    expect(context.outcome).toBe('error');
  });
});
