import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, clipboard, dialog, type BrowserWindow } from 'electron';
import type { StoredText } from '../../shared/session.js';
import {
  answerMarkdown, completedTurnIds, markdownFileName, sessionMarkdown, transcriptEntries, turnAnswerEntries
} from '../../shared/markdown-export.js';
import { getSession, readEvents, readOverflowText } from './store.js';

export type MarkdownExportRequest = {
  id: string;
  scope: 'answer' | 'session';
  /** The completed turn whose answer is wanted; required for `answer`. */
  turnId?: string;
  target: 'clipboard' | 'file';
};

export type MarkdownExportResult = { done: 'copied' } | { done: 'saved'; name: string } | { done: 'cancelled' };

/** The whole text: an answer cut in the log is read back from the overflow copy beside it. */
async function fullText(sessionId: string, stored: StoredText): Promise<string> {
  if (!stored.truncated || !stored.assetId) return stored.text;
  return (await readOverflowText(sessionId, stored.assetId)) ?? stored.text;
}

/** Builds a completed turn's answer or the session transcript and copies or saves it. */
export async function exportSessionMarkdown(request: MarkdownExportRequest, owner: BrowserWindow | null): Promise<MarkdownExportResult> {
  const summary = await getSession(request.id);
  if (!summary) throw new Error('Session not found');
  const events = await readEvents(request.id);
  let markdown: string;
  let name: string;
  if (request.scope === 'answer') {
    // Only a turn the page reported as completed has an answer to hand out.
    if (!request.turnId || !completedTurnIds(events).has(request.turnId)) throw new Error('This turn has not completed');
    const entries = turnAnswerEntries(events, request.turnId);
    if (!entries.length) throw new Error('This turn has no answer to export');
    markdown = answerMarkdown(await Promise.all(entries.map(entry => fullText(request.id, entry.stored))));
    name = markdownFileName(summary.title, ' - answer');
  } else {
    const entries = transcriptEntries(events);
    markdown = sessionMarkdown(summary.title, await Promise.all(entries.map(async entry =>
      ({ role: entry.role, text: await fullText(request.id, entry.stored) }))));
    name = markdownFileName(summary.title);
  }
  if (request.target === 'clipboard') {
    clipboard.writeText(markdown);
    return { done: 'copied' };
  }
  const options = {
    title: 'Export as Markdown',
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  };
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { done: 'cancelled' };
  await fs.writeFile(result.filePath, markdown, 'utf8');
  return { done: 'saved', name: path.basename(result.filePath) };
}
