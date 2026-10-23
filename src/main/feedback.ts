import os from 'node:os';

/**
 * In-app feedback: a GitHub issue form opened in the person's browser with what they wrote and
 * what the app knows (version, system, architecture, the extension) already filled in. They read
 * it and submit it there; nothing is sent from the app. The form's field ids are the ones in
 * .github/ISSUE_TEMPLATE, and the dropdown answers are their option texts word for word.
 */

const REPOSITORY = 'https://github.com/totec448-spec/chat-on-steroids';
/** GitHub refuses longer addresses; a little room is kept below its limit. */
export const MAX_ISSUE_URL = 7800;

export type FeedbackReport =
  | { kind: 'bug'; what: string; steps?: string; frequency?: 'Every time' | 'Sometimes' | 'It happened once' }
  | { kind: 'idea'; problem: string; proposal: string };

export type FeedbackEnvironment = {
  version: string;
  /** As operatingSystemName says it. */
  os: string;
  arch: string;
  /** Null when the app has never heard from an extension. */
  extension: { present: boolean; version: string | null } | null;
};


/** Electron's system version ("15.6.1" on macOS, not the Darwin kernel's); the kernel's outside Electron. */
export function systemVersion(): string {
  return typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release();
}

/** The system as people know it: "macOS 15.6", "Windows 11 (build 26100)". */
export function operatingSystemName(platform: string, version: string): string {
  if (platform === 'darwin') return `macOS ${version}`;
  if (platform === 'win32') {
    const build = Number(/^10\.0\.(\d+)/.exec(version)?.[1]);
    // Windows 11 still reports 10.0; its builds start at 22000.
    return Number.isFinite(build) ? `Windows ${build >= 22000 ? 11 : 10} (build ${build})` : `Windows ${version}`;
  }
  return `${platform === 'linux' ? 'Linux' : platform} ${version}`;
}

function architecture(arch: string): string {
  return arch === 'arm64' ? 'ARM64' : arch === 'x64' ? 'x64 (Intel/AMD)' : 'Not sure';
}

function extensionAnswer(extension: FeedbackEnvironment['extension'], version: string): string | undefined {
  if (!extension) return undefined;
  if (!extension.present) return 'No';
  return extension.version === version ? 'Yes, and its version matches the app' : 'Yes, but I am not sure the versions match';
}

/** The first sentence or line, at most 80 characters. */
function titleOf(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0]!.trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/u.exec(line)?.[1] ?? line;
  const chars = [...sentence];
  if (chars.length <= 80) return sentence;
  const cut = chars.slice(0, 79).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function address(fields: ReadonlyArray<readonly [string, string | undefined]>): string {
  const query = new URLSearchParams();
  for (const [name, value] of fields) if (value !== undefined && value !== '') query.set(name, value);
  return `${REPOSITORY}/issues/new?${query}`;
}

/**
 * The issue form's address. Text that does not fit in a link is shortened, the longest field
 * first, by whole characters, and ends with "…"; `trimmed` says so, so the person can paste the rest.
 */
export function feedbackIssueUrl(report: FeedbackReport, env: FeedbackEnvironment): { url: string; trimmed: boolean } {
  const text: Array<[string, string]> = report.kind === 'bug'
    ? [['what', report.what.trim()], ['repro', report.steps?.trim() ?? '']]
    : [['problem', report.problem.trim()], ['proposal', report.proposal.trim()]];
  const fixed: Array<[string, string | undefined]> = report.kind === 'bug'
    ? [['template', 'bug_report.yml'], ['title', titleOf(report.what)], ['version', env.version], ['operating_system', env.os],
      ['architecture', architecture(env.arch)], ['extension', extensionAnswer(env.extension, env.version)]]
    : [['template', 'feature_request.yml'], ['title', titleOf(report.problem)]];
  const tail: Array<[string, string | undefined]> = report.kind === 'bug' ? [['frequency', report.frequency]] : [];
  const build = () => address([...fixed, ...text, ...tail]);
  let url = build();
  let trimmed = false;
  while (url.length > MAX_ISSUE_URL) {
    const longest = text.reduce((a, b) => encodeURIComponent(b[1]).length > encodeURIComponent(a[1]).length ? b : a);
    const chars = [...longest[1].replace(/…$/u, '')];
    if (!chars.length) break;
    // Each character costs at most 12 encoded characters (four UTF-8 bytes); cut enough at once.
    const excess = url.length - MAX_ISSUE_URL;
    const keep = Math.max(0, chars.length - Math.max(1, Math.ceil(excess / 12)));
    longest[1] = `${chars.slice(0, keep).join('').trimEnd()}…`;
    trimmed = true;
    url = build();
  }
  return { url, trimmed };
}
