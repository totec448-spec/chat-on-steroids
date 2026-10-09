import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

/** Fonts always ship as files; anything else keeps Vite's default inlining. */
export const rendererAssetsInlineLimit = (file: string): boolean | undefined => /\.(?:woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined;

const nixNodeModules = process.env.npmDeps ? resolve(process.env.npmDeps, 'node_modules') : null;

export default defineConfig({
  main: {
    // Keep node_modules external so the MCP SDK ships as real files in the asar
    // rather than being inlined by the bundler.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'pet-overlay': resolve(__dirname, 'src/preload/pet-overlay.ts'),
          'cos-browser': resolve(__dirname, 'src/preload/cos-browser.ts'),
          'cos-browser-worker': resolve(__dirname, 'src/preload/cos-browser-worker.ts'),
          'cos-browser-sign-in': resolve(__dirname, 'src/preload/cos-browser-sign-in.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // nixpkgs' development hook links dependencies from its immutable node_modules
    // derivation. Vite resolves those symlinks before its filesystem check, so allow
    // that exact derivation when `nix develop` exports it as npmDeps.
    server: nixNodeModules
      ? {
          fs: {
            allow: [resolve(__dirname), nixNodeModules]
          }
        }
      : undefined,
    build: {
      // The window's policy allows fonts from the app only (font-src 'self'). Vite inlines small
      // assets as data: URLs, which that policy blocks, so a few KaTeX fonts never loaded.
      assetsInlineLimit: rendererAssetsInlineLimit,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          'pet-overlay': resolve(__dirname, 'src/renderer/pet-overlay.html'),
          'cos-browser': resolve(__dirname, 'src/renderer/cos-browser.html'),
          'cos-browser-sign-in': resolve(__dirname, 'src/renderer/cos-browser-sign-in.html')
        }
      }
    }
  }
});
