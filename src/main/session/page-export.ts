import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, dialog, type BrowserWindow, type SaveDialogOptions } from 'electron';
import { markdownFileName, transcriptEntries } from '../../shared/markdown-export.js';
import { hiddenCount, transcriptHtml } from '../../shared/html-export.js';
import { getSession, readEvents } from './store.js';
import { dialogLabel, mainText } from '../main-texts.js';
import { fullText } from './markdown-export.js';
import { redactPersonalText, redactSecretText } from '../redaction.js';
import { replaceFile } from '../replace-file.js';
import { logWarn } from '../logger.js';

export type PageExportRequest =
  /**
   * Builds the page for the Share dialog. Keys and tokens are always hidden; `hide` also hides email
   * addresses and the user name in home-folder paths. `lang` is the interface language.
   */
  | { id: string; target: 'preview'; hide: boolean; lang: string }
  /** Saves the page that preview returned with this `preview` id, exactly as it was shown. */
  | { id: string; target: 'file'; preview: string };

export type PageExportResult =
  | { done: 'preview'; preview: string; html: string; hidden: number }
  | { done: 'saved'; name: string }
  | { done: 'cancelled' };

/**
 * The page last shown in the Share dialog. Save writes this one and does not build the page again:
 * a chat that is still working would otherwise save more than the person looked at.
 */
let shown: { preview: string; id: string; html: string; fileName: string } | null = null;
/** The newest preview request; an older one that finishes later must not replace what the dialog shows. */
let latestPreview = 0;

function longDate(lang: string, now: Date): string {
  try { return new Intl.DateTimeFormat(lang, { dateStyle: 'long' }).format(now); }
  catch { return new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(now); }
}

/** A whole chat as a web page to share: previewed in the app first, then saved as one HTML file. */
export async function exportSessionPage(request: PageExportRequest, owner: BrowserWindow | null): Promise<PageExportResult> {
  if (request.target === 'file') {
    const page = shown;
    if (!page || page.preview !== request.preview || page.id !== request.id) {
      logWarn('page export: save refused, the preview is out of date');
      throw new Error('The preview is out of date. Open Share again.');
    }
    // Linux asks nothing about replacing a file unless told to.
    const options: SaveDialogOptions = {
      ...dialogLabel('Export as HTML'),
      defaultPath: path.join(app.getPath('downloads'), page.fileName),
      filters: [{ name: mainText('HTML files'), extensions: ['html'] }],
      properties: ['showOverwriteConfirmation']
    };
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { done: 'cancelled' };
    await replaceFile(result.filePath, page.html, 'HTML export');
    return { done: 'saved', name: path.basename(result.filePath) };
  }
  const mine = ++latestPreview;
  const summary = await getSession(request.id);
  if (!summary) throw new Error('Session not found');
  const entries = transcriptEntries(await readEvents(request.id));
  if (!entries.length) throw new Error('This chat has nothing to share yet');
  // A page is made to be passed on: the credential shapes chat text can hold are always hidden in it.
  const hide = (text: string) => request.hide ? redactPersonalText(redactSecretText(text)) : redactSecretText(text);
  const messages = await Promise.all(entries.map(async entry =>
    ({ role: entry.role, text: hide(await fullText(request.id, entry.stored, entry.html)) })));
  const title = hide(summary.title.trim() || mainText('New chat'));
  const word = mainText('hidden');
  const html = transcriptHtml(title, messages, { user: mainText('You'), assistant: 'ChatGPT' }, {
    lang: request.lang, date: longDate(request.lang, new Date()), footer: mainText('Shared from Chat On Steroids'), hidden: word
  });
  // A hidden detail in the title stays hidden in the suggested file name too.
  const fileName = markdownFileName(title.replace(/\[redacted(?: private key)?\]/g, word), '', 'html');
  const preview = randomUUID();
  // The dialog shows only its newest answer; that one stays the page Save writes.
  if (mine === latestPreview) shown = { preview, id: request.id, html, fileName };
  return { done: 'preview', preview, html, hidden: hiddenCount(html) };
}
