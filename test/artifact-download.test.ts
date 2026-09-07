/**
 * download_artifact: ChatGPT-provided files land inside approved roots, and only there.
 *
 * Three layers, tested bottom-up like the implementation is built:
 * artifact-fetch (trusted-URL gateway) → artifact-target (exclusive publish) →
 * downloadArtifactFile (sandbox resolution + orchestration) → MCP surface
 * (registration, _meta fileParams, TOOL_DISABLED gating).
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeOpenAIFileReference,
  openArtifactFile,
  validateOpenAIFileUrl
} from '../src/main/mcp/artifact-fetch.js';
import { downloadArtifactFile } from '../src/main/mcp/artifact-download.js';
import {
  ARTIFACT_PARTIAL_PREFIX,
  openArtifactTarget
} from '../src/main/mcp/artifact-target.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/tools.js';
import { resetWorkspaces } from '../src/main/workspace.js';
import { DEFAULT_CAPABILITIES, type Capabilities, type Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const FILE_ID = 'file-abc123';
const GOOD_URL = 'https://files.oaiusercontent.com/file-abc123?se=2030&sig=test';

function fileRef(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { download_url: GOOD_URL, file_id: FILE_ID, ...over };
}

/** Minimal fetch stub: route URL → canned Response. */
function stubFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof fetch;
}

function okResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', ...headers }
  });
}

