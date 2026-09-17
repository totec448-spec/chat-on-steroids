import type { InputAttachment } from '../shared/input.js';
import type { LocalProject } from '../shared/projects.js';
import type { ProjectDirectoryListing, ProjectFileEntry, ProjectFileKind, ProjectFilePreview, ProjectFilesChanged } from '../shared/project-files.js';
import { safeExternalLink } from '../shared/external-link.js';
import { marked } from 'marked';
import { t, ui } from './i18n.js';
import { el, icon, run, toast } from './dom.js';
import { attachWorkPanelResize } from './work-panel-resize.js';
import type { ProjectCodeEditor } from './file-code-editor.js';
import type { ProjectPdfViewer } from './file-pdf-viewer.js';

interface FilePanelOptions {
  host: HTMLElement;
  toggle: HTMLButtonElement;
  onShow?: () => void;
  onAttach?: (attachment: InputAttachment) => void;
  /** Capture the current composer owner before staging starts, including its draft epoch. */
  captureAttachment?: () => (attachment: InputAttachment) => boolean;
}

interface Selection {
  path: string;
  kind: ProjectFileKind | 'root';
}

const PREVIEW_HEIGHT_KEY = 'chat-on-steroids.file-preview-height';
const PREVIEW_MIN_HEIGHT = 140;
const MARKDOWN_TAGS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'KBD', 'LI', 'OL', 'P', 'PRE', 'S', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TFOOT',
  'TH', 'THEAD', 'TR', 'UL'
]);
const DROP_MARKDOWN_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'META', 'LINK', 'IMG', 'VIDEO', 'AUDIO', 'SOURCE'
]);

function parentPath(relative: string): string {
  const at = relative.lastIndexOf('/');
  return at < 0 ? '' : relative.slice(0, at);
}

function baseName(relative: string): string {
  const at = relative.lastIndexOf('/');
  return at < 0 ? relative : relative.slice(at + 1);
}

// IPC supplies fresh objects even when the file did not change. All preview fields
// are primitives, including bounded content; compare the complete projection rather
// than timestamps or encoded lengths (which can miss same-size replacements).
function samePreview(a: ProjectFilePreview | null, b: ProjectFilePreview | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof ProjectFilePreview)[];
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function markdownPreview(source: string): HTMLElement {
  const root = el('div', 'file-preview-markdown');
  const template = document.createElement('template');
  template.innerHTML = marked.parse(source, { async: false, gfm: true });

  const visit = (parent: ParentNode): void => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      const tag = element.tagName.toUpperCase();
      if (DROP_MARKDOWN_TAGS.has(tag)) {
        element.remove();
        continue;
      }
      visit(element);
      if (!MARKDOWN_TAGS.has(tag)) {
        element.replaceWith(...element.childNodes);
        continue;
      }
      const href = tag === 'A' ? element.getAttribute('href')?.trim() ?? '' : '';
      const safeHref = href.startsWith('#') ? href : safeExternalLink(href) ? href : '';
      const title = element.getAttribute('title');
      const start = tag === 'OL' ? element.getAttribute('start') : null;
      const colSpan = tag === 'TD' || tag === 'TH' ? element.getAttribute('colspan') : null;
      const rowSpan = tag === 'TD' || tag === 'TH' ? element.getAttribute('rowspan') : null;
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      if (safeHref) {
        element.setAttribute('href', safeHref);
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noreferrer noopener');
      }
      if (title) element.setAttribute('title', title.slice(0, 500));
      if (start && /^\d{1,6}$/.test(start)) element.setAttribute('start', start);
      if (colSpan && /^\d{1,3}$/.test(colSpan)) element.setAttribute('colspan', colSpan);
      if (rowSpan && /^\d{1,3}$/.test(rowSpan)) element.setAttribute('rowspan', rowSpan);
    }
  };
  visit(template.content);
  root.append(template.content);
  for (const table of root.querySelectorAll('table')) {
    const viewport = el('div', 'file-preview-markdown-table');
    viewport.tabIndex = 0;
    table.replaceWith(viewport);
    viewport.append(table);
  }
  root.addEventListener('click', event => {
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!anchor || !root.contains(anchor)) return;
    const href = anchor.getAttribute('href') ?? '';
    event.preventDefault();
    if (href.startsWith('#')) {
      const id = href.slice(1);
      [...root.querySelectorAll<HTMLElement>('[id]')].find(node => node.id === id)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (safeExternalLink(href)) void run(window.api.openLink(href));
  });
  return root;
}

function actionButton(label: () => string, glyph: string, action: () => void | Promise<void>): HTMLButtonElement {
  const button = el('button', 'btn file-panel-action') as HTMLButtonElement;
  button.type = 'button';
  button.append(icon(glyph), el('span', '', label));
  ui(button, 'title', label);
  button.addEventListener('click', () => void action());
  return button;
}

function requestEntryName(options: { title: string; initial?: string; confirm: string }): Promise<string | null> {
  document.querySelector('.file-entry-dialog')?.remove();
  return new Promise(resolve => {
    const box = document.createElement('dialog');
    box.className = 'file-entry-dialog';
    const form = document.createElement('form');
    form.className = 'file-entry-dialog-form';
    form.noValidate = true;
    const heading = el('h2', '', options.title);
    const label = el('label', 'file-entry-dialog-field');
    const input = document.createElement('input');
    input.className = 'file-entry-dialog-input';
    input.type = 'text';
    input.maxLength = 255;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = options.initial ?? '';
    label.append(el('span', '', () => t('Name')), input);
    const actions = el('div', 'file-entry-dialog-actions');
    const cancel = el('button', 'btn', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button';
    const confirm = el('button', 'btn btn-solid', options.confirm) as HTMLButtonElement;
    confirm.type = 'submit';
    actions.append(cancel, confirm);
    form.append(heading, label, actions);
    box.append(form);
    document.body.append(box);

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      box.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    box.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    input.addEventListener('input', () => input.setCustomValidity(''));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
        input.setCustomValidity(t('Use one file or folder name.'));
        input.reportValidity();
        return;
      }
      finish(value);
    });

    if (typeof box.showModal === 'function') box.showModal();
    else box.setAttribute('open', '');
    input.focus();
    input.select();
  });
}

