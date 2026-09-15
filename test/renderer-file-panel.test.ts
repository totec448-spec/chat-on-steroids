import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFilePanel } from '../src/renderer/file-panel.js';
import { createAgentPanel } from '../src/renderer/agent-panel.js';
import type { LocalProject } from '../src/shared/projects.js';
import type { ProjectDirectoryListing, ProjectFilePreview, ProjectFilesChanged } from '../src/shared/project-files.js';

const createPdfViewer = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/file-pdf-viewer.js', () => ({ createProjectPdfViewer: createPdfViewer }));

let dom: JSDOM;
let host: HTMLElement;
let toggle: HTMLButtonElement;
let attached: string[];
let projectFilesChanged: ((event: ProjectFilesChanged) => void) | null;

const projectA: LocalProject = { id: '11111111-1111-4111-8111-111111111111', name: 'alpha', path: 'C:\\alpha', createdAt: 1 };
const projectB: LocalProject = { id: '22222222-2222-4222-8222-222222222222', name: 'beta', path: 'C:\\beta', createdAt: 2 };

const rootListing = (project = projectA): ProjectDirectoryListing => ({
  projectId: project.id,
  projectName: project.name,
  directory: '',
  entries: [
    { name: 'src', path: 'src', kind: 'directory', bytes: null },
    { name: 'README.md', path: 'README.md', kind: 'file', bytes: 12 }
  ],
  truncated: false
});

const preview: ProjectFilePreview = {
  projectId: projectA.id,
  projectName: projectA.name,
  path: 'README.md',
  name: 'README.md',
  bytes: 12,
  modifiedAt: new Date(0).toISOString(),
  binary: false,
  text: '# hello',
  truncated: false
};

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
const tick = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
const submitEntryDialog = async (value: string): Promise<void> => {
  const dialog = document.querySelector<HTMLDialogElement>('.file-entry-dialog')!;
  const input = dialog.querySelector<HTMLInputElement>('.file-entry-dialog-input')!;
  input.value = value;
  dialog.querySelector<HTMLFormElement>('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
};

beforeEach(() => {
  dom = new JSDOM('<body><section id="host"></section><button id="toggle"></button></body>', { url: 'https://cos.local/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLButtonElement', dom.window.HTMLButtonElement);
  host = document.getElementById('host')!;
  toggle = document.getElementById('toggle') as HTMLButtonElement;
  attached = [];
  projectFilesChanged = null;
  createPdfViewer.mockReset();
  createPdfViewer.mockImplementation(async ({ parent }: { parent: HTMLElement }) => {
    const marker = document.createElement('div');
    marker.className = 'pdf-viewer-mock';
    parent.append(marker);
    return { destroy: vi.fn() };
  });
  Object.assign(dom.window, {
    api: {
      listProjectFiles: vi.fn((projectId: string, directory: string) => ok(directory === 'src'
        ? { ...rootListing(projectA), directory: 'src', entries: [{ name: 'main.ts', path: 'src/main.ts', kind: 'file', bytes: 20 }] }
        : rootListing(projectId === projectB.id ? projectB : projectA))),
      previewProjectFile: vi.fn(() => ok(preview)),
      watchProjectFiles: vi.fn(() => ok(true)),
      onProjectFilesChanged: vi.fn((listener: (event: ProjectFilesChanged) => void) => {
        projectFilesChanged = listener;
        return () => { if (projectFilesChanged === listener) projectFilesChanged = null; };
      }),
      createProjectFileEntry: vi.fn(),
      renameProjectFileEntry: vi.fn(),
      deleteProjectFileEntry: vi.fn(),
      revealProjectFileEntry: vi.fn(() => ok(true)),
      attachProjectFile: vi.fn(() => ok({ id: 'file-1', name: 'README.md', size: 12, mimeType: 'text/markdown' })),
      writeClipboard: vi.fn(() => ok(true))
    }
  });
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

it('is unavailable without a local project and lazily expands only the chosen directory', async () => {
  const onShow = vi.fn();
  const panel = createFilePanel({ host, toggle, onShow, onAttach: file => attached.push(file.name) });
  panel.update(null);
  expect(toggle.hidden).toBe(true);

  panel.update(projectA);
  expect(toggle.hidden).toBe(false);
  toggle.click(); await tick();
  expect(onShow).toHaveBeenCalledTimes(1);
  expect((window.api.listProjectFiles as any)).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('README.md');
  expect(host.textContent).not.toContain('main.ts');

  host.querySelector<HTMLButtonElement>('[data-path="src"]')!.click(); await tick();
  expect((window.api.listProjectFiles as any)).toHaveBeenLastCalledWith(projectA.id, 'src');
  expect(host.textContent).toContain('main.ts');
  expect((window.api.watchProjectFiles as any)).toHaveBeenLastCalledWith(projectA.id, ['', 'src']);
});

it('refreshes a watched directory automatically when the filesystem changes', async () => {
  let listing = rootListing(projectA);
  (window.api.listProjectFiles as any) = vi.fn(() => ok(listing));
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  expect(host.textContent).not.toContain('generated.ts');

  listing = {
    ...listing,
    entries: [...listing.entries, { name: 'generated.ts', path: 'generated.ts', kind: 'file', bytes: 10 }]
  };
  projectFilesChanged?.({ projectId: projectA.id, directory: '' });
  await tick();

  expect((window.api.listProjectFiles as any)).toHaveBeenLastCalledWith(projectA.id, '');
  expect(host.textContent).toContain('generated.ts');
});

it('previews and attaches a selected project file without exposing a native path', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: file => attached.push(file.name) });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();

  expect((window.api.previewProjectFile as any)).toHaveBeenCalledWith(projectA.id, 'README.md');
  expect(host.querySelector('.file-preview-markdown h1')?.textContent).toBe('hello');
  const attach = [...host.querySelectorAll<HTMLButtonElement>('.file-preview-actions button')]
    .find(button => button.title === 'Attach')!;
  attach.click(); await tick();
  expect((window.api.attachProjectFile as any)).toHaveBeenCalledWith(projectA.id, 'README.md');
  expect(attached).toEqual(['README.md']);
  expect(JSON.stringify((window.api.attachProjectFile as any).mock.calls)).not.toContain('C:\\alpha');
});

it('lets the user close only the file preview without closing Files or changing the selection', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();

  const close = [...host.querySelectorAll<HTMLButtonElement>('.file-preview-actions button')]
    .find(button => button.title === 'Close preview')!;
  expect(close).toBeTruthy();
  close.click(); await tick();

  expect(host.querySelector<HTMLElement>('.file-preview')!.hidden).toBe(true);
  expect(panel.visible()).toBe(true);
  expect(host.querySelector('[data-path="README.md"]')?.classList.contains('is-selected')).toBe(true);
});

