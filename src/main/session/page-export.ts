import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { markdownFileName, transcriptEntries } from '../../shared/markdown-export.js';
import { getSession, readEvents } from './store.js';
import { dialogLabel, mainText } from '../main-texts.js';
import { fullText } from './markdown-export.js';
import { chatPageHtml, hideForSharing } from './chat-page.js';

export type PageExportRequest =
  /** Builds the page for the Share dialog. `hide` hides keys and passwords, email addresses and user names in folder paths. */
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

/** The session as a web page to share: previewed in the app first, then saved as one HTML file. */
export async function exportSessionPage(request: PageExportRequest, owner: BrowserWindow | null): Promise<PageExportResult> {
  if (request.target === 'file') {
    const page = shown;
    if (!page || page.preview !== request.preview || page.id !== request.id) throw new Error('The preview is out of date. Open Share again.');
    const options = {
      ...dialogLabel('Save as web page'),
      defaultPath: path.join(app.getPath('downloads'), page.fileName),
      filters: [{ name: mainText('Web pages'), extensions: ['html'] }]
    };
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { done: 'cancelled' };
    await fs.writeFile(result.filePath, page.html, 'utf8');
    return { done: 'saved', name: path.basename(result.filePath) };
  }
  const summary = await getSession(request.id);
  if (!summary) throw new Error('Session not found');
  const entries = transcriptEntries(await readEvents(request.id));
  if (!entries.length) throw new Error('This chat has nothing to share yet');
  const messages = await Promise.all(entries.map(async entry =>
    ({ role: entry.role, text: await fullText(request.id, entry.stored, entry.html) })));
  const title = summary.title.trim() || mainText('New chat');
  const labels = { you: mainText('You'), assistant: 'ChatGPT', hidden: mainText('hidden'), footer: mainText('Shared from Chat On Steroids') };
  const page = chatPageHtml({ title, messages, hide: request.hide, lang: request.lang, labels, now: new Date() });
  // A hidden detail in the title stays hidden in the file name too.
  const named = request.hide ? hideForSharing(title).text.replace(//g, labels.hidden) : title;
  shown = { preview: randomUUID(), id: request.id, html: page.html, fileName: markdownFileName(named, '', 'html') };
  return { done: 'preview', preview: shown.preview, ...page };
}
