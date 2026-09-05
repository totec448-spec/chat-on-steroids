import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

/**
 * Issue #76: a left-handed mouse turned every default click into a right-click.
 *
 * SendInput's flags name *physical* buttons, and Windows applies the `SM_SWAPBUTTON` swap when it
 * turns a physical press into the message an application receives. So on a swapped mouse the app's
 * `left` — which callers mean as "the primary button" — arrived as the secondary click, opening
 * context menus instead of activating things.
 *
 * Measured on Windows 11 before the fix, by injecting into a window the probe owned so no real UI
 * was clicked, with the setting restored afterwards:
 *
 *     swap on, MOUSEEVENTF_LEFTDOWN  sent -> WM_RBUTTONDOWN   (the bug)
 *     swap on, MOUSEEVENTF_RIGHTDOWN sent -> WM_LBUTTONDOWN   (the fix)
 *
 * The mapping lives inside the embedded C#, so it cannot be called from here; what this pins is
 * the source contract. Deliberately asserted as whole down/up pairs rather than as "the file
 * mentions SM_SWAPBUTTON", because the ways this regresses are partial: swapping the down flag and
 * not the up, fixing `left` and forgetting `right`, or dropping the runtime read for a constant.
 */
describe('a swapped-button mouse still gets a primary click (issue #76)', () => {
  const buttonFlags = (() => {
    const start = HELPER_SCRIPT.indexOf('static void ButtonFlags');
    expect(start, 'ButtonFlags should still exist in the helper').toBeGreaterThan(-1);
    return HELPER_SCRIPT.slice(start, HELPER_SCRIPT.indexOf('public static void Click', start));
  })();

  it('decides from the live system setting rather than a build-time constant', () => {
    // The user can flip this checkbox while the app runs, so a cached answer is the same
    // wrong-button bug with a longer fuse.
    expect(buttonFlags).toMatch(/GetSystemMetrics\(SM_SWAPBUTTON\)/);
  });

  it('sends the right-hand flags for a primary click when the buttons are swapped', () => {
    // Both halves of the pair, because a down without its up leaves the button stuck.
    expect(buttonFlags).toMatch(/swapped \? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN/);
    expect(buttonFlags).toMatch(/swapped \? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP/);
  });

  it('sends the left-hand flags for a secondary click when the buttons are swapped', () => {
    expect(buttonFlags).toMatch(/swapped \? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_RIGHTDOWN/);
    expect(buttonFlags).toMatch(/swapped \? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_RIGHTUP/);
  });

  it('leaves the middle button and wheel out of it', () => {
    // Windows swaps only the primary and secondary buttons; conditioning the middle button on the
    // setting would invent a bug the OS does not have.
    const middle = buttonFlags.slice(buttonFlags.indexOf('case "middle"'));
    expect(middle.slice(0, middle.indexOf('break'))).not.toMatch(/swapped/);
  });

  it('declares SM_SWAPBUTTON as the documented index', () => {
    expect(HELPER_SCRIPT).toMatch(/const int SM_SWAPBUTTON = 23;/);
  });

  it('routes every physical click through the one place that knows about the swap', () => {
    // click, double_click and drag all reach the pointer through ButtonFlags, and so does the
    // click_ref fallback when a control has no InvokePattern — it calls Clf::Click. A caller that
    // built its own flags instead would silently stop being covered by this fix.
    //
    // Asserted as "these callers delegate" rather than by counting flag mentions across the file:
    // the first version of this test counted them, and the count moved the moment the fix's own
    // comment mentioned a flag by name. A test that a comment can break is measuring the wrong
    // thing.
    for (const caller of ['public static void Click', 'public static void Drag']) {
      const start = HELPER_SCRIPT.indexOf(caller);
      expect(start, `${caller} should still exist`).toBeGreaterThan(-1);
      const body = HELPER_SCRIPT.slice(start, start + 600);
      expect(body, `${caller} should ask ButtonFlags rather than choosing flags itself`)
        .toMatch(/ButtonFlags\(button, out down, out up\)/);
    }
    // And the click_ref fallback goes through Click, so it inherits the same decision.
    expect(HELPER_SCRIPT).toMatch(/\[Clf\]::Click\(/);
  });
});
