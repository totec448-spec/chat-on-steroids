/**
 * Runs the freshly built macOS desktop helper on a real Mac and reports what it says.
 *
 * Until now "the macOS helper is fine" meant it compiled. Compiling proves the Swift parses; it
 * proves nothing about whether the binary starts, answers, or reaches its capture path — and the
 * pointer bug that started all of this was a runtime property, invisible to the compiler.
 *
 * A CI runner has no Screen Recording grant, so a capture here is expected to be refused. That
 * refusal is the useful part: a clean, named TCC refusal is a working code path, while a crash,
 * a hang, or a malformed reply is not. Anything that reaches the pointer compositor also prints
 * its verdict, which is the value a human QA pass would otherwise have to hunt for.
 *
 * Exits non-zero only for a helper that misbehaves: fails to start, stops answering, or returns
 * something that is not JSON. A permission refusal is information, not a failure — this probe
 * must never turn a green macOS build red for lacking a grant no CI runner has.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readPNG, differenceRegion, differenceAround } from './lib/read-png.mjs';

if (process.platform !== 'darwin') {
  throw new Error(`probe-macos-helper.mjs must run on macOS, got ${process.platform}`);
}

const arch = process.argv[2] === 'x64' ? 'x64' : 'arm64';
const helper = path.resolve('resources', 'packaging', 'desktop', 'darwin', arch, 'macos-desktop-helper');
if (!existsSync(helper)) {
  throw new Error(`No built helper at ${helper}. Run prepare-macos-desktop-helper.mjs first.`);
}

// Only run a binary this machine can actually execute; a cross-built slice would fail in a way
// that says nothing about the code.
const native = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim() === 'arm64' ? 'arm64' : 'x64';
if (native !== arch) {
  console.log(`skipped: this runner is ${native}, the helper is ${arch}`);
  process.exit(0);
}

const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });

const pending = [];
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const settle = pending.shift();
    if (settle) settle(line);
  }
});

let died = null;
child.once('exit', (code, signal) => { died = { code, signal }; });

/** One request, with a deadline: a helper that stops answering must not hang the build. */
function ask(request, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    if (died) return reject(new Error(`helper already exited (${JSON.stringify(died)})`));
    const timer = setTimeout(() => reject(new Error(`no answer to ${request.op} within ${timeoutMs}ms`)), timeoutMs);
    pending.push((line) => { clearTimeout(timer); resolve(line); });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

const results = [];
let failed = false;

async function probe(label, request) {
  let line;
  try {
    line = await ask(request);
  } catch (error) {
    console.log(`FAIL  ${label} — ${error.message}`);
    failed = true;
    return null;
  }
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    console.log(`FAIL  ${label} — reply was not JSON: ${line.slice(0, 200)}`);
    failed = true;
    return null;
  }
  const verdict = reply.ok === true ? 'ok' : `refused ${reply.error_code ?? '(no code)'}`;
  console.log(`ok    ${label} — ${verdict}`);
  results.push({ label, reply });
  return reply;
}

// Answering at all is the first thing worth knowing, and warm also states both TCC verdicts —
// which is what makes a later refusal interpretable rather than merely assumed.
const warm = await probe('the helper starts and answers', { op: 'warm' });
const screenGranted = warm?.['screenPermission'] === true;
if (warm?.ok === true) {
  console.log(`      screenPermission=${warm['screenPermission']} accessibilityPermission=${warm['accessibilityPermission']}`);
}

// The pointer, read through the main-queue hop because NSCursor is AppKit. This is the exact
// call the window compositor depends on, and the one whose nil case is the open question.
const cursor = await probe('it can be asked for the cursor', { op: 'cursor' });
if (cursor?.ok === true) {
  console.log(`      cursor=${JSON.stringify(cursor['cursor'])} foreground=${cursor['foreground']}`);
  // The compositor cannot place a pointer it was never given a position for.
  if (cursor['cursor'] === undefined || cursor['cursor'] === null) {
    console.log('FAIL  the cursor op answered without a cursor');
    failed = true;
  }
}

