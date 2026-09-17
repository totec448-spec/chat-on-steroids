import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFilePanel } from '../src/renderer/file-panel.js';
import { createAgentPanel } from '../src/renderer/agent-panel.js';
import type { LocalProject } from '../src/shared/projects.js';
import type { ProjectDirectoryListing, ProjectFilePreview, ProjectFilesChanged } from '../src/shared/project-files.js';

const createPdfViewer = vi.hoisted(() => vi.fn());
const codeMount = vi.hoisted(() => ({ wait: null as Promise<void> | null, calls: 0 }));
vi.mock('../src/renderer/file-pdf-viewer.js', () => ({ createProjectPdfViewer: createPdfViewer }));
vi.mock('../src/renderer/file-code-editor.js', () => ({
  createProjectCodeEditor: async (options: { parent: HTMLElement; text: string; onChange?: (text: string) => void }) => {
    codeMount.calls++;
    if (codeMount.wait) await codeMount.wait;
    const input = document.createElement('textarea'); input.className = 'test-code-input'; input.value = options.text;
    options.parent.append(input);
    input.addEventListener('input', () => options.onChange?.(input.value));
    return { getValue: () => input.value, focus: () => input.focus(), destroy: () => input.remove(), language: 'Plain text' };
  }
}));

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
  revision: 'a'.repeat(64),
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
  codeMount.wait = null; codeMount.calls = 0;
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
      saveProjectFile: vi.fn((_projectId: string, _path: string, text: string) => ok({ preview: { ...preview, text, revision: 'b'.repeat(64) } })),
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

it('keeps tree focus through directory loading and supports arrow, parent and boundary navigation', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const key = async (key: string) => {
    document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await tick();
  };
  const focusedPath = () => (document.activeElement as HTMLElement).dataset.path;
  host.querySelector<HTMLButtonElement>('[data-path="src"]')!.focus();
  await key('ArrowRight');
  expect(focusedPath()).toBe('src');
  await key('ArrowRight'); expect(focusedPath()).toBe('src/main.ts');
  await key('ArrowLeft'); expect(focusedPath()).toBe('src');
  await key('ArrowLeft'); expect(focusedPath()).toBe('src');
  expect(host.querySelector('[data-path="src/main.ts"]')).toBeNull();
  await key('ArrowDown'); expect(focusedPath()).toBe('README.md');
  projectFilesChanged?.({ projectId: projectA.id, directory: '' }); await tick();
  expect(focusedPath()).toBe('README.md');
  await key('Home'); expect(focusedPath()).toBe('');
  await key('End'); expect(focusedPath()).toBe('README.md');
  expect(host.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1);
  expect(window.api.previewProjectFile).not.toHaveBeenCalled();
});

