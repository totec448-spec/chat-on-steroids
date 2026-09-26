import type { InputAttachment } from '../shared/input.js';
import type { LocalProject } from '../shared/projects.js';
import type { ToolEditReview } from '../shared/session.js';
import type { ProjectDirectoryListing, ProjectFileEntry, ProjectFileKind, ProjectFilePreview, ProjectFilesChanged } from '../shared/project-files.js';
import type { ProjectGitChange, ProjectGitChanged, ProjectGitDiff, ProjectGitSnapshot, ProjectGitStatus } from '../shared/project-git.js';
import { safeExternalLink } from '../shared/external-link.js';
import { marked } from 'marked';
import { t, ui } from './i18n.js';
import { disclosureChevron, el, icon, run, toast } from './dom.js';
import { attachWorkPanelResize } from './work-panel-resize.js';
import { hideSlidingPanel, showSlidingPanel } from './panel-motion.js';
import type { ProjectCodeEditor, ProjectDiffViewer } from './file-code-editor.js';
import type { ProjectPdfViewer } from './file-pdf-viewer.js';

interface FilePanelOptions {
  host: HTMLElement;
  toggle: HTMLButtonElement;
  onShow?: () => void;
  onAttach?: (attachment: InputAttachment) => void;
  /** Capture the current composer owner before staging starts, including its draft epoch. */
  captureAttachment?: () => (attachment: InputAttachment) => boolean;
  onRequestGitReview?: (projectId: string) => void;
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
  refresh.type = 'button'; refresh.append(icon('i-retry'));
  ui(refresh, 'title', () => t('Refresh files')); ui(refresh, 'aria-label', () => t('Refresh files'));

  const toolbar = el('div', 'file-panel-toolbar');
  const newFile = actionButton(() => t('New file'), 'i-file-add', () => createEntry('file'));
  const newFolder = actionButton(() => t('New folder'), 'i-folder-add', () => createEntry('directory'));
  const rename = actionButton(() => t('Rename'), 'i-pencil', renameSelection);
  const remove = actionButton(() => t('Delete'), 'i-trash', deleteSelection);
  const reveal = actionButton(() => t('Reveal'), 'i-out', revealSelection);
  const changes = actionButton(() => t('Changes'), 'i-git-diff', toggleChanges);
  changes.classList.add('file-panel-changes-toggle');
  changes.setAttribute('aria-pressed', 'false');
  const changesBadge = el('span', 'file-panel-changes-badge');
  changesBadge.hidden = true;
  changes.append(changesBadge);
  toolbar.append(newFile, newFolder, rename, remove, reveal, changes, refresh);

