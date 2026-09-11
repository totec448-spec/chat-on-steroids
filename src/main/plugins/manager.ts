import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolSchema } from '@modelcontextprotocol/core';
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type Tool, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { getMcpConfigForManifest, vAny } from '@anthropic-ai/mcpb/browser';
import { getSecret, setSecret, clearSecret } from '../secrets.js';
import { readDurable, writeDurableNow } from '../durable.js';
import { setEnvValue } from '../env.js';
import { redactCredentialText } from '../redaction.js';
import type { PluginConfigPatch, PluginInstallRequest, PluginSnapshot, PluginView } from '../../shared/plugins.js';
import { installSource, pluginEnvironment, resolveGithub, stopInstallers, type InstalledLaunch } from './installer.js';
import { terminateProcessTree } from '../exec.js';
import { pluginCatalog, reviewedPluginLicense } from './catalog.js';
import sharp from 'sharp';
import { pluginExposure } from './exposure.js';
import { PluginOAuth, PluginNeedsAuth, PluginOAuthSetupError, clearPluginOAuth } from './oauth.js';
export { PLUGIN_MAX_TOOLS, PLUGIN_MAX_SCHEMA_BYTES } from './exposure.js';

interface RecordEntry extends Omit<PluginView, 'tools'> {
  /** Validated discovery belongs to the installation, not a replaceable connection. */
  catalog: Tool[];
  directory: string;
  launch: InstalledLaunch;
  disabledTools: string[];
}
interface Live {
  client: Client;
  tools: Tool[];
  transport?: StdioClientTransport;
  users: number;
  oauth?: PluginOAuth;
}
const boundedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: 'error' });
  if (!response.body) return response;
  let size = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > 16 * 1024 * 1024) throw new Error('Plugin HTTP response exceeds 16 MiB');
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

