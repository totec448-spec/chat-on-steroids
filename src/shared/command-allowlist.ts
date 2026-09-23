export const MAX_COMMAND_ALLOWLIST_RULES = 100;
export const MAX_COMMAND_ALLOWLIST_RULE_CHARS = 1000;

export type CommandAllowlistShell = 'zsh' | 'bash' | 'powershell' | 'sh' | 'cmd';

export interface CommandAllowlistSettings {
  enabled: boolean;
  rules: string[];
}

export interface CommandAllowlistIssue {
  line: number;
  message: string;
}

interface ParsedInvocation {
  args: string[];
  wildcard: boolean;
}

export type CommandAllowlistDecision =
  | { allowed: true; args: string[][] }
  | { allowed: false; commandIndex: number; kind: 'unsupported' | 'unmatched' | 'invalid-policy'; detail: string };

type ParseMode = 'command' | 'rule';
type ParseShell = CommandAllowlistShell | 'neutral';

function unsupported(detail: string): never {
  throw new Error(detail);
}

function parseInvocation(source: string, shell: ParseShell, mode: ParseMode): ParsedInvocation {
  let index = 0;
  const args: string[] = [];
  let wildcard = false;
  const skipSpace = (): void => {
    while (source[index] === ' ' || source[index] === '\t') index += 1;
  };

  skipSpace();
  // PowerShell needs its call operator before a quoted executable path. Accept it only in
  // that leading position and compare the executable itself with the saved rule.
  if (mode === 'command' && shell === 'powershell' && source[index] === '&') {
    if (source[index + 1] !== ' ' && source[index + 1] !== '\t') {
      unsupported('PowerShell call operator & must be followed by an executable.');
    }
    index += 1;
    skipSpace();
  }

  while (index < source.length) {
    if (source[index] === '\r' || source[index] === '\n') unsupported('Newlines are not supported.');
    if (mode === 'rule' && source[index] === '*') {
      if (args.length === 0 || source.slice(index + 1).trim() !== '') {
        unsupported('The wildcard must be a standalone final argument after an executable.');
      }
      wildcard = true;
      index = source.length;
      break;
    }

    let value = '';
    let hasSegment = false;
    while (index < source.length && source[index] !== ' ' && source[index] !== '\t') {
      const character = source[index]!;
      if (character === '\r' || character === '\n') unsupported('Newlines are not supported.');
      if (character === '"' || character === "'") {
        if (character === "'" && shell === 'cmd') unsupported('Single quotes do not quote arguments in cmd.exe.');
        if (hasSegment) unsupported('Quoted arguments must be wholly quoted.');
        const quote = character;
        hasSegment = true;
        index += 1;
        let closed = false;
        while (index < source.length) {
          const quoted = source[index]!;
          if (quoted === quote) {
            closed = true;
            index += 1;
            break;
          }
          if (quoted === '\r' || quoted === '\n') unsupported('Newlines are not supported.');
          if (quote === '"') {
            if ((shell === 'bash' || shell === 'sh' || shell === 'zsh') && (quoted === '$' || quoted === '`' || quoted === '\\')) {
              unsupported('Expansion and escaping inside double quotes are not supported.');
            }
            if (shell === 'powershell' && (quoted === '$' || quoted === '`')) {
              unsupported('PowerShell expansion and escaping inside double quotes are not supported.');
            }
            if (shell === 'cmd' && (quoted === '%' || quoted === '!')) {
              unsupported('cmd.exe variable expansion is not supported.');
            }
          }
          value += quoted;
          index += 1;
        }
        if (!closed) unsupported(`Unclosed ${quote === '"' ? 'double' : 'single'} quote.`);
        if (index < source.length && source[index] !== ' ' && source[index] !== '\t') {
          unsupported('Quoted arguments must be wholly quoted.');
        }
        continue;
      }

      const commonOperator = '|;&<>(){}\r\n'.includes(character);
      const expansion = character === '$' || character === '`';
      const glob = character === '*' || character === '?' || character === '[' || character === ']';
      const comment = character === '#';
      const posixEscape = character === '\\' && (shell === 'bash' || shell === 'sh' || shell === 'zsh');
      const posixTilde = character === '~' && (shell === 'bash' || shell === 'sh' || shell === 'zsh');
      const cmdEscape = shell === 'cmd' && (character === '^' || character === '%' || character === '!');
      const powershellSyntax = shell === 'powershell' && (character === ',' || character === '`' || (character === '@' && value.length === 0));
      if (commonOperator || expansion || glob || comment || posixEscape || posixTilde || cmdEscape || powershellSyntax) {
        unsupported(`Unsupported shell syntax ${JSON.stringify(character)}.`);
      }
      hasSegment = true;
      value += character;
      index += 1;
    }
    if (!hasSegment) unsupported('Expected a literal argument.');
    args.push(value);
    skipSpace();
  }

  if (args.length === 0) unsupported('The command is empty.');
  if (mode === 'command' && (shell === 'bash' || shell === 'sh' || shell === 'zsh') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!)) {
    unsupported('Leading environment assignments are not supported.');
  }
  return { args, wildcard };
}

