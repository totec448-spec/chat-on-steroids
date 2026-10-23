import type { AppApi } from '../preload/index.js';
import type { AppState, SettingsBackupChoice } from '../shared/types.js';
import { currentLanguage, t, tn } from './i18n.js';

/**
 * Settings → General → Backup. Export writes a file of the settings (and, when asked, the saved
 * keys, locked with a passphrase); import shows how many settings a backup changes before it
 * changes them. The main process reads and checks the file; this page never sees a saved key.
 */
const WRONG_PASSPHRASE = 'That passphrase does not open the saved keys in this backup.';
const MIN_PASSPHRASE = 8;

type Api = Pick<AppApi, 'exportSettings' | 'pickSettingsBackup' | 'importSettingsBackup'>;

export function initSettingsBackup(api: Api, hooks: { imported(state: AppState): void; toast(message: string): void }): void {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const show = (dialog: HTMLDialogElement) => { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); };
  const hide = (dialog: HTMLDialogElement) => { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); };
  const error = (node: HTMLElement, message: string | null) => { node.hidden = !message; node.textContent = message ?? ''; };

  // Export.
  const exportDialog = $<HTMLDialogElement>('exportSettingsDialog');
  const exportForm = $<HTMLFormElement>('exportSettingsForm');
  const keys = $<HTMLInputElement>('exportSettingsKeys');
  const passBox = $('exportSettingsPassphrase');
  const pass = $<HTMLInputElement>('exportSettingsPass');
  const again = $<HTMLInputElement>('exportSettingsPassAgain');
  const exportError = $('exportSettingsError');
  const exportSubmit = $<HTMLButtonElement>('exportSettingsSubmit');
  let exporting = false;
  const exportBusy = (busy: boolean) => { exporting = busy; exportSubmit.disabled = busy; exportSubmit.textContent = busy ? t('Exporting…') : t('Export'); };
  keys.addEventListener('change', () => {
    passBox.hidden = !keys.checked;
    error(exportError, null);
    if (keys.checked) pass.focus();
  });
  exportForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (exporting) return;
    error(exportError, null);
    if (keys.checked) {
      if ([...pass.value].length < MIN_PASSPHRASE) { error(exportError, t('Use a passphrase of at least 8 characters.')); pass.focus(); return; }
      if (pass.value !== again.value) { error(exportError, t('The two passphrases are not the same.')); again.select(); return; }
    }
    exportBusy(true);
    try {
      const reply = await api.exportSettings(keys.checked, keys.checked ? pass.value : undefined);
      if (!reply.ok) { error(exportError, t(reply.error)); return; }
      // The file picker was cancelled: the dialog stays, so another place can be chosen.
      if (!reply.data) return;
      hide(exportDialog);
      hooks.toast(reply.data.keyCount
        ? tn('Saved {0} with 1 saved key.', 'Saved {0} with {1} saved keys.', reply.data.keyCount, [reply.data.file, reply.data.keyCount])
        : t('Saved {0}.', [reply.data.file]));
    } catch (failure) {
      error(exportError, failure instanceof Error ? failure.message : String(failure));
    } finally { exportBusy(false); }
  });
  for (const id of ['exportSettingsCancel', 'exportSettingsClose']) $(id).addEventListener('click', () => hide(exportDialog));
  // Typed passphrases never outlive the dialog.
  exportDialog.addEventListener('close', () => { pass.value = ''; again.value = ''; });
  $('exportSettings').addEventListener('click', () => {
    exportForm.reset();
    passBox.hidden = true;
    error(exportError, null);
    exportBusy(false);
    show(exportDialog);
    exportSubmit.focus();
  });

  // Import.
  const importDialog = $<HTMLDialogElement>('importSettingsDialog');
  const importForm = $<HTMLFormElement>('importSettingsForm');
  const importKeysRow = $('importSettingsKeysRow');
  const importKeys = $<HTMLInputElement>('importSettingsKeys');
  const importPassRow = $('importSettingsPassRow');
  const importPass = $<HTMLInputElement>('importSettingsPass');
  const importError = $('importSettingsError');
  const importSubmit = $<HTMLButtonElement>('importSettingsSubmit');
  let choice: SettingsBackupChoice | null = null;
  let importing = false;
  let picking = false;
  const canImport = () => !!choice && (choice.changed.length > 0 || (choice.keyCount > 0 && importKeys.checked));
  const importBusy = (busy: boolean) => {
    importing = busy;
    importSubmit.disabled = busy || !canImport();
    importSubmit.textContent = busy ? t('Importing…') : t('Import');
  };
  const savedOn = (iso: string | null): string | null => {
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.getTime())) return null;
    try { return new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(at); } catch { return at.toISOString(); }
  };
  const fill = (next: SettingsBackupChoice) => {
    choice = next;
    const date = savedOn(next.exportedAt);
    $('importSettingsSource').textContent = date ? t('{0}, saved on {1}.', [next.file, date]) : next.file;
    $('importSettingsSummary').textContent = (next.changed.length
      ? tn('1 setting will change.', '{0} settings will change.', next.changed.length)
      : t('Every setting in this backup already matches yours.')) + ' ' +
      t("Folders and this computer's connection to ChatGPT stay as they are.");
    importKeysRow.hidden = next.keyCount === 0;
    $('importSettingsKeysLabel').textContent = tn('Also import 1 saved key', 'Also import {0} saved keys', next.keyCount);
    importKeys.checked = next.keyCount > 0;
    importPassRow.hidden = !importKeys.checked;
    importPass.value = '';
    error(importError, null);
    importBusy(false);
  };
  importKeys.addEventListener('change', () => {
    importPassRow.hidden = !importKeys.checked;
    error(importError, null);
    importBusy(false);
    if (importKeys.checked) importPass.focus();
  });
  importForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (importing || !choice || !canImport()) return;
    const withKeys = choice.keyCount > 0 && importKeys.checked;
    error(importError, null);
    if (withKeys && !importPass.value) { error(importError, t('Enter the passphrase of this backup.')); importPass.focus(); return; }
    importBusy(true);
    try {
      const reply = await api.importSettingsBackup(choice.token, withKeys, withKeys ? importPass.value : undefined);
      if (!reply.ok) {
        error(importError, t(reply.error));
        if (reply.error === WRONG_PASSPHRASE) importPass.select();
        return;
      }
      hide(importDialog);
      hooks.imported(reply.data.state);
      const { changedCount, keyCount } = reply.data;
      hooks.toast([
        tn('Imported: 1 setting changed.', 'Imported: {0} settings changed.', changedCount),
        ...(keyCount ? [tn('1 saved key added.', '{0} saved keys added.', keyCount)] : [])
      ].join(' '));
    } catch (failure) {
      error(importError, failure instanceof Error ? failure.message : String(failure));
    } finally { importBusy(false); }
  });
  for (const id of ['importSettingsCancel', 'importSettingsClose']) $(id).addEventListener('click', () => hide(importDialog));
  importDialog.addEventListener('close', () => { importPass.value = ''; });
  $('importSettings').addEventListener('click', async () => {
    if (picking) return;
    picking = true;
    try {
      const reply = await api.pickSettingsBackup();
      if (!reply.ok) { hooks.toast(t(reply.error)); return; }
      if (!reply.data) return;
      fill(reply.data);
      show(importDialog);
      if (!importPassRow.hidden) importPass.focus(); else (importSubmit.disabled ? $('importSettingsCancel') : importSubmit).focus();
    } finally { picking = false; }
  });
}
