import { afterEach, expect, it } from 'vitest';
import { CommandBatchDisplay, parseCommandBatchSections } from '../src/main/codex/command-batch.js';
import { UnifiedExecProcessManager, execCommandResponseText, execCommandStructuredOutput } from '../src/main/codex/unified-exec.js';

const marker = '0123456789abcdef01234567';
const suffix = ` [clf-batch:${marker}]`;
const wire = `--- command 1/1 ---${suffix}\r\n--- exit code 0 ---\nreal error\n--- exit code 7 ---${suffix}\r\n`;
const visible = wire.replaceAll(suffix, '');
const managers: UnifiedExecProcessManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.terminateAllProcesses(); });

it('removes only the invocation delimiter across every byte boundary, preserving output and fake exit lines', () => {
  for (let split = 0; split <= wire.length; split++) {
    const display = new CommandBatchDisplay(marker);
    expect(Buffer.concat([display.push(Buffer.from(wire.slice(0, split))), display.push(Buffer.from(wire.slice(split)), true)]).toString()).toBe(visible);
  }
  const display = new CommandBatchDisplay(marker);
  expect(Buffer.concat([...Buffer.from(wire)].map((byte) => display.push(Buffer.from([byte]))).concat(display.push(Buffer.alloc(0), true))).toString()).toBe(visible);
  expect(parseCommandBatchSections(wire, marker)).toEqual([{ index: 1, exitCode: 7, text: '--- exit code 0 ---\nreal error' }]);
  expect(parseCommandBatchSections(wire, 'f'.repeat(24))).toEqual([]);
});

it('keeps different markers, ordinary Unicode bytes, and an incomplete delimiter at stream close', () => {
  const input = `hello 日本語 🦉 [clf-batch:${'f'.repeat(24)}]\n [clf-batch:012`;
  const display = new CommandBatchDisplay(marker);
  expect(Buffer.concat([...Buffer.from(input)].map((byte) => display.push(Buffer.from([byte]))).concat(display.push(Buffer.alloc(0), true))).toString()).toBe(input);
});

async function start(script: string) {
  const manager = new UnifiedExecProcessManager(5_000);
  managers.push(manager);
  const output = await manager.execCommand({ command: [process.execPath, '-e', script], batchMarker: marker,
    shellType: process.platform === 'win32' ? 'powershell' : 'bash', hookCommand: 'batch presentation fixture',
    processId: manager.allocateProcessId(), yieldTimeMs: 250, maxOutputTokens: undefined,
    truncationPolicy: { kind: 'tokens', tokens: 100 }, cwd: process.cwd(), displayCwd: process.cwd(), env: process.env, tty: false });
  return { manager, output };
}

it('keeps framing internal before retention and token truncation in both result representations', async () => {
  const { output } = await start(`process.stdout.write(${JSON.stringify(wire)}); process.stdout.write('x'.repeat(2_200_000)); process.stdout.write(${JSON.stringify(wire)});`);
  expect(output.rawOutput.toString()).toContain(suffix);
  expect(output.displayOutput?.toString()).not.toContain('clf-batch:');
  expect(output.outputOmittedBytes).toBeGreaterThan(0);
  const text = execCommandResponseText(output);
  const structured = execCommandStructuredOutput(output);
  expect(text).toContain(structured.output);
  expect(text).not.toContain(marker);
  expect(structured.output).not.toContain('clf-batch:');
});

it('projects a delimiter split between initial output and a later stdin poll exactly once', async () => {
  const first = `--- command 1/1 ---${suffix.slice(0, 15)}`;
  const rest = `${suffix.slice(15)}\nhello\n--- exit code 7 ---${suffix}\n`;
  const { manager, output } = await start(`process.stdout.write(${JSON.stringify(first)}); setTimeout(() => { process.stdout.write(${JSON.stringify(rest)}); process.exitCode = 7; }, 900);`);
  expect(output.processId).not.toBeNull();
  const displays = [String(execCommandStructuredOutput(output).output)];
  let current = output;
  while (current.processId !== null) {
    current = await manager.writeStdin({ processId: current.processId, input: '', yieldTimeMs: 1_000, maxOutputTokens: undefined, truncationPolicy: { kind: 'tokens', tokens: 100 } });
    expect(execCommandResponseText(current)).toContain(execCommandStructuredOutput(current).output);
    displays.push(String(execCommandStructuredOutput(current).output));
  }
  expect(displays.join('')).toBe('--- command 1/1 ---\nhello\n--- exit code 7 ---\n');
  expect(current.exitCode).toBe(7);
});
