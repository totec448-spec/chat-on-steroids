import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { unzipSync } from 'fflate';
import { vAny } from '@anthropic-ai/mcpb/browser';
import type { PluginSource } from '../../shared/plugins.js';
import { pluginCatalog, reviewedPluginLicense } from './catalog.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { terminateProcessTree } from '../exec.js';
import { envValue, pathEntries, setEnvValue } from '../env.js';

/** One minimal environment for runtime discovery, installation and plugin startup. */
export function pluginEnvironment(inherited = getDefaultEnvironment(), platform = process.platform): Record<string, string> {
  const env = { ...inherited };
  if (platform === 'win32') {
    // uv's standalone installer uses this per-user directory. An already-running
    // desktop app has the old PATH, so use the same runtime environment for discovery,
    // installation and startup instead of requiring a restart after installing uv.
    const home = envValue(env, 'USERPROFILE');
    if (home && path.win32.isAbsolute(home)) {
      const directories = (envValue(env, 'PATH') ?? '').split(';').filter(Boolean);
      const userBin = path.win32.join(home, '.local', 'bin');
      if (!directories.some(directory => directory.toLowerCase() === userBin.toLowerCase())) directories.push(userBin);
      setEnvValue(env, 'PATH', directories.join(';'));
    }
    return env;
  }
  // Desktop launchers do not inherit interactive shell setup. Keep the inherited path
  // first, then the standard Node/Homebrew and uv user-install locations. Never execute
  // shell startup files or copy the application's wider secret-bearing environment.
  const directories = (envValue(env, 'PATH') ?? '').split(':').filter(Boolean);
  if (platform === 'darwin') directories.push('/opt/homebrew/bin');
  directories.push('/usr/local/bin');
  const home = envValue(env, 'HOME');
  if (home) directories.push(path.posix.join(home, '.local', 'bin'));
  setEnvValue(env, 'PATH', [...new Set(directories)].join(':'));
  return env;
}

export interface InstalledLaunch {
  command: string;
  args: string[];
  version: string;
  license: string;
  manifest?: unknown;
}
export const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;

/** Validate central-directory metadata before decompression, then extract into a new private directory only. */
export async function extractBundle(input: string, directory: string): Promise<unknown> {
  if ((await fs.stat(input)).size > MAX_BUNDLE_BYTES) throw new Error('MCPB exceeds the 128 MiB archive limit');
  const zip = await fs.readFile(input);
  let total = 0,
    entries = 0;
  const seen = new Map<string, { name: string; size: number; mode: number }>();
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--)
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) {
      end = i;
      break;
    }
  if (
    end < 0 ||
    zip.readUInt16LE(end + 4) ||
    zip.readUInt16LE(end + 6) ||
    zip.readUInt16LE(end + 8) !== zip.readUInt16LE(end + 10)
  )
    throw new Error('Invalid or multipart MCPB archive');
  const count = zip.readUInt16LE(end + 10),
    centralSize = zip.readUInt32LE(end + 12),
    centralOffset = zip.readUInt32LE(end + 16);
  if (count === 65535 || centralOffset + centralSize !== end)
    throw new Error('ZIP64 and malformed MCPB archives are unsupported');
  let i = centralOffset;
  for (let index = 0; index < count; index++) {
    if (i + 46 > end || zip.readUInt32LE(i) !== 0x02014b50) throw new Error('Invalid MCPB central directory');
    const size = zip.readUInt32LE(i + 24),
      length = zip.readUInt16LE(i + 28);
    const name = zip.subarray(i + 46, i + 46 + length).toString('utf8');
    const mode = zip.readUInt32LE(i + 38) >>> 16;
    if (
      (mode & 0xf000) === 0xa000 ||
      /(^[\\/]|[\\:]|(^|\/)\.\.?($|\/))/.test(name) ||
      name.includes('\0') ||
      name.split('/').some((p) => /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))
    )
      throw new Error('MCPB contains an unsafe archive path or symbolic link');
    const key = name.toLowerCase();
    if (seen.has(key) || zip.readUInt16LE(i + 8) & 1)
      throw new Error('MCPB contains duplicate paths or encrypted files');
    seen.set(key, { name, size, mode });
    total += size;
    entries++;
    if (total > MAX_BUNDLE_BYTES || entries > 10000 || size === 0xffffffff)
      throw new Error('MCPB extraction limit exceeded');
    i += 46 + length + zip.readUInt16LE(i + 30) + zip.readUInt16LE(i + 32);
  }
  if (!entries || i !== end) throw new Error('MCPB is not a supported ZIP archive');
  for (const { name } of seen.values()) {
    const parts = name.replace(/\/$/, '').split('/');
    for (let n = 1; n < parts.length; n++)
      if (seen.has(parts.slice(0, n).join('/').toLowerCase())) throw new Error('MCPB file/directory path collision');
  }
  const files = unzipSync(zip, {
    filter: (file) => {
      const entry = seen.get(file.name.toLowerCase());
      if (!entry || entry.name !== file.name || entry.size !== file.originalSize) throw new Error('Invalid MCPB entry');
      return true;
    },
  });
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes || manifestBytes.length > 256000) throw new Error('MCPB needs a bounded root manifest.json');
  const manifest = vAny.McpbManifestSchema.parse(JSON.parse(Buffer.from(manifestBytes).toString('utf8')));
  await fs.mkdir(directory, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    const target = path.resolve(directory, name);
    if (!target.startsWith(path.resolve(directory) + path.sep)) throw new Error('Unsafe bundle path');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx', mode: seen.get(name.toLowerCase())!.mode & 0o111 ? 0o700 : 0o600 });
  }
  return manifest;
}

