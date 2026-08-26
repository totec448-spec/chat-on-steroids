/**
 * The child environment.
 *
 * These are regressions for a live incident, not hygiene. The installed 1.7 build spawned
 * every child with a `Path` of exactly
 * `C:\Users\…\Chat On Steroids\resources\rg;` — one directory, no System32, no Git, no
 * Node — while the machine's own registry path was healthy. `npm` was "not recognized",
 * `git` and `where.exe` and `powershell.exe` all failed ENOENT, and the visible Claude Code
 * process inherited the same crippled path.
 *
 * The cause was two characters of case. Windows environment names are case-insensitive and
 * the inherited path is spelled `Path`; `{ ...process.env }` produces a case-*sensitive*
 * object, so `env.PATH ?? ''` read as empty and the assignment created a second key. The
 * block handed to CreateProcess then contained `Path=<everything>` and `PATH=<rg only>`,
 * and the wrong one won.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEnvOverrides,
  deleteEnvValue,
  ensureUsablePath,
  envValue,
  normalizeEnvironment,
  pathEntries,
  prependPath,
  setEnvValue
} from '../src/main/env.js';
import { ensureDevToolchain, resetToolchainCache, type ToolchainProbe } from '../src/main/toolchain.js';

/** A Windows environment as Windows actually spells it. */
const windowsEnv = (): Record<string, string> => ({
  Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
  SystemRoot: 'C:\\Windows',
  USERNAME: 'developer'
});

const pathKeys = (env: Record<string, string | undefined>): string[] =>
  Object.keys(env).filter((key) => key.toLowerCase() === 'path');

describe.runIf(process.platform === 'win32')('the Windows child environment', () => {
  it('reads the inherited path whatever Windows spelled it', () => {
    expect(envValue(windowsEnv(), 'PATH')).toBe('C:\\Windows\\System32;C:\\Program Files\\nodejs');
    expect(envValue({ PATH: '/usr/bin' }, 'Path')).toBe('/usr/bin');
    expect(envValue(windowsEnv(), 'systemroot')).toBe('C:\\Windows');
  });

  it('prepends the bundled tool directory without losing a single inherited entry', () => {
    // The live failure, exactly: this is the only thing the crippled child had left.
    const env = normalizeEnvironment(windowsEnv());
    prependPath(env, 'C:\\Program Files\\Chat On Steroids\\resources\\rg');

    expect(pathKeys(env)).toEqual(['Path']);
    expect(pathEntries(env)).toEqual([
      'C:\\Program Files\\Chat On Steroids\\resources\\rg',
      'C:\\Windows\\System32',
      'C:\\Program Files\\nodejs'
    ]);
  });

  it('never leaves two spellings of one variable behind', () => {
    const env = normalizeEnvironment(windowsEnv());
    setEnvValue(env, 'PATH', 'C:\\one');
    setEnvValue(env, 'path', 'C:\\two');

    expect(pathKeys(env)).toEqual(['Path']);
    expect(envValue(env, 'PATH')).toBe('C:\\two');
  });

  it('collapses a source that already holds both spellings, keeping the first with a value', () => {
    const env = normalizeEnvironment({ Path: 'C:\\real', PATH: 'C:\\rg-only' });
    expect(pathKeys(env)).toEqual(['Path']);
    expect(envValue(env, 'PATH')).toBe('C:\\real');

    const empty = normalizeEnvironment({ Path: '', PATH: 'C:\\rg-only' });
    expect(pathKeys(empty)).toEqual(['Path']);
    expect(envValue(empty, 'PATH')).toBe('C:\\rg-only');
  });

  it('applies a caller override onto the inherited spelling rather than beside it', () => {
    const env = normalizeEnvironment(windowsEnv());
    applyEnvOverrides(env, { PATH: 'C:\\only-this', Username: 'someone' });

    expect(pathKeys(env)).toEqual(['Path']);
    expect(envValue(env, 'path')).toBe('C:\\only-this');
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'username')).toEqual(['USERNAME']);
    expect(envValue(env, 'USERNAME')).toBe('someone');
  });

  it('removes every spelling of a secret, not just the one we happened to write', () => {
    const env = normalizeEnvironment({ Path: 'C:\\Windows\\System32', openai_api_key: 'sk-live' });
    deleteEnvValue(env, 'OPENAI_API_KEY');
    expect(envValue(env, 'openai_api_key')).toBeUndefined();
    expect(Object.keys(env)).toEqual(['Path']);
  });

  it('prepending twice does not grow the path', () => {
    const env = normalizeEnvironment(windowsEnv());
    prependPath(env, 'C:\\rg');
    prependPath(env, 'C:\\rg');
    expect(pathEntries(env).filter((entry) => entry === 'C:\\rg')).toHaveLength(1);
  });

  it('drops variables the parent had unset instead of writing them as "undefined"', () => {
    const env = normalizeEnvironment({ Path: 'C:\\Windows\\System32', GONE: undefined });
    expect('GONE' in env).toBe(false);
  });
});

