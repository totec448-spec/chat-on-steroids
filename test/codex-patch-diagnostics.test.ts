import { describe, expect, it } from 'vitest';
import { ApplyPatchError } from '../src/main/codex/apply-patch/errors.js';
import { deriveNewContentsFromChunks } from '../src/main/codex/apply-patch/file-update.js';
import { parsePatch } from '../src/main/codex/apply-patch/parser.js';
import { emptyEvidence } from '../src/main/mcp/call-context.js';
import { summarizeToolCall } from '../src/main/session/summarize.js';

function chunks(body: string) {
  const hunk = parsePatch(`*** Begin Patch\n*** Update File: sample.ts\n${body}\n*** End Patch`).hunks[0]!;
  if (hunk.kind !== 'update_file') throw new Error('Expected update');
  return hunk.chunks;
}

describe('patch mismatch diagnostics without relaxed matching', () => {
  it.each(['normalize_to_lf', 'preserve_line_endings'] as const)('explains backward edits and accepts the ordered correction (%s)', async mode => {
    const source = 'function early() {}\r\nseparator\r\nfunction late() {}\r\n';
    const early = '@@\n-function early() {}\n+function early() { return 1; }';
    const late = '@@\n-function late() {}\n+function late() { return 2; }';
    const failure = await deriveNewContentsFromChunks('sample.ts', chunks(`${late}\n${early}`), mode, source).catch(error => error);
    expect(failure).toBeInstanceOf(ApplyPatchError);
    expect(failure.message).toContain('Matching text exists at line 1, before the current search position at line 4');
    expect(failure.message).toContain('Put edits in file order');
    expect(failure.sourceContext).toContain('1\tfunction early() {}');
    const corrected = await deriveNewContentsFromChunks('sample.ts', chunks(`${early}\n${late}`), mode, source);
    expect(corrected.newContents).toContain('function early() { return 1; }');
    expect(corrected.newContents).toContain('function late() { return 2; }');
    if (mode === 'preserve_line_endings') expect(corrected.newContents).toContain('\r\n');
  });

  it('explains backward @@ context markers too', async () => {
    const failure = await deriveNewContentsFromChunks('sample.ts', chunks(
      '@@\n-late();\n+later();\n@@ function early() {\n-old();\n+new();'
    ), 'normalize_to_lf', 'function early() {\nold();\n}\nlate();\n').catch(error => error);
    expect(failure.message).toContain('Failed to find context in sample.ts');
    expect(failure.message).toContain('Matching text exists at line 1');
  });

  it('rejects reconstructed old text and shows a bounded snapshot near its unique anchor', async () => {
    const source = `unrelated\nfor (const tab of exact) {\n  try {\n    reload(tab.id);\n  } catch { /* actual comment */ }\n}\n${'x'.repeat(5000)}\n${'tail\n'.repeat(100)}`;
    const failure = await deriveNewContentsFromChunks('sample.ts', chunks(
      '@@\n for (const tab of exact) {\n-  try { reload(tab.id); } catch { /* guessed */ }\n+  fixed();\n }'
    ), 'normalize_to_lf', source).catch(error => error);
    expect(failure.message).toContain('Use the current file text as patch context');
    expect(failure.message).not.toContain('Matching text exists');
    expect(failure.sourceContext).toContain('5\t  } catch { /* actual comment */ }');
    expect(failure.message).not.toContain('actual comment'); // Source stays separate for permission gating.
    expect(failure.sourceContext.length).toBeLessThan(2200);
    expect(failure.sourceContext.split('\n')).toHaveLength(9);
  });

  it('does not invent an excerpt location from absent or ambiguous anchors', async () => {
    for (const source of ['other text\n', 'sharedAnchor();\nfirst();\nsharedAnchor();\nsecond();\n']) {
      const failure = await deriveNewContentsFromChunks('sample.ts', chunks(
        '@@\n sharedAnchor();\n-missing();\n+new();'
      ), 'normalize_to_lf', source).catch(error => error);
      expect(failure.sourceContext).toBeUndefined();
    }
  });

  it('bounds echoed expected text even for very long lines and many lines', async () => {
    const body = ['@@', ...Array.from({ length: 100 }, () => `-${'x'.repeat(10000)}`), '+replacement'].join('\n');
    const failure = await deriveNewContentsFromChunks('sample.ts', chunks(body), 'normalize_to_lf', 'actual\n').catch(error => error);
    expect(failure.message.length).toBeLessThan(2400);
    expect(failure.message).toContain('(expected text truncated)');
    expect(failure.sourceContext).toBeUndefined();
  });
});

describe('patch mismatch timeline wording', () => {
  const summary = (head: string, tool = 'apply_patch', changed = false) => summarizeToolCall({
    tool, args: {}, durationMs: 1, outcome: 'tool_rejected', resultHead: head,
    evidence: { ...emptyEvidence(), changes: changed ? [{ path: '/workspace/a.ts', added: 1, removed: 1, approximate: false }] : [] }
  });

  it.each(['expected lines in /workspace/a.ts:', 'context in /workspace/a.ts:', "context 'function f()' in /workspace/a.ts"])(
    'labels a verified mismatch distinctly (%s)', reason => {
      expect(summary(`apply_patch verification failed: Failed to find ${reason}`)).toMatchObject({
        title: 'Patch didn’t match', metric: 'not applied', tone: 'warn'
      });
    }
  );

  it('keeps permission, identity, syntax and partial failures distinct', () => {
    for (const head of ['TOOL_DISABLED: Edit is disabled', 'Exact chat identity required', 'apply_patch verification failed: invalid patch']) {
      expect(summary(head)).toMatchObject({ title: 'Refused to apply a patch', metric: 'refused' });
    }
    const head = 'apply_patch verification failed: Failed to find expected lines in /workspace/a.ts:';
    expect(summary(head, 'external_plugin').title).not.toBe('Patch didn’t match');
    expect(summary(head, 'apply_patch', true).title).not.toBe('Patch didn’t match');
  });
});
