/**
 * One file that explains a problem: versions, settings, connection, pending work and the log,
 * with personal details removed (see `report-scrub.ts`). People attach it to an issue instead of
 * pasting log excerpts over several rounds (#882), so it has to be complete for us and safe for
 * them. It is plain text, so anyone can read exactly what they share before sharing it.
 *
 * What it never contains: message or task text, chat titles, folder and file names, account or
 * tunnel identity, keys, prompts or private hosts. Settings are reduced to on/off values,
 * numbers and short option names; everything that names something is left out.
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { app, dialog, shell, type BrowserWindow } from 'electron';
import { getConfig } from './config.js';
import { flushLogFile, logFilePath } from './logger.js';
import { scrubText, type ScrubContext } from './report-scrub.js';

/** Enough log for a long run, small enough to attach anywhere. */
export const REPORT_LOG_BYTES = 3 * 1024 * 1024;

export interface DiagnosticsReportSources {
  app: { version: string; electron: string; chrome: string; platform: string; arch: string; osRelease: string; locale: string };
  home: string;
  extension: unknown;
  bridge: unknown;
  selfTest: { summary: string; checks: Array<{ name: string; status: string; detail: string }> } | null;
  commands: Array<Record<string, unknown>>;
  workers: Array<Record<string, unknown>>;
  sessions: Array<{ title?: string; lastToolActivity?: { title?: string } | null; endedAt: number | null; toolCalls: number }>;
  projects: Array<{ name: string; path: string }>;
  /** Free text the user or ChatGPT wrote that the log may quote: tasks, labels, results. */
  workerTexts: string[];
  log: string;
  now: number;
}

/** Settings keys that name, address or unlock something. Never reported, whatever their value. */
const PRIVATE_SETTING = /(tunnel|profile|path|root|folder|prompt|url|key|token|secret|name|email|instruction|objective|allowlist|rules|binary|^id$|Id$)/i;

/** On/off values, numbers and short option names only; lists by length. */
export function reportableSettings(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return [`${prefix}: ${value.length} item(s)`];
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      // A number or an on/off value names nothing ("autoTokens: 400000"); text and whole groups under
      // a private-sounding key are left out.
      PRIVATE_SETTING.test(key) && typeof child !== 'number' && typeof child !== 'boolean'
        ? [] : reportableSettings(child, prefix ? `${prefix}.${key}` : key));
  }
  if (typeof value === 'boolean' || typeof value === 'number') return [`${prefix}: ${value}`];
  if (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,40}$/.test(value)) return [`${prefix}: ${value}`];
  return [];
}

function section(title: string, lines: string[]): string {
  return `\n## ${title}\n\n${lines.length ? lines.join('\n') : '(none)'}\n`;
}

function json(value: unknown): string[] {
  return value === null || value === undefined ? [] : JSON.stringify(value, null, 2).split('\n');
}

export function renderDiagnosticsReport(sources: DiagnosticsReportSources): string {
  const context: ScrubContext = {
    home: sources.home,
    known: [
      ...sources.projects.flatMap(project => [project.path, project.name]),
      ...sources.sessions.flatMap(session => [session.title ?? '', session.lastToolActivity?.title ?? '']),
      ...sources.workerTexts,
      ...configKnownValues()
    ]
  };
  const scrub = (text: string) => scrubText(text, context);
  const ended = sources.sessions.filter(session => session.endedAt !== null).length;
  const header = [
    '# Chat On Steroids diagnostics report',
    '',
    `Created ${new Date(sources.now).toISOString()}.`,
    'This file is meant for a bug report. It contains versions, settings (on/off values, numbers and option names),',
    'the connection state, pending work (step names and times) and the app log. Personal details are replaced:',
    'your user name, folder and file names, chat titles, tasks, email addresses, keys and private addresses',
    'become tags like <p:1a2b>. Please read it before you share it.'
  ];
  const body = [
    section('App', [
      `Version: ${sources.app.version}`,
      `System: ${sources.app.platform} ${sources.app.osRelease} (${sources.app.arch}), locale ${sources.app.locale}`,
      `Electron ${sources.app.electron}, Chrome ${sources.app.chrome}`
    ]),
    section('Browser connection', [...json(sources.bridge), ...json(sources.extension)].map(scrub)),
    section('Connection self-test', sources.selfTest
      ? [sources.selfTest.summary, ...sources.selfTest.checks.map(check => `- ${check.name}: ${check.status} — ${check.detail}`)].map(scrub)
      : ['(not available)']),
    section('Settings', reportableSettings(getConfig())),
    section('Chats', [`${sources.sessions.length} chat(s), ${ended} ended, ${sources.projects.length} project(s)`]),
    section('Pending work', [...sources.commands, ...sources.workers].map(row => scrub(JSON.stringify(row)))),
    section('Log (most recent last)', [scrub(sources.log)])
  ];
  return [...header, ...body].join('\n');
}

/** Values from the settings that the log may quote and that identify the user. */
function configKnownValues(): string[] {
  const config = getConfig() as unknown as Record<string, any>;
  const roots: Array<{ name?: string; path?: string }> = Array.isArray(config.roots) ? config.roots : [];
  const tunnel = config.tunnel ?? {};
  const profiles: Array<{ name?: string }> = Array.isArray(tunnel.profiles) ? tunnel.profiles : [];
  return [
    ...roots.flatMap(root => [root.path ?? '', root.name ?? '']),
    tunnel.profileName ?? '', tunnel.tunnelId ?? '', tunnel.desktopTunnelId ?? '', tunnel.pluginsTunnelId ?? '', tunnel.binaryPath ?? '',
    ...profiles.map(profile => profile.name ?? '')
  ].filter((value): value is string => typeof value === 'string');
}

/** The newest `limit` bytes of the log, previous rotation first, starting at a whole line. */
export async function readRecentLog(limit = REPORT_LOG_BYTES): Promise<string> {
  const file = logFilePath();
  if (!file) return '(no log file)';
  await flushLogFile().catch(() => undefined);
  const parts: string[] = [];
  for (const candidate of [`${file}.1`, file]) {
    try { parts.push(await fs.readFile(candidate, 'utf8')); } catch { /* Missing rotation is normal. */ }
  }
  const all = parts.join('');
  if (Buffer.byteLength(all, 'utf8') <= limit) return all;
  const tail = Buffer.from(all, 'utf8').subarray(-limit).toString('utf8');
  return tail.slice(tail.indexOf('\n') + 1);
}

export function systemFacts(app: { getVersion(): string; getLocale(): string }): DiagnosticsReportSources['app'] {
  return {
    version: app.getVersion(), electron: process.versions.electron ?? '?', chrome: process.versions.chrome ?? '?',
    platform: process.platform, arch: process.arch, osRelease: os.release(), locale: app.getLocale()
  };
}

/** Asks where to save, writes the file and shows it, so the user reads what they would share. */
export async function saveDiagnosticsReport(text: string, owner: BrowserWindow | null): Promise<{ saved: false } | { saved: true; name: string }> {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const options = {
    title: 'Save diagnostics report',
    defaultPath: path.join(app.getPath('downloads'), `chat-on-steroids-diagnostics-${stamp}.txt`),
    filters: [{ name: 'Text', extensions: ['txt'] }]
  };
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false };
  await fs.writeFile(result.filePath, text, 'utf8');
  shell.showItemInFolder(result.filePath);
  return { saved: true, name: path.basename(result.filePath) };
}
