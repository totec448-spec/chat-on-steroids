import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Which commit this bundle was built from.
 *
 * Every build calls itself 2.0.2, which is fine for a version and useless for telling two builds
 * apart. A QA run tested an app that turned out to predate the feature it was there to test, and
 * nothing on screen could have revealed that: same name, same version, different code. CI sets
 * GITHUB_SHA; a local build reads git; neither being available is not a build failure, it just
 * means nobody can be told.
 */
function buildRevision(): string {
  const fromCI = process.env['GITHUB_SHA'];
  if (fromCI) return fromCI.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  main: {
    // Keep node_modules external so the MCP SDK ships as real files in the asar
    // rather than being inlined by the bundler.
    plugins: [externalizeDepsPlugin()],
    define: { __BUILD_REVISION__: JSON.stringify(buildRevision()) },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    }
  }
});
