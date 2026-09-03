/**
 * Reading a model-issued shell command well enough to stop punishing it for Windows.
 *
 * Four separate jobs, kept together because all four need the same small amount of
 * understanding of one command line: which program actually determined the exit status,
 * and where its arguments begin and end.
 *
 *   1. `repairPowerShellQuoting` — a bash-style backslash-quote inside a double-quoted
 *      argument does not escape anything in PowerShell; it ends the argument, and the
 *      shell then refuses the whole line without running a single statement of it. The
 *      caller's intent is recoverable when bash's rules read the line cleanly and either
 *      PowerShell cannot, or the affected argument is provably ripgrep's pattern slot. The
 *      repair is verified against PowerShell's rules before it is allowed to stand.
 *
 *   2. `nonZeroExitIsBenign` — a search that found nothing is a *result*, not a failure.
 *      `rg` documents exit 1 as "no matches"; recording that as an errored tool call made
 *      roughly one in eight recorded exec calls a lie, and a session's error count stopped
 *      meaning anything. This does not soften real failures: a build that exits 1 is still
 *      an error, and so is a search that exits 1 *while printing its own error line*.
 *
 *   3. `normalizeShellCommand` — PowerShell does not expand `*` or `?` for native programs
 *      the way a POSIX shell does, so `rg pattern *_test.go` hands ripgrep the literal
 *      asterisk and it fails with `os error 123`. The missing step is done here instead: the
 *      glob is expanded against the working directory, exactly as the shell the caller was
 *      writing for would have done, rather than costing a round trip to rediscover the
 *      platform difference.
 *
 *      It is expansion and not translation on purpose. `-g '*_test.go'` looks like the same
 *      request and is not: an expanded operand names entries of *this* directory, while `-g`
 *      is a recursive filter that also matches `sub/nested_test.go`. Returning extra matches
 *      nobody asked for is the one outcome worse than the error, because nothing downstream
 *      can tell that it happened.
 *
 *      For the same reason a glob is only ever expanded in the *first* statement of a command
 *      line. It is expanded here, before anything runs, and the shell would have expanded it
 *      at the moment that statement was reached — the same answer only while nothing has run
 *      in between. `cd sub; rg foo *.ts` would be answered from the directory rg is not going
 *      to run in, and `npm run build; rg foo *.js` from before the files existed. A glob after
 *      the first statement is left alone and gets the hint.
 *
 *      The same function also expands bash brace groups, `src/{main,test}/x`, which PowerShell
 *      has no syntax for and hands to the program as one literal name. That rewrite is textual
 *      and asks the filesystem nothing, so it carries none of the debt above and applies to
 *      every statement. It is kept deliberately narrow, because `{ … }` is also PowerShell's
 *      script-block syntax and rewriting one of those would destroy the command.
 *
 *   4. `execRecoveryHints` — for the failures that cannot be rewritten safely, say what to
 *      do next in the same result rather than leaving the model to guess.
 *
 * Everything here is advisory. Nothing rejects a command; the only two things that change
 * what runs are the narrowly-scoped glob expansion in (3) and the re-quoting in (1), each of
 * which is applied only where the alternative was a line the shell had already refused or a
 * program handed an argument no shell would have given it. A command this file does not
 * understand is passed through untouched. When in doubt it must do nothing: a wrong
 * rewrite is far worse than a missed one.
 */

import { isWindowsPowerShell5, type ShellType } from './codex/shell.js';

/**
 * Programs whose exit code 1 means "found nothing", not "went wrong".
 *
 * All of these reserve a *different* code (usually 2) for real errors, which is what makes
 * the distinction safe to act on. Anything not on this list keeps the old behaviour.
 */
const NO_MATCH_MEANS_EXIT_1 = new Set(['rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'findstr']);

/** Search programs whose glob arguments PowerShell will not expand for them. */
const RIPGREP_NAMES = new Set(['rg', 'ripgrep']);

/**
 * The ripgrep release this option table was read out of.
 *
 * Named so the pin and the table can be checked against each other. Bumping the bundled
 * binary without revisiting the table is exactly how a flag goes missing, and a missing
 * flag does not fail — it silently changes what was searched for.
 */
export const RG_OPTION_TABLE_VERSION = '15.2.0';

/**
 * ripgrep's own option table, derived from `rg --help` of the binary this app ships
 * rather than from memory. Both halves are listed: the flags that consume the next
 * argument, so a glob that is already a flag's *value* is never mistaken for a path
 * operand and rewritten (`-g *.md` must survive this file untouched), and the flags that
 * consume nothing, so the operand after them is known to be one.
 *
 * Getting this wrong is not a failed call, it is a changed one. A flag that consumes the
 * next argument and is not listed here makes that argument look like the search pattern,
 * which makes the *pattern* look like a path — and a path is what this file expands. The
 * live example was `rg --engine pcre2 foo.* src`: with `--engine` unknown, `pcre2` was read
 * as the pattern and `foo.*` was expanded against the working directory, so ripgrep was
 * asked a different question than the one that was typed and answered it successfully.
 *
 * So both halves are listed, and anything in neither is unknown arity: the segment is then
 * left exactly as written. Rewriting nothing is always a safe answer; guessing is not.
 */
export const RG_VALUE_FLAGS = new Set([
  '--after-context', '--before-context', '--color', '--colors', '--context',
  '--context-separator', '--dfa-size-limit', '--encoding', '--engine',
  '--field-context-separator', '--field-match-separator', '--file', '--generate', '--glob',
  '--hostname-bin', '--hyperlink-format', '--iglob', '--ignore-file', '--max-columns',
  '--max-count', '--max-depth', '--max-filesize', '--path-separator', '--pre', '--pre-glob',
  '--regex-size-limit', '--regexp', '--replace', '--sort', '--sortr', '--threads', '--type',
  '--type-add', '--type-clear', '--type-not', '-A', '-B', '-C', '-E', '-M', '-T', '-d', '-e',
  '-f', '-g', '-j', '-m', '-r', '-t'
]);

export const RG_BOOLEAN_FLAGS = new Set([
  '--auto-hybrid-regex', '--binary', '--block-buffered', '--byte-offset', '--case-sensitive',
  '--column', '--count', '--count-matches', '--crlf', '--debug', '--files',
  '--files-with-matches', '--files-without-match', '--fixed-strings', '--follow',
  '--glob-case-insensitive', '--heading', '--help', '--hidden', '--ignore-case',
  '--ignore-file-case-insensitive', '--include-zero', '--invert-match', '--json',
  '--line-buffered', '--line-number', '--line-regexp', '--max-columns-preview', '--mmap',
  '--multiline', '--multiline-dotall', '--no-config', '--no-filename', '--no-ignore',
  '--no-ignore-dot', '--no-ignore-exclude', '--no-ignore-files', '--no-ignore-global',
  '--no-ignore-messages', '--no-ignore-parent', '--no-ignore-vcs', '--no-line-number',
  '--no-messages', '--no-pcre2-unicode', '--no-require-git', '--no-unicode', '--null',
  '--null-data', '--one-file-system', '--only-matching', '--passthru', '--pcre2',
  '--pcre2-version', '--pretty', '--quiet', '--search-zip', '--smart-case', '--sort-files',
  '--stats', '--stop-on-nonmatch', '--text', '--trace', '--trim', '--type-list',
  '--unrestricted', '--version', '--vimgrep', '--with-filename', '--word-regexp', '-.', '-0',
  '-F', '-H', '-I', '-L', '-N', '-P', '-S', '-U', '-V', '-a', '-b', '-c', '-h', '-i', '-l', '-n',
  '-o', '-p', '-q', '-s', '-u', '-v', '-w', '-x', '-z'
]);

/**
 * Flags that fill the search-pattern slot, so the next bare token is a path and not the
 * pattern.
 *
 * Without them `rg -e foo *.go` reads `*.go` as the pattern it has already been given and
 * leaves the glob to fail; `--files` takes no pattern at all and its first operand met the
 * same fate.
 */
const RG_PATTERN_FLAGS = new Set(['-e', '--regexp', '-f', '--file']);
const RG_NO_PATTERN_FLAGS = new Set(['--files', '--type-list']);

interface Token {
  /** Exactly as written, quotes included, so a command can be rebuilt without damage. */
  raw: string;
  /** Quotes stripped, for comparison. */
  value: string;
  quoted: boolean;
}

/**
 * Splits one command line into tokens, respecting single and double quotes.
 *
 * Not a shell parser and not trying to be. It has to be right about quoting only well
 * enough that a quoted argument containing a space or a semicolon is never split, because
 * a mis-split is what would turn a rewrite into a broken command.
 */
function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  let raw = '';
  let value = '';
  let quoted = false;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    if (raw === '') return;
    tokens.push({ raw, value, quoted });
    raw = '';
    value = '';
    quoted = false;
  };

  for (const char of segment) {
    if (quote !== null) {
      raw += char;
      if (char === quote) quote = null;
      else value += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      raw += char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    raw += char;
    value += char;
  }
  flush();
  return tokens;
}

/**
 * Shell syntax this intentionally-small parser cannot model without guessing.
 *
 * Backticks can escape separators/quotes/whitespace. `#` starts comments outside quotes, so
 * a textual `; rg ...` after it may never execute. PowerShell here-strings (`@"` / `@'`) are
 * multiline quoting constructs whose interior may contain every separator this file splits.
 * Any one of those turns a separator-only parse into an unsafe approximation. The caller's
 * command still runs unchanged; we simply decline rewrites and benign-exit inference.
 */
function hasUnsupportedShellLexemes(command: string): boolean {
  if (command.includes('`') || command.includes('@"') || command.includes("@'")) return true;
  let quote: '"' | "'" | null = null;
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return true;
  }
  return false;
}

