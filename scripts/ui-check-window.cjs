// Resize a UI check's window and wait until it really has that size.
//
// `setSize` asks the window manager; it does not promise anything. A tiling window manager (Hyprland
// through XWayland, issues #2233 and #2234) can ignore the request or apply it late, so a check that
// measured the layout right after the call asserted on a window that never reached its narrow
// breakpoint, and failed on the layout instead of on the window.
//
// The width must arrive exactly. The height may stop short, never run over: macOS clamps a taller window to its work
// area, and the checks that ask for one accept that. A window that settles at another width is
// reported as that, with both sizes, so the failure names the window manager and not the page.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function resizeWindow(win, width, height, { content = false, timeoutMs = 3000, pollMs = 25 } = {}) {
  if (content) win.setContentSize(width, height); else win.setSize(width, height);
  const read = () => { const [w, h] = content ? win.getContentSize() : win.getSize(); return { width: w, height: h }; };
  const deadline = Date.now() + timeoutMs;
  let last = read(), steady = 0;
  for (;;) {
    if (last.width === width && last.height === height) return last;
    // Right width, shorter window that has stopped changing: a work-area clamp, not a late resize.
    if (last.width === width && last.height <= height && steady >= 3) return last;
    if (Date.now() >= deadline) break;
    await pause(pollMs);
    const next = read();
    steady = next.width === last.width && next.height === last.height ? steady + 1 : 0;
    last = next;
  }
  if (last.width === width && last.height <= height) return last;
  throw new Error(`The window did not resize: asked for ${width}x${height}, still ${last.width}x${last.height} after ${timeoutMs} ms (a tiling window manager can ignore the request; float the window and run the check again).`);
}

/**
 * Whether a check shows its test window. On Linux X11 a hidden window reports a new size after `setSize` but keeps laying
 * the page out for the old one (a grid summing to 776 px in a 676 px window, still wrong 1.5 s later), so a layout
 * measured after a resize is stale until the window is shown. Windows already needs a shown window; macOS keeps its
 * test windows hidden so a run does not take the person's focus.
 */
const showsTestWindow = platform => platform === 'win32' || platform === 'linux';

module.exports = { resizeWindow, showsTestWindow };
