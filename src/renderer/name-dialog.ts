import { el } from './dom.js';
import { t } from './i18n.js';

/**
 * The app's one in-app name dialog (file and folder names, chat group names). `validate` gets the
 * trimmed value and returns the reason it cannot be used, or null; the dialog stays open until it
 * can, and Cancel or Escape resolve null. Its look is the file panel's (`.file-entry-dialog`).
 */
export function requestName(options: { title: string; initial?: string; confirm: string; maxLength: number; validate: (value: string) => string | null }): Promise<string | null> {
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
    input.maxLength = options.maxLength;
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
      const problem = options.validate(value);
      if (problem) {
        input.setCustomValidity(problem);
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