/** Index of every top-level occurrence of any separator in `seps`, ignoring quoted text. */
function splitTopLevel(command: string, seps: readonly string[], hits?: string[]): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;

  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    // `$( … )`, `@( … )` and plain grouping all hide separators that are not statement
    // boundaries. Depth-tracking keeps `(a; b)` from being read as two statements.
    if (char === '(' || char === '{') depth++;
    else if (char === ')' || char === '}') {
      if (depth === 0) return [command];
      depth--;
    }

    if (depth === 0) {
      const hit = seps.find((sep) => command.startsWith(sep, i));
      if (hit !== undefined) {
        parts.push(current);
        hits?.push(hit);
        current = '';
        i += hit.length - 1;
        continue;
      }
    }
    current += char;
  }
  if (quote !== null || depth !== 0) {
    hits?.splice(0);
    return [command];
  }
  parts.push(current);
  return parts.filter((part) => part.trim() !== '');
}

/**
 * The bare program name of a token, lowercased and stripped of its path and `.exe`.
 *
 * `.exe` and nothing else. Everything this name is used to decide is a claim about a
 * *program's* contract — ripgrep spending exit 1 on "no matches" — and `rg.cmd`, `rg.bat`
 * or `rg.ps1` is a local script that merely happens to be named after it. A wrapper is free
 * to exit 1 for its own reasons, and calling that ripgrep's no-match answer would launder
 * exactly the failure this file exists to stop laundering. So an extension that is not
 * `.exe` stays part of the name, which no set of known programs contains.
 */
function programName(token: Token | undefined): string {
  if (!token) return '';
  const tail = token.value.split(/[\\/]/).pop() ?? '';
  return tail.toLowerCase().replace(/\.exe$/, '');
}

/**
 * PowerShell aliases that are cmdlets despite not being spelled Verb-Noun.
 *
 * Only needed to tell "this stage leaves $LASTEXITCODE alone" from "this stage sets it".
 * Anything not recognised here is assumed to be a program, which is the safe assumption:
 * it can only ever cost an exemption, never grant one.
 */
const CMDLET_ALIASES = new Set([
  'select', 'where', 'foreach', 'sort', 'measure', 'group', 'tee', 'ft', 'fl', 'fw', 'gc',
  'gci', 'gi', 'ls', 'dir', 'cat', 'echo', 'write', 'sls', 'ogv', '%', '?'
]);

/**
 * Cmdlets recognised by name, because nothing about a token's *shape* can prove one.
 *
 * `Verb-Noun` was the obvious test and it is not sound in either half. `docker-compose` and
 * `tunnel-client` have the shape and are programs; narrowing to PowerShell's approved verb
 * list does not save it either, because `test-runner`, `build-tool` and `get-version` are
 * equally plausible executables built from approved verbs. Since the shape cannot decide,
 * only an exact name may, and everything unrecognised is treated as native.
 *
 * That is the safe direction, and the asymmetry is the whole point: a real cmdlet missing
 * from this list costs one benign-exit exemption, while a program mistaken for a cmdlet is
 * skipped, hands the exit code back to the generator, and lets a generator on the no-match
 * list launder that program's genuine failure into "the search found nothing".
 *
 * The list covers the object-processing cmdlets that actually appear as pipeline stages —
 * every hyphenated stage head in the recorded corpus is here — plus the common neighbours.
 */
const KNOWN_CMDLETS = new Set([
  'add-content', 'add-member', 'clear-content', 'compare-object', 'convertfrom-csv',
  'convertfrom-json', 'convertfrom-stringdata', 'convertto-csv', 'convertto-html',
  'convertto-json', 'copy-item', 'export-clixml', 'export-csv', 'format-custom',
  'format-list', 'format-table', 'format-wide', 'get-childitem', 'get-command',
  'get-content', 'get-date', 'get-filehash', 'get-item', 'get-itemproperty',
  'get-location', 'get-member', 'get-process', 'get-random', 'get-unique', 'group-object',
  'import-csv', 'join-path', 'measure-object', 'move-item', 'new-item', 'new-object',
  'out-file', 'out-gridview', 'out-host', 'out-null', 'out-string', 'remove-item',
  'rename-item', 'resolve-path', 'select-object', 'select-string', 'select-xml',
  'set-content', 'set-location', 'sort-object', 'split-path', 'tee-object', 'test-path',
  'where-object', 'write-error', 'write-host', 'write-output', 'write-warning',
  'foreach-object'
]);

/** Whether a pipeline stage is PowerShell's own, and so cannot have set the exit code. */
function looksLikeCmdlet(token: Token | undefined): boolean {
  if (!token) return false;
  // A path or an executable extension names a program, whatever the rest of it looks like.
  if (/[\\/]/.test(token.value)) return false;
  if (/\.(exe|cmd|bat|com|ps1)$/i.test(token.value)) return false;
  const name = token.value.toLowerCase();
  return CMDLET_ALIASES.has(name) || KNOWN_CMDLETS.has(name);
}

/**
 * Downstream pipeline stages that cannot decide what the shell exits with.
 *
 * Being a cmdlet is not enough, which is what this replaced. `Out-File -LiteralPath
 * 'Z:\missing\x.txt'` is a known cmdlet, carries no script block, throws
 * DriveNotFoundException and exits the host with status 1 — and no diagnostic the output
 * guard knows appears. Skipping it and reading the exit code off ripgrep upstream would file
 * that as a search that found nothing. `Write-Error` and `ForEach-Object { exit 1 }` do the
 * same thing by other routes.
 *
 * So nothing is skipped on the strength of its name. These are the exact shapes the recorded
 * sessions actually use to trim ripgrep's output, each argument-free or fixed enough to have
 * nothing left to fail at. Anything else — a cmdlet with arguments, an expression, a block —
 * is status-ambiguous, and an ambiguous stage means no exemption for the line.
 */
const PASSIVE_STAGES = [
  /^(?:select-object|select)\s+-(?:first|last)\s+\d+$/i,
  /^(?:sort-object|sort)$/i,
  /^(?:measure-object|measure)$/i,
  /^out-null$/i
];

function stageIsPassive(segment: string): boolean {
  return PASSIVE_STAGES.some((shape) => shape.test(segment));
}

/**
 * The literal executable token at the head of one pipeline stage.
 *
 * PowerShell needs the call operator to execute a quoted path, so the deterministic bundled
 * ripgrep form produced below is `& 'C:\\...\\rg.exe' ...`. Treat that literal path as the
 * program, but refuse dynamic call-operator forms such as `& $cmd`: their target is runtime
 * state and the command text cannot prove what actually ran.
 */
function stageProgramToken(segment: string): Token | null {
  const tokens = tokenize(segment);
  const first = tokens[0];
  if (!first) return null;
  if (first.value !== '&') return first;
  const target = tokens[1];
  if (!target || !/[\\/]/.test(target.value)) return null;
  return target;
}

/**
 * The program whose exit status the shell will report.
 *
 * PowerShell sets `$LASTEXITCODE` from the last *native* program it ran — the last one in
 * the pipeline, not the first. `cmd /c exit 1 | cmd /c exit 0` leaves 0 behind; reversed, it
 * leaves 1. Cmdlets do not touch it at all, which is why `rg … | Select-Object -First 80`
 * still reports ripgrep's own code even though ripgrep is not the last stage.
 *
 * So: last statement, then the rightmost stage that is a program rather than a cmdlet, and
 * the generator only when every stage after it was PowerShell's own. Reading the generator
 * unconditionally is what would let `rg foo | git diff --exit-code` be filed as an `rg`
 * result — and `rg` is on the list of programs allowed to exit 1 harmlessly, so git failing
 * would have been recorded as a search that found nothing.
 *
 * A stage this cannot classify counts as a program. That direction only ever withholds an
 * exemption, and a real failure recorded as a failure is the outcome to fail towards.
 */
