/**
 * The real thing: the Core MCP surface invoking a real headless Claude through the machine's
 * stored claude.ai login. Opt in with COS_HEADLESS_CLAUDE_LIVE=1; it spends subscription usage.
 *
 * What this proves is exactly the model-facing path — HTTP JSON-RPC into the Core endpoint,
 * `session` action=invoke, the CLI, and the structured reply — with nothing mocked. What it
 * does not prove is ChatGPT itself issuing the call; that needs a connected conversation.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/tools.js';
import { initSessionStore } from '../src/main/session/store.js';
import { DEFAULT_CAPABILITIES, type Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

const LIVE = process.env['COS_HEADLESS_CLAUDE_LIVE'] === '1';
const MODEL = (process.env['COS_HEADLESS_CLAUDE_MODEL'] ?? 'fable') as 'fable' | 'opus' | 'sonnet' | 'haiku';
const TOKEN = 'HEADLESS_FABLE_SURFACE_OK';

function post(url: string, body: string): Promise<string> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function decode(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const last = [...trimmed.matchAll(/^data:\s*(.*)$/gm)].map((m) => m[1] ?? '').at(-1);
  return last ? JSON.parse(last) : null;
}

describe.runIf(LIVE)('live headless Claude through the Core surface', () => {
  let base: string;
  let endpoint: McpEndpoint;
  let ctx: ToolContext;

  beforeAll(async () => {
    base = await makeTempDir('clf-headless-live-');
    initSessionStore(base);
    await writeTree(`${base}/workspace`, { 'README.md': '# scratch\n' });
    ctx = {
      roots: [{ name: 'workspace', path: `${base}/workspace` }] as Root[],
      caps: { ...DEFAULT_CAPABILITIES },
      readOnly: true,
      sessionTools: true,
      agentTools: false,
      headlessClaudeTools: true
    };
    endpoint = await startMcpServer(() => ctx);
  });

  afterAll(async () => {
    if (endpoint) await endpoint.stop();
    await removeTempDir(base);
  });

  it(`invokes ${MODEL} in the reasoning profile and returns exactly ${TOKEN}`, async () => {
    const reply = decode(
      await post(
        endpoint.urls.core,
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'session',
            arguments: {
              action: 'invoke',
              provider: 'claude',
              model: MODEL,
              prompt: `Reply with exactly ${TOKEN} and nothing else.`,
              workdir: '/workspace',
              timeout_seconds: 180
            }
          }
        })
      )
    );
    const text = (reply.result?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('\n');
    // Printed whole so a failing live run leaves the real facts in the log.
    console.log(text);
    expect(reply.error, JSON.stringify(reply.error)).toBeUndefined();
    expect(reply.result?.isError, text).toBeFalsy();
    const structured = reply.result?.structuredContent as Record<string, any>;
    expect(structured.status).toBe('completed');
    expect(structured.provider).toBe('claude');
    expect(structured.profile).toBe('reasoning');
    expect(structured.cwd).toBe('/workspace');
    expect(structured.auth?.method).toBe('claude.ai');
    expect(structured.model.requested).toBe(MODEL);
    expect(structured.model.canonical).toMatch(/^claude-/);
    expect(structured.model.resolved).toBe(structured.model.canonical);
    expect(structured.model.fallback).toBeNull();
    expect(structured.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(structured.usage.output_tokens).toBeGreaterThan(0);
    expect(structured.result.trim()).toBe(TOKEN);
    expect(text).toContain(`result:\n${TOKEN}`);
  }, 240_000);
});
