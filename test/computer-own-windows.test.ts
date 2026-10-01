import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

// macOS skips the app's own process inside the in-process backend. On Windows the helper is a
// separate PowerShell process, so the app passes its id and Window() leaves those windows out.
describe('the desktop helper leaves the app\'s own windows out', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('starts the Windows helper with the app process id', async () => {
    const spawn = vi.fn(() => {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      const on = (event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return child;
      };
      const emit = (target: { listeners: typeof listeners }, event: string, ...args: unknown[]) =>
        target.listeners.get(event)?.forEach((listener) => listener(...args));
      const stdout = { listeners: new Map(), on(event: string, listener: (...args: unknown[]) => void) {
        stdout.listeners.set(event, [...(stdout.listeners.get(event) ?? []), listener]); return stdout; } };
      const child: any = {
        pid: 9100, exitCode: null, listeners, on, once: on, removeListener: () => child, kill: () => true,
        stdout, stderr: { on: () => child.stderr, listeners: new Map() },
        stdin: {
          write(_line: string, _encoding: string, callback: (error?: Error | null) => void) {
            callback(null);
            queueMicrotask(() => emit(stdout as never, 'data',
              Buffer.from(`${JSON.stringify({ ok: true, windows: [], screen: { x: 0, y: 0, width: 100, height: 100 } })}\n`)));
            return true;
          },
          end() {}
        }
      };
      queueMicrotask(() => emit(child, 'spawn'));
      return child;
    });
    vi.doMock('node:child_process', () => ({ spawn }));
    vi.doMock('../src/main/exec.js', () => ({ findWindowsPowerShell: () => 'powershell.exe', terminateProcessTree: vi.fn() }));
    vi.doMock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    vi.resetModules();
    const { listWindows } = await import('../src/main/computer/index.js');
    await listWindows();
    const options = (spawn.mock.calls[0] as unknown[])[2] as { env: Record<string, string> };
    expect(options.env.COS_APP_PID).toBe(String(process.pid));
  });

  it('reads the id into the helper before it serves a request', () => {
    const setup = HELPER_SCRIPT.indexOf('[Clf]::OwnPid = [uint32]$env:COS_APP_PID');
    expect(setup).toBeGreaterThan(0);
    expect(setup).toBeLessThan(HELPER_SCRIPT.indexOf('function Handle-Request('));
  });

  it.runIf(process.platform === 'win32')('describes another process\'s window but not one owned by the app', () => {
    // Compile the real Window() with substituted native boundaries; no real window is read.
    const method = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf('public static string Window(long handle)'),
      HELPER_SCRIPT.indexOf('public static List<string> Windows()'));
    const source = `using System;
using System.Text;
public static class CosWindowsAppIdentity {
  public static string[] Read(long handle, uint pid) { return new string[] { "fixture.exe", "C:\\\\fixture.exe", "" }; }
}
public static class OwnProbe {
  public static uint OwnPid = 0;
  public struct RECT { public int Left, Top, Right, Bottom; }
  static bool IsWindow(IntPtr h) { return true; }
  static bool IsWindowVisible(IntPtr h) { return true; }
  static int GetWindowTextLengthW(IntPtr h) { return 7; }
  static int GetWindowTextW(IntPtr h, StringBuilder text, int count) { text.Append("Fixture"); return 7; }
  static bool GetWindowRect(IntPtr h, out RECT r) { r = new RECT { Left = 0, Top = 0, Right = 100, Bottom = 80 }; return true; }
  static uint GetWindowThreadProcessId(IntPtr h, out uint pid) { pid = (uint)h.ToInt64() * 10; return 1; }
  static bool IsIconic(IntPtr h) { return false; }
  static IntPtr GetForegroundWindow() { return IntPtr.Zero; }
  static uint GetDpiForWindow(IntPtr h) { return 96; }
  ${method}
}`;
    const script = `Add-Type -TypeDefinition @'\n${source}\n'@
if ([OwnProbe]::Window(3) -eq '') { throw 'another process window was hidden without an app id' }
[OwnProbe]::OwnPid = 30
if ([OwnProbe]::Window(3) -ne '') { throw 'the app window was still described' }
if ([OwnProbe]::Window(4) -eq '') { throw 'another process window was hidden' }
'own windows passed'
`;
    const directory = mkdtempSync(path.join(tmpdir(), 'cos-own-windows-'));
    try {
      const file = path.join(directory, 'probe.ps1');
      writeFileSync(file, script);
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('own windows passed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