/**
 * The exact token whose process status would determine this command, when the lightweight
 * parse is strong enough to name one.
 *
 * Kept separate from statusDeterminingProgram because the benign-exit decision needs one
 * extra fact the display name intentionally throws away: whether the caller used a path.
 * A profiled PowerShell can define `function rg { ... }` and even `function rg.exe { ... }`,
 * so a bare spelling is not proof that ripgrep.exe ran. A path-qualified spelling cannot be
 * intercepted by that command-name lookup and is therefore materially stronger evidence.
 */
function statusDeterminingToken(command: string): Token | null {
  // The lightweight splitter below deliberately does not implement PowerShell's backtick
  // escape grammar. That is already enough reason for normalizeShellCommand to leave such a
  // line untouched, and it is equally important here: a backtick can escape `;`, `|`, a
  // newline or whitespace, changing which textual fragment actually ran and which process
  // supplied the exit status. Treating an escaped separator as real can make an upstream
  // `cmd /c exit 1` look like a later `rg` no-match and silently launder the failure. With no
  // trustworthy parse there is no trustworthy program name, so withhold the exemption.
  if (hasUnsupportedShellLexemes(command)) return null;
  // A conditional chain decides at run time which of its branches ran, and nothing in the
  // text of it says which one did. `cmd /c exit 1 && rg foo` never reaches ripgrep at all —
  // PowerShell 7 runs the operator, sees the failure and stops — and yet the last statement
  // is still `rg foo`. Reading it would file that exit 1 as a search that found nothing.
  //
  // There is no program this can name honestly, so it names none, and the exemption that
  // depends on the name is withheld. Windows PowerShell 5.1 refuses such a line outright and
  // the output guard catches that; this is the shell where the operators actually work.
  if (splitTopLevel(command, ['&&', '||']).length > 1) return null;
  const statements = splitTopLevel(command, [';', '\n']);
  const last = statements[statements.length - 1];
  if (last === undefined) return null;
  const segments = splitTopLevel(last, ['|']);
  for (let i = segments.length - 1; i > 0; i--) {
    const segment = (segments[i] as string).trim();
    if (stageIsPassive(segment)) continue;
    const first = stageProgramToken(segment);
    // A program here set $LASTEXITCODE and is the answer; a cmdlet here could have decided
    // the status without touching it, and cannot be proven not to have.
    return looksLikeCmdlet(first ?? undefined) ? null : (first ?? null);
  }
  const generator = segments[0];
  if (generator === undefined) return null;
  return stageProgramToken(generator);
}

export function statusDeterminingProgram(command: string): string {
  return programName(statusDeterminingToken(command) ?? undefined);
}

/**
 * Diagnostics that mean the shell itself refused the command line.
 *
 * None of these can coexist with "the search ran and found nothing", so any of them is
 * enough to withhold the benign-exit exemption. Matching one of these on output that was
 * genuinely a search result would only cost an exemption, which is the direction this file
 * is allowed to be wrong in.
 */
const SHELL_REFUSED = new RegExp(
  [
    String.raw`^\s*At line:\d+ char:\d+`,
    String.raw`The token '[^']*' is not a valid statement separator`,
    String.raw`ParserError`,
    String.raw`CommandNotFoundException`,
    String.raw`ParameterBindingException`,
    String.raw`is not recognized as (?:the name of )?a (?:cmdlet|command)`,
    String.raw`is not recognized as an internal or external command`,
    String.raw`The string (?:is missing the terminator|starting:)`,
    String.raw`Missing (?:argument|expression|closing|\))`
  ].join('|'),
  'im'
);

/**
 * git subcommands that only report, and therefore cannot fail after printing.
 *
 * Each of these exits 0 whenever it produced output at all; the ways they exit non-zero are a
 * `fatal:` on stderr with nothing on stdout, or one of the flags below being passed to turn the
 * command into a test. Deliberately not a general list of "read-only programs": the property
 * being relied on is not read-onlyness, it is that a normal run has exactly one exit code.
 */
const GIT_SUBCOMMANDS_THAT_ONLY_REPORT = new Set(['diff', 'log', 'show', 'status', 'blame']);

/** The flags that turn one of the above into a predicate, where exit 1 is the whole point. */
const GIT_FLAGS_THAT_MAKE_THE_EXIT_MEAN_SOMETHING = /^--(?:exit-code|quiet|check)$/i;

/** The one passive stage that stops the pipeline; `-Last` and the rest must drain it first. */
const TRUNCATING_STAGE = /^(?:select-object|select)\s+-first\s+\d+$/i;

/**
 * The generator of a deciding pipeline that `Select-Object -First` cut short, if that is what
 * this command is.
 *
 * `Select-Object -First N` stops the pipeline the moment it has N objects, which kills the native
 * program still writing into it and leaves a non-zero status behind. Measured against Windows
 * PowerShell 5.1: `git diff -- CHANGELOG.md | Select-Object -First 5` exits 1 where the same
 * `git diff` alone exits 0, and `-Wait` — which drains the pipeline instead of stopping it —
 * exits 0 again. Whether the cut actually bites depends on whether the program was still running
 * when N was reached, so a short output exits 0 and a long one exits 1 from the same command.
 *
 * This does not say the exit was benign; it only names the generator, so the caller can ask
 * whether that program had any other way to exit non-zero. The rest of the pipeline must be the
 * passive shapes `statusDeterminingToken` already trusts, for the same reason it trusts them: a
 * stage that could have set the status itself makes the question unanswerable.
 */
function pipelineStopCandidate(command: string): Token | null {
  if (hasUnsupportedShellLexemes(command)) return null;
  if (splitTopLevel(command, ['&&', '||']).length > 1) return null;
  const statements = splitTopLevel(command, [';', '\n']);
  const last = statements[statements.length - 1];
  if (last === undefined) return null;
  const segments = splitTopLevel(last, ['|']);
  if (segments.length < 2) return null;
  let truncates = false;
  for (let i = 1; i < segments.length; i++) {
    const segment = (segments[i] as string).trim();
    if (!stageIsPassive(segment)) return null;
    if (TRUNCATING_STAGE.test(segment)) truncates = true;
  }
  if (!truncates) return null;
  const generator = segments[0];
  if (generator === undefined) return null;
  return stageProgramToken(generator);
}

/**
 * The subcommand a `git …` generator names, when the generator is git and the name is usable.
 *
 * The subcommand must be the token straight after `git`. `git -C dir diff` reads the same to a
 * person and is refused here, because proving which token is the subcommand means knowing which
 * of git's own options take a value, and being wrong about that is how `git -c x=y --exit-code`
 * would slip through. Withholding the exemption from a form nobody recorded costs nothing.
 *
 * Null when a predicate flag is present, because exit 1 is then the answer the caller asked for
 * rather than an absence of output, and no caller of this may treat it as one.
 *
 * Command-name lookup cannot be intercepted on this surface: exec.ts launches every exec_command
 * through `powershell -NoProfile`, so unlike the bare `rg` case there is no profile function that
 * could be answering to the name `git`.
 */
function gitGeneratorSubcommand(command: string): string | null {
  const statements = splitTopLevel(command, [';', '\n']);
  const last = statements[statements.length - 1];
  if (last === undefined) return null;
  const generator = splitTopLevel(last, ['|'])[0];
  if (generator === undefined) return null;
  const tokens = tokenize(generator);
  if (programName(tokens[0]) !== 'git') return null;
  const subcommand = tokens[1];
  if (subcommand === undefined) return null;
  if (tokens.some((argument) => GIT_FLAGS_THAT_MAKE_THE_EXIT_MEAN_SOMETHING.test(argument.value))) return null;
  return subcommand.value.toLowerCase();
}

/** Whether a cut pipeline's generator is a git command with no second reason to exit non-zero. */
function cutPipelineGeneratorOnlyReports(command: string): boolean {
  const token = pipelineStopCandidate(command);
  if (token === null) return false;
  if (programName(token) !== 'git') return cutPipelineGeneratorIsProvenSearch(token);
  const subcommand = gitGeneratorSubcommand(command);
  return subcommand !== null && GIT_SUBCOMMANDS_THAT_ONLY_REPORT.has(subcommand);
}

/**
 * Whether the first pipeline stage is the one whose status the shell reported.
 *
 * `statusDeterminingToken` walks in from the right and stops at the first stage that could
 * have set the status itself, so a generator only decides when everything after it is one of
 * PowerShell's own passive shapes. Asking this separately is what keeps a git-subcommand read
 * off the generator honest: without it, `git grep foo | git diff --exit-code` would have its
 * predicate failure filed as a search that found nothing.
 */
function generatorDecidesStatus(command: string): boolean {
  const statements = splitTopLevel(command, [';', '\n']);
  const last = statements[statements.length - 1];
  if (last === undefined) return false;
  return splitTopLevel(last, ['|'])
    .slice(1)
    .every((segment) => stageIsPassive(segment.trim()));
}

/** A path-proven search generator whose own failures are visible in its output. */
function cutPipelineGeneratorIsProvenSearch(token: Token): boolean {
  if (!NO_MATCH_MEANS_EXIT_1.has(programName(token))) return false;
  return /[\\/]/.test(token.value);
}