describe.runIf(process.platform !== 'win32')('the POSIX child environment', () => {
  it('keeps environment variable names case-sensitive', () => {
    const env = normalizeEnvironment({ PATH: '/usr/bin', Path: '/custom/bin', GONE: undefined });
    expect(envValue(env, 'PATH')).toBe('/usr/bin');
    expect(envValue(env, 'Path')).toBe('/custom/bin');
    expect(envValue(env, 'path')).toBeUndefined();
    expect('GONE' in env).toBe(false);
  });

  it('updates and deletes only the exact requested spelling', () => {
    const env = normalizeEnvironment({ PATH: '/usr/bin', Path: '/custom/bin' });
    setEnvValue(env, 'PATH', '/bin');
    expect(env).toMatchObject({ PATH: '/bin', Path: '/custom/bin' });
    deleteEnvValue(env, 'PATH');
    expect(envValue(env, 'PATH')).toBeUndefined();
    expect(envValue(env, 'Path')).toBe('/custom/bin');
  });

  it('deduplicates PATH entries case-sensitively', () => {
    const env = normalizeEnvironment({ PATH: '/opt/Foo:/opt/foo:/usr/bin' });
    prependPath(env, '/opt/Foo');
    expect(pathEntries(env)).toEqual(['/opt/Foo', '/opt/foo', '/usr/bin']);
  });

  it('applies overrides without changing a differently-cased variable', () => {
    const env = normalizeEnvironment({ PATH: '/usr/bin', Path: '/custom/bin' });
    applyEnvOverrides(env, { PATH: '/bin' });
    expect(env).toMatchObject({ PATH: '/bin', Path: '/custom/bin' });
  });
});

