/**
 * Browser control through the DevTools protocol.
 *
 * The Desktop driver already controls a browser: it moves the real pointer and posts real
 * keystrokes at the operating-system level. What it cannot do is *see* a web page. Chromium
 * keeps its renderer accessibility tree switched off until a real assistive client asks for
 * it, so a UIA/AX walk of a browser window returns the toolbar, the tabs and one opaque pane
 * where the page is. Measured against a full traversal of a live Chromium window: sixty-three
 * elements, every one of them browser chrome, not a single node of page content.
 *
 * Inside a web page the Desktop driver is therefore reduced to pixels and guesswork, which is
 * exactly where `click_ref` and `set_value` — the two things that make this product better
 * than coordinate-poking — stop being available. This file closes that gap, and it is
 * browser-level rather than OS-level, so it works the same on every platform and on a window
 * that is not even in the foreground.
 *
 * ## Why the debugger permission
 *
 * Events a content script dispatches carry `isTrusted: false`. Real pages reject them for
 * anything that matters: file pickers, drag and drop, and any framework that guards against
 * synthetic input. A driver built that way works on simple pages and fails silently on the
 * hard ones, which is worse than not having it at all.
 *
 * `chrome.debugger` is the only route to `isTrusted: true` from an extension. It costs a
 * permanent, unmissable "…is debugging this browser" banner on every driven tab. That banner
 * is not a wart to be minimised — it is the honest signal that something other than the
 * person at the keyboard is driving. This module deliberately adds two more: driven tabs are
 * collected into a visibly named tab group, and a pointer overlay shows where the model acts.
 *
 * ## The coordinate invariant
 *
 * One rule, chosen so that a whole class of bugs cannot exist: **one screenshot pixel is one
 * CSS pixel is one input unit.** Screenshots are taken with an explicit clip at `scale: 1`
 * over the CSS visual viewport, so a coordinate read off the returned image is already the
 * coordinate `Input.dispatchMouseEvent` wants. There is no device-pixel-ratio arithmetic
 * anywhere in this file, on any display, at any zoom level.
 */

/** Tab group title. Deliberately the product name: the user must recognise it instantly. */
export const DRIVEN_GROUP_TITLE = 'Chat On Steroids';

/**
 * Pages this driver refuses to attach to, whatever it is asked.
 *
 * ChatGPT itself is first, for a reason worth stating plainly: the model asking for browser
 * control is *in* a ChatGPT tab, and a driver able to attach there could drive its own
 * conversation — send messages as the user, answer its own confirmations, or read another
 * conversation the person has open in a second tab. That is the single most dangerous thing
 * this capability could do, so it is refused at the lowest level rather than anywhere it
 * could later be forgotten.
 *
 * The browser's own surfaces are refused because a debugger session there reaches settings,
 * stored credentials and other extensions. `file:` is refused because a page that can be
 * driven should not also be a filesystem reader.
 */
export const REFUSED_HOSTS = ['chatgpt.com', 'chat.openai.com'];

/** The only two schemes a driven page may use. Everything else is refused by being absent. */
const DRIVABLE_SCHEMES = ['http:', 'https:'];

/**
 * The modifier that means "select all" on this machine.
 *
 * CDP modifier bits are 1 Alt, 2 Ctrl, 4 Meta. This was hardcoded to Meta, which is Cmd on a Mac
 * and the Windows key everywhere else — so off macOS nothing was selected, and set_value then
 * inserted at the caret instead of replacing: a field holding "abc" became "abcxyz". Clearing
 * was worse, because the lone Delete with no selection removed a single character forward.
 */
const SELECT_ALL_MODIFIER = /Mac/i.test(globalThis.navigator?.userAgent ?? '') ? 4 : 2;

/** How long any single protocol command may take before the driver gives up on it. */
const COMMAND_TIMEOUT_MS = 15_000;
/** Navigation gets longer, but never unbounded. */
const NAVIGATE_TIMEOUT_MS = 30_000;
/**
 * Two operations answer only once the renderer has composited, and get longer for it.
 *
 * `Page.captureScreenshot` replies when a frame is produced, and a wheel event is acknowledged
 * after the compositor's input pipeline has taken it. Neither is a fixed cost: a tab that is
 * not compositing — backgrounded, occluded, or simply idle with nothing animating — can take
 * seconds, and both were measured taking longer than ten in a real browser run. Holding them
 * to the ordinary command deadline turns "the page was quiet" into a failure, which is the
 * opposite of what the caller asked about. Clicks and keystrokes are acknowledged directly and
 * keep the ordinary deadline.
 */
const COMPOSITOR_TIMEOUT_MS = 30_000;
/**
 * How long a scroll may wait before the position is read instead.
 *
 * Scrolling is judged by whether the page moved, so waiting the full compositor budget buys
 * nothing: two failed attempts cost a minute of a run in which nothing happened, measured.
 */
const SCROLL_TIMEOUT_MS = 5_000;
/**
 * How long a scroll's move-detection waits for the position to start changing, once a dispatch
 * call has returned — acknowledged or timed out. Separate from SCROLL_TIMEOUT_MS: that budget
 * belongs to the protocol round trip, this one to a page that is merely slow to apply what it
 * already accepted.
 */
const SCROLL_ONSET_TIMEOUT_MS = 1_000;
/** Upper bound on elements one observation returns, so a huge page cannot flood the model. */
const MAX_ELEMENTS = 200;

/**
 * How long a link click is given to move the page before the answer says it did not.
 *
 * Long enough for an ordinary same-origin navigation to commit — the check is on the address
 * changing, not on the load finishing — and short enough that it is not felt on a click that was
 * never going to navigate. Only spent on a click that resolved to a real destination.
 */
const CLICK_NAVIGATION_MS = 1500;
/**
 * How long a drag holds the button down before moving, and hovers before letting go.
 *
 * The same two numbers both desktop drivers use, for the same reason: a press and a release in
 * the same instant is a click, and neither an HTML5 drag nor a hover-armed drop target ever
 * starts. Copied deliberately rather than re-derived, so all three drivers behave alike.
 */
const DRAG_PRESS_HOLD_MS = 90;
const DRAG_DROP_DWELL_MS = 140;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BrowserDriverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserDriverError';
    this.code = code;
  }
}

const fail = (code, message) => new BrowserDriverError(code, message);

export function refusedUrl(url) {
  const value = String(url ?? '').trim();
  // An address that cannot be read is refused, not allowed. Chrome answers `tab.url` with
  // undefined for any tab the extension has no access to, and a refusal that misses there would
  // quietly stop applying to the tabs it must cover. A tab whose address is unknown is a tab
  // that cannot be shown safe to drive, which is the same answer.
  if (!value) return true;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    // Not an address at all. Same reasoning as above.
    return true;
  }
  // Everything but the ordinary web is refused by not being on this list, rather than by being
  // on a list of what to reject. The rejection list was the bug: it matched `chrome:`, `file:`,
  // `javascript:` and the rest by name, so any scheme nobody thought of — and any new one a
  // browser adds — read as an ordinary page.
  if (!DRIVABLE_SCHEMES.includes(parsed.protocol.toLowerCase())) return true;
  // The host, parsed, not the start of the string.
  //
  // This was `/^https:\/\/chatgpt\.com/i`, and a string prefix is the wrong instrument for the
  // most important rule in this file. `http://chatgpt.com/` did not match, and Chrome then
  // redirects it to https with the session still attached; `https://user@chatgpt.com/` did not
  // match either, because the userinfo sits where the host was expected. Meanwhile
  // `https://sub.chatgpt.com/` was allowed and `https://chatgpt.com.example/` was refused —
  // both backwards. Comparing the parsed host answers all four correctly at once.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return REFUSED_HOSTS.some((refused) => host === refused || host.endsWith(`.${refused}`));
}

/**
 * The one tab this driver is attached to, or null.
 *
 * Deliberately one at a time. A driver holding several debugger sessions is a driver whose
 * "stop" is ambiguous and whose banner no longer tells the user which tab is live.
 */
let session = null;