/** Observed PowerShell native-pipeline cut statuses, including unsigned -1. */
const CUT_PIPELINE_EXIT_CODES = new Set([1, -1, 0xff_ff_ff_ff]);

/** A diagnostic line a search program printed about itself, rather than a match. */
const SEARCH_DIAGNOSTIC = /^\s*(rg|ripgrep|grep|egrep|fgrep|findstr):/im;

/** Command output with single-command response framing removed when present. */
function commandOutputBody(outputText: string): string[] {
  const lines = outputText.split('\n').map((line) => line.replace(/\r$/, ''));
  const start = lines.indexOf('Output:');
  return (start < 0 ? lines : lines.slice(start + 1)).filter(
    (line) => line.trim() !== '' && !line.startsWith('---') && !line.startsWith('Warning: truncated output')
  );
}

/** A path-proven search answered for at least one path while naming another path it could not read. */
function searchAnsweredDespiteBadPath(command: string, outputText: string): boolean {
  if (splitTopLevel(command, [';', '\n']).length !== 1) return false;
  const token = statusDeterminingToken(command);
  if (token === null || !/[\\/]/.test(token.value) || !NO_MATCH_MEANS_EXIT_1.has(programName(token))) return false;
  if (!SEARCH_DIAGNOSTIC.test(outputText)) return false;
  return commandOutputBody(outputText).some((line) => !SEARCH_DIAGNOSTIC.test(line));
}

/**
 * Whether a non-zero exit is a reported result rather than a failure.
 *
 * Both conditions matter. The program must be one that spends exit 1 on "no matches", and
 * it must not have printed an error of its own — ripgrep given an unexpandable glob prints
 * `rg: …: IO error …` and still exits 1, and that call really did fail. Checking the output
 * is what keeps this from laundering the very failures fix (2) exists to surface.
 */
export function nonZeroExitIsBenign(
  command: string,
  exitCode: number | null,
  outputText: string
): boolean {
  if (exitCode === null) return false;
  // A shell refusal means the status cannot be interpreted as the child's result.
  if (SHELL_REFUSED.test(outputText)) return false;
  // A proven reporting generator cut by `Select-Object -First` can leave a native non-zero status.
  if (
    CUT_PIPELINE_EXIT_CODES.has(exitCode) &&
    cutPipelineGeneratorOnlyReports(command) &&
    commandOutputBody(outputText).length > 0 &&
    !/^\s*(?:fatal|error):/im.test(outputText) &&
    !SEARCH_DIAGNOSTIC.test(outputText)
  ) {
    return true;
  }
  if (exitCode === 2) return searchAnsweredDespiteBadPath(command, outputText);
  if (exitCode !== 1) return false;
  const token = statusDeterminingToken(command);
  const program = programName(token ?? undefined);
  // `git grep` spends exit 1 on "found nothing" for the same reason ripgrep does, and is the
  // spelling a model reaches for once it is already running git. It needs no path-qualified
  // form to prove itself: `powershell -NoProfile` leaves no way for a profile function to be
  // answering to the name `git`. It does need to be the stage that decided the status, and to
  // have printed no diagnostic of its own — a bad pathspec is `fatal:` and exit 128, so this
  // withholds nothing git actually produces, and costs nothing if git ever changes its mind.
  if (program === 'git') {
    return (
      gitGeneratorSubcommand(command) === 'grep' &&
      generatorDecidesStatus(command) &&
      !/^\s*(?:fatal|error):/im.test(outputText)
    );
  }
  if (!NO_MATCH_MEANS_EXIT_1.has(program)) return false;
  // A bare command name is not proof of which implementation ran. PowerShell profiles can
  // define functions/aliases named `rg` and even `rg.exe`; cmd.exe searches the current
  // directory before PATH and can pick up a local rg.cmd; POSIX shells have functions/aliases
  // of their own. Any of those may exit 1 with no diagnostic for a reason unrelated to search
  // results. A path-qualified token is the one representation the command text can actually
  // prove. tools-core binds ordinary PowerShell/POSIX `rg` calls to the bundled executable before
  // they reach this classifier, preserving the common no-match case without trusting names.
  const pathQualified = token !== null && /[\\/]/.test(token.value);
  if (!pathQualified) return false;
  return !/^\s*(rg|ripgrep|grep|egrep|fgrep|findstr):/im.test(outputText);
}

/**
 * Binds a bare PowerShell/POSIX `rg`/`ripgrep` invocation to the binary the app deliberately ships.
 *
 * This project already parses ripgrep arguments against the bundled version's option table and
 * prepends that binary's directory to child PATH. Leaving shell command-name lookup in front of
 * it broke that contract: a function/alias named `rg` can win before PATH and both receive
 * rewrites intended for ripgrep 15.2.0 and make its exit status impossible to attribute safely.
 *
 * A shell-quoted absolute path (plus PowerShell's call operator where needed) makes the intended
 * binary explicit.
 * Only a literal bare program token at a top-level statement/pipeline head is changed. Dynamic
 * invocations, already-qualified paths, quoted strings and commands containing backtick escapes
 * stay untouched; the latter cannot be split safely by this lightweight parser.
 */
export function bindBundledRipgrep(command: string, shellType: ShellType, executable: string | null): string {
  if (shellType === 'cmd' || !executable || hasUnsupportedShellLexemes(command)) return command;
  let changed = false;
  const bound = rebuild(command, [';', '&&', '||', '\n'], (statement) =>
    rebuild(statement, ['|'], (segment) => {
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment);
      if (!match) return segment;
      const lead = match[1] ?? '';
      const body = match[2] ?? '';
      const trail = match[3] ?? '';
      const first = tokenize(body)[0];
      if (!first || first.raw !== first.value) return segment;
      if (!/^(?:rg|rg\.exe|ripgrep|ripgrep\.exe)$/i.test(first.value)) return segment;
      if (/[\\/]/.test(first.value)) return segment;
      const at = body.indexOf(first.raw);
      if (at < 0) return segment;
      changed = true;
      const replacement = shellType === 'powershell'
        ? `& ${quoteArgument(executable)}`
        : quotePosixArgument(executable);
      return `${lead}${body.slice(0, at)}${replacement}${body.slice(at + first.raw.length)}${trail}`;
    })
  );
  return changed ? bound : command;
}

/** One literal POSIX-shell argument. Single quotes close/reopen around an embedded apostrophe. */
function quotePosixArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Where one double-quoted string sits in a command line, read under bash's escape rules. */
interface QuotedRegion {
  /** Index of the opening quote. */
  open: number;
  /** Index of the closing quote. */
  close: number;
  /** Everything between the quotes, exactly as written. */
  body: string;
}

/**
 * Whether PowerShell would reach the end of this line with every quote closed.
 *
 * PowerShell's escapes are its own. Inside a double-quoted string a backtick escapes the next
 * character and a doubled quote stands for one quote; inside a single-quoted string nothing
 * escapes but a doubled apostrophe. A backslash is an ordinary character in both, which is the
 * entire point of this function: a bash-style backslash-quote does not escape anything here, it
 * *closes* the string the caller meant it to sit inside, and every character after that is read
 * as a different kind of token.
 */
function powershellQuotingTerminates(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);
    if (quote === null) {
      if (char === '"' || char === "'") quote = char;
      continue;
    }
    if (quote === '"' && char === '`') {
      i++;
      continue;
    }
    if (char === quote) {
      if (command.charAt(i + 1) === quote) {
        i++;
        continue;
      }
      quote = null;
    }
  }
  return quote === null;
}

/**
 * The double-quoted strings in a command line, read the way the caller evidently wrote it.
 *
 * bash's rules, not PowerShell's: a backslash escapes the next character both outside quotes
 * and inside double quotes, and a single-quoted string is literal throughout. Returns null when
 * even this reading leaves a quote open, because then there is no coherent intent to recover
 * and nothing below is entitled to act.
 */
function bashDoubleQuotedRegions(command: string): QuotedRegion[] | null {
  const regions: QuotedRegion[] = [];
  let quote: '"' | "'" | null = null;
  let open = -1;

  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);
    if (quote === null) {
      if (char === '\\') i++;
      else if (char === '"') {
        quote = '"';
        open = i;
      } else if (char === "'") quote = "'";
      continue;
    }
    if (quote === '"') {
      if (char === '\\') i++;
      else if (char === '"') {
        regions.push({ open, close: i, body: command.slice(open + 1, i) });
        quote = null;
      }
      continue;
    }
    if (char === "'") quote = null;
  }

  return quote === null ? regions : null;
}