function requestFileConfirmation(options: { title: string; message: string; detail?: string; confirm: string }): Promise<boolean> {
  document.querySelector('.file-confirm-dialog')?.remove();
  return new Promise(resolve => {
    const box = document.createElement('dialog');
    box.className = 'file-confirm-dialog';
    const body = el('div', 'file-confirm-dialog-body');
    body.append(el('h2', '', options.title), el('p', 'file-confirm-dialog-message', options.message));
    if (options.detail) body.append(el('p', 'file-confirm-dialog-detail', options.detail));
    const actions = el('div', 'file-entry-dialog-actions');
    const cancel = el('button', 'btn', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button';
    const confirm = el('button', 'btn btn-solid file-dialog-danger', options.confirm) as HTMLButtonElement;
    confirm.type = 'button';
    actions.append(cancel, confirm);
    body.append(actions);
    box.append(body);
    document.body.append(box);

    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      box.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    box.addEventListener('cancel', event => { event.preventDefault(); finish(false); });

    if (typeof box.showModal === 'function') box.showModal();
    else box.setAttribute('open', '');
    confirm.focus();
  });
}

/**
 * Project-scoped file explorer. It never receives native paths; all operations name one
 * LocalProject id plus a project-relative path and main re-resolves the filesystem authority.
 */
export function createFilePanel(options: FilePanelOptions) {
  const pane = el('aside', 'file-panel'); pane.hidden = true;
  ui(pane, 'aria-label', () => t('Files'));
  attachWorkPanelResize(options.host, pane);

  const refresh = el('button', 'btn btn-icon file-panel-refresh') as HTMLButtonElement;
  refresh.type = 'button'; refresh.append(icon('i-pulse'));
  ui(refresh, 'title', () => t('Refresh files')); ui(refresh, 'aria-label', () => t('Refresh files'));

  const toolbar = el('div', 'file-panel-toolbar');
  const newFile = actionButton(() => t('New file'), 'i-plus', () => createEntry('file'));
  const newFolder = actionButton(() => t('New folder'), 'i-folder', () => createEntry('directory'));
  const rename = actionButton(() => t('Rename'), 'i-pencil', renameSelection);
  const remove = actionButton(() => t('Delete'), 'i-trash', deleteSelection);
  const reveal = actionButton(() => t('Reveal'), 'i-out', revealSelection);
  toolbar.append(newFile, newFolder, rename, remove, reveal, refresh);

  const body = el('div', 'file-panel-body');
  const tree = el('div', 'file-tree'); tree.setAttribute('role', 'tree');
  const preview = el('section', 'file-preview'); preview.hidden = true;
  const previewResize = el('div', 'file-preview-resize');
  previewResize.tabIndex = 0;
  previewResize.setAttribute('role', 'separator');
  previewResize.setAttribute('aria-orientation', 'horizontal');
  previewResize.setAttribute('aria-label', 'Resize file preview');
  body.append(tree, preview);
  pane.append(toolbar, body); options.host.append(pane);

  let project: LocalProject | null = null;
  let generation = 0;
  let selection: Selection = { path: '', kind: 'root' };
  let previewPath: string | null = null;
  let previewValue: ProjectFilePreview | null = null;
  let renderedPreview: ProjectFilePreview | null = null;
  let pendingCodePreview: ProjectFilePreview | null = null;
  let codeEditor: ProjectCodeEditor | null = null;
  let codeViewer: ProjectCodeEditor | null = null;
  let pdfViewer: ProjectPdfViewer | null = null;
  let pdfAbort: AbortController | null = null;
  let pdfSurfaceRevision: string | null = null;
  let editingPath: string | null = null;
  let editorOriginalText = '';
  let editorDraft = '';
  let editorDirty = false;
  let editorExternalChange = false;
  let editorMountToken = 0;
  let viewerMountToken = 0;
  let pdfMountToken = 0;
  let editorSaveButton: HTMLButtonElement | null = null;
  let editorDirtyBadge: HTMLElement | null = null;
  let saving = false;
  const retainedDrafts = new Map<string, { preview: ProjectFilePreview & { text: string; revision: string }; text: string }>();
  let expanded = new Set<string>(['']);
  const listings = new Map<string, ProjectDirectoryListing>();
  let watchSignature = '';
  let previewHeight: number | null = null;
  try {
    const saved = Number(window.localStorage.getItem(PREVIEW_HEIGHT_KEY));
    if (Number.isFinite(saved) && saved >= PREVIEW_MIN_HEIGHT) previewHeight = saved;
  } catch { /* Layout persistence is optional. */ }

  function previewMaximum(): number {
    const height = body.getBoundingClientRect().height || body.clientHeight || 400;
    return Math.max(PREVIEW_MIN_HEIGHT, height - 36);
  }

  function currentPreviewHeight(): number {
    if (previewHeight !== null) return previewHeight;
    const measured = preview.getBoundingClientRect().height;
    if (measured > 0) return measured;
    const height = body.getBoundingClientRect().height || body.clientHeight || 400;
    return Math.max(PREVIEW_MIN_HEIGHT, height * 0.52);
  }

  function setPreviewHeight(height: number, persist = false): void {
    previewHeight = Math.round(Math.max(PREVIEW_MIN_HEIGHT, Math.min(previewMaximum(), height)));
    preview.style.height = `${previewHeight}px`;
    previewResize.setAttribute('aria-valuemin', String(PREVIEW_MIN_HEIGHT));
    previewResize.setAttribute('aria-valuemax', String(Math.round(previewMaximum())));
    previewResize.setAttribute('aria-valuenow', String(previewHeight));
    if (persist) {
      try { window.localStorage.setItem(PREVIEW_HEIGHT_KEY, String(previewHeight)); } catch { /* optional */ }
    }
  }

  function resetPreviewHeight(): void {
    previewHeight = null;
    preview.style.removeProperty('height');
    try { window.localStorage.removeItem(PREVIEW_HEIGHT_KEY); } catch { /* optional */ }
    const bodyHeight = body.getBoundingClientRect().height || body.clientHeight || 400;
    const fallback = Math.round(Math.max(PREVIEW_MIN_HEIGHT, Math.min(previewMaximum(), bodyHeight * 0.52)));
    previewResize.setAttribute('aria-valuemin', String(PREVIEW_MIN_HEIGHT));
    previewResize.setAttribute('aria-valuemax', String(Math.round(previewMaximum())));
    previewResize.setAttribute('aria-valuenow', String(fallback));
  }

  function replacePreview(...nodes: Node[]): void {
    renderedPreview = null;
    preview.replaceChildren(previewResize, ...nodes);
  }

  function destroyCodeEditor(): void {
    editorMountToken++;
    codeEditor?.destroy();
    codeEditor = null;
    editorSaveButton = null;
    editorDirtyBadge = null;
    preview.classList.remove('is-editing');
  }

  function destroyCodeViewer(): void {
    pendingCodePreview = null;
    renderedPreview = null;
    viewerMountToken++;
    codeViewer?.destroy();
    codeViewer = null;
  }

  function destroyPdfViewer(): void {
    renderedPreview = null;
    pdfMountToken++;
    pdfAbort?.abort(); pdfAbort = null;
    pdfViewer?.destroy();
    pdfViewer = null;
    pdfSurfaceRevision = null;
  }

  function pdfPreviewRevision(value: ProjectFilePreview): string | null {
    return value.pdfDataBase64
      ? `${value.path}\0${value.modifiedAt}\0${value.bytes}\0${value.pdfDataBase64.length}`
      : null;
  }

  function clearEditorState(): void {
    destroyCodeEditor();
    editingPath = null;
    editorOriginalText = '';
    editorDraft = '';
    editorDirty = false;
    editorExternalChange = false;
  }

  function updateEditorDirtyState(): void {
    if (editorSaveButton) editorSaveButton.disabled = !editorDirty || saving;
    if (editorDirtyBadge) {
      editorDirtyBadge.hidden = !editorDirty;
      editorDirtyBadge.classList.toggle('is-conflict', editorExternalChange);
      editorDirtyBadge.title = editorDirty
        ? editorExternalChange ? t('Unsaved changes · file changed on disk') : t('Unsaved changes')
        : '';
    }
  }

  function markEditorExternalChange(): void {
    if (editorExternalChange) return;
    editorExternalChange = true;
    updateEditorDirtyState();
    toast(t('This file changed on disk while you were editing it. Your unsaved edits were kept.'));
  }

  function editablePreview(value: ProjectFilePreview): value is ProjectFilePreview & { text: string; revision: string } {
    return !value.binary && value.text !== null && !value.truncated && typeof value.revision === 'string';
  }

  async function leaveEditorIfNeeded(): Promise<boolean> {
    if (!editingPath) return true;
    const token = editorMountToken, owner = project?.id;
    if (editorDirty) {
      const discard = await requestFileConfirmation({
        title: t('Discard changes?'),
        message: t('Your edits to “{0}” have not been saved.', [baseName(editingPath)]),
        detail: t('Discard these edits and continue?'),
        confirm: t('Discard')
      });
      if (!discard || token !== editorMountToken || owner !== project?.id) return false;
    }
    if (owner) retainedDrafts.delete(owner);
    clearEditorState();
    return true;
  }

  let previewDrag: { id: number; y: number; height: number } | null = null;
  previewResize.addEventListener('pointerdown', event => {
    if (event.button !== 0 || previewDrag) return;
    previewResize.setPointerCapture(event.pointerId);
    previewDrag = { id: event.pointerId, y: event.clientY, height: currentPreviewHeight() };
    pane.classList.add('is-resizing-file-preview');
    event.preventDefault();
  });
  previewResize.addEventListener('pointermove', event => {
    if (previewDrag?.id !== event.pointerId) return;
    setPreviewHeight(previewDrag.height + previewDrag.y - event.clientY);
  });
  const finishPreviewResize = (event: PointerEvent): void => {
    if (previewDrag?.id !== event.pointerId) return;
    previewDrag = null;
    pane.classList.remove('is-resizing-file-preview');
    if (previewResize.hasPointerCapture(event.pointerId)) previewResize.releasePointerCapture(event.pointerId);
    setPreviewHeight(currentPreviewHeight(), true);
  };
  previewResize.addEventListener('pointerup', finishPreviewResize);
  previewResize.addEventListener('pointercancel', finishPreviewResize);
  previewResize.addEventListener('lostpointercapture', finishPreviewResize);
  previewResize.addEventListener('dblclick', resetPreviewHeight);
  previewResize.addEventListener('keydown', event => {
    const height = currentPreviewHeight();
    if (event.key === 'ArrowUp') setPreviewHeight(height + 20, true);
    else if (event.key === 'ArrowDown') setPreviewHeight(height - 20, true);
    else if (event.key === 'Home') setPreviewHeight(PREVIEW_MIN_HEIGHT, true);
    else if (event.key === 'End') setPreviewHeight(previewMaximum(), true);
    else return;
    event.preventDefault();
  });
  const clampPreviewHeight = () => { if (previewHeight !== null) setPreviewHeight(previewHeight); };
  if (typeof ResizeObserver === 'function') new ResizeObserver(clampPreviewHeight).observe(body);
  window.addEventListener('resize', clampPreviewHeight);
  resetPreviewHeight();

  function hide(): void {
    generation++;
    destroyPdfViewer();
    pane.hidden = true;
    options.host.classList.remove('has-file-panel');
    options.toggle.setAttribute('aria-expanded', 'false');
    syncWatches();
  }

  async function show(): Promise<void> {
    if (!project) return;
    options.onShow?.();
    pane.hidden = false;
    options.host.classList.add('has-file-panel');
    options.toggle.setAttribute('aria-expanded', 'true');
    if (!listings.has('')) await loadDirectory('');
    else render();
    const draft = project && retainedDrafts.get(project.id);
    if (draft && !editingPath) {
      selection = { path: draft.preview.path, kind: 'file' };
      previewPath = draft.preview.path; previewValue = draft.preview;
      await startEditing(draft.preview, draft.text);
    }
  }

  function selectedDirectory(): string {
    return selection.kind === 'directory' || selection.kind === 'root' ? selection.path : parentPath(selection.path);
  }

  function updateActions(): void {
    const mutable = Boolean(project) && selection.path !== '' && (selection.kind === 'file' || selection.kind === 'directory');
    rename.disabled = !mutable;
    remove.disabled = !mutable;
    reveal.disabled = !project;
    newFile.disabled = !project || (selection.kind !== 'root' && selection.kind !== 'directory' && selection.kind !== 'file');
    newFolder.disabled = newFile.disabled;
  }

  async function loadDirectory(relative: string, expectedGeneration = generation): Promise<void> {
    const current = project;
    if (!current) return;
    const listing = await run(window.api.listProjectFiles(current.id, relative));
    if (!listing || expectedGeneration !== generation || project?.id !== current.id) return;
    listings.set(relative, listing);
    render();
  }

  function forgetDirectory(relative: string): void {
    for (const key of listings.keys()) if (key === relative || key.startsWith(`${relative}/`)) listings.delete(key);
    for (const key of expanded) if (key === relative || key.startsWith(`${relative}/`)) expanded.delete(key);
  }

  async function toggleDirectory(entry: ProjectFileEntry): Promise<void> {
    if (editingPath && !(await leaveEditorIfNeeded())) return;
    selection = { path: entry.path, kind: 'directory' };
    previewPath = null; previewValue = null;
    if (expanded.has(entry.path)) {
      forgetDirectory(entry.path);
      render();
      return;
    }
    if (expanded.size >= 128) { toast(t('Collapse a folder before expanding more folders.')); return; }
    expanded.add(entry.path);
    render();
    if (!listings.has(entry.path)) await loadDirectory(entry.path);
  }

  async function selectFile(entry: ProjectFileEntry): Promise<void> {
    if (entry.path === editingPath) return;
    if (editingPath) {
      if (!(await leaveEditorIfNeeded())) return;
      renderPreview();
    }
    if (entry.kind !== 'file' || !project) {
      selection = { path: entry.path, kind: entry.kind };
      previewPath = null; previewValue = null; render(); return;
    }
    const request = ++generation;
    const current = project;
    const previousSelection = selection;
    // Keep the last accepted file visible until the replacement is available. No
    // intermediate empty/loading panel, and no old response after newer navigation.
    const value = await run(window.api.previewProjectFile(current.id, entry.path));
    if (!value || request !== generation || project?.id !== current.id || selection !== previousSelection || editingPath) return;
    selection = { path: entry.path, kind: entry.kind };
    previewValue = value; previewPath = entry.path;
    render();
  }

  function treeRow(entry: ProjectFileEntry, depth: number): HTMLElement {
    const row = el('button', `file-tree-row${selection.path === entry.path ? ' is-selected' : ''}`) as HTMLButtonElement;
    row.type = 'button'; row.dataset.path = entry.path; row.dataset.kind = entry.kind;
    row.style.setProperty('--file-depth', String(depth));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 2));
    row.setAttribute('aria-selected', String(selection.path === entry.path));
    row.tabIndex = selection.path === entry.path ? 0 : -1;
    if (entry.kind === 'directory') row.setAttribute('aria-expanded', String(expanded.has(entry.path)));
    const disclosure = el('span', `file-tree-disclosure${entry.kind === 'directory' && expanded.has(entry.path) ? ' is-open' : ''}`);
    disclosure.setAttribute('aria-hidden', 'true');
    row.append(disclosure, icon(entry.kind === 'directory' ? 'i-folder' : entry.kind === 'file' ? 'i-file' : 'i-ban', 'file-tree-icon'));
    row.append(el('span', 'file-tree-name', entry.name));
    if (entry.kind === 'file' && entry.bytes !== null) row.append(el('span', 'file-tree-size', humanBytes(entry.bytes)));
    row.title = entry.path;
    row.addEventListener('click', () => void (entry.kind === 'directory' ? toggleDirectory(entry) : selectFile(entry)));
    return row;
  }

  function appendDirectory(target: DocumentFragment | HTMLElement, relative: string, depth: number): void {
    const listing = listings.get(relative);
    if (!listing) {
      if (expanded.has(relative)) target.append(el('div', 'file-tree-status', () => t('Loading…')));
      return;
    }
    for (const entry of listing.entries) {
      target.append(treeRow(entry, depth));
      if (entry.kind === 'directory' && expanded.has(entry.path)) appendDirectory(target, entry.path, depth + 1);
    }
    if (listing.truncated) target.append(el('div', 'file-tree-status', () => t('This folder has more items than the explorer can show at once.')));
  }

  function renderTree(): void {
    const focused = tree.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.path : undefined;
    tree.replaceChildren();
    if (!project) {
      tree.append(el('p', 'meta', () => t('Files is available only for chats in a local project.')));
      return;
    }
    const root = el('button', `file-tree-root${selection.path === '' ? ' is-selected' : ''}`) as HTMLButtonElement;
    root.type = 'button'; root.setAttribute('role', 'treeitem'); root.setAttribute('aria-expanded', 'true');
    root.dataset.path = ''; root.dataset.kind = 'root';
    root.setAttribute('aria-level', '1'); root.setAttribute('aria-selected', String(selection.path === ''));
    root.tabIndex = selection.path === '' ? 0 : -1;
    root.append(icon('i-folder', 'file-tree-icon'), el('strong', 'file-tree-name', project.name));
    root.title = project.path;
    root.onclick = () => void (async () => {
      if (editingPath && !(await leaveEditorIfNeeded())) return;
      selection = { path: '', kind: 'root' }; previewPath = null; previewValue = null; render();
    })();
    tree.append(root);
    const fragment = document.createDocumentFragment(); appendDirectory(fragment, '', 0); tree.append(fragment);
    const rows = [...tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
    if (!rows.some(row => row.tabIndex === 0)) root.tabIndex = 0;
    if (focused !== undefined) {
      let path = focused;
      while (!rows.some(row => row.dataset.path === path) && path) path = parentPath(path);
      rows.find(row => row.dataset.path === path)?.focus({ preventScroll: true });
    }
  }

  tree.addEventListener('focusin', event => {
    const row = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="treeitem"]');
    if (!row) return;
    for (const item of tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')) item.tabIndex = item === row ? 0 : -1;
  });
  tree.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const rows = [...tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
    const row = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="treeitem"]');
    if (!row) return;
    const index = rows.indexOf(row);
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowDown') next = rows[Math.min(index + 1, rows.length - 1)];
    else if (event.key === 'ArrowUp') next = rows[Math.max(0, index - 1)];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows.at(-1);
    else if (event.key === 'ArrowRight') {
      if (row.getAttribute('aria-expanded') === 'false') row.click();
      else if (row.hasAttribute('aria-expanded')) next = rows[index + 1];
    } else if (event.key === 'ArrowLeft') {
      if (row.dataset.kind === 'directory' && row.getAttribute('aria-expanded') === 'true') row.click();
      else next = rows.find(item => item.dataset.path === parentPath(row.dataset.path ?? ''));
    } else return;
    event.preventDefault();
    next?.focus();
  });

  async function closePreview(): Promise<void> {
    if (editingPath && !(await leaveEditorIfNeeded())) return;
    generation++;
    previewPath = null;
    previewValue = null;
    renderPreview();
  }

  function previewCloseButton(): HTMLButtonElement {
    const button = actionButton(() => t('Close preview'), 'i-x', closePreview);
    button.classList.add('file-preview-close');
    return button;
  }

  function previewTreeButton(): HTMLButtonElement {
    const button = actionButton(() => t('Files'), 'i-folder', () => {
      body.classList.toggle('is-reading');
      button.setAttribute('aria-pressed', String(!body.classList.contains('is-reading')));
    });
    button.classList.add('file-preview-toggle-tree');
    button.setAttribute('aria-pressed', String(!body.classList.contains('is-reading')));
    return button;
  }

  function viewerHeader(value: ProjectFilePreview): HTMLElement {
    const head = el('div', 'file-preview-head');
    const nameWrap = el('div', 'file-preview-title');
    const name = el('strong', '', value.name); name.title = value.path;
    nameWrap.append(name);
    const actions = el('div', 'file-preview-actions');
    actions.append(previewTreeButton());
    if (editablePreview(value)) {
      actions.append(actionButton(() => t('Edit'), 'i-pencil', () => startEditing(value)));
    }
    const attach = actionButton(() => t('Attach'), 'i-plus', async () => {
      const expected = generation, current = project;
      if (!current) return;
      const deliver: ((attachment: InputAttachment) => unknown) | undefined = options.captureAttachment?.() ?? options.onAttach;
      const attachment = await run(window.api.attachProjectFile(current.id, value.path));
      if (!attachment || expected !== generation || project?.id !== current.id) return;
      if (deliver?.(attachment) !== false) toast(t('{0} attached', [attachment.name]));
    });
    const copy = actionButton(() => t('Copy path'), 'i-copy', async () => {
      if (await run(window.api.writeClipboard(value.path))) toast(t('Path copied'));
    });
    actions.append(attach, copy, previewCloseButton());
    head.append(nameWrap, actions);
    return head;
  }

  async function stopEditing(): Promise<void> {
    if (!(await leaveEditorIfNeeded())) return;
    renderPreview();
  }

  async function saveEditing(): Promise<void> {
    const current = project;
    const value = previewValue;
    if (saving || !current || !value || editingPath !== value.path || !editablePreview(value) || !editorDirty) return;
    const draft = codeEditor?.getValue() ?? editorDraft;
    const token = editorMountToken;
    saving = true; updateEditorDirtyState();
    try {
      const saved = await run(window.api.saveProjectFile(current.id, value.path, draft, value.modifiedAt, value.bytes, value.revision));
      if (!saved) return;
      const retained = retainedDrafts.get(current.id);
      if (retained?.preview.revision === value.revision && editablePreview(saved.preview)) {
        if (retained.text === draft) retainedDrafts.delete(current.id);
        else retained.preview = saved.preview;
      }
      if (token !== editorMountToken || project?.id !== current.id || previewPath !== value.path) return;
      retainedDrafts.delete(current.id);
      previewValue = saved.preview;
      editorOriginalText = saved.preview.text ?? draft;
      editorDraft = codeEditor?.getValue() ?? editorDraft;
      editorDirty = editorDraft !== editorOriginalText;
      editorExternalChange = false;
      if (!editorDirty) clearEditorState();
      toast(t('Saved {0}', [saved.preview.name]));
      renderPreview();
      await reloadDirectory(parentPath(saved.preview.path));
    } finally {
      saving = false;
      updateEditorDirtyState();
    }
  }

  async function startEditing(value: ProjectFilePreview, draft = value.text ?? ''): Promise<void> {
    if (!editablePreview(value) || previewPath !== value.path || selection.path !== value.path) return;
    if (!project || (!retainedDrafts.has(project.id) && retainedDrafts.size >= 8)) {
      toast(t('Save or discard an existing project draft before editing another project.')); return;
    }
    destroyCodeViewer();
    clearEditorState();
    editingPath = value.path;
    editorOriginalText = value.text;
    editorDraft = draft;
    editorDirty = draft !== value.text;
    editorExternalChange = false;
    preview.classList.add('is-editing');
    preview.hidden = false;

    const head = el('div', 'file-preview-head');
    const titleWrap = el('div', 'file-preview-title');
    const name = el('strong', '', value.name); name.title = value.path;
    const dirty = el('span', 'file-editor-dirty', '●'); dirty.hidden = true;
    ui(dirty, 'aria-label', () => t('Unsaved changes'));
    editorDirtyBadge = dirty;
    titleWrap.append(name, dirty);
    const actions = el('div', 'file-preview-actions');
    const save = actionButton(() => t('Save'), 'i-check', saveEditing);
    save.classList.add('file-editor-save');
    save.disabled = true;
    editorSaveButton = save;
    const view = actionButton(() => t('View'), 'i-eye', stopEditing);
    actions.append(save, view, previewTreeButton(), previewCloseButton());
    head.append(titleWrap, actions);

    const languageLabel = el('span', 'file-editor-language', () => t('Detecting language…'));
    const meta = el('div', 'file-preview-meta file-editor-meta');
    meta.append(el('span', '', `${value.path} · ${humanBytes(value.bytes)}`), languageLabel);
    const editorHost = el('div', 'file-code-editor-host');
    replacePreview(head, meta, editorHost);

    const token = ++editorMountToken;
    const module = await import('./file-code-editor.js');
    if (token !== editorMountToken || editingPath !== value.path || previewPath !== value.path) return;
    const created = await module.createProjectCodeEditor({
      parent: editorHost,
      filename: value.name,
      text: draft,
      onChange: draft => {
        if (editingPath !== value.path) return;
        editorDraft = draft;
        editorDirty = draft !== editorOriginalText;
        updateEditorDirtyState();
      }
    });
    if (token !== editorMountToken || editingPath !== value.path || previewPath !== value.path) {
      created.destroy();
      return;
    }
    codeEditor = created;
    languageLabel.textContent = created.language;
    updateEditorDirtyState();
    created.focus();
  }

  async function mountCodeViewer(value: ProjectFilePreview & { text: string }, host: HTMLElement, languageLabel: HTMLElement, publish: () => void): Promise<void> {
    const token = ++viewerMountToken;
    pendingCodePreview = value;
    const module = await import('./file-code-editor.js');
    if (token !== viewerMountToken || editingPath || previewPath !== value.path || selection.path !== value.path) return;
    const created = await module.createProjectCodeEditor({
      parent: host,
      filename: value.name,
      text: value.text,
      readOnly: true
    });
    if (token !== viewerMountToken || editingPath || previewPath !== value.path || selection.path !== value.path) {
      created.destroy();
      return;
    }
    languageLabel.textContent = created.language;
    publish();
    codeViewer = created;
  }

  async function mountPdfViewer(value: ProjectFilePreview & { pdfDataBase64: string }, host: HTMLElement, revision: string): Promise<void> {
    const token = ++pdfMountToken;
    const controller = new AbortController(); pdfAbort = controller;
    const module = await import('./file-pdf-viewer.js');
    if (token !== pdfMountToken || pdfSurfaceRevision !== revision || editingPath || previewPath !== value.path || selection.path !== value.path) return;
    const created = await module.createProjectPdfViewer({
      parent: host,
      filename: value.name,
      dataBase64: value.pdfDataBase64,
      signal: controller.signal
    });
    if (token !== pdfMountToken || pdfSurfaceRevision !== revision || editingPath || previewPath !== value.path || selection.path !== value.path) {
      created.destroy();
      return;
    }
    pdfViewer = created;
  }

  function renderPreview(): void {
    if (editingPath && editingPath === previewPath && selection.path === previewPath) return;
    // Routine session paints and unrelated directory events do not own the viewer's
    // lifetime. Keep its DOM, scroll, selection and in-flight language/PDF loader.
    if (renderedPreview && previewPath === selection.path && samePreview(renderedPreview, previewValue)) {
      preview.hidden = false;
      return;
    }
    if (!previewPath || !previewValue || selection.path !== previewPath) {
      destroyCodeViewer();
      destroyPdfViewer();
      body.classList.remove('is-reading');
      preview.classList.remove('is-editing');
      preview.hidden = true; replacePreview(); return;
    }
    if (pendingCodePreview && samePreview(pendingCodePreview, previewValue)) return;
    const value = previewValue;
    const head = viewerHeader(value);
    const meta = el('div', 'file-preview-meta');
    meta.append(el('span', '', `${value.path} · ${humanBytes(value.bytes)} · ${new Date(value.modifiedAt).toLocaleString()}`));
    let content: HTMLElement;
    let viewerHost: HTMLElement | null = null;
    let languageLabel: HTMLElement | null = null;
    let pdfHost: HTMLElement | null = null;
    let surfaceClass: string | null = null;
    if (value.imageDataUrl && value.imageMimeType) {
      const wrap = el('div', 'file-preview-image-wrap');
      const image = document.createElement('img');
      image.className = 'file-preview-image';
      image.src = value.imageDataUrl;
      image.alt = value.name;
      image.decoding = 'async';
      wrap.append(image);
      content = wrap;
    } else if (value.pdfDataBase64) {
      pdfHost = el('div', 'file-pdf-viewer-host');
      surfaceClass = 'has-pdf-viewer';
      content = pdfHost;
    } else if (value.binary) {
      content = el('p', 'file-preview-empty', value.note ?? (() => t('Binary file · preview unavailable')));
    } else if (value.text === null) {
      content = el('p', 'file-preview-empty', value.note ?? t('Preview unavailable'));
    } else if (/\.(?:md|markdown)$/i.test(value.name)) {
      content = markdownPreview(value.text);
    } else {
      meta.classList.add('file-editor-meta');
      languageLabel = el('span', 'file-editor-language', () => t('Detecting language…'));
      meta.append(languageLabel);
      viewerHost = el('div', 'file-code-editor-host file-code-viewer-host');
      surfaceClass = 'has-code-viewer';
      content = viewerHost;
    }
    const publish = (): void => {
      destroyCodeViewer(); destroyPdfViewer();
      preview.classList.remove('is-editing', 'has-code-viewer', 'has-pdf-viewer');
      if (surfaceClass) preview.classList.add(surfaceClass);
      replacePreview(head, meta, content);
      renderedPreview = value;
      if (value.truncated) preview.append(el('div', 'file-preview-truncated', () => t('Preview truncated.')));
      preview.hidden = false;
    };
    if (viewerHost && languageLabel && value.text !== null) {
      void mountCodeViewer(value as ProjectFilePreview & { text: string }, viewerHost, languageLabel, publish);
      return;
    }
    publish();
    if (pdfHost && value.pdfDataBase64) {
      const revision = pdfPreviewRevision(value)!;
      pdfSurfaceRevision = revision;
      void mountPdfViewer(value as ProjectFilePreview & { pdfDataBase64: string }, pdfHost, revision);
    }
  }

  function render(): void {
    renderTree();
    if (!pane.hidden) renderPreview();
    updateActions();
    syncWatches();
  }

  function watchedDirectories(): string[] {
    if (!project) return [];
    const result = [''];
    const visit = (directory: string): void => {
      const listing = listings.get(directory);
      if (!listing) return;
      for (const entry of listing.entries) {
        if (entry.kind !== 'directory' || !expanded.has(entry.path)) continue;
        result.push(entry.path);
        visit(entry.path);
      }
    };
    visit('');
    return result;
  }

  function syncWatches(): void {
    const current = pane.hidden ? null : project;
    const directories = current ? watchedDirectories() : [];
    const signature = current ? `${current.id}\0${directories.join('\0')}` : '<none>';
    if (signature === watchSignature) return;
    watchSignature = signature;
    void window.api.watchProjectFiles(current?.id ?? null, directories).then(reply => {
      if (!reply.ok && watchSignature === signature) watchSignature = '';
    });
  }

  function firstChildWithin(directory: string, candidate: string): string | null {
    const prefix = directory ? `${directory}/` : '';
    if (!candidate.startsWith(prefix) || candidate === directory) return null;
    const remainder = candidate.slice(prefix.length);
    const first = remainder.split('/')[0];
    return first ? `${prefix}${first}` : null;
  }

  async function reloadPreviewFromDisk(directory: string, expectedGeneration: number): Promise<void> {
    const current = project;
    const relative = previewPath;
    if (!current || !relative || parentPath(relative) !== directory) return;
    const fresh = await run(window.api.previewProjectFile(current.id, relative));
    if (!fresh || expectedGeneration !== generation || project?.id !== current.id || previewPath !== relative) return;
    if (editingPath === relative && editorDirty) {
      if (fresh.revision !== previewValue?.revision) markEditorExternalChange();
      return;
    }
    if (samePreview(previewValue, fresh)) return;
    previewValue = fresh;
    if (editingPath === relative) {
      if (editablePreview(fresh)) await startEditing(fresh);
      else { clearEditorState(); renderPreview(); }
    } else {
      renderPreview();
    }
  }

  async function handleWatchedChange(change: ProjectFilesChanged): Promise<void> {
    const current = project;
    if (!current || change.projectId !== current.id) return;
    const expectedGeneration = generation;
    const listing = await run(window.api.listProjectFiles(current.id, change.directory));
    if (!listing || expectedGeneration !== generation || project?.id !== current.id) return;
    listings.set(change.directory, listing);

    const child = firstChildWithin(change.directory, selection.path);
    if (child && !listing.entries.some(entry => entry.path === child)) {
      if (editingPath && editorDirty && firstChildWithin(change.directory, editingPath) === child) {
        markEditorExternalChange();
      } else {
        if (editingPath) clearEditorState();
        selection = { path: change.directory, kind: change.directory ? 'directory' : 'root' };
        previewPath = null;
        previewValue = null;
      }
    }
    render();
    await reloadPreviewFromDisk(change.directory, expectedGeneration);
  }

  async function reloadDirectory(relative: string): Promise<void> {
    const current = project;
    if (!current) return;
    const request = generation;
    const listing = await run(window.api.listProjectFiles(current.id, relative));
    if (!listing || request !== generation || project?.id !== current.id) return;
    listings.set(relative, listing); render();
  }

  async function createEntry(kind: 'file' | 'directory'): Promise<void> {
    const current = project;
    if (!current) return;
    const directory = selectedDirectory(), expected = generation;
    // Creation selects the new entry, so it must leave the current editor through
    // the same draft guard as navigation, rename and delete.
    if (editingPath) {
      if (!(await leaveEditorIfNeeded())) return;
      renderPreview();
    }
    if (expected !== generation || project?.id !== current.id) return;
    const name = await requestEntryName({
      title: kind === 'file' ? t('New file') : t('New folder'),
      confirm: t('Create')
    });
    if (!name || expected !== generation || project?.id !== current.id) return;
    const created = await run(window.api.createProjectFileEntry(current.id, directory, name, kind));
    if (!created || expected !== generation || project?.id !== current.id) return;
    expanded.add(directory);
    selection = { path: created.path, kind: created.kind };
    await reloadDirectory(directory);
    if (expected !== generation || project?.id !== current.id) return;
    if (created.kind === 'directory' && expanded.size < 128) {
      expanded.add(created.path);
      listings.delete(created.path);
      render();
      await loadDirectory(created.path, expected);
    }
  }

  async function renameSelection(): Promise<void> {
    const current = project;
    if (!current || !selection.path || (selection.kind !== 'file' && selection.kind !== 'directory')) return;
    const oldPath = selection.path, parent = parentPath(oldPath), expected = generation;
    if (editingPath && !(await leaveEditorIfNeeded())) return;
    const nextName = await requestEntryName({
      title: t('Rename item'),
      initial: baseName(oldPath),
      confirm: t('Rename')
    });
    if (!nextName || nextName === baseName(oldPath) || expected !== generation || project?.id !== current.id || selection.path !== oldPath) return;
    const renamed = await run(window.api.renameProjectFileEntry(current.id, oldPath, nextName));
    if (!renamed || expected !== generation || project?.id !== current.id) return;
    const wasExpanded = expanded.has(oldPath);
    forgetDirectory(oldPath);
    if (wasExpanded && renamed.kind === 'directory') expanded.add(renamed.path);
    selection = { path: renamed.path, kind: renamed.kind };
    previewPath = null; previewValue = null;
    await reloadDirectory(parent);
    if (expected !== generation || project?.id !== current.id) return;
    if (wasExpanded && renamed.kind === 'directory') await loadDirectory(renamed.path, expected);
  }

  async function deleteSelection(): Promise<void> {
    const current = project;
    if (!current || !selection.path || (selection.kind !== 'file' && selection.kind !== 'directory')) return;
    if (editingPath && !(await leaveEditorIfNeeded())) return;
    const oldPath = selection.path, parent = parentPath(oldPath), expected = generation;
    const confirmed = await requestFileConfirmation({
      title: t('Delete item?'),
      message: t('Move “{0}” to the Trash?', [oldPath]),
      detail: t('You can restore it from the operating system Trash.'),
      confirm: t('Move to Trash')
    });
    if (!confirmed || expected !== generation || project?.id !== current.id || selection.path !== oldPath) return;
    const deleted = await run(window.api.deleteProjectFileEntry(current.id, oldPath));
    if (!deleted || expected !== generation || project?.id !== current.id) return;
    forgetDirectory(oldPath);
    selection = { path: parent, kind: parent ? 'directory' : 'root' };
    previewPath = null; previewValue = null;
    await reloadDirectory(parent);
  }

  async function revealSelection(): Promise<void> {
    if (!project) return;
    await run(window.api.revealProjectFileEntry(project.id, selection.path));
  }

  async function refreshAll(): Promise<void> {
    if (!project) return;
    if (editingPath && !(await leaveEditorIfNeeded())) return;
    generation++;
    watchSignature = '';
    listings.clear(); expanded = new Set(['']);
    selection = { path: '', kind: 'root' }; previewPath = null; previewValue = null;
    render();
    await loadDirectory('', generation);
  }

  refresh.onclick = () => void refreshAll();
  pane.addEventListener('keydown', event => {
    if (editingPath && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveEditing();
      return;
    }
    if (editingPath && event.key === 'Escape') return;
    if (event.key !== 'Escape') return;
    event.preventDefault(); hide(); options.toggle.focus();
  });
  options.toggle.onclick = () => { if (pane.hidden) void show(); else hide(); };
  window.api.onProjectFilesChanged?.(change => { void handleWatchedChange(change); });

  updateActions();
  return {
    hide,
    visible: () => !pane.hidden,
    update(next: LocalProject | null): void {
      const changed = project?.id !== next?.id;
      const labelChanged = project?.name !== next?.name || project?.path !== next?.path;
      if (changed && project && editingPath && editorDirty && previewValue && editablePreview(previewValue)) {
        retainedDrafts.set(project.id, { preview: previewValue, text: codeEditor?.getValue() ?? editorDraft });
      }
      project = next;
      if (changed) watchSignature = '';
      options.toggle.hidden = next === null;
      ui(options.toggle, 'title', () => next ? t('Files · {0}', [next.name]) : t('Files'));
      if (!changed) {
        if (labelChanged) renderTree();
        return;
      }
      if (editingPath) {
        clearEditorState();
      }
      destroyCodeViewer(); destroyPdfViewer();
      generation++;
      listings.clear(); expanded = new Set(['']); selection = { path: '', kind: 'root' };
      previewPath = null; previewValue = null;
      if (!next) { hide(); render(); return; }
      render();
      if (!pane.hidden) void show();
    }
  };
}
