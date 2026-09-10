import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const renderer = path.join(process.cwd(), 'src', 'renderer');
const read = (name: string) => fs.readFile(path.join(renderer, name), 'utf8');

async function rendererSources(folder = renderer): Promise<Array<{ name: string; text: string }>> {
  const rows: Array<{ name: string; text: string }> = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) rows.push(...await rendererSources(target));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) rows.push({ name: path.relative(renderer, target), text: await fs.readFile(target, 'utf8') });
  }
  return rows;
}

describe('React renderer architecture', () => {
  it('boots one React tree and does not keep the deleted imperative renderer beside it', async () => {
    const [html, main, compatibility] = await Promise.all([read('index.html'), read('main.tsx'), read('chat.ts')]);
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="./main.tsx"');
    expect(html).not.toMatch(/id="(?:sessionList|chatInput|settingsForm|chatBody)"/);
    expect(main).toContain('createRoot(root).render(<StrictMode><App /></StrictMode>)');
    expect(compatibility.trim()).toBe("export { renderedMarkdown, renderedMessage } from './lib/rendered-message.js';");
    expect(compatibility).not.toMatch(/initChat|openChatView|chatVisible|querySelector/);
    for (const retired of ['dom.ts', 'plugins.ts', 'usage.ts', 'agent-panel.ts', 'chat-models.ts', 'browser-preferences.ts', 'sidebar-resize.ts', 'timeline-scroll.ts', 'context-meter.ts', 'main.ts']) {
      await expect(fs.stat(path.join(renderer, retired))).rejects.toThrow();
    }
  });

  it('follows a fresh conversation only through the exact accepted outbox id and invalidates stale acknowledgements', async () => {
    const app = await read('app.tsx');
    expect(app).toContain("const row = rows.find((entry) => entry.id === pending.id)");
    expect(app).toContain('if (!row?.deliveredSessionId) return');
    expect(app).toContain('draftGeneration.current !== pending.generation');
    expect(app).toMatch(/function draftChanged\(\)[\s\S]*pendingFresh\.current = null/);
    expect(app).not.toMatch(/sessions\[0\].*delivered|sort\(.*updatedAt.*deliveredSessionId/);
  });

  it('uses reusable React components with Base UI primitives instead of a second DOM component system', async () => {
    const [app, sidebar, composer, dialog, menu, select, scroll, switchSource, tooltip] = await Promise.all([
      read('app.tsx'), read('components/layout/app-sidebar.tsx'), read('components/chat/composer.tsx'),
      read('components/ui/dialog.tsx'), read('components/ui/dropdown-menu.tsx'), read('components/ui/select.tsx'), read('components/ui/scroll-area.tsx'),
      read('components/ui/switch.tsx'), read('components/ui/tooltip.tsx'),
    ]);
    expect(app).toMatch(/<AppSidebar[\s\S]*<ConversationWorkspace/);
    expect(sidebar).toContain('Repositories');
    expect(sidebar).not.toContain("label: 'New Chat'");
    expect(sidebar).toContain('aria-label={`New conversation in ${project.name}`}');
    expect(sidebar).toContain("label: 'Search'");
    expect(sidebar).toContain("label: 'Automations'");
    expect(sidebar).toContain("label: 'Customize'");
    expect(composer).toContain('api.addProject(session?.id ?? null)');
    for (const source of [dialog, menu, select, scroll, switchSource, tooltip]) expect(source).toContain('@base-ui/react/');
    expect((await rendererSources()).map(source => source.text).join('\n')).not.toMatch(/<select(?:\s|>)/);
  });

  it('keeps sidebar management, compact active-chat composition and recorded file/task surfaces in the React owners', async () => {
    const [sidebar, composer, timeline, icons, css] = await Promise.all([
      read('components/layout/app-sidebar.tsx'), read('components/chat/composer.tsx'), read('components/chat/timeline.tsx'), read('icons.ts'), read('styles.css'),
    ]);
    expect(sidebar).toContain('aria-label={`Delete ${session.title || \'Untitled chat\'}`}');
    expect(sidebar).not.toContain('Delete chat?');
    expect(sidebar).toContain('Remove from sidebar');
    expect(sidebar).toContain('Other conversations');
    expect(sidebar).not.toContain('aria-label="Back"');
    expect(sidebar).not.toContain('aria-label="Forward"');
    expect(icons).toContain("MoreHorizontalIcon");
    expect(icons).toContain("'i-more': MoreHorizontalIcon");
    expect(composer).toContain('rows={session ? 1 : 3}');
    expect(composer).not.toContain('focus-within:shadow-md');
    expect(composer).toContain('<TodoList');
    expect(timeline).toContain('<FileDiff changes={call.changes} />');
    expect(css).not.toMatch(/stroke-width:\s*1\.7|svg use\[href\^=/);
    expect(css).toContain('cursor: pointer');
  });

  it('keeps one Tailwind v4 semantic token system and the native system font', async () => {
    const css = await read('styles.css');
    expect(css).toContain('@import "tailwindcss"');
    for (const token of ['--background:', '--foreground:', '--card:', '--muted:', '--accent:', '--border:', '--sidebar:']) expect(css).toContain(token);
    expect(css).toContain('--color-background: var(--background)');
    expect(css).toContain('--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif');
    expect(css).not.toMatch(/font-family:\s*(?:Inter|Roboto|Arial)(?:[,;])/i);
  });

  it('uses the authored Hugeicons stroke glyphs everywhere without renderer fill/stroke overrides', async () => {
    const [icons, icon, sidebar] = await Promise.all([read('icons.ts'), read('components/ui/icon.tsx'), read('components/layout/app-sidebar.tsx')]);
    expect(icons).toContain("from '@hugeicons/core-free-icons/Add01Icon'");
    expect(icons).toContain("from '@hugeicons/core-free-icons/Activity01Icon'");
    expect(icons).toContain("'s-search': Search01Icon");
    expect(icons).not.toContain('Home01Icon');
    expect(icons).not.toContain('@solar-icons');
    expect(icons).not.toMatch(/from ['"]@hugeicons\/core-free-icons['"]/);
    expect(icons).not.toMatch(/setAttribute\(['"](?:fill|stroke|stroke-width)['"]/);
    expect(icon).toContain('fill="none"');
    for (const icon of ['s-search', 's-agents', 's-settings']) expect(sidebar).toContain(icon);
  });

  it('keeps repository disclosure, prime/worker hierarchy and connected state semantic in the sidebar/header', async () => {
    const [sidebar, workspace, css] = await Promise.all([
      read('components/layout/app-sidebar.tsx'),
      read('components/chat/workspace.tsx'),
      read('styles.css'),
    ]);
    expect(sidebar).toContain('collapsedProjects');
    expect(sidebar).toContain('aria-expanded={!collapsed}');
    expect(sidebar).toContain('onClick={() => onNewChat(project.id)}');
    expect(sidebar).toContain('data-project-header={project.id}');
    expect(sidebar).toContain('data-session-role={role}');
    expect(sidebar).toContain("primary && 'bg-brand-wash/70 text-brand");
    expect(sidebar).toContain("role=\"worker\"");
    expect(workspace).toContain('rounded-full');
    expect(workspace).toContain('bg-success text-success-foreground');
    expect(css).toContain('--brand: #486f9d');
    expect(css).toContain('--success: #1f7a4d');
    expect(css).toContain('--color-brand: var(--brand)');
    expect(css).toContain('--color-success: var(--success)');
  });

  it('requests session list pages within the sessions:list IPC limit', async () => {
    const store = await read('state/session-store.ts');
    const calls = [...store.matchAll(/listSessions\(\{([^}]*)\}\)/g)].map((match) => match[1] ?? '');
    expect(calls.length).toBeGreaterThan(0);
    for (const options of calls) {
      const limit = options.match(/limit:\s*(\d+)/);
      if (limit) expect(Number(limit[1])).toBeLessThanOrEqual(60);
    }
    const ipc = await fs.readFile(path.join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8');
    expect(ipc).toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(60\)/);
  });

  it('keeps one draggable title-bar row sharing the Windows caption controls', async () => {
    const [app, css, sidebar] = await Promise.all([
      read('app.tsx'),
      read('styles.css'),
      read('components/layout/app-sidebar.tsx'),
    ]);
    expect(app).toContain('app-topbar');
    expect(app).toContain('id="sidebarToggle"');
    expect(sidebar).not.toContain('sidebarToggle');
    expect(sidebar).not.toContain('onToggle');
    expect(css).toContain('titlebar-area-height');
    expect(css).toContain('titlebar-area-width');
    expect(css).toContain('-webkit-app-region: drag');
    expect(css).toContain('-webkit-app-region: no-drag');
  });

  it('keeps every scroll region inside a shrinkable flex chain', async () => {
    const [app, sidebar, workspace, search, automations, plugins, usage, activity, customize, scrollArea] = await Promise.all([
      read('app.tsx'),
      read('components/layout/app-sidebar.tsx'),
      read('components/chat/workspace.tsx'),
      read('components/pages/search-page.tsx'),
      read('components/pages/automations-page.tsx'),
      read('components/pages/plugins-page.tsx'),
      read('components/pages/usage-page.tsx'),
      read('components/pages/activity-page.tsx'),
      read('components/settings/customize-page.tsx'),
      read('components/ui/scroll-area.tsx'),
    ]);
    // Without min-h-0 these column items floor at their content height, so the
    // scroller below grows with its content instead of scrolling it.
    expect(app).toContain('flex min-h-0 min-w-0 flex-1 flex-col');
    expect(workspace).toMatch(/<section className="[^"]*min-h-0[^"]*" data-panel="chat"/);
    expect(workspace).toContain('min-h-0 flex-1 overflow-y-auto');
    expect(sidebar).toMatch(/<aside[^>]*min-h-0/);
    for (const [name, source] of [['search', search], ['automations', automations], ['plugins', plugins], ['usage', usage], ['activity', activity], ['customize', customize]] as const) {
      expect(source, name).toMatch(/<section className="[^"]*min-h-0/);
    }
    for (const [name, source] of [['search', search], ['automations', automations]] as const) {
      expect(source, name).toContain('min-h-0 flex-1 overflow-y-auto');
    }
    // The Base UI scroll root carries its own shrink floor; both users size it with flex-1.
    expect(scrollArea).toContain('min-h-0');
    expect(scrollArea).toContain("style={{ minWidth: 0, width: '100%' }}");
    expect(sidebar).toContain('<ScrollArea className="mt-1 min-w-0 flex-1">');
  });

  it('keeps Node and Electron authority outside every renderer module', async () => {
    const sources = await rendererSources();
    for (const source of sources) {
      expect(source.text, source.name).not.toMatch(/from ['"](?:node:|electron(?:\/|['"]))/);
      expect(source.text, source.name).not.toMatch(/\brequire\(['"](?:node:|electron)/);
      expect(source.text, source.name).not.toContain('ipcRenderer');
    }
  });
});

describe('folder-selection ownership', () => {
  it('keeps the native picker in IPC and delegates the selected path to an in-process service', async () => {
    const [ipc, service] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src', 'main', 'project-selection.ts'), 'utf8'),
    ]);
    const start = ipc.indexOf("handle('projects:add'");
    const handler = ipc.slice(start, ipc.indexOf('  // A folder dropped', start));
    expect(handler).toContain("dialog.showOpenDialog");
    expect(handler).toContain('selectProjectFolder(result.filePaths[0], sessionId)');
    expect(handler).not.toMatch(/approveFolder|assignSessionProject|setWorkspaceFor|resolvePath/);
    expect(service).toMatch(/approveFolder\(folderPath\)[\s\S]*addProject\(folderPath\)[\s\S]*assignSessionProject\(sessionId, project.id\)/);
  });
});
