/** Codex metadata compatibility from igorbelchior86's #260, with one parser per format. */
import { load, JSON_SCHEMA } from 'js-yaml';
import { parse } from 'smol-toml';
import type { SkillMetadata } from '../shared/skills.js';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('Skill metadata must contain plain text');
  const text = value.trim();
  if (text.length > max) throw new Error(`Skill metadata exceeds ${max} characters`);
  return text || undefined;
}
function boolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error('Skill policy values must be true or false');
  return value;
}
function yaml(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('Skill metadata exceeds 64 KiB');
  const value: unknown = load(text, { schema: JSON_SCHEMA, maxDepth: 24, maxAliases: 0 });
  const parsed = object(value);
  if (!parsed) throw new Error('Skill metadata must be a mapping');
  const pending: unknown[] = [parsed];
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (++nodes > 4096) throw new Error('Skill metadata contains too many values');
    if (Array.isArray(item)) pending.push(...item);
    else {
      const mapping = object(item);
      if (mapping) for (const [key, child] of Object.entries(mapping)) pending.push(key, child);
    }
  }
  return parsed;
}

export function parseSkillFrontmatter(text: string): { name: string; description: string; shortDescription?: string } {
  const header = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(text);
  if (!header) throw new Error('Discovered skills require YAML frontmatter with name and description');
  const parsed = yaml(header[1]!);
  const name = string(parsed.name, 160);
  const description = string(parsed.description, 1024);
  if (!name || !description) throw new Error('Discovered skills need a name and description');
  const shortDescription = string(object(parsed.metadata)?.['short-description'], 240);
  return { name: name.replace(/\s+/g, ' '), description, ...(shortDescription ? { shortDescription } : {}) };
}

export function parseSkillInterface(text: string): SkillMetadata {
  const parsed = yaml(text);
  const ui = object(parsed.interface);
  const policy = object(parsed.policy);
  if (parsed.policy !== undefined && !policy) throw new Error('Skill policy must be a mapping');
  const displayName = string(ui?.display_name, 160);
  const shortDescription = string(ui?.short_description, 240);
  const defaultPrompt = string(ui?.default_prompt, 4000);
  const dependencies = object(parsed.dependencies)?.tools;
  if (dependencies !== undefined && (!Array.isArray(dependencies) || dependencies.length > 32)) throw new Error('A skill supports at most 32 dependency descriptions');
  const result: SkillMetadata = { allowImplicitInvocation: boolean(policy?.allow_implicit_invocation) ?? true };
  if (displayName) result.displayName = displayName;
  if (shortDescription) result.shortDescription = shortDescription;
  if (defaultPrompt) result.defaultPrompt = defaultPrompt;
  if (Array.isArray(dependencies)) result.dependencies = dependencies.map(value => {
    const row = object(value);
    const type = string(row?.type, 80), name = string(row?.value, 200), description = string(row?.description, 500);
    if (!type || !name) throw new Error('Skill dependency metadata needs type and value');
    return { type, value: name, ...(description ? { description } : {}) };
  });
  return result;
}

export interface SkillConfiguration {
  includeInstructions?: boolean;
  bundledEnabled?: boolean;
  maxContextTokens?: number;
  rules: Array<{ name?: string; path?: string; enabled: boolean }>;
}
export function parseSkillConfiguration(text: string): SkillConfiguration {
  if (Buffer.byteLength(text, 'utf8') > 128_000) throw new Error('Skills configuration exceeds 128,000 bytes');
  const raw = parse(text).skills;
  if (raw === undefined) return { rules: [] };
  const section = object(raw);
  if (!section) throw new Error('Skills configuration must be a table');
  const result: SkillConfiguration = { rules: [] };
  const include = boolean(section.include_instructions), bundled = boolean(object(section.bundled)?.enabled);
  if (include !== undefined) result.includeInstructions = include;
  if (bundled !== undefined) result.bundledEnabled = bundled;
  if (section.max_context_tokens !== undefined) {
    const count = section.max_context_tokens;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) throw new Error('Skills max_context_tokens must be a positive integer');
    result.maxContextTokens = Math.min(count, 10_000);
  }
  if (section.config !== undefined) {
    if (!Array.isArray(section.config) || section.config.length > 256) throw new Error('Skills configuration supports at most 256 rules');
    result.rules = section.config.map(value => {
      const row = object(value);
      const name = string(row?.name, 160), filename = string(row?.path, 4096), enabled = boolean(row?.enabled);
      if (Number(!!name) + Number(!!filename) !== 1 || enabled === undefined) throw new Error('Each Skills rule needs one name or path and an enabled flag');
      return { ...(name ? { name } : { path: filename! }), enabled };
    });
  }
  return result;
}