it.each(['README.md', 'example.ts'])('preserves unchanged %s preview DOM during session and directory refreshes', async name => {
  let value = { ...preview, path: name, name };
  (window.api.listProjectFiles as any) = vi.fn(() => ok({ ...rootListing(), entries: [{ name, path: name, kind: 'file', bytes: 12 }] }));
  (window.api.previewProjectFile as any) = vi.fn(() => ok({ ...value }));
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>(`[data-path="${name}"]`)!.click(); await tick();
  const content = host.querySelector('.file-preview-markdown, .file-code-viewer-host')!;
  const treeRow = host.querySelector(`[data-path="${name}"]`);
  for (let i = 0; i < 10; i++) panel.update({ ...projectA });
  await tick();
  expect(host.querySelector(`[data-path="${name}"]`)).toBe(treeRow);
  expect(host.querySelector('.file-preview-markdown, .file-code-viewer-host')).toBe(content);
  projectFilesChanged?.({ projectId: projectA.id, directory: '' }); await tick(); await tick();
  expect(host.querySelector('.file-preview-markdown, .file-code-viewer-host')).toBe(content);
  value = { ...value, text: '# changed', revision: 'b'.repeat(64) };
  projectFilesChanged?.({ projectId: projectA.id, directory: '' }); await tick(); await tick();
  expect(host.querySelector('.file-preview-markdown, .file-code-viewer-host')).not.toBe(content);
  expect(host.querySelector('.file-preview')?.textContent || host.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBeTruthy();
});

it('lets the preview occupy the panel and restores the tree when it closes', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();
  host.querySelector<HTMLButtonElement>('.file-preview-toggle-tree')!.click();
  expect(host.querySelector('.file-panel-body')?.classList.contains('is-reading')).toBe(true);
  expect(host.querySelector('.file-preview-toggle-tree')?.getAttribute('aria-pressed')).toBe('false');
  host.querySelector<HTMLButtonElement>('.file-preview-close')!.click(); await tick();
  expect(host.querySelector('.file-panel-body')?.classList.contains('is-reading')).toBe(false);
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

it('loads the contents of a newly created expanded folder without waiting for a watch event', async () => {
  let created = false;
  (window.api.listProjectFiles as any) = vi.fn((_projectId: string, directory: string) => ok(directory === 'docs'
    ? { ...rootListing(), directory, entries: [] }
    : { ...rootListing(), entries: [...rootListing().entries, ...(created ? [{ name: 'docs', path: 'docs', kind: 'directory', bytes: null }] : [])] }));
  (window.api.createProjectFileEntry as any) = vi.fn(() => {
    created = true;
    return ok({ projectId: projectA.id, path: 'docs', kind: 'directory' });
  });
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[title="New folder"]')!.click();
  await submitEntryDialog('docs');
  expect(window.api.listProjectFiles).toHaveBeenCalledWith(projectA.id, 'docs');
  expect(host.querySelector('[data-path="docs"]')?.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('.file-tree-status')).toBeNull();
});

it('loads an expanded renamed folder under its new path and retires its old child paths', async () => {
  let name = 'src';
  (window.api.listProjectFiles as any) = vi.fn((_projectId: string, directory: string) => ok(directory === ''
    ? { ...rootListing(), entries: [{ name, path: name, kind: 'directory', bytes: null }] }
    : { ...rootListing(), directory, entries: [{ name: 'main.ts', path: `${directory}/main.ts`, kind: 'file', bytes: 20 }] }));
  (window.api.renameProjectFileEntry as any) = vi.fn(() => {
    name = 'code';
    return ok({ projectId: projectA.id, path: 'code', kind: 'directory' });
  });
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="src"]')!.click(); await tick();
  host.querySelector<HTMLButtonElement>('[title="Rename"]')!.click();
  await submitEntryDialog('code');
  expect(host.querySelector('[data-path="code/main.ts"]')).not.toBeNull();
  expect(host.querySelector('[data-path="src/main.ts"]')).toBeNull();
  expect(host.querySelector('.file-tree-status')).toBeNull();
  expect(window.api.watchProjectFiles).toHaveBeenLastCalledWith(projectA.id, ['', 'code']);
});

it('keeps one compact toolbar and closes through the Files toggle', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();

  const disclosure = host.querySelector<HTMLElement>('[data-path="src"] .file-tree-disclosure')!;
  expect(disclosure.textContent).toBe('');
  expect(disclosure.getAttribute('aria-hidden')).toBe('true');
  expect(host.querySelector('.file-panel-header')).toBeNull();
  expect(host.querySelector('.file-panel-close')).toBeNull();
  expect(host.querySelector('.file-panel-toolbar .file-panel-refresh')).not.toBeNull();
  toggle.click(); await tick();
  expect(host.querySelector<HTMLElement>('.file-panel')!.hidden).toBe(true);
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

async function editFile(): Promise<HTMLTextAreaElement> {
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();
  host.querySelector<HTMLButtonElement>('[title="Edit"]')!.click(); await tick();
  return host.querySelector<HTMLTextAreaElement>('.test-code-input')!;
}
function typeEdit(input: HTMLTextAreaElement, text: string): void {
  input.value = text; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

it.each(['New file', 'New folder'])('protects the active draft before %s changes selection', async label => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const input = await editFile(); typeEdit(input, 'keep this draft');
  host.querySelector<HTMLButtonElement>(`[title="${label}"]`)!.click(); await tick();
  expect(document.querySelector('.file-confirm-dialog')).not.toBeNull();
  expect(document.querySelector('.file-entry-dialog')).toBeNull();
  document.querySelector<HTMLButtonElement>('.file-confirm-dialog .btn')!.click(); await tick();
  expect(host.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBe('keep this draft');
  expect(window.api.createProjectFileEntry).not.toHaveBeenCalled();

  host.querySelector<HTMLButtonElement>(`[title="${label}"]`)!.click(); await tick();
  document.querySelector<HTMLButtonElement>('.file-confirm-dialog .file-dialog-danger')!.click(); await tick();
  expect(document.querySelector('.file-entry-dialog')).not.toBeNull();
});

it('retains an unsaved editor draft through a project A-B-A round trip', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const input = await editFile(); typeEdit(input, 'my unsaved changes');
  panel.update(projectB); await tick();
  panel.update(projectA); await tick(); await tick();
  expect(host.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBe('my unsaved changes');
  expect(host.querySelector<HTMLButtonElement>('.file-editor-save')?.disabled).toBe(false);
});

it('keeps edits typed while a save is pending and ignores a duplicate save', async () => {
  let finish!: (value: unknown) => void;
  (window.api.saveProjectFile as any) = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const input = await editFile(); typeEdit(input, 'first draft');
  const save = host.querySelector<HTMLButtonElement>('.file-editor-save')!; save.click(); await tick();
  typeEdit(input, 'newer draft');
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  expect(window.api.saveProjectFile).toHaveBeenCalledTimes(1);
  finish({ ok: true, data: { preview: { ...preview, text: 'first draft', revision: 'b'.repeat(64) } } }); await tick();
  expect(host.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBe('newer draft');
  expect(save.disabled).toBe(false);
});

it('does not overwrite edits typed while a watcher preview read is in flight', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const input = await editFile();
  let finish!: (value: unknown) => void;
  (window.api.previewProjectFile as any) = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  projectFilesChanged?.({ projectId: projectA.id, directory: '' }); await tick();
  typeEdit(input, 'typed during read');
  finish({ ok: true, data: { ...preview, text: 'external revision', revision: 'b'.repeat(64) } }); await tick();
  expect(host.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBe('typed during read');
});

it('captures attachment delivery before staging rather than after a chat switch', async () => {
  let currentChat = 'a'; const delivered: string[] = [];
  let finish!: (value: unknown) => void;
  (window.api.attachProjectFile as any) = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const panel = createFilePanel({ host, toggle, captureAttachment: () => {
    const owner = currentChat;
    return () => { if (owner !== currentChat) return false; delivered.push(owner); return true; };
  } });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();
  host.querySelector<HTMLButtonElement>('[title="Attach"]')!.click(); await tick();
  currentChat = 'b'; panel.update(projectA);
  finish({ ok: true, data: { id: 'file-1', name: 'README.md', size: 12, mimeType: 'text/markdown' } }); await tick();
  expect(delivered).toEqual([]);
});

it('cancels a stale name dialog after a project A-B-A round trip', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[title="New file"]')!.click();
  panel.update(projectB); panel.update(projectA); await tick();
  await submitEntryDialog('stale.txt');
  expect(window.api.createProjectFileEntry).not.toHaveBeenCalled();
});

it('expands the work panel beyond 60 percent while retaining space for chat', () => {
  host.getBoundingClientRect = () => ({ width: 2200 } as DOMRect);
  createFilePanel({ host, toggle, onAttach: () => undefined });
  const handle = host.querySelector<HTMLElement>('.work-panel-resize')!;
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End' }));
  expect(host.style.getPropertyValue('--work-panel-width')).toBe('1840px');
  expect(Number(handle.getAttribute('aria-valuenow'))).toBeGreaterThan(2200 * .6);
  host.getBoundingClientRect = () => ({ width: 1000 } as DOMRect);
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  expect(host.style.getPropertyValue('--work-panel-width')).toBe('640px');
});

it('keeps the previous preview during a pending file read and ignores a superseded read', async () => {
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  const row = host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!;
  row.click(); await tick();
  const surface = host.querySelector('.file-preview-markdown');
  let complete!: (value: any) => void;
  window.api.previewProjectFile = vi.fn(() => new Promise<{ ok: true; data: ProjectFilePreview }>(resolve => { complete = resolve; }));
  row.click(); await tick();
  expect(host.querySelector('.file-preview-markdown')).toBe(surface);
  expect(host.textContent).not.toContain('Loading preview');
  host.querySelector<HTMLButtonElement>('[data-path="src"]')!.click(); await tick();
  complete({ ok: true, data: { ...preview, text: '# stale' } }); await tick();
  expect(host.querySelector<HTMLElement>('.file-preview')!.hidden).toBe(true);
});


it('does not restart a pending code mount when the directory watcher refreshes', async () => {
  const code = { ...preview, path: 'README.md', name: 'example.ts', text: 'const answer = 42;' };
  window.api.previewProjectFile = vi.fn(() => ok(code));
  let release!: () => void;
  codeMount.wait = new Promise<void>(resolve => { release = resolve; });
  const panel = createFilePanel({ host, toggle, onAttach: () => undefined });
  panel.update(projectA); toggle.click(); await tick();
  host.querySelector<HTMLButtonElement>('[data-path="README.md"]')!.click(); await tick();
  expect(codeMount.calls).toBe(1);
  projectFilesChanged?.({ projectId: projectA.id, directory: '' } as ProjectFilesChanged); await tick();
  expect(codeMount.calls).toBe(1);
  release(); await tick();
  expect(host.querySelector<HTMLTextAreaElement>('.test-code-input')?.value).toBe(code.text);
});
