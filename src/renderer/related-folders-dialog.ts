import { el, icon } from './dom.js';
import { t } from './i18n.js';
import type { LocalProject, RelatedFolderView } from '../shared/projects.js';
import type { Root } from '../shared/types.js';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
export interface RelatedFoldersApi {
  relatedFolders(id: string): Promise<Result<RelatedFolderView[]>>;
  setRelatedFolders(id: string, folders: string[]): Promise<Result<RelatedFolderView[]>>;
  getState(): Promise<Result<{ config: { roots: Root[] } }>>;
}

/**
 * Related folders (#1689): the project's other approved folders, as context for its chats. Each
 * change is saved at once; Done or Escape closes. One that is no longer approved or no longer there
 * says Unavailable, with text and an icon, and ChatGPT is not told about it.
 */
export async function openRelatedFolders(api: RelatedFoldersApi, project: LocalProject, onError: (message: string) => void,
  /** Where the keyboard goes back to when the dialog closes: the project's menu button (2.1.51 polish pass). */
  returnFocus: () => HTMLElement | null = () => null): Promise<void> {
  document.querySelector('.related-folders-dialog')?.remove();
  const [views, state] = await Promise.all([api.relatedFolders(project.id), api.getState()]);
  if (!views.ok) { onError(views.error); return; }
  if (!state.ok) { onError(state.error); return; }
  let current = views.data;
  const roots = state.data.config.roots;
  let saving = false;

  const box = document.createElement('dialog');
  box.className = 'file-entry-dialog related-folders-dialog';
  box.setAttribute('aria-labelledby', 'relatedFoldersTitle');
  const form = document.createElement('form');
  form.className = 'file-entry-dialog-form';
  form.noValidate = true;
  const heading = el('h2', '', () => t('Related folders'));
  heading.id = 'relatedFoldersTitle';
  const intro = el('p', 'related-folders-intro', () => t('Adds context for ChatGPT; does not change the working directory or grant access.'));
  const list = el('ul', 'related-folders-list');
  const empty = el('p', 'related-folders-empty', () => t('No related folders yet.'));
  const addRow = el('div', 'related-folders-add');
  const select = document.createElement('select');
  select.className = 'file-entry-dialog-input related-folders-select';
  select.setAttribute('aria-label', t('Approved folder to add'));
  const add = el('button', 'btn', () => t('Add')) as HTMLButtonElement;
  add.type = 'button';
  addRow.append(select, add);
  const none = el('p', 'related-folders-hint', () => t('Every approved folder is already here. Approve another folder in Settings to add it.'));
  const actions = el('div', 'file-entry-dialog-actions');
  const done = el('button', 'btn btn-solid', () => t('Done')) as HTMLButtonElement;
  done.type = 'submit';
  actions.append(done);
  form.append(heading, intro, list, empty, addRow, none, actions);
  box.append(form);
  document.body.append(box);

  const sameRoot = (root: Root, folder: string) => root.path === folder;
  const paint = (): void => {
    list.replaceChildren(...current.map(view => {
      const item = el('li', `related-folders-item${view.available ? '' : ' is-unavailable'}`);
      const text = el('span', 'related-folders-text');
      text.append(el('span', 'related-folders-name', view.name ?? view.path.split(/[\\/]/).filter(Boolean).pop() ?? view.path),
        el('span', 'related-folders-path', view.path));
      item.append(icon(view.available ? 'i-folder' : 'i-warning'), text);
      if (!view.available) item.append(el('span', 'related-folders-state', () => t('Unavailable')));
      item.title = view.available ? view.path : `${view.path}\n${t('No longer approved or no longer there; ChatGPT is not told about it.')}`;
      const remove = el('button', 'btn row-menu-button related-folders-remove') as HTMLButtonElement;
      remove.type = 'button'; remove.disabled = saving;
      remove.append(icon('i-x'));
      remove.setAttribute('aria-label', t('Remove {0}', [view.name ?? view.path]));
      remove.title = t('Remove');
      remove.addEventListener('click', () => void save(current.filter(other => other.path !== view.path).map(other => other.path)));
      item.append(remove);
      return item;
    }));
    empty.hidden = current.length > 0;
    const choices = roots.filter(root => !sameRoot(root, project.path) && !current.some(view => sameRoot(root, view.path)));
    select.replaceChildren(...choices.map(root => {
      const option = document.createElement('option');
      option.value = root.path; option.textContent = `${root.name} — ${root.path}`; option.title = option.textContent;
      return option;
    }));
    // One line in the closed dropdown; its tooltip names the chosen folder in full.
    select.title = select.selectedOptions[0]?.textContent ?? '';
    addRow.hidden = choices.length === 0;
    none.hidden = choices.length > 0;
    select.disabled = add.disabled = saving;
  };
  const save = async (folders: string[]): Promise<void> => {
    if (saving) return;
    saving = true; paint();
    try {
      const result = await api.setRelatedFolders(project.id, folders);
      if (result.ok) current = result.data;
      else onError(result.error);
    } finally {
      saving = false;
      if (box.isConnected) paint();
    }
  };
  add.addEventListener('click', () => { if (select.value) void save([...current.map(view => view.path), select.value]); });
  select.addEventListener('change', () => { select.title = select.selectedOptions[0]?.textContent ?? ''; });
  const close = (): void => { box.remove(); returnFocus()?.focus({ preventScroll: true }); };
  form.addEventListener('submit', event => { event.preventDefault(); close(); });
  box.addEventListener('cancel', event => { event.preventDefault(); close(); });
  paint();
  if (typeof box.showModal === 'function') box.showModal();
  else box.setAttribute('open', '');
  (addRow.hidden ? done : select).focus();
}