describe.runIf(process.platform === 'win32')('a parent whose own path is unusable', () => {
  it('gives the child enough to find powershell and say what went wrong', () => {
    const env = normalizeEnvironment({ Path: 'C:\\rg;', SystemRoot: 'C:\\Windows' });
    ensureUsablePath(env);

    const entries = pathEntries(env).map((entry) => entry.toLowerCase());
    expect(entries[0]).toBe('c:\\rg');
    expect(entries).toContain('c:\\windows\\system32');
    expect(entries).toContain('c:\\windows\\system32\\windowspowershell\\v1.0');
    expect(pathKeys(env)).toEqual(['Path']);
  });

  it('leaves a fully equipped inherited path exactly as it found it', () => {
    const equipped =
      'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;' +
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Program Files\\nodejs';
    const env = normalizeEnvironment({ ...windowsEnv(), Path: equipped });
    ensureUsablePath(env);
    expect(envValue(env, 'PATH')).toBe(equipped);
    expect(pathKeys(env)).toEqual(['Path']);
  });

  it('adds the rest of the Windows directories to a path that only has System32', () => {
    // System32 alone used to satisfy the check and return early, which is not the same
    // question. `where.exe` lives there, but `taskkill` needs nothing else while WMIC lives
    // in Wbem and powershell.exe in WindowsPowerShell\v1.0 — so a path this thin still
    // failed to start the very helpers the repair exists to guarantee.
    const env = normalizeEnvironment({ Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' });
    ensureUsablePath(env);

    const entries = pathEntries(env).map((entry) => entry.toLowerCase());
    // What the parent had stays where the parent put it; the repair only appends.
    expect(entries[0]).toBe('c:\\windows\\system32');
    expect(entries).toContain('c:\\windows');
    expect(entries).toContain('c:\\windows\\system32\\wbem');
    expect(entries).toContain('c:\\windows\\system32\\windowspowershell\\v1.0');
    expect(new Set(entries).size).toBe(entries.length);
    expect(pathKeys(env)).toEqual(['Path']);
  });
});

/**
 * A toolchain the machine has but never put on the path.
 *
 * `ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH` was the
 * most repeated *recoverable* shell failure in the recorded sessions, and it was never an
 * inheritance bug: on a machine where Android Studio is the only JDK, nothing ever exports
 * JAVA_HOME. The model recovered every time by prefixing the variable by hand, which means
 * the answer was available all along and the round trip bought nothing.
 *
 * The risk being guarded here is redirecting a build that was already fine. Filling in a
 * variable is only safe while it is strictly additive, so the negatives below — an existing
 * value, a java already on PATH — matter more than the positive.
 */
describe.runIf(process.platform === 'win32')('an unset developer toolchain', () => {
  beforeEach(() => resetToolchainCache());

  /** A machine with Android Studio's bundled runtime and nothing else. */
  const studioProbe: ToolchainProbe = {
    isFile: (target) => target === 'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\javac.exe',
    directories: () => []
  };

  const bareEnv = (): Record<string, string> => ({
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files'
  });

  it('fills in JAVA_HOME and its bin directory when java is unreachable', () => {
    const env = normalizeEnvironment(bareEnv());
    const added = ensureDevToolchain(env, studioProbe);

    expect(envValue(env, 'JAVA_HOME')).toBe('C:\\Program Files\\Android\\Android Studio\\jbr');
    expect(pathEntries(env)[0]).toBe('C:\\Program Files\\Android\\Android Studio\\jbr\\bin');
    expect(added).toEqual(['JAVA_HOME=C:\\Program Files\\Android\\Android Studio\\jbr']);
    // The whole reason env.ts exists: one spelling of PATH, never two.
    expect(pathKeys(env)).toEqual(['Path']);
    // What the parent had is still reachable behind the addition.
    expect(pathEntries(env)).toContain('C:\\Windows\\System32');
  });

  it('never overrides a JAVA_HOME the user already chose', () => {
    const env = normalizeEnvironment({ ...bareEnv(), JAVA_HOME: 'C:\\jdk-21' });
    expect(ensureDevToolchain(env, studioProbe)).toEqual([]);
    expect(envValue(env, 'JAVA_HOME')).toBe('C:\\jdk-21');
    expect(pathEntries(env)).toEqual(['C:\\Windows\\System32']);
  });

  it('never redirects a build whose java already resolves on PATH', () => {
    // A project deliberately selecting its JDK through PATH must not be quietly moved to
    // whichever JDK this machine happens to have installed somewhere else.
    const probe: ToolchainProbe = {
      isFile: (target) =>
        target === 'C:\\chosen\\jdk\\bin\\java.exe' ||
        target === 'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\javac.exe',
      directories: () => []
    };
    const env = normalizeEnvironment({ ...bareEnv(), Path: 'C:\\chosen\\jdk\\bin;C:\\Windows\\System32' });
    expect(ensureDevToolchain(env, probe)).toEqual([]);
    expect(envValue(env, 'JAVA_HOME')).toBeUndefined();
  });

  it('does not rescan the same PATH for Java and Go on every fresh command environment', () => {
    let probes = 0;
    const probe: ToolchainProbe = {
      isFile: (target) => {
        probes++;
        return target === 'C:\\chosen\\bin\\java.exe' || target === 'C:\\chosen\\bin\\go.exe';
      },
      directories: () => []
    };
    const source = { ...bareEnv(), Path: 'C:\\chosen\\bin;C:\\Windows\\System32' };

    expect(ensureDevToolchain(normalizeEnvironment(source), probe)).toEqual([]);
    const firstPass = probes;
    expect(firstPass).toBeGreaterThan(0);

    // execChildEnvironment() creates a new object each time. Same effective PATH must reuse
    // the process-lifetime reachability verdict instead of stat'ing every PATH entry again.
    expect(ensureDevToolchain(normalizeEnvironment(source), probe)).toEqual([]);
    expect(probes).toBe(firstPass);
  });

  it('adds nothing at all when no toolchain is actually on disk', () => {
    const env = normalizeEnvironment(bareEnv());
    const empty: ToolchainProbe = { isFile: () => false, directories: () => [] };
    expect(ensureDevToolchain(env, empty)).toEqual([]);
    expect(envValue(env, 'JAVA_HOME')).toBeUndefined();
    expect(envValue(env, 'GOROOT')).toBeUndefined();
    expect(pathEntries(env)).toEqual(['C:\\Windows\\System32']);
  });

  it('descends one level into a versioned install root and prefers the later version', () => {
    const probe: ToolchainProbe = {
      isFile: (target) => target === 'C:\\Program Files\\Java\\jdk-21\\bin\\javac.exe',
      directories: (target) =>
        target === 'C:\\Program Files\\Java'
          ? ['C:\\Program Files\\Java\\jdk-11', 'C:\\Program Files\\Java\\jdk-21']
          : []
    };
    const env = normalizeEnvironment(bareEnv());
    ensureDevToolchain(env, probe);
    expect(envValue(env, 'JAVA_HOME')).toBe('C:\\Program Files\\Java\\jdk-21');
  });

  it('compares version numbers as numbers, so 9 does not outrank 21', () => {
    // A lexical sort puts `jdk-9` after `jdk-21` on the first character, and this code
    // took the last name as the newest. On a machine holding both, every Gradle build
    // would have been handed a JDK that current Gradle refuses to run on at all.
    const both = ['C:\\Program Files\\Java\\jdk-21', 'C:\\Program Files\\Java\\jdk-9'];
    const probe: ToolchainProbe = {
      isFile: (target) => both.some((root) => target === `${root}\\bin\\javac.exe`),
      directories: (target) => (target === 'C:\\Program Files\\Java' ? both : [])
    };
    const env = normalizeEnvironment(bareEnv());
    ensureDevToolchain(env, probe);
    expect(envValue(env, 'JAVA_HOME')).toBe('C:\\Program Files\\Java\\jdk-21');
  });

  it('orders a patch version the same way', () => {
    const all = [
      'C:\\Program Files\\Java\\jdk-21.0.5',
      'C:\\Program Files\\Java\\jdk-21.0.12',
      'C:\\Program Files\\Java\\jdk-8'
    ];
    const probe: ToolchainProbe = {
      isFile: (target) => all.some((root) => target === `${root}\\bin\\javac.exe`),
      directories: (target) => (target === 'C:\\Program Files\\Java' ? all : [])
    };
    const env = normalizeEnvironment(bareEnv());
    ensureDevToolchain(env, probe);
    expect(envValue(env, 'JAVA_HOME')).toBe('C:\\Program Files\\Java\\jdk-21.0.12');
  });

  it('still reaches a toolchain whose name carries no version at all', () => {
    // `jbr`, `current`, `latest`: ranking must never make one unreachable.
    const probe: ToolchainProbe = {
      isFile: (target) => target === 'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\javac.exe',
      directories: (target) =>
        target === 'C:\\Program Files\\Android\\Android Studio'
          ? ['C:\\Program Files\\Android\\Android Studio\\jbr']
          : []
    };
    const env = normalizeEnvironment(bareEnv());
    ensureDevToolchain(env, probe);
    expect(envValue(env, 'JAVA_HOME')).toBe('C:\\Program Files\\Android\\Android Studio\\jbr');
  });

  it('passes over a JRE sitting beside the JDK', () => {
    // `C:\Program Files\Java` holding `jdk-21` next to a leftover `jre1.8.0_411` is what an
    // ordinary Oracle install leaves behind, and the name ranking is plain text once the
    // names stop sharing a digit run — so `jre…` sorted first. Both hold `bin\java.exe`, so
    // probing the launcher picked the runtime: JAVA_HOME would have named something that
    // cannot compile, with its bin ahead of the JDK on PATH. That is not a worse choice
    // than doing nothing, it is a broken build on a machine that had a working one.
    const roots = ['C:\\Program Files\\Java\\jdk-21', 'C:\\Program Files\\Java\\jre1.8.0_411'];
    const probe: ToolchainProbe = {
      isFile: (target) =>
        target === 'C:\\Program Files\\Java\\jdk-21\\bin\\javac.exe' ||
        roots.some((root) => target === `${root}\\bin\\java.exe`),
      directories: (target) => (target === 'C:\\Program Files\\Java' ? roots : [])
    };
    const env = normalizeEnvironment(bareEnv());
    ensureDevToolchain(env, probe);
    expect(envValue(env, 'JAVA_HOME')).toBe('C:\\Program Files\\Java\\jdk-21');
    expect(pathEntries(env)[0]).toBe('C:\\Program Files\\Java\\jdk-21\\bin');
  });

  it('adds nothing when the only Java on the machine cannot compile', () => {
    // Doing nothing leaves the caller with the error it already knew how to recover from.
    // Naming a JRE would instead answer confidently and wrongly, and put it on PATH.
    const probe: ToolchainProbe = {
      isFile: (target) => target === 'C:\\Program Files\\Java\\jre1.8.0_411\\bin\\java.exe',
      directories: (target) =>
        target === 'C:\\Program Files\\Java' ? ['C:\\Program Files\\Java\\jre1.8.0_411'] : []
    };
    const env = normalizeEnvironment(bareEnv());
    expect(ensureDevToolchain(env, probe)).toEqual([]);
    expect(envValue(env, 'JAVA_HOME')).toBeUndefined();
    expect(pathEntries(env)).toEqual(['C:\\Windows\\System32']);
  });

  it('fills in GOROOT on the same terms', () => {
    const probe: ToolchainProbe = {
      isFile: (target) => target === 'C:\\Program Files\\Go\\bin\\go.exe',
      directories: () => []
    };
    const env = normalizeEnvironment(bareEnv());
    expect(ensureDevToolchain(env, probe)).toEqual(['GOROOT=C:\\Program Files\\Go']);
    expect(envValue(env, 'GOROOT')).toBe('C:\\Program Files\\Go');
    expect(pathEntries(env)[0]).toBe('C:\\Program Files\\Go\\bin');
  });

  it('is idempotent, so a long-lived process cannot grow its path without bound', () => {
    const env = normalizeEnvironment(bareEnv());
    ensureDevToolchain(env, studioProbe);
    const afterFirst = envValue(env, 'PATH');
    ensureDevToolchain(env, studioProbe);
    expect(envValue(env, 'PATH')).toBe(afterFirst);
  });
});