/** Installation policy owns connections; lifecycle mutations serialize per installation. */
export class PluginManager {
  constructor(private openAuthorization: (url: URL) => Promise<void> = async url => {
    const { shell } = await import('electron'); await shell.openExternal(url.href);
  }) {}
  private root = '';
  private records: RecordEntry[] = [];
  private live = new Map<string, Live>();
  private listeners = new Set<() => void>();
  private queues = new Map<string, Promise<unknown>>();
  private starting = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private secretValues = new Set<string>();
  private revision = 0;
  private exposureCache: ReturnType<typeof pluginExposure> | null = null;
  private closing = false;
  private connecting = new Map<Client, StdioClientTransport | undefined>();
  private authenticating = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    this.exposureCache = null;
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).then(fn);
    const settled = next.catch(() => undefined);
    this.queues.set(id, settled);
    void settled.finally(() => { if (this.queues.get(id) === settled) this.queues.delete(id); });
    return next;
  }
  private async save(): Promise<void> {
    // Catalog/configuration mutations are observable while their durable write awaits.
    this.exposureCache = null;
    await writeDurableNow('plugins', this.records);
  }
  async initialize(userDataDir: string): Promise<void> {
    this.root = path.join(userDataDir, 'plugins');
    this.closing = false;
    await fs.mkdir(this.root, { recursive: true });
    const stored = await readDurable<RecordEntry[]>('plugins');
    this.records = Array.isArray(stored) && stored.length <= 24
      ? stored.filter(p => this.validRecord(p)).map(p => {
        const { tools: _legacyTools, ...record } = p as RecordEntry & { tools?: unknown };
        const catalog = this.validCatalog(record.catalog);
        return { ...record, catalog, status: record.enabled ? 'connecting' : 'disabled' };
      })
      : [];
    this.changed();
    // Installation + enabled policy owns the runtime. Restore connections in the
    // background so slow external servers never delay the app's first window.
    void Promise.all(this.records.filter(row => row.enabled).map(row => this.connect(row))).catch(() => undefined);
  }
  private exposure() {
    return this.exposureCache ??= pluginExposure(this.records.map(row => ({
      id: row.id, name: row.name, enabled: row.enabled && !['error', 'needs-auth', 'authenticating'].includes(row.status) && (row.source.auth !== 'oauth' || this.live.has(row.id)),
      tools: row.catalog, disabledTools: row.disabledTools,
    })));
  }
  snapshot(): PluginSnapshot {
    const exposure = this.exposure();
    return structuredClone({
      catalog: pluginCatalog,
      schemaRevision: this.revision,
      plugins: this.records.map(({ directory: _, launch: __, disabledTools, catalog, ...row }) => ({
        ...row,
        license: reviewedPluginLicense({ ...row.source, version: row.version }, row.license),
        tools: catalog.map(tool => ({
          name: tool.name, exposedName: tool.name, description: tool.description,
          enabled: !disabledTools.includes(tool.name),
          published: exposure.owners.get(tool.name) === row.id,
          ...(exposure.issues.get(row.id)?.get(tool.name) ? { exposureError: exposure.issues.get(row.id)!.get(tool.name) } : {}),
        })),
      })),
    });
  }
  private validCatalog(value: unknown): Tool[] {
    try {
      if (!Array.isArray(value) || value.length > 256 || Buffer.byteLength(JSON.stringify(value)) > 1000000) return [];
      const tools = value.map(tool => ToolSchema.parse(tool));
      return new Set(tools.map(tool => tool.name)).size === tools.length ? tools : [];
    } catch { return []; }
  }
  redact(value: unknown): unknown {
    if (typeof value === 'string') {
      let out = redactCredentialText(value);
      for (const secret of this.secretValues) if (secret) out = out.split(secret).join('[redacted]');
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => this.redact(v));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redact(v)]));
    return value;
  }
  /** Redact authored values without rewriting protocol tags or opaque binary encodings. */
  redactResult(result: CallToolResult): CallToolResult {
    return {
      ...result,
      ...(result.structuredContent === undefined ? {} : { structuredContent: this.redact(result.structuredContent) as Record<string, unknown> }),
      ...(result._meta === undefined ? {} : { _meta: this.redact(result._meta) as Record<string, unknown> }),
      content: result.content.map((block) => {
        const metadata = '_meta' in block ? { _meta: this.redact(block._meta) as Record<string, unknown> } : {};
        if (block.type === 'text') return { ...block, ...metadata, text: String(this.redact(block.text)) };
        if (block.type === 'resource') return {
          ...block, ...metadata,
          resource: {
            ...block.resource,
            ...('_meta' in block.resource ? { _meta: this.redact(block.resource._meta) as Record<string, unknown> } : {}),
            uri: String(this.redact(block.resource.uri)),
            ...('text' in block.resource ? { text: String(this.redact(block.resource.text)) } : {}),
          },
        };
        if (block.type === 'resource_link') return {
          ...block, ...metadata, name: String(this.redact(block.name)), uri: String(this.redact(block.uri)),
          ...(block.title === undefined ? {} : { title: String(this.redact(block.title)) }),
          ...(block.description === undefined ? {} : { description: String(this.redact(block.description)) }),
        };
        return { ...block, ...metadata };
      }),
    };
  }
  private row(id: string): RecordEntry {
    const p = this.records.find((p) => p.id === id);
    if (!p) throw new Error('Plugin not found');
    return p;
  }
  private validRecord(p: RecordEntry): boolean {
    try {
      if (
        !p ||
        typeof p.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(p.id) ||
        typeof p.name !== 'string' ||
        typeof p.directory !== 'string' ||
        typeof p.enabled !== 'boolean' ||
        !p.source ||
        (p.source.auth !== undefined && (p.source.auth !== 'oauth' || p.source.kind !== 'remote')) ||
        !['command', 'npm', 'python', 'mcpb', 'remote'].includes(p.source.kind) ||
        !p.launch ||
        typeof p.launch.command !== 'string' ||
        !Array.isArray(p.launch.args) ||
        p.launch.args.some((a) => typeof a !== 'string') ||
        !Array.isArray(p.disabledTools) ||
        p.disabledTools.some((t) => typeof t !== 'string') ||
        !Array.isArray(p.credentialKeys) ||
        p.credentialKeys.some((k) => typeof k !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,100}$/.test(k))
      )
        return false;
      if (!path.resolve(p.directory).startsWith(path.resolve(this.root, p.id) + path.sep)) return false;
      this.validateConfig(p.config);
      if (p.launch.manifest) vAny.McpbManifestSchema.parse(p.launch.manifest);
      return true;
    } catch {
      return false;
    }
  }
  private async credentials(row: RecordEntry): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const key of row.credentialKeys) {
      const value = await getSecret(`plugin:${row.id}:${key}`);
      if (value) {
        result[key] = value;
        this.secretValues.add(value);
      }
    }
    return result;
  }
  private async storeCredentials(row: RecordEntry, values: Record<string, string> = {}): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,100}$/.test(key) || typeof value !== 'string' || value.length > 16384)
        throw new Error('Invalid credential field');
      await setSecret(`plugin:${row.id}:${key}`, value);
      if (value) {
        this.secretValues.add(value);
        if (!row.credentialKeys.includes(key)) row.credentialKeys.push(key);
      } else row.credentialKeys = row.credentialKeys.filter((k) => k !== key);
    }
  }
  private validateConfig(config: Record<string, string>): void {
    if (
      Object.keys(config).length > 100 ||
      Object.entries(config).some(
        ([k, v]) => !/^[a-zA-Z_][a-zA-Z0-9_-]{0,100}$/.test(k) || typeof v !== 'string' || v.length > 8192,
      )
    )
      throw new Error('Invalid plugin configuration');
    if (Object.keys(config).some((k) => /token|password|secret|api.?key|authorization/i.test(k)))
      throw new Error('Put credentials in secure credential fields, not configuration');
  }
  private installationMetadata(launch: InstalledLaunch, catalogId?: string): Pick<PluginView, 'fields' | 'homepage'> {
    if (!launch.manifest) {
      const catalog = pluginCatalog.find((p) => p.id === catalogId);
      return { fields: catalog?.fields, homepage: catalog?.homepage };
    }
    const manifest = vAny.McpbManifestSchema.parse(launch.manifest);
    return {
      homepage: manifest.homepage,
      fields: Object.entries(manifest.user_config ?? {}).map(([key, field]) => ({
        key, label: field.title, secret: field.sensitive, required: field.required, placeholder: field.description,
      })),
    };
  }
  install(request: PluginInstallRequest): Promise<PluginSnapshot> {
    return this.serial('install', async () => {
      if (this.closing) throw new Error('Plugins are shutting down');
      if (this.records.length >= 24) throw new Error('At most 24 plugins may be installed');
      const catalog = pluginCatalog.find((p) => p.id === request.catalogId);
      let source = structuredClone(request.source ?? catalog?.source);
      if (!source) throw new Error('Choose an integration or installation source');
      if (source.auth && source.kind !== 'remote') throw new Error('OAuth requires a remote source.');
      if (source.kind === 'github') source = resolveGithub(source);
      if (source.kind === 'remote') this.remoteUrl(source.url);
      this.validateConfig(request.config ?? {});
      const id = randomUUID(),
        directory = path.join(this.root, id, randomUUID());
      let row: RecordEntry | undefined;
      try {
        const launch = await installSource(source, directory);
        if (this.closing) throw new Error('Plugin installation cancelled by shutdown');
        row = {
          id,
          name: (request.name ?? catalog?.name ?? source.package ?? 'Custom MCP').slice(0, 100),
          catalogId: catalog?.id,
          source,
          config: request.config ?? {},
          credentialKeys: [],
          version: launch.version,
          license: launch.license,
          homepage: catalog?.homepage,
          enabled: true,
          status: 'installed',
          catalog: [],
          installedAt: Date.now(),
          directory,
          launch,
          disabledTools: [],
          ...this.installationMetadata(launch, catalog?.id),
        };
        if (launch.manifest) {
          const manifest = vAny.McpbManifestSchema.parse(launch.manifest);
          row.name = manifest.display_name ?? manifest.name;
        }
        if (row.fields?.some((f) => f.secret && f.key in row!.config))
          throw new Error('Store sensitive bundle fields in secure credentials');
        await this.storeCredentials(row, request.credentials);
        this.records.push(row);
        try {
          await this.save();
        } catch (e) {
          this.records = this.records.filter((p) => p !== row);
          this.exposureCache = null;
          throw e;
        }
        await this.connect(row);
        this.changed();
        return this.snapshot();
      } catch (e) {
        if (!row || !this.records.includes(row)) {
          await fs.rm(directory, { recursive: true, force: true });
          for (const key of row?.credentialKeys ?? []) await clearSecret(`plugin:${id}:${key}`);
        }
        throw new Error(String(this.redact((e as Error).message)));
      }
    });
  }
  configure(id: string, patch: PluginConfigPatch): Promise<PluginSnapshot> {
    this.authenticating.get(id)?.controller.abort();
    return this.serial(id, async () => {
      const row = this.row(id);
      this.validateConfig(patch.config ?? row.config);
      if (row.fields?.some((f) => f.secret && f.key in (patch.config ?? row.config)))
        throw new Error('Store sensitive bundle fields in secure credentials');
      const oldKeys = [...row.credentialKeys],
        oldConfig = row.config,
        oldName = row.name;
      const oldSecrets = await this.credentials(row);
      try {
        await this.storeCredentials(row, patch.credentials);
        if (patch.source) {
          await this.replace(row, patch.source, patch.config ?? row.config);
        } else {
          await this.disconnect(row);
          row.config = patch.config ?? row.config;
          if (patch.name) row.name = patch.name.slice(0, 100);
          await this.save();
          if (row.enabled) await this.connect(row);
        }
      } catch (e) {
        for (const key of new Set([...Object.keys(patch.credentials ?? {}), ...oldKeys]))
          await setSecret(`plugin:${id}:${key}`, oldSecrets[key] ?? '');
        row.credentialKeys = oldKeys;
        row.config = oldConfig;
        row.name = oldName;
        await this.disconnect(row);
        if (row.enabled) await this.connect(row);
        throw e;
      }
      this.changed();
      return this.snapshot();
    });
  }
  restart(id: string): Promise<PluginSnapshot> {
    this.authenticating.get(id)?.controller.abort();
    return this.serial(id, async () => {
      const row = this.row(id);
      await this.disconnect(row);
      if (row.enabled) await this.connect(row);
      this.changed();
      return this.snapshot();
    });
  }
  update(id: string): Promise<PluginSnapshot> {
    this.authenticating.get(id)?.controller.abort();
    return this.serial(id, async () => {
      const row = this.row(id);
      const catalog = pluginCatalog.find((p) => p.id === row.catalogId);
      await this.replace(row, catalog?.source ?? row.source, row.config);
      this.changed();
      return this.snapshot();
    });
  }
  private async replace(
    row: RecordEntry,
    source: RecordEntry['source'],
    config: Record<string, string>,
  ): Promise<void> {
    if (this.closing) throw new Error('Plugins are shutting down');
    if (source.auth && source.kind !== 'remote') throw new Error('OAuth requires a remote source.');
    if (source.kind === 'github') source = resolveGithub(source);
    if (source.kind === 'remote') this.remoteUrl(source.url);
    const directory = path.join(this.root, row.id, randomUUID());
    const old = { ...row };
    try {
      const launch = await installSource(source, directory);
      if (this.closing) throw new Error('Plugin update cancelled by shutdown');
      const catalogId = pluginCatalog.find((p) => p.id === row.catalogId && JSON.stringify(p.source) === JSON.stringify(source))?.id;
      const metadata = this.installationMetadata(launch, catalogId);
      if (metadata.fields?.some((f) => f.secret && f.key in config))
        throw new Error('Store sensitive bundle fields in secure credentials');
      await this.disconnect(row);
      Object.assign(row, { source, directory, launch, version: launch.version, license: launch.license, config, catalogId, ...metadata });
      if (row.enabled) {
        await this.connect(row);
        if (row.status !== 'ready' && row.status !== 'needs-auth') throw new Error(row.error ?? 'New server did not become ready');
      }
      await this.save();
    } catch (e) {
      await this.disconnect(row);
      // Installation rollback must not undo a newer user policy request.
      Object.assign(row, old, { enabled: row.enabled, disabledTools: row.disabledTools });
      this.exposureCache = null;
      await fs.rm(directory, { recursive: true, force: true });
      if (row.enabled) await this.connect(row);
      throw new Error(`Update rolled back: ${String(this.redact((e as Error).message))}`);
    }
    // Cleanup after the commit is best-effort: an old-directory deletion failure must never undo durable publication.
    await fs.rm(old.directory, { recursive: true, force: true }).catch(() => undefined);
  }
  setEnabled(id: string, enabled: boolean): Promise<PluginSnapshot> {
    const row = this.row(id);
    // The record is the live policy authority, including while lifecycle work is queued.
    row.enabled = enabled;
    // Revocation retires the current identity now, even while an update downloads
    // a replacement. The queued transaction awaits this same retirement promise.
    const retirement = enabled ? Promise.resolve() : this.disconnect(row);
    void retirement.catch(() => undefined);
    this.changed();
    return this.serial(id, async () => {
      await retirement;
      await this.disconnect(row);
      await this.save();
      if (row.enabled && this.records.includes(row)) await this.connect(row);
      this.changed();
      return this.snapshot();
    });
  }
  setToolEnabled(id: string, name: string, enabled: boolean): Promise<PluginSnapshot> {
    const row = this.row(id);
    if (!row.catalog.some((t) => t.name === name)) throw new Error('Tool not found');
    row.disabledTools = row.disabledTools.filter((n) => n !== name);
    if (!enabled) row.disabledTools.push(name);
    this.changed();
    return this.serial(id, async () => {
      await this.save();
      this.changed();
      return this.snapshot();
    });
  }
  uninstall(id: string): Promise<PluginSnapshot> {
    const row = this.row(id);
    row.enabled = false;
    const retirement = this.disconnect(row);
    void retirement.catch(() => undefined);
    this.records = this.records.filter((p) => p !== row);
    this.changed();
    return this.serial(id, async () => {
      await retirement;
      await this.disconnect(row);
      try {
        await this.save();
      } catch (e) {
        this.records.push(row);
        this.exposureCache = null;
        throw e;
      }
      for (const key of row.credentialKeys) await clearSecret(`plugin:${id}:${key}`);
      await clearPluginOAuth(id);
      await fs.rm(path.join(this.root, id), { recursive: true, force: true });
      this.changed();
      return this.snapshot();
    });
  }
  private async disconnect(row: RecordEntry): Promise<void> {
    this.authenticating.get(row.id)?.controller.abort();
    this.starting.get(row.id)?.controller.abort();
    const live = this.live.get(row.id);
    this.live.delete(row.id);
    row.status = !row.enabled ? 'disabled' : ['error', 'needs-auth'].includes(row.status) ? row.status : 'installed';
    // Revocation happens before process/transport retirement can yield.
    this.exposureCache = null;
    if (live) {
      live.oauth?.dispose();
      if (live.transport?.pid) await terminateProcessTree(live.transport.pid, true);
      await live.client.close().catch(() => undefined);
    }
  }
  /** Explicit UI action, returning immediately; no other lifecycle path opens a browser. */
  async authenticate(id: string): Promise<PluginSnapshot> {
    const row = this.row(id);
    if (this.closing || !row.enabled || row.source.kind !== 'remote' || row.source.auth !== 'oauth') throw new Error('Enable an OAuth remote plugin before signing in.');
    if (this.authenticating.has(id)) return this.snapshot();
    const endpoint = this.remoteUrl(row.source.url);
    const retirement = this.disconnect(row);
    const operation = { controller: new AbortController(), promise: Promise.resolve() };
    this.authenticating.set(id, operation);
    row.status = 'authenticating'; row.error = undefined; this.changed();
    operation.promise = this.serial(id, async () => {
      let provider: PluginOAuth | undefined;
      try {
        await retirement; operation.controller.signal.throwIfAborted();
        if (this.closing || !row.enabled || !this.records.includes(row)) return;
        row.status = 'authenticating'; this.changed();
        provider = await PluginOAuth.load(id, endpoint, operation.controller.signal, boundedFetch, value => this.secretValues.add(value));
        await provider.signIn(this.openAuthorization);
        operation.controller.signal.throwIfAborted();
        if (this.authenticating.get(id) !== operation || !row.enabled || this.closing) return;
        this.authenticating.delete(id);
        provider.dispose();
        await this.connect(row);
      } catch (error) {
        if (this.authenticating.get(id) === operation && row.enabled && this.records.includes(row)) {
          row.status = error instanceof PluginOAuthSetupError ? 'error' : 'needs-auth';
          row.error = operation.controller.signal.aborted ? undefined : error instanceof PluginOAuthSetupError ? error.message : 'Sign-in was not completed. Check the service setup and try Sign in again.';
        }
      } finally {
        provider?.dispose();
        if (this.authenticating.get(id) === operation) this.authenticating.delete(id);
        this.changed();
      }
    });
    void operation.promise.catch(() => undefined);
    return this.snapshot();
  }
  async cancelAuthentication(id: string): Promise<PluginSnapshot> {
    const row = this.row(id);
    this.authenticating.get(id)?.controller.abort();
    this.authenticating.delete(id);
    if (row.status === 'authenticating') { row.status = row.enabled ? 'needs-auth' : 'disabled'; row.error = undefined; this.changed(); }
    return this.snapshot();
  }
  private remoteUrl(value: string | undefined): URL {
    const url = new URL(value ?? '');
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
    )
      throw new Error(
        'Use HTTPS (or loopback HTTP), without URL credentials or query tokens; put tokens in credentials',
      );
    return url;
  }
  private async discover(client: Client): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const deadline = Date.now() + 20000;
    let pages = 0;
    do {
      if (++pages > 16 || Date.now() >= deadline) throw new Error('Server discovery exceeded its page/time limit');
      // Read one protocol page so limits apply before another page is requested.
      // SDK listTools() without a cursor aggregates every page before returning.
      const page = await client.request({ method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) }, { timeout: Math.max(1, Math.min(15000, deadline - Date.now())) });
      tools.push(...page.tools);
      if (tools.length > 256 || Buffer.byteLength(JSON.stringify(tools)) > 1000000)
        throw new Error('Server discovery exceeds 256 tools or 1 MB; configure a smaller server toolset');
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Server returned a repeated tool cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (new Set(tools.map((t) => t.name)).size !== tools.length)
      throw new Error('Server declares duplicate tool names');
    if (!tools.length) throw new Error('Server connected but discovered no tools');
    return tools;
  }
  private publishTools(row: RecordEntry, tools: Tool[]): void {
    row.catalog = tools;
    row.status = 'ready';
    this.exposureCache = null;
  }
  private release(row: RecordEntry, live: Live): void {
    live.users--;
    if (this.live.get(row.id) !== live || live.users !== 0) return;
    if (row.status === 'error' || row.status === 'needs-auth') {
      void this.serial(row.id, async () => {
        if (this.live.get(row.id) === live && live.users === 0) await this.disconnect(row);
      });
      return;
    }
  }
  private connect(row: RecordEntry): Promise<void> {
    const pending = this.starting.get(row.id);
    if (pending && !pending.controller.signal.aborted) return pending.promise;
    const controller = new AbortController();
    const cancelled = new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
    const operation = { controller, promise: Promise.resolve() };
    operation.promise = Promise.race([this.startConnection(row, controller.signal), cancelled]).finally(() => {
      if (this.starting.get(row.id) === operation) this.starting.delete(row.id);
    });
    this.starting.set(row.id, operation);
    return operation.promise;
  }
  private async startConnection(row: RecordEntry, signal: AbortSignal): Promise<void> {
    if (this.closing || !row.enabled) return;
    row.status = 'connecting';
    row.error = undefined;
    this.changed();
    const client = new Client({ name: 'Chat On Steroids Plugins', version: '1.0.0' });
    let transport: StdioClientTransport | undefined;
    let oauth: PluginOAuth | undefined;
    const retire = () => {
      void (async () => {
        if (transport?.pid) await terminateProcessTree(transport.pid, true);
        await client.close().catch(() => undefined);
      })().catch(() => undefined);
    };
    signal.addEventListener('abort', retire, { once: true });
    this.connecting.set(client, undefined);
    try {
      const secrets = await this.credentials(row);
      signal.throwIfAborted();
      if (this.closing || !row.enabled || !this.records.includes(row)) return;
      if (row.source.kind === 'remote') {
        const url = this.remoteUrl(row.source.url);
        if (row.source.auth === 'oauth') {
          if (row.credentialKeys.length) throw new Error('OAuth plugins use Sign in instead of static credential headers.');
          oauth = await PluginOAuth.load(row.id, url, signal, boundedFetch, value => this.secretValues.add(value));
          if (!oauth.tokens()) throw new PluginNeedsAuth();
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(secrets))
          headers[k === 'token' ? 'Authorization' : k] = k === 'token' ? `Bearer ${v}` : v;
        await client.connect(
          new StreamableHTTPClientTransport(url, {
            fetch: oauth?.fetch ?? boundedFetch,
            ...(oauth ? { authProvider: oauth } : {}),
            requestInit: { headers },
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          }),
          { timeout: 20000 },
        );
      } else {
        let launch = { command: row.launch.command, args: row.launch.args, env: {} as Record<string, string> };
        if (row.launch.manifest) {
          const manifest = vAny.McpbManifestSchema.parse(row.launch.manifest);
          const missing = Object.entries(manifest.user_config ?? {})
            .filter(
              ([key, field]) => field.required && !(row.config[key] ?? secrets[key]) && field.default === undefined,
            )
            .map(([key]) => key);
          if (missing.length) throw new Error(`Configure required bundle fields: ${missing.join(', ')}`);
          const cfg = await getMcpConfigForManifest({
            manifest,
            extensionPath: row.directory,
            systemDirs: {},
            userConfig: { ...row.config, ...secrets },
            pathSeparator: path.sep,
            logger: { log: () => {}, warn: () => {}, error: () => {} },
          });
          if (!cfg?.command) throw new Error('MCPB requires unsupported configuration/runtime setup');
          launch = { command: cfg.command, args: cfg.args ?? [], env: cfg.env ?? {} };
          if (JSON.stringify(launch).includes('${'))
            throw new Error('MCPB configuration is incomplete; provide its required fields');
          // MCPB recipes also permit ordinary relative entry points. Resolve packaged assets
          // against the bundle before switching cwd to the stable per-plugin data directory.
          const packagedPath = async (value: string): Promise<string> => {
            if (path.isAbsolute(value) || value.startsWith('-')) return value;
            const candidate = path.resolve(row.directory, value);
            if (!candidate.startsWith(path.resolve(row.directory) + path.sep)) return value;
            try {
              await fs.access(candidate);
              return candidate;
            } catch {
              return value;
            }
          };
          launch.args = await Promise.all(launch.args.map(packagedPath));
          if (manifest.server.type === 'binary') launch.command = await packagedPath(launch.command);
        }
        const env = pluginEnvironment();
        // Use the upstream response policy, not markdown surgery after execution. Apply at
        // launch so existing official installations also stop echoing submitted/generated code.
        // Explicit user configuration/CLI options retain their normal precedence.
        if (row.source.kind === 'npm' && row.source.package === '@playwright/mcp')
          setEnvValue(env, 'PLAYWRIGHT_MCP_CODEGEN', 'none');
        for (const [k, v] of Object.entries({ ...row.config, ...secrets, ...launch.env })) setEnvValue(env, k, v);
        const data = path.join(this.root, row.id, 'data');
        await fs.mkdir(data, { recursive: true });
        if (row.catalogId === 'memory') setEnvValue(env, 'MEMORY_FILE_PATH', path.join(data, 'memory.json'));
        // A generation directory contains immutable installed code. Servers write relative user data
        // into a stable cwd so replacing the installation cannot erase that data.
        signal.throwIfAborted();
        if (this.closing || !row.enabled || !this.records.includes(row)) return;
        transport = new StdioClientTransport({
          command: launch.command,
          args: launch.args,
          cwd: data,
          env,
          stderr: 'ignore',
          maxBufferSize: 16 * 1024 * 1024,
        });
        this.connecting.set(client, transport);
        await client.connect(transport, { timeout: 20000 });
      }
      const tools = await this.discover(client);
      signal.throwIfAborted();
      if (row.catalogId === 'blender') {
        const probe = tools.find((t) => t.name === 'get_scene_info');
        if (!probe) throw new Error('Blender scene probe is unavailable');
        // The pinned Blender server requires user_prompt even for a read-only scene
        // probe. Empty arguments fail schema validation before contacting the addon.
        const result = await client.callTool({ name: probe.name, arguments: {
          user_prompt: 'Read-only connection check: inspect the current Blender scene without changing it.',
        } }, { timeout: 15000, toolDefinition: probe });
        if (result.isError || result.content.some((block) => block.type === 'text' &&
          /^(?:error\b|could not connect\b|connection refused\b)/i.test(block.text.trim())))
          throw new Error('Open Blender, enable its MCP addon, and click Start MCP Server in Blender. Then restart this plugin.');
      }
      if (signal.aborted || this.closing || !row.enabled) {
        if (transport?.pid) await terminateProcessTree(transport.pid, true);
        await client.close();
        return;
      }
      const live: Live = { client, tools, transport, users: 0, oauth };
      this.live.set(row.id, live);
      client.setNotificationHandler('notifications/tools/list_changed', () => {
        // A current connection can invalidate its own listing, never resurrect a retired one.
        if (this.live.get(row.id) !== live || row.status === 'connecting') return;
        row.status = 'connecting';
        this.changed();
        void this.serial(row.id, async () => {
          if (this.live.get(row.id) !== live || !row.enabled) return;
          try {
            const refreshed = await this.discover(client);
            if (this.live.get(row.id) !== live) return;
            live.tools = refreshed;
            this.publishTools(row, refreshed);
            await this.save();
          } catch {
            if (this.live.get(row.id) !== live) return;
            if (live.users === 0) await this.disconnect(row);
            row.status = 'error';
            row.error = 'Tool discovery changed and could not be refreshed. Restart this plugin.';
          }
          this.changed();
        });
      });
      client.onclose = () => {
        oauth?.dispose();
        if (this.live.get(row.id) === live) {
          this.live.delete(row.id);
          row.status = 'error';
          row.error = 'Server disconnected. Restart it after checking its application and credentials.';
          this.changed();
        }
      };
      client.onerror = () => {
        /* Transport errors are deliberately not logged: they may contain headers or credentials. */
      };
      this.publishTools(row, tools);
      await this.save();
    } catch (e) {
      oauth?.dispose();
      if (this.live.get(row.id)?.client === client) this.live.delete(row.id);
      this.exposureCache = null;
      if (transport?.pid) await terminateProcessTree(transport.pid, true);
      await client.close().catch(() => undefined);
      if (!signal.aborted) {
        const needsAuth = e instanceof PluginNeedsAuth || e instanceof UnauthorizedError;
        row.status = needsAuth ? 'needs-auth' : 'error';
        row.error = row.source.auth === 'oauth' ? needsAuth ? 'Sign in to connect this plugin.' : 'The OAuth server could not connect. Check its setup and try again.' : String(this.redact((e as Error).message)).slice(0, 600);
      }
    } finally {
      signal.removeEventListener('abort', retire);
      this.connecting.delete(client);
    }
    this.changed();
  }
  tools(): Tool[] { return [...this.exposure().tools]; }
  async call(name: string, args: Record<string, unknown> = {},
    onOutcome?: (outcome: 'tool_rejected' | 'tool_execution_error') => void): Promise<CallToolResult> {
    // The invocation owner knows whether a tool failed or was never admitted.
    // Keep this internal evidence out of the upstream MCP result/content contract.
    const errorResult = (text: string, outcome: 'tool_rejected' | 'tool_execution_error' = 'tool_execution_error'): CallToolResult => {
      onOutcome?.(outcome);
      return this.redactResult({ isError: true, content: [{ type: 'text', text }] });
    };
    let startupFailed = false;
    let acquired: { row: RecordEntry; live: Live; tool: Tool } | undefined;
    try {
      acquired = await this.serial(this.exposure().owners.get(name) ?? name, async () => {
        if (this.closing) return;
        const owner = this.exposure().owners.get(name);
        const row = this.records.find(row => row.id === owner && row.enabled);
        if (!row) return;
        let live = this.live.get(row.id);
        if (!live) { await this.connect(row); live = this.live.get(row.id); startupFailed = !live && row.enabled && row.status === 'error'; }
        // Discovery/configuration may have changed the exact declaration during startup.
        if (!live || !row.enabled || this.closing || this.exposure().owners.get(name) !== row.id) {
          if (live && live.users === 0) await this.disconnect(row);
          return;
        }
        const tool = live.tools.find(tool => tool.name === name);
        if (!tool) { if (live.users === 0) await this.disconnect(row); return; }
        live.users++;
        return { row, live, tool };
      });
    } catch { return errorResult('PLUGIN_START_FAILED: The plugin server could not start. Check its settings and application.'); }
    if (!acquired) return startupFailed
      ? errorResult('PLUGIN_START_FAILED: The plugin server could not start. Check its settings and application.')
      : errorResult('PLUGIN_DISABLED: This plugin tool is unavailable, conflicted or disabled. Refresh the Plugins connector.', 'tool_rejected');
    const { row, live, tool } = acquired;
    try {
      // Supply our bounded discovery result: SDK validates output against it without
      // rediscovery or the modern header-mismatch retry path for ambiguous mutations.
      const result = await live.client.callTool({ name: tool.name, arguments: args }, { timeout: 120000, toolDefinition: tool });
      if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024)
        return errorResult('PLUGIN_RESULT_TOO_LARGE: Result exceeds 16 MiB. Request a smaller result.');
      for (const block of result.content)
        if (block.type === 'image') {
          const data = Buffer.from(block.data, 'base64');
          const info = await sharp(data, { limitInputPixels: 36000000 }).metadata();
          if (!info.width || !info.height || info.width * info.height > 36000000)
            return errorResult('PLUGIN_IMAGE_TOO_LARGE: Image exceeds the decoded-pixel limit.');
          if (block.mimeType !== `image/${info.format === 'svg' ? 'svg+xml' : info.format}`)
            return errorResult('PLUGIN_IMAGE_INVALID: Image MIME type does not match its decoded content.');
        }
      if (result.isError) onOutcome?.('tool_execution_error');
      return this.redactResult(result);
    } catch (error) {
      // A failed/ambiguous call must not leave a broken process running idle.
      if (this.live.get(row.id) === live && this.records.includes(row)) {
        const needsAuth = error instanceof PluginNeedsAuth || error instanceof UnauthorizedError;
        row.status = row.enabled ? needsAuth ? 'needs-auth' : 'error' : 'disabled';
        row.error = needsAuth ? 'Sign in again to reconnect this plugin.' : 'Server call failed or disconnected. Restart after checking its application.';
        this.changed();
      }
      return errorResult(
        'PLUGIN_CALL_FAILED: The server failed or disconnected. The operation may have completed; inspect its state before retrying. CoS did not retry.',
      );
    } finally { this.release(row, live); }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const operation of this.starting.values()) operation.controller.abort();
    await Promise.all(this.records.map(row => this.disconnect(row)));
    await stopInstallers();
    await Promise.all(
      [...this.connecting].map(async ([client, transport]) => {
        if (transport?.pid) await terminateProcessTree(transport.pid, true);
        await client.close().catch(() => undefined);
      }),
    );
    await Promise.all(this.queues.values());
    await Promise.all(this.records.map((row) => this.disconnect(row)));
    this.changed();
  }
}
export const pluginManager = new PluginManager();