it('creates files and folders and renames entries through an in-app name dialog', async () => {
  (window.api.createProjectFileEntry as any) = vi.fn((projectId: string, directory: string, name: string, kind: 'file' | 'directory') =>
    ok({ projectId, path: directory ? `${directory}/${name}` : name, kind }));
  (window.api.renameProjectFileEntry as any) = vi.fn((projectId: string, _oldPath: string, name: string) =>
    ok({ projectId, path: name, kind: 'file' }));
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const action = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.file-panel-toolbar button')]
    .find(button => button.textContent?.includes(label))!;

  action('New file').click();
  expect(document.querySelector('.file-entry-dialog h2')?.textContent).toBe('New file');
  await submitEntryDialog('notes.txt');
  expect((window.api.createProjectFileEntry as any)).toHaveBeenCalledWith(projectA.id, '', 'notes.txt', 'file');

  action('New folder').click();
  expect(document.querySelector('.file-entry-dialog h2')?.textContent).toBe('New folder');
  await submitEntryDialog('docs');
  expect((window.api.createProjectFileEntry as any)).toHaveBeenCalledWith(projectA.id, '', 'docs', 'directory');

  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();
  action('Rename').click();
  expect(document.querySelector<HTMLInputElement>('.file-entry-dialog-input')?.value).toBe('README.md');
  await submitEntryDialog('README-renamed.md');
  expect((window.api.renameProjectFileEntry as any)).toHaveBeenCalledWith(projectA.id, 'README.md', 'README-renamed.md');
});

it('uses an in-app confirmation before moving a selected item to the Trash', async () => {
  (window.api.deleteProjectFileEntry as any) = vi.fn(() => ok(true));
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();
  const remove = [...host.querySelectorAll<HTMLButtonElement>('.file-panel-toolbar button')]
    .find(button => button.textContent?.includes('Delete'))!;

  remove.click();
  expect(document.querySelector('.file-confirm-dialog h2')?.textContent).toBe('Delete item?');
  expect(document.querySelector('.file-confirm-dialog')?.textContent).toContain('Move “README.md” to the Trash?');
  expect((window.api.deleteProjectFileEntry as any)).not.toHaveBeenCalled();

  document.querySelector<HTMLButtonElement>('.file-confirm-dialog .file-dialog-danger')!.click();
  await tick();
  expect((window.api.deleteProjectFileEntry as any)).toHaveBeenCalledWith(projectA.id, 'README.md');
  expect(document.querySelector('.file-confirm-dialog')).toBeNull();
});

