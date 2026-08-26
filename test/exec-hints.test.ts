/**
 * Reading a model-issued shell command well enough to stop punishing it for Windows.
 *
 * These are regressions for a measured problem, not hygiene. Across the 50 most recent
 * recorded sessions, 79 of 1,175 tool calls were stored as errors — and only 16 of those
 * were a build or test that genuinely failed. Nine were ripgrep reporting "no matches" or
 * being cut short by `Select-Object -First`, both of which exit 1 by design; five were
 * PowerShell handing ripgrep an unexpanded `*`; seven were git run in a folder with no
 * `.git`. The error count had stopped meaning "something went wrong".
 *
 * The dangerous failure mode for this file is the opposite of the one it fixes: a rule that
 * is too eager launders real failures into successes, or rewrites a command into one that
 * silently searches the wrong place. Every test below that asserts a *negative* is guarding
 * that edge, and matters more than the positives.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RG_BOOLEAN_FLAGS,
  RG_OPTION_TABLE_VERSION,
  RG_VALUE_FLAGS,
  benignExitNote,
  bindBundledRipgrep,
  execRecoveryHints,
  nonZeroExitIsBenign,
  normalizeShellCommand,
  repairPowerShellQuoting,
  statusDeterminingProgram,
  withExecNotes
} from '../src/main/exec-hints.js';
import { locateRipgrep } from '../src/main/ripgrep.js';

const BOUND_RG = "& 'C:\\tools\\rg.exe'";

describe('which program decided the exit code', () => {
  it('reads through a pipeline of cmdlets to the program that generated the output', () => {
    // Cmdlets never touch $LASTEXITCODE, so ripgrep's own code is still the one reported.
    expect(statusDeterminingProgram('rg -n "foo" src | Select-Object -First 30')).toBe('rg');
    expect(statusDeterminingProgram('rg -n "foo" src | sort | measure')).toBe('rg');
  });

  it('reads to the last native program in a pipeline, not the first', () => {
    // Verified in PowerShell: `cmd /c exit 1 | cmd /c exit 0` leaves $LASTEXITCODE at 0, and
    // reversing the two leaves it at 1. The last native stage wins.
    expect(statusDeterminingProgram('rg -n foo src | git diff --exit-code')).toBe('git');
    expect(statusDeterminingProgram('cmd /c exit 1 | cmd /c exit 0')).toBe('cmd');
    expect(statusDeterminingProgram('rg -n foo src | C:\\tools\\rg.exe -n bar')).toBe('rg');
  });

  it('treats a stage it cannot classify as a program rather than as a cmdlet', () => {
    // The direction that withholds an exemption. Guessing "cmdlet" here would file whatever
    // that stage did under ripgrep's name.
    expect(statusDeterminingProgram('rg -n foo src | mystery_tool --strict')).toBe('mystery_tool');
  });

  it('takes the last statement of a chain', () => {
    expect(statusDeterminingProgram("$root='C:\\x'; Get-ChildItem $root; rg -n 'foo' $root")).toBe('rg');
  });

  it('ignores separators inside quotes and groups', () => {
    expect(statusDeterminingProgram(`rg -n 'a;b|c' src`)).toBe('rg');
    expect(statusDeterminingProgram('(Get-ChildItem; Get-Item) ; rg -n x')).toBe('rg');
  });

  it('strips a directory and an extension from the program name', () => {
    expect(statusDeterminingProgram('C:\\tools\\rg.exe -n foo src')).toBe('rg');
  });
});

describe('a non-zero exit that is a result rather than a failure', () => {
  it('treats ripgrep exit 1 with no output as "no matches"', () => {
    const output = 'Wall time: 0.0056 seconds\nProcess exited with code 1\nOutput:\n';
    expect(nonZeroExitIsBenign(`${BOUND_RG} -n "CallToolRequest" src`, 1, output)).toBe(true);
  });

  it('treats ripgrep exit 1 after Select-Object truncated the pipe as success', () => {
    // The pipe closing early is why the code is non-zero; the matches did arrive.
    const output = 'Process exited with code 1\nOutput:\nclient.go:36: defaultMaxInFlightRequests = 20\n';
    expect(nonZeroExitIsBenign(`${BOUND_RG} -n "Max" $root | Select-Object -First 160`, 1, output)).toBe(true);
  });

  it('still calls it an error when ripgrep printed an error of its own', () => {
    // The exact live failure: an unexpanded glob. Exit 1, but the call really did fail, and
    // exempting it would hide the very thing the glob rewrite exists to prevent.
    const output =
      'Process exited with code 1\nOutput:\nrg: C:\\Users\\x\\tunnel-client*: IO error for operation on ' +
      'C:\\Users\\x\\tunnel-client*: The filename, directory name, or volume label syntax is incorrect. (os error 123)\n';
    expect(nonZeroExitIsBenign('rg -n "Transport" C:\\Users\\x\\tunnel-client*', 1, output)).toBe(false);
  });

  it('never exempts a program that does not spend exit 1 on "no matches"', () => {
    const output = 'Process exited with code 1\nOutput:\n--- FAIL: TestThing\nFAIL\n';
    expect(nonZeroExitIsBenign('go test ./...', 1, output)).toBe(false);
    expect(nonZeroExitIsBenign('.\\gradlew.bat :app:test', 1, output)).toBe(false);
  });

  it('never answers a bracket class with the file that is literally named that', () => {
    // The matcher escapes `[` and `]`, so this pattern would have matched the one file whose
    // name really does contain the brackets — while the shell being stood in for means a
    // character class and would have matched a1.ts and a2.ts. Expanding it is not a smaller
    // answer, it is a different one, reported as success.
    const list = (): readonly string[] => ['a1.ts', 'a2.ts', 'a[12]-literal.ts'];
    const cmd = 'rg needle a[12]*.ts';
    expect(normalizeShellCommand(cmd, 'powershell', list).cmd).toBe(cmd);
    expect(normalizeShellCommand(cmd, 'powershell', list).notes).toEqual([]);
  });

  it('does not rewrite around PowerShell backtick escapes it does not parse', () => {
    // In PowerShell the backtick escapes this space, so `foo` + `bar*.ts` is one argument.
    // A whitespace-only tokenizer sees two tokens and would otherwise expand `bar*.ts`,
    // silently changing one path into two arguments. Backticks therefore make the whole
    // command ineligible for normalization rather than inviting a partial guess.
    const list = (): readonly string[] => ['bar-one.ts', 'bar-two.ts'];
    const escapedSpace = 'rg needle foo` bar*.ts';
    expect(normalizeShellCommand(escapedSpace, 'powershell', list)).toEqual({
      cmd: escapedSpace,
      notes: []
    });

    // A backtick can also continue a physical line. Treating that newline as a statement
    // separator would be the same class of parse corruption.
    const continued = 'rg needle `\n*.ts';
    expect(normalizeShellCommand(continued, 'powershell', list)).toEqual({ cmd: continued, notes: [] });
  });

  it('never grants a benign exit through a PowerShell backtick escape it cannot parse', () => {
    // Real Windows PowerShell: the backtick escapes the semicolon, so the apparent `rg` tail
    // is not a second statement at all. cmd exits 1, but a separator-only parser used to pick
    // rg as the status program and turn the genuine cmd failure into "no matches".
    for (const cmd of [
      'cmd /c exit 1 `; rg foo',
      'cmd /c exit 1 `| rg foo',
      'cmd /c exit 1 `\nrg foo'
    ]) {
      expect(statusDeterminingProgram(cmd)).toBe('');
      expect(nonZeroExitIsBenign(cmd, 1, '')).toBe(false);
    }
  });

  it('never infers execution through comments or PowerShell here-strings it does not parse', () => {
    const bundled = 'C:\\tools\\rg.exe';
    // Everything after # is comment text. A separator-only parser used to see the semicolon,
    // pick the apparent rg tail and could launder cmd's real exit 1 as a search miss.
    const commented = 'cmd /c exit 1 # ; rg foo';
    expect(statusDeterminingProgram(commented)).toBe('');
    expect(nonZeroExitIsBenign(commented, 1, '')).toBe(false);
    expect(bindBundledRipgrep(commented, 'powershell', bundled)).toBe(commented);

    // Here-string contents are data, not statements. Newlines and semicolons inside them must
    // never be rebuilt as shell structure or have a literal line beginning with rg rebound.
    const hereString = '$x = @"\nrg foo *.ts; still text\n"@\nWrite-Output $x';
    expect(statusDeterminingProgram(hereString)).toBe('');
    expect(bindBundledRipgrep(hereString, 'powershell', bundled)).toBe(hereString);
    expect(normalizeShellCommand(hereString, 'powershell', () => ['one.ts'])).toEqual({
      cmd: hereString,
      notes: []
    });

    // A hash inside ordinary quoted data is understood by the quote tracker and does not
    // disable safe parsing unnecessarily.
    expect(statusDeterminingProgram("Write-Output '#'; C:\\tools\\rg.exe foo")).toBe('rg');
  });

  it('does not trust a bare search command when command lookup could have shadowed it', () => {
    // PowerShell command lookup prefers functions/aliases over applications. Both spellings
    // below are legal function names; cmd.exe can likewise pick a current-directory rg.cmd;
    // POSIX shells have functions/aliases too. The text alone therefore proves nothing.
    expect(nonZeroExitIsBenign('rg foo', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('rg.exe foo', 1, '')).toBe(false);

    // A path-qualified executable cannot be replaced by command-name lookup. The call-operator
    // form is what bindBundledRipgrep produces for a quoted Windows path.
    expect(nonZeroExitIsBenign('.\\rg.exe foo', 1, '')).toBe(true);
    expect(nonZeroExitIsBenign(`${BOUND_RG} foo`, 1, '')).toBe(true);
  });

  it('binds bare PowerShell and POSIX ripgrep to the bundled executable without touching explicit/dynamic forms', () => {
    const bundled = 'C:\\Program Files\\Chat On Steroids\\resources\\rg\\rg.exe';
    expect(bindBundledRipgrep('rg -n foo src', 'powershell', bundled)).toBe(
      "& 'C:\\Program Files\\Chat On Steroids\\resources\\rg\\rg.exe' -n foo src"
    );
    expect(bindBundledRipgrep('rg foo | Select-Object -First 5', 'powershell', bundled)).toBe(
      "& 'C:\\Program Files\\Chat On Steroids\\resources\\rg\\rg.exe' foo | Select-Object -First 5"
    );
    expect(bindBundledRipgrep('Write-Output x; ripgrep foo', 'powershell', bundled)).toBe(
      "Write-Output x; & 'C:\\Program Files\\Chat On Steroids\\resources\\rg\\rg.exe' foo"
    );

    // Explicit paths and dynamic/escaped commands preserve the exact shell semantics the
    // caller wrote. The binding exists only for the bare name whose intended runtime the app
    // already owns by shipping it and prepending it to PATH.
    expect(bindBundledRipgrep('.\\tools\\rg.exe foo', 'powershell', bundled)).toBe('.\\tools\\rg.exe foo');
    expect(bindBundledRipgrep('& $search foo', 'powershell', bundled)).toBe('& $search foo');
    expect(bindBundledRipgrep('rg foo`; Write-Output x', 'powershell', bundled)).toBe('rg foo`; Write-Output x');

    const posix = '/Applications/Chat On Steroids/resources/rg/rg';
    const boundPosix = "'/Applications/Chat On Steroids/resources/rg/rg' foo";
    expect(bindBundledRipgrep('rg foo', 'bash', posix)).toBe(boundPosix);
    expect(bindBundledRipgrep('ripgrep foo', 'zsh', posix)).toBe(boundPosix);
    expect(bindBundledRipgrep('rg foo', 'sh', posix)).toBe(boundPosix);
    expect(nonZeroExitIsBenign(boundPosix, 1, '')).toBe(true);
    expect(bindBundledRipgrep('rg foo', 'bash', "/tmp/it's/rg")).toBe("'/tmp/it'\\''s/rg' foo");
    expect(bindBundledRipgrep('/usr/bin/rg foo', 'bash', posix)).toBe('/usr/bin/rg foo');
    expect(bindBundledRipgrep('rg foo', 'cmd', bundled)).toBe('rg foo');
  });

  it('hides a leading dot from a pattern without one, and only then', () => {
    // The POSIX rule the caller was writing to: `*.ts` skips dotfiles, `.h*.ts` asks for them.
    const list = (): readonly string[] => ['.hidden.ts', 'plain.ts'];
    expect(normalizeShellCommand('rg -n x *.ts', 'powershell', list).cmd).toBe("rg -n x 'plain.ts'");
    expect(normalizeShellCommand('rg -n x .h*.ts', 'powershell', list).cmd).toBe("rg -n x '.hidden.ts'");
  });

  it('never rewrites a command whose option arity it cannot know', () => {
    // The corruption this guard exists for: `--engine` consumes `pcre2`, which makes `foo.*`
    // the *pattern*. Reading `--engine` as a switch instead made `pcre2` the pattern and
    // `foo.*` a path — and expanding that path asked ripgrep a different question than the
    // one that was typed, then reported success. Rewriting nothing is the only safe answer.
    const list = (): readonly string[] => ['foo.js', 'other.ts'];
    expect(normalizeShellCommand('rg --engine pcre2 foo.* src', 'powershell', list).cmd).toBe(
      'rg --engine pcre2 foo.* src'
    );
    // Every flag known, so the same line normalizes as before.
    expect(normalizeShellCommand('rg --engine=pcre2 x *.js', 'powershell', list).cmd).toBe(
      "rg --engine=pcre2 x 'foo.js'"
    );
    // An option ripgrep does not have at all remains ambiguous and therefore untouched.
    expect(normalizeShellCommand('rg --not-a-real-flag x *.js', 'powershell', list).cmd).toBe(
      'rg --not-a-real-flag x *.js'
    );
    // `--` is different: its arity is exact and it makes everything after it positional, so
    // the pattern/path slots are safer to identify than they were before the delimiter.
    expect(normalizeShellCommand('rg -- x *.js', 'powershell', list).cmd).toBe("rg -- x 'foo.js'");
    expect(normalizeShellCommand('rg x -- *.js', 'powershell', list).cmd).toBe("rg x -- 'foo.js'");
  });

  it('only reads through pipeline stages that cannot decide the exit status', () => {
    // Being a cmdlet is not enough. `Out-File` to a missing drive throws, exits the host with
    // 1, and prints nothing the output guard recognises; `Write-Error` and a script block
    // that calls `exit` do the same by other routes. Reading ripgrep's code through any of
    // them files a real failure as a search that found nothing.
    expect(statusDeterminingProgram("rg x src | Out-File -LiteralPath 'Z:\\missing\\x.txt'")).toBe('');
    expect(statusDeterminingProgram('rg x src | Set-Content -LiteralPath Z:\\missing\\x.txt')).toBe('');
    expect(statusDeterminingProgram('rg x src | ForEach-Object { exit 1 }')).toBe('');
    expect(statusDeterminingProgram('rg x src | Write-Error boom')).toBe('');
    expect(nonZeroExitIsBenign('rg x src | ForEach-Object { exit 1 }', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign("rg x src | Out-File -LiteralPath 'Z:\\missing\\x.txt'", 1, '')).toBe(false);
    // The shapes the recorded sessions actually use to trim output still read through.
    expect(statusDeterminingProgram('rg x src | Select-Object -First 5')).toBe('rg');
    expect(statusDeterminingProgram('rg x src | Out-Null')).toBe('rg');
    expect(statusDeterminingProgram('rg x src | sort | measure')).toBe('rg');
  });

  it('never exempts a conditional chain, because nothing says which branch ran', () => {
    // PowerShell 7 runs `&&` for real: this one exits 1 from cmd and never reaches ripgrep,
    // yet `rg foo` is still the last statement in the text. The 5.1 parser-error guard does
    // not help here, because on 7 there is no parser error to see — the chain simply ran.
    expect(statusDeterminingProgram('cmd /c exit 1 && rg foo')).toBe('');
    expect(nonZeroExitIsBenign('cmd /c exit 1 && rg foo', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('go build ./... || rg foo', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('rg foo && go build ./...', 1, '')).toBe(false);
    // A `;` chain is unconditional: every statement ran, so the last one is the answer.
    expect(statusDeterminingProgram('cmd /c exit 1; rg foo')).toBe('rg');
    expect(nonZeroExitIsBenign(`cmd /c exit 1; ${BOUND_RG} foo`, 1, '')).toBe(true);
  });

  it('never exempts a command the shell refused to parse', () => {
    // Verified in Windows PowerShell 5.1 on this machine: `&&` is rejected outright, nothing
    // runs, and the exit code is 1. This guard reads the shell's own diagnostic, so it holds
    // even for a chain whose text would otherwise have ended in a search that found nothing.
    const parserError = [
      'At line:1 char:17',
      '+ Write-Output hi && rg foo',
      '+                 ~~',
      "The token '&&' is not a valid statement separator in this version.",
      '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException'
    ].join('\n');
    expect(nonZeroExitIsBenign('Write-Output hi && rg foo', 1, parserError)).toBe(false);
    expect(nonZeroExitIsBenign('rg foo || Write-Output no', 1, parserError)).toBe(false);
  });

  it('never exempts a search the shell could not even find', () => {
    const notFound = [
      "rg : The term 'rg' is not recognized as the name of a cmdlet, function, script file, " +
        'or operable program.',
      '    + CategoryInfo          : ObjectNotFound: (rg:String) [], CommandNotFoundException'
    ].join('\n');
    expect(nonZeroExitIsBenign('rg -n foo src', 1, notFound)).toBe(false);
  });

  it('never exempts a real failure in a hyphenated program later in the pipeline', () => {
    // `docker-compose` has the shape of a cmdlet and is a native program. Reading it as one of
    // PowerShell's own would skip it, hand the exit code back to ripgrep, and launder its
    // failure into "no matches".
    const output = ['Process exited with code 1', 'Output:', 'error: no configuration file provided'].join(
      '\n'
    );
    expect(statusDeterminingProgram('rg -n foo src | docker-compose up')).toBe('docker-compose');
    expect(nonZeroExitIsBenign('rg -n foo src | docker-compose up', 1, output)).toBe(false);
    expect(statusDeterminingProgram('rg -n foo src | tunnel-client --strict')).toBe('tunnel-client');
  });

  it('never exempts a program whose name is built from an approved PowerShell verb', () => {
    // The near-miss fix for the line above was to require an approved verb before the hyphen,
    // which these three defeat: they are executables spelled exactly like cmdlets. Only an
    // exact cmdlet name can be trusted, so an unrecognised Verb-Noun has to count as native.
    const output = 'Process exited with code 1\nOutput:\n2 suites failed\n';
    expect(statusDeterminingProgram('rg x src | test-runner')).toBe('test-runner');
    expect(nonZeroExitIsBenign('rg x src | test-runner', 1, output)).toBe(false);
    expect(statusDeterminingProgram('rg x src | build-tool --ci')).toBe('build-tool');
    expect(statusDeterminingProgram('rg x src | get-version')).toBe('get-version');
  });

  it('still reads through the cmdlets it does know', () => {
    // The exemption has to survive, or the benign-exit rule stops firing on the real corpus:
    // these are the stage heads that actually follow a search in recorded sessions.
    expect(statusDeterminingProgram('rg x src | Select-Object -First 5')).toBe('rg');
    expect(nonZeroExitIsBenign(`${BOUND_RG} x src | Sort-Object | Measure-Object`, 1, '')).toBe(true);
  });

  it('never exempts an exit code other than 1', () => {
    const clean = 'Process exited with code 2\nOutput:\n';
    // ripgrep reserves 2 for real errors, which is what makes exempting 1 safe at all.
    expect(nonZeroExitIsBenign('rg -n foo src', 2, clean)).toBe(false);
    expect(nonZeroExitIsBenign('rg -n foo src', 0, clean)).toBe(false);
    expect(nonZeroExitIsBenign('rg -n foo src', null, clean)).toBe(false);
  });

  it('does not exempt a search whose exit code came from a later program', () => {
    const output = 'Process exited with code 1\nOutput:\nfatal: not a git repository\n';
    expect(nonZeroExitIsBenign('rg -n foo src; git status', 1, output)).toBe(false);
  });

  it('does not exempt a native program downstream of the search in one pipeline', () => {
    // `git diff --exit-code` exits 1 to mean "there are differences", and it is the last
    // native stage, so that 1 is the one PowerShell reports. Reading the pipeline's
    // generator instead would have filed a real result under ripgrep's exemption.
    const output = 'Process exited with code 1\nOutput:\ndiff --git a/x b/x\n';
    expect(nonZeroExitIsBenign('rg -l foo | git diff --exit-code', 1, output)).toBe(false);
  });
});

describe('globs PowerShell will not expand for a native program', () => {
  /**
   * One directory, holding a file the glob matches, a file it does not, and a sub-directory
   * that itself contains a match. That sub-directory is the whole point: a `-g '*_test.go'`
   * filter is recursive and would have found `sub/nested_test.go` too, which the command as
   * written never asked for.
   */
  const cwd = () => ['other.go', 'sub', 'top_test.go', 'zz_test.go'];

  it('expands a bare filename glob into the entries the shell would have passed', () => {
    const result = normalizeShellCommand("rg -n 'TunnelListener' *_test.go", 'powershell', cwd);
    expect(result.cmd).toBe("rg -n 'TunnelListener' 'top_test.go' 'zz_test.go'");
    expect(result.notes.join(' ')).toMatch(/does not expand globs/i);
  });

  it('expands the relative path globs from the latest recorded failures', () => {
    const calls: string[] = [];
    const tree = (directory = '.'): readonly string[] => {
      calls.push(directory);
      if (directory === 'test') {
        return [
          'computer-frame-bounds.test.ts',
          'computer.test.ts',
          'tools-desktop-permissions.test.ts',
          'tools-desktop-runtime.test.ts'
        ];
      }
      if (directory === 'src/main/mcp') return ['kernel.ts', 'server.ts', 'tools-core.ts'];
      return [];
    };

    const tests = normalizeShellCommand(
      "rg -n wait test/tools-desktop*.test.ts test/computer*.test.ts",
      'powershell',
      tree
    );
    expect(tests.cmd).toBe(
      "rg -n wait 'test/tools-desktop-permissions.test.ts' 'test/tools-desktop-runtime.test.ts' " +
        "'test/computer-frame-bounds.test.ts' 'test/computer.test.ts'"
    );

    const mcp = normalizeShellCommand(
      'rg -n -C 12 caller src/main/mcp/*.ts',
      'powershell',
      tree
    );
    expect(mcp.cmd).toBe(
      "rg -n -C 12 caller 'src/main/mcp/kernel.ts' 'src/main/mcp/server.ts' 'src/main/mcp/tools-core.ts'"
    );
    expect(calls).toEqual(['test', 'test', 'src/main/mcp']);
    expect([...tests.notes, ...mcp.notes].join(' ')).toMatch(/relative directory/i);
  });

  it('never widens the search to sub-directories the glob did not name', () => {
    // The regression that retired the previous rewrite. `-g` is a recursive filter, so
    // `rg pattern -g '*_test.go'` also matches `sub\nested_test.go` — extra results returned
    // confidently, with nothing downstream able to tell they were never asked for.
    const result = normalizeShellCommand("rg -n 'x' *_test.go", 'powershell', cwd);
    expect(result.cmd).not.toContain('-g');
    expect(result.cmd).not.toContain('sub');
    expect(result.cmd).toBe("rg -n 'x' 'top_test.go' 'zz_test.go'");
  });

  it('expands a bash brace group into the paths bash would have produced', () => {
    // Straight from the corpus: the model writes one path with alternatives, PowerShell has no
    // brace expansion, and ripgrep is handed a single directory name that does not exist.
    const result = normalizeShellCommand('rg -n "AppGraph" app/src/{main,test}/java', 'powershell', cwd);
    expect(result.cmd).toBe("rg -n \"AppGraph\" 'app/src/main/java' 'app/src/test/java'");
    expect(result.notes.join(' ')).toMatch(/no brace expansion/i);
  });

  it('expands braces without a directory listing, because the expansion is textual', () => {
    // Unlike a glob, a brace group needs nothing from the disk — and is not checked against it
    // either, so a path that is not there still earns ripgrep's own error rather than silence.
    const result = normalizeShellCommand('rg -n x src/{a,b}', 'powershell', null);
    expect(result.cmd).toBe("rg -n x 'src/a' 'src/b'");
  });

  it('never mistakes a script block for a brace group', () => {
    // The danger the narrow pattern exists for: `{ … }` is PowerShell's own syntax, and
    // rewriting one into a list of paths would destroy the command.
    for (const cmd of [
      'rg -n x . | Where-Object { $_ -match "a,b" }',
      'rg -n x . | ForEach-Object { $_.Trim(),$_.Length }',
      "rg -n 'a{2,3}' src"
    ]) {
      expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
      expect(normalizeShellCommand(cmd, 'powershell', cwd).notes).toEqual([]);
    }
  });

  it('leaves a brace group alone when it is quoted or holds no alternative', () => {
    // A quoted group was protected on purpose, and a comma is what separates a path from a
    // regex quantifier or a block — without one there is nothing to expand.
    for (const cmd of ["rg -n x 'src/{a,b}'", 'rg -n x src/{a}', 'rg -n x src/{$env:X,b}']) {
      expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    }
  });

  it('refuses a brace group whose alternatives would still need a glob stage', () => {
    // bash expands braces and *then* expands the wildcards in what came out. Only the first
    // half happens here, and what it produces is quoted so it reaches the program verbatim —
    // so expanding this one would hand ripgrep two quoted wildcards it cannot open, which is
    // a worse failure than the untouched group. Both alternatives are judged, not just the
    // one carrying the wildcard.
    for (const cmd of [
      'rg -n x {*.ts,*.js}',
      'rg -n x src/{main,test}/*.ts',
      'rg -n x {main,test/*}',
      'rg -n x {a,b?}',
      'rg -n x {[ab].ts,c.ts}'
    ]) {
      const result = normalizeShellCommand(cmd, 'powershell', cwd);
      expect(result.cmd).toBe(cmd);
      expect(result.notes).toEqual([]);
    }
  });

  it('does not read a wrapper script as the program whose exit code it trusts', () => {
    // `rg.cmd`, `rg.bat` and `rg.ps1` are local scripts that happen to be named after
    // ripgrep. Nothing about them promises exit 1 means "no matches", so the exemption that
    // rests on that promise cannot be given to them. Only the program itself earns it.
    for (const wrapper of ['.\\rg.ps1 foo', 'rg.cmd foo', 'rg.bat foo', 'C:\\tools\\rg.cmd foo']) {
      expect(nonZeroExitIsBenign(wrapper, 1, '')).toBe(false);
    }
    // The real program still does when the command text proves an executable path.
    expect(nonZeroExitIsBenign('rg foo', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('C:\\tools\\rg.exe foo', 1, '')).toBe(true);
    expect(statusDeterminingProgram('rg -n foo | rg.cmd bar')).toBe('rg.cmd');
  });

  it('expands braces after the first statement, where a glob would be left alone', () => {
    // The asymmetry is the point: the brace group means the same thing wherever it appears,
    // while the glob one statement later would be answered from the wrong directory.
    const mixed = "$ErrorActionPreference='Stop'; rg -n x app/{main,test}";
    const result = normalizeShellCommand(mixed, 'powershell', cwd);
    expect(result.cmd).toBe("$ErrorActionPreference='Stop'; rg -n x 'app/main' 'app/test'");
    expect(normalizeShellCommand("Set-Location sub; rg -n x *_test.go", 'powershell', cwd).cmd).toBe(
      'Set-Location sub; rg -n x *_test.go'
    );
  });

  it('leaves everything after the first statement alone', () => {
    // Expansion happens here, before anything runs; the shell would have expanded when it
    // reached the statement. Those are the same answer only while nothing ran in between.
    const moved = "Set-Location sub; rg -n 'x' *_test.go";
    expect(normalizeShellCommand(moved, 'powershell', cwd).cmd).toBe(moved);
    // And the files a preceding statement is about to create do not exist yet to be listed.
    const built = "npm run build; rg -n 'x' *_test.go";
    expect(normalizeShellCommand(built, 'powershell', cwd).cmd).toBe(built);
    expect(normalizeShellCommand(built, 'powershell', cwd).notes).toEqual([]);
  });

  it('expands inside the first statement even when it is a pipeline', () => {
    const result = normalizeShellCommand("rg -n 'x' *_test.go | Select-Object -First 5", 'powershell', cwd);
    expect(result.cmd).toBe("rg -n 'x' 'top_test.go' 'zz_test.go' | Select-Object -First 5");
  });

  it('knows the pattern slot is already filled by -e, --file or --files', () => {
    // Each of these used to leave the first bare token counted as the pattern, so the glob
    // after it was never reached at all.
    expect(normalizeShellCommand("rg -e 'foo' *_test.go", 'powershell', cwd).cmd).toBe(
      "rg -e 'foo' 'top_test.go' 'zz_test.go'"
    );
    expect(normalizeShellCommand('rg --regexp=foo *_test.go', 'powershell', cwd).cmd).toBe(
      "rg --regexp=foo 'top_test.go' 'zz_test.go'"
    );
    expect(normalizeShellCommand('rg --files *_test.go', 'powershell', cwd).cmd).toBe(
      "rg --files 'top_test.go' 'zz_test.go'"
    );
  });

  it('passes an unmatched glob through exactly as a shell would', () => {
    // A shell that matches nothing hands the program the pattern. Substituting nothing here
    // would instead turn a scoped search into a search of the entire tree.
    const cmd = "rg -n 'x' *.rs";
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    expect(normalizeShellCommand(cmd, 'powershell', cwd).notes).toEqual([]);
  });

  it('gives up rather than build a command line nobody can read', () => {
    const many = () => Array.from({ length: 200 }, (_, i) => `file_${i}_test.go`);
    const cmd = "rg -n 'x' *_test.go";
    expect(normalizeShellCommand(cmd, 'powershell', many).cmd).toBe(cmd);
  });

  it('does nothing at all without a directory to expand against', () => {
    const cmd = "rg -n 'x' *_test.go";
    expect(normalizeShellCommand(cmd, 'powershell').cmd).toBe(cmd);
    const unreadable = () => {
      throw new Error('EPERM');
    };
    expect(normalizeShellCommand(cmd, 'powershell', unreadable).cmd).toBe(cmd);
  });

  it('expands only bounded child-directory globs', () => {
    // A child directory is exact and still beneath the command workdir. A parent traversal
    // or absolute path is not: normalization must not pre-read a broader location merely
    // because the command itself could do so when it eventually runs.
    const cmd = "rg -n 'benchmark' ..\\docs\\*.md";
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    const withDrive = 'rg -n "Transport" C:\\Users\\x\\tunnel-client*';
    expect(normalizeShellCommand(withDrive, 'powershell', cwd).cmd).toBe(withDrive);
    const parentGlob = "rg -n 'x' src*\\nested\\*.md";
    expect(normalizeShellCommand(parentGlob, 'powershell', cwd).cmd).toBe(parentGlob);

    const nested = (directory = '.'): readonly string[] =>
      directory === 'sub' ? ['a.md', 'b.md', 'c.ts'] : [];
    expect(normalizeShellCommand("rg -n 'x' sub\\*.md", 'powershell', nested).cmd).toBe(
      "rg -n 'x' 'sub\\a.md' 'sub\\b.md'"
    );
  });

  it('never mistakes the search pattern for a filename glob', () => {
    // `.*` and `foo?` are regex here. Expanding either would change what is searched for.
    const cmd = 'rg -n "json\\.Marshal|Write\\(.*" src';
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    expect(normalizeShellCommand('rg "colou?r" src', 'powershell', cwd).cmd).toBe('rg "colou?r" src');
  });

  it('leaves a glob that is already a flag value alone', () => {
    const cmd = "rg -n 'x' -g '*.md' src";
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    const long = "rg -n 'x' --glob '*.md' src";
    expect(normalizeShellCommand(long, 'powershell', cwd).cmd).toBe(long);
  });

  it('leaves a glob the caller quoted on purpose alone', () => {
    // Quoting it is how a caller asks for the literal to reach ripgrep. Honour that.
    const cmd = "rg -n 'x' '*_test.go'";
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
  });

  it('leaves a shell expansion alone', () => {
    const cmd = 'rg -n "x" "$env:USERPROFILE\\go\\pkg\\*"';
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
  });

  it('touches nothing that is not ripgrep', () => {
    const cmd = 'Get-ChildItem *.md | Select-Object Name';
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    expect(normalizeShellCommand('go test ./...', 'powershell', cwd).cmd).toBe('go test ./...');
  });

  it('leaves POSIX shells alone, where the shell already expanded the glob', () => {
    const cmd = "rg -n 'x' *_test.go";
    expect(normalizeShellCommand(cmd, 'bash', cwd).cmd).toBe(cmd);
    expect(normalizeShellCommand(cmd, 'zsh', cwd).notes).toEqual([]);
  });
});