/** Promise wrapper over the callback API, turning `lastError` into a typed failure. */
function rawSend(tabId, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(fail('BROWSER_TIMEOUT', `${method} did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    try {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        const error = chrome.runtime.lastError;
        if (error) return finish(reject, fail('BROWSER_PROTOCOL_FAILED', `${method}: ${error.message}`));
        finish(resolve, result ?? {});
      });
    } catch (error) {
      finish(reject, fail('BROWSER_PROTOCOL_FAILED', `${method}: ${error?.message ?? String(error)}`));
    }
  });
}

function send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
  if (!session) throw fail('BROWSER_NOT_ATTACHED', 'no tab is under browser control');
  return rawSend(session.tabId, method, params, timeoutMs);
}

/**
 * Collects a driven tab into one visibly named group.
 *
 * Purely an affordance for the person watching: the banner says *this tab* is being driven,
 * the group says *these* are the tabs this session has touched. Failure is never fatal —
 * losing the grouping must not cost the ability to stop — so it is attempted and forgotten.
 */
async function groupDrivenTab(tabId) {
  try {
    if (!chrome.tabs?.group || !chrome.tabGroups?.update) return null;
    // A stray group from a session this worker no longer remembers (see sweepStaleDrivenGroups
    // below) must not be left standing beside the one this call is about to create — that is
    // exactly how two "Chat On Steroids" bands end up visible at once.
    await sweepStaleDrivenGroups();
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: DRIVEN_GROUP_TITLE, color: 'blue' });
    return groupId;
  } catch {
    return null;
  }
}

/**
 * Puts a released tab back where it was.
 *
 * The group is the visible answer to "is this tab being driven": a blue band labelled with the
 * app's name, above the tab. It was created on attach and never removed, so every session left
 * one behind — a tab still advertising that something is driving it when nothing is, and one
 * more band in the tab strip for every run. The indicator that exists to be trusted was the one
 * telling the untruth.
 *
 * Best effort by construction. Ungrouping needs a permission that is optional, the tab may have
 * gone, and neither is a reason to fail letting go of it.
 */
async function ungroupDrivenTab(tabId, groupId) {
  if (groupId === null || groupId === undefined) return;
  try {
    if (chrome.tabs?.ungroup) await chrome.tabs.ungroup(tabId);
  } catch {
    // The tab is gone, or grouping was never permitted. Either way there is nothing to undo.
  }
}

/**
 * Ungroups every "Chat On Steroids" band this worker is not currently using.
 *
 * `session` is the only record this module keeps of which group belongs to a live run, and it
 * is plain memory — nothing survives an MV3 service worker being recycled, which Chrome does
 * on its own after roughly thirty seconds of inactivity, restart or update entirely outside
 * this driver's control. A restart mid-session, or between the last action and a person
 * noticing the tab is still there, wipes `session` with no `detach` ever having run: the tab
 * keeps its blue band with nothing left owning it, and it stays that way until something
 * cleans it up, because nothing was going to run `ungroupDrivenTab` for a session this worker
 * no longer remembers existed. This is that cleanup. It runs before every new group is created
 * (so an orphan is never left standing beside a fresh one) and on the extension's own wake
 * timer (so an orphan is still caught even if nothing ever attaches again). Never touches the
 * tabs themselves — same as `detach`, only the grouping goes away, never the page.
 */
export async function sweepStaleDrivenGroups() {
  if (!chrome.tabGroups?.query || !chrome.tabs?.query || !chrome.tabs?.ungroup) return;
  let groups;
  try {
    groups = await chrome.tabGroups.query({ title: DRIVEN_GROUP_TITLE });
  } catch {
    return;
  }
  for (const group of groups) {
    if (session && group.id === session.groupId) continue;
    try {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      const tabIds = tabs.map((tab) => tab.id).filter((id) => typeof id === 'number');
      if (tabIds.length > 0) await chrome.tabs.ungroup(tabIds);
    } catch {
      // The group or its tabs may already be gone by the time this runs. Best effort, same as
      // ungroupDrivenTab: there is nothing left to undo either way.
    }
  }
}

/**
 * Makes the driven tab the one actually compositing, before an action whose correctness
 * depends on it.
 *
 * A scroll gesture and a wheel event are both compositor work, and Chrome defers compositor
 * work for a background tab rather than doing it immediately — a QA round measured this
 * directly, with instrumentation: `visibilityState: hidden` turned a 388 ms, correctly-judged
 * scroll into a 7275 ms timeout with the target's own `scrollLeft` still unmoved, and the
 * instant the tab was activated afterward it jumped straight to *double* the requested
 * distance — the gesture and its own wheel fallback, both delivered together the moment the
 * tab could actually paint. The refusal that produces is honest about the instant it was
 * measured and wrong a moment later, which is worse than either being right or explaining why.
 *
 * The same round measured a second, independent effect of the same cause: a link opened while
 * its tab is backgrounded gets a new tab whose `openerTabId` names whichever tab actually *is*
 * active — Chrome's own tab-creation attribution, not anything this driver controls — so
 * `findCreatedTab`'s comparison against the driven tab's own id can never match. Widening its
 * poll window would not have helped; the condition itself does not hold while backgrounded.
 *
 * `chrome.tabs.update({ active: true })` is tried first and alone, because the follow-up round
 * that confirmed this fix also measured its cost: `chrome.windows.update({ focused: true })`
 * does not just switch a Chrome tab, it switches the *macOS application* — measured directly,
 * TextEdit frontmost to Chrome frontmost, 1191 ms. That takes real keystrokes away from
 * whoever is typing, unlike the debugger banner, tab group and pointer overlay, none of which
 * take anything from the person watching. `visibilityState` turns out to track only whether a
 * tab is its *window's* active one and whether that window is open — not which macOS
 * application is frontmost — so a later measurement found the ordinary "working in another
 * app" case never needs to escalate at all: tab activation alone recovered visibility with
 * TextEdit genuinely frontmost throughout. The one case that reliably does need it is a
 * minimized Chrome window.
 *
 * `broughtToFront` reports whether that escalation was *attempted* without error — not whether
 * `visibilityState` confirmed it within some poll afterward. Those used to be the same return
 * value, and a minimized window's own un-minimize animation measured a reproducible 556–588 ms
 * against a 300 ms poll, so the one case the field exists to name was exactly the case it
 * reported wrong: the window came forward, the scroll worked, and `broughtToFront` still said
 * `false`. The wait after escalating is now purely a courtesy — giving the caller's own action
 * a real chance to see `visible` before proceeding — and is generous enough to usually see it,
 * without being what the field means.
 *
 * Best-effort and bounded throughout: a tab that cannot be activated (closed mid-call, or a
 * withdrawn permission) still gets to attempt the action rather than fail before it starts.
 */
async function ensureTabActive(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { broughtToFront: false };

  const waitVisible = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        const reply = await send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true });
        if (reply?.result?.value === 'visible') return true;
      } catch {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  try {
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
  } catch {
    return { broughtToFront: false };
  }
  if (await waitVisible(300)) return { broughtToFront: false };

  // The lighter fix was not enough — the window itself was not visible, which tab activation
  // alone cannot reach. Pay the real cost only now that it is the thing missing.
  //
  // No windowId means no escalation is possible, not that one was tried and skipped — the
  // earlier form fell through this case into the unconditional `return true` below, reporting
  // a switch that never happened. The one thing broughtToFront exists to get right.
  if (tab.windowId === undefined) return { broughtToFront: false };
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    return { broughtToFront: false };
  }
  // 900 ms, not 300: measured at 556-588 ms for a minimized window's own un-minimize animation
  // on real hardware, so 300 reported this exact case wrong. This wait no longer decides
  // broughtToFront — escalating without error already did — it only gives the action that
  // follows a real chance to find the page visible before it runs.
  await waitVisible(900);
  return { broughtToFront: true };
}

/**
 * A pointer the person can actually see.
 *
 * CDP input moves no real cursor, so without this the page reacts and nothing visibly causes
 * it — the most unnerving way to watch a machine use your browser. The overlay lives in the
 * page, so it also lands in screenshots for free and the model sees the same pointer the user
 * does. It is `pointer-events: none` and must stay that way: an overlay that can swallow a
 * click is an overlay that breaks the thing it illustrates.
 */
const POINTER_SOURCE = `(() => {
  const ID = '__cos_pointer__';
  let node = document.getElementById(ID);
  if (!node) {
    node = document.createElement('div');
    node.id = ID;
    node.setAttribute('aria-hidden', 'true');
    node.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:22px', 'height:22px',
      'pointer-events:none', 'z-index:2147483647', 'margin:0', 'padding:0', 'border:0',
      'transition:transform 90ms linear', 'will-change:transform'
    ].join(';');
    node.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M4 2 L4 16 L8 12.5 L10.5 18 L13 17 L10.5 11.5 L16 11.5 Z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    (document.body || document.documentElement).appendChild(node);
  }
  return node;
})()`;

/**
 * Where the overlay was last put, so it can be put back.
 *
 * The overlay lives in the document and a navigation replaces the document. It was drawn at
 * attach and thereafter only by mouse actions, so navigate-then-look — the exact order the QA
 * script asks for — found nothing, and the pointer the user watches vanished for every page
 * change until something happened to move it.
 */
let pointerAt = { x: 0, y: 0, pressed: false };

async function movePointer(x, y, pressed = false) {
  pointerAt = { x, y, pressed };
  try {
    await send('Runtime.evaluate', {
      expression:
        `${POINTER_SOURCE}.style.transform = ` +
        `'translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${pressed ? 0.82 : 1})';`,
      returnByValue: true
    });
  } catch {
    // A page mid-navigation has no document to draw into. The action still stands; only its
    // illustration is missing, and that is never a reason to fail the action.
  }
}

/** Draws the overlay again wherever it last was, after a new document replaced it. */
async function restorePointer() {
  await movePointer(pointerAt.x, pointerAt.y, pointerAt.pressed);
}

async function removePointer() {
  try {
    await send('Runtime.evaluate', {
      expression: "document.getElementById('__cos_pointer__')?.remove();",
      returnByValue: true
    });
  } catch {
    // Detaching anyway, and the overlay dies with the next navigation regardless.
  }
}

/** The CSS visual viewport, which is the coordinate space every action in this file uses. */
async function viewport() {
  const metrics = await send('Page.getLayoutMetrics');
  const visual = metrics.cssVisualViewport ?? metrics.visualViewport ?? {};
  const layout = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
  const width = Math.max(1, Math.round(visual.clientWidth ?? layout.clientWidth ?? 0));
  const height = Math.max(1, Math.round(visual.clientHeight ?? layout.clientHeight ?? 0));
  // Where the viewport sits in the document. Needed because a capture clip is given in document
  // coordinates, not in viewport ones — see `screenshot`.
  const x = Math.round(visual.pageX ?? layout.pageX ?? 0);
  const y = Math.round(visual.pageY ?? layout.pageY ?? 0);
  // The display's scale factor, from the two viewports the browser already reports: one measured
  // in CSS pixels and one in device pixels. Derived rather than asked for, so it needs no script
  // in the page and is right on a page that refuses to run any.
  const devicePixels = Number(metrics.visualViewport?.clientWidth ?? 0);
  const cssPixels = Number(visual.clientWidth ?? layout.clientWidth ?? 0);
  const ratio = devicePixels > 0 && cssPixels > 0 ? devicePixels / cssPixels : 1;
  return { width, height, x, y, ratio };
}

/**
 * The size a PNG actually is, read from its header.
 *
 * Because the alternative is to report the size that was asked for, which is what this did, and
 * an image that came back at twice the requested size was described as if it had not.
 */
function pngSize(base64) {
  try {
    const head = atob(String(base64).slice(0, 64));
    if (head.slice(12, 16) !== 'IHDR') return null;
    const at = (i) =>
      (head.charCodeAt(i) << 24) | (head.charCodeAt(i + 1) << 16) |
      (head.charCodeAt(i + 2) << 8) | head.charCodeAt(i + 3);
    return { width: at(16), height: at(20) };
  } catch {
    return null;
  }
}

/** CDP's mouse-button vocabulary, from the one this product uses everywhere else. */
export function cdpButton(name) {
  switch (String(name || 'left').toLowerCase()) {
    case 'right': return 'right';
    case 'middle': case 'wheel': return 'middle';
    case 'back': return 'back';
    case 'forward': return 'forward';
    default: return 'left';
  }
}

/** The bitmask CDP wants for "which buttons are currently held" during a drag. */
export function buttonMask(name) {
  switch (cdpButton(name)) {
    case 'right': return 2;
    case 'middle': return 4;
    case 'back': return 8;
    case 'forward': return 16;
    default: return 1;
  }
}

/**
 * Key identity for `Input.dispatchKeyEvent`.
 *
 * A page listens for `key`, `code` and `keyCode`, and different pages listen for different
 * ones, so all three are supplied. The names accepted here are the same names the Desktop
 * driver accepts, including the DOM `Arrow*` spellings — one vocabulary across both drivers
 * is worth more than either driver's private preference.
 */
const KEYS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 }
};

/** Modifier bits CDP expects: Alt 1, Control 2, Meta 4, Shift 8. */
export const MODIFIERS = {
  alt: 1, option: 1,
  control: 2, ctrl: 2,
  meta: 4, cmd: 4, command: 4, super: 4, win: 4,
  shift: 8
};

export function keyDescriptor(name) {
  const lower = String(name || '').toLowerCase();
  if (KEYS[lower]) return KEYS[lower];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
    const number = Number(lower.slice(1));
    return { key: `F${number}`, code: `F${number}`, vk: 111 + number };
  }
  if ([...name].length === 1) {
    const character = name;
    const upper = character.toUpperCase();
    const code = /[a-z]/i.test(character)
      ? `Key${upper}`
      : /[0-9]/.test(character)
        ? `Digit${character}`
        : undefined;
    return { key: character, code, vk: upper.charCodeAt(0), text: character };
  }
  throw fail('BAD_KEY', `unknown key ${name}`);
}

/**
 * Reads the page's interactive elements, in an isolated world.
 *
 * Deliberately not `Accessibility.getFullAXTree`: that returns nodes without geometry, so
 * every one of them would need a second round trip to become clickable, and a page of any
 * size turns into hundreds of protocol calls. One evaluation returns role, accessible name,
 * state and rectangle together — and the rectangle is already in the coordinate space the
 * input methods use.
 *
 * The isolated world matters. Evaluated in the page's own world, a hostile or merely
 * over-clever page could shadow `querySelectorAll` or `getBoundingClientRect` and hand back a
 * description of a page that does not exist, which the model would then act on.
 */
export const COLLECT_SOURCE = `(() => {
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=option]', '[role=switch]', '[role=textbox]',
    '[role=combobox]', '[role=searchbox]', '[contenteditable=""]', '[contenteditable=true]'
  ].join(',');
  const seen = [];
  /**
   * A path that finds this element again later.
   *
   * Coordinates go stale the moment the page scrolls or reflows, and a click on a stale
   * coordinate does not fail — it hits whatever moved into that spot, which is the worst
   * possible outcome. Re-resolving from the document at action time turns that into an honest
   * refusal instead. An id is used when the page provides one; otherwise a child-index chain,
   * which is stable enough for the moments between an observation and the action on it.
   */
  const pathOf = (el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '#' + CSS.escape(el.id);
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 24) {
      const parent = node.parentElement;
      if (!parent) break;
      const index = Array.prototype.indexOf.call(parent.children, node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + index + ')');
      node = parent;
    }
    return parts.length > 0 ? 'html > body ' + parts.slice(1).map((p) => '> ' + p).join(' ') : '';
  };
  const name = (el) => {
    const label = el.getAttribute('aria-label');
    if (label) return label.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ').trim();
      if (parts) return parts;
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const own = el.labels && el.labels[0] ? el.labels[0].textContent : '';
      const text = (own || el.placeholder || el.getAttribute('title') || el.name || '').trim();
      if (text) return text;
    }
    if (el.tagName === 'IMG') return (el.alt || '').trim();
    const alt = el.querySelector('img[alt]')?.alt;
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return (text || alt || el.getAttribute('title') || '').trim();
  };
  const role = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'range') return type;
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'textbox';
    }
    return 'generic';
  };
  /**
   * Elements the page itself styles on :hover, which SELECTOR cannot describe.
   *
   * move_ref exists for menus and captions that appear under the pointer, and on the page that
   * is the canonical example of exactly that — three avatars whose captions are revealed by
   * ".figure:hover .figcaption" — it had nothing to aim at. The wrapper is a plain div with no
   * role and no href, the caption inside it is display:none until hovered and so is skipped as
   * unreachable, and the only ref on the whole page was an unrelated footer link. The feature
   * was unusable on its own headline case.
   *
   * Read from the page's own stylesheets rather than by guessing at tag names. Adding, say,
   * every img would flood the ref list on an image-heavy page and push real controls past
   * MAX_ELEMENTS, which breaks pages that work today to fix one that does not. A :hover rule is
   * the page declaring the element reacts to a pointer, so this only ever exposes what some
   * author deliberately made hoverable, and pages with no such rule gain nothing.
   *
   * Cross-origin sheets throw on .cssRules and are skipped; that is a real gap, not a silent
   * one — such a page simply keeps the refs it has today. Both the rule walk and the number of
   * targets are bounded, because a stylesheet is page-controlled input.
   */
  const HOVER_TARGET_LIMIT = 100;
  const hoverTargets = () => {
    const found = new Set();
    let sheets = [];
    try { sheets = Array.from(document.styleSheets); } catch (e) { return found; }
    let budget = 8000;
    const walk = (rules) => {
      for (const rule of rules) {
        if (budget-- <= 0 || found.size >= HOVER_TARGET_LIMIT) return;
        const sel = rule.selectorText;
        if (sel && sel.indexOf(':hover') !== -1) {
          for (const one of sel.split(',')) {
            const idx = one.indexOf(':hover');
            if (idx === -1) continue;
            // The element the rule hangs off, not what it reveals: ".figure:hover .figcaption"
            // is a statement about .figure. What it reveals is display:none until then, so it
            // cannot be the thing a pointer is sent to.
            const base = one.slice(0, idx).trim();
            if (!base || base === '*') continue;
            try {
              for (const el of document.querySelectorAll(base)) {
                found.add(el);
                if (found.size >= HOVER_TARGET_LIMIT) return;
              }
            } catch (e) { /* a selector this browser will not parse is not a target */ }
          }
        }
        // After selectorText, never instead of it: a nested style rule carries both.
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    for (const sheet of sheets) {
      let rules = null;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (rules) walk(rules);
    }
    return found;
  };
  const inDocumentOrder = (a, b) => {
    const rel = a.compareDocumentPosition(b);
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  };
  const hovers = hoverTargets();
  const interactive = Array.from(document.querySelectorAll(SELECTOR));
  const already = new Set(interactive);
  const extra = [];
  for (const el of hovers) if (!already.has(el)) extra.push(el);
  extra.sort(inDocumentOrder);
  // Interactive elements first, and never displaced.
  //
  // A hover target is an addition to the surface; it must not cost a button. Rules like
  // "tr:hover" and "li:hover" are ordinary on tables and menus, so a dashboard can easily
  // declare a hundred of them, and a single list merged in document order would spend the
  // MAX_ELEMENTS budget on rows and truncate away the controls further down the page — breaking
  // pages that work today in order to fix one that did not. Filling in two passes means the cut
  // always falls on hover targets first, and the output is put back into document order
  // afterwards so the caller still reads the page from the top.
  const candidates = interactive.concat(extra);
  for (const el of candidates) {
    if (seen.length >= ${MAX_ELEMENTS}) break;
    const rect = el.getBoundingClientRect();
    // Off-screen and zero-area elements are not things a pointer can reach, and reporting
    // them invites a click at a coordinate that addresses something else entirely.
    if (rect.width < 1 || rect.height < 1) continue;
    if (rect.bottom <= 0 || rect.right <= 0) continue;
    if (rect.top >= innerHeight || rect.left >= innerWidth) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    // A hover wrapper's whole point is that its text is hidden until hovered, so name(), which
    // reads innerText, finds nothing on exactly the elements this exists for. textContent sees
    // through display:none and gives "name: user1 View profile" — the caption the hover is about,
    // which is the most useful thing this ref could be called. Only as a fallback, and only for
    // these: for anything else an empty name is the honest answer.
    let label = name(el).slice(0, 160);
    if (!label && hovers.has(el)) {
      label = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
    }
    seen.push({
      el,
      path: pathOf(el),
      role: role(el),
      name: label,
      value: 'value' in el && typeof el.value === 'string' ? String(el.value).slice(0, 160) : '',
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      // Only for controls that have a checked state at all.
      //
      // The checked property is a boolean on every input element, so a text field, a search box
      // and a submit button all reported false -- and the renderer, reading it as "is there
      // something to say", printed checked=false beside every one of them. On a login or settings
      // page that is noise on nearly every line, and it drowns the one signal it exists for: a
      // checkbox that is already ticked. aria-checked comes first because a div with a role is a
      // checkbox too, and it carries "mixed", which a boolean cannot.
      //
      // No backticks in this comment: everything here is stringified into the page, and a
      // backtick ends the template literal that carries it.
      checked:
        el.getAttribute('aria-checked') ??
        (/^(checkbox|radio)$/i.test(el.getAttribute('type') ?? '') ? String(el.checked) : ''),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
  }
  // Back into document order for the caller, after the two-pass fill above chose *which*
  // elements survive the budget. The element is carried only for this sort and dropped here.
  seen.sort((a, b) => inDocumentOrder(a.el, b.el));
  return JSON.stringify({
    url: location.href,
    title: document.title,
    scrollY: Math.round(scrollY),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    elements: seen.map((row) => { const copy = Object.assign({}, row); delete copy.el; return copy; })
  });
})()`;

/** Frames one observation will look into, and how deep. A frame bomb is a real page shape. */
const MAX_FRAMES = 12;
const MAX_FRAME_DEPTH = 4;

async function isolatedContext(frameId) {
  const { executionContextId } = await send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'chat-on-steroids',
    grantUniveralAccess: false
  });
  return executionContextId;
}

async function mainFrameId() {
  const { frameTree } = await send('Page.getFrameTree');
  const frameId = frameTree?.frame?.id;
  if (!frameId) throw fail('BROWSER_PROTOCOL_FAILED', 'the page reported no main frame');
  return frameId;
}

/** Evaluates the collector inside one frame, in a world the page cannot see or shadow. */
async function readFrame(frameId) {
  const contextId = await isolatedContext(frameId);
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression: COLLECT_SOURCE,
    contextId,
    returnByValue: true,
    awaitPromise: false
  });
  if (exceptionDetails) return null;
  try {
    return JSON.parse(String(result?.value ?? '{}'));
  } catch {
    return null;
  }
}

/**
 * Where a child frame sits in the page above it.
 *
 * An element's rectangle is relative to its own frame, so without this every coordinate
 * inside an iframe would be wrong by the iframe's position — and wrong coordinates do not
 * fail, they click somewhere else.
 */
async function frameOffset(frameId) {
  try {
    const { backendNodeId } = await send('DOM.getFrameOwner', { frameId });
    if (!backendNodeId) return null;
    const { model } = await send('DOM.getBoxModel', { backendNodeId });
    const quad = model?.content;
    if (!Array.isArray(quad) || quad.length < 2) return null;
    return { x: quad[0], y: quad[1] };
  } catch {
    // A frame that closed between the tree walk and this call. Its elements are dropped
    // rather than reported at an offset nobody can vouch for.
    return null;
  }
}

/**
 * Every element on the page, including the ones inside iframes.
 *
 * Consent dialogs, payment forms, embedded editors and most login widgets are iframes. Reading
 * only the main frame reported those pages as having nothing to interact with, which the model
 * cannot tell apart from a page that genuinely has nothing.
 *
 * Each element keeps the frame it came from, because a ref has to be re-resolved in the frame
 * that owns it, and carries coordinates already translated into the top-level page's space so
 * that clicking one needs no further arithmetic.
 */
async function collectElements(generation) {
  const root = await mainFrameId();
  const { frameTree } = await send('Page.getFrameTree');

  const frames = [];
  const walk = (node, depth, offset) => {
    if (!node?.frame?.id || frames.length >= MAX_FRAMES) return;
    frames.push({ id: node.frame.id, depth, offset });
    if (depth >= MAX_FRAME_DEPTH) return;
    for (const child of node.childFrames ?? []) walk(child, depth + 1, null);
  };
  walk(frameTree, 0, { x: 0, y: 0 });

  const page = (await readFrame(root)) ?? { elements: [] };
  const elements = [];
  let index = 0;
  const take = (list, frameId, offset) => {
    for (const element of list ?? []) {
      if (elements.length >= MAX_ELEMENTS) return;
      elements.push({
        ...element,
        // Stamped with the observation that minted it, not just a recycled per-call index. Every
        // observe() starts index back at 0, so a bare "e4" from one observation and "e4" from the
        // next name two unrelated elements — and a caller holding the first one after the second
        // has run gets a silent, successful click on whatever the label now happens to match. QA
        // caught exactly that: a stale first-observation ref was reused by a later observation and
        // activated a different control instead of failing. The generation makes that collision
        // impossible instead of merely unlikely.
        ref: 'g' + generation + '_e' + index++,
        frameId,
        x: Math.round(element.x + offset.x),
        y: Math.round(element.y + offset.y)
      });
    }
  };
  take(page.elements, root, { x: 0, y: 0 });

  for (const frame of frames) {
    if (frame.id === root) continue;
    if (elements.length >= MAX_ELEMENTS) break;
    const offset = await frameOffset(frame.id);
    if (!offset) continue;
    const inner = await readFrame(frame.id);
    if (!inner) continue;
    take(inner.elements, frame.id, offset);
  }

  return { ...page, elements };
}

/**
 * A screenshot of what is on screen, in which one pixel is one CSS pixel.
 *
 * The clip carries two facts, and both were learned the hard way.
 *
 * `scale: 1` is why the clip exists at all: without it the image comes back in device pixels and
 * every coordinate the model reads off it is wrong by the display's scale factor, on exactly the
 * high-DPI machines people actually use.
 *
 * The origin is why this went wrong for months. A capture clip is given in **document**
 * coordinates, not viewport ones, and this asked for `0,0` — the top of the document. On any
 * scrolled page that is not what is on screen: the requested region has mostly never been
 * rasterised, so it comes back blank, with the sliver that does overlap the viewport stranded far
 * down the image. Two QA runs reported it as "the screenshot after scrolling is wrong"; it was
 * every screenshot of a scrolled page, whoever scrolled it and however long ago.
 *
 * So the clip starts where the viewport starts. It is what Chrome's own tooling does — Puppeteer
 * adds the layout viewport's `pageX`/`pageY` to every clip it sends, for this reason.
 *
 * And the scale is `1 / ratio`, not `1`. A clip's scale multiplies the display's own scale factor
 * rather than replacing it, so `scale: 1` on a Retina display returned an image at twice the size
 * it claimed — and the claim was the requested size, never the picture's, so nothing noticed for
 * as long as this has existed. Every coordinate a model read off one of those images was out by
 * a factor of two on every Mac made in the last decade. The size reported now comes from the
 * PNG's own header.
 */
async function screenshot() {
  const { width, height, x, y, ratio } = await viewport();
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x, y, width, height, scale: 1 / (ratio || 1) }
  }, COMPOSITOR_TIMEOUT_MS);
  const actual = pngSize(data);
  return { data, width: actual?.width ?? width, height: actual?.height ?? height };
}

async function currentTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab) throw fail('BROWSER_TAB_GONE', `tab ${tabId} no longer exists`);
  return tab;
}

/**
 * The permissions browser control needs, which the extension deliberately does not ship with.
 *
 * `debugger` and `<all_urls>` together are the most far-reaching pair an extension can hold —
 * read and write on every page, plus trusted input. Requiring them at install time would mean
 * every existing user is re-prompted on update and left disabled until they accept a
 * capability most of them will never switch on. As optional permissions they are requested
 * once, from a real click in the popup, by the person who actually wants the feature.
 */
/**
 * What is actually requested and revoked at runtime.
 *
 * `debugger` is not here, and cannot be: Chrome refuses it in optional_permissions, dropping the
 * entry at manifest load so a later request answers "Only permissions specified in the manifest
 * may be requested" — measured against Chrome 152. One unavailable entry failed the whole
 * request, which is why the popup switch could never stay on. It is a required permission now.
 *
 * Site and tab access remain optional, and they are what decides whether this extension can
 * read a page at all, so the opt-in still means something.
 */
export const BROWSER_PERMISSIONS = { permissions: ['tabs', 'tabGroups'], origins: ['<all_urls>'] };

/** Held from install, not requestable. Checked, never requested and never removed. */
/**
 * A short digest of this file, so an answer can say which driver produced it.
 *
 * Installing a new build rewrites the extension folder, but Chrome keeps running the copy it
 * already loaded until someone reloads the extension by hand. A test run then measures the old
 * driver while reading the new source, and reports a fix as broken — which has already cost a
 * round. Hashing the running source turns that into something visible: two runs quoting the same
 * stamp were the same code, whatever the release notes say.
 */
let driverStamp = null;
async function stamp() {
  if (driverStamp) return driverStamp;
  try {
    const source = await (await fetch(chrome.runtime.getURL('browser-driver.js'))).arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source)).slice(0, 6);
    driverStamp = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    driverStamp = 'unreadable';
  }
  return driverStamp;
}
const REQUIRED_BROWSER_PERMISSIONS = { permissions: ['debugger'] };

/**
 * One call shape, whichever the browser answers with.
 *
 * `permissions.*` answers a callback in the classic API and returns a promise in the MV3 one,
 * and which you get depends on the browser build rather than on anything visible here. Waiting
 * only for the callback hangs forever against the promise form, and a permission check that
 * hangs is indistinguishable from one that denied. Accepting either costs three lines.
 */
function askPermissions(method) {
  return new Promise((resolve) => {
    const runtime = globalThis.browser ?? globalThis.chrome;
    const api = runtime?.permissions;
    if (!api?.[method]) return resolve(false);
    try {
      const returned = api[method](BROWSER_PERMISSIONS, (granted) => {
        void runtime?.runtime?.lastError;
        resolve(Boolean(granted));
      });
      if (returned && typeof returned.then === 'function') {
        returned.then((granted) => resolve(Boolean(granted)), () => resolve(false));
      }
    } catch {
      resolve(false);
    }
  });
}

/**
 * Whether this browser can do any of this at all.
 *
 * Browser control needs the DevTools protocol. Where an extension cannot reach it — a browser
 * that never implemented it, or a build where policy has taken it away — this is not a missing
 * permission but a missing capability, and saying so plainly is the difference between a
 * feature someone can decide not to use and a switch that silently does nothing.
 *
 * Deliberately not a `chrome.debugger` presence check. That object does not exist until the
 * optional permission is granted, so testing for it would hide the very switch that grants
 * it — the feature would be permanently unreachable on exactly the browsers that support it.
 * Proven in a real Edge run, where the popup reported no debugger API at all.
 */
export function browserControlSupported() {
  return new Promise((resolve) => {
    const runtime = globalThis.browser ?? globalThis.chrome;
    const api = runtime?.permissions;
    if (!api?.contains) return resolve(false);
    // Asking whether the permission is *held* is not the question — it will not be, before it
    // is granted. Asking whether the browser recognises the name is: one that has never heard
    // of it rejects the call outright, while one that simply has not granted it answers false.
    const done = (value) => resolve(value === true || value === false);
    try {
      const returned = api.contains({ permissions: ['debugger'] }, (held) => {
        // A browser that does not know the permission reports it here rather than throwing.
        if (runtime?.runtime?.lastError) return resolve(false);
        done(held);
      });
      if (returned && typeof returned.then === 'function') returned.then(done, () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

export async function hasBrowserPermissions() {
  if (!(await browserControlSupported())) return false;
  // Both halves, because they are granted by different mechanisms: debugger at install, the
  // rest from the popup. Holding only one is not browser control.
  if (!(await containsRequired())) return false;
  return askPermissions('contains');
}

/** Whether the install-time debugger permission is actually present. */
function containsRequired() {
  return new Promise((resolve) => {
    const runtime = globalThis.browser ?? globalThis.chrome;
    const api = runtime?.permissions;
    if (!api?.contains) return resolve(false);
    try {
      const returned = api.contains(REQUIRED_BROWSER_PERMISSIONS, (held) => {
        if (runtime?.runtime?.lastError) return resolve(false);
        resolve(held === true);
      });
      if (returned && typeof returned.then === 'function') {
        returned.then((held) => resolve(held === true), () => resolve(false));
      }
    } catch {
      resolve(false);
    }
  });
}

/** Must be called from a user gesture; the browser refuses the prompt otherwise. */
export function requestBrowserPermissions() {
  return askPermissions('request');
}

/** Where the page is scrolled to, or null when it cannot be read. */
/**
 * Waits until the page has stopped moving and painted what it moved to.
 *
 * A scroll gesture animates. The command returns as soon as it is accepted, so a screenshot taken
 * straight afterwards catches the page mid-flight: a run got an entirely white picture of a page
 * that had plainly scrolled, and on a simpler page the newly exposed strip was blank while the
 * old content still sat at its old height. The scroll had worked; the evidence of it had not.
 *
 * That is the failure this whole layer exists to prevent — an answer that says `ok` beside a
 * picture that shows something else — so scrolling waits for the position to settle and then for
 * two animation frames, which is the browser's own promise that a paint has happened.
 */
async function settleAfterScroll(send, x, y) {
  let last = null;
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const now = await readScrollPosition(send, x, y);
    if (now !== null && last !== null && now.x === last.x && now.y === last.y) break;
    last = now;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  try {
    await send('Runtime.evaluate', {
      expression:
        'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(1))))',
      awaitPromise: true,
      returnByValue: true
    }, SCROLL_TIMEOUT_MS);
  } catch {
    // A page that will not run script still scrolled; the wait above is the part that matters.
  }
}

/**
 * Whether a click just opened a new ordinary tab — `target="_blank"`, `window.open`, a form
 * posting to a new tab.
 *
 * Before this, nothing in a click's answer said so: the driver stayed attached to the tab it
 * was already on, status kept naming that same tab, and a caller had no way to learn a second
 * tab now existed short of separately listing tabs and guessing which one was new. QA reached
 * for exactly that guess and found nothing to guess from.
 *
 * Chrome creates the new tab a beat after the input event that triggered it completes, so this
 * polls briefly rather than checking once and calling it settled.
 */
async function findCreatedTab(openerTabId, before) {
  const deadline = Date.now() + 200;
  for (;;) {
    let tabs = [];
    try {
      // `openerTabId` is a property Chrome reports on a returned Tab, not a filter
      // `tabs.query` accepts — passing it as query criteria throws ACTION_REFUSED
      // ("Unexpected property"). Query everything and filter here instead.
      tabs = await chrome.tabs.query({});
    } catch {
      return null;
    }
    const created = tabs.find(
      (tab) => tab?.openerTabId === openerTabId && Number.isSafeInteger(tab?.id) && !before.has(tab.id)
    );
    if (created) {
      return { tabId: created.id, url: created.url || created.pendingUrl || null, title: created.title || null };
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/**
 * Whether the page has moved from `before` — worth a short wait, not one look.
 *
 * A dispatch call timing out at SCROLL_TIMEOUT_MS says nothing about the scroll itself: QA saw
 * horizontal scrolling reported as `BROWSER_SCROLL_FAILED` — neither the gesture nor the wheel
 * fallback acknowledged in time — while a screenshot taken moments later showed the page had
 * moved anyway. Reading the position exactly once, at the instant a timed-out dispatch call
 * returns, catches the scroll mid-flight and calls it failed. This polls for the onset of
 * movement the same way settleAfterScroll below polls for its end, so a scroll that lands a
 * little after its dispatch call is still seen landing.
 */
async function waitForScrollOnset(send, before, timeoutMs, x, y) {
  const deadline = Date.now() + timeoutMs;
  let last = before;
  for (;;) {
    const now = await readScrollPosition(send, x, y);
    if (now !== null) {
      last = now;
      if (before === null || now.x !== before.x || now.y !== before.y) return now;
    }
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/**
 * The position a scroll at `(x, y)` is actually judged by — the element under that point that
 * can scroll, not always the window.
 *
 * `Input.synthesizeScrollGesture` and a wheel event both scroll whatever the compositor finds
 * under the pointer, the same way a real wheel does: a small nested strip with its own
 * `overflow: auto` takes the gesture and never touches `window.scrollX`/`scrollY` at all. Reading
 * only those two, as this used to, made a real, visible scroll of that strip indistinguishable
 * from nothing happening — QA's fixture moved WIDE 1/2 → 2/3 → 3/4 on screen while every check
 * here kept reporting `BROWSER_SCROLL_FAILED`. `elementFromPoint` finds the same element the
 * gesture would have hit and walks up to the nearest one that can actually scroll in either
 * axis; only when none exists — the ordinary case, an element-less point or the page itself —
 * does this fall back to the window, which is the only thing a plain page scroll ever moves.
 */
function scrollTargetExpression(x, y) {
  return (
    '(() => {' +
    `const px = ${Math.round(x)}, py = ${Math.round(y)};` +
    'let el = document.elementFromPoint(px, py);' +
    'while (el && el !== document.documentElement && el !== document.body) {' +
    'const style = getComputedStyle(el);' +
    'const canX = el.scrollWidth > el.clientWidth && /(auto|scroll)/.test(style.overflowX);' +
    'const canY = el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(style.overflowY);' +
    'if (canX || canY) return { x: Math.round(el.scrollLeft), y: Math.round(el.scrollTop) };' +
    'el = el.parentElement;' +
    '}' +
    'return { x: Math.round(scrollX), y: Math.round(scrollY) };' +
    '})()'
  );
}

async function readScrollPosition(send, x, y) {
  try {
    const reply = await send('Runtime.evaluate', {
      expression: scrollTargetExpression(x, y),
      returnByValue: true
    });
    const value = reply?.result?.value;
    return value && typeof value.x === 'number' ? value : null;
  } catch {
    return null;
  }
}

export const browserDriver = {
  /** What is under control right now, for the popup, the app and the stop button. */
  /**
   * Where the driver is now, not where it started.
   *
   * The address and title were captured when the tab was taken and never updated, so after any
   * navigation — the driver's own, or the person clicking a link — status answered with the page
   * the run began on. status is precisely what a caller uses to confirm where it is, so a stale
   * answer is worse than no answer: it reads as confirmation.
   *
   * A tab that cannot be read leaves the last known values in place, which beats answering
   * nothing about a session that is genuinely still attached.
   */
  async status() {
    if (!session) return { attached: false, tabId: null, url: null, title: null, build: await stamp() };
    try {
      const tab = await chrome.tabs.get(session.tabId);
      session.url = tab?.url || tab?.pendingUrl || session.url;
      session.title = tab?.title || session.title;
    } catch {
      // Keep what we knew.
    }
    // The group rides along because it is the visible claim: a blue band above the tab saying
    // something is driving it. Reporting it makes that claim checkable by whoever is driving,
    // instead of only by a person looking at the tab strip.
    return {
      attached: true,
      tabId: session.tabId,
      url: session.url,
      title: session.title,
      groupId: session.groupId ?? null,
      build: await stamp()
    };
  },

  async attach(tabId) {
    if (session && session.tabId === tabId) return this.status();
    if (session) await this.detach();

    if (!(await browserControlSupported())) {
      throw fail(
        'BROWSER_UNSUPPORTED',
        'this browser exposes no DevTools protocol to extensions, so a web page cannot be driven ' +
          'from it. Desktop control still works and can operate the browser window itself.'
      );
    }
    if (!(await hasBrowserPermissions())) {
      throw fail(
        'BROWSER_PERMISSION_REQUIRED',
        'browser control is off. Open the Chat On Steroids extension popup and turn it on; ' +
          'the browser asks for site and tab access there. If the switch will not stay on, the ' +
          'popup now says why underneath it.'
      );
    }

    const tab = await currentTab(tabId);
    // A tab still loading reports its destination as pendingUrl and its url as empty, which a
    // tab this driver just opened always is. Judging only `url` would refuse the page we were
    // asked for, at the moment we asked for it.
    const address = tab.url || tab.pendingUrl || '';
    if (!address) {
      throw fail(
        'BROWSER_URL_UNKNOWN',
        `the address of tab ${tabId} cannot be read, so it cannot be shown safe to drive. Turn ` +
          'browser control off and on again in the extension popup and accept the tab access it asks for.'
      );
    }
    if (refusedUrl(address)) {
      throw fail('BROWSER_URL_REFUSED', `browser control refuses ${address}`);
    }

    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        const error = chrome.runtime.lastError;
        if (error) return reject(fail('BROWSER_ATTACH_FAILED', error.message));
        resolve();
      });
    });

    session = { tabId, url: tab.url ?? '', title: tab.title ?? '', groupId: null, refGeneration: 0 };
    try {
      await send('Page.enable');
      await send('Runtime.enable');
      await send('DOM.enable');
      session.groupId = await groupDrivenTab(tabId);
      await movePointer(0, 0);
    } catch (error) {
      await this.detach();
      throw error;
    }
    return this.status();
  },

  /** Always safe to call, always leaves the tab as the user's own again. */
  async detach() {
    if (!session) return { attached: false, tabId: null, url: null, title: null, build: await stamp() };
    const { tabId, groupId } = session;
    await removePointer();
    await ungroupDrivenTab(tabId, groupId);
    try {
      await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      }));
    } catch {
      // The tab may already be gone, which is the state we were heading for anyway.
    }
    const released = { tabId, url: session.url, title: session.title };
    session = null;
    // Say what was let go of. "No tab is under control" is the state afterwards and it is true,
    // but as the answer to detach it reads as though there had been nothing to detach — which is
    // the one thing it cannot distinguish. Naming the tab makes the effect legible.
    // The build belongs on both branches. It was on the one that had nothing to let go of and
    // not on the one that did, so every successful detach printed "driver build unreported" —
    // the exact string the QA instructions call a finding. A false alarm in the answer that is
    // supposed to settle which driver ran is worse than no answer at all.
    return { attached: false, tabId: null, url: null, title: null, released, build: await stamp() };
  },

  /**
   * Called when the browser tears the session down underneath us.
   *
   * Also reached when a person presses Cancel on Chrome's debugging banner, and the tab then
   * outlives the session — so the group has to go here too, not only in detach.
   */
  forget(tabId) {
    if (!session || session.tabId !== tabId) return;
    const { groupId } = session;
    session = null;
    void ungroupDrivenTab(tabId, groupId);
  },

  /**
   * Where a ref points *now*, not where it pointed when it was observed.
   *
   * A coordinate from an earlier observation does not fail when the page has scrolled or
   * reflowed — it hits whatever moved into that spot, which is worse than any error. So a ref
   * is re-resolved from the document immediately before it is used, and an element that is
   * gone, hidden or off-screen produces a refusal instead of a click somewhere else.
   */
  async resolveRef(ref) {
    const entry = session?.refs?.get(String(ref));
    if (!entry) {
      throw fail('BROWSER_BAD_REF', `${ref} is not from the most recent observation of this page`);
    }
    const { path, frameId } = entry;
    // Resolved in the frame that owns it. A path from inside an iframe means nothing in the
    // document above it, and could match something entirely different there.
    //
    // A ref whose frame was an iframe survives navigation of the *page* in the map (it is only
    // replaced by the next observe()), but the frame itself can be gone by then — the top
    // document navigated, or the iframe was removed. Asking CDP for that frame's isolated world
    // then fails at the protocol level ("No frame for given id found"), which used to escape as
    // a raw BROWSER_PROTOCOL_FAILED. That is exactly the case this method exists to turn into a
    // clean refusal: the ref is stale, not the protocol.
    let contextId;
    try {
      contextId = await isolatedContext(frameId);
    } catch {
      throw fail('BROWSER_BAD_REF', `${ref} belonged to a frame that no longer exists on this page`);
    }
    const offset = (await frameOffset(frameId)) ?? { x: 0, y: 0 };
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(path)});
        if (!el) return JSON.stringify({ found: false });
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        const usable = r.width >= 1 && r.height >= 1 && r.bottom > 0 && r.right > 0 &&
          r.top < innerHeight && r.left < innerWidth &&
          s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        // What is actually at that point. A ref resolves to fresh coordinates, but coordinates are
        // not the element: a page can lay something over it, and the click then lands on the cover
        // while every part of the call still succeeds.
        const at = document.elementFromPoint(x, y);
        const hit = at
          ? at.tagName.toLowerCase() + (at.id ? '#' + at.id : '')
          : null;
        const covered = Boolean(at) && at !== el && !el.contains(at) && !at.contains(el);
        // The destination this click is expected to reach, when there is one to be sure of.
        //
        // Only a link that opens in this tab, addresses an ordinary page, and points somewhere
        // other than where we already are. Anything else — a fragment, a new tab, a script
        // handler — has no outcome that can be checked by watching the address, and guessing at
        // one would file a "nothing happened" report against a click that worked perfectly.
        // Top document only. The address watched after the click is the page's, and a link inside
        // an iframe moves the frame while the page stays exactly where it was — so checking one
        // against the other would report a working click as having reached nothing, which is
        // worse than saying nothing. The top/self test is a reference comparison and is safe
        // across origins. (No backticks in here: this whole source is a template literal.)
        const anchor = window.top === window.self && el.closest ? el.closest('a[href]') : null;
        let expect = '';
        if (anchor && !anchor.target) {
          const href = anchor.href;
          if (/^https?:/i.test(href) && href.split('#')[0] !== location.href.split('#')[0]) expect = href;
        }
        return JSON.stringify({ found: true, usable, x, y, hit, covered, tag: el.tagName.toLowerCase(), expect });
      })()`,
      contextId,
      returnByValue: true
    });
    if (exceptionDetails) throw fail('BROWSER_BAD_REF', `${ref} could not be resolved on this page`);
    const found = JSON.parse(String(result?.value ?? '{}'));
    if (!found.found) throw fail('BROWSER_BAD_REF', `${ref} is no longer on this page`);
    if (!found.usable) throw fail('BROWSER_BAD_REF', `${ref} is on the page but not visible or reachable`);
    // Back into the top-level page's coordinates, which is the space input events use.
    //
    // `tag`, `path` and `contextId` come back too, for the actions that cannot be expressed as a
    // point. A native <select> is the case that forced it: its dropdown is painted by the browser
    // process, so no synthetic event aimed at any coordinate can pick an option. See set_value.
    return {
      x: Math.round(found.x + offset.x),
      y: Math.round(found.y + offset.y),
      hit: found.hit ?? null,
      covered: Boolean(found.covered),
      tag: String(found.tag ?? ''),
      expect: String(found.expect ?? ''),
      path,
      contextId
    };
  },

  /**
   * Attaches to the tab a person would mean by "the browser", if nothing is attached yet.
   *
   * Making the model ask for this first was bookkeeping it should not have to carry, and one
   * more thing to get wrong. The newest ordinary tab is the one being worked in; ChatGPT's own
   * tabs and browser surfaces are skipped by the same refusal list that governs an explicit
   * attach, so this cannot reach anywhere an explicit attach could not.
   */
  async ensureAttached(openUrl = null) {
    if (session) return;
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      throw fail('BROWSER_PERMISSION_REQUIRED', 'browser control is off; turn it on in the extension popup');
    }
    const usable = tabs.filter((tab) => Number.isSafeInteger(tab?.id));
    const candidate = usable
      .filter((tab) => !refusedUrl(tab.url || tab.pendingUrl))
      .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];
    if (candidate) {
      await this.attach(candidate.id);
      // Judged again, by what the tab holds rather than by what it was asked for.
      //
      // The filter above reads `tab.url`, which for a page that failed to load is still the
      // address that was requested — so a tab showing Chrome's error page looks like an ordinary
      // site and is picked. QA met this straight after a detach: the next observe silently
      // re-attached and returned `chrome-error://chromewebdata/` as the page, with no refusal
      // anywhere. attach() cannot answer this either, for the same reason; only the frame tree
      // can, and only once attached.
      //
      // Not when the caller brought an address, though. `navigate` is about to replace the
      // document, so what the tab holds right now is not what it will be driven on — and
      // refusing here would be a trap rather than a guard: the failed tab stays open, every
      // later `navigate` auto-picks it, is refused, and detaches again, so the one action that
      // would fix the situation is the one action that can never run. That is the dead end the
      // comment below already names, arrived at from the other side.
      if (!openUrl) await this.assertPageStillAllowed();
      return;
    }
    // "No page is open" and "no page whose address I may read" are different problems with
    // different fixes, and only the second one is the user's to solve. Chrome answers `tab.url`
    // with undefined wherever the extension has no access, and those tabs are refused rather
    // than driven — correct, but saying nothing is open when the browser is full of pages sends
    // someone to open one more, which changes nothing.
    if (usable.length > 0 && usable.every((tab) => !(tab.url || tab.pendingUrl))) {
      throw fail(
        'BROWSER_PERMISSION_REQUIRED',
        `${usable.length} tab(s) are open but none of their addresses can be read, so none can be ` +
          'shown safe to drive. Open the Chat On Steroids extension popup, turn browser control ' +
          'off and on again, and accept the site access it asks for.'
      );
    }
    // Nothing to take. If the caller brought an address — navigate is the only action that
    // does — open it, because the alternative is the dead end QA walked into twice: "open the
    // page first" is not an instruction a model can follow when no action opens a page. The
    // address has already passed the refusal list in `act`, so this cannot open anywhere an
    // explicit attach could not reach.
    if (!openUrl) {
      throw fail(
        'BROWSER_NO_TAB',
        'no ordinary web page is open to drive, and no address was given to open one. ' +
          'Use navigate, which opens a page when none is open; ChatGPT tabs are never driven.'
      );
    }
    const opened = await chrome.tabs.create({ url: openUrl, active: true });
    if (!Number.isSafeInteger(opened?.id)) {
      throw fail('BROWSER_NO_TAB', `the browser did not open ${openUrl}`);
    }
    await this.attach(opened.id);
  },

  /**
   * Refuses to keep driving a page the driver would never have taken.
   *
   * The refusal list guarded two doors: attach, and navigate. A click is the third. Follow a
   * link and the tab lands wherever it points with the debugger session still on it, so the one
   * refusal this list exists for — the model must not reach the ChatGPT tab it is speaking
   * from — could be walked around by clicking a link to it. The comment on that list says it is
   * refused at the lowest level "rather than anywhere it could later be forgotten"; this is
   * where it had been forgotten. Proven by clicking one, in Chrome, before it was written.
   *
   * The address comes from the protocol rather than from `chrome.tabs`, because the protocol
   * answers whether or not the extension holds permission to read that tab's URL — and a check
   * that goes blank exactly when permissions are thin is the failure this same list already had.
   *
   * Only pages the driver has been holding are checked. A tab attached moments ago was already
   * judged by `attach`, and a tab this driver just opened passes through about:blank on its way
   * to the page it was asked for, which is refused and would detach it on arrival.
   */
  /**
   * The address the tab is really showing.
   *
   * Three surfaces answer this and two of them lie about a page that failed to load. Measured
   * against a dead port: `chrome.tabs` reports the requested `http://127.0.0.1:1/`,
   * `Page.getNavigationHistory` reports the same, and only `Page.getFrameTree` reports what the
   * tab actually holds — `chrome-error://chromewebdata/`, carrying the address that failed
   * alongside it as `unreachableUrl`. The isolated world agrees with the frame tree, which is why
   * observe could describe a Chrome error page as though it were the site: every check upstream
   * had asked one of the two surfaces that still name the site.
   */
  async currentPageUrl() {
    try {
      const { frameTree } = await send('Page.getFrameTree');
      const frame = frameTree?.frame;
      const url = String(frame?.url ?? '');
      if (url) return { url, unreachable: String(frame?.unreachableUrl ?? '') };
    } catch { /* fall back to history below */ }
    try {
      const history = await send('Page.getNavigationHistory');
      return { url: String(history?.entries?.[history.currentIndex]?.url ?? ''), unreachable: '' };
    } catch {
      // Unreadable through the protocol means the session is already in trouble; onDetach and
      // tabs.onRemoved cover a tab that has gone, and the next action will fail on its own.
      return { url: '', unreachable: '' };
    }
  },

  /**
   * Whether the address left `from` within the budget.
   *
   * Polled rather than driven off `Page.frameNavigated`, because the answer is wanted for a click
   * that may well produce no navigation at all — that is the case being measured — and an event
   * that never arrives cannot be distinguished from one that is merely late without a timer
   * anyway. Polling the frame tree says both things with one instrument.
   */
  async waitForUrlChange(from, budgetMs) {
    const until = Date.now() + budgetMs;
    for (;;) {
      const { url } = await this.currentPageUrl();
      if (url && url !== from) return true;
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  },

  async assertPageStillAllowed() {
    if (!session) return;
    const { url: address, unreachable } = await this.currentPageUrl();
    if (!address || !refusedUrl(address)) return;
    await this.detach().catch(() => {});
    // A page that failed to load is not a page that "moved" somewhere, and saying so sends the
    // caller looking for a redirect that never happened. The address it could not reach is the
    // one thing worth naming, because retrying or fixing it is the only way forward.
    if (unreachable) {
      throw fail(
        'BROWSER_URL_REFUSED',
        `the tab is showing Chrome's error page because ${unreachable} could not be loaded, so there ` +
          'is no page to drive. The tab has been let go of.'
      );
    }
    throw fail(
      'BROWSER_URL_REFUSED',
      `the page moved to ${address}, which browser control refuses. The tab has been let go of.`
    );
  },

  async act(action) {
    // Whether the page could have moved under us: a session that predates this call has had the
    // chance, one established by the line below has not.
    const held = Boolean(session);
    const type = String(action?.type ?? '');
    // navigate is the one action that carries its own destination, so it is the one action that
    // can start from nothing. Its address is judged here, before a tab exists, so that a refused
    // one never becomes a reason to open a tab and a refusal reads the same whether or not the
    // browser happened to have a page open.
    if (type === 'navigate') {
      const target = String(action.url ?? '');
      if (refusedUrl(target)) throw fail('BROWSER_URL_REFUSED', `browser control refuses ${target}`);
      if (!/^https?:\/\//i.test(target)) throw fail('BAD_REQUEST', 'navigate needs an http(s) URL');
      await this.ensureAttached(target);
    } else {
      await this.ensureAttached();
    }
    if (held) await this.assertPageStillAllowed();
    const button = cdpButton(action?.button);
    const modifiers = (action?.modifiers ?? []).reduce(
      (bits, name) => bits | (MODIFIERS[String(name).toLowerCase()] ?? 0),
      0
    );

    switch (type) {
      case 'navigate': {
        // Already validated above, where it had to be.
        const url = String(action.url ?? '');
        await send('Page.navigate', { url }, NAVIGATE_TIMEOUT_MS);
        await restorePointer();
        // Where it landed, not where it was aimed. A redirect can end on a refused page, and an
        // action that only judges its argument cannot see that.
        await this.assertPageStillAllowed();
        return { navigated: url };
      }
      case 'back':
      case 'forward': {
        const history = await send('Page.getNavigationHistory');
        const index = history.currentIndex + (type === 'back' ? -1 : 1);
        const entry = history.entries?.[index];
        if (!entry) throw fail('BROWSER_NO_HISTORY', `there is nothing to go ${type} to`);
        // The destination is known before moving, so a refused one is refused before it is
        // reached rather than after. History is the one navigation that can say this in advance.
        if (refusedUrl(entry.url)) {
          throw fail('BROWSER_URL_REFUSED', `browser control refuses ${entry.url}`);
        }
        await send('Page.navigateToHistoryEntry', { entryId: entry.id }, NAVIGATE_TIMEOUT_MS);
        await restorePointer();
        await this.assertPageStillAllowed();
        return { navigated: entry.url };
      }
      case 'reload':
        await send('Page.reload', {}, NAVIGATE_TIMEOUT_MS);
        await restorePointer();
        await this.assertPageStillAllowed();
        return { reloaded: true };

      case 'click_ref': {
        /*
         * Say what the click actually landed on.
         *
         * A QA run clicked a freshly observed link, got `ok`, and the page did not move — twice,
         * a second apart. Everything in the call had succeeded: the ref resolved, the element was
         * visible, the click was trusted. Nothing in the answer could distinguish that from a link
         * that simply does not navigate. So the answer now carries what was under the point, and
         * says plainly when something else is covering it.
         */
        const at = await this.resolveRef(action.ref);
        const before = at.expect ? (await this.currentPageUrl()).url : '';
        const clicked = await this.act({ ...action, type: 'click', x: at.x, y: at.y });
        const answer = { ...clicked, hit: at.hit, covered: at.covered };
        /*
         * A link click is checked against the one thing it promised to do.
         *
         * `hit` and `covered` were the previous answer to "the click succeeded and the page did
         * not move", and both are blind to the case that keeps producing it. They are computed by
         * the renderer, so they can only see what the *page* draws. A browser-native dialog — the
         * password-manager leak prompt, a permission bubble — is painted by the browser process
         * over the web contents and suspends input to it. `elementFromPoint` cannot see it, so
         * `covered` is honestly false, the click is dispatched and reported trusted, and it
         * reaches nothing.
         *
         * Measured twice by QA on the-internet's Logout button, the second time with the cause
         * visible: `hit=i covered=false`, the URL unchanged, and a foreground Chrome dialog
         * headed "Passwort ändern" over the page. No CDP event announces such a dialog, so it
         * cannot be detected — but its effect can. The click still happened and is still reported
         * as such; what is added is whether the page went where the link pointed.
         */
        // `before` must be known for the comparison to mean anything. If the address could not be
        // read at all, every later reading differs from it and the click would be reported as
        // having navigated — turning this check into the very thing it exists to catch. An
        // unreadable address says the session is already in trouble; say nothing rather than
        // something false.
        if (at.expect && before) {
          const settled = await this.waitForUrlChange(before, CLICK_NAVIGATION_MS);
          answer.navigated = settled;
          if (!settled) {
            answer.expected = at.expect;
            // Under 200 characters, deliberately. The MCP layer renders a driver answer by
            // printing every field it finds — which is what lets a new field like this one arrive
            // there without being enumerated — and truncates any value past 200 with an ellipsis.
            // The first draft ran to 315 and lost its whole second half at exactly that cut: the
            // caller was told a click had been swallowed and not what to do about it, which is the
            // half worth having. `expected` already carries the address, so this does not repeat
            // it. Measured through renderBrowserAction rather than estimated — see its test.
            answer.note =
              'delivered, but the page did not go there. A Chrome password or permission dialog in ' +
              'front of the tab can swallow a click invisibly. Check the screen, or use navigate ' +
              'to reach the address directly.';
          }
        }
        return answer;
      }
      case 'move_ref': {
        /*
         * Point at a control without pressing anything.
         *
         * Two independent QA runs named this as the one action genuinely missing: menus that open
         * on hover, tooltips, and anything that reveals its controls only under the pointer were
         * unreachable, because the only way to a named element was a click — which commits to the
         * thing the hover was meant to inspect first. Coordinates could not stand in: what a hover
         * reveals is usually laid out relative to the element, so the point has to be resolved from
         * the ref at the moment of the move, not read off an older screenshot.
         */
        const at = await this.resolveRef(action.ref);
        const moved = await this.act({ type: 'move', x: at.x, y: at.y });
        return { ...moved, hit: at.hit, covered: at.covered };
      }
      case 'set_value': {
        const at = await this.resolveRef(action.ref);
        /**
         * A native <select> is not a text field and cannot be driven as one.
         *
         * Chrome paints its dropdown in the browser process, above the page and outside the
         * renderer entirely, so no CDP input event aimed at any coordinate reaches an option.
         * The typing path below is therefore not merely wrong here, it is unobservable: the click
         * opens a popup the driver cannot see, insertText goes nowhere, and every call still
         * reports success. QA spent a step on exactly that — click_ref, keyboard, set_value and
         * typing in turn, no tool error from any of them, and every read-back still showing
         * "Please select an option".
         *
         * Selecting the option and firing input+change is what the page would observe from a real
         * selection, and is the only route that exists from out here.
         */
        if (at.tag === 'select') {
          const { result: picked, exceptionDetails: pickFailed } = await send('Runtime.evaluate', {
            expression: `(() => {
              const el = document.querySelector(${JSON.stringify(at.path)});
              if (!el || el.tagName !== 'SELECT') return JSON.stringify({ ok: false, reason: 'gone' });
              if (el.disabled) return JSON.stringify({ ok: false, reason: 'disabled' });
              const want = ${JSON.stringify(String(action.text ?? ''))};
              const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
              const options = Array.from(el.options);
              const label = (o) => (o.label || o.textContent || '');
              // Exact value first, so a page whose values differ from its labels stays drivable
              // by the value it actually submits; then either spelling, case and space forgiven.
              const pick =
                options.find((o) => o.value === want) ||
                options.find((o) => norm(o.value) === norm(want)) ||
                options.find((o) => norm(label(o)) === norm(want));
              if (!pick) {
                return JSON.stringify({
                  ok: false, reason: 'no-option',
                  options: options.filter((o) => !o.disabled).map((o) => label(o).trim()).slice(0, 20)
                });
              }
              if (pick.disabled) return JSON.stringify({ ok: false, reason: 'option-disabled' });
              el.focus();
              el.selectedIndex = pick.index;
              // Both, in this order, and bubbling: 'input' is what a framework binding listens
              // for and 'change' is what plain pages listen for. A selection that fired neither
              // would leave the page's own state behind the control the user can see.
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return JSON.stringify({ ok: true, value: el.value, label: label(pick).trim() });
            })()`,
            contextId: at.contextId,
            returnByValue: true
          });
          if (pickFailed) throw fail('BROWSER_BAD_REF', `${action.ref} could not be set on this page`);
          const outcome = JSON.parse(String(picked?.value ?? '{}'));
          if (outcome.reason === 'gone') throw fail('BROWSER_BAD_REF', `${action.ref} is no longer on this page`);
          if (outcome.reason === 'disabled') throw fail('BROWSER_ACTION_REFUSED', `${action.ref} is disabled`);
          if (outcome.reason === 'option-disabled') {
            throw fail('BROWSER_ACTION_REFUSED', `that option of ${action.ref} is disabled`);
          }
          if (outcome.reason === 'no-option') {
            // Naming the choices costs one line and saves the round trip that guessing would take.
            const offered = (outcome.options ?? []).filter(Boolean).join(', ');
            throw fail(
              'BROWSER_ACTION_REFUSED',
              `${action.ref} has no option matching that text${offered ? `. Options: ${offered}` : ''}`
            );
          }
          if (outcome.ok !== true) throw fail('BROWSER_BAD_REF', `${action.ref} could not be set on this page`);
          return { set: action.ref, value: outcome.value, selected: outcome.label };
        }
        // Focus by clicking where the control actually is, select everything, then insert.
        // Writing `value` directly through the DOM skips the input events a page listens for,
        // so a framework-backed field would look changed and behave as if it never was.
        await this.act({ type: 'click', x: at.x, y: at.y });
        // `commands` rather than a modifier, because a modifier only describes the keystroke and
        // leaves the browser to decide what it means. QA measured what that costs: set_value on
        // a field holding "OLD TEXT" produced "OLD TEXTONLY NEW" — nothing was selected, so the
        // insert appended. This names the editing command outright, which is platform-independent
        // and does not depend on Cmd versus Ctrl being interpreted the way the page expects.
        await send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown', modifiers: SELECT_ALL_MODIFIER, key: 'a', code: 'KeyA',
          windowsVirtualKeyCode: 65, commands: ['selectAll']
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp', modifiers: SELECT_ALL_MODIFIER, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65
        });
        const text = String(action.text ?? '');
        // insertText with empty text is a no-op, so an intentional clear needs a real delete.
        // With the whole value selected, one delete removes it — and QA found an empty set_value
        // reporting ok while the field kept its contents, which is the same missing selection.
        if (text) await send('Input.insertText', { text });
        else {
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
        }
        return { set: action.ref, length: text.length };
      }

      case 'move':
        await movePointer(action.x, action.y);
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: action.x, y: action.y, modifiers
        });
        return { moved: { x: action.x, y: action.y } };

      case 'click':
      case 'double_click': {
        const clickCount = type === 'double_click' ? 2 : 1;
        const openerTabId = session.tabId;
        // A click that opens a tab is attributed by Chrome to whichever tab is active, not to
        // this one — see ensureTabActive's own comment. Without this, createdTab correlation
        // silently fails whenever the driven tab sits behind the conversation tab, which is the
        // ordinary case rather than the exception.
        const { broughtToFront } = await ensureTabActive(session.tabId);
        const beforeTabs = new Set(
          (await chrome.tabs.query({}).catch(() => [])).map((tab) => tab.id)
        );
        await movePointer(action.x, action.y);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: action.x, y: action.y, modifiers });
        for (let press = 1; press <= clickCount; press++) {
          await movePointer(action.x, action.y, true);
          await send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: action.x, y: action.y, button, buttons: buttonMask(action.button),
            clickCount: press, modifiers
          });
          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: action.x, y: action.y, button, buttons: 0,
            clickCount: press, modifiers
          });
          await movePointer(action.x, action.y);
        }
        const createdTab = await findCreatedTab(openerTabId, beforeTabs);
        return {
          clicked: { x: action.x, y: action.y, button, clickCount },
          ...(createdTab ? { createdTab } : {}),
          ...(broughtToFront ? { broughtToFront } : {})
        };
      }

      case 'drag': {
        const path = Array.isArray(action.path) ? action.path : [];
        if (path.length < 2) throw fail('BAD_REQUEST', 'drag needs at least two points');
        const mask = buttonMask(action.button);
        // A drag presses, moves and releases through the same Input.dispatchMouseEvent calls
        // click does, and a backgrounded tab defers all of them the same way — see
        // ensureTabActive's own comment. Missing here, a drag over a backgrounded tab would
        // fail exactly how scroll and click used to: silently, with no escalation available.
        const { broughtToFront } = await ensureTabActive(session.tabId);
        await movePointer(path[0].x, path[0].y, true);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: path[0].x, y: path[0].y, modifiers });
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: path[0].x, y: path[0].y, button, buttons: mask, clickCount: 1, modifiers
        });
        // Held before moving, and dwelt on before releasing. Both desktop drivers learned this
        // the hard way and carry the same two numbers; this one still teleported press to
        // release, so an HTML5 drag never started and a drop target that arms on hover never
        // armed. A drag that presses and lets go in the same instant is a click with waypoints.
        await pause(DRAG_PRESS_HOLD_MS);
        for (const point of path.slice(1)) {
          await movePointer(point.x, point.y, true);
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: point.x, y: point.y, button, buttons: mask, modifiers
          });
        }
        const last = path[path.length - 1];
        await pause(DRAG_DROP_DWELL_MS);
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: last.x, y: last.y, button, buttons: 0, clickCount: 1, modifiers
        });
        await movePointer(last.x, last.y);
        return { dragged: path.length, ...(broughtToFront ? { broughtToFront } : {}) };
      }

      case 'scroll': {
        const x = Number(action.x ?? 0);
        const y = Number(action.y ?? 0);
        // A background tab defers the compositor work a scroll gesture and a wheel event both
        // need — see ensureTabActive's own comment for the measurement. Without this, a scroll
        // over a backgrounded tab times out and reports moved: false for a scroll that lands a
        // few seconds later, doubled, the instant something brings the tab back.
        const { broughtToFront } = await ensureTabActive(session.tabId);
        await movePointer(x, y);
        /*
         * Sent, then judged by whether the page moved — not by whether the protocol answered.
         *
         * A wheel event is acknowledged only once the compositor has taken it, and it sometimes
         * never is: QA hit `Input.dispatchMouseEvent did not answer within 30000 ms` twice in a
         * real browser on a real page, so scrolling reported failure for an action that was
         * delivered. Headless never acknowledges one at all. The acknowledgement is a property
         * of the compositor, not of the scroll.
         *
         * So: read the position, send, and look again. A page that moved scrolled, whatever the
         * protocol said. A page that did not move and did not answer is reported as a timeout,
         * because then nothing is known.
         */
        const dx = Number(action.scroll_x ?? 0);
        const dy = Number(action.scroll_y ?? 0);
        const before = await readScrollPosition(send, x, y);
        const moveFrom = (position) =>
          position !== null && before !== null && (position.x !== before.x || position.y !== before.y);

        /*
         * The gesture first, because the event does not work.
         *
         * `Input.dispatchMouseEvent` with `type: 'mouseWheel'` is accepted by Chrome 152 and then
         * does nothing at all — measured on a Mac with a visible browser, at the viewport corner
         * and at its centre: never acknowledged, never any movement, while `scrollBy` in the same
         * page moved it 300 pixels. A run through the app saw the same thing, so this was broken
         * for anyone using it and not merely unverifiable on a build machine.
         *
         * `Input.synthesizeScrollGesture` is the protocol's own scrolling primitive: it drives the
         * compositor rather than posting an event into it, and with `gestureSourceType: 'mouse'`
         * the page still sees real wheel events.
         *
         * Its sign convention is the opposite of the DOM's — `yDistance` is positive to scroll
         * *up*, while a positive `deltaY` scrolls down — so it is negated here to keep the
         * caller's convention the DOM one. Getting a scroll sign wrong by reasoning about the
         * wrong API is exactly how every page once scrolled backwards, so the direction is
         * asserted against a real browser in `verify:browser` rather than argued about here.
         */
        let acknowledged = true;
        try {
          await send('Input.synthesizeScrollGesture', {
            x, y, xDistance: -dx, yDistance: -dy, gestureSourceType: 'mouse'
          }, SCROLL_TIMEOUT_MS);
        } catch (error) {
          if (error?.code !== 'BROWSER_TIMEOUT') throw error;
          acknowledged = false;
        }
        let after = await waitForScrollOnset(send, before, SCROLL_ONSET_TIMEOUT_MS, x, y);
        if (!moveFrom(after)) {
          // The wheel event as a fallback: it is what worked before Chrome stopped acting on it,
          // and a browser that ignores the gesture instead is not one this code has met.
          try {
            await send('Input.dispatchMouseEvent', {
              type: 'mouseWheel', x, y, modifiers, deltaX: dx, deltaY: dy
            }, SCROLL_TIMEOUT_MS);
            acknowledged = true;
          } catch (error) {
            if (error?.code !== 'BROWSER_TIMEOUT') throw error;
            acknowledged = false;
          }
          after = await waitForScrollOnset(send, before, SCROLL_ONSET_TIMEOUT_MS, x, y);
        }
        if (moveFrom(after)) {
          await settleAfterScroll(send, x, y);
          after = await readScrollPosition(send, x, y);
        }
        const moved = moveFrom(after);
        // Not moving is not the same as not working. A page already at its end does not move, and
        // refusing that would be wrong. What is worth refusing is knowing nothing at all: nothing
        // acknowledged and nothing moved means the scroll may as well not have been sent.
        if (!acknowledged && !moved) {
          throw fail(
            'BROWSER_SCROLL_FAILED',
            `neither a scroll gesture nor a wheel event was taken at ${x},${y}, and the page did ` +
              'not move. Scroll over the element that actually scrolls, or observe first to see ' +
              'where the page is.'
          );
        }
        return { scrolled: { x, y }, moved, acknowledged, ...(broughtToFront ? { broughtToFront } : {}) };
      }

      case 'type': {
        // insertText rather than a keystroke per character: it is one round trip instead of
        // hundreds, it does not depend on the layout, and it is what a paste looks like to
        // the page. Composition-sensitive editors still see a real input event.
        const text = String(action.text ?? '');
        if (!text) return { typed: 0 };
        await send('Input.insertText', { text });
        return { typed: text.length };
      }

      case 'keypress': {
        const names = Array.isArray(action.keys) ? action.keys : [];
        if (names.length === 0) throw fail('BAD_REQUEST', 'keypress needs at least one key');
        const held = names.filter((name) => MODIFIERS[String(name).toLowerCase()] !== undefined);
        const plain = names.filter((name) => MODIFIERS[String(name).toLowerCase()] === undefined);
        const bits = held.reduce((all, name) => all | MODIFIERS[String(name).toLowerCase()], modifiers);
        // A chord of modifiers alone is a real thing to send; a chord with keys sends those
        // keys while the modifier bits are set, which is what every page listens for.
        const targets = plain.length > 0 ? plain : held;
        for (const name of targets) {
          const key = keyDescriptor(name);
          const base = {
            modifiers: bits,
            key: key.key,
            code: key.code,
            windowsVirtualKeyCode: key.vk,
            nativeVirtualKeyCode: key.vk
          };
          // A modifier held down must not also insert text, and neither must a chord:
          // Ctrl+A types nothing, it selects.
          const text = bits === 0 && key.text ? key.text : undefined;
          await send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text });
          await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
        }
        return { pressed: names.length };
      }

      case 'wait': {
        const ms = Math.min(10_000, Math.max(0, Number(action.ms ?? 250)));
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { waited: ms };
      }

      default:
        throw fail('BAD_REQUEST', `unknown browser action ${type || '(none)'}`);
    }
  },

  /** One look: what the page is, what can be acted on, and a picture of it. */
  async observe({ includeScreenshot = true } = {}) {
    // Reading a page is as much a use of the session as acting on one — a refused page must not
    // be readable either, and observe is how anything would be read.
    if (session) await this.assertPageStillAllowed();
    // And the screenshot below is where the pointer has to appear. A page can replace its own
    // document without any navigation action to hook — a clicked link, a redirect — so drawing
    // it here covers what re-drawing after the navigation actions cannot.
    if (session) await restorePointer();
    await this.ensureAttached();
    const tab = await currentTab(session.tabId);
    session.url = tab.url ?? session.url;
    session.title = tab.title ?? session.title;
    // Bumped before collecting, so every ref this observation mints is stamped with a number no
    // earlier observation ever used and no later one ever will.
    session.refGeneration = (session.refGeneration ?? 0) + 1;
    const page = await collectElements(session.refGeneration);
    // Only the newest observation's refs are addressable. Keeping older ones alive would let
    // a ref from three pages ago resolve against whatever happens to match now.
    session.refs = new Map(
      (page.elements ?? []).map((element) => [
        element.ref,
        // No offset stored. It used to read element.frameX/frameY, which collectElements never
        // sets — so it was always {0,0}, harmless only because resolveRef recomputes the offset
        // from the frame itself and ignored the stored value. A dead field that looks like a
        // fallback is worse than no field: the next reader trusts it.
        { path: element.path, frameId: element.frameId }
      ])
    );
    const view = await viewport();
    const shot = includeScreenshot ? await screenshot() : null;
    return {
      tabId: session.tabId,
      url: page.url || session.url,
      title: page.title || session.title,
      viewport: view,
      scrollY: page.scrollY,
      scrollHeight: page.scrollHeight,
      // The path and the frame are how a ref is resolved, not something the model should
      // reason about: it names a ref and gets coordinates already in the page's own space.
      elements: (page.elements ?? []).map(({ path, frameId, ...element }) => element),
      screenshot: shot
    };
  }
};

/**
 * The browser tearing a session down is not an error, it is news.
 *
 * A user closing the tab, hitting Chrome's own "Cancel" on the debugging banner, or opening
 * DevTools all end the session without asking us. Forgetting it here is what keeps `status()`
 * honest and stops the next action from addressing a tab that is not ours any more.
 */
let lifecycleInstalled = false;

export function installBrowserDriverLifecycle() {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  chrome.debugger.onDetach.addListener((source) => {
    if (source?.tabId !== undefined) browserDriver.forget(source.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => browserDriver.forget(tabId));
}