it('centers tree disclosure and panel close controls with geometry-owned icons', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();

  const disclosure = host.querySelector<HTMLElement>('[data-path="src"] .file-tree-disclosure')!;
  expect(disclosure.textContent).toBe('');
  expect(disclosure.getAttribute('aria-hidden')).toBe('true');
  const close = host.querySelector<HTMLButtonElement>('.file-panel-close')!;
  expect(close.querySelector('use')?.getAttribute('href')).toBe('#i-x');
});

it('renders markdown semantically and strips executable or remote-media markup', async () => {
  const markdown: ProjectFilePreview = {
    ...preview,
    text: '# Heading\n\nA **bold** paragraph with a [safe link](https://example.com).\n\n```text\nlong code line\n```\n\n<script>alert(1)</script>\n\n![remote](https://example.com/image.png)'
  };
  (window.api.previewProjectFile as any) = vi.fn(() => ok(markdown));
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();

  const rendered = host.querySelector<HTMLElement>('.file-preview-markdown')!;
  expect(rendered.querySelector('h1')?.textContent).toBe('Heading');
  expect(rendered.querySelector('strong')?.textContent).toBe('bold');
  expect(rendered.querySelector('pre code')?.textContent).toContain('long code line');
  expect(rendered.querySelector('script')).toBeNull();
  expect(rendered.querySelector('img')).toBeNull();
  expect(rendered.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
});

it('renders supported image previews inline instead of the generic binary placeholder', async () => {
  const imagePreview: ProjectFilePreview = {
    projectId: projectA.id,
    projectName: projectA.name,
    path: 'Perfil.jpg',
    name: 'Perfil.jpg',
    bytes: 12,
    modifiedAt: new Date(0).toISOString(),
    binary: true,
    text: null,
    imageMimeType: 'image/jpeg',
    imageDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
    truncated: false
  };
  (window.api.listProjectFiles as any) = vi.fn(() => ok({
    ...rootListing(projectA),
    entries: [{ name: 'Perfil.jpg', path: 'Perfil.jpg', kind: 'file', bytes: 12 }]
  }));
  (window.api.previewProjectFile as any) = vi.fn(() => ok(imagePreview));

  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="Perfil.jpg"]')!.click(); await tick();

  const image = host.querySelector<HTMLImageElement>('.file-preview-image')!;
  expect(image).not.toBeNull();
  expect(image.src).toBe(imagePreview.imageDataUrl);
  expect(image.alt).toBe('Perfil.jpg');
  expect(host.textContent).not.toContain('Binary file · preview unavailable');
});

it('mounts the in-app PDF viewer from project-scoped bytes without exposing a native path', async () => {
  const pdfPreview: ProjectFilePreview = {
    projectId: projectA.id,
    projectName: projectA.name,
    path: 'paper.pdf',
    name: 'paper.pdf',
    bytes: 24,
    modifiedAt: new Date(0).toISOString(),
    binary: true,
    text: null,
    pdfDataBase64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
    truncated: false
  };
  (window.api.listProjectFiles as any) = vi.fn(() => ok({
    ...rootListing(projectA),
    entries: [{ name: 'paper.pdf', path: 'paper.pdf', kind: 'file', bytes: pdfPreview.bytes }]
  }));
  (window.api.previewProjectFile as any) = vi.fn(() => ok(pdfPreview));

  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="paper.pdf"]')!.click(); await tick();

  expect(createPdfViewer).toHaveBeenCalledWith(expect.objectContaining({
    parent: expect.any(HTMLElement),
    filename: 'paper.pdf',
    dataBase64: pdfPreview.pdfDataBase64
  }));
  expect(host.querySelector('.file-pdf-viewer-host')).not.toBeNull();
  expect(JSON.stringify(createPdfViewer.mock.calls)).not.toContain('C:\\alpha');
  expect(host.textContent).not.toContain('Binary file · preview unavailable');
});

it('lets the file preview expand vertically over the tree and persists that height', async () => {
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 900 });
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();

  const previewPane = host.querySelector<HTMLElement>('.file-preview')!;
  const handle = previewPane.querySelector<HTMLElement>('.file-preview-resize')!;
  expect(handle.getAttribute('role')).toBe('separator');
  expect(handle.getAttribute('aria-orientation')).toBe('horizontal');

  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  expect(previewPane.style.height).toMatch(/^\d+px$/);
  expect(Number.parseInt(previewPane.style.height, 10)).toBeGreaterThanOrEqual(160);
  expect(dom.window.localStorage.getItem('chat-on-steroids.file-preview-height')).toBe(previewPane.style.height.replace('px', ''));
});