describe('saying what to do next', () => {
  it('names the cause when git ran outside a repository', () => {
    const hints = execRecoveryHints('git status --short', 'fatal: not a git repository (or any of the parent directories): .git');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/not a git repository/i);
    expect(hints[0]).toMatch(/rev-parse --show-toplevel/);
  });

  it('explains an unexpanded glob rather than leaving the code to be guessed at', () => {
    const hints = execRecoveryHints('rg -n x C:\\a\\b*', 'rg: C:\\a\\b*: IO error … (os error 123)');
    expect(hints.join(' ')).toMatch(/PowerShell does not expand/);
  });

  it('never gives a POSIX shell a PowerShell-only glob recovery command', () => {
    const output = 'rg: src/*.ts: IO error for operation on src/*.ts: No such file or directory (os error 2)';
    const hints = execRecoveryHints("rg -n x 'src/*.ts'", output, 'bash').join(' ');
    expect(hints).not.toMatch(/PowerShell|Get-ChildItem|\$env:/);
  });

  it('uses shell-native path and toolchain recovery syntax on POSIX', () => {
    const missingPath = execRecoveryHints(
      'rg -n x src/missing.ts',
      'rg: src/missing.ts: IO error for operation on src/missing.ts: No such file or directory (os error 2)',
      'zsh'
    ).join(' ');
    expect(missingPath).toContain("ls -ld -- '<path>'");
    expect(missingPath).not.toMatch(/Get-ChildItem|PowerShell/);

    const java = execRecoveryHints('gradle test', 'ERROR: JAVA_HOME is not set', 'bash').join(' ');
    expect(java).toContain('export JAVA_HOME=/path/to/jdk');
    expect(java).toContain('$JAVA_HOME/bin:$PATH');
    expect(java).not.toMatch(/\$env:|C:\\/);

    const go = execRecoveryHints('go test ./...', 'go: cannot find GOROOT directory', 'sh').join(' ');
    expect(go).toContain('bin/go');
    expect(go).toContain('export GOROOT=/path/to/go');
    expect(go).not.toContain('go.exe');
  });

  it('uses cmd-native toolchain recovery syntax when cmd was explicitly requested', () => {
    const java = execRecoveryHints('gradlew test', 'ERROR: JAVA_HOME is not set', 'cmd').join(' ');
    expect(java).toContain('set "JAVA_HOME=C:\\path\\to\\jdk"');
    expect(java).not.toContain('$env:');

    const go = execRecoveryHints('go test ./...', 'go: cannot find GOROOT directory', 'cmd').join(' ');
    expect(go).toContain('set "GOROOT=C:\\path\\to\\go"');
    expect(go).toContain('bin\\go.exe');
  });

  it('hands over the guard form when PowerShell 5.1 refused && or ||', () => {
    const refusal = "The token '&&' is not a valid statement separator in this version.";
    const hints = execRecoveryHints('npm test && npm publish', refusal);
    expect(hints).toHaveLength(1);
    // The point of the hint is the conditional, so it has to carry the guard and say why `;`
    // is not the answer — a model told only "use ;" would publish after a failing test run.
    expect(hints[0]).toMatch(/if \(\$\?\) \{ B \}/);
    expect(hints[0]).toMatch(/if \(-not \$\?\) \{ B \}/);
    expect(hints[0]).toMatch(/not the same as `;`/);
    expect(execRecoveryHints('a || b', "The token '||' is not a valid statement separator in this version.")).toHaveLength(1);
  });

  it('turns common PowerShell parser diagnostics into a correction at the failure site', () => {
    const cases = [
      {
        command: 'rg -n "unterminated src',
        output: 'ParserError: The string is missing the terminator: ".\nFullyQualifiedErrorId : TerminatorExpectedAtEndOfString',
        expected: /balance the quoted argument/i
      },
      {
        command: 'Get-Item -LiteralPath',
        output: 'ParserError: Missing an argument for parameter LiteralPath.\nFullyQualifiedErrorId : MissingArgument',
        expected: /supply the missing value/i
      },
      {
        command: 'python - <<EOF',
        output: 'ParserError: Missing file specification after redirection operator.\nFullyQualifiedErrorId : MissingFileSpecification',
        expected: /does not support Bash heredocs/i
      }
    ];

    for (const item of cases) {
      const hints = execRecoveryHints(item.command, item.output);
      expect(hints.join(' '), item.output).toMatch(/PowerShell parsed none of the command/i);
      expect(hints.join(' '), item.output).toMatch(item.expected);
      expect(hints.join(' '), item.output).toMatch(/rerun/i);
    }
  });

  it('stays silent on a shell where the operators work', () => {
    // PowerShell 7 runs `&&` without complaint, so there is no refusal text and no hint. The
    // hint keys off the shell's own error, never off the command containing the operator.
    expect(execRecoveryHints('npm test && npm publish', 'ok')).toHaveLength(0);
  });

  it('stays silent on a healthy result', () => {
    expect(execRecoveryHints('rg -n foo src', 'Process exited with code 0\nOutput:\nsrc/a.ts:1:foo')).toEqual([]);
  });

  it('appends notes without disturbing the parity-formatted body', () => {
    const body = 'Wall time: 0.1 seconds\nProcess exited with code 1\nOutput:\nx';
    expect(withExecNotes(body, [])).toBe(body);
    const noted = withExecNotes(body, ['do the thing']);
    expect(noted.startsWith(body)).toBe(true);
    expect(noted).toContain('Note: do the thing');
  });
});