/**
 * Re-quotes a bash-style escaped-quote argument into the one form that survives PowerShell.
 *
 * The measured failure, twice in one session: a model writes
 * `rg -n "a|state === \"starting" src`, PowerShell reads the backslash as an ordinary
 * character and the quote after it as the end of the string, and refuses the entire line with
 * TerminatorExpectedAtEndOfString. Nothing runs — not the search, and not the `git diff` two
 * statements earlier on the same line — and the model receives a parser error that never
 * mentions the escape character that caused it.
 *
 * The fix is not the obvious one. Both escapes PowerShell *does* accept make the line parse and
 * then corrupt the argument on its way to a native program. Measured on this machine, passing
 * an argument written with a doubled quote reaches the child as one argument with the quote
 * dropped and the following argument swallowed: `argc=1, arg[0]=<state === starting second>`.
 * Windows PowerShell 5.1 does not re-escape an embedded quote when it builds a child's command
 * line, so the only spelling that arrives intact is a literal backslash-quote in the argument
 * text, which CommandLineToArgvW then unescapes on the other side. The caller's backslash-quote
 * was therefore already right; only the quotes around it were wrong. So this changes the
 * enclosing double quotes to single quotes and leaves the body byte for byte, doubling any
 * apostrophe inside it because that is how a single-quoted PowerShell string spells one.
 *
 * It acts only where all three of these hold, and does nothing at all otherwise:
 *
 *   1. PowerShell either would not have reached the end of the line with its quotes closed, or
 *      the affected argument is proven to be ripgrep's search-pattern slot. The second case is
 *      needed because an even number of bash-style escaped quotes can make the line rebalance
 *      while still handing PowerShell code to its parser or corrupting the regex sent to rg.
 *   2. Reading the same line under bash's escape rules does close every quote. That is what
 *      makes the intended token boundaries knowable rather than guessed.
 *   3. The repaired line, re-scanned under PowerShell's rules, closes every quote. A rewrite is
 *      applied only after it has been proven to fix the thing it was made for.
 *
 * A body holding `$`, a backtick, or a doubled backslash is left alone even when all three
 * hold. `"$env:X\src"` wants an interpolation that single quotes would kill, and a doubled
 * backslash means one backslash to bash and two inside a single-quoted string. Either would
 * change what the program is asked, which is the one outcome worse than the error being
 * repaired.
 */
export function repairPowerShellQuoting(cmd: string, shellType: ShellType): NormalizedCommand {
  if (shellType !== 'powershell') return { cmd, notes: [] };
  if (!cmd.includes('\\"')) return { cmd, notes: [] };
  const powerShellBalanced = powershellQuotingTerminates(cmd);
  // A balanced line might be valid PowerShell. The one safe exception below proves the
  // affected token is ripgrep's pattern, but that proof uses the lightweight command parser
  // and therefore inherits its fail-closed boundary around backticks/comments/here-strings.
  if (powerShellBalanced && hasUnsupportedShellLexemes(cmd)) return { cmd, notes: [] };
  const regions = bashDoubleQuotedRegions(cmd);
  if (regions === null) return { cmd, notes: [] };

  let out = '';
  let cursor = 0;
  let repaired = 0;
  for (const region of regions) {
    if (!region.body.includes('\\"')) continue;
    if (powerShellBalanced && !isRipgrepPatternRegion(cmd, region)) continue;
    // Interpolation, an escape this reading does not model, or a backslash whose meaning
    // differs between the two shells. Any of them makes the move lossy; leave it to the hint.
    if (/[$`]|\\\\/.test(region.body)) continue;
    out += cmd.slice(cursor, region.open);
    out += `'${region.body.replace(/'/g, "''")}'`;
    cursor = region.close + 1;
    repaired++;
  }
  if (repaired === 0) return { cmd, notes: [] };
  out += cmd.slice(cursor);
  if (!powershellQuotingTerminates(out)) return { cmd, notes: [] };

  return {
    cmd: out,
    notes: [
      'A backslash does not escape a quote in PowerShell, only a backtick does, so the ' +
        'double-quoted argument ended at that backslash and would have been split, parsed as ' +
        'PowerShell code, or sent to the native program with a corrupted value. The argument ' +
        'was re-quoted with single quotes, ' +
        'which is the spelling that works here. The backslash before the quote is correct and ' +
        'has been kept: a literal quote only survives the trip to a native program if it ' +
        'arrives backslash-escaped, and the two escapes PowerShell accepts inside double ' +
        'quotes deliver it stripped and swallow the argument after it. Write patterns ' +
        'containing quotes in single quotes.'
    ]
  };
}

/**
 * The pipeline/statement prefix immediately before one bash-read quoted argument.
 *
 * This scanner exists only for balanced-line quote recovery. It uses the same bash reading
 * that found the region, tracks grouping, and returns null on anything it cannot place at a
 * top-level command boundary. The returned text ends immediately before the opening quote.
 */