it('keeps the same PDF viewer mounted across unrelated panel repaints and unchanged watcher refreshes', async () => {
  const pdfPreview: ProjectFilePreview = {
    projectId: projectA.id,
    projectName: projectA.name,
    path: 'paper.pdf',
    name: 'paper.pdf',
    bytes: 24,
    modifiedAt: new Date(0).toISOString(),
    binary: true,
    text: null,
    pdfDataBase64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
    truncated: false
  };
  (window.api.listProjectFiles as any) = vi.fn(() => ok({
    ...rootListing(projectA),
    entries: [{ name: 'paper.pdf', path: 'paper.pdf', kind: 'file', bytes: pdfPreview.bytes }]
  }));
  (window.api.previewProjectFile as any) = vi.fn(() => ok(pdfPreview));

  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="paper.pdf"]')!.click(); await tick();

  const firstHost = host.querySelector<HTMLElement>('.file-pdf-viewer-host')!;
  const firstMarker = host.querySelector<HTMLElement>('.pdf-viewer-mock')!;
  expect(createPdfViewer).toHaveBeenCalledTimes(1);

  // Session-list paints call filePanel.update() even when the selected project did not change.
  panel.update(projectA); await tick();
  expect(createPdfViewer).toHaveBeenCalledTimes(1);
  expect(host.querySelector('.file-pdf-viewer-host')).toBe(firstHost);
  expect(host.querySelector('.pdf-viewer-mock')).toBe(firstMarker);

  // A directory watcher event also repaints the tree and reloads preview metadata. If the PDF
  // revision is unchanged, neither pass is allowed to tear down the mounted viewer.
  projectFilesChanged?.({ projectId: projectA.id, directory: '' });
  await tick(); await tick();
  expect(createPdfViewer).toHaveBeenCalledTimes(1);
  expect(host.querySelector('.file-pdf-viewer-host')).toBe(firstHost);
  expect(host.querySelector('.pdf-viewer-mock')).toBe(firstMarker);
});

it('remounts the PDF viewer only when the selected PDF revision actually changes', async () => {
  const pdfPreview: ProjectFilePreview = {
    projectId: projectA.id,
    projectName: projectA.name,
    path: 'paper.pdf',
    name: 'paper.pdf',
    bytes: 24,
    modifiedAt: new Date(0).toISOString(),
    binary: true,
    text: null,
    pdfDataBase64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
    truncated: false
  };
  let currentPreview = pdfPreview;
  (window.api.listProjectFiles as any) = vi.fn(() => ok({
    ...rootListing(projectA),
    entries: [{ name: 'paper.pdf', path: 'paper.pdf', kind: 'file', bytes: currentPreview.bytes }]
  }));
  (window.api.previewProjectFile as any) = vi.fn(() => ok(currentPreview));

  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="paper.pdf"]')!.click(); await tick();
  const firstHost = host.querySelector<HTMLElement>('.file-pdf-viewer-host')!;
  expect(createPdfViewer).toHaveBeenCalledTimes(1);

  currentPreview = {
    ...pdfPreview,
    modifiedAt: new Date(1).toISOString(),
    pdfDataBase64: Buffer.from('%PDF-1.4\n% changed\n%%EOF').toString('base64')
  };
  projectFilesChanged?.({ projectId: projectA.id, directory: '' });
  await tick(); await tick();
  expect(createPdfViewer).toHaveBeenCalledTimes(2);
  expect(host.querySelector('.file-pdf-viewer-host')).not.toBe(firstHost);
});

it('keeps the original synchronous vertical resize behavior while a PDF is open', async () => {
  const pdfPreview: ProjectFilePreview = {
    projectId: projectA.id,
    projectName: projectA.name,
    path: 'paper.pdf',
    name: 'paper.pdf',
    bytes: 24,
    modifiedAt: new Date(0).toISOString(),
    binary: true,
    text: null,
    pdfDataBase64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
    truncated: false
  };
  (window.api.listProjectFiles as any) = vi.fn(() => ok({
    ...rootListing(projectA),
    entries: [{ name: 'paper.pdf', path: 'paper.pdf', kind: 'file', bytes: pdfPreview.bytes }]
  }));
  (window.api.previewProjectFile as any) = vi.fn(() => ok(pdfPreview));

  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="paper.pdf"]')!.click(); await tick();

  const previewPane = host.querySelector<HTMLElement>('.file-preview')!;
  const handle = previewPane.querySelector<HTMLElement>('.file-preview-resize')!;
  let captured = false;
  Object.assign(handle, {
    setPointerCapture: () => { captured = true; },
    hasPointerCapture: () => captured,
    releasePointerCapture: () => { captured = false; }
  });
  const pointer = (type: string, y: number) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    return event;
  };

  handle.dispatchEvent(pointer('pointerdown', 300));
  handle.dispatchEvent(pointer('pointermove', 180));
  // PDF-specific fixes must not change the shared preview separator's original immediate drag.
  expect(Number.parseInt(previewPane.style.height, 10)).toBeGreaterThan(200);
  handle.dispatchEvent(pointer('pointerup', 180));
  expect(dom.window.localStorage.getItem('chat-on-steroids.file-preview-height')).toBe(previewPane.style.height.replace('px', ''));
  expect(captured).toBe(false);
  expect(createPdfViewer).toHaveBeenCalledTimes(1);
});

