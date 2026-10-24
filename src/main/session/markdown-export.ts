import path from 'node:path';
import { app, clipboard, ClipboardItem, dialog, type BrowserWindow, type SaveDialogOptions } from 'electron';
import type { StoredText } from '../../shared/session.js';
import {
  answerMarkdown, completedTurnIds, latestAnswer, markdownFileName, messageAnswerEntries, sessionMarkdown, transcriptEntries,
  turnAnswerEntries
} from '../../shared/markdown-export.js';
import { getSession, readEvents, readOverflowText } from './store.js';
import { providerEntitiesAsMarkdown } from '../../shared/content-reference.js';
import { dialogLabel, mainText } from '../main-texts.js';
import { completedDilText } from '../../shared/dil-tables.js';
import { answerHtml, answerPlainText, type CopyFormat } from '../../shared/answer-copy.js';
import { transcriptHtml } from '../../shared/html-export.js';
import { redactSecretText } from '../redaction.js';
import { replaceFile } from '../replace-file.js';

export type MarkdownExportRequest = {
  id: string;
  /** `latest` (/copy) is the chat's newest answer that offers copy, found here. */
  scope: 'answer' | 'latest' | 'session';
  /** The completed turn whose answer is wanted; `answer` names this or `messageId`. */
  turnId?: string;
  /** An answer recorded outside any turn (copied branch history, an adopted chat's history). */
  messageId?: string;
  target: 'clipboard' | 'file';
  /**
   * `html` saves a whole session as one self-contained page. The other values are for a copy:
   * `text`, `text-no-code` and `formatted` (HTML for Word and mail) put on the clipboard something
   * other than the Markdown. A saved answer is always Markdown; Markdown when left out.
   */
  format?: CopyFormat | 'html';
};

export type MarkdownExportResult = { done: 'copied' } | { done: 'saved'; name: string } | { done: 'cancelled' };

/** The whole text: an answer cut in the log is read back from the overflow copy beside it. */
async function fullText(sessionId: string, stored: StoredText, html?: StoredText): Promise<string> {
  // ChatGPT's link cards arrive as private-use markup; exported Markdown gets real links. A table
  // it drew in full but wrote with only its header gets its recorded rows (#1477).
  const text = !stored.truncated || !stored.assetId ? stored.text : (await readOverflowText(sessionId, stored.assetId)) ?? stored.text;
  return providerEntitiesAsMarkdown(completedDilText(text, html));
}

/** Builds a completed turn's answer or the session transcript and copies or saves it. */
export async function exportSessionMarkdown(request: MarkdownExportRequest, owner: BrowserWindow | null): Promise<MarkdownExportResult> {
  const summary = await getSession(request.id);
  if (!summary) throw new Error('Session not found');
  const format = request.format ?? 'markdown';
  const html = format === 'html';
  if (html && (request.scope !== 'session' || request.target !== 'file')) throw new Error('HTML export saves a whole session to a file');
  if (!html && format !== 'markdown' && request.target !== 'clipboard') throw new Error('Only a copy can be plain text or formatted text');
  const events = await readEvents(request.id);
  let markdown: string;
  let name: string;
  if (request.scope !== 'session') {
    const named = request.scope === 'latest' ? latestAnswer(events) : request;
    if (!named) throw new Error('This chat has no finished answer yet');
    const { turnId, messageId } = named;
    // Only a turn the page reported as completed has an answer to hand out; an answer recorded
    // outside any turn is final already, and is named by its message instead.
    if (!messageId && (!turnId || !completedTurnIds(events).has(turnId))) throw new Error('This turn has not completed');
    const entries = messageId ? messageAnswerEntries(events, messageId) : turnAnswerEntries(events, turnId!);
    if (!entries.length) throw new Error('This turn has no answer to export');
    markdown = answerMarkdown(await Promise.all(entries.map(entry => fullText(request.id, entry.stored, entry.html))));
    name = markdownFileName(summary.title, ' - answer');
  } else {
    const entries = await Promise.all(transcriptEntries(events).map(async entry =>
      ({ role: entry.role, text: await fullText(request.id, entry.stored, entry.html) })));
    // A page is made to be passed on, so the credential shapes chat text can hold are masked in it.
    const title = html ? redactSecretText(summary.title) : summary.title;
    markdown = html
      ? transcriptHtml(title, entries.map(entry => ({ role: entry.role, text: redactSecretText(entry.text) })),
        { user: mainText('You'), assistant: 'ChatGPT' })
      : sessionMarkdown(title, entries);
    name = markdownFileName(title, '', html ? 'html' : 'md');
  }
  if (request.target === 'clipboard') {
    // Formatted text carries the plain text too, for the apps that paste no HTML.
    if (format === 'formatted') await clipboard.write([new ClipboardItem({ 'text/plain': answerPlainText(markdown), 'text/html': answerHtml(markdown) })]);
    else await clipboard.writeText(format === 'markdown' ? markdown : answerPlainText(markdown, { codeBlocks: format !== 'text-no-code' }));
    return { done: 'copied' };
  }
  // Linux asks nothing about replacing a file unless told to.
  const options: SaveDialogOptions = {
    ...dialogLabel(html ? 'Export as HTML' : 'Export as Markdown'),
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [html ? { name: mainText('HTML files'), extensions: ['html'] } : { name: mainText('Markdown files'), extensions: ['md'] }],
    properties: ['showOverwriteConfirmation']
  };
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { done: 'cancelled' };
  await replaceFile(result.filePath, markdown, html ? 'HTML export' : 'Markdown export');
  return { done: 'saved', name: path.basename(result.filePath) };
}