  const body = el('div', 'file-panel-body');
  const tree = el('div', 'file-tree'); tree.setAttribute('role', 'tree');
  const changesView = el('div', 'file-changes-view'); changesView.hidden = true;
  const changesHeader = el('div', 'file-changes-header');
  const backToFiles = el('button', 'file-changes-back') as HTMLButtonElement;
  backToFiles.type = 'button';
  const backToFilesLabel = el('span', '', () => t('Files'));
  backToFiles.append(icon('i-back'), backToFilesLabel);
  backToFiles.setAttribute('aria-label', t('Back to files'));
  backToFiles.addEventListener('click', () => {
    if (mode === 'review') {
      const returnsToFiles = reviewReturnMode === 'files';
      leaveReview();
      if (returnsToFiles) tree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus();
    }
    else if (gitDiffPath) closeGitDiff();
    else {
      showFiles();
      tree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus();
    }
  });
  const changesHeaderTitle = el('strong', 'file-changes-header-title', () => t('Working tree'));
  const requestGitReview = el('button', 'btn file-panel-action file-changes-request') as HTMLButtonElement;
  requestGitReview.type = 'button';
  requestGitReview.hidden = true;
  requestGitReview.append(icon('i-chat'), el('span', '', () => t('Ask agent')));
  ui(requestGitReview, 'title', () => t('Draft a Git review, commit and push request'));
  ui(requestGitReview, 'aria-label', () => t('Draft a Git review, commit and push request'));
  requestGitReview.addEventListener('click', () => {
    if (mode !== 'changes' || gitDiffPath || !project || gitSnapshot?.projectId !== project.id ||
        gitSnapshot.state !== 'ready' || !gitSnapshot.changes.length) return;
    options.onRequestGitReview?.(project.id);
  });
  changesHeader.append(backToFiles, changesHeaderTitle, requestGitReview);
  const changesList = el('div', 'file-changes-list');
  changesList.setAttribute('role', 'region');
  ui(changesList, 'aria-label', () => t('Git changes'));
  changesView.append(changesHeader, changesList);
  const preview = el('section', 'file-preview'); preview.hidden = true;
  const previewResize = el('div', 'file-preview-resize');
  previewResize.tabIndex = 0;
  previewResize.setAttribute('role', 'separator');
  previewResize.setAttribute('aria-orientation', 'horizontal');
  previewResize.setAttribute('aria-label', 'Resize file preview');
  body.append(tree, changesView, preview);
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
  let diffViewer: ProjectDiffViewer | null = null;
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
  let diffMountToken = 0;
  let pdfMountToken = 0;
  let editorSaveButton: HTMLButtonElement | null = null;
  let editorDirtyBadge: HTMLElement | null = null;
  let saving = false;
  let mode: 'files' | 'changes' | 'review' = 'files';
  let reviewReturnMode: 'files' | 'changes' = 'files';
  let reviewSource: { sessionId: string; callId: string; indices: number[]; cursor: number } | null = null;
  let reviewValue: ToolEditReview | null = null;
  let reviewGeneration = 0;
  let gitSnapshot: ProjectGitSnapshot | null = null;
  let gitLoading = false;
  let gitGeneration = 0;
  let gitDiffGeneration = 0;
  let gitDiffPath: string | null = null;
  let gitDiffValue: ProjectGitDiff | null = null;
  let renderedGitDiffRevision: string | null = null;
  let gitReconcileTimer: number | null = null;
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

