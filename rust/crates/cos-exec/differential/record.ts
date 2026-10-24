// Wraps the two benign-exit exports of exec-hints.ts so every call the TypeScript tests make,
// directly or through tools-core, is appended to the file named by COS_BENIGN_RECORD. Each exit
// they find benign also records the note both shell families would get for it.
import { appendFileSync } from 'node:fs';
import { vi } from 'vitest';

vi.mock('../../../../src/main/exec-hints.js', async (importOriginal) => {
  const hints = await importOriginal<typeof import('../../../../src/main/exec-hints.js')>();
  const file = process.env.COS_BENIGN_RECORD ?? '';
  const record = (row: object): void => appendFileSync(file, JSON.stringify(row) + '\n');
  type NoteArgs = Parameters<typeof hints.benignExitNote>;
  const note = (...args: NoteArgs): string => {
    const text = hints.benignExitNote(...args);
    const [command, shellType = 'powershell', exitCode = null, outputText = null] = args;
    record({ fn: 'note', command, shellType, exitCode, outputText, note: text });
    return text;
  };
  return {
    ...hints,
    nonZeroExitIsBenign: (command: string, exitCode: number | null, outputText: string) => {
      const benign = hints.nonZeroExitIsBenign(command, exitCode, outputText);
      record({ fn: 'benign', command, exitCode, outputText, benign });
      if (benign) {
        note(command, 'powershell', exitCode, outputText);
        note(command, 'bash', exitCode, outputText);
      }
      return benign;
    },
    benignExitNote: note
  };
});