function bashSegmentPrefix(command: string, end: number): string | null {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  let start = 0;

  for (let i = 0; i < end; i++) {
    const char = command.charAt(i);
    if (quote === '"') {
      if (char === '\\') i++;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(' || char === '{') {
      depth++;
      continue;
    }
    if (char === ')' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;

    if (char === ';' || char === '|' || char === '\n' || char === '\r') {
      start = i + 1;
      if (
        (char === '|' && command.charAt(i + 1) === '|') ||
        (char === '\r' && command.charAt(i + 1) === '\n')
      ) {
        start = ++i + 1;
      }
      continue;
    }
    if (char === '&' && command.charAt(i + 1) === '&') {
      start = ++i + 1;
    }
  }

  return quote === null && depth === 0 ? command.slice(start, end) : null;
}

/** Whether the next argument after `tokens` is provably ripgrep's search pattern. */
function nextRipgrepArgumentIsPattern(tokens: readonly Token[]): boolean {
  if (!RIPGREP_NAMES.has(programName(tokens[0]))) return false;
  let seenPattern = false;
  let optionsEnded = false;
  let pendingValue: 'pattern' | 'other' | null = null;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (pendingValue !== null) {
      if (pendingValue === 'pattern') seenPattern = true;
      pendingValue = null;
      continue;
    }
    if (!optionsEnded && token.value === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.value.startsWith('-')) {
      const flag = token.value.split('=')[0] as string;
      if (!RG_VALUE_FLAGS.has(flag) && !RG_BOOLEAN_FLAGS.has(flag)) return false;
      if (RG_NO_PATTERN_FLAGS.has(flag)) seenPattern = true;
      if (RG_VALUE_FLAGS.has(flag)) {
        if (token.value.includes('=')) {
          if (RG_PATTERN_FLAGS.has(flag)) seenPattern = true;
        } else {
          pendingValue = RG_PATTERN_FLAGS.has(flag) ? 'pattern' : 'other';
        }
      }
      continue;
    }
    if (!seenPattern) seenPattern = true;
  }

  if (pendingValue !== null) return pendingValue === 'pattern';
  return !seenPattern;
}

/**
 * A balanced PowerShell line is changed only when the affected bash-read string is one whole
 * argument in ripgrep's pattern slot. Paths, flag values and arbitrary shell strings remain
 * untouched even when they contain the same characters.
 */
function isRipgrepPatternRegion(command: string, region: QuotedRegion): boolean {
  const before = region.open === 0 ? '' : command.charAt(region.open - 1);
  const after = command.charAt(region.close + 1);
  if (before !== '' && !/\s/.test(before)) return false;
  if (after !== '' && !/[\s;|&\r\n)]/.test(after)) return false;
  const prefix = bashSegmentPrefix(command, region.open);
  if (prefix === null) return false;
  return nextRipgrepArgumentIsPattern(tokenize(prefix));
}

/**
 * What to say about a non-zero exit that was a reported result rather than a failure.
 *
 * The classification already existed and was spent only on the session's error count, so the
 * model still read `Process exited with code 1` under an empty body and drew the obvious wrong
 * conclusion — the measured consequence being re-runs of searches that had already answered.
 * Both benign shapes are named, because nothing in the exit code tells them apart.
 */
export function benignExitNote(
  command: string,
  shellType: ShellType = 'powershell',
  exitCode?: number | null,
  outputText?: string
): string {
  if (exitCode === 2 && outputText !== undefined && searchAnsweredDespiteBadPath(command, outputText)) {
    const program = statusDeterminingProgram(command);
    const missing = outputText
      .split('\n')
      .filter((line) => SEARCH_DIAGNOSTIC.test(line))
      .slice(0, 3)
      .map((line) => line.trim())
      .join(' ');
    return (
      `Exit code 2 from \`${program}\` here is one path it could not read, not a failed search: ` +
      'the matches above are a complete answer for every path that does exist. ' +
      `${missing} Re-check that path's spelling and search it on its own — re-running the whole ` +
      'search would return the same matches again.'
    );
  }
  // A search cut is only the better explanation once it actually printed matches.
  const cutGenerator =
    shellType === 'powershell' && cutPipelineGeneratorOnlyReports(command)
      ? pipelineStopCandidate(command)
      : null;
  const cutIsTheBetterStory =
    cutGenerator !== null &&
    (!cutPipelineGeneratorIsProvenSearch(cutGenerator) ||
      (outputText !== undefined && commandOutputBody(outputText).length > 0));
  if (cutGenerator !== null && cutIsTheBetterStory) {
    const program = programName(cutGenerator);
    return (
      `Exit code ${exitCode ?? 1} here is \`Select-Object -First\` stopping the pipeline, not a ` +
      `failure: it closes the pipe while \`${program}\` is still writing, and \`${program}\` has no other ` +
      'way to exit non-zero once it has printed. The output above is the first N objects and is ' +
      'complete for that window, so the command does not need to be run again. Add `-Wait` to ' +
      'the same stage to keep the exit code meaningful, at the cost of letting the command run ' +
      'to the end.'
    );
  }
  // Name the search the caller actually wrote. `git grep` decides its status as `git`, and a
  // note reading "exit code 1 from `git`" would generalise to the git commands where 1 means
  // something else entirely — which is the belief this note exists to prevent, not to spread.
  const deciding = statusDeterminingProgram(command);
  const program = deciding === 'git' ? `git ${gitGeneratorSubcommand(command) ?? ''}`.trim() : deciding;
  if (shellType !== 'powershell') {
    return (
      `Exit code 1 from \`${program}\` is a result, not a failure: this search program uses it ` +
      'when it finds no matches. Nothing went wrong, and the command does not need to be run again.'
    );
  }
  return (
    `Exit code 1 from \`${program}\` is a result, not a failure: it is what a search reports ` +
    'when it finds no matches, and also what it reports when a later stage such as ' +
    '`Select-Object -First` stops the pipeline early. Nothing went wrong, and the command does ' +
    'not need to be run again.'
  );
}

export interface NormalizedCommand {
  cmd: string;
  /** Human-readable description of every rewrite, for the model and the log. */
  notes: string[];
}

/** Rewrites only small, top-level conditional chains that PowerShell 5.1 would reject outright. */
export function normalizePowerShellOperators(
  cmd: string,
  shellType: ShellType,
  shellPath: string
): NormalizedCommand {
  if (shellType !== 'powershell' || !isWindowsPowerShell5(shellPath)) return { cmd, notes: [] };
  if ((!cmd.includes('&&') && !cmd.includes('||')) || hasUnsupportedShellLexemes(cmd)) return { cmd, notes: [] };

  const operators: string[] = [];
  const operands = splitTopLevel(cmd, ['&&', '||'], operators);
  if (operators.length === 0 || operands.length !== operators.length + 1 || operands.length > 4) {
    return { cmd, notes: [] };
  }
  if (
    operands.some((operand) => {
      const value = operand.trim();
      return !value || value.includes('>') || value.includes('$?') || splitTopLevel(value, [';', '\n']).length !== 1;
    })
  ) {
    return { cmd, notes: [] };
  }

  const rewritten = operands
    .map((operand, index) => {
      if (index === 0) return operand.trim();
      const guard = operators[index - 1] === '&&' ? 'if ($?)' : 'if (-not $?)';
      return `${guard} { ${operand.trim()} }`;
    })
    .join('; ');
  return {
    cmd: rewritten,
    notes: ['Windows PowerShell 5.1 cannot parse && or ||, so this simple chain was rewritten as guards on `$?`.']
  };
}

/**
 * Whether a token is a glob this file is willing to expand.
 *
 * A quoted glob was deliberately protected from the shell and is left exactly as protected.
 * A relative child path may name one exact directory beneath the command workdir; absolute
 * paths, parent traversal and globs in the directory portion remain ineligible so normalization
 * never pre-reads a broader or guessed location.
 */
function isExpandableGlob(token: Token): boolean {
  if (token.quoted) return false;
  if (!/[*?]/.test(token.value)) return false;
  if (token.value.startsWith('-')) return false;
  // A bracket class is pathname expansion this does not implement — the matcher below escapes
  // `[` and `]` into literals, so `a[12]*.ts` would match a file actually *named* with those
  // brackets while the shell would have matched `a1.ts` and `a2.ts`. Answering a different
  // question and reporting success is worse than not answering, so it is not answered.
  if (/[[\]]/.test(token.value)) return false;
  // `$env:X` and other expansions are the shell's business, not ours.
  return !token.value.includes('$');
}

interface GlobLocation {
  /** Normalized relative directory handed to the trusted lister. */
  directory: string;
  /** Original spelling, including its final slash, preserved in the rebuilt arguments. */
  prefix: string;
  /** Filename-only glob matched against that directory's immediate entries. */
  leaf: string;
}

/** The one exact directory and filename pattern a bounded operand names. */
function globLocation(pattern: string): GlobLocation | null {
  const slash = Math.max(pattern.lastIndexOf('/'), pattern.lastIndexOf('\\'));
  if (slash < 0) return { directory: '.', prefix: '', leaf: pattern };

  const prefix = pattern.slice(0, slash + 1);
  const rawDirectory = pattern.slice(0, slash);
  const leaf = pattern.slice(slash + 1);
  // Drive/UNC/rooted paths are outside this pre-execution convenience's authority. The command
  // still runs unchanged and may access them under the command capability's existing contract.
  if (/^(?:[A-Za-z]:|[\\/])/.test(pattern)) return null;
  if (leaf === '' || /[\\/]/.test(leaf)) return null;

  const segments = rawDirectory.split(/[\\/]/);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '' || segment === '..' || /[*?\[\]{}$:'"`]/.test(segment))
  ) {
    return null;
  }
  const directory = segments.filter((segment) => segment !== '.').join('/');
  return { directory: directory === '' ? '.' : directory, prefix, leaf };
}

/** Re-quotes an expanded name for the shell, so it reaches the program verbatim. */
function quoteArgument(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The expanded names, as a note can carry them.
 *
 * Naming them is what lets the caller check what the search actually ran against, and a
 * hundred filenames on one line is not checkable — so past a dozen the note gives the count
 * and the head. Only the note is shortened; the command received every name.
 */
const NAMES_SHOWN_IN_NOTE = 12;
function listExpandedNames(names: readonly string[]): string {
  if (names.length <= NAMES_SHOWN_IN_NOTE) return names.join(', ');
  return `${names.slice(0, NAMES_SHOWN_IN_NOTE).join(', ')} … and ${names.length - NAMES_SHOWN_IN_NOTE} more`;
}

/**
 * One brace group of plain alternatives, e.g. `src/{main,test}/x`.
 *
 * Deliberately one group and nothing clever inside it. A brace group is also PowerShell's
 * script-block syntax, so the pattern has to be narrow enough that `Where-Object { $_ -eq 1 }`
 * can never match it: no whitespace (the tokenizer already split on that), no `$`, no nested
 * braces, no quotes, and a comma is required — a lone `{...}` is far more likely to be a
 * block than a path. Anything outside that shape is left exactly as written.
 */
const BRACE_ALTERNATIVES = /^([^{}$'"`|;]*)\{([^{}$'"`|;,]*(?:,[^{}$'"`|;,]*)+)\}([^{}$'"`|;]*)$/;

/**
 * The paths a bash-style brace group stands for, in the order bash would produce them.
 *
 * Purely textual, exactly as the shell it stands in for: the names are not checked against
 * the disk, because bash does not check either and a caller who typed a path that is not
 * there is owed ripgrep's own "no such file" rather than a silently shortened list.
 *
 * Which is also why a group holding a wildcard is refused outright. bash expands braces and
 * *then* expands the wildcards in what came out; this does only the first half, and quotes
 * what it produces so it reaches the program verbatim. Half of a two-stage expansion is not
 * a smaller fix, it is a worse failure: `{*.ts,*.js}` would become two quoted wildcards that
 * ripgrep cannot open, where the untouched group at least fails as the shell's own.
 */
function expandBraces(token: Token): string[] | null {
  if (token.quoted) return null;
  if (token.value.startsWith('-')) return null;
  const match = BRACE_ALTERNATIVES.exec(token.value);
  if (!match) return null;
  const [, prefix = '', body = '', suffix = ''] = match;
  const parts = body.split(',');
  if (parts.length < 2 || parts.length > MAX_EXPANDED_NAMES) return null;
  const names = parts.map((part) => `${prefix}${part}${suffix}`);
  // The second stage is not ours to run, so a group that would still need it is not ours to
  // touch. Both halves of the group are judged, not just the one that happens to carry the
  // wildcard: expanding `{main,test/*}` partly would be the same trap. A bracket class is
  // pathname expansion too — `{[ab].ts,c.ts}` needs the same second stage as a `*` does.
  if (names.some((name) => /[*?[]/.test(name))) return null;
  return names;
}

/**
 * The most names one glob may turn into.
 *
 * The bound is the command line's length limit, and 48 was well under it: a test directory of
 * 71 files made `test/*.test.ts` fall past this, and what the caller then got was not the hint
 * but ripgrep's `os error 123` on a literal asterisk — the exact failure this expansion exists
 * to remove. 128 quoted relative paths is a few KB against PowerShell's ~32 KB, so the limit
 * now sits where the real constraint is rather than ahead of it. The wall-of-filenames problem
 * was the *note's*, and `listExpandedNames` is where that belongs.
 */
const MAX_EXPANDED_NAMES = 128;

/** Lists one validated relative directory's immediate entry names for glob expansion. */
export type DirectoryLister = (relativeDirectory?: string) => readonly string[];

/**
 * The entries of the exact relative directory this glob names, in shell expansion order.
 *
 * The directory portion is validated by `globLocation`: it cannot be absolute, traverse a
 * parent, or contain expansion syntax of its own. Leading dots are excluded unless the leaf
 * pattern itself begins with one, which is the POSIX rule the caller was writing to.
 *
 * An empty result is not an expansion. A shell that matches nothing passes the pattern
 * through untouched, and so does this: the command then fails exactly as it would have, and
 * the hint explains it. Substituting nothing would instead silently search the whole tree.
 */
function expandGlob(pattern: string, list: DirectoryLister): { hits: string[]; directory: string } | null {
  const location = globLocation(pattern);
  if (location === null) return null;
  let entries: readonly string[];
  try {
    entries = list(location.directory);
  } catch {
    return null;
  }
  const source = location.leaf
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^\\\\/]*')
    .replace(/\?/g, '[^\\\\/]');
  // Case-insensitively, which is how Windows matches filenames and therefore how the shell
  // being stood in for would have matched them.
  const matcher = new RegExp(`^${source}$`, 'i');
  // POSIX hides a leading dot from a pattern that does not have one, and only then. A
  // pattern written with the dot is asking for those files by name.
  const hidden = location.leaf.startsWith('.');
  const hits = entries
    .filter((entry) => !/[\\/]/.test(entry) && (hidden || !entry.startsWith('.')) && matcher.test(entry))
    .sort()
    .map((entry) => `${location.prefix}${entry}`);
  if (hits.length === 0 || hits.length > MAX_EXPANDED_NAMES) return null;
  return { hits, directory: location.directory };
}

/**
 * `allowGlob` is false for every statement after the first. A glob has to be expanded against
 * the directory the shell would have used, and one statement later that is a guess about what
 * the statements before it did. Brace expansion carries no such debt — it is pure text, cwd
 * and filesystem play no part — so it stays on for the whole command line.
 */
function normalizeRipgrepSegment(
  segment: string,
  list: DirectoryLister,
  allowGlob: boolean
): { segment: string; notes: string[] } {
  const tokens = tokenize(segment);
  if (!RIPGREP_NAMES.has(programName(tokens[0]))) return { segment, notes: [] };

  const notes: string[] = [];
  const out: string[] = [tokens[0]?.raw ?? ''];
  let seenPattern = false;
  let skipValue = false;
  let optionsEnded = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (skipValue) {
      skipValue = false;
      out.push(token.raw);
      continue;
    }
    if (!optionsEnded && token.value === '--') {
      // Unlike an unknown flag, `--` has exact arity: it consumes nothing and makes every
      // following token positional. Refusing the whole segment here left the most explicit
      // spelling of `rg -- pattern *.ts` broken on PowerShell even though the token boundaries
      // after the delimiter are *more* knowable than without it.
      optionsEnded = true;
      out.push(token.raw);
      continue;
    }
    if (!optionsEnded && token.value.startsWith('-')) {
      const flag = token.value.split('=')[0] as string;
      // An option this table does not know may or may not swallow the next argument, and
      // the two readings disagree about which token is the pattern and which is a path.
      // Neither reading is safe to act on, so nothing in this segment is rewritten. A bare
      // `-` still lands here because it names stdin; `--` is handled above because its arity
      // and effect on every following token are exact.
      if (!RG_VALUE_FLAGS.has(flag) && !RG_BOOLEAN_FLAGS.has(flag)) return { segment, notes: [] };
      // `--glob=*.md` carries its value inline and consumes nothing after it.
      if (RG_VALUE_FLAGS.has(token.value) && !token.value.includes('=')) skipValue = true;
      if (RG_PATTERN_FLAGS.has(flag) || RG_NO_PATTERN_FLAGS.has(flag)) seenPattern = true;
      out.push(token.raw);
      continue;
    }
    if (!seenPattern) {
      // The search pattern itself. `*` is a regex quantifier here, never a filename glob.
      seenPattern = true;
      out.push(token.raw);
      continue;
    }
    const braced = expandBraces(token);
    if (braced) {
      out.push(...braced.map(quoteArgument));
      notes.push(
        `PowerShell has no brace expansion, so \`${token.value}\` reached ripgrep as one literal name. ` +
          `It was expanded here to the ${braced.length} paths bash would have produced: ${listExpandedNames(braced)}.`
      );
      continue;
    }
    const expanded = allowGlob && isExpandableGlob(token) ? expandGlob(token.value, list) : null;
    if (expanded) {
      out.push(...expanded.hits.map(quoteArgument));
      notes.push(
        `PowerShell does not expand globs for native programs, so \`${token.value}\` was expanded here to ` +
          `${expanded.hits.length === 1 ? 'the one entry' : `the ${expanded.hits.length} entries`} of the ` +
          `${expanded.directory === '.' ? 'working directory' : `relative directory ${expanded.directory}`} ` +
          `matching it: ${listExpandedNames(expanded.hits)}. Sub-directories were not searched, exactly as ` +
          `the glob asked; use \`-g '${token.value}'\` if a recursive match was what you meant.`
      );
      continue;
    }
    out.push(token.raw);
  }

  return { segment: out.join(' '), notes };
}

/**
 * Rewrites what can be rewritten losslessly, and leaves everything else exactly as written.
 *
 * Scoped to PowerShell because that is where the gap is: a POSIX shell already expanded the
 * glob before the program ever saw it, so touching a bash command here could only do harm.
 */
export function normalizeShellCommand(
  cmd: string,
  shellType: ShellType,
  list: DirectoryLister | null = null
): NormalizedCommand {
  if (shellType !== 'powershell') return { cmd, notes: [] };
  if (!/[*?{]/.test(cmd)) return { cmd, notes: [] };
  // This tokenizer intentionally does not implement PowerShell's backtick escape grammar.
  // That is fine only while a backtick is absent. With one present, a visually separate token
  // may actually be part of the same argument (`foo`<backtick>` bar*.ts`), a newline may be a
  // continuation rather than a statement boundary, and an escaped quote/separator can change
  // every split this normalizer makes. Rewriting around any of those would be silent command
  // corruption, so the safe answer is to leave the entire line alone. A missed convenience
  // rewrite costs one retry; a guessed parse can make a different command succeed.
  if (hasUnsupportedShellLexemes(cmd)) return { cmd, notes: [] };
  // Without a directory there is nothing to expand a glob against, and guessing is not
  // available here: the point of the exercise is that the answer must be the shell's own.
  // Brace expansion needs no directory — it is textual — so it still runs, against a listing
  // that reports the one honest thing it can, which is that it knows of no entries.
  const entries: DirectoryLister = list ?? ((): readonly string[] => []);

  const notes: string[] = [];
  let changed = false;
  let statementIndex = 0;

  // Statements and pipeline segments are rebuilt with their own separators intact, so only
  // the segments this file actually rewrote differ from the original text.
  const rebuilt = rebuild(cmd, [';', '&&', '||', '\n'], (statement) => {
    // Globs are expanded in the first statement only. Nothing has run yet at that point, so
    // the directory listed here is the directory the shell would have expanded against; one
    // statement later it is a guess about what the statements before it did to the cwd and to
    // the files in it. Brace groups are not asking the filesystem anything and run throughout.
    const first = statementIndex++ === 0;
    return rebuild(statement, ['|'], (segment) => {
      const result = normalizeRipgrepSegment(segment.trim(), entries, first);
      if (result.notes.length === 0) return segment;
      changed = true;
      notes.push(...result.notes);
      // Keep the caller's surrounding whitespace so the rebuilt line still reads naturally.
      const [, lead = '', , trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment) ?? [];
      return `${lead}${result.segment}${trail}`;
    });
  });

  return changed ? { cmd: rebuilt, notes: [...new Set(notes)] } : { cmd, notes: [] };
}

/** Splits on `seps`, maps each part, and joins it back with the separators it was cut on. */
function rebuild(text: string, seps: readonly string[], map: (part: string) => string): string {
  const pieces: string[] = [];
  const separators: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '{') depth++;
    else if (char === ')' || char === '}') depth = Math.max(0, depth - 1);

    if (depth === 0) {
      const hit = seps.find((sep) => text.startsWith(sep, i));
      if (hit !== undefined) {
        pieces.push(current);
        separators.push(hit);
        current = '';
        i += hit.length - 1;
        continue;
      }
    }
    current += char;
  }
  pieces.push(current);

  return pieces.map(map).reduce((acc, part, index) => acc + (index === 0 ? '' : separators[index - 1]) + part, '');
}

