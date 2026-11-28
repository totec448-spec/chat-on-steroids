import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/** Fonts always ship as files; anything else keeps Vite's default inlining. */
export const rendererAssetsInlineLimit = (file: string): boolean | undefined => /\.(?:woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined;

const nixNodeModules = process.env.npmDeps ? resolve(process.env.npmDeps, 'node_modules') : null;

// Keep the Workspace's synchronous module entry and derive the compact page from the
// same HTML at dev/build time. No copied composer markup or Workspace startup race.
const workspacePage = resolve(__dirname, 'src/renderer/index.html');
const compactPage = resolve(__dirname, 'src/renderer/quick-chat.html');
export function compactHtml(page: string): string {
  const entry = '<script type="module" src="./main.ts"></script>';
  if (page.split(entry).length !== 2) throw new Error('Workspace must have exactly one main entry script');
  return page.replace(entry, '<script type="module" src="./quick-chat.ts"></script>');
}
function quickChatPage(): Plugin {
  return {
    name: 'quick-chat-page', enforce: 'pre',
    resolveId(id) { if (id === compactPage) return compactPage; },
    load(id) {
      if (id !== compactPage) return;
      this.addWatchFile(workspacePage);
      return compactHtml(readFileSync(workspacePage, 'utf8'));
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/quick-chat.html') return next();
        void server.transformIndexHtml('/quick-chat.html', compactHtml(readFileSync(workspacePage, 'utf8'))).then(html => {
          response.setHeader('Content-Type', 'text/html'); response.end(html);
        }).catch(next);
      });
    }
  };
}

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
          'desktop-ask': resolve(__dirname, 'src/preload/desktop-ask.ts'),
          'cos-browser': resolve(__dirname, 'src/preload/cos-browser.ts'),
          'cos-browser-worker': resolve(__dirname, 'src/preload/cos-browser-worker.ts'),
          'cos-browser-sign-in': resolve(__dirname, 'src/preload/cos-browser-sign-in.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [quickChatPage()],
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
          'quick-chat': compactPage,
          'pet-overlay': resolve(__dirname, 'src/renderer/pet-overlay.html'),
          'update-progress': resolve(__dirname, 'src/renderer/update-progress.html'),
          'desktop-ask': resolve(__dirname, 'src/renderer/desktop-ask.html'),
          'cos-browser': resolve(__dirname, 'src/renderer/cos-browser.html'),
          'cos-browser-sign-in': resolve(__dirname, 'src/renderer/cos-browser-sign-in.html')
        }
      }
    }
  }
});