await probe('it can enumerate windows', { op: 'windows' });

// Expected to be refused on a runner with no Screen Recording grant. A named refusal is a
// working path; a crash or silence is not.
const shot = await probe('a capture either works or is refused by name', {
  op: 'capture',
  full: true,
  maxWidth: 640,
  file: path.join(process.env['TMPDIR'] ?? '/tmp', 'cos-probe-capture.png')
});
if (shot?.ok === true) {
  console.log(`      pointer=${shot['pointer'] ?? '(not reported)'} captureMode=${shot['captureMode'] ?? '?'}`);
  if (shot['pointer'] === undefined) {
    console.log('FAIL  a successful capture reported no pointer verdict');
    failed = true;
  }
} else if (shot) {
  console.log(`      refused: ${shot['error_code'] ?? '?'} — ${shot['message'] ?? ''}`);
  // Tolerant only where tolerance is earned. Without the grant a refusal is the correct
  // behaviour; with the grant, a refusal is a real failure and must not pass quietly.
  if (screenGranted) {
    console.log('FAIL  Screen Recording is granted here, so a refused capture is a defect');
    failed = true;
  }
}

/*
 * The window path, which is the one that was broken.
 *
 * A full-screen capture goes through SCContentFilter(display:) and gets the pointer from
 * ScreenCaptureKit — that is the "system" verdict above, and it exercises none of the code that
 * was wrong. Window capture uses SCContentFilter(desktopIndependentWindow:), where showsCursor
 * has no effect and the pointer is composited by hand at its hotspot. That is the code the first
 * fix got wrong, and until now nothing had ever run it.
 *
 * So: find a window, put the pointer inside it, capture it, and see what the compositor says.
 * The pointer is moved deliberately — parked at 10,10 it would sit outside any window and the
 * honest answer would be outside_region, which proves the geometry check and nothing else.
 */
/*
 * A runner has no window open, and without one the window filter cannot be exercised at all —
 * the first run of this probe reported exactly that and printed UNCOVERED. So open one. TextEdit
 * with a real document is the most reliable choice: it appears, it has a title, and it needs no
 * interaction to stay up.
 */
let openedWindow = false;
try {
  const scratch = path.join(process.env['TMPDIR'] ?? '/tmp', 'cos-probe-window.txt');
  execFileSync('/bin/sh', ['-c', `printf 'Chat On Steroids pointer probe
' > ${JSON.stringify(scratch)}`]);
  execFileSync('/usr/bin/open', ['-a', 'TextEdit', scratch]);
  openedWindow = true;
  // Launching is asynchronous and the window has to be mapped before it can be captured.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  console.log('      opened a TextEdit window to capture');
} catch (error) {
  console.log(`      could not open a window (${error.message}) — the window path may stay uncovered`);
}

const listed = await probe('it lists windows to capture', { op: 'windows' });
// The op reports state as foreground/open/minimized — there is no onScreen field. A minimized
// window has no pixels to capture, so anything else will do.
const windows = listed?.['windows'] ?? [];
const usable = (w) =>
  w && w['state'] !== 'minimized' && Number(w['width']) >= 120 && Number(w['height']) >= 120;
// The window this script opened, before anything else. Taking the first usable window off the
// list meant that on a desktop somebody was actually using, this measured a stranger: one run
// landed on a Chrome new-tab page, whose contents animate, and 19,097 pixels differed between two
// captures of a window nobody had touched. The probe opens a window precisely so it has something
// still to look at; it should then look at that one.
const candidate =
  windows.find((w) => usable(w) && /cos-probe-window/.test(String(w['title'] ?? ''))) ??
  windows.find(usable);
console.log(`      ${windows.length} windows listed, ${windows.filter((w) => w?.['state'] !== 'minimized').length} not minimized`);