  function destroyDiffViewer(): void {
    renderedGitDiffRevision = null;
    diffMountToken++;
    diffViewer?.destroy();
    diffViewer = null;
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

  function hide(instant = false): void {
    generation++;
    if (gitReconcileTimer !== null) window.clearTimeout(gitReconcileTimer);
    gitReconcileTimer = null;
    destroyPdfViewer();
    destroyDiffViewer();
    hideSlidingPanel(pane, 'right', instant);
    options.host.classList.remove('has-file-panel');
    options.toggle.setAttribute('aria-expanded', 'false');
    syncWatches();
  }

  async function show(reconcile = true): Promise<void> {
    if (!project) return;
    options.onShow?.();
    if (pane.hidden) showSlidingPanel(pane, 'right');
    options.host.classList.add('has-file-panel');
    options.toggle.setAttribute('aria-expanded', 'true');
    if (mode === 'files' && !listings.has('')) await loadDirectory('');
    else render();
    if (reconcile) void reconcileGitChanges();
    const draft = project && retainedDrafts.get(project.id);
    if (mode === 'files' && draft && !editingPath) {
      selection = { path: draft.preview.path, kind: 'file' };
      previewPath = draft.preview.path; previewValue = draft.preview;
      await startEditing(draft.preview, draft.text);
    }
  }

  function actionSelection(): Selection {
    return mode === 'files' ? selection : { path: '', kind: 'root' };
  }

  function actionTargetStillCurrent(target: Selection): boolean {
    if (mode !== 'files') return false;
    const current = actionSelection();
    return current.path === target.path && current.kind === target.kind;
  }

  function selectedDirectory(): string {
    const target = actionSelection();
    return target.kind === 'directory' || target.kind === 'root' ? target.path : parentPath(target.path);
  }

  function updateActions(): void {
    const target = actionSelection();
    const inFiles = mode === 'files';
    const mutable = inFiles && Boolean(project) && target.path !== '' &&
      (target.kind === 'file' || target.kind === 'directory');
    rename.disabled = !mutable;
    remove.disabled = !mutable;
    reveal.disabled = !inFiles || !project;
    newFile.disabled = !inFiles || !project || (target.kind !== 'root' && target.kind !== 'directory' && target.kind !== 'file');
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

  function gitStatusLabel(status: ProjectGitStatus): string {
    if (status === 'U') return t('Untracked');
    if (status === 'A') return t('Added');
    if (status === 'D') return t('Deleted');
    if (status === 'R') return t('Renamed');
    return t('Modified');
  }

  function treeGitStatus(relative: string): ProjectGitChange | undefined {
    if (gitSnapshot?.state !== 'ready') return undefined;
    return gitSnapshot.changes.find(change => change.path === relative && change.status !== 'D');
  }

  function changedDirectoryCounts(): Map<string, { count: number; statuses: Set<ProjectGitStatus> }> {
    const counts = new Map<string, { count: number; statuses: Set<ProjectGitStatus> }>();
    if (gitSnapshot?.state !== 'ready') return counts;
    for (const change of gitSnapshot.changes) {
      const visited = new Set<string>();
      for (const changedPath of [change.path, change.previousPath]) {
        if (!changedPath) continue;
        let directory = parentPath(changedPath);
        while (directory) {
          if (!visited.has(directory)) {
            const summary = counts.get(directory) ?? { count: 0, statuses: new Set<ProjectGitStatus>() };
            summary.count++;
            summary.statuses.add(change.status);
            counts.set(directory, summary);
            visited.add(directory);
          }
          directory = parentPath(directory);
        }
      }
    }
    return counts;
  }

  function folderGitLabel(count: number): string {
    return t('Git changes in this folder: {0}', [count]);
  }

  function folderGitStatus(statuses: ReadonlySet<ProjectGitStatus>): ProjectGitStatus {
    return statuses.size === 1 ? [...statuses][0]! : 'M';
  }

  function treeRow(entry: ProjectFileEntry, depth: number, directoryCounts: ReturnType<typeof changedDirectoryCounts>): HTMLElement {
    const row = el('button', `file-tree-row${selection.path === entry.path ? ' is-selected' : ''}`) as HTMLButtonElement;
    row.type = 'button'; row.dataset.path = entry.path; row.dataset.kind = entry.kind;
    row.style.setProperty('--file-depth', String(depth));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 2));
    row.setAttribute('aria-selected', String(selection.path === entry.path));
    row.tabIndex = selection.path === entry.path ? 0 : -1;
    if (entry.kind === 'directory') row.setAttribute('aria-expanded', String(expanded.has(entry.path)));
    const isOpen = entry.kind === 'directory' && expanded.has(entry.path);
    const disclosure = el('span', `file-tree-disclosure${isOpen ? ' is-open' : ''}`);
    disclosure.setAttribute('aria-hidden', 'true');
    if (entry.kind === 'directory') disclosure.append(disclosureChevron('ph-file-disclosure'));
    row.append(disclosure, icon(entry.kind === 'directory' ? (isOpen ? 'i-folder-open' : 'i-folder') : entry.kind === 'file' ? 'i-file' : 'i-ban', 'file-tree-icon'));
    row.append(el('span', 'file-tree-name', entry.name));
    const gitChange = entry.kind === 'file' ? treeGitStatus(entry.path) : undefined;
    const descendants = entry.kind === 'directory' ? directoryCounts.get(entry.path) : undefined;
    if (gitChange || descendants) {
      const status = gitChange?.status ?? folderGitStatus(descendants!.statuses);
      const marker = el('span', `file-tree-git-status is-${status.toLowerCase()}${descendants ? ' is-directory' : ''}`, status);
      marker.setAttribute('role', 'img');
      const label = gitChange ? gitStatusLabel(gitChange.status) : folderGitLabel(descendants!.count);
      marker.title = label;
      marker.setAttribute('aria-label', label);
      row.append(marker);
    }
    if (entry.kind === 'file' && entry.bytes !== null) row.append(el('span', 'file-tree-size', humanBytes(entry.bytes)));
    row.title = entry.path;
    row.addEventListener('click', () => void (entry.kind === 'directory' ? toggleDirectory(entry) : selectFile(entry)));
    return row;
  }