/** No shell expansion, lifecycle scripts or captured output: installers cannot leak credentials into app logs. */
const installing = new Set<number>();
export async function stopInstallers(): Promise<void> {
  await Promise.all([...installing].map((pid) => terminateProcessTree(pid, true)));
}
export async function runInstaller(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: pluginEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    if (child.pid) installing.add(child.pid);
    const timer = setTimeout(() => {
      if (child.pid) void terminateProcessTree(child.pid, true);
      reject(new Error('Installation timed out after three minutes'));
    }, 180000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error(`Required runtime ${path.basename(command)} is unavailable; install it and restart CoS`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (child.pid) installing.delete(child.pid);
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Installation failed (exit ${code ?? 'terminated'}). Check the package, version and network connection.`,
            ),
          );
    });
  });
}

export function resolveGithub(source: PluginSource): PluginSource {
  const url = new URL(source.url ?? '');
  if (url.hostname !== 'github.com' || url.username || url.password) throw new Error('Use a github.com repository URL');
  const normalized = url.href.replace(/\/$/, '').replace(/\.git$/, '');
  const recipe = pluginCatalog.find((p) => p.homepage.replace(/\/$/, '') === normalized);
  if (!recipe)
    throw new Error(
      'This GitHub repository has no reviewed recipe. Import its MCPB release or supply the executable/package and arguments from its MCP instructions.',
    );
  return { ...recipe.source };
}

export async function installSource(source: PluginSource, dir: string): Promise<InstalledLaunch> {
  // Pins belong to the recipe's single package-resolution transaction, never a
  // repair step that mutates a published installation after dependency resolution.
  const dependencies: string[] = [];
  if (source.dependencies !== undefined) {
    if (source.kind !== 'python' || !Array.isArray(source.dependencies) || source.dependencies.length > 16)
      throw new Error('Dependency pins require a Python source and at most 16 packages');
    const names = new Set([source.package?.toLowerCase().replace(/[-_.]+/g, '-')]);
    for (const dependency of source.dependencies) {
      if (!dependency || typeof dependency.package !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(dependency.package) ||
          typeof dependency.version !== 'string' || !/^\d+(\.\d+)+([a-z0-9.+_-]*)$/i.test(dependency.version))
        throw new Error('Dependency pins need package names and exact versions (no URLs or version ranges)');
      const name = dependency.package.toLowerCase().replace(/[-_.]+/g, '-');
      if (names.has(name)) throw new Error('Dependency pins must not repeat or replace the server package');
      names.add(name);
      dependencies.push(`${dependency.package}==${dependency.version}`);
    }
  }
  await fs.mkdir(dir, { recursive: true });
  if (source.kind === 'remote') return { command: '', args: [], version: 'remote', license: 'See server terms' };
  if (source.kind === 'command') {
    if (!source.command?.trim()) throw new Error('An executable is required');
    return {
      command: source.command,
      args: source.args ?? [],
      version: source.version ?? 'custom',
      license: 'User supplied',
    };
  }
  if (source.kind === 'mcpb') {
    if (!source.path) throw new Error('Choose an MCPB file');
    const manifest = (await extractBundle(source.path, dir)) as { version: string; license?: string };
    return { command: '', args: [], version: manifest.version, license: manifest.license ?? 'Not declared', manifest };
  }
  if (
    !source.package ||
    !/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(source.package) ||
    !source.version ||
    !/^\d+(\.\d+)+([a-z0-9.+_-]*)$/i.test(source.version)
  )
    throw new Error('Specify a package name and an explicit version (no URLs or version ranges)');
  if (source.kind === 'npm') {
    // Use npm's JS entry point on Windows: .cmd files need a shell and untrusted shell interpolation is not acceptable.
    const node = await findExecutable('node');
    const args = [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      `${source.package}@${source.version}`,
    ];
    if (process.platform === 'win32') {
      const npm = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      try {
        await fs.access(npm);
      } catch {
        throw new Error('Install the standard Node.js distribution including npm, then restart CoS');
      }
      await runInstaller(node, [npm, ...args], dir);
    } else await runInstaller('npm', args, dir);
    const pkg = JSON.parse(
      await fs.readFile(path.join(dir, 'node_modules', source.package, 'package.json'), 'utf8'),
    ) as { version: string; license?: string; bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0];
    if (!bin) throw new Error('The npm package does not declare an executable');
    const entry = path.resolve(dir, 'node_modules', source.package, bin);
    if (!entry.startsWith(path.resolve(dir) + path.sep)) throw new Error('Invalid npm executable path');
    return {
      command: node,
      args: [entry, ...(source.args ?? [])],
      version: pkg.version,
      license: reviewedPluginLicense({ ...source, version: pkg.version }, pkg.license ?? 'Not declared'),
    };
  }
  if (source.kind === 'python') {
    if (source.command && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(source.command))
      throw new Error('Python recipes need an executable name; use Custom executable for a full command path');
    await runInstaller('uv', ['venv', path.join(dir, 'venv')], dir);
    const scripts = path.join(dir, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    await runInstaller(
      'uv',
      [
        'pip',
        'install',
        '--python',
        path.join(scripts, process.platform === 'win32' ? 'python.exe' : 'python'),
        `${source.package}==${source.version}`,
        ...dependencies,
      ],
      dir,
    );
    return {
      command: path.join(scripts, (source.command ?? source.package) + (process.platform === 'win32' ? '.exe' : '')),
      args: source.args ?? [],
      version: source.version,
      license: reviewedPluginLicense(source, 'See installed dist-info licenses'),
    };
  }
  throw new Error('Unsupported installation source');
}

async function findExecutable(name: string): Promise<string> {
  for (const dir of pathEntries(pluginEnvironment())) {
    const full = path.join(dir, name + (process.platform === 'win32' ? '.exe' : ''));
    try {
      await fs.access(full);
      return full;
    } catch {
      /* next PATH entry */
    }
  }
  throw new Error(`Install ${name} and restart CoS`);
}
