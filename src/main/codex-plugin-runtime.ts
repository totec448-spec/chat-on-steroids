import { accessSync, constants, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathEntries, setEnvValue } from './env.js';
import { childEnv } from './exec.js';
import type { CodexPluginRuntimeEntry, CodexPluginSource } from '../shared/skills.js';

const MAX_RUNTIME_OUTPUT_BYTES = 2 * 1024 * 1024;
const RUNTIME_TIMEOUT_MS = 15_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_VERSION = /^[A-Za-z0-9._+-]+$/;

function plain(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Codex plugin runtime returned an invalid ${label}`);
  }
  return value;
}

function optionalPlain(value: unknown, label: string, max = 4096): string | undefined {
  if (value === undefined || value === null) return undefined;
  return plain(value, label, max);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function source(value: unknown): CodexPluginSource {
  const row = object(value);
  const kind = row && plain(row.source, 'source kind', 40);
  if (!row || !kind) throw new Error('Codex plugin runtime returned an invalid source');
  if (kind === 'remote') return { source: kind, id: plain(row.id, 'remote source id') };
  if (kind === 'local') return { source: kind };
  if (kind === 'git') return {
    source: kind,
    url: plain(row.url, 'Git source URL'),
    ...optionalField('ref', optionalPlain(row.ref, 'Git source ref')),
    ...optionalField('sha', optionalPlain(row.sha, 'Git source SHA', 160))
  };
  if (kind === 'git-subdir') return {
    source: kind,
    url: plain(row.url, 'Git source URL'),
    path: plain(row.path, 'Git source path'),
    ...optionalField('ref', optionalPlain(row.ref, 'Git source ref')),
    ...optionalField('sha', optionalPlain(row.sha, 'Git source SHA', 160))
  };
  if (kind === 'npm') return {
    source: kind,
    package: plain(row.package, 'npm package', 512),
    ...optionalField('version', optionalPlain(row.version, 'npm source version', 160)),
    ...optionalField('registry', optionalPlain(row.registry, 'npm registry'))
  };
  throw new Error(`Codex plugin runtime returned unsupported source kind ${JSON.stringify(kind)}`);
}

function optionalField<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: string };
}

export function parseCodexPluginList(text: string): CodexPluginRuntimeEntry[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_RUNTIME_OUTPUT_BYTES) throw new Error('Codex plugin runtime output exceeded 2 MiB');
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('Codex plugin runtime returned invalid JSON'); }
  const root = object(parsed);
  const installed = root?.installed;
  if (!Array.isArray(installed) || installed.length > 256) throw new Error('Codex plugin runtime returned an invalid installed plugin list');
  const result: CodexPluginRuntimeEntry[] = [];
  for (const value of installed) {
    const row = object(value);
    if (!row) throw new Error('Codex plugin runtime returned an invalid installed plugin');
    const pluginId = plain(row.pluginId, 'plugin id', 300);
    const pluginName = plain(row.name, 'plugin name', 128);
    const marketplaceName = plain(row.marketplaceName, 'marketplace name', 128);
    const version = plain(row.version, 'installed version', 160);
    if (!SAFE_SEGMENT.test(pluginName) || !SAFE_SEGMENT.test(marketplaceName) || pluginId !== `${pluginName}@${marketplaceName}`) {
      throw new Error(`Codex plugin runtime returned inconsistent plugin identity ${JSON.stringify(pluginId)}`);
    }
    if (!SAFE_VERSION.test(version) || version === '.' || version === '..') throw new Error(`Codex plugin ${pluginId} returned an unsafe installed version`);
    if (row.installed !== true || typeof row.enabled !== 'boolean') throw new Error(`Codex plugin ${pluginId} returned invalid installed/enabled state`);
    const marketplaceSource = object(row.marketplaceSource);
    const marketplaceSourceType = marketplaceSource ? plain(marketplaceSource.sourceType, 'marketplace source type', 80) : null;
    const marketplaceSourceValue = marketplaceSourceType && marketplaceSourceType !== 'local'
      ? optionalPlain(marketplaceSource?.source, 'marketplace source')
      : undefined;
    result.push({
      pluginId, pluginName, marketplaceName, version, installed: true, enabled: row.enabled,
      source: source(row.source),
      ...(marketplaceSourceType ? {
        marketplaceSource: {
          sourceType: marketplaceSourceType,
          ...(marketplaceSourceValue ? { source: marketplaceSourceValue } : {})
        }
      } : {})
    });
  }
  return result;
}

type RuntimeCommand = { file: string; prefix: string[]; runAsNode?: true };

function executableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch { return false; }
}

/** Resolve only absolute inherited PATH entries so a project-local `codex` cannot become runtime authority. */
export function locateCodexRuntime(): RuntimeCommand | null {
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.com'] : ['codex'];
  for (const directory of pathEntries()) {
    if (!path.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (executableFile(candidate)) return { file: candidate, prefix: [] };
    }
    if (process.platform === 'win32' && executableFile(path.join(directory, 'codex.cmd'))) {
      // npm's Windows shim is a batch file. Execute the package's JS entry directly through the
      // already-running executable in Node mode so a packaged Electron app cannot relaunch its
      // main entrypoint and cmd.exe expansion never participates in path handling.
      const script = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (executableFile(script)) return { file: process.execPath, prefix: [script], runAsNode: true };
    }
  }
  return null;
}

export async function listInstalledCodexPlugins(codexHome: string, cwd: string): Promise<CodexPluginRuntimeEntry[]> {
  const command = locateCodexRuntime();
  if (!command) throw new Error('Codex CLI was not found on the inherited PATH');
  // Whatever `codex` comes first on PATH runs here, so it gets the same environment as any child
  // process: without the connector, tunnel and control-plane secrets (see exec.ts SECRET_ENV_KEYS).
  const environment: Record<string, string | undefined> = { ...childEnv() };
  setEnvValue(environment, 'CODEX_HOME', codexHome);
  if (command.runAsNode) setEnvValue(environment, 'ELECTRON_RUN_AS_NODE', '1');
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.prefix, 'plugin', 'list', '--json'], {
      cwd, env: environment as NodeJS.ProcessEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0, settled = false;
    const finish = (error?: Error, code = -1): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { reject(error); return; }
      if (code !== 0) { reject(new Error(`Codex plugin runtime failed with exit code ${code}`)); return; }
      try { resolve(parseCodexPluginList(Buffer.concat(stdout).toString('utf8'))); }
      catch (parseError) { reject(parseError); }
    };
    const timer = setTimeout(() => {
      child.kill(); finish(new Error('Codex plugin runtime did not respond within 15 seconds'));
    }, RUNTIME_TIMEOUT_MS);
    child.once('error', () => finish(new Error('Codex plugin runtime could not start')));
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RUNTIME_OUTPUT_BYTES) { child.kill(); finish(new Error('Codex plugin runtime returned too much data')); return; }
      stdout.push(chunk);
    });
    // Drain diagnostics so a noisy CLI cannot block on a full pipe; never publish inherited paths
    // or authentication detail from stderr into the Skills catalog/error surface.
    child.stderr.resume();
    child.once('close', code => finish(undefined, code ?? -1));
  });
}
