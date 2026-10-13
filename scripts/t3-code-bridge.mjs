import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseArgs } from 'node:util';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const fail = code => { throw new Error(code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const session = /^[0-9a-z-]{8,64}$/;
const MAX_BYTES = 2 * 1024 * 1024;

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('invalid_request');
  return value;
}

function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid_text');
  return value;
}

function address(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('invalid_id');
  return value;
}

function integer(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) fail('invalid_number');
  return value;
}

async function readJson(file, max = MAX_BYTES) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) fail('file_too_large');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await handle.close(); }
}

function userData() {
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) fail('data_dir_required');
    return path.join(process.env.APPDATA, 'chat-on-steroids');
  }
  return path.join(process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'chat-on-steroids');
}

async function credentials(directory) {
  try {
    const endpoint = await readJson(path.join(directory, 'control-api/endpoint.json'), 4096);
    if (endpoint.protocol !== 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) fail('unsupported_endpoint');
    const token = (await fs.readFile(path.join(directory, 'control-api/token'), 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(token)) fail('invalid_token');
    return { port: endpoint.port, token };
  } catch (error) {
    if (error.code === 'ENOENT') fail('control_api_disabled: enable Local control API in CoS Settings > General > For developers');
    throw error;
  }
}

function request(connection, route, body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: connection.port, path: route,
      method: encoded === null ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + connection.token, ...(encoded === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }) }
    }, res => {
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) req.destroy(new Error('response_too_large'));
        else chunks.push(chunk);
      });
      res.on('error', () => reject(new Error('connection_lost')));
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // Only publish the machine code, never a server message that might echo credentials.
            reject(new Error(typeof value.error === 'string' && /^[a-z_]{1,80}$/.test(value.error) ? value.error : 'http_' + res.statusCode));
          } else resolve(value);
        } catch { reject(new Error('invalid_response')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('request_timeout')), 25_000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', error => reject(new Error(error.message === 'response_too_large' || error.message === 'request_timeout' ? error.message : 'connection_lost')));
    req.end(encoded);
  });
}

function sendBody(value, delegate) {
  object(value, ['id', 'sessionId', 'projectId', 'interrupt', ...(delegate ? ['context', 'workers'] : ['text'])]);
  const body = { id: address(value.id, uuid) };
  if (value.sessionId !== undefined) body.sessionId = address(value.sessionId, session);
  if (value.projectId !== undefined) body.projectId = address(value.projectId, uuid);
  if (body.sessionId && body.projectId) fail('project_requires_new_chat');
  if (value.interrupt !== undefined) {
    if (typeof value.interrupt !== 'boolean') fail('invalid_interrupt');
    body.interrupt = value.interrupt;
  }
  if (!delegate) body.text = text(value.text, 64_000);
  else {
    if (!Array.isArray(value.workers) || value.workers.length < 1 || value.workers.length > 8) fail('invalid_workers');
    for (const worker of value.workers) {
      object(worker, ['label', 'task']);
      text(worker.task, 4000);
      if (worker.label !== undefined) text(worker.label, 60);
    }
    if (value.context !== undefined) text(value.context, 4000);
    body.text = [
      'T3 Code delegates the following work to this ChatGPT coordinator through Chat On Steroids.',
      'Use the CoS agents tool to perform these assignments. Check status once, reuse suitable sleeping workers with message, and spawn only when needed. Omit model and reasoning_effort overrides; use saved defaults. Respect worker capacity and dispatch remaining assignments as slots become available.',
      'Give each worker the shared context and its exact assignment. Workers must not delegate further. Keep work within the authorized scope and permissions; if agents is unavailable, report the blocker instead of claiming delegation.',
      'Report progress in this conversation, including returned run_id and worker ids. Collect worker reports before finalizing. Return RESULT / CHANGES / VALIDATION / BLOCKERS with factual evidence. Do not repeatedly poll agents status.',
      'Assignments (JSON):', JSON.stringify({ context: value.context ?? '', workers: value.workers })
    ].join('\n\n');
  }
  return body;
}

