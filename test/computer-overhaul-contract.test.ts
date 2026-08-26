import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe('desktop helper overhaul contract', () => {
  it('does not reintroduce the fixed focus and per-action sleeps', () => {
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 120');
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 30');
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 20');
    expect(HELPER_SCRIPT).toContain('Stopwatch]::StartNew()');
  });

  it('keeps observation coalesced and window capture background-first', () => {
    expect(HELPER_SCRIPT).toContain("'snapshot'");
    expect(HELPER_SCRIPT).toContain('CaptureWindow');
    expect(HELPER_SCRIPT).toContain("$mode = 'window'");
    expect(HELPER_SCRIPT).not.toContain('$root.FindAll(');
    expect(HELPER_SCRIPT).toContain('TreeWalker]::ControlViewWalker');
    expect(HELPER_SCRIPT).toContain('System.Windows.Automation.CacheRequest');
  });

  it('returns exact partial-batch evidence and snapshot-scopes UI handles', () => {
    expect(HELPER_SCRIPT).toContain('completed_count = $completed');
    expect(HELPER_SCRIPT).toContain('failed_index = $index');
    expect(HELPER_SCRIPT).toContain('$script:UiSnapshots');
    expect(HELPER_SCRIPT).toContain('STALE_UI_SNAPSHOT');
  });
});
