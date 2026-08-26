/**
 * One environment for every child process this app starts.
 *
 * Windows treats environment variable names case-insensitively; JavaScript objects do not.
 * `{ ...process.env }` therefore turns a perfectly ordinary inherited environment into a
 * trap: the real Windows spelling is `Path`, so `copy.PATH` reads as absent, and writing
 * `copy.PATH = …` adds a *second* key rather than editing the first. The object then holds
 * `Path=<the user's whole path>` and `PATH=<whatever we just wrote>`, CreateProcess folds
 * the two spellings back into one name, and the child inherits whichever one wins.
 *
 * That is not hypothetical. The installed build prefixed the bundled ripgrep directory onto
 * `env.PATH`, and the process it spawned came up with a `Path` of exactly
 * `…\Chat On Steroids\resources\rg;` — no System32, no Git, no Node. Every
 * `spawn powershell.exe ENOENT`, every `'npm' is not recognized`, every failed `where.exe`
 * in the recorded sessions traces back to those four characters. The machine's own registry
 * path was healthy throughout; the damage was done in this process.
 *
 * So no caller outside this file may index an environment by name. Read through
 * `envValue`, write through `setEnvValue`, and build children from `normalizeEnvironment`,
 * all of which match names the way the operating system does.
 */

/** The separator between path entries: `;` on Windows, `:` everywhere else. */
export const PATH_SEPARATOR = process.platform === 'win32' ? ';' : ':';
const CASE_INSENSITIVE_ENVIRONMENT = process.platform === 'win32';

export type MutableEnvironment = Record<string, string | undefined>;

/** The spelling this environment actually uses for `name`, respecting OS name semantics. */
export function envKey(env: MutableEnvironment, name: string): string | null {
  if (!CASE_INSENSITIVE_ENVIRONMENT) {
    return Object.prototype.hasOwnProperty.call(env, name) ? name : null;
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return key;
  }
  return null;
}

export function envValue(env: MutableEnvironment, name: string): string | undefined {
  const key = envKey(env, name);
  return key === null ? undefined : env[key];
}

/**
 * Sets a variable under whatever spelling the environment already uses for it on Windows.
 * POSIX names are case-sensitive, so only the exact requested key is updated there.
 *
 * Every other spelling is removed, so the result can never contain two keys that Windows
 * would consider the same variable.
 */
export function setEnvValue(env: MutableEnvironment, name: string, value: string): void {
  if (!CASE_INSENSITIVE_ENVIRONMENT) {
    env[name] = value;
    return;
  }
  const wanted = name.toLowerCase();
  let target: string | null = null;
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== wanted) continue;
    if (target === null) target = key;
    else delete env[key];
  }
  env[target ?? name] = value;
}

export function deleteEnvValue(env: MutableEnvironment, name: string): void {
  if (!CASE_INSENSITIVE_ENVIRONMENT) {
    delete env[name];
    return;
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) delete env[key];
  }
}

/**
 * A plain object copy of an environment using the host OS's variable-name semantics.
 *
 * A real Windows environment block cannot contain two spellings of one name, but an object
 * assembled in JavaScript can, and this is the last point at which that is still cheap to
 * repair. The first spelling seen keeps the name; a later duplicate only supplies the value
 * if the first one had nothing to say. POSIX keeps differently-cased names distinct.
 */
export function normalizeEnvironment(source: NodeJS.ProcessEnv = process.env): MutableEnvironment {
  if (!CASE_INSENSITIVE_ENVIRONMENT) {
    const env: MutableEnvironment = {};
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) env[key] = value;
    }
    return env;
  }
  const env: MutableEnvironment = {};
  const byLower = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const held = byLower.get(key.toLowerCase());
    if (held === undefined) {
      byLower.set(key.toLowerCase(), key);
      env[key] = value;
      continue;
    }
    if (!env[held]) env[held] = value;
  }
  return env;
}

/** The path entries of an environment, in order, unquoted and without blanks. */
export function pathEntries(env: MutableEnvironment = process.env): string[] {
  return (envValue(env, 'PATH') ?? '')
    .split(PATH_SEPARATOR)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/**
 * Puts a directory at the front of the search path, once.
 *
 * Idempotent, because the same directory arriving twice is how a path grows without bound
 * across a long-lived process that prepares many commands.
 */
export function prependPath(env: MutableEnvironment, dir: string): void {
  const held = pathEntries(env);
  const samePathEntry = CASE_INSENSITIVE_ENVIRONMENT
    ? (entry: string): boolean => entry.toLowerCase() === dir.toLowerCase()
    : (entry: string): boolean => entry === dir;
  const already = held.some(samePathEntry);
  const kept = already ? held.filter((entry) => !samePathEntry(entry)) : held;
  setEnvValue(env, 'PATH', [dir, ...kept].join(PATH_SEPARATOR));
}

/**
 * Applies caller-supplied variables, matching names the way the OS does.
 *
 * An override spelled `PATH` must replace an inherited `Path` rather than sit beside it —
 * the same collision as above, arriving from the other direction.
 */
export function applyEnvOverrides(env: MutableEnvironment, overrides: Record<string, string>): void {
  for (const [key, value] of Object.entries(overrides)) setEnvValue(env, key, value);
}

/**
 * The directories Windows can always be expected to have, for an environment that arrived
 * with no usable path at all.
 *
 * A last resort rather than a policy: a healthy inherited path is always authoritative and
 * is never rewritten. This exists so that a child started from a broken parent can still
 * find `powershell.exe` and report what went wrong, instead of failing with ENOENT on the
 * very tools that would explain it.
 */
export function ensureUsablePath(env: MutableEnvironment): void {
  if (process.platform !== 'win32') return;
  const root = envValue(env, 'SystemRoot') || envValue(env, 'windir') || 'C:\\Windows';
  const system32 = `${root}\\System32`;
  // Each one checked on its own. An earlier version returned as soon as *any* entry ended
  // in `System32`, which reads as "the path is fine" and is not the same statement:
  // Windows PowerShell lives in `System32\WindowsPowerShell\v1.0`, so a path carrying
  // System32 but not that subdirectory passed the test and then failed to start
  // powershell.exe — the exact failure this function exists to prevent.
  const defaults = [system32, root, `${system32}\\Wbem`, `${system32}\\WindowsPowerShell\\v1.0`];
  const held = pathEntries(env);
  const missing = defaults.filter(
    (dir) => !held.some((entry) => entry.toLowerCase() === dir.toLowerCase())
  );
  if (missing.length === 0) return;
  setEnvValue(env, 'PATH', [...held, ...missing].join(PATH_SEPARATOR));
}
