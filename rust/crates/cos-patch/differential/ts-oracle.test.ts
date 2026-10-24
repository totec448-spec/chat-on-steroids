// The TypeScript side of the cos-patch differential: the real MCP server of the app (no Electron
// window), the real apply_patch tool, one fresh tree per case. `run.mjs` starts this file and
// compares what it writes with the Rust probe's output.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';

import { startMcpServer, type McpEndpoint } from '../../../../src/main/mcp/server.js';
import type { ToolContext } from '../../../../src/main/mcp/tools.js';
import { initSessionStore } from '../../../../src/main/session/store.js';
import { initSkillsPath } from '../../../../src/main/skills.js';
import { resetWorkspaces } from '../../../../src/main/workspace.js';
import { DEFAULT_CAPABILITIES, type Capabilities } from '../../../../src/shared/types.js';

interface Case {
  name: string;
  files?: Record<string, string>;
  binary?: Record<string, string>;
  dirs?: string[];
  readonly?: string[];
  caps?: Partial<Capabilities>;
  second?: boolean;
  secondFiles?: Record<string, string>;
  calls: string[];
}

const casesFile = process.env.COS_PATCH_DIFF_CASES;
const outFile = process.env.COS_PATCH_DIFF_OUT;
const baseCaps = JSON.parse(process.env.COS_PATCH_DIFF_CAPS ?? '{}') as Partial<Capabilities>;

function post(url: string, body: string): Promise<string> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    request.on('error', reject);
    request.end(body);
  });
}

function decode(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const frames = [...trimmed.matchAll(/^data:\s*(.*)$/gm)].map((match) => match[1] ?? '');
  return JSON.parse(frames.at(-1) ?? 'null');
}

async function writeTree(root: string, files: Record<string, string>, encoding: 'utf8' | 'base64'): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.from(content, encoding));
  }
}

/** Every file and folder under `root`: text, `{ base64 }`, or a digest for a large file. */
async function snapshot(root: string, prefix: string, out: Record<string, unknown>): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    const key = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      out[`${key}/`] = 'dir';
      await snapshot(full, `${key}/`, out);
      continue;
    }
    const bytes = await fs.readFile(full);
    out[key] = describe(bytes);
  }
}

function describe(bytes: Buffer): unknown {
  if (bytes.length > 1024 * 1024) {
    return { len: bytes.length, head: bytes.subarray(0, 64).toString('base64'), tail: bytes.subarray(-64).toString('base64') };
  }
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : { base64: bytes.toString('base64') };
}

async function unlockAll(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await unlockAll(full);
    else await fs.chmod(full, 0o666).catch(() => {});
  }
}

const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-patch-ts-')));
initSessionStore(path.join(work, 'profile'));
// The app's Core surface always adds the managed Skills folder as `/skills`.
await initSkillsPath(path.join(work, 'profile'));
let endpoint: McpEndpoint | undefined;

afterAll(async () => {
  if (endpoint) await endpoint.stop();
  await unlockAll(work);
  await fs.rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

it('applies every differential case through the TypeScript apply_patch', async () => {
  expect(casesFile && outFile).toBeTruthy();
  const cases = JSON.parse(await fs.readFile(casesFile!, 'utf8')) as Case[];
  const results: Record<string, unknown> = {};
  let id = 1;
  for (const [index, testCase] of cases.entries()) {
    const run = path.join(work, String(index));
    const project = path.join(run, 'project');
    const second = path.join(run, 'second');
    for (const dir of [project, second]) await fs.mkdir(dir, { recursive: true });
    for (const dir of testCase.dirs ?? []) await fs.mkdir(path.join(project, dir), { recursive: true });
    await writeTree(project, testCase.files ?? {}, 'utf8');
    await writeTree(project, testCase.binary ?? {}, 'base64');
    await writeTree(second, testCase.secondFiles ?? {}, 'utf8');
    for (const file of testCase.readonly ?? []) await fs.chmod(path.join(project, file), 0o444);

    const ctx: ToolContext = {
      roots: [
        { name: 'project', path: project },
        ...(testCase.second ? [{ name: 'second', path: second }] : [])
      ],
      caps: { ...DEFAULT_CAPABILITIES, ...baseCaps, ...testCase.caps },
      readOnly: false,
      sessionTools: false,
      agentTools: false
    };
    if (endpoint) await endpoint.stop();
    endpoint = await startMcpServer(() => ctx);

    const calls: unknown[] = [];
    for (const call of testCase.calls) {
      resetWorkspaces();
      const patch = call
        .replaceAll('<PROJECT_NATIVE>', project)
        .replaceAll('<PROJECT_FWD>', project.replaceAll('\\', '/'));
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: id++,
        method: 'tools/call',
        params: { name: 'apply_patch', arguments: { patch } }
      });
      const reply = decode(await post(endpoint.urls.core, body));
      calls.push(
        reply.error
          ? { error: reply.error.message }
          : { text: reply.result?.content?.[0]?.text ?? null, isError: reply.result?.isError === true }
      );
    }
    const disk: Record<string, unknown> = {};
    await snapshot(project, 'project/', disk);
    await snapshot(second, 'second/', disk);
    results[testCase.name] = { roots: [project, second], calls, disk };
  }
  await fs.writeFile(outFile!, JSON.stringify(results, null, 1));
}, 600_000);