describe('the exec_command pipeline, in the order tools-core actually runs it', () => {
  // The two rewrites are not independent, and the bug this guards was invisible to every
  // test that exercised them one at a time. `bindBundledRipgrep` turns the leading `rg`
  // into `& '<path>\\rg.exe'`, and `normalizeShellCommand` recognises ripgrep by exactly
  // that leading token -- so binding first switched off glob and brace expansion for every
  // ordinary rg call while every single-function test stayed green. Normalize, then bind.
  const RG = 'C:\\Program Files\\app\\rg.exe';
  const pipeline = (cmd: string, entries: readonly string[]) => {
    const normalized = normalizeShellCommand(cmd, 'powershell', () => entries);
    return bindBundledRipgrep(normalized.cmd, 'powershell', RG);
  };

  it('expands the glob and still pins the executable', () => {
    const out = pipeline('rg -n TODO *.ts', ['a.ts', 'b.ts', 'note.md']);
    expect(out).toContain("'a.ts'");
    expect(out).toContain("'b.ts'");
    expect(out).not.toContain('*.ts');
    expect(out.startsWith('& ')).toBe(true);
    expect(out).toContain('rg.exe');
  });

  it('expands a brace group and still pins the executable', () => {
    const out = pipeline('rg TODO src/{main,shared}', []);
    expect(out).toContain("'src/main'");
    expect(out).toContain("'src/shared'");
    expect(out).not.toContain('{main,shared}');
    expect(out.startsWith('& ')).toBe(true);
  });

  it('leaves the bound command provable enough to earn the benign-exit exemption', () => {
    // The exemption is what makes "no matches" stop counting as an error, and it requires a
    // path-qualified program. Classifying the pre-bind text instead would silently lose it.
    const out = pipeline('rg -n TODO *.ts', ['a.ts']);
    expect(nonZeroExitIsBenign(out, 1, '')).toBe(true);
    expect(nonZeroExitIsBenign('rg -n TODO a.ts', 1, '')).toBe(false);
  });
});

