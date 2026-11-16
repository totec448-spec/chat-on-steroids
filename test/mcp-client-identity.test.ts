import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  listLiveExternalMcpClients,
  observeMcpInitialize,
  parseClientInfoObject,
  resetMcpClientIdentityForTests,
  resolveInboundMcpClient
} from '../src/main/mcp/client-identity.js';
import {
  connectorProofWritten,
  externalClientProofs,
  initConnectorProofPath,
  loadConnectorProof,
  resetConnectorProofsForTests
} from '../src/main/connector-proof.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { resetToolClock, type ToolContext } from '../src/main/mcp/tools.js';
import { DEFAULT_CAPABILITIES, type Root } from '../src/shared/types.js';
import { isExternalMcpSession, isUnattributedSession } from '../src/shared/session.js';
import { defaultConfig, getConfig } from '../src/main/config.js';
import { resetRecorderForTests, flushRecorder } from '../src/main/session/recorder.js';
import {
  createSession,
  endSession,
  getSession,
  indexedSessions,
  initSessionStore
} from '../src/main/session/store.js';
import { sessionActivityExpiresAt } from '../src/main/bridge.js';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

function postRpc(urlStr: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const url = new URL(urlStr);
  const payload = JSON.stringify(body);
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
          'content-length': Buffer.byteLength(payload),
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').trim();
          let parsed: any = text;
          if (text.startsWith('{') || text.startsWith('[')) {
            try { parsed = JSON.parse(text); } catch { /* leave text */ }
          } else {
            const datas = [...text.matchAll(/^data:\s*(.*)$/gm)].map((m) => m[1] ?? '');
            const last = datas.at(-1);
            if (last) try { parsed = JSON.parse(last); } catch { /* leave text */ }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('parseClientInfoObject & HTTP correlation', () => {
  beforeEach(() => resetMcpClientIdentityForTests());

  it('normalizes known external clients and sanitizes custom names', () => {
    expect(parseClientInfoObject({ name: 'gemini-cli', version: '0.9.1' })).toEqual({
      id: 'gemini',
      name: 'Gemini',
      version: '0.9.1'
    });
    expect(parseClientInfoObject({ name: 'gemini_cli' })).toEqual({
      id: 'gemini',
      name: 'Gemini'
    });
    expect(parseClientInfoObject({ name: 'GeminiCLI' })).toEqual({
      id: 'gemini',
      name: 'Gemini'
    });
    expect(parseClientInfoObject({ name: 'Claude Desktop', version: '1.2' })).toEqual({
      id: 'claude',
      name: 'Claude',
      version: '1.2'
    });
    expect(parseClientInfoObject({ name: 'goose', version: '1.0\n\x07' })).toEqual({
      id: 'goose',
      name: 'Goose',
      version: '1.0'
    });
  });

  it('ignores OpenAI/ChatGPT callers and internal test stubs', () => {
    for (const ignored of ['openai-mcp', 'ChatGPT', 'wfr_1234', 'test', 'test-client', 'probe', 'code-mode-contract-test', 'node']) {
      expect(parseClientInfoObject({ name: ignored, version: '1.0' })).toBeNull();
    }
  });

  it('prefers explicit OpenAI metadata exclusion over cached external user-agent or session mappings', () => {
    const headers = { 'user-agent': 'gemini-cli/0.9.1', 'mcp-session-id': 'sess-gemini-1' };
    observeMcpInitialize('core', headers, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'gemini-cli', version: '0.9.1' } }
    });
    expect(resolveInboundMcpClient('core', headers, { method: 'tools/call', params: { name: 'read' } })).toEqual({
      clientIdentity: { id: 'gemini', name: 'Gemini', version: '0.9.1' },
      mcpSessionId: 'sess-gemini-1'
    });
    expect(
      resolveInboundMcpClient('core', headers, {
        method: 'tools/call',
        params: { name: 'read', _meta: { 'openai/session': 's-1', 'io.modelcontextprotocol/clientInfo': { name: 'gemini-cli' } } }
      })
    ).toEqual({
      clientIdentity: null,
      mcpSessionId: 'sess-gemini-1'
    });
  });

  it('recognizes known external clients from User-Agent after a stateless restart', () => {
    expect(
      resolveInboundMcpClient('core', { 'user-agent': 'gemini-cli/0.9.1' }, { method: 'tools/call', params: { name: 'read' } })
    ).toEqual({
      clientIdentity: { id: 'gemini', name: 'Gemini' },
      mcpSessionId: null
    });
  });

  it('recognizes ?client=gemini URL hints without overriding ChatGPT or specific clients', () => {
    expect(
      resolveInboundMcpClient(
        'core',
        { 'user-agent': 'Mozilla/5.0' },
        { method: 'tools/call', params: { name: 'read' } },
        '/mcp/core/tok123?client=gemini'
      )
    ).toEqual({
      clientIdentity: { id: 'gemini', name: 'Gemini' },
      mcpSessionId: null
    });

    // Upgrades an unrecognized wrapper clientInfo to Gemini while keeping reported version.
    expect(
      resolveInboundMcpClient(
        'core',
        { 'user-agent': 'Mozilla/5.0' },
        { method: 'initialize', params: { clientInfo: { name: 'http-mcp-proxy', version: '2.4' } } },
        '/mcp/core/tok123?client=gemini'
      )
    ).toEqual({
      clientIdentity: { id: 'gemini', name: 'Gemini', version: '2.4' },
      mcpSessionId: null
    });

    // Never lets ?client=gemini relabel ChatGPT (wfr_ request ID or openai/_meta).
    expect(
      resolveInboundMcpClient(
        'core',
        { 'x-request-id': 'wfr_998877', 'user-agent': 'Mozilla/5.0' },
        { method: 'tools/call', params: { name: 'read' } },
        '/mcp/core/tok123?client=gemini'
      )
    ).toEqual({
      clientIdentity: null,
      mcpSessionId: null
    });

    // Keeps specific non-Gemini external identities untouched and ignores arbitrary unknown query hints.
    expect(
      resolveInboundMcpClient(
        'core',
        { 'user-agent': 'claude-desktop/1.0' },
        { method: 'tools/call', params: { name: 'read' } },
        '/mcp/core/tok123?client=gemini'
      )
    ).toEqual({
      clientIdentity: { id: 'claude', name: 'Claude' },
      mcpSessionId: null
    });
    expect(
      resolveInboundMcpClient(
        'core',
        {},
        { method: 'tools/call', params: { name: 'read' } },
        '/mcp/core/tok123?client=untrusted-unknown'
      )
    ).toEqual({
      clientIdentity: null,
      mcpSessionId: null
    });
  });
});

