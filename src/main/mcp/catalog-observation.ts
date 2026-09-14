import { createHash } from 'node:crypto';
import type { FetchLikeMcpHandler } from '@modelcontextprotocol/node';

export interface CatalogObservation {
  method: 'initialize' | 'server/discover' | 'tools/list';
  httpStatus: number;
  outcome: 'success' | 'http-error' | 'rpc-error' | 'invalid-catalog' | 'unparsed';
  toolCount?: number;
  definitionHash?: string;
  rpcErrorCode?: number;
  advertisesTools?: boolean;
}

/** Observation never consumes the original body or retains payloads in logs/state. */
async function boundedText(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string | null> {
  if (!stream) return null;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return Buffer.concat(chunks).toString('utf8');
      bytes += item.value.byteLength;
      if (bytes > maxBytes) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(item.value);
    }
  } catch { return null; }
  finally { reader.releaseLock(); }
}

function responseObject(text: string | null, id: unknown): Record<string, any> | null {
  if (!text) return null;
  const parse = (value: string): Record<string, any> | null => {
    try {
      const object = JSON.parse(value);
      return object && typeof object === 'object' && !Array.isArray(object) && object.jsonrpc === '2.0' && object.id === id ? object : null;
    } catch { return null; }
  };
  const json = parse(text);
  if (json) return json;
  for (const frame of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    const object = parse(data);
    if (object && ('result' in object || 'error' in object)) return object;
  }
  return null;
}

/** Fixed-size summaries only: no request IDs, arguments, URLs, schema bodies or errors' text. */
export function summarizeCatalogResponse(method: CatalogObservation['method'], id: unknown, status: number, text: string | null): CatalogObservation {
  const summary: CatalogObservation = { method, httpStatus: status, outcome: 'unparsed' };
  const object = responseObject(text, id);
  if (typeof object?.error?.code === 'number' && Number.isFinite(object.error.code)) summary.rpcErrorCode = object.error.code;
  if (status < 200 || status >= 300) return { ...summary, outcome: 'http-error' };
  if (object?.error) return { ...summary, outcome: 'rpc-error' };
  if (!object?.result || typeof object.result !== 'object' || Array.isArray(object.result)) return summary;
  if (method === 'initialize') {
    const { serverInfo, capabilities, protocolVersion } = object.result;
    if (typeof serverInfo?.name !== 'string' || !serverInfo.name || typeof serverInfo.version !== 'string' ||
      !capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities) ||
      typeof protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(protocolVersion)) return summary;
    return { ...summary, outcome: 'success', advertisesTools: !!capabilities.tools && typeof capabilities.tools === 'object' && !Array.isArray(capabilities.tools) };
  }
  if (method !== 'tools/list') return { ...summary, outcome: 'success' };
  const tools = object.result.tools;
  if (!Array.isArray(tools)) return { ...summary, outcome: 'invalid-catalog' };
  summary.toolCount = tools.length;
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || !tool.name.trim() || names.has(tool.name) ||
      !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema) || tool.inputSchema.type !== 'object') {
      return { ...summary, outcome: 'invalid-catalog' };
    }
    names.add(tool.name);
  }
  return { ...summary, outcome: 'success', definitionHash: createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16) };
}

/** Keeps the SDK's original Response and backpressure path intact. */
export function observeCatalogTraffic(handler: FetchLikeMcpHandler, observe: (summary: CatalogObservation) => void): FetchLikeMcpHandler {
  return { fetch: async (request, options) => {
    let parsed: { method?: unknown; id?: unknown } | null = null;
    if (request.method === 'POST' && /^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) {
      try { parsed = JSON.parse(await boundedText(request.clone().body, 16 * 1024) ?? 'null'); } catch { /* Diagnostic only. */ }
    }
    const response = await handler.fetch(request, options);
    const method = parsed?.method;
    if (method === 'initialize' || method === 'server/discover' || method === 'tools/list') {
      try {
        void boundedText(response.clone().body, 512 * 1024).then(text => {
          observe(summarizeCatalogResponse(method, parsed?.id, response.status, text));
        }).catch(() => {});
      } catch { /* An observation failure cannot change the response. */ }
    }
    return response;
  } };
}
