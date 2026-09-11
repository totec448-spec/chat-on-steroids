import path from 'node:path';
import { readFileStream } from '../codex/filesystem.js';
import { effectiveCapabilities, getConfig } from '../config.js';
import { currentCoreInstructions } from '../mcp/instructions.js';
import { getSessionProject, projectWorkspace } from '../projects.js';
import { resolvePath } from '../sandbox.js';
import { MAX_CHATGPT_MESSAGE_CHARS, prependUserPrompt } from '../../shared/user-prompt.js';

type PromptScope = { sessionId?: string | null; projectId?: string | null };
export type PromptLimits = { maxChars: number; maxBytes: number };
type ProjectInstructions = { directory: string; text: string; truncated: boolean };
const limits: PromptLimits = { maxChars: MAX_CHATGPT_MESSAGE_CHARS, maxBytes: Infinity };
const cutNotice = '\n\n[Cut off because of the message limit. Read AGENTS.md yourself for the remaining instructions.]';

/** One selected folder, never cwd inference, global discovery or a recursive document scan. */
async function projectInstructions(scope: PromptScope): Promise<ProjectInstructions | null> {
  if ((!scope.sessionId && !scope.projectId) || !effectiveCapabilities(getConfig()).read) return null;
  // Existing sessions own their project; a caller-provided project cannot replace that binding.
  const folder = scope.sessionId ? await getSessionProject(scope.sessionId)
    : await projectWorkspace(scope.projectId!);
  if (!folder) return null;
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
    return text.trim() ? { directory: current.virtual, text, truncated: bytes > budget } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Do not expose native filesystem paths through the browser bridge's error response.
    throw new Error('Could not read the selected folder\'s AGENTS.md safely');
  }
}

/** User text and the complete Core prompt are mandatory; only project instructions spend slack. */
export function fitSessionPrompt(text: string, core: string, agents: ProjectInstructions | null = null, budget = limits): string {
  const fits = (value: string): boolean => value.length <= Math.min(MAX_CHATGPT_MESSAGE_CHARS, budget.maxChars) &&
    Buffer.byteLength(value, 'utf8') <= budget.maxBytes;
  const base = prependUserPrompt(text, core);
  if (!fits(base)) throw new Error('The message and main instructions exceed the delivery limit (maximum 96,000 characters). Shorten the message or standing instructions.');
  if (!agents) return base;
  const content = agents.text.replace(/\r\n?/g, '\n');
  const render = (length: number, shortened: boolean): string => {
    // Never split a UTF-16 surrogate pair at the character budget boundary.
    if (length > 0 && /[\uD800-\uDBFF]/.test(content[length - 1]!)) length--;
    const instructions = `# AGENTS.md instructions for ${agents.directory}\n\n<INSTRUCTIONS>\n${content.slice(0, length)}${shortened ? cutNotice : ''}\n</INSTRUCTIONS>`;
    return prependUserPrompt(text, `${core}\n\n${instructions}`);
  };
  const full = render(content.length, agents.truncated);
  if (fits(full)) return full;
  // Include the framing, length header and truncation notice in the exact final budget.
  let low = 0, high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(render(middle, true))) low = middle;
    else high = middle - 1;
  }
  return low > 0 ? render(low, true) : base;
}

/** Opening normal/worker messages only. Callers own first-message eligibility;
 * follow-ups, helpers, handoff requests and resumed bootstraps never call this. */
export async function prepareSessionPrompt(text: string, scope: PromptScope = {}, budget = limits): Promise<string> {
  const core = await currentCoreInstructions();
  fitSessionPrompt(text, core, null, budget); // Reject mandatory overflow before reading optional files.
  return fitSessionPrompt(text, core, await projectInstructions(scope), budget);
}
