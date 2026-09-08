import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

/** Native roles retain Chromium's current selection, undo history and trusted paste
 * event. Image paste therefore reaches the composer's existing attachment importer. */
export function editContextMenuTemplate(
  params: Pick<ContextMenuParams, 'isEditable' | 'editFlags'>
): MenuItemConstructorOptions[] {
  if (!params.isEditable) return [];
  return [
    { role: 'cut', enabled: params.editFlags.canCut },
    { role: 'copy', enabled: params.editFlags.canCopy },
    { role: 'paste', enabled: params.editFlags.canPaste },
    { role: 'selectAll', enabled: params.editFlags.canSelectAll }
  ];
}