  function appendDirectory(target: DocumentFragment | HTMLElement, relative: string, depth: number, directoryCounts: ReturnType<typeof changedDirectoryCounts>): void {
    const listing = listings.get(relative);
    if (!listing) {
      if (expanded.has(relative)) target.append(el('div', 'file-tree-status', () => t('Loading…')));
      return;
    }
    for (const entry of listing.entries) {
      target.append(treeRow(entry, depth, directoryCounts));
      if (entry.kind === 'directory' && expanded.has(entry.path)) appendDirectory(target, entry.path, depth + 1, directoryCounts);
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
    root.append(icon('i-folder-open', 'file-tree-icon'), el('strong', 'file-tree-name', project.name));
    const directoryCounts = changedDirectoryCounts();
    if (gitSnapshot?.state === 'ready' && gitSnapshot.changes.length) {
      const status = folderGitStatus(new Set(gitSnapshot.changes.map(change => change.status)));
      const marker = el('span', `file-tree-git-status is-${status.toLowerCase()} is-directory`, status);
      const label = folderGitLabel(gitSnapshot.changes.length);
      marker.setAttribute('role', 'img'); marker.setAttribute('aria-label', label); marker.title = label;
      root.append(marker);
    }
    root.title = project.path;
    root.onclick = () => void (async () => {
      if (editingPath && !(await leaveEditorIfNeeded())) return;
      selection = { path: '', kind: 'root' }; previewPath = null; previewValue = null; render();
    })();
    tree.append(root);
    const fragment = document.createDocumentFragment(); appendDirectory(fragment, '', 0, directoryCounts); tree.append(fragment);
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
    const button = actionButton(() => t('Files'), 'i-files', () => {
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
    const attach = actionButton(() => t('Attach'), 'i-attach', async () => {
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
      await reconcileGitChanges(true);
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
    const save = actionButton(() => t('Save'), 'i-save', saveEditing);
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

  function updateChangesButton(): void {
    const count = gitSnapshot?.state === 'ready' ? gitSnapshot.changes.length : 0;
    changesBadge.textContent = String(count);
    changesBadge.hidden = count === 0;
    changes.classList.toggle('is-active', mode === 'changes');
    changes.setAttribute('aria-pressed', String(mode === 'changes'));
    const label = count > 0 ? t('Changes ({0})', [count]) : t('Changes');
    changes.title = label;
    changes.setAttribute('aria-label', label);
  }

  function changeStats(change: ProjectGitChange): HTMLElement {
    const stats = el('span', 'file-change-stats');
    if (change.status === 'U') {
      stats.title = t('All lines in this untracked file');
      stats.append(el('span', 'is-muted', change.binary ? t('Binary') :
        change.additions === null ? '—' : t('{0} lines', [change.additions])));
      return stats;
    }
    stats.title = t('Changes since HEAD');
    if (change.additions !== null) stats.append(el('span', 'is-added', `+${change.additions}`));
    if (change.deletions !== null) stats.append(el('span', 'is-deleted', `−${change.deletions}`));
    if (change.additions === null && change.deletions === null) {
      stats.append(el('span', 'is-muted', change.binary ? t('Binary') : '—'));
    }
    return stats;
  }

  function renderChangesList(): void {
    changesList.replaceChildren();
    if (!project) {
      changesList.append(el('p', 'file-changes-empty', () => t('Changes is available only for chats in a local project.')));
      return;
    }
    if (gitLoading && !gitSnapshot) {
      changesList.append(el('p', 'file-changes-empty', () => t('Reading Git changes…')));
      return;
    }
    if (!gitSnapshot) {
      changesList.append(el('p', 'file-changes-empty', () => t('Open Changes to inspect this project.')));
      return;
    }
    if (gitSnapshot.state === 'not-repository') {
      changesList.append(el('p', 'file-changes-empty', () => t('This folder is not a Git repository.')));
      return;
    }
    if (gitSnapshot.state === 'unavailable') {
      const message = el('p', 'file-changes-empty', () => t('Git changes are unavailable.'));
      if (gitSnapshot.message) message.title = gitSnapshot.message;
      changesList.append(message);
      return;
    }
    if (!gitSnapshot.changes.length) {
      const clean = el('div', 'file-changes-clean');
      clean.append(icon('i-check'), el('span', '', () => t('Working tree is clean')));
      changesList.append(clean);
      return;
    }
    const groups: Array<[ProjectGitStatus, string]> = [
      ['M', t('Modified')], ['A', t('Added')], ['D', t('Deleted')],
      ['R', t('Renamed')], ['U', t('Untracked')]
    ];
    for (const [status, label] of groups) {
      const entries = gitSnapshot.changes.filter(change => change.status === status);
      if (!entries.length) continue;
      const section = el('section', 'file-change-group');
      section.append(el('h3', 'file-change-group-title', `${label} (${entries.length})`));
      for (const change of entries) {
        const row = el('button', `file-change-row${gitDiffPath === change.path ? ' is-selected' : ''}`) as HTMLButtonElement;
        row.type = 'button';
        row.dataset.path = change.path;
        row.setAttribute('aria-pressed', String(gitDiffPath === change.path));
        const statusMark = el('span', `file-change-status is-${status.toLowerCase()}`, status);
        statusMark.setAttribute('aria-hidden', 'true');
        const names = el('span', 'file-change-names');
        if (change.previousPath) {
          names.append(el('span', 'file-change-previous', change.previousPath), el('span', 'file-change-arrow', '→'));
        }
        names.append(el('span', 'file-change-path', change.path));
        const stats = changeStats(change);
        row.append(statusMark, names, stats);
        row.title = `${gitStatusLabel(change.status)} · ${change.previousPath ? `${change.previousPath} → ` : ''}${change.path} · ${stats.textContent ?? ''}`;
        row.setAttribute('aria-label', row.title);
        row.addEventListener('click', () => void openGitDiff(change));
        section.append(row);
      }
      changesList.append(section);
    }
    if (gitSnapshot.truncated) changesList.append(el('p', 'file-changes-limit', () => t('More changes exist than can be shown at once.')));
  }

  function closeGitDiff(): void {
    gitDiffGeneration++;
    gitDiffPath = null;
    gitDiffValue = null;
    destroyDiffViewer();
    render();
  }

  function leaveReview(): void {
    if (mode !== 'review') return;
    reviewGeneration++;
    reviewSource = null; reviewValue = null;
    mode = reviewReturnMode;
    destroyDiffViewer();
    if (mode === 'changes' && gitDiffPath) {
      const selected = gitSnapshot?.state === 'ready' ? gitSnapshot.changes.find(change => change.path === gitDiffPath) : undefined;
      if (selected) { void openGitDiff(selected); return; }
      gitDiffPath = null;
      gitDiffValue = null;
    }
    render();
  }

  async function selectReview(cursor: number): Promise<void> {
    const source = reviewSource;
    const current = project;
    if (!source || !current || cursor < 0 || cursor >= source.indices.length) return;
    const token = ++reviewGeneration;
    source.cursor = cursor;
    reviewValue = null;
    destroyDiffViewer();
    render();
    const value = await run(window.api.getToolEditReview(source.sessionId, source.callId, source.indices[cursor]!));
    if (token !== reviewGeneration || project?.id !== current.id || mode !== 'review' || reviewSource !== source) return;
    if (!value) { leaveReview(); toast(t('Recorded edit is unavailable.')); return; }
    reviewValue = value;
    render();
  }

  async function mountGitDiff(value: ProjectGitDiff | ToolEditReview, host: HTMLElement, language: HTMLElement, revision: string): Promise<void> {
    const token = ++diffMountToken;
    const module = await import('./file-code-editor.js');
    if (token !== diffMountToken || (mode === 'changes' ? gitDiffPath !== value.path : mode !== 'review' || reviewValue !== value) || revision !== renderedGitDiffRevision) return;
    const created = await module.createProjectDiffViewer({
      parent: host,
      filename: value.path,
      baseText: value.baseText ?? '',
      currentText: value.currentText ?? ''
    });
    if (token !== diffMountToken || (mode === 'changes' ? gitDiffPath !== value.path : mode !== 'review' || reviewValue !== value) || revision !== renderedGitDiffRevision) {
      created.destroy(); return;
    }
    diffViewer = created;
    language.textContent = created.language;
  }

  function renderGitDiff(): void {
    const historical = mode === 'review';
    const path = historical ? reviewValue?.path ?? t('Review edit') : gitDiffPath;
    if (!path) {
      destroyDiffViewer();
      preview.hidden = true;
      replacePreview();
      return;
    }
    const value = historical ? reviewValue : gitDiffValue;
    const revision = historical
      ? `review\0${reviewSource?.callId ?? ''}\0${reviewSource?.cursor ?? 0}`
      : `${gitSnapshot?.revision ?? ''}\0${gitDiffPath}`;
    if (renderedGitDiffRevision === revision && (diffViewer || (value && 'binary' in value && (value.binary || value.tooLarge)))) {
      preview.hidden = false;
      return;
    }
    destroyCodeViewer(); destroyPdfViewer(); destroyDiffViewer();
    renderedGitDiffRevision = revision;
    const head = el('div', 'file-preview-head');
    const title = el('div', 'file-preview-title');
    const resolvedPath = value?.path ?? path;
    const name = el('strong', '', baseName(resolvedPath)); name.title = resolvedPath;
    title.append(name);
    const actions = el('div', 'file-preview-actions');
    if (historical && reviewSource && reviewSource.indices.length > 1) {
      const previous = actionButton(() => t('Previous edited file'), 'i-back', () => void selectReview(reviewSource!.cursor - 1));
      previous.disabled = reviewSource.cursor === 0;
      const next = actionButton(() => t('Next edited file'), 'i-chev', () => void selectReview(reviewSource!.cursor + 1));
      next.disabled = reviewSource.cursor === reviewSource.indices.length - 1;
      actions.append(previous, el('span', 'file-review-counter', `${reviewSource.cursor + 1}/${reviewSource.indices.length}`), next);
    }
    actions.append(actionButton(() => t('Close preview'), 'i-x', historical ? leaveReview : closeGitDiff));
    head.append(title, actions);
    if (!value) {
      replacePreview(head, el('p', 'file-preview-empty', () => t('Loading diff…')));
      preview.hidden = false;
      return;
    }
    const language = el('span', 'file-editor-language', () => t('Detecting language…'));
    const meta = el('div', 'file-preview-meta file-editor-meta');
    const status = historical
      ? `${t('This edit')} · ${value.path} · +${(value as ToolEditReview).added} −${(value as ToolEditReview).removed}`
      : 'previousPath' in value && value.previousPath
        ? `${gitStatusLabel(value.status)} · ${value.previousPath} → ${value.path}`
        : `${gitStatusLabel((value as ProjectGitDiff).status)} · ${value.path}`;
    meta.append(el('span', '', status), language);
    if (('binary' in value && (value.binary || value.tooLarge)) || value.baseText === null || value.currentText === null) {
      language.remove();
      replacePreview(head, meta, el('p', 'file-preview-empty', 'note' in value ? value.note ?? (() => t('Diff preview unavailable')) : () => t('Diff preview unavailable')));
      preview.hidden = false;
      return;
    }
    const host = el('div', 'file-code-editor-host file-diff-viewer-host');
    preview.classList.remove('is-editing', 'has-pdf-viewer');
    preview.classList.add('has-code-viewer', 'has-diff-viewer');
    replacePreview(head, meta, host);
    preview.hidden = false;
    void mountGitDiff(value, host, language, revision);
  }

  async function openGitDiff(change: ProjectGitChange): Promise<void> {
    const current = project;
    if (!current || mode !== 'changes') return;
    const entering = gitDiffPath !== change.path;
    const token = ++gitDiffGeneration;
    gitDiffPath = change.path;
    gitDiffValue = null;
    destroyDiffViewer();
    render();
    if (entering) backToFiles.focus();
    const value = await run(window.api.getProjectGitDiff(current.id, change.path));
    if (!value) {
      if (token === gitDiffGeneration && project?.id === current.id && gitDiffPath === change.path) closeGitDiff();
      return;
    }
    if (token !== gitDiffGeneration || project?.id !== current.id || mode !== 'changes' || gitDiffPath !== change.path) return;
    gitDiffValue = value;
    render();
  }

  async function reconcileGitChanges(forceDiff = false): Promise<void> {
    const current = project;
    if (!current) {
      gitSnapshot = null; gitLoading = false; updateChangesButton(); renderTree(); renderChangesList(); return;
    }
    const token = ++gitGeneration;
    gitLoading = true;
    if (mode === 'changes') renderChangesList();
    const snapshot = await run(window.api.getProjectGitSnapshot(current.id));
    if (token !== gitGeneration || project?.id !== current.id) return;
    if (!snapshot) {
      gitLoading = false;
      gitSnapshot = { projectId: current.id, state: 'unavailable', changes: [], truncated: false, revision: '' };
      if (gitDiffPath && mode !== 'review') closeGitDiff();
      else render();
      return;
    }
    const previousRevision = gitSnapshot?.revision;
    gitSnapshot = snapshot;
    gitLoading = false;
    const selected = gitDiffPath && snapshot.state === 'ready'
      ? snapshot.changes.find(change => change.path === gitDiffPath)
      : undefined;
    if (mode !== 'review') {
      if (gitDiffPath && !selected) { closeGitDiff(); return; }
      if (selected && (forceDiff || previousRevision !== snapshot.revision)) { void openGitDiff(selected); return; }
    }
    render();
  }

  function scheduleGitReconcile(): void {
    if (gitReconcileTimer !== null) window.clearTimeout(gitReconcileTimer);
    // The renderer window owns this debounce. Closing the document must retire it instead of
    // leaving a Node timer that can call back after the preload/DOM authority is gone.
    gitReconcileTimer = window.setTimeout(() => {
      gitReconcileTimer = null;
      if (!pane.isConnected || pane.hidden) return;
      void reconcileGitChanges(Boolean(gitDiffPath));
    }, 120);
  }

  function showFiles(): void {
    if (mode !== 'changes') return;
    mode = 'files';
    gitDiffGeneration++;
    gitDiffPath = null; gitDiffValue = null;
    destroyDiffViewer();
    render();
  }

  async function toggleChanges(): Promise<void> {
    if (!project) return;
    if (mode === 'changes') { showFiles(); return; }
    if (editingPath && !(await leaveEditorIfNeeded())) return;
    if (mode === 'review') leaveReview();
    mode = 'changes';
    body.classList.remove('is-reading');
    destroyCodeViewer(); destroyPdfViewer();
    render();
    await reconcileGitChanges();
  }

  async function openReview(projectId: string, sessionId: string, callId: string, indices: number[]): Promise<boolean> {
    const projectGeneration = generation;
    if (project?.id !== projectId || !indices.length || indices.length > 8 ||
        indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= 64)) return false;
    if (editingPath && !(await leaveEditorIfNeeded())) return false;
    if (project?.id !== projectId || generation !== projectGeneration) return false;
    reviewGeneration++;
    reviewReturnMode = mode === 'changes' ? 'changes' : 'files';
    reviewSource = { sessionId, callId, indices, cursor: 0 };
    reviewValue = null;
    mode = 'review';
    body.classList.remove('is-reading');
    destroyCodeViewer(); destroyPdfViewer(); destroyDiffViewer();
    if (pane.hidden) await show(false);
    else render();
    if (project?.id !== projectId || mode !== 'review') return false;
    await selectReview(0);
    if (project?.id === projectId && mode === 'review') backToFiles.focus();
    return project?.id === projectId && mode === 'review' && reviewValue !== null;
  }

  function render(): void {
    const showingChanges = mode === 'changes';
    const showingReview = mode === 'review';
    const showingDiff = showingReview || (showingChanges && gitDiffPath !== null);
    requestGitReview.hidden = !showingChanges || showingDiff || !options.onRequestGitReview ||
      gitSnapshot?.state !== 'ready' || gitSnapshot.projectId !== project?.id || !gitSnapshot.changes.length;
    tree.hidden = showingChanges || showingReview;
    changesView.hidden = !showingChanges && !showingReview;
    changesList.hidden = showingDiff;
    ui(changesHeaderTitle, 'textContent', () => t(showingReview ? 'Review edit' : showingDiff ? 'Diff' : 'Working tree'));
    const backToChanges = showingReview ? reviewReturnMode === 'changes' : showingChanges && gitDiffPath !== null;
    ui(backToFilesLabel, 'textContent', () => t(backToChanges ? 'Changes' : 'Files'));
    ui(backToFiles, 'aria-label', () => t(backToChanges ? 'Back to changes' : 'Back to files'));
    const refreshLabel = (): string => t(showingChanges ? 'Refresh changes' : 'Refresh files');
    ui(refresh, 'title', refreshLabel);
    ui(refresh, 'aria-label', refreshLabel);
    body.classList.toggle('is-changes', showingChanges);
    body.classList.toggle('is-review', showingReview);
    body.classList.toggle('is-diff-open', showingDiff);
    renderTree();
    if (showingChanges || showingReview) {
      if (!showingDiff) renderChangesList();
      if (!pane.hidden) renderGitDiff();
    } else if (!pane.hidden) {
      destroyDiffViewer();
      preview.classList.remove('has-diff-viewer');
      renderPreview();
    }
    updateChangesButton();
    updateActions();
    syncWatches();
  }

  function watchedDirectories(): string[] {
    if (!project) return [];
    const result = [''];
    const included = new Set(result);
    // Changes are the live projection, so its known parent folders get the bounded watcher
    // budget before optional expanded tree folders.
    if (gitSnapshot?.state === 'ready') {
      for (const change of gitSnapshot.changes) {
        const directory = parentPath(change.path);
        if (!included.has(directory) && result.length < 128) {
          result.push(directory);
          included.add(directory);
        }
      }
    }
    const visit = (directory: string): void => {
      const listing = listings.get(directory);
      if (!listing) return;
      for (const entry of listing.entries) {
        if (entry.kind !== 'directory' || !expanded.has(entry.path)) continue;
        if (!included.has(entry.path) && result.length < 128) {
          result.push(entry.path);
          included.add(entry.path);
        }
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
    scheduleGitReconcile();
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
    const target = actionSelection();
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
    if (!name || expected !== generation || project?.id !== current.id ||
        !actionTargetStillCurrent(target)) return;
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
    await reconcileGitChanges(true);
  }

  async function renameSelection(): Promise<void> {
    const current = project;
    const target = actionSelection();
    if (!current || !target.path || (target.kind !== 'file' && target.kind !== 'directory')) return;
    const oldPath = target.path, parent = parentPath(oldPath), expected = generation;
    if (editingPath && !(await leaveEditorIfNeeded())) return;
    const nextName = await requestEntryName({
      title: t('Rename item'),
      initial: baseName(oldPath),
      confirm: t('Rename')
    });
    if (!nextName || nextName === baseName(oldPath) || expected !== generation || project?.id !== current.id ||
        !actionTargetStillCurrent(target)) return;
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
    await reconcileGitChanges(true);
  }

  async function deleteSelection(): Promise<void> {
    const current = project;
    const target = actionSelection();
    if (!current || !target.path || (target.kind !== 'file' && target.kind !== 'directory')) return;
    if (editingPath && !(await leaveEditorIfNeeded())) return;
    const oldPath = target.path, parent = parentPath(oldPath), expected = generation;
    const confirmed = await requestFileConfirmation({
      title: t('Delete item?'),
      message: t('Move “{0}” to the Trash?', [oldPath]),
      detail: t('You can restore it from the operating system Trash.'),
      confirm: t('Move to Trash')
    });
    if (!confirmed || expected !== generation || project?.id !== current.id ||
        !actionTargetStillCurrent(target)) return;
    const deleted = await run(window.api.deleteProjectFileEntry(current.id, oldPath));
    if (!deleted || expected !== generation || project?.id !== current.id) return;
    forgetDirectory(oldPath);
    selection = { path: parent, kind: parent ? 'directory' : 'root' };
    previewPath = null; previewValue = null;
    await reloadDirectory(parent);
    await reconcileGitChanges(true);
  }

  async function revealSelection(): Promise<void> {
    if (!project) return;
    await run(window.api.revealProjectFileEntry(project.id, actionSelection().path));
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
    await reconcileGitChanges(true);
  }

  refresh.onclick = () => void (mode === 'changes' ? reconcileGitChanges(true) : refreshAll());
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
  window.api.onProjectGitChanged?.((change: ProjectGitChanged) => {
    if (change.projectId === project?.id) scheduleGitReconcile();
  });

  updateActions();
  return {
    hide,
    openReview,
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
      destroyCodeViewer(); destroyPdfViewer(); destroyDiffViewer();
      gitGeneration++; gitDiffGeneration++;
      if (gitReconcileTimer !== null) window.clearTimeout(gitReconcileTimer);
      gitReconcileTimer = null;
      gitSnapshot = null; gitLoading = false; gitDiffPath = null; gitDiffValue = null;
      reviewGeneration++; reviewSource = null; reviewValue = null; mode = 'files';
      generation++;
      listings.clear(); expanded = new Set(['']); selection = { path: '', kind: 'root' };
      previewPath = null; previewValue = null;
      if (!next) { hide(true); render(); return; }
      render();
      if (!pane.hidden) void show();
    }
  };
}
