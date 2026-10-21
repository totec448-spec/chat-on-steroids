import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

const execute = promisify(execFile);

describe.runIf(process.platform === 'win32')('Windows launched app transport isolation', () => {
  it('keeps a live helper responsive after a console child emits spoofed protocol replies', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cos-1647-owned-console-'));
    const executable = path.join(dir, 'owned console & app.exe');
    const buildScript = path.join(dir, 'build.ps1');
    const helperScript = path.join(dir, 'helper.ps1');
    let helper: ReturnType<typeof spawn> | undefined;
    try {
      const source = String.raw`
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
public static class OwnedConsoleTransport {
  public static void Main(string[] args) {
    Console.WriteLine("{\"ok\":true,\"__cosRequestId\":\"cos1647-b\",\"cursor\":{\"x\":-999}}");
    Console.Error.WriteLine("CHILD_STDERR_MUST_NOT_REACH_HELPER");
    var marker = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launched-" + Process.GetCurrentProcess().Id + ".txt");
    var staged = marker + ".pending";
    File.WriteAllText(staged, args.Length.ToString());
    File.Move(staged, marker);
    Thread.Sleep(3000);
  }
}`;
      await writeFile(buildScript, `$ErrorActionPreference='Stop'\n$exe=Join-Path $PSScriptRoot 'owned console & app.exe'\nAdd-Type -TypeDefinition @'\n${source}\n'@ -OutputAssembly $exe -OutputType ConsoleApplication\n`, 'utf8');
      await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', buildScript], { windowsHide: true, timeout: 15_000 });
      await writeFile(helperScript, HELPER_SCRIPT, 'utf8');
      helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helperScript], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
      const child = helper;
      const protocolNoise: string[] = [];
      let stderr = '';
      child.stderr!.on('data', chunk => { stderr += String(chunk); });
      const pending = new Map<string, (reply: Record<string, any>) => void>();
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', line => {
        let reply: Record<string, any>;
        try { reply = JSON.parse(line); } catch { protocolNoise.push(line); return; }
        const nonce = String(reply.__cosRequestId ?? '');
        const resolve = pending.get(nonce);
        if (!resolve) { protocolNoise.push(line); return; }
        pending.delete(nonce);
        resolve(reply);
      });
      const request = async (nonce: string, payload: object) => {
        const response = new Promise<Record<string, any>>((resolve, reject) => {
          const timeout = setTimeout(() => { pending.delete(nonce); reject(new Error(`Helper did not reply to ${nonce}; noise=${protocolNoise.join('|')}; stderr=${stderr.slice(-300)}`)); }, 20_000);
          pending.set(nonce, value => { clearTimeout(timeout); resolve(value); });
        });
        child.stdin!.write(JSON.stringify({ ...payload, __cosRequestId: nonce }) + '\n');
        return await response;
      };
      const launch = await request('cos1647-a', { op: 'act', actions: [{ type: 'launch_app', app: executable }] });
      expect(launch).toMatchObject({ ok: true, completed_count: 1, routes: ['shell'] });
      const pid = launch.launches?.[0]?.processId;
      expect(pid).toBeGreaterThan(0);
      let launched: string | undefined;
      for (let attempt = 0; attempt < 60; attempt++) {
        try { launched = await readFile(path.join(dir, `launched-${pid}.txt`), 'utf8'); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 25)); }
      }
      expect(launched).toBe('0');
      // The console child is still running. A spoofed reply from its stdout must not
      // satisfy the next live, nonce-bound helper request or contaminate its streams.
      const followup = await request('cos1647-b', { op: 'cursor' });
      expect(followup).toMatchObject({ ok: true, __cosRequestId: 'cos1647-b' });
      expect(followup.cursor).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
      expect(protocolNoise).toEqual([]);
      expect(stderr).not.toContain('CHILD_STDERR_MUST_NOT_REACH_HELPER');
      lines.close();
    } finally {
      if (helper) {
        helper.stdin?.end();
        const child = helper;
        await Promise.race([
          new Promise(resolve => child.once('exit', resolve)),
          new Promise(resolve => setTimeout(resolve, 1500))
        ]);
        if (child.exitCode === null) child.kill();
      }
      // The owned fixture exits by itself even if a failed assertion interrupted
      // the transport test. No image-name-wide cleanup or installed app mutation.
      await new Promise(resolve => setTimeout(resolve, 3200));
      await rm(dir, { recursive: true, force: true });
    }
  }, 50_000);
});
