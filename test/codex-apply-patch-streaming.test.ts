import { describe, expect, it } from 'vitest';
import type { Hunk } from '../src/main/codex/apply-patch/hunk.js';
import { StreamingPatchParser } from '../src/main/codex/apply-patch/streaming-parser.js';

const lines = [
  '*** Begin Patch', '*** Environment ID: repo-1',
  '*** Add File: new.txt', '+😀 text  ', '*** Delete File: old.txt',
  '*** Update File: a.txt', '*** Move to: b.txt', '@@ function x',
  ' same  ', '-before', '+after', '', '*** End of File', '',
  '@@', '-last', '+next', '*** End Patch'
];
const expected: Hunk[] = [
  { kind: 'add_file', path: 'new.txt', contents: '😀 text  \n' },
  { kind: 'delete_file', path: 'old.txt' },
  {
    kind: 'update_file', path: 'a.txt', movePath: 'b.txt',
    chunks: [
      {
        changeContext: 'function x', oldLines: ['same  ', 'before', ''],
        newLines: ['same  ', 'after', ''], contextLineIndices: [[0, 0], [2, 2]], isEndOfFile: true
      },
      {
        changeContext: null, oldLines: ['last'], newLines: ['next'],
        contextLineIndices: [], isEndOfFile: false
      }
    ]
  }
];

describe('streamed apply_patch grammar', () => {
  it.each(['\n', '\r\n'])('preserves hunks across every split, including %j and Unicode boundaries', newline => {
    const patch = lines.join(newline);
    for (let split = 0; split <= patch.length; split++) {
      const parser = new StreamingPatchParser();
      parser.pushDelta(patch.slice(0, split));
      parser.pushDelta(patch.slice(split));
      expect(parser.finish()).toEqual(expected);
      expect(parser.environmentId()).toBe('repo-1');
    }
    const parser = new StreamingPatchParser();
    for (let index = 0; index < patch.length; index++) parser.pushDelta(patch[index]!);
    expect(parser.finish()).toEqual(expected);
  });

  it('returns detached snapshots while subsequent chunks extend the same hunk', () => {
    const parser = new StreamingPatchParser();
    const snapshot = parser.pushDelta('*** Begin Patch\n*** Update File: a.txt\n context\n');
    const update = snapshot[0];
    if (update?.kind !== 'update_file') throw new Error('Expected an update hunk');
    update.path = 'tampered';
    update.chunks[0]!.oldLines.push('tampered');
    update.chunks[0]!.contextLineIndices[0]![0] = 99;
    parser.pushDelta('-before\n+after\n*** End Patch\n');
    expect(parser.finish()).toEqual([{
      kind: 'update_file', path: 'a.txt', movePath: null,
      chunks: [{
        changeContext: null, oldLines: ['context', 'before'], newLines: ['context', 'after'],
        contextLineIndices: [[0, 0]], isEndOfFile: false
      }]
    }]);
  });

  it.each([
    [['*** Begin Patch', '*** Update File: a.txt', '*** End Patch'],
      "invalid hunk at line 2, Update file hunk for path 'a.txt' is empty"],
    [['*** Begin Patch', '*** Update File: a.txt', '@@', '*** End Patch'],
      'invalid hunk at line 4, Update hunk does not contain any lines'],
    [['*** Begin Patch', '*** Update File: a.txt', '-old', '*** End of File', '+new', '*** End Patch'],
      "invalid hunk at line 5, Expected update hunk to start with a @@ context marker, got: '+new'"]
  ])('keeps error locations and messages independent of chunk boundaries', (invalidLines, message) => {
    const patch = invalidLines.join('\r\n');
    for (let split = 0; split <= patch.length; split++) {
      const parser = new StreamingPatchParser();
      expect(() => {
        parser.pushDelta(patch.slice(0, split));
        parser.pushDelta(patch.slice(split));
        parser.finish();
      }).toThrow(message);
    }
  });
});
