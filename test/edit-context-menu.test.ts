import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { editContextMenuTemplate } from '../src/main/edit-context-menu.js';

const flags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false };

describe('native editable context menu', () => {
  it('uses native edit roles without reading clipboard data or replacing the selection', () => {
    const menu = editContextMenuTemplate({ isEditable: true, editFlags: flags });
    expect(menu).toEqual([
      { role: 'cut', enabled: true }, { role: 'copy', enabled: true },
      { role: 'paste', enabled: true }, { role: 'selectAll', enabled: true }
    ]);
    expect(menu.every(item => !item.click)).toBe(true);
  });

  it('reflects the actual selection, clipboard and empty-field capabilities', () => {
    const empty = editContextMenuTemplate({ isEditable: true, editFlags: { ...flags, canCut: false, canCopy: false, canPaste: false, canSelectAll: false } });
    expect(empty.every(item => item.enabled === false)).toBe(true);
    const imageClipboard = editContextMenuTemplate({ isEditable: true, editFlags: { ...flags, canCut: false, canCopy: false } });
    expect(imageClipboard.map(item => [item.role, item.enabled])).toEqual([
      ['cut', false], ['copy', false], ['paste', true], ['selectAll', true]
    ]);
  });

  it('does not present editing actions over transcript content or other non-editable UI', () => {
    expect(editContextMenuTemplate({ isEditable: false, editFlags: flags })).toEqual([]);
  });

  it('opens the native editing menu on the window context-menu event only', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf("  window.webContents.on('context-menu'");
    const handler = source.slice(start, source.indexOf('\n  window.webContents.on(', start + 1));
    let callback: (event: unknown, params: unknown) => void = () => undefined;
    let shown = 0;
    const owner = { isDestroyed: () => false, webContents: { on: (event: string, listener: typeof callback) => {
      expect(event).toBe('context-menu'); callback = listener;
    } } };
    const context = vm.createContext({ window: owner, editContextMenuTemplate, Menu: { buildFromTemplate: (template: unknown[]) => {
      expect(template).toHaveLength(4); return { popup: (options: { window: unknown }) => { expect(options.window).toBe(owner); shown++; } };
    } } });
    vm.runInContext(handler, context);
    callback({}, { isEditable: false, editFlags: flags });
    expect(shown).toBe(0);
    callback({}, { isEditable: true, editFlags: flags });
    expect(shown).toBe(1);
    owner.isDestroyed = () => true;
    callback({}, { isEditable: true, editFlags: flags });
    expect(shown).toBe(1);
  });
});