async function streamText(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const value of stream) {
    chunks.push(typeof value === 'string' ? Buffer.from(value) : Buffer.from(value as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ------------------------------------------------------------------ fetch gateway

describe('artifact file gateway', () => {
  it('accepts only the trusted ChatGPT file hosts over https', () => {
    expect(validateOpenAIFileUrl(GOOD_URL)).toBe(GOOD_URL);
    for (const bad of [
      'http://files.oaiusercontent.com/file-abc123',
      'https://evil.example.com/file-abc123',
      'https://files.oaiusercontent.com.evil.example.com/x',
      'https://myaccount.blob.core.windows.net/c/f',
      'https://oaisdmntprlookalike.blob.core.windows.net/c/f',
      'https://files.oaiusercontent.com:8080/x',
      'https://user:pass@files.oaiusercontent.com/x',
      'https://files.oaiusercontent.com/x#frag',
      'not-a-url'
    ]) {
      expect(() => validateOpenAIFileUrl(bad), bad).toThrow();
    }
  });

  it('rejects malformed or smuggled file references', () => {
    expect(() => normalizeOpenAIFileReference({})).toThrow();
    expect(() => normalizeOpenAIFileReference(fileRef({ file_id: 42 }))).toThrow();
    // strictObject behaviour lives in the tool schema; the gateway additionally refuses
    // unknown keys so a hand-built call cannot widen the reference shape.
    expect(() => normalizeOpenAIFileReference(fileRef({ authorization: 'Bearer x' }))).toThrow();
    expect(() => normalizeOpenAIFileReference(fileRef({ file_id: 'x'.repeat(600) }))).toThrow();
    expect(() => normalizeOpenAIFileReference(fileRef({ file_id: 'bad\x01id' }))).toThrow();
  });

  it('re-validates every redirect hop and rejects escapes', async () => {
    const fetch = stubFetch((url) => {
      if (url === GOOD_URL) return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/f' } });
      return okResponse('nope');
    });
    await expect(openArtifactFile(fileRef(), { fetch })).rejects.toThrow(/outside the trusted file host/);
  });

  it('follows an allowlisted redirect and checks size agreement', async () => {
    const target = 'https://files.oaiusercontent.com/redirected-file?sig=y';
    const fetch = stubFetch((url) => {
      if (url === GOOD_URL) return new Response(null, { status: 302, headers: { location: target } });
      return okResponse('hello', { 'content-length': '5' });
    });
    const opened = await openArtifactFile(fileRef({ size: 5, file_name: 'hi.txt' }), { fetch });
    expect(await streamText(opened.stream)).toBe('hello');
    const mismatch = stubFetch(() => okResponse('hello', { 'content-length': '5' }));
    await expect(openArtifactFile(fileRef({ size: 6 }), { fetch: mismatch })).rejects.toThrow(/did not match/);
  });


});

// ------------------------------------------------------------------ secure target

describe('artifact secure target', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('clf-artifact-target-');
  });
  afterEach(async () => { await removeTempDir(dir); });

  it('writes an exclusive partial and publishes it atomically', async () => {
    const target = await openArtifactTarget({ parentReal: dir, rootReal: dir, name: 'a.png', maxFileBytes: 1024 });
    await target.writeAll(Buffer.from('PNGDATA'), 0);
    await target.syncAndVerify(7);
    // Not visible before publish.
    await expect(fs.stat(path.join(dir, 'a.png'))).rejects.toMatchObject({ code: 'ENOENT' });
    await target.publish();
    await target.close();
    expect(await fs.readFile(path.join(dir, 'a.png'), 'utf8')).toBe('PNGDATA');
    const leftovers = (await fs.readdir(dir)).filter((f) => f.startsWith(ARTIFACT_PARTIAL_PREFIX));
    expect(leftovers).toEqual([]);
  });

  it('requires canonical paths even when a directory has a stable ancestor alias', async () => {
    const real = path.join(dir, 'real');
    const alias = path.join(dir, 'alias');
    await fs.mkdir(path.join(real, 'nested'), { recursive: true });
    await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const spelled = path.join(alias, 'nested');
    // Like macOS /var or a Windows runner junction, the leaf is an ordinary directory.
    // Its spelling still does not satisfy the target's sandbox-canonical contract.
    expect((await fs.lstat(spelled)).isSymbolicLink()).toBe(false);
    await expect(openArtifactTarget({ parentReal: spelled, rootReal: spelled, name: 'result.bin', maxFileBytes: 10 })).rejects.toThrow(/parent changed/);
    const canonical = await fs.realpath(spelled);
    const target = await openArtifactTarget({ parentReal: canonical, rootReal: canonical, name: 'result.bin', maxFileBytes: 10 });
    try {
      await target.writeAll(Buffer.from('safe'), 0);
      await target.syncAndVerify(4);
      await target.publish();
    } finally { await target.close(); }
    expect(await fs.readFile(path.join(spelled, 'result.bin'), 'utf8')).toBe('safe');
  });
  it('refuses to overwrite and leaves the existing file alone', async () => {
    await fs.writeFile(path.join(dir, 'taken.txt'), 'original');
    await expect(
      openArtifactTarget({ parentReal: dir, rootReal: dir, name: 'taken.txt', maxFileBytes: 1024 })
    ).rejects.toThrow(/already exists/);
    expect(await fs.readFile(path.join(dir, 'taken.txt'), 'utf8')).toBe('original');
  });

  it('rejects symlinked parents and unsafe names', async () => {
    const real = path.join(dir, 'real');
    await fs.mkdir(real);
    const linkPath = path.join(dir, 'linkparent');
    try {
      await fs.symlink(real, linkPath, 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(
      openArtifactTarget({ parentReal: linkPath, rootReal: dir, name: 'x.bin', maxFileBytes: 1024 })
    ).rejects.toThrow(/real directory/);
    for (const bad of ['..', '', 'a/b', 'a\\b']) {
      await expect(
        openArtifactTarget({ parentReal: dir, rootReal: dir, name: bad, maxFileBytes: 1024 })
      ).rejects.toThrow(/invalid/);
    }
  });

  it('refuses an equal-sized partial replacement before linking and does not remove that foreign file', async () => {
    const target = await openArtifactTarget({ parentReal: dir, rootReal: dir, name: 'result.bin', maxFileBytes: 100 });
    await target.writeAll(Buffer.from('safe'), 0);
    await target.syncAndVerify(4);
    const partial = path.join(dir, (await fs.readdir(dir)).find(file => file.startsWith(ARTIFACT_PARTIAL_PREFIX))!);
    await fs.rename(partial, path.join(dir, 'original.partial'));
    await fs.writeFile(partial, 'evil');
    await expect(target.publish()).rejects.toThrow(/changed/);
    await target.close();
    await expect(fs.stat(path.join(dir, 'result.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(partial, 'utf8')).toBe('evil');
  });
  it('refuses a changed parent after streaming without creating a destination there', async () => {
    const folder = path.join(dir, 'folder');
    await fs.mkdir(folder);
    const target = await openArtifactTarget({ parentReal: folder, rootReal: dir, name: 'result.bin', maxFileBytes: 100 });
    await target.writeAll(Buffer.from('safe'), 0);
    await target.syncAndVerify(4);
    // Windows rejects renaming a directory with our open partial. Model the changed
    // canonical observation directly so this publication boundary is tested on every OS.
    const { rawPromises } = await import('../src/main/rawfs.js');
    const realpath = vi.spyOn(rawPromises, 'realpath').mockResolvedValueOnce(path.join(dir, 'moved'));
    try { await expect(target.publish()).rejects.toThrow(/parent changed/); }
    finally { realpath.mockRestore(); await target.close(); }
    expect(await fs.readdir(folder)).toEqual([]);
  });
});

// ------------------------------------------------------------------ orchestration

describe('downloadArtifactFile', () => {
  let base: string;
  let approved: string;
  let roots: Root[];

  beforeAll(async () => {
    base = await makeTempDir('clf-artifact-');
    approved = path.join(base, 'workspace');
    await fs.mkdir(approved, { recursive: true });
    roots = [{ name: 'workspace', path: approved }];
  });

  afterAll(async () => {
    await removeTempDir(base);
  });

  beforeEach(() => {
    resetWorkspaces();
  });

  function fetchBytes(body: string): typeof fetch {
    return stubFetch(() => okResponse(body, { 'content-length': String(Buffer.byteLength(body)) }));
  }

  it('saves into an existing nested folder and reports size+sha256', async () => {
    await fs.mkdir(path.join(approved, 'reports'));
    const saved = await downloadArtifactFile(roots, '/workspace/reports/icon.png', fileRef(), {
      maxFileBytes: 1024 * 1024,
      fetch: fetchBytes('IMAGEDATA!')
    });
    expect(saved.virtual).toBe('/workspace/reports/icon.png');
    expect(saved.size).toBe(10);
    expect(saved.sha256).toBe(`sha256:${createHash('sha256').update('IMAGEDATA!').digest('hex')}`);
    expect(await fs.readFile(path.join(approved, 'reports', 'icon.png'), 'utf8')).toBe('IMAGEDATA!');
  });

  it('cleans a partial and cancels an oversized response before reading its body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '100' } });
    await expect(downloadArtifactFile(roots, '/workspace/cancel.bin', fileRef(), {
      maxFileBytes: 4, fetch: stubFetch(() => response)
    })).rejects.toThrow(/limit/);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledOnce();
    expect((await fs.readdir(approved)).filter(file => file.startsWith(ARTIFACT_PARTIAL_PREFIX))).toEqual([]);
    await expect(fs.stat(path.join(approved, 'cancel.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves no partial after a fetch failure and never creates missing parents', async () => {
    await expect(downloadArtifactFile(roots, '/workspace/fetchfail.bin', fileRef(), {
      maxFileBytes: 4, fetch: (async () => { throw new Error('private network detail'); }) as typeof fetch
    })).rejects.toThrow('ChatGPT file could not be downloaded.');
    expect((await fs.readdir(approved)).filter(file => file.startsWith(ARTIFACT_PARTIAL_PREFIX))).toEqual([]);
    const fetch = vi.fn();
    await expect(downloadArtifactFile(roots, '/workspace/missing/child.bin', fileRef(), { maxFileBytes: 4, fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(approved, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses traversal, folders, existing files and oversized streams', async () => {
    await expect(
      downloadArtifactFile(roots, '/workspace/../../evil.bin', fileRef(), {
        maxFileBytes: 1024,
        fetch: fetchBytes('x')
      })
    ).rejects.toThrow();
    await expect(
      downloadArtifactFile(roots, '/workspace/folder/', fileRef(), {
        maxFileBytes: 1024,
        fetch: fetchBytes('x')
      })
    ).rejects.toThrow(/folder/);
    await fs.writeFile(path.join(approved, 'kept.bin'), 'keep');
    await expect(
      downloadArtifactFile(roots, '/workspace/kept.bin', fileRef(), {
        maxFileBytes: 1024,
        fetch: fetchBytes('new')
      })
    ).rejects.toThrow(/already exists/);
    expect(await fs.readFile(path.join(approved, 'kept.bin'), 'utf8')).toBe('keep');
    await expect(
      downloadArtifactFile(roots, '/workspace/big.bin', fileRef(), {
        maxFileBytes: 4,
        fetch: fetchBytes('way too long')
      })
    ).rejects.toThrow(/limit/);
    await expect(
      downloadArtifactFile(roots, '/workspace/x.bin', { nope: true }, {
        maxFileBytes: 1024,
        fetch: fetchBytes('x')
      })
    ).rejects.toThrow(/malformed/);
  });
});

// ------------------------------------------------------------------ MCP surface

describe('download_artifact MCP surface', () => {
  let base: string;
  let approved: string;
  let endpoint: McpEndpoint;
  let ctx: ToolContext;
  let nextId = 1;

  const withCaps = (overrides: Partial<Capabilities>): Capabilities => ({ ...DEFAULT_CAPABILITIES, ...overrides });

  function rawCall(body: string): Promise<{ status: number; parsed: any }> {
    const url = new URL(endpoint.urls.core);
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
            'content-length': Buffer.byteLength(body)
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            let parsed: any = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              const last = [...text.matchAll(/^data:\s*(.*)$/gm)].map((m) => m[1]).at(-1);
              if (last !== undefined) parsed = JSON.parse(last);
            }
            resolve({ status: res.statusCode ?? 0, parsed });
          });
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  const list = async (): Promise<Array<Record<string, any>>> => {
    const { parsed } = await rawCall(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} }));
    return (parsed?.result?.tools ?? []) as Array<Record<string, any>>;
  };

  beforeAll(async () => {
    base = await makeTempDir('clf-artifact-mcp-');
    approved = path.join(base, 'workspace');
    await fs.mkdir(approved, { recursive: true });
  });

  afterAll(async () => {
    if (endpoint) await endpoint.stop();
    await removeTempDir(base);
  });

  beforeEach(async () => {
    if (endpoint) await endpoint.stop();
    resetWorkspaces();
    ctx = {
      roots: [{ name: 'workspace', path: approved }],
      caps: withCaps({}),
      readOnly: true,
      sessionTools: false,
      agentTools: false
    };
    endpoint = await startMcpServer(() => ctx);
  });

  it('is absent without the capability and advertised with fileParams once enabled', async () => {
    expect((await list()).map((t) => t.name)).not.toContain('download_artifact');
    ctx.caps = withCaps({ saveArtifact: true });
    const tools = await list();
    const tool = tools.find((t) => t.name === 'download_artifact');
    expect(tool).toBeDefined();
    // The one field ChatGPT needs to inject the native file value (the spike question).
    expect(tool?.['_meta']).toMatchObject({ 'openai/fileParams': ['file'] });
  });

  it('keeps the schema but refuses the call after the permission is switched off', async () => {
    ctx.caps = withCaps({ saveArtifact: true });
    expect((await list()).map((t) => t.name)).toContain('download_artifact');
    ctx.caps = withCaps({});
    ctx.readOnly = false;
    const { parsed } = await rawCall(
      JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name: 'download_artifact', arguments: { file: fileRef(), path: '/workspace/x.bin' } }
      })
    );
    expect(parsed?.result?.isError).toBe(true);
    expect(JSON.stringify(parsed?.result?.content)).toContain('TOOL_DISABLED');
  });
});