if (!candidate) {
  console.log('      no on-screen window here, so the hand-composited pointer path is UNCOVERED');
  if (openedWindow) {
    // A window was opened and still none is listed. That is the window enumeration failing,
    // which is a defect rather than an empty desktop.
    console.log('FAIL  a window was opened but the helper listed none');
    failed = true;
  }
} else {
  const cx = Math.round(Number(candidate['x']) + Number(candidate['width']) / 2);
  const cy = Math.round(Number(candidate['y']) + Number(candidate['height']) / 2);
  console.log(`      window ${candidate['id']} "${String(candidate['title'] ?? '').slice(0, 40)}" at ${candidate['x']},${candidate['y']} ${candidate['width']}x${candidate['height']}`);

  /*
   * Foreground resolution, which is the subsystem the last release was held for.
   *
   * QA reported `No foreground window` while Chrome was plainly active, because Chrome's
   * link-preview bubble was WindowServer's topmost window while AX focus — and the typing —
   * belonged to the real window. That report was written against a build 93 minutes older than
   * its own fix, so the fix has never been exercised anywhere. This cannot reproduce the bubble,
   * but it can prove the ordinary case resolves at all rather than answering nothing, which is
   * the failure that was actually observed.
   */
  const front = await probe('it names a foreground window', { op: 'cursor' });
  if (front?.ok === true) {
    const id = Number(front['foreground']);
    // Only judge when something actually claims to be foreground. A runner has no ordinary
    // user session, so NSWorkspace may report no frontmost application at all — and then
    // answering nothing is correct, not the defect QA saw. Asserting otherwise here failed a
    // build for the code being right, which is the same mistake in the opposite direction as
    // calling a moved pointer a compositor fault.
    const claimed = windows.find((w) => w?.['state'] === 'foreground');
    console.log(`      foreground=${id}, opened window ${candidate['id']}, window list claims ${claimed?.['id'] ?? 'none'}`);
    if (!claimed) {
      /*
       * Nothing claims foreground. On a CI runner that is honest — there is no user session. On
       * a real desktop it is the defect itself, and skipping here is how the check that exists
       * to find it stopped running: QA saw "nothing to judge" in four runs out of four while a
       * window was plainly in front.
       *
       * A second helper, started after that window opened, tells the two apart. NSWorkspace
       * serves the frontmost application from a cache refreshed on a run loop, and a helper
       * without one is fixed at first access — so a fresh process sees an application the old
       * one never will. If the newcomer names a foreground window and this one does not, the
       * desktop has one and this helper has gone blind.
       */
      const second = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      let secondSaw = null;
      try {
        let buffered = '';
        const answer = new Promise((resolve) => {
          second.stdout.on('data', (chunk) => {
            buffered += chunk;
            const newline = buffered.indexOf('\n');
            if (newline >= 0) resolve(buffered.slice(0, newline));
          });
          setTimeout(() => resolve(''), 15_000);
        });
        second.stdin.write(`${JSON.stringify({ op: 'cursor' })}\n`);
        const line = await answer;
        secondSaw = line ? (JSON.parse(line)['foreground'] ?? 0) : null;
      } catch {
        secondSaw = null;
      }
      second.kill();

      if (secondSaw === null) {
        console.log('      no window claims foreground, and a second helper could not be asked');
      } else if (Number(secondSaw) > 0) {
        console.log(`FAIL  a freshly started helper names foreground window ${secondSaw}; this one sees none`);
        console.log('      the running-application cache is stale — see frontmostPID');
        failed = true;
      } else {
        console.log('      neither this helper nor a fresh one sees a foreground window, so there is nothing to judge');
      }
    } else if (id === 0) {
      console.log(`FAIL  window ${claimed['id']} claims foreground, but no foreground window was named`);
      failed = true;
    } else if (id !== Number(claimed['id'])) {
      console.log(`FAIL  foreground resolved to ${id}, but ${claimed['id']} is the one claiming it`);
      failed = true;
    } else {
      console.log('      foreground resolution agrees with the window list');
    }
  }

  const moved = await probe('it can put the pointer inside that window',
    { op: 'act', actions: [{ type: 'move', x: cx, y: cy }] });
  if (moved?.ok !== true) {
    console.log(`      pointer could not be moved (${moved?.['error_code'] ?? '?'}) — act requires Accessibility, which a runner rarely grants, so expect outside_region below`);
  }

  /*
   * A warp is not a guarantee. The pointer is shared with whoever is sitting at the machine, so
   * a hand on the trackpad between the warp and the capture makes outside_region the honest
   * answer — the runbook's table calls that "not a defect". This probe used to report it as a
   * compositor failure anyway. On the first real run against a granted Mac it did exactly that,
   * did not reproduce in the eleven runs that followed, and named the one piece of code that was
   * innocent: the compositor the whole exercise exists to judge.
   *
   * So bracket the capture with cursor reads and judge the compositor only when the pointer
   * demonstrably stayed inside the window across it. Otherwise say inconclusive — which a probe
   * is allowed to be, and which a red build is not.
   */
  const insideCandidate = (c) =>
    c != null &&
    Number(c['x']) >= Number(candidate['x']) &&
    Number(c['x']) < Number(candidate['x']) + Number(candidate['width']) &&
    Number(c['y']) >= Number(candidate['y']) &&
    Number(c['y']) < Number(candidate['y']) + Number(candidate['height']);

  /** The cursor, read without recording an answer: these reads bracket a check, they are not one. */
  const readCursor = async () => {
    try {
      const reply = JSON.parse(await ask({ op: 'cursor' }));
      return reply?.ok === true ? reply['cursor'] ?? null : null;
    } catch {
      return null;
    }
  };

  const cursorBefore = await readCursor();
  // Let the window settle before the first capture. A window still painting itself changes
  // between the two shots, and the comparison then reports "redrew" rather than a pointer —
  // true, but it wastes the run's one chance to judge the pixels.
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const windowShot = await probe('it captures that window', {
    op: 'capture',
    id: candidate['id'],
    maxWidth: 640,
    file: path.join(process.env['TMPDIR'] ?? '/tmp', 'cos-probe-window.png')
  });
  const cursorAfter = await readCursor();
  const stayedInside = insideCandidate(cursorBefore) && insideCandidate(cursorAfter);

  if (windowShot?.ok === true) {
    const verdict = windowShot['pointer'];
    const where = `before=${JSON.stringify(cursorBefore)} after=${JSON.stringify(cursorAfter)}`;
    console.log(`      pointer=${verdict} captureMode=${windowShot['captureMode']}`);
    if (windowShot['captureMode'] !== 'window') {
      console.log(`      fell back to ${windowShot['captureMode']}, so the hand-composited path is still UNCOVERED`);
    } else if (verdict === 'drawn') {
      console.log('      the hand-composited pointer ran and drew — this is the path that was broken');
    } else if (verdict === 'outside_region' && moved?.ok !== true) {
      console.log('      outside_region, consistent with the pointer move being refused');
    } else if (verdict === 'outside_region' && !stayedInside) {
      console.log(`      INCONCLUSIVE: the pointer left the window during the capture (${where}), so`);
      console.log('      outside_region is honest and the compositor is unjudged — rerun without touching the mouse');
    } else {
      console.log(`FAIL  window capture returned pointer=${verdict} with the pointer inside the window throughout (${where})`);
      failed = true;
    }

    /*
     * And now the pixels, because "drawn" is the compositor's own word for it.
     *
     * The same window is captured twice — once with the pointer at its centre, once with the
     * pointer parked in the corner of the screen — and the two images are diffed. If the pointer
     * is really composited, the difference is small and sits where the pointer was. That is the
     * one thing a verdict cannot tell you, and it is exactly what was wrong before: the code read
     * correctly, reported success, and put nothing in the picture.
     */
    if (verdict === 'drawn' && windowShot['captureMode'] === 'window') {
      const withPointer = path.join(process.env['TMPDIR'] ?? '/tmp', 'cos-probe-window.png');
      const parked = path.join(process.env['TMPDIR'] ?? '/tmp', 'cos-probe-window-parked.png');
      await probe('it can park the pointer away from the window',
        { op: 'act', actions: [{ type: 'move', x: 4, y: 4 }] });
      const second = await probe('it captures the window again',
        { op: 'capture', id: candidate['id'], maxWidth: 640, file: parked });

      if (second?.ok === true) {
        console.log(`      second capture pointer=${second['pointer']}`);
        try {
          const a = readPNG(withPointer);
          const b = readPNG(parked);
          const scale = a.width / Number(candidate['width']);
          const diff = differenceRegion(a, b);
          const expected = {
            x: Math.round((cx - Number(candidate['x'])) * scale),
            y: Math.round((cy - Number(candidate['y'])) * scale)
          };
          console.log(`      image ${a.width}x${a.height}, ${diff.count} pixels differ, box ${JSON.stringify(diff.box)}`);
          console.log(`      pointer was expected near ${expected.x},${expected.y}`);

          if (!diff.box) {
            console.log('FAIL  the two captures are identical — nothing was drawn into the pixels');
            failed = true;
          } else {
            /*
             * Busy where the pointer was put, quiet everywhere else. Asking instead whether one box
             * around every changed pixel is small enough has now cost this verdict twice — to the
             * title bar's buttons, then to a blinking text caret — because a handful of pixels
             * anywhere else stretches that box across the frame. Densities do not care how many
             * other things moved, only whether this place moved more.
             */
            const around = differenceAround(a, b, expected.x, expected.y, 32);
            console.log(
              `      ${around.near} changed within 32px of the pointer, ${around.far} elsewhere ` +
                `(density ${around.nearDensity.toFixed(4)} vs ${around.farDensity.toFixed(4)})`
            );
            if (around.near < 20) {
              console.log('FAIL  nothing was drawn where the pointer was put');
              failed = true;
            } else if (around.nearDensity < around.farDensity * 4) {
              console.log(
                '      the whole window was repainting between captures, so a change at the ' +
                  'pointer proves nothing — position could not be judged'
              );
            } else {
              console.log('      PIXELS CONFIRM the pointer is drawn, at the position it was moved to');
            }
          }
        } catch (error) {
          console.log(`FAIL  could not compare the two captures: ${error.message}`);
          failed = true;
        }
      }
    }
  }
}