/**
 * The option table is a copy of another program's interface, and a copy goes stale silently.
 *
 * Nothing about a wrong entry looks like a failure: `rg --engine pcre2 foo.* src` with
 * `--engine` missing read `pcre2` as the pattern, expanded `foo.*` as a path, and answered a
 * question nobody asked — successfully. That is the whole reason the table was rewritten from
 * the binary's own help instead of from memory, and a bundled-ripgrep bump is an ordinary
 * dependency chore that would quietly undo it.
 *
 * So the pin and the table are checked against each other, which needs no binary and
 * therefore runs everywhere; and where the binary is actually on disk, the table is checked
 * against the help text it claims to have come from.
 */
describe('the ripgrep option table against the ripgrep this app ships', () => {
  it('is derived from the version the packaging actually pins', () => {
    // Read rather than imported: the pin lives in a .mjs the typecheck does not cover, and
    // the only thing needed here is the string a person edits when they bump ripgrep.
    const pinned = /version:\s*'([^']+)'/.exec(
      readFileSync('scripts/packaging-versions.mjs', 'utf8').split('export const RIPGREP')[1] ?? ''
    );
    expect(pinned?.[1]).toBe(RG_OPTION_TABLE_VERSION);
  });

  it('lists every option the binary documents, with the right arity', () => {
    const executable = locateRipgrep();
    // Only the packaging steps fetch ripgrep, so a plain `npm ci && npm test` has no binary
    // to ask. The pin check above is the half that catches the change a person makes.
    if (executable === null || !existsSync(executable)) return;

    const help = execFileSync(executable, ['--help'], { encoding: 'utf8' });
    const documented = new Map<string, boolean>();
    for (const line of help.split(/\r?\n/)) {
      // Option headers sit at exactly four spaces; their prose is indented further.
      if (!/^ {4}-/.test(line)) continue;
      for (const part of line.trim().split(/,\s+/)) {
        // `-A NUM`, `--after-context=NUM` take a value; `-i`, `--ignore-case` do not.
        const match = /^(--?[A-Za-z0-9][A-Za-z0-9.-]*)(?:[=\s](\S+))?$/.exec(part);
        if (!match?.[1]) continue;
        documented.set(match[1], match[2] !== undefined);
      }
    }
    expect(documented.size).toBeGreaterThan(100);

    const wrong: string[] = [];
    for (const [flag, takesValue] of documented) {
      const table = RG_VALUE_FLAGS.has(flag) ? true : RG_BOOLEAN_FLAGS.has(flag) ? false : null;
      if (table === null) wrong.push(`${flag} is missing from the table`);
      else if (table !== takesValue) {
        wrong.push(`${flag} is listed as ${table ? 'taking a value' : 'boolean'} and is not`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

/**
 * The two commands below are verbatim from one recorded session: worker-2 of run 7a301153,
 * 24 August, six non-zero exits in forty-six calls. Both were refused by the shell before a
 * single statement of them ran, and the first took a `git diff` and two `echo`s down with it.
 * Neither the exit code nor the parser error mentioned the escape character that caused it.
 */
const WORKER_2_SYMBOL_SWEEP =
  "echo '--- connection diff ---'; git diff -- src/main/connection.ts; " +
  "echo '--- connection/ipc/preload/renderer symbols ---'; " +
  'rg -n "connection:|connectBtn|connect-button|connecting|disconnect|applySettings|' +
  'saveSettings|onState|state === \'starting|state === \\"starting" ' +
  'src/main/ipc.ts src/preload/index.ts src/renderer/main.ts';

const WORKER_2_IMPORT_SWEEP =
  'rg -n "from \'../src/main/connection|from \\"../src/main/connection|' +
  'connection\\.js\'|connection\\.js\\"" test src | Select-Object -First 200';

describe('repairing a bash-style escaped quote', () => {
  it('re-quotes the argument PowerShell would have refused, keeping the backslash', () => {
    const repaired = repairPowerShellQuoting(WORKER_2_SYMBOL_SWEEP, 'powershell');
    expect(repaired.cmd).toContain(
      "rg -n 'connection:|connectBtn|connect-button|connecting|disconnect|applySettings|" +
        "saveSettings|onState|state === ''starting|state === \\\"starting' src/main/ipc.ts"
    );
    // The statements that had nothing to do with the broken quote are untouched.
    expect(repaired.cmd).toContain("echo '--- connection diff ---'; git diff -- src/main/connection.ts");
    expect(repaired.notes).toHaveLength(1);
  });

  it('repairs every broken argument on the line and leaves the rest of it alone', () => {
    const repaired = repairPowerShellQuoting(WORKER_2_IMPORT_SWEEP, 'powershell');
    expect(repaired.cmd).toBe(
      "rg -n 'from ''../src/main/connection|from \\\"../src/main/connection|" +
        "connection\\.js''|connection\\.js\\\"' test src | Select-Object -First 200"
    );
  });

  it('repairs the five balanced ripgrep patterns from the latest recorded failures', () => {
    const recorded = [
      String.raw`Write-Host '--- limits ---'; rg -n "plain" src; rg -n "process-manager|from './exec'|from \"./exec\"|fallback" src/main`,
      String.raw`rg -n "type.?=.?['\"]wait|['\"]wait['\"]|Start-Sleep|Sleep" src/main/computer/helper.ts test`,
      String.raw`rg -n first src; Write-Host '--- imports ---'; rg -n "from ['\"][^'\"]*(process-manager|patch-files|/patch)\.js['\"]" src`,
      String.raw`rg -n "one" src; rg -n "two" src; rg -n "from './patch\.js'|from \"./patch\.js\"" src/main`,
      String.raw`rg -n "from ['\"][^'\"]*fsops\.js['\"]" src/main --glob '!out/**'`
    ];

    for (const command of recorded) {
      const repaired = repairPowerShellQuoting(command, 'powershell');
      expect(repaired.cmd, command).not.toBe(command);
      expect(repaired.notes, command).toHaveLength(1);
      expect(repaired.cmd, command).not.toMatch(/(?:^|\s)"[^"\r\n]*\\"/);
    }

    expect(repairPowerShellQuoting(recorded[4] as string, 'powershell').cmd).toBe(
      String.raw`rg -n 'from [''\"][^''\"]*fsops\.js[''\"]' src/main --glob '!out/**'`
    );
  });

  it('never introduces a backtick, so the rest of this file still trusts its own parse', () => {
    // A backtick would be a correct PowerShell escape and a silent regression here:
    // hasUnsupportedShellLexemes treats one as unparseable, which would switch off ripgrep
    // binding and the benign-exit exemption for exactly the commands this repair touched.
    for (const command of [WORKER_2_SYMBOL_SWEEP, WORKER_2_IMPORT_SWEEP]) {
      const repaired = repairPowerShellQuoting(command, 'powershell');
      expect(repaired.cmd).not.toContain('`');
      expect(bindBundledRipgrep(repaired.cmd, 'powershell', 'C:\\tools\\rg.exe')).toContain(BOUND_RG);
    }
  });

  it('leaves a command PowerShell can already parse exactly as written', () => {
    // The same backslash-quote, already in the single quotes that make it work. Repairing
    // this would be rewriting a command that was going to succeed.
    const fine = "rg -n 'state === \\\"starting' src";
    expect(repairPowerShellQuoting(fine, 'powershell')).toEqual({ cmd: fine, notes: [] });
    expect(repairPowerShellQuoting('rg -n "plain" src', 'powershell').notes).toHaveLength(0);
    // A balanced backslash before a closing quote is valid PowerShell outside the one
    // ripgrep-pattern slot this repair understands. Do not reinterpret arbitrary shell data.
    const path = String.raw`Write-Output "C:\"; Write-Output done`;
    expect(repairPowerShellQuoting(path, 'powershell')).toEqual({ cmd: path, notes: [] });
    const operand = String.raw`rg -n plain "path\"with\"quotes"`;
    expect(repairPowerShellQuoting(operand, 'powershell')).toEqual({ cmd: operand, notes: [] });
  });

  it('refuses a body whose meaning would change in single quotes', () => {
    // $ is an interpolation single quotes would kill; a backtick is an escape this reading
    // does not model; a doubled backslash is one backslash to bash and two here. Each of
    // these lines is left for the shell to refuse and the hint to explain.
    const interpolated = 'rg -n "$pattern|x === \\"y" src';
    const backticked = 'rg -n "a`tb|x === \\"y" src';
    const doubled = 'rg -n "a\\\\b|x === \\"y" src';
    for (const command of [interpolated, backticked, doubled]) {
      expect(repairPowerShellQuoting(command, 'powershell').cmd).toBe(command);
    }
  });

  it('does not touch a line that is broken for some other reason', () => {
    // A genuinely mismatched quote, from the same corpus: the closing quote landed before
    // the `:` instead of after `maximum`. There is no backslash-quote to move and no way to
    // know what was meant, so it keeps failing loudly.
    const mismatched = 'rg -n "schema|maximum": tunnel-go/server.go | Select-Object -First 30';
    expect(repairPowerShellQuoting(mismatched, 'powershell').cmd).toBe(mismatched);
  });

  it('stays out of a shell that already understands the escape', () => {
    // bash reads the caller's line correctly as written; rewriting it there could only break it.
    expect(repairPowerShellQuoting(WORKER_2_SYMBOL_SWEEP, 'bash').notes).toHaveLength(0);
    expect(repairPowerShellQuoting(WORKER_2_SYMBOL_SWEEP, 'bash').cmd).toBe(WORKER_2_SYMBOL_SWEEP);
  });

  it('hands the program the pattern the caller actually wrote', () => {
    // The point of the whole exercise, checked against the shell rather than against a belief
    // about it. The repaired text is executed as a command line, which is how it reaches
    // PowerShell in production — not passed through an argv API that would do its own
    // escaping and prove nothing about this.
    if (process.platform !== 'win32') return;
    const probe = join(tmpdir(), 'exec-hints-argv-probe.ps1');
    const driver = join(tmpdir(), 'exec-hints-argv-driver.ps1');
    writeFileSync(probe, 'foreach ($a in $args) { [Console]::Out.WriteLine("<" + $a + ">") }\n', 'utf8');

    const argv = (commandLine: string): string[] => {
      writeFileSync(driver, `${commandLine}\n`, 'utf8');
      return execFileSync('powershell.exe', ['-NoProfile', '-File', driver], { encoding: 'utf8' })
        .split(/\r?\n/)
        .filter((line) => line !== '');
    };

    // Invoked as a native executable on purpose. Passing a literal quote is a property of the
    // Win32 command line and its CommandLineToArgvW round trip, which is what ripgrep and every
    // other program here goes through; a .ps1 called in-process receives .NET strings directly
    // and would answer a question nobody asked.
    const exe = `& 'powershell.exe' -NoProfile -File '${probe}'`;
    const call = `${exe} "state === \\"starting" second`;
    const repaired = repairPowerShellQuoting(call, 'powershell');
    expect(repaired.cmd).toBe(`${exe} 'state === \\"starting' second`);
    expect(argv(repaired.cmd)).toEqual(['<state === "starting>', '<second>']);

    // Why the repair is not one of the two escapes PowerShell itself accepts. Both of these
    // parse, and both then reach the program with the quote gone and the next argument
    // swallowed into the first — a wrong answer reported as a successful one.
    expect(argv(`${exe} "state === ""starting" second`)).toEqual(['<state === starting second>']);
    expect(argv(`${exe} "state === \`"starting" second`)).toEqual(['<state === starting second>']);
  });
});

describe('saying that a benign exit was benign', () => {
  it('names the program and both shapes, so the caller does not re-run the search', () => {
    const note = benignExitNote(`${BOUND_RG} -n foo src | Select-Object -First 200`);
    expect(note).toContain('`rg`');
    expect(note).toContain('no matches');
    expect(note).toContain('Select-Object -First');
    expect(withExecNotes('Process exited with code 1\nOutput:\n', [note])).toContain('Note: Exit code 1');
  });

  it('uses POSIX vocabulary for a POSIX no-match result', () => {
    const note = benignExitNote('rg -n foo src', 'bash');
    expect(note).toContain('no matches');
    expect(note).not.toMatch(/Select-Object|PowerShell/);
  });
});

describe('hinting at a refused line', () => {
  it('explains the escape character that caused the parser error', () => {
    const refusal = [
      'The string is missing the terminator: ".',
      '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException',
      '    + FullyQualifiedErrorId : TerminatorExpectedAtEndOfString'
    ].join('\n');
    const hints = execRecoveryHints(WORKER_2_SYMBOL_SWEEP, refusal);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('not an escape character in PowerShell');
    expect(hints[0]).toContain('single quotes');
    // The other half of the damage, which the bare parser error never mentions.
    expect(hints[0]).toContain('including any earlier statement on the same line');
  });

  it('does not fire on output that merely mentions a terminator', () => {
    expect(execRecoveryHints('rg -n foo src', 'src/x.ts:4: // the string is missing here')).toHaveLength(0);
  });

  it('does not blame backslash quoting when the command did not contain it, but still explains the parser failure', () => {
    const refusal = [
      'The string is missing the terminator: ".',
      '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException'
    ].join('\n');
    const hints = execRecoveryHints("Write-Output 'unfinished", refusal);
    expect(hints).toHaveLength(1);
    expect(hints[0]).not.toContain('backslash');
    expect(hints[0]).toMatch(/balance the quoted argument/i);
    expect(hints[0]).toMatch(/parsed none/i);
  });
});

describe('a pipeline stopped early by Select-Object -First', () => {
  // Verbatim from a worker's session: the diff printed 383 lines and the call was still filed
  // as an error, so the model ran it again.
  const WORKER_1_DIFF_CUT =
    "Select-String -Path docs/bug-audit-2026-08-24.md -Pattern 'DONE|SSE' -Context 2,3; " +
    'git diff -- test/agents.test.ts test/goal.test.ts src/main/agents.ts src/main/goal.ts | ' +
    'Select-Object -First 220';
  const DIFF_OUTPUT = ['diff --git a/src/main/goal.ts b/src/main/goal.ts', '@@ -1,4 +1,4 @@', '-const a = 1;'].join('\n');

  it('is benign when the generator is a git command that only reports', () => {
    expect(nonZeroExitIsBenign(WORKER_1_DIFF_CUT, 1, DIFF_OUTPUT)).toBe(true);
  });

  it('says the cut caused it and names the flag that keeps the status meaningful', () => {
    const note = benignExitNote(WORKER_1_DIFF_CUT);
    expect(note).toContain('Select-Object -First');
    expect(note).toContain('`git`');
    expect(note).toContain('-Wait');
    // The no-match wording belongs to the search shape and would be a lie about git.
    expect(note).not.toContain('no matches');
  });

  // Every negative below is the direction this must fail towards: a real failure recorded as a
  // failure. The first is the one that would do the most damage.
  it('is not benign when the cut program is a test run that genuinely failed', () => {
    const output = ['RUN v4.1.10', 'x does not publish a handoff 15ms', 'AssertionError: expected'].join('\n');
    expect(nonZeroExitIsBenign('npm test -- --run test/goal.test.ts | Select-Object -First 120', 1, output)).toBe(false);
    expect(nonZeroExitIsBenign('npx vitest run test/goal.test.ts | Select-Object -First 40', 1, output)).toBe(false);
    expect(nonZeroExitIsBenign('node scripts/check.js | Select-Object -First 40', 1, output)).toBe(false);
  });

  it('is not benign when a flag has spent the exit code on an answer', () => {
    for (const flag of ['--exit-code', '--quiet', '--check']) {
      expect(nonZeroExitIsBenign(`git diff ${flag} -- src | Select-Object -First 220`, 1, DIFF_OUTPUT)).toBe(false);
    }
  });

  it('is not benign for a git subcommand that can fail after printing', () => {
    expect(nonZeroExitIsBenign('git apply --stat patch.diff | Select-Object -First 20', 1, DIFF_OUTPUT)).toBe(false);
    expect(nonZeroExitIsBenign('git push origin main | Select-Object -First 20', 1, DIFF_OUTPUT)).toBe(false);
  });

  it('is not benign without the stage that actually stops the pipeline', () => {
    expect(nonZeroExitIsBenign('git diff -- src', 1, DIFF_OUTPUT)).toBe(false);
    // -Last has to drain the pipeline to know what the last N are, so it never cuts anything.
    expect(nonZeroExitIsBenign('git diff -- src | Select-Object -Last 220', 1, DIFF_OUTPUT)).toBe(false);
    expect(nonZeroExitIsBenign('git diff -- src | Sort-Object', 1, DIFF_OUTPUT)).toBe(false);
  });

  it('is not benign when a stage between the two could have set the status itself', () => {
    expect(
      nonZeroExitIsBenign('git diff -- src | Where-Object { $_ -match "x" } | Select-Object -First 5', 1, DIFF_OUTPUT)
    ).toBe(false);
  });

  it('is not benign when nothing was printed, or when git printed a failure of its own', () => {
    expect(nonZeroExitIsBenign('git diff -- src | Select-Object -First 220', 1, '')).toBe(false);
    expect(
      nonZeroExitIsBenign('git diff -- src | Select-Object -First 220', 1, 'fatal: not a git repository')
    ).toBe(false);
  });

  it('withholds the exemption from a form whose subcommand it cannot prove', () => {
    // `git -C dir diff` reads the same to a person. Proving which token is the subcommand means
    // knowing which of git's own options take a value, and being wrong is how `--exit-code`
    // would slip through.
    expect(nonZeroExitIsBenign('git -C sub diff -- src | Select-Object -First 220', 1, DIFF_OUTPUT)).toBe(false);
  });

  it('leaves an exit code other than 1 alone', () => {
    expect(nonZeroExitIsBenign('git diff -- src | Select-Object -First 220', 2, DIFF_OUTPUT)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('is what the shell really does with a cut pipeline', () => {
    const run = (command: string): number => {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe']
        });
        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? -1;
      }
    };

    // One native process with far more to write than the stage will take, so the cut lands
    // while it is still writing. A cmdlet loop would not do: stopping it leaves $LASTEXITCODE
    // holding the status of whichever child had already finished, which is 0.
    const generator = 'cmd /c "for /l %i in (1,1,20000) do @echo line%i"';
    expect(run(`${generator} | Select-Object -First 5 | Out-Null`)).not.toBe(0);
    // -Wait drains instead of stopping, which is the remedy the note hands the model.
    expect(run(`${generator} | Select-Object -First 5 -Wait | Out-Null`)).toBe(0);
  });
});

describe('hinting at a search path that does not exist', () => {
  const PARTIAL = [
    'rg: src/main/codex/workspace.ts: The system cannot find the file specified. (os error 2)',
    'src/main/workspace.ts:67: export function workspaceKey(): string | null {'
  ].join('\n');

  it('says the other matches are still a complete answer', () => {
    const hints = execRecoveryHints('rg -n "workspaceKey" src/main/codex/workspace.ts src/main/workspace.ts', PARTIAL);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('does not exist');
    expect(hints[0]).toContain('complete answer for the paths that do');
  });

  it('does not take over the unexpanded-glob case, which is a different error', () => {
    const glob = 'rg: test/*agent*: The filename, directory name, or volume label syntax is incorrect. (os error 123)';
    const hints = execRecoveryHints('rg -n "message.id" test/*agent*', glob);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('does not expand');
  });

  it('does not fire on a match whose text happens to mention the error', () => {
    const line = 'src/main/exec-hints.ts:44: // grep: os error 2 is a missing path';
    expect(execRecoveryHints('rg -n "os error" src', line)).toHaveLength(0);
  });
});