it('drops stale directory results after switching projects', async () => {
  let resolveOld!: (value: any) => void;
  (window.api.listProjectFiles as any) = vi.fn((projectId: string) => {
    if (projectId === projectA.id) return new Promise(resolve => { resolveOld = resolve; });
    return ok(rootListing(projectB));
  });
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await Promise.resolve();
  panel.update(projectB); await tick();
  resolveOld({ ok: true, data: rootListing(projectA) }); await tick();

  expect(host.textContent).toContain('beta');
  expect(host.textContent).not.toContain('alpha');
  expect((window.api.listProjectFiles as any)).toHaveBeenCalledWith(projectB.id, '');
});

it('closes immediately when the selected task no longer has a project', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  expect(panel.visible()).toBe(true);
  expect(host.classList.contains('has-file-panel')).toBe(true);
  panel.update(null);
  expect(panel.visible()).toBe(false);
  expect(toggle.hidden).toBe(true);
  expect(host.classList.contains('has-file-panel')).toBe(false);
});

it('shares the right work slot exclusively with the Sub-agents panel', async () => {
  const agentToggle = document.createElement('button');
  document.body.append(agentToggle);
  let files: ReturnType<typeof createFilePanel>;
  const agents = createAgentPanel({
    host,
    toggle: agentToggle,
    onShow: () => files.hide(),
    load: async () => ({ events: [] }),
    render: () => [],
    openMain: () => undefined,
    working: () => false
  });
  files = createFilePanel({
    host,
    toggle,
    onShow: () => agents.hide(),
    onAttach: () => undefined
  });
  files.update(projectA);
  agents.update('prime-session', [{
    id: 'worker-session', title: 'Worker', conversationId: 'worker-conversation',
    startedAt: 1, updatedAt: 1, endedAt: null, events: 0, agents: ['worker-1'],
    estimatedTokens: 0, contextTokens: 0,
    origin: { kind: 'worker', fromSessionId: 'prime-session', agentId: 'worker-1', task: 'Inspect' }
  } as any]);

  toggle.click(); await tick();
  expect(files.visible()).toBe(true);
  expect(host.classList.contains('has-file-panel')).toBe(true);
  expect(host.classList.contains('has-agent-panel')).toBe(false);

  agentToggle.click(); await tick();
  expect(files.visible()).toBe(false);
  expect(host.classList.contains('has-file-panel')).toBe(false);
  expect(host.classList.contains('has-agent-panel')).toBe(true);

  toggle.click(); await tick();
  expect(files.visible()).toBe(true);
  expect(host.classList.contains('has-file-panel')).toBe(true);
  expect(host.classList.contains('has-agent-panel')).toBe(false);
});

it('gives Files and Sub-agents the same horizontally resizable work-panel width', async () => {
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1200 });
  const agentToggle = document.createElement('button');
  document.body.append(agentToggle);
  const agents = createAgentPanel({
    host, toggle: agentToggle, load: async () => ({ events: [] }), render: () => [],
    openMain: () => undefined, working: () => false
  });
  const files = createFilePanel({ host, toggle, onAttach: () => undefined });
  files.update(projectA);

  const fileHandle = host.querySelector<HTMLElement>('.file-panel .work-panel-resize')!;
  expect(fileHandle.getAttribute('role')).toBe('separator');
  fileHandle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  const width = host.style.getPropertyValue('--work-panel-width');
  expect(width).toMatch(/^\d+px$/);

  agents.update('prime-session', []);
  const agentHandle = host.querySelector<HTMLElement>('.agent-panel .work-panel-resize')!;
  expect(agentHandle.getAttribute('aria-valuenow')).toBe(width.replace('px', ''));
  agentHandle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(host.style.getPropertyValue('--work-panel-width')).not.toBe(width);
});
