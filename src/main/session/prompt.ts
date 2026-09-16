import path from 'node:path';
import { readFileStream } from '../codex/filesystem.js';
import { effectiveCapabilities, getConfig } from '../config.js';
import { currentCoreInstructions } from '../mcp/instructions.js';
import { getSessionProject, projectWorkspace } from '../projects.js';
import { resolvePath } from '../sandbox.js';
import { MAX_CHATGPT_MESSAGE_CHARS, prependUserPrompt } from '../../shared/user-prompt.js';
import { selectedSkillInstructions, type SelectedSkill } from './skill-prompt.js';

type PromptScope = { sessionId?: string | null; projectId?: string | null };
export type PromptLimits = { maxChars: number; maxBytes: number };
type ProjectInstructions = { directory: string; text: string; truncated: boolean };
const limits: PromptLimits = { maxChars: MAX_CHATGPT_MESSAGE_CHARS, maxBytes: Infinity };
const cutNotice = '\n\n[Cut off because of the message limit. Read AGENTS.md yourself for the remaining instructions.]';

/** One selected folder, never cwd inference, global discovery or a recursive document scan. */
async function projectInstructions(scope: PromptScope): Promise<ProjectInstructions | null> {
  if (!scope.sessionId && !scope.projectId) return null;
  // Existing sessions own their project; a caller-provided project cannot replace that binding.
  const folder = scope.sessionId ? await getSessionProject(scope.sessionId)
    : await projectWorkspace(scope.projectId!);
  if (!folder) return null;
  const directoryOnly = { directory: folder.virtual, text: '', truncated: false };
  if (!effectiveCapabilities(getConfig()).read) return directoryOnly;
  const filename = path.join(folder.real, 'AGENTS.md');
  try {
    const resolved = await resolvePath(getConfig().roots, filename, { allowMissing: true });
    // At most four UTF-8 bytes per available UTF-16 code unit, plus one byte to detect overflow.
    // Stream a bounded prefix so even a gigabyte AGENTS.md never becomes a gigabyte allocation.
    const budget = MAX_CHATGPT_MESSAGE_CHARS * 4;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of readFileStream(resolved.real)) {
      const kept = chunk.subarray(0, Math.max(0, budget + 1 - bytes));
      chunks.push(kept);
      bytes += kept.length;
      if (bytes > budget) break;
    }
    const data = Buffer.concat(chunks);
    // Streaming decode leaves an incomplete final codepoint out of a shortened prefix.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, budget), { stream: bytes > budget });
    if (text.includes('\0')) throw new Error('AGENTS.md must be a UTF-8 text file');
    // Permission/path changes during the asynchronous read cannot publish another folder's text.
    const current = scope.sessionId ? await getSessionProject(scope.sessionId) : await projectWorkspace(scope.projectId!);
    const checked = await resolvePath(getConfig().roots, filename);
    if (!current || current.real !== folder.real || checked.real !== resolved.real || !effectiveCapabilities(getConfig()).read)
      throw new Error('Project instructions changed location or permission while being read');
    return { directory: current.virtual, text: text.trim() ? text : '', truncated: bytes > budget };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const current = scope.sessionId ? await getSessionProject(scope.sessionId) : await projectWorkspace(scope.projectId!);
      if (current?.real === folder.real) return { ...directoryOnly, directory: current.virtual };
    }
    // Do not expose native filesystem paths through the browser bridge's error response.
    throw new Error('Could not read the selected folder\'s AGENTS.md safely');
  }
}

/** Preserve Core/task; reduce AGENTS to 5k before sharing remaining space across Skills. */
export function fitSessionPrompt(text: string, core: string, agents: ProjectInstructions | null = null, budget = limits, skills: SelectedSkill[] = []): string {
  const fits = (value: string): boolean => value.length <= Math.min(MAX_CHATGPT_MESSAGE_CHARS, budget.maxChars) &&
    Buffer.byteLength(value, 'utf8') <= budget.maxBytes;
  const projectHeader = agents ? `Selected project directory: ${agents.directory}\nUse this directory as your default working directory and keep task work there unless the user or task requires another approved location. This project association grants no additional filesystem permissions.` : '';
  const mandatory = [core, projectHeader].filter(Boolean).join('\n\n');
  const base = prependUserPrompt(text, mandatory);
  if (!fits(base)) throw new Error('The message and main instructions exceed the delivery limit (maximum 96,000 characters). Shorten the message or standing instructions.');
  const content = agents?.text.replace(/\r\n?/g, '\n') ?? '';
  const prefix = (value: string, length: number): string => {
    if (length > 0 && length < value.length && /[\uD800-\uDBFF]/.test(value[length - 1]!)) length--;
    return value.slice(0, length);
  };
  const render = (length: number, skillCap = Infinity): string => {
    const sections = skills.map(skill => {
      const body = prefix(skill.text, skillCap);
      const notice = body.length < skill.text.length
        ? `\n\n[Shortened to fit the message. Read /skills/${skill.id}/SKILL.md for the remaining instructions.]` : '';
      return `# Selected skill: /${skill.id}\n\n<SKILL_INSTRUCTIONS>\n${body}${notice}\n</SKILL_INSTRUCTIONS>`;
    });
    if (agents && content) sections.push(`${projectHeader}\n\n# AGENTS.md instructions for ${agents.directory}\n\n<INSTRUCTIONS>\n${prefix(content, length)}${length < content.length || agents.truncated ? cutNotice : ''}\n</INSTRUCTIONS>`);
    else if (projectHeader) sections.push(projectHeader);
    return prependUserPrompt(text, [core, ...sections].filter(Boolean).join('\n\n'));
  };
  const full = render(content.length);
  if (fits(full)) return full;
  const largestFit = (low: number, high: number, candidate: (n: number) => string): string => {
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(candidate(middle))) low = middle;
      else high = middle - 1;
    }
    return candidate(low);
  };
  // Without Skills, retain the existing AGENTS-only fitting behavior.
  if (!skills.length) {
    if (!fits(render(0))) return base;
    return largestFit(0, content.length, n => render(n));
  }
  // Include the whole code point crossing the floor rather than dropping below it.
  let floor = Math.min(5_000, content.length);
  if (floor < content.length && /[\uD800-\uDBFF]/.test(content[floor - 1] ?? '')) floor++;
  if (fits(render(floor))) return largestFit(floor, content.length, n => render(n));
  // A common prefix cap shares space across all selected files; later skills never vanish.
  if (!fits(render(floor, 0))) throw new Error('The message, main instructions, 5,000-character AGENTS minimum and selected skill references exceed the delivery limit. Shorten the message or standing instructions.');
  return largestFit(0, Math.max(...skills.map(skill => skill.text.length)), n => render(floor, n));
}

/** Opening normal/worker messages only. Callers own first-message eligibility;
 * follow-ups, helpers, handoff requests and resumed bootstraps never call this. */
export async function prepareSessionPrompt(text: string, scope: PromptScope = {}, budget = limits, authored = text): Promise<string> {
  const core = await currentCoreInstructions();
  const skills = await selectedSkillInstructions(authored);
  fitSessionPrompt(text, core, null, budget); // Only Core/task overflow is mandatory.
  return fitSessionPrompt(text, core, await projectInstructions(scope), budget, skills);
}

/** Explicit follow-up selection adds Skills only, never repeats opening setup. */
export async function prepareSkillFollowup(text: string, authored: string, budget = limits): Promise<string> {
  const skills = await selectedSkillInstructions(authored);
  return skills.length ? fitSessionPrompt(text, '', null, budget, skills) : text;
}