/**
 * What to try next, for failures whose cause is unambiguous in the output.
 *
 * Only patterns that name one specific, actionable cause belong here. A hint that fires on
 * a guess is worse than silence: it sends the model somewhere confidently wrong.
 */
export function execRecoveryHints(
  command: string,
  outputText: string,
  shellType: ShellType = 'powershell'
): string[] {
  const hints: string[] = [];
  const powershell = shellType === 'powershell';
  const cmd = shellType === 'cmd';

  if (/fatal: not a git repository/i.test(outputText)) {
    hints.push(
      'That folder is not a git repository, so no git command that needs one will work there. ' +
        'Check with `git rev-parse --show-toplevel`, or set workdir to the folder that actually contains .git. ' +
        'The server instructions list which approved roots are repositories.'
    );
  } else if (/warning: Not a git repository\. Use --no-index|^usage: git diff --no-index/im.test(outputText)) {
    // `git diff <paths>` outside a repository falls into --no-index mode, which compares the
    // named files with each other or, given one path, prints the full option list. Fifteen of
    // those dumps in the recorded sessions, none of them read as "this is not a repository".
    hints.push(
      'That folder is not a git repository. `git diff` there falls into `git diff --no-index`, which compares the ' +
        'named files with each other or prints its option list, so nothing above is a diff against any commit. ' +
        'Check with `git rev-parse --show-toplevel`, or set workdir to the folder that actually contains .git.'
    );
  }

  if (
    powershell &&
    /[?*]/.test(command) &&
    (/os error 123/i.test(outputText) || /IO error for operation on .*[*?]/i.test(outputText))
  ) {
    hints.push(
      'PowerShell does not expand `*` or `?` for native programs, so the pattern reached the program literally. ' +
        'For ripgrep pass the filename pattern as `-g \'<glob>\'`; otherwise expand it first, e.g. ' +
        '`Get-ChildItem -Path \'<glob>\' | ForEach-Object FullName`.'
    );
  }

  // Distinct from the glob hint above, which is os error 123 — a path that cannot exist because
  // the shell handed the program a wildcard. This is os error 2: a path that could have existed
  // and does not. Both leave a non-zero exit sitting on top of matches from the paths that were
  // real, and a recorded session shows the model discarding a good answer over it after naming
  // a plausible `src/main/codex/...` path for a module that actually lives directly in src/main.
  if (
    /^\s*(?:rg|ripgrep|grep|egrep|fgrep|findstr):.*(?:os error 2\b|No such file or directory|cannot find the (?:file|path) specified)/im.test(
      outputText
    )
  ) {
    const checkPath = powershell
      ? '`Get-ChildItem -LiteralPath \'<path>\'`'
      : cmd
        ? '`dir "<path>"`'
        : '`ls -ld -- \'<path>\'`';
    hints.push(
      'The search exited non-zero because a path it was given does not exist — the error line ' +
        'above names it, and the rest of the output is a complete answer for the paths that do. ' +
        `Confirm the spelling with ${checkPath} before re-running, and re-run only the ` +
        'missing path rather than the whole search.'
    );
  }

  if (
    powershell &&
    command.includes('\\"') &&
    /PositionalParameterNotFound|A positional parameter cannot be found that accepts argument/i.test(outputText) &&
    !/The string (?:is missing the terminator|starting:)/i.test(outputText)
  ) {
    // The quotes balanced out, so PowerShell did run the line — with the double-quoted argument
    // ended at the backslash-quote and the remainder handed to the cmdlet as extra positional
    // arguments. The cmdlet's refusal names one of those fragments, not the mistake.
    hints.push(
      'PowerShell ended the double-quoted argument at the backslash-quote inside it — a backslash escapes nothing in ' +
        'PowerShell — and handed the rest of the text to the cmdlet as extra positional arguments, which it refused. ' +
        'Put a pattern that contains a quote in single quotes, doubling any apostrophe; keep the backslash before the ' +
        'quote only when a native program should receive it.'
    );
  }

  if (powershell && command.includes('\\"') && /The string (?:is missing the terminator|starting:)/i.test(outputText)) {
    hints.push(
      'PowerShell refused that line at a quote and ran none of it, including any earlier ' +
        'statement on the same line. A backslash is not an escape character in PowerShell, so ' +
        'a backslash-quote inside a double-quoted argument ends the argument there. Put a ' +
        'pattern that contains a quote in single quotes and keep the backslash before the ' +
        'quote, doubling any apostrophe: a literal quote reaches a native program only when it ' +
        'arrives backslash-escaped. Passing each alternative as its own -e argument avoids the ' +
        'question entirely.'
    );
  }

  // Deliberately a hint and not a rewrite. `A && B` runs B only if A succeeded, and the
  // nearest thing PowerShell 5.1 has is a guard, not `;` — turning one into the other would
  // run the gated half of `gradlew test && gradlew publish` after the tests had failed. The
  // faithful translation is mechanical enough to hand over, and cheap enough to let the model
  // make. This fires on the shell's own refusal, so it can never misfire on PowerShell 7,
  // where the operators work and no such error exists.
  const invalidOperator = /The token '(&&|\|\|)' is not a valid statement separator/i.exec(outputText)?.[1];
  if (powershell && invalidOperator && command.includes(invalidOperator)) {
    hints.push(
      'Windows PowerShell 5.1 has no `&&` or `||`, so it refused the whole line and ran nothing. ' +
        'These are not the same as `;`, which would run the second command even when the first failed: ' +
        'write `A; if ($?) { B }` for `A && B`, and `A; if (-not $?) { B }` for `A || B`. ' +
        'Chain longer runs by nesting inside the block rather than repeating the guard.'
    );
  }

  const bashQuoteFailure = command.includes('\\"') && /The string (?:is missing the terminator|starting:)/i.test(outputText);
  const parserFailure =
    /\bParserError\b/i.test(outputText) ||
    /FullyQualifiedErrorId\s*:\s*(?:TerminatorExpectedAtEndOfString|MissingArgument|MissingExpressionAfterToken|MissingFileSpecification|RedirectionNotSupported|UnexpectedToken|EmptyPipeElement)/i.test(
      outputText
    );
  if (powershell && parserFailure && !invalidOperator && !bashQuoteFailure) {
    const correction = /TerminatorExpectedAtEndOfString|missing the terminator/i.test(outputText)
      ? 'Balance the quoted argument; for literal regexes and paths, prefer one single-quoted PowerShell argument.'
      : /MissingArgument|missing an argument/i.test(outputText)
        ? 'Supply the missing value after the named parameter or comma, quoting it as one argument when it contains shell punctuation.'
        : /MissingFileSpecification|RedirectionNotSupported|redirection operator/i.test(outputText)
          ? 'PowerShell does not support Bash heredocs such as `<<EOF`; use a PowerShell here-string piped to the program, or write the content with Set-Content.'
          : 'Use the reported line and character to correct the unexpected or incomplete token; split unrelated checks into `exec_command.cmds`.';
    hints.push(
      `PowerShell parsed none of the command, so no statement ran. ${correction} Correct the syntax and rerun the command.`
    );
  }

  if (/JAVA_HOME is not set/i.test(outputText)) {
    const example = powershell
      ? "`$env:JAVA_HOME='C:\\path\\to\\jdk'; $env:Path=\"$env:JAVA_HOME\\bin;$env:Path\"`"
      : cmd
        ? '`set "JAVA_HOME=C:\\path\\to\\jdk" && set "PATH=%JAVA_HOME%\\bin;%PATH%"`'
        : '`export JAVA_HOME=/path/to/jdk; export PATH="$JAVA_HOME/bin:$PATH"`';
    hints.push(`No Java could be found automatically. Point JAVA_HOME at a JDK for this command, e.g. ${example}.`);
  }

  if (/cannot find GOROOT/i.test(outputText)) {
    const executable = powershell || cmd ? 'bin\\go.exe' : 'bin/go';
    const example = powershell
      ? "`$env:GOROOT='C:\\path\\to\\go'; $env:Path=\"$env:GOROOT\\bin;$env:Path\"`"
      : cmd
        ? '`set "GOROOT=C:\\path\\to\\go" && set "PATH=%GOROOT%\\bin;%PATH%"`'
        : '`export GOROOT=/path/to/go; export PATH="$GOROOT/bin:$PATH"`';
    hints.push(
      `The go binary was found but GOROOT was not set and could not be inferred. Set GOROOT to the ` +
        `toolchain directory that contains ${executable} before invoking it, e.g. ${example}.`
    );
  }

  return hints;
}

/** Appends advisory notes to an exec result without disturbing the parity-formatted body. */
export function withExecNotes(responseText: string, notes: readonly string[]): string {
  if (notes.length === 0) return responseText;
  return `${responseText}\n\n${notes.map((note) => `Note: ${note}`).join('\n')}`;
}