describe('MCP external client sessions and fail-closed security', () => {
  let base: string;
  let workspace: string;
  let endpoint: McpEndpoint;
  let savedConfig: ReturnType<typeof defaultConfig>;

  beforeAll(async () => {
    savedConfig = structuredClone(defaultConfig());
    base = await makeTempDir('cos-client-id-');
    workspace = path.join(base, 'repo');
    await writeTree(workspace, { 'hello.txt': 'hello from gemini workspace\n' });
  });

  beforeEach(async () => {
    resetMcpClientIdentityForTests();
    resetConnectorProofsForTests();
    resetRecorderForTests();
    resetToolClock();
    initConnectorProofPath(base);
    const cfg = getConfig();
    cfg.sessions.record = true;
    cfg.multiAgent.allowUnattributedCalls = true;
    cfg.multiAgent.strictChatAllowlist = false;
    initSessionStore(base);
    const ctx: ToolContext = {
      roots: [{ name: 'repo', path: workspace }] as Root[],
      caps: { ...DEFAULT_CAPABILITIES, read: true },
      readOnly: true,
      sessionTools: false,
      agentTools: false
    };
    endpoint = await startMcpServer(() => ctx);
  });

  afterEach(async () => {
    await flushRecorder();
    if (endpoint) await endpoint.stop();
    const cfg = getConfig();
    Object.assign(cfg, structuredClone(savedConfig));
    resetRecorderForTests();
    resetConnectorProofsForTests();
    resetMcpClientIdentityForTests();
  });

  afterAll(async () => {
    await removeTempDir(base);
  });

  it('creates a dedicated Gemini session across initialize + stateless calls and preserves collapsed single-block output', async () => {
    let rpcId = 1;
    const headers = { 'user-agent': 'gemini-cli/0.9.1' };
    const initRes = await postRpc(
      endpoint.urls.core,
      { jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gemini-cli', version: '0.9.1' } } },
      headers
    );
    expect(initRes.status).toBe(200);

    const readRes = await postRpc(
      endpoint.urls.core,
      { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'read', arguments: { paths: ['/repo/hello.txt'] } } },
      headers
    );
    expect(readRes.status).toBe(200);
    const blocks = readRes.body?.result?.content ?? [];
    expect(blocks.filter((b: { type: string }) => b.type === 'text')).toHaveLength(1);
    const text: string = blocks[0]?.text ?? '';
    expect(text).toContain('hello from gemini workspace');
    expect(text).toContain('--- Identity notice ---');
    expect(text).toContain('"Gemini"');
    expect(text).not.toContain('exact ChatGPT conversation is not known yet');

    await flushRecorder();
    const sessions = await indexedSessions();
    const geminiSessions = sessions.filter((s) => s.mcpClient?.id === 'gemini');
    expect(geminiSessions).toHaveLength(1);
    const gemini = geminiSessions[0]!;
    expect(gemini.title).toBe('Gemini');
    expect(gemini.mcpClient).toEqual({ id: 'gemini', name: 'Gemini', version: '0.9.1' });
    expect(isExternalMcpSession(gemini)).toBe(true);
    expect(isUnattributedSession(gemini)).toBe(false);
    expect(sessions.some((s) => isUnattributedSession(s))).toBe(false);
    expect(sessionActivityExpiresAt(gemini)).toBeGreaterThan(Date.now());

    // Subsequent call after clearing in-memory recorder state adopts the open Gemini session rather than duplicating it.
    resetRecorderForTests();
    const secondRes = await postRpc(
      endpoint.urls.core,
      { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'read', arguments: { paths: ['/repo/hello.txt'] } } },
      headers
    );
    expect(secondRes.status).toBe(200);
    await flushRecorder();
    const afterRestart = (await indexedSessions()).filter((s) => s.mcpClient?.id === 'gemini');
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0]!.toolCalls).toBe(2);

    // Turning off Allow unattributed calls immediately removes active status and marks external calls blocked.
    getConfig().multiAgent.allowUnattributedCalls = false;
    expect(sessionActivityExpiresAt(afterRestart[0]!)).toBeNull();
    getConfig().multiAgent.allowUnattributedCalls = true;

    // Ending the session causes subsequent Gemini calls to start a fresh Gemini session.
    await endSession(gemini.id);
    await postRpc(
      endpoint.urls.core,
      { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'read', arguments: { paths: ['/repo/hello.txt'] } } },
      headers
    );
    await flushRecorder();
    expect((await indexedSessions()).filter((s) => s.mcpClient?.id === 'gemini')).toHaveLength(2);
  });

  it('drops malformed mcpClient metadata safely while preserving valid persisted external sessions', async () => {
    const valid = await createSession({ title: 'Gemini', mcpClient: { id: 'gemini', name: 'Gemini', version: '1.0' } });
    const metaPath = path.join(base, 'sessions', valid.id, 'meta.json');
    expect((await getSession(valid.id))?.mcpClient).toEqual({ id: 'gemini', name: 'Gemini', version: '1.0' });

    const malformedId = '2026-11-15-badc11e7';
    const malformedDir = path.join(base, 'sessions', malformedId);
    await fs.mkdir(malformedDir, { recursive: true });
    await fs.writeFile(path.join(malformedDir, 'events.jsonl'), '', 'utf8');
    await fs.writeFile(path.join(malformedDir, 'messages.json'), '{}', 'utf8');
    const raw = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    raw.id = malformedId;
    raw.mcpClient = { id: 'Bad Id With Spaces', name: 'Gemini\nEvil', version: 123 };
    await fs.writeFile(path.join(malformedDir, 'meta.json'), JSON.stringify(raw, null, 2), 'utf8');
    const reloaded = await getSession(malformedId);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.mcpClient).toBeUndefined();
    expect(isExternalMcpSession(reloaded!)).toBe(false);
  });

  it('tracks live and persisted external MCP client reachability without including OpenAI calls', async () => {
    expect(listLiveExternalMcpClients()).toEqual([]);
    expect(externalClientProofs()).toEqual([]);

    const geminiHeaders = { 'user-agent': 'gemini-cli/0.9.1' };
    await postRpc(
      endpoint.urls.core,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gemini-cli', version: '0.9.1' } } },
      geminiHeaders
    );
    await postRpc(
      endpoint.urls.core,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { paths: ['/repo/hello.txt'] } } },
      geminiHeaders
    );
    // OpenAI/ChatGPT-tagged calls must never be treated as external MCP clients.
    await postRpc(
      endpoint.urls.core,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read', arguments: { paths: ['/repo/hello.txt'] }, _meta: { 'openai/session': 's-1' } } },
      geminiHeaders
    );

    const live = listLiveExternalMcpClients();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      id: 'gemini',
      name: 'Gemini',
      version: '0.9.1',
      surfaces: ['core']
    });
    expect(live[0]!.lastToolCallAt).not.toBeNull();

    await connectorProofWritten();
    const proofsBeforeReload = externalClientProofs();
    expect(proofsBeforeReload).toHaveLength(1);
    expect(proofsBeforeReload[0]).toMatchObject({
      id: 'gemini',
      name: 'Gemini',
      version: '0.9.1',
      surfaces: ['core']
    });

    // Stopping the server clears live reachability while durable proof persists across reloads.
    await endpoint.stop();
    expect(listLiveExternalMcpClients()).toEqual([]);
    resetConnectorProofsForTests();
    await loadConnectorProof();
    expect(externalClientProofs()).toHaveLength(1);
    expect(externalClientProofs()[0]!.id).toBe('gemini');
  });

  it('attributes remote HTTP calls with ?client=gemini even without clientInfo or Gemini User-Agent', async () => {
    for (const s of await indexedSessions()) {
      if (s.mcpClient?.id === 'gemini' && s.endedAt === null) await endSession(s.id);
    }
    const beforeIds = new Set((await indexedSessions()).map((s) => s.id));
    const geminiUrl = `${endpoint.urls.core}?client=gemini`;
    const headers = { 'user-agent': 'Mozilla/5.0' };
    const initRes = await postRpc(
      geminiUrl,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      headers
    );
    expect(initRes.status).toBe(200);

    const readRes = await postRpc(
      geminiUrl,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { paths: ['/repo/hello.txt'] } } },
      headers
    );
    expect(readRes.status).toBe(200);
    const text: string = readRes.body?.result?.content?.[0]?.text ?? '';
    expect(text).toContain('hello from gemini workspace');
    expect(text).toContain('--- Identity notice ---');
    expect(text).toContain('"Gemini"');

    await flushRecorder();
    const created = (await indexedSessions()).filter(
      (s) => !beforeIds.has(s.id) && s.mcpClient?.id === 'gemini'
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.mcpClient).toEqual({ id: 'gemini', name: 'Gemini' });
    expect(created[0]!.toolCalls).toBe(1);
    expect(listLiveExternalMcpClients()[0]).toMatchObject({ id: 'gemini', name: 'Gemini', surfaces: ['core'] });
    await endSession(created[0]!.id);
  });
});