if (openedWindow) {
  try {
    /*
     * Close the one document this script opened — not the application.
     *
     * Quitting TextEdit outright is refused whenever any *other* document has unsaved changes: the
     * modal save sheet answers "User cancelled" (-128) and the quit never happens, leaving this
     * script's own window behind. That is not harmless on a machine somebody uses. A run two rounds
     * ago inherited a stray Finder window from the run before it and lost a drag to the ambiguity;
     * a later run found several `cos-probe-window.txt` windows stacked up from previous probes.
     */
    execFileSync('/usr/bin/osascript', [
      '-e',
      'tell application "TextEdit" to close (every document whose name is "cos-probe-window.txt") saving no'
    ]);
  } catch (error) {
    // Said out loud rather than swallowed: a window left behind is what the next run trips over.
    console.log(`      could not close the window this probe opened (${String(error.message).slice(0, 120)})`);
    console.log('      close cos-probe-window.txt by hand, or the next run may inherit it');
  }
}

child.stdin.end();
await new Promise((resolve) => setTimeout(resolve, 500));
child.kill();

if (stderr.trim()) console.log(`      helper stderr: ${stderr.trim().slice(0, 400)}`);
if (died && died.signal) {
  console.log(`FAIL  the helper died on ${died.signal}`);
  failed = true;
}

console.log(failed ? '\nmacOS helper probe FAILED' : `\nmacOS helper probe passed (${results.length} answers)`);
process.exit(failed ? 1 : 0);
