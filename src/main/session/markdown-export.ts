import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, clipboard, dialog, type BrowserWindow } from 'electron';
import type { StoredText } from '../../shared/session.js';
import {
  answerMarkdown, completedTurnIds, markdownFileName, messageAnswerEntries, sessionMarkdown, transcriptEntries, turnAnswerEntries
} from '../../shared/markdown-export.js';
import { getSession, readEvents, readOverflowText } from './store.js';
import { providerEntitiesAsMarkdown } from '../../shared/content-reference.js';
import { dialogLabel, mainText } from '../main-texts.js';
import { completedDilText } from '../../shared/dil-tables.js';

export type MarkdownExportRequest = {
  id: string;
  scope: 'answer' | 'session';
  /** The completed turn whose answer is wanted; `answer` names this or `messageId`. */
  turnId?: string;
  /** An answer recorded outside any turn (copied branch history, an adopted chat's history). */
  messageId?: string;
  target: 'clipboard' | 'file';
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
  const events = await readEvents(request.id);
  let markdown: string;
  let name: string;
  if (request.scope === 'answer') {
    // Only a turn the page reported as completed has an answer to hand out; an answer recorded
    // outside any turn is final already, and is named by its message instead.
    if (!request.messageId && (!request.turnId || !completedTurnIds(events).has(request.turnId))) throw new Error('This turn has not completed');
    const entries = request.messageId ? messageAnswerEntries(events, request.messageId) : turnAnswerEntries(events, request.turnId!);
    if (!entries.length) throw new Error('This turn has no answer to export');
    markdown = answerMarkdown(await Promise.all(entries.map(entry => fullText(request.id, entry.stored, entry.html))));
    name = markdownFileName(summary.title, ' - answer');
  } else {
    const entries = transcriptEntries(events);
    markdown = sessionMarkdown(summary.title, await Promise.all(entries.map(async entry =>
      ({ role: entry.role, text: await fullText(request.id, entry.stored, entry.html) }))));
    name = markdownFileName(summary.title);
  }
  if (request.target === 'clipboard') {
    await clipboard.writeText(markdown);
    return { done: 'copied' };
  }
  const options = {
    ...dialogLabel('Export as Markdown'),
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [{ name: mainText('Markdown files'), extensions: ['md'] }]
  };
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { done: 'cancelled' };
  await fs.writeFile(result.filePath, markdown, 'utf8');
  return { done: 'saved', name: path.basename(result.filePath) };
}
