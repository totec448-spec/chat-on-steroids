import { beforeAll, describe, expect, it } from 'vitest';
import {
  act,
  actAndCapture,
  activeWindow,
  findUi,
  focusWindow,
  getWindowState,
  listWindows,
  screenshot,
  waitForWindow
} from '../src/main/computer/index.js';
import { IS_WINDOWS } from './helpers.js';

describe.runIf(IS_WINDOWS)('desktop helper', () => {
  /**
   * Pay the helper's cold start once, outside any test that is measured.
   *
   * Starting it is a process launch on a hosted Windows runner, behind whatever antivirus that
   * image runs, and it is not the subject of a single test here. It overran the 15 s default on
   * one CI run and failed exactly the first two tests in this block, while the other eighteen —
   * which found the helper already warm — passed. Raising each test's limit would have hidden
   * that; taking the launch out of the measured region means every test below still asserts
   * against the default, about its own subject.
   */
  beforeAll(async () => {
    await listWindows();
  }, 120_000);

  // A hosted runner can have no visible desktop window at all, and getWindowState is right
  // to answer that with WINDOW_NOT_FOUND — that is the production semantic, not a bug to
  // work around here. The tests below are about what a window state *says* once there is a
  // window, so they find one first and skip when the desktop has none, the way the window
  // tests above already do. Naming the window also removes a race the foreground introduces:
  // between probing and asking, whatever happened to be in front may no longer be.
  const visibleWindow = async (): Promise<number | null> => {
    const active = (await activeWindow()).window;
    if (active) return active.id;
    const { windows } = await listWindows();
    return windows.find((w) => w.state !== 'minimized')?.id ?? null;
  };

  it('starts once and serves repeated window queries', async () => {
    const first = await listWindows();
    const second = await listWindows();
    expect(first.screen.width).toBeGreaterThan(0);
    expect(first.screen.height).toBeGreaterThan(0);
    expect(Array.isArray(first.windows)).toBe(true);
    expect(second.screen.width).toBe(first.screen.width);
  });

  it('reports the active window without a screenshot', async () => {
    const result = await activeWindow();
    expect(result.screen.width).toBeGreaterThan(0);
    if (result.window) {
      expect(result.window.id).toBeGreaterThan(0);
      expect(result.window.width).toBeGreaterThan(0);
    }
  });

  it('reports a failed focus instead of claiming success', async () => {
    expect(await focusWindow(999_999_999)).toBe(false);
  });

  // Capturing deliberately no longer demands the foreground: looking at a window that
  // something else is covering is a picture, not a failure. A window that does not exist
  // at all is still an error, and it has to say so as one.
  it('captures a window that will not come forward, but refuses one that does not exist', async () => {
    // A closed window is a named code, not a generic helper failure: the model reads
    // WINDOW_NOT_FOUND and goes back to observe rather than retrying the same id.
    await expect(screenshot({ window: 999_999_999, maxWidth: 320 })).rejects.toThrow(
      /WINDOW_NOT_FOUND: window 999999999 is no longer open/
    );
    const { windows } = await listWindows();
    const background = windows.find((w) => w.state !== 'minimized');
    if (!background) return;
    const shot = await screenshot({ window: background.id, maxWidth: 320 });
    expect(shot.width).toBeGreaterThan(0);
    expect(typeof shot.focused).toBe('boolean');
  });

  it('does not move foreground focus while observing a background window', async () => {
    const before = (await activeWindow()).window;
    if (!before) return;
    const { windows } = await listWindows();
    const background = windows.find((window) => window.id !== before.id && window.state !== 'minimized');
    if (!background) return;

    const shot = await screenshot({ window: background.id, maxWidth: 320 });
    expect(['window', 'screen_fallback']).toContain(shot.captureMode);
    expect((await activeWindow()).window?.id).toBe(before.id);
  });

  it('crops using coordinates from the most recent returned frame', async () => {
    const base = await screenshot({ maxWidth: 320 });
    const width = Math.min(100, base.width);
    const height = Math.min(80, base.height);
    const crop = await screenshot({ crop: { x: 0, y: 0, width, height } });
    expect(crop.width).toBe(width);
    expect(crop.height).toBe(height);
    expect(crop.region.width).toBeGreaterThan(0);
    expect(crop.region.height).toBeGreaterThan(0);
  });

  it('waits for an existing visible window without a fixed sleep', async () => {
    const { windows } = await listWindows();
    const candidate = windows[0];
    if (!candidate) return;
    const found = await waitForWindow({ process: candidate.process, timeoutMs: 1000 });
    expect(found.process.toLowerCase()).toContain(candidate.process.toLowerCase());
  });

  it('queries Windows UI Automation without requiring a screenshot', async () => {
    // A cold, loaded build machine can spend longer walking the UI Automation tree than the
    // product allows find_ui — eight seconds, plus ten while the helper is still starting. The
    // same commit passed on the Windows arm64 runner and timed out on the x64 one within one
    // release build, which is a statement about the machine, not the code. This test is about
    // the shape of the answer, so it retries the timeout and only the timeout; anything else
    // still fails immediately. Raising the product's budget to suit a build machine would make
    // every real user wait longer for a list of controls.
    const query = () => findUi({ role: 'Button', maxResults: 5 });
    const result = await query().catch((error: unknown) => {
      if (!/did not answer in time/i.test(String((error as Error)?.message ?? error))) throw error;
      return query();
    });
    expect(result.window).toBeGreaterThan(0);
    expect(Array.isArray(result.elements)).toBe(true);
    expect(result.elements.length).toBeLessThanOrEqual(5);
    expect(result.snapshotId).toBeGreaterThan(0);
    for (const element of result.elements) expect(element.ref).toMatch(/^g\d+_s\d+_e\d+$/);
  });

  it('returns a Codex-style window state with semantic UI refs', async () => {
    const target = await visibleWindow();
    if (target === null) return;
    const state = await getWindowState({ window: target, includeScreenshot: false, maxElements: 8 });
    expect(state.window.id).toBeGreaterThan(0);
    expect(state.screenshot).toBeNull();
    expect(state.elements.length).toBeLessThanOrEqual(8);
    expect(state.snapshotId).toBeGreaterThan(0);
    for (const element of state.elements) expect(element.ref).toMatch(/^g\d+_s\d+_e\d+$/);
  });

  it('refuses an invented semantic element ref instead of clicking cached coordinates', async () => {
    await expect(act([{ type: 'click_ref', ref: 'g1_e999999_999999' }])).rejects.toThrow(/UNKNOWN_UI_REF/);
  });

  it('keeps a recent immutable frame usable across an unrelated observation', async () => {
    const earlier = await screenshot({ maxWidth: 320 });
    const current = await screenshot({ maxWidth: 320 });
    expect(current.frameId).toBeGreaterThan(earlier.frameId);

    // Another caller taking a picture no longer invalidates this frame. A window-bound
    // frame is revalidated against its HWND and geometry inside the helper before input.
    await expect(act([{ type: 'move', x: 1, y: 1 }], { frameId: earlier.frameId })).resolves.toBeTruthy();
    await expect(act([{ type: 'move', x: 1, y: 1 }], { frameId: current.frameId })).resolves.toBeTruthy();
    await expect(act([{ type: 'move', x: 1, y: 1 }])).rejects.toThrow(/FRAME_REQUIRED/);
  });

  it('refuses a frame after the bounded immutable history evicts it', async () => {
    const old = await screenshot({ maxWidth: 320 });
    for (let index = 0; index < 16; index++) await screenshot({ maxWidth: 320 });
    await expect(act([{ type: 'move', x: 1, y: 1 }], { frameId: old.frameId })).rejects.toThrow(/STALE_FRAME/);
  });

  it('does not check the frame for semantic refs, which do not use coordinates', async () => {
    const stale = await screenshot({ maxWidth: 320 });
    await screenshot({ maxWidth: 320 });
    // Nothing here should mention the frame: the failure must be about the ref itself.
    await expect(
      act([{ type: 'click_ref', ref: 'g1_e999999_999999' }], { frameId: stale.frameId })
    ).rejects.toThrow(/UNKNOWN_UI_REF/);
  });

  it('takes its verification picture before anyone else can touch the desktop', async () => {
    // captureAfter exists to make action and verification one round trip. If the lock is
    // released between them, another agent's capture can land in the gap and the "after"
    // picture proves nothing about the action it was supposed to verify.
    const order: string[] = [];
    const base = await screenshot({ maxWidth: 320 });

    const combined = actAndCapture([{ type: 'move', x: 1, y: 1 }], {
      frameId: base.frameId,
      capture: { maxWidth: 320 }
    }).then((result) => {
      order.push('combined');
      return result;
    });
    const interloper = screenshot({ maxWidth: 320 }).then((shot) => {
      order.push('interloper');
      return shot;
    });

    const [result, other] = await Promise.all([combined, interloper]);
    expect(result.screenshot).not.toBeNull();
    expect(order).toEqual(['combined', 'interloper']);
    // Frames are numbered in capture order: the verification picture is the very next one
    // after the frame the action was aimed at, and the interloper's comes after that.
    expect(result.screenshot!.frameId).toBe(base.frameId + 1);
    expect(other.frameId).toBe(result.screenshot!.frameId + 1);
  });

  it('waits for a compact postcondition inside the same action call', async () => {
    const current = (await activeWindow()).window;
    if (!current) return;
    const result = await actAndCapture([{ type: 'wait', ms: 0 }], {
      verify: { until: 'foreground', window: current.id, timeoutMs: 250 }
    });
    expect(result.completedCount).toBe(1);
    expect(result.verification).toMatchObject({ until: 'foreground', snapshotId: null });
  });

  it('marks all executed actions when postcondition verification times out', async () => {
    await expect(
      actAndCapture([{ type: 'wait', ms: 0 }], {
        verify: { until: 'window_exists', match: 'clf-window-that-cannot-exist-5f2dc5', timeoutMs: 0 }
      })
    ).rejects.toMatchObject({
      completedCount: 1,
      message: expect.stringMatching(/POSTCONDITION_FAILED: completed_count=1.*VERIFY_TIMEOUT/)
    });
  });

  it('resolves a captureAfter crop against the frame that was current before the actions', async () => {
    const base = await screenshot({ maxWidth: 320 });
    const width = Math.min(64, base.width);
    const height = Math.min(48, base.height);
    const result = await actAndCapture([{ type: 'wait', ms: 0 }], {
      frameId: base.frameId,
      capture: { crop: { x: 0, y: 0, width, height } }
    });
    expect(result.screenshot).not.toBeNull();
    expect(result.screenshot!.width).toBe(width);
    expect(result.screenshot!.height).toBe(height);
  });

  it('requires a retained screenshot identity for captureAfter crops', async () => {
    const earlier = await screenshot({ maxWidth: 320 });
    const current = await screenshot({ maxWidth: 320 });
    const crop = { x: 0, y: 0, width: Math.min(32, current.width), height: Math.min(24, current.height) };

    await expect(actAndCapture([{ type: 'wait', ms: 0 }], { capture: { crop } })).rejects.toThrow(/FRAME_REQUIRED/);
    await expect(
      actAndCapture([{ type: 'wait', ms: 0 }], { frameId: earlier.frameId, capture: { crop } })
    ).resolves.toBeTruthy();

    for (let index = 0; index < 16; index++) await screenshot({ maxWidth: 320 });
    await expect(
      actAndCapture([{ type: 'wait', ms: 0 }], { frameId: earlier.frameId, capture: { crop } })
    ).rejects.toThrow(/STALE_FRAME/);
  });

  it('pairs window state element centres with the screenshot it returned', async () => {
    // A competing capture is fired while get_window_state is mid-acquisition. The state
    // it returns must describe one moment: centres computed against its own screenshot,
    // never against the frame the interloper installed.
    const target = await visibleWindow();
    if (target === null) return;
    const statePromise = getWindowState({ window: target, includeScreenshot: true, maxWidth: 640, maxElements: 12 });
    const interloper = screenshot({ maxWidth: 320 });
    const [state, other] = await Promise.all([statePromise, interloper]);

    expect(state.screenshot).not.toBeNull();
    const shot = state.screenshot!;
    // Different capture, therefore a different region and scale to be mapped against.
    expect(shot.frameId).not.toBe(other.frameId);
    // A window with no automation tree has no centres to pair. That is a property of the
    // desktop this happens to run on, not of the mapping under test, so it is a skip rather
    // than a failure; the checked count below still holds the assertion that matters.
    if (state.elements.length === 0) return;

    let checked = 0;
    for (const element of state.elements) {
      if (!element.imageBounds || !element.imageCenter) continue;
      checked++;
      // Recompute the mapping from the screenshot that came back with these elements.
      // Any other frame's region or scale gives different numbers.
      expect(element.imageBounds.x).toBe(Math.round((element.bounds.x - shot.region.x) * shot.scale));
      expect(element.imageBounds.y).toBe(Math.round((element.bounds.y - shot.region.y) * shot.scale));
      expect(element.imageBounds.width).toBe(Math.round(element.bounds.width * shot.scale));
      expect(element.imageCenter.x).toBe(
        Math.round(element.imageBounds.x + element.imageBounds.width / 2)
      );
      expect(element.imageBounds.x + element.imageBounds.width).toBeLessThanOrEqual(shot.width);
      expect(element.imageBounds.y + element.imageBounds.height).toBeLessThanOrEqual(shot.height);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('refuses a ref minted before the desktop helper restarted', async () => {
    // A UI Automation runtime id is meaningless to a different helper process, so acting
    // on one would target whatever now holds that id rather than what the model saw.
    const target = await visibleWindow();
    if (target === null) return;
    const state = await getWindowState({ window: target, includeScreenshot: false, maxElements: 4 });
    const live = state.elements.find((element) => element.ref.startsWith('g'));
    if (!live) return;
    const older = live.ref.replace(/^g(\d+)/, (_match, gen: string) => `g${Number(gen) - 1}`);
    await expect(act([{ type: 'click_ref', ref: older }])).rejects.toThrow(/UNKNOWN_UI_REF|STALE_REF/);
  });
});
