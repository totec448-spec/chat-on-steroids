/**
 * Removes personal details from text that goes into a diagnostics report.
 *
 * The report exists so a bug can be fixed from one file instead of rounds of pasted logs (#882),
 * and people attach it to public issues. So it keeps what explains a failure (step names, ids,
 * timings, versions, error codes) and replaces what identifies a person or their work: the
 * user's name in the home folder, folder and file names, chat titles, tasks, email addresses,
 * secrets and private hosts. A replaced path keeps its shape and extension, and the same path
 * always becomes the same tag, so one file can still be followed through the log.
 *
 * Two layers, because neither is enough alone. Patterns catch paths, addresses and secrets nobody
 * listed. `known` values (project folders and names, chat titles, worker tasks) are then replaced
 * wherever they still appear, including bare names a pattern cannot recognize ("approved folder
 * /Thesis").
 */

import { createHash } from 'node:crypto';
import { redact } from './logger.js';

export interface ScrubContext {
  /** The user's home folder; becomes `~`. */
  home: string;
  /** Exact personal strings to replace wherever they appear. Short ones are ignored. */
  known: readonly string[];
}

/** Folder names that describe where the app keeps things, never whose they are. */
const STRUCTURAL = new Set([
  '~', 'Users', 'home', 'Library', 'Application Support', 'Caches', 'Logs', 'AppData', 'Roaming', 'Local', 'LocalLow',
  'Program Files', 'Program Files (x86)', 'ProgramData', 'Applications', 'Contents', 'Resources', 'MacOS', 'tmp', 'var',
  'private', 'opt', 'usr', 'bin', 'lib', 'etc', 'Temp', 'Windows', 'System32',
  'Chat On Steroids', 'chat-on-steroids', 'Chat-On-Steroids', 'sessions', 'extension', 'logs', 'skills', 'pets', 'plugins',
  'workspace', 'state', 'durable', 'app.asar', 'node_modules', 'Google', 'Chrome', 'Chromium', 'Microsoft', 'Edge',
  'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Extensions', '.codex', '.cos',
  // The app's own bridge routes, which log lines name as paths.
  'commands', 'ack', 'redeem', 'step', 'status', 'activity', 'events', 'input', 'revivals', 'pending', 'mcp', 'core',
  'desktop', 'wake', 'hello', 'pair', 'extension', 'update'
]);

/** Hosts whose addresses say nothing about the user. Everything else becomes `<host>`. */
const PUBLIC_HOSTS = /^(?:(?:[a-z0-9-]+\.)*(?:chatgpt\.com|openai\.com|oaistatic\.com|github\.com|githubusercontent\.com|anthropic\.com|openrouter\.ai)|localhost|127\.0\.0\.1|\[::1\])$/i;

function tag(kind: string, value: string): string {
  return `<${kind}:${createHash('sha256').update(value).digest('hex').slice(0, 4)}>`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One path segment: kept when structural or shaped like an id, otherwise tagged, keeping its extension. */
function scrubSegment(segment: string): string {
  if (!segment || STRUCTURAL.has(segment) || /^\d+$/.test(segment)) return segment;
  const dot = segment.lastIndexOf('.');
  const extension = dot > 0 && segment.length - dot <= 7 && /^\.[A-Za-z0-9]+$/.test(segment.slice(dot)) ? segment.slice(dot) : '';
  const stem = extension ? segment.slice(0, dot) : segment;
  // Conversation ids, uuids, dated session ids and hashes are what the log is made of; they name nothing personal.
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stem) || /^[0-9a-f]{12,64}$/i.test(stem) ||
      /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/i.test(stem)) return segment;
  return tag('p', stem) + extension;
}

function scrubPath(path: string): string {
  const separator = path.includes('\\') && !path.startsWith('/') ? '\\' : '/';
  return path.split(/[\\/]/).map(scrubSegment).join(separator);
}

function scrubUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return '<url>'; }
  if (!PUBLIC_HOSTS.test(parsed.hostname)) return `${parsed.protocol}//<host>`;
  // Query values on public hosts are ids and model names here; a token-shaped one was already masked.
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
}

export function scrubText(text: string, context: ScrubContext): string {
  let out = redact(text);
  out = out
    .replace(/\bhttps?:\/\/[^\s'"<>)\]]+/g, scrubUrl)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\b([A-Z][A-Z0-9_]{2,})=("[^"]*"|'[^']*'|\S+)/g, '$1=<redacted>')
    .replace(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, ip => ip === '127.0.0.1' || ip === '0.0.0.0' ? ip : '<ip>');
  if (context.home.length >= 3) {
    const home = escapeRegExp(context.home.replace(/[\\/]+$/, ''));
    out = out.replace(new RegExp(home.replace(/\\\\|\//g, '[\\\\/]'), 'gi'), '~');
  }
  out = out
    // A quoted path may contain spaces ("…/My Documents/report.csv").
    .replace(/(['"`])((?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)[^'"`\n]*?)\1/g, (_match, quote: string, path: string) => quote + scrubPath(path) + quote)
    // Unquoted paths where folder names with spaces are common: under the home folder, a drive,
    // a network share or a mounted volume. Spaces are allowed only between separators, so the
    // last name ends at the first space and the prose after it is kept.
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\|~[\\/]|(?<![\w.:/<>-])\/(?:Users|home|Volumes|mnt|media)\/)(?:(?![^\\/\n]*\.[A-Za-z0-9]{1,6}\s)[^\\/\n'"`<>|*?~]+[\\/])*(?:[^\\/\n'"`<>|*?]{0,80}?\.[A-Za-z0-9]{1,6}(?![\w.])|[^\s\\/'"`<>|*?]*)/g, scrubPath)
    // Any other absolute path with at least two segments. URLs were rewritten above.
    .replace(/(?<![\w.:/<>~-])\/(?=[^\s/'"`<>]+\/)[^\s'"`<>|*?]+/g, scrubPath);
  // Known values last: paths are tagged segment by segment first, so a project folder's path is
  // never replaced whole and the file names below it left readable. What remains are bare names
  // and titles. Longest first, in one pass: megabytes of log and hundreds of titles stay quick.
  const known = [...new Set(context.known.map(value => value.trim()).filter(value => value.length >= 3))]
    .sort((a, b) => b.length - a.length);
  return known.length ? out.replace(new RegExp(known.map(escapeRegExp).join('|'), 'gi'), match => tag('x', match.toLowerCase())) : out;
}