function updates(connection, route, from, durationMs, limit) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let count = 0;
    let nextFrom = from;
    const finish = (reason, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.destroy();
      emit({ end: reason, nextFrom });
      if (error) reject(error); else resolve();
    };
    const req = http.get({ hostname: '127.0.0.1', port: connection.port, path: route,
      headers: { authorization: 'Bearer ' + connection.token, accept: 'text/event-stream' }
    }, res => {
      if (res.statusCode !== 200 || !res.headers['content-type']?.startsWith('text/event-stream')) {
        finish('refused', new Error('http_' + res.statusCode)); return;
      }
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      res.on('data', chunk => {
        if (finished) return;
        buffer += decoder.write(chunk);
        try {
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            if (Buffer.byteLength(frame) > 65536) fail('frame_too_large');
            const lines = frame.split(/\r?\n/);
            const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data) continue;
            const value = JSON.parse(data);
            if (lines.some(line => line === 'event: end')) {
              finish(typeof value.reason === 'string' && /^[a-z_]{1,80}$/.test(value.reason) ? value.reason : 'ended'); return;
            }
            const id = lines.find(line => line.startsWith('id:'))?.slice(3).trim();
            if (!/^\d{1,8}$/.test(id ?? '') || value.seq !== Number(id)) fail('invalid_event');
            if (value.seq < nextFrom) continue;
            nextFrom = value.seq + 1;
            emit({ event: value, nextFrom });
            if (++count >= limit) { finish('limit'); return; }
          }
          if (Buffer.byteLength(buffer) > 65536) fail('frame_too_large');
        } catch { finish('invalid_stream', new Error('invalid_stream')); }
      });
      res.on('end', () => finish('closed', new Error('stream_closed')));
      res.on('error', () => finish('connection_lost', new Error('connection_lost')));
    });
    const timer = setTimeout(() => finish('duration'), durationMs);
    req.on('error', () => finish('connection_lost', new Error('connection_lost')));
  });
}

let operationId;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' }, 'request-file': { type: 'string' } } });
  if (positionals.length !== 1 || !['delegate', 'send', 'inputs', 'health', 'status', 'sessions', 'session', 'agents', 'updates'].includes(positionals[0])) fail('unknown_command');
  const command = positionals[0];
  const input = values['request-file'] ? await readJson(values['request-file']) : {};
  let body;
  let route;
  switch (command) {
    case 'send':
    case 'delegate':
      body = sendBody(input, command === 'delegate');
      operationId = body.id;
      route = '/v1/inputs';
      break;
    case 'inputs':
      object(input, ['id']); if (input.id !== undefined) address(input.id, uuid);
      route = '/v1/inputs?limit=500';
      break;
    case 'sessions': {
      object(input, ['limit', 'cursor']);
      const query = new URLSearchParams({ limit: String(integer(input.limit, 20, 1, 50)) });
      if (input.cursor !== undefined) query.set('cursor', address(input.cursor, /^\d{1,16}\.[0-9a-z-]{8,64}$/));
      route = '/v1/sessions?' + query;
      break;
    }
    case 'session':
      object(input, ['sessionId']);
      route = '/v1/sessions/' + address(input.sessionId, session) + '?live=1';
      break;
    case 'agents':
      object(input, ['runId']); if (input.runId !== undefined) address(input.runId, uuid);
      route = '/v1/agents';
      break;
    case 'updates': {
      object(input, ['sessionId', 'from', 'durationMs', 'limit']);
      integer(input.durationMs, 30_000, 1, 45_000);
      integer(input.limit, 100, 1, 100);
      const query = new URLSearchParams({ from: String(integer(input.from, 0, 0, 10_000_000)), kinds: 'user_message,assistant_message,progress,agent_message,turn_start,turn_end,chat_error' });
      route = '/v1/sessions/' + address(input.sessionId, session) + '/events/stream?' + query;
      break;
    }
    default:
      object(input, []);
      route = '/v1/' + command;
  }
  const connection = await credentials(values['data-dir'] ?? userData());
  if (command === 'updates') {
    const health = await request(connection, '/v1/health');
    if (health.protocol !== 1 || !Array.isArray(health.routes)) fail('unsupported_endpoint');
    if (health.routes.includes('/v1/sessions/{id}/events/stream')) {
      await updates(connection, route, input.from ?? 0, input.durationMs ?? 30_000, input.limit ?? 100);
    } else {
      const streamQuery = new URLSearchParams(route.split('?')[1]);
      const pageQuery = new URLSearchParams({ from: streamQuery.get('from'), limit: String(input.limit ?? 100), kinds: streamQuery.get('kinds') });
      const page = await request(connection, route.split('/events/stream')[0] + '/events?' + pageQuery);
      for (const event of page.events) emit({ event, nextFrom: event.seq + 1 });
      emit({ end: 'page', nextFrom: page.nextFrom });
    }
  }
  else {
    const result = await request(connection, route, body);
    if (command === 'inputs' && input.id) emit({ input: result.inputs.find(row => row.id === input.id) ?? null, missing: 'A missing row does not prove it was never sent; the outbox retains limited history.' });
    else if (command === 'agents' && input.runId) emit({ ...result, agents: result.agents.filter(row => row.runId === input.runId) });
    else emit({ ...result, ...(command === 'delegate' ? { delegation: 'requested' } : {}) });
  }
} catch (error) {
  const allowed = /^[a-z_0-9]+(?:: enable Local control API in CoS Settings > General > For developers)?$/;
  emit({ error: allowed.test(error.message) ? error.message : 'bridge_error', ...(operationId ? { inputId: operationId, recovery: 'Inspect inputs before retrying. Never resend an unconfirmed delivery.' } : {}) });
  process.exitCode = 1;
}