export function validateCommandAllowlistRule(rule: string): string | null {
  if (rule.length > MAX_COMMAND_ALLOWLIST_RULE_CHARS) {
    return `Rule is longer than ${MAX_COMMAND_ALLOWLIST_RULE_CHARS} characters.`;
  }
  try {
    parseInvocation(rule.trim(), 'neutral', 'rule');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid rule.';
  }
}

export function parseCommandAllowlistText(text: string): { rules: string[]; issues: CommandAllowlistIssue[] } {
  const rules: string[] = [];
  const issues: CommandAllowlistIssue[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const rule = raw.trim();
    if (!rule) continue;
    if (rules.length >= MAX_COMMAND_ALLOWLIST_RULES) {
      issues.push({ line: index + 1, message: `At most ${MAX_COMMAND_ALLOWLIST_RULES} rules are allowed.` });
      continue;
    }
    const message = validateCommandAllowlistRule(rule);
    if (message) issues.push({ line: index + 1, message });
    else rules.push(rule);
  }
  return { rules, issues };
}

function ruleMatches(rule: ParsedInvocation, args: readonly string[]): boolean {
  if (rule.wildcard ? args.length < rule.args.length : args.length !== rule.args.length) return false;
  return rule.args.every((argument, index) => argument === args[index]);
}

export function evaluateCommandAllowlist(
  policy: CommandAllowlistSettings,
  commands: readonly string[],
  shell: CommandAllowlistShell
): CommandAllowlistDecision {
  if (!policy.enabled) return { allowed: true, args: [] };

  const rules: ParsedInvocation[] = [];
  for (const [index, rule] of policy.rules.entries()) {
    const message = validateCommandAllowlistRule(rule);
    if (message) {
      return { allowed: false, commandIndex: 0, kind: 'invalid-policy', detail: `Saved rule ${index + 1} is invalid: ${message}` };
    }
    rules.push(parseInvocation(rule.trim(), 'neutral', 'rule'));
  }

  const parsed: string[][] = [];
  for (const [index, command] of commands.entries()) {
    let invocation: ParsedInvocation;
    try {
      invocation = parseInvocation(command, shell, 'command');
    } catch (error) {
      return { allowed: false, commandIndex: index, kind: 'unsupported', detail: error instanceof Error ? error.message : 'Unsupported shell syntax.' };
    }
    parsed.push(invocation.args);
    if (!rules.some((rule) => ruleMatches(rule, invocation.args))) {
      return { allowed: false, commandIndex: index, kind: 'unmatched', detail: 'No allowlist rule matched the executable and complete argument list.' };
    }
  }
  return { allowed: true, args: parsed };
}

export function commandHasSameArguments(expected: readonly string[], command: string, shell: CommandAllowlistShell): boolean {
  try {
    const parsed = parseInvocation(command, shell, 'command').args;
    return parsed.length === expected.length && parsed.every((argument, index) => argument === expected[index]);
  } catch {
    return false;
  }
}
