/**
 * The browser driver's decidable parts.
 *
 * The protocol traffic itself needs a real browser and is proven by using it. Everything that
 * can be decided without one is decided here, and the first block is the important one: the
 * refusal list is the only thing standing between "the model can drive a web page" and "the
 * model can drive the conversation it is having with you".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_PERMISSIONS,
  browserDriver,
  COLLECT_SOURCE,
  DRIVEN_GROUP_TITLE,
  buttonMask,
  cdpButton,
  browserControlSupported,
  hasBrowserPermissions,
  keyDescriptor,
  refusedUrl,
  requestBrowserPermissions
} from '../extension/browser-driver.js';

const manifest = JSON.parse(
  readFileSync(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
);

describe('what browser control refuses to attach to', () => {
  /**
   * The model asking for browser control is sitting in a ChatGPT tab. A driver able to attach
   * there could send messages as the user, answer its own confirmations, or read a different
   * conversation the person has open. This is the one refusal that is not about tidiness.
   */
  it('never attaches to ChatGPT itself', () => {
    for (const url of [
      'https://chatgpt.com/',
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'https://chatgpt.com/g/g-p-project/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'https://CHATGPT.com/',
      'https://chat.openai.com/',
      // Four addresses a string prefix got wrong. The first two reached ChatGPT: `http://` was
      // not matched at all and Chrome redirects it to https with the session still attached, and
      // userinfo sits exactly where the host was expected. The third is a subdomain the prefix
      // never covered. The fourth is the same host wearing a port.
      'http://chatgpt.com/',
      'https://user@chatgpt.com/',
      'https://sub.chatgpt.com/',
      'https://chatgpt.com:443/',
      'https://chatgpt.com./'
    ]) {
      expect(refusedUrl(url), url).toBe(true);
    }
  });

  it('refuses a scheme by it not being the web, rather than by name', () => {
    // The list named `chrome:`, `file:`, `javascript:` and the rest, so anything nobody thought
    // of read as an ordinary page. Only http and https are drivable; everything else follows.
    for (const url of ['data:text/html,<p>hi', 'blob:https://example.com/abc', 'ws://example.com/', 'intent://scan/#Intent;end']) {
      expect(refusedUrl(url), url).toBe(true);
    }
  });

  it('never attaches to the browser, its extensions or the filesystem', () => {
    for (const url of [
      'chrome://settings',
      'chrome://extensions',
      'edge://settings',
      'about:blank',
      'about:config',
      'devtools://devtools/bundled/inspector.html',
      'chrome-extension://abcdefghijklmnop/popup.html',
      'moz-extension://abcdefghijklmnop/popup.html',
      'view-source:https://example.com',
      'file:///C:/Users/you/secrets.txt'
    ]) {
      expect(refusedUrl(url), url).toBe(true);
    }
  });

  it('allows the ordinary web, which is the entire point', () => {
    for (const url of [
      'https://example.com/',
      'http://localhost:3000/app',
      'https://github.com/some/repo/pull/1',
      'https://notchatgpt.com/',
      'https://example.com/?next=https://chatgpt.com/',
      // Refused by the old prefix and correctly allowed now: it is not ChatGPT, it merely starts
      // with those letters. A rule that refuses this is refusing by spelling, not by identity.
      'https://chatgpt.com.example.org/'
    ]) {
      expect(refusedUrl(url), url).toBe(false);
    }
  });

  it('treats a missing or malformed url as refusable rather than allowed', () => {
    // This is what the test has always been called and what it now asserts. It used to assert
    // the opposite: an unreadable address was allowed, on the reasoning that attach would stop
    // it on an http(s) check. There is no such check on that path — only navigate has one — so
    // the reasoning described a gate that did not exist.
    //
    // It matters because `tab.url` is undefined for every tab the extension cannot see, and the
    // whole refusal list is written against that field. Allowing an unknown address turns the
    // list off exactly where it cannot be checked.
    expect(refusedUrl(undefined)).toBe(true);
    expect(refusedUrl('')).toBe(true);
    expect(refusedUrl('   ')).toBe(true);
    expect(refusedUrl('javascript:alert(1)')).toBe(true);
  });
});

describe('why no tab could be taken', () => {
  const withTabs = async (tabs: unknown[], run: () => Promise<void>) => {
    const original = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = { tabs: { query: async () => tabs } };
    try {
      await run();
    } finally {
      (globalThis as { chrome?: unknown }).chrome = original;
    }
  };

  /**
   * "Nothing is open" and "nothing whose address I may read" are different problems, and only
   * the second is the user's to solve. Chrome answers `tab.url` with undefined wherever the
   * extension has no access, and those tabs are refused rather than driven — so a browser full
   * of pages can present as an empty one, and the advice to open a page changes nothing.
   */
  it('says the addresses cannot be read rather than that nothing is open', async () => {
    await withTabs([{ id: 1 }, { id: 2 }], async () => {
      await expect(browserDriver.ensureAttached()).rejects.toMatchObject({
        code: 'BROWSER_PERMISSION_REQUIRED'
      });
    });
  });

  it('still says nothing is drivable when the only readable tabs are refused ones', async () => {
    await withTabs([{ id: 1, url: 'https://chatgpt.com/c/x' }], async () => {
      await expect(browserDriver.ensureAttached()).rejects.toMatchObject({ code: 'BROWSER_NO_TAB' });
    });
  });
});

describe('permissions are opt-in', () => {
  /**
   * `debugger` is required, and it has to be.
   *
   * It was optional here, on the reasoning that shipping the most far-reaching permission as
   * required would re-prompt every user on update for a capability most never switch on. Sound
   * reasoning about a design Chrome does not allow: `debugger` cannot appear in
   * optional_permissions. Chrome drops the entry when the manifest loads, so requesting it later
   * answers "Only permissions specified in the manifest may be requested" — measured against
   * Chrome 152 with a trusted click, where `chrome.debugger` was also simply `undefined`. One
   * unavailable entry failed the whole request, so the popup switch could never stay on, and QA
   * found the feature unusable.
   *
   * The opt-in still means something: site and tab access stay optional, and those are what
   * decide whether the extension can read a page at all.
   */
  it('requires debugger, because Chrome will not grant it any other way', () => {
    expect(manifest.permissions).toEqual(['storage', 'scripting', 'alarms', 'debugger']);
    expect(manifest.optional_permissions).toEqual(['tabs', 'tabGroups']);
    expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
    // Site access is still not granted at install; that is the part worth keeping optional.
    expect(manifest.host_permissions).not.toContain('<all_urls>');
  });

  /**
   * The guard for the class of mistake, not just this instance.
   *
   * Chrome documents a set of permissions that may never be optional, and declaring one there is
   * silent: the manifest loads, the entry vanishes, and the only symptom is a runtime request
   * that fails for a reason nobody sees. A build should not be able to reach a browser in that
   * state again.
   */
  it('declares no permission Chrome refuses to treat as optional', () => {
    // Verified empirically for `debugger` against Chrome 152; the rest are documented alongside
    // it as install-time only.
    const NEVER_OPTIONAL = [
      'debugger',
      'declarativeNetRequest',
      'devtools',
      'experimental',
      'mdns',
      'proxy',
      'tts',
      'ttsEngine',
      'wallpaper'
    ];
    const declared = manifest.optional_permissions ?? [];
    expect(declared.filter((name: string) => NEVER_OPTIONAL.includes(name))).toEqual([]);
  });

  it('asks for exactly what the manifest offers, and no more', () => {
    expect(BROWSER_PERMISSIONS.permissions).toEqual(manifest.optional_permissions);
    expect(BROWSER_PERMISSIONS.origins).toEqual(manifest.optional_host_permissions);
  });

  /**
   * A capture is not an ordinary command.
   *
   * `Page.captureScreenshot` answers when the renderer produces a frame, and a tab that is not
   * compositing can take seconds to make one — measured at over ten in a real headless run.
   * Holding it to the ordinary deadline turns "the page was quiet" into a failed observation.
   */
  it('gives the two compositor-bound operations their own deadline', () => {
    const driver = readFileSync(path.join(process.cwd(), 'extension', 'browser-driver.js'), 'utf8');
    expect(driver).toContain('const COMPOSITOR_TIMEOUT_MS = 30_000;');
    // A capture answers when a frame is produced; a wheel event when the compositor has taken
    // it. Both were measured stalling past ten seconds on an idle tab in a real browser.
    expect(driver).toMatch(/Page\.captureScreenshot[\s\S]{0,220}COMPOSITOR_TIMEOUT_MS/);
    // Scrolling has its own, shorter budget. It is judged by where the page ended up rather than
    // by an acknowledgement, so waiting the full compositor deadline buys nothing — two failed
    // attempts cost a minute of a run in which nothing happened, measured on a Mac.
    expect(driver).toContain('const SCROLL_TIMEOUT_MS = 5_000;');
    expect(driver).toMatch(/Input\.synthesizeScrollGesture[\s\S]{0,200}SCROLL_TIMEOUT_MS/);
    expect(driver).toMatch(/type: 'mouseWheel'[\s\S]{0,200}SCROLL_TIMEOUT_MS/);
    // Clicks and keystrokes are acknowledged directly and keep the ordinary deadline, which
    // still exists: an unbounded wait is how a stuck tab becomes a stuck tool call.
    expect(driver).toContain('const COMMAND_TIMEOUT_MS = 15_000;');
    expect(driver).not.toMatch(/type: 'mousePressed'[\s\S]{0,200}COMPOSITOR_TIMEOUT_MS/);
  });

  it('names the driven tab group after the product so it is recognisable', () => {
    expect(DRIVEN_GROUP_TITLE).toBe('Chat On Steroids');
  });

  /**
   * Chrome answers `permissions.*` through a callback and returns nothing. Firefox returns a
   * promise and ignores the callback. This extension ships for both, so waiting only for the
   * callback would hang forever on one of them — and the symptom would be a toggle that does
   * nothing at all, with no error to chase.
   */
  describe('across both extension APIs', () => {
    // The driver reads whichever of the two globals the browser provides, so the test has to
    // be able to install either and put the environment back afterwards.
    const globals = globalThis as unknown as Record<string, unknown>;
    const original = { chrome: globals.chrome, browser: globals.browser };
    afterEach(() => {
      globals.chrome = original.chrome;
      globals.browser = original.browser;
    });

    /** Every fake carries the debugger API, because a browser without it cannot do any of this. */
    const debuggerApi = { attach() {}, detach() {}, sendCommand() {}, onDetach: { addListener() {} } };

    it('accepts the Chrome callback', async () => {
      globals.browser = undefined;
      globals.chrome = {
        runtime: {},
        debugger: debuggerApi,
        permissions: {
          contains: (_perms: unknown, done: (granted: boolean) => void) => done(true),
          request: (_perms: unknown, done: (granted: boolean) => void) => done(false)
        }
      };
      await expect(hasBrowserPermissions()).resolves.toBe(true);
      await expect(requestBrowserPermissions()).resolves.toBe(false);
    });

    it('accepts the Firefox promise, which never calls the callback', async () => {
      globals.browser = {
        runtime: {},
        debugger: debuggerApi,
        permissions: {
          contains: () => Promise.resolve(true),
          request: () => Promise.resolve(true)
        }
      };
      await expect(hasBrowserPermissions()).resolves.toBe(true);
      await expect(requestBrowserPermissions()).resolves.toBe(true);
    });

    it('answers false rather than hanging when the API is absent or throws', async () => {
      globals.browser = undefined;
      globals.chrome = { runtime: {}, debugger: debuggerApi };
      await expect(hasBrowserPermissions()).resolves.toBe(false);

      globals.chrome = {
        runtime: {},
        debugger: debuggerApi,
        permissions: { contains: () => { throw new Error('no'); } }
      };
      await expect(hasBrowserPermissions()).resolves.toBe(false);

      globals.browser = {
        runtime: {},
        debugger: debuggerApi,
        permissions: { contains: () => Promise.reject(new Error('denied')) }
      };
      await expect(hasBrowserPermissions()).resolves.toBe(false);
    });

    /**
     * Support is decided by whether the browser recognises the permission, not by whether the
     * `debugger` object is there.
     *
     * That object does not exist until the optional permission is granted, so a presence check
     * would hide the very switch that grants it and make the feature permanently unreachable —
     * which is exactly what a real Edge run reported before this was corrected: the popup saw
     * no debugger API at all, on a browser that supports it perfectly well.
     */
    it('supports a browser that knows the permission, granted or not', async () => {
      globals.browser = undefined;
      // Chrome shape: knows the name, has not granted it. The switch must be offered.
      globals.chrome = {
        runtime: {},
        permissions: { contains: (_p: unknown, done: (held: boolean) => void) => done(false) }
      };
      await expect(browserControlSupported()).resolves.toBe(true);

      // Granted: still supported, and now actually held.
      globals.chrome = {
        runtime: {},
        debugger: debuggerApi,
        permissions: { contains: (_p: unknown, done: (held: boolean) => void) => done(true) }
      };
      await expect(browserControlSupported()).resolves.toBe(true);
      await expect(hasBrowserPermissions()).resolves.toBe(true);
    });

    it('treats a browser that does not know the permission as unsupported', async () => {
      globals.chrome = undefined;
      // A browser that never implemented it reports the unknown name rather than answering.
      globals.browser = {
        runtime: { lastError: { message: 'Type error for parameter permissions' } },
        permissions: { contains: (_p: unknown, done: (held: unknown) => void) => done(undefined) }
      };
      await expect(browserControlSupported()).resolves.toBe(false);
      await expect(hasBrowserPermissions()).resolves.toBe(false);

      // And the promise shape of the same refusal.
      globals.browser = {
        runtime: {},
        permissions: { contains: () => Promise.reject(new Error('unknown permission')) }
      };
      await expect(browserControlSupported()).resolves.toBe(false);
    });
  });

  /**
   * electron-builder copies the whole extension folder, but the packaged-runtime smoke check
   * names every file it expects. A driver missing from the package would otherwise ship as a
   * browser-control toggle that fails on first use.
   */
  it('is required by the packaged-runtime smoke check', () => {
    const smoke = readFileSync(path.join(process.cwd(), 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');
    expect(smoke).toContain("'extension/browser-driver.js'");
    // And the declaration file, which a browser cannot run, stays out of both packages: the
    // app's bundled copy and the standalone add-on zip are produced by different steps, and
    // only the first was filtered — the published zip carried it until a built artifact was
    // actually opened and looked at.
    const builder = readFileSync(path.join(process.cwd(), 'electron-builder.yml'), 'utf8');
    expect(builder).toContain("- '!**/*.d.ts'");
    const release = readFileSync(path.join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf8');
    expect(release).toContain("-x '*.map' -x '*.d.ts'");
    expect(release).toContain('required in manifest.json background.js browser-driver.js');
    expect(release).toContain('Extension zip carries TypeScript declarations');
  });
});

describe('the shared input vocabulary', () => {
  it('maps every mouse button the rest of the product accepts', () => {
    expect(cdpButton('left')).toBe('left');
    expect(cdpButton('right')).toBe('right');
    expect(cdpButton('middle')).toBe('middle');
    expect(cdpButton('wheel')).toBe('middle');
    expect(cdpButton('back')).toBe('back');
    expect(cdpButton('forward')).toBe('forward');
    expect(cdpButton(undefined)).toBe('left');
    expect(cdpButton('nonsense')).toBe('left');
  });

  it('holds the right bit while a drag is in progress', () => {
    expect(buttonMask('left')).toBe(1);
    expect(buttonMask('right')).toBe(2);
    expect(buttonMask('wheel')).toBe(4);
    expect(buttonMask('back')).toBe(8);
    expect(buttonMask('forward')).toBe(16);
  });

  it('accepts the same key names as the desktop driver, DOM spellings included', () => {
    expect(keyDescriptor('ArrowLeft')).toMatchObject({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
    expect(keyDescriptor('left')).toMatchObject({ key: 'ArrowLeft', vk: 37 });
    expect(keyDescriptor('Enter')).toMatchObject({ key: 'Enter', vk: 13 });
    expect(keyDescriptor('Return')).toMatchObject({ key: 'Enter', vk: 13 });
    expect(keyDescriptor('Escape')).toMatchObject({ key: 'Escape', vk: 27 });
    expect(keyDescriptor('PageDown')).toMatchObject({ key: 'PageDown', vk: 34 });
    expect(keyDescriptor('F5')).toMatchObject({ key: 'F5', code: 'F5', vk: 116 });
    expect(keyDescriptor('a')).toMatchObject({ key: 'a', code: 'KeyA', text: 'a' });
    expect(keyDescriptor('7')).toMatchObject({ key: '7', code: 'Digit7', text: '7' });
  });

  it('refuses a key it cannot name rather than pressing something arbitrary', () => {
    expect(() => keyDescriptor('NotAKey')).toThrowError(/unknown key/i);
  });
});

/**
 * The page reader, run against a real DOM.
 *
 * This is the part most likely to be quietly wrong — a selector that misses the button the
 * model needs, a name that comes back empty, a hidden element reported as clickable — so it
 * is exercised rather than asserted. jsdom computes no layout, so the fixture declares each
 * element's rectangle and the test installs a `getBoundingClientRect` that returns it.
 */
describe('reading a page', () => {
  function read(body: string, viewport = { width: 1000, height: 800 }) {
    const dom = new JSDOM(`<!doctype html><title>Fixture page</title><body>${body}</body>`, {
      url: 'https://example.com/page',
      // The collector runs inside the page, so the test has to run it there too.
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & typeof globalThis;
    Object.defineProperty(window, 'innerWidth', { value: viewport.width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: viewport.height, configurable: true });
    window.Element.prototype.getBoundingClientRect = function rect(this: Element) {
      const spec = (this as HTMLElement).dataset?.rect;
      const [left = 0, top = 0, width = 0, height = 0] = (spec ?? '0,0,0,0').split(',').map(Number);
      return {
        left, top, width, height,
        right: left + width, bottom: top + height,
        x: left, y: top, toJSON: () => ({})
      } as DOMRect;
    };
    const raw = window.eval(COLLECT_SOURCE) as string;
    return JSON.parse(raw) as {
      url: string;
      title: string;
      elements: Array<Record<string, unknown>>;
    };
  }

  it('finds what can be acted on, and says where', () => {
    const page = read(`
      <a href="/next" data-rect="10,20,100,30">Next page</a>
      <button data-rect="10,60,80,24">Save</button>
      <input type="text" placeholder="Search" data-rect="10,100,200,28">
      <div role="button" data-rect="10,140,60,20">Custom</div>
    `);

    expect(page.url).toBe('https://example.com/page');
    expect(page.title).toBe('Fixture page');
    expect(page.elements).toHaveLength(4);
    // Every element carries the path its ref is re-resolved with. Refs themselves are numbered
    // by the driver across all frames, not here: this collector runs once per frame and a
    // per-frame counter would hand out the same ref for two different elements.
    expect(page.elements.every((e) => typeof e.path === 'string' && (e.path as string).length > 0)).toBe(true);
    expect(page.elements.some((e) => 'ref' in e)).toBe(false);
    expect(page.elements.map((e) => [e.role, e.name])).toEqual([
      ['link', 'Next page'],
      ['button', 'Save'],
      ['textbox', 'Search'],
      ['button', 'Custom']
    ]);
    // Coordinates are the element's centre, in the same space the input methods use.
    expect(page.elements[1]).toMatchObject({ x: 50, y: 72, width: 80, height: 24 });
  });

  it('prefers the accessible name over the visible text', () => {
    const page = read(`
      <button aria-label="Close dialog" data-rect="0,0,20,20">×</button>
      <span id="lbl">Email address</span>
      <input type="text" aria-labelledby="lbl" data-rect="0,30,200,28">
      <button data-rect="0,70,40,40"><img alt="Print" src="p.png"></button>
    `);
    expect(page.elements.map((e) => e.name)).toEqual(['Close dialog', 'Email address', 'Print']);
  });

  it('leaves out what a pointer could not reach', () => {
    const page = read(`
      <button data-rect="10,10,60,20">Visible</button>
      <button data-rect="0,0,0,0">Zero size</button>
      <button style="display:none" data-rect="10,40,60,20">Display none</button>
      <button style="visibility:hidden" data-rect="10,70,60,20">Hidden</button>
      <button aria-hidden="true" data-rect="10,100,60,20">Aria hidden</button>
      <button data-rect="-200,10,60,20">Scrolled off the left</button>
      <button data-rect="10,900,60,20">Below the fold</button>
    `);
    expect(page.elements.map((e) => e.name)).toEqual(['Visible']);
  });

  it('reports state the model has to know before it acts', () => {
    const page = read(`
      <button disabled data-rect="0,0,50,20">Submit</button>
      <input type="checkbox" checked data-rect="0,30,20,20" aria-label="Remember me">
      <input type="text" value="already here" data-rect="0,60,200,28" aria-label="Note">
    `);
    expect(page.elements[0]).toMatchObject({ name: 'Submit', disabled: true });
    expect(page.elements[1]).toMatchObject({ name: 'Remember me', checked: 'true' });
    expect(page.elements[2]).toMatchObject({ name: 'Note', value: 'already here' });
  });

  it('bounds a hostile page instead of handing the model everything it has', () => {
    const many = Array.from(
      { length: 400 },
      (_, index) => `<button data-rect="0,${index % 700},40,10">B${index}</button>`
    ).join('');
    expect(read(many).elements.length).toBeLessThanOrEqual(200);
  });
});

/**
 * Two protocols, two conventions, and they are not the same.
 *
 * CoreGraphics' wheel API takes an inverted sign, and the macOS helper negates for it correctly.
 * CDP's mouseWheel carries the DOM convention instead, where a positive deltaY scrolls down —
 * which is also what the caller means. The driver negated anyway, carrying the macOS reasoning
 * to the wrong protocol, and scrolled every page backwards. Nothing caught it: a wheel event is
 * acknowledged only once a compositor has taken it, and headless has none, so the real-browser
 * run cannot reach this at all.
 */
describe('the browser driver scrolls the way the caller asked', () => {
  const driver = readFileSync(path.join(process.cwd(), 'extension/browser-driver.js'), 'utf8');
  const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');

  /**
   * Two protocols, two conventions, and the caller only ever means the DOM one.
   *
   * `Input.dispatchMouseEvent` carries the DOM convention: a positive deltaY scrolls down, so the
   * caller's numbers pass through untouched. `Input.synthesizeScrollGesture` is the opposite —
   * `yDistance` is positive to scroll *up* — so those are negated. Both appear in the same
   * function, which is exactly the shape that produced the original bug: the macOS helper's
   * inversion was carried to CDP by reasoning rather than measurement, and every page scrolled
   * backwards.
   *
   * These assertions pin the pairing. The direction itself is proven in `verify:browser` against
   * a real browser, because that is the only thing that can actually settle it.
   */
  it('negates for the gesture and not for the wheel, which disagree about the sign', () => {
    expect(driver).toMatch(/synthesizeScrollGesture[\s\S]{0,120}xDistance: -dx, yDistance: -dy/);
    expect(driver).toMatch(/type: 'mouseWheel'[\s\S]{0,80}deltaX: dx, deltaY: dy/);
    expect(driver).not.toMatch(/deltaY: -dy/);
    expect(driver).not.toMatch(/yDistance: dy/);
  });

  it('still negates for CoreGraphics, which really is inverted', () => {
    expect(swift).toMatch(/wheel1|scrollWheelEvent/);
  });

  /**
   * Select-all is Cmd on a Mac and Ctrl everywhere else. Hardcoding Meta made set_value append
   * instead of replace off macOS, and made an intentional clear delete a single character.
   */
  it('chooses the select-all modifier for the platform it runs on', () => {
    expect(driver).toContain('const SELECT_ALL_MODIFIER =');
    expect(driver).toContain("/Mac/i.test(globalThis.navigator?.userAgent ?? '') ? 4 : 2");
    expect(driver).toContain('modifiers: SELECT_ALL_MODIFIER');
    expect(driver).not.toMatch(/modifiers: 4, key: 'a'/);
  });
});

/**
 * Two findings from a review of the ensureTabActive round, both real.
 *
 * The scroll and click cases were each fixed in their own commit; a drag is the same
 * Input.dispatchMouseEvent machinery those fixes exist for, and was never given the same call.
 * And ensureTabActive's own return had a gap the review found by reading, not by running: a tab
 * whose windowId is somehow undefined skips the escalation entirely, but execution still fell
 * through the unconditional `return { broughtToFront: true }` at the end of the function — the
 * exact misreport class this round's whole fix was for, on a path no live-Chrome run exercises
 * (a real tab always carries a windowId), which is why this is a source assertion and not a
 * driven-fixture one.
 */
describe('the ensureTabActive review findings', () => {
  const driver = readFileSync(path.join(process.cwd(), 'extension/browser-driver.js'), 'utf8');

  it('activates the driven tab before a drag, the same as before a scroll or a click', () => {
    const dragCase = driver.slice(driver.indexOf("case 'drag': {"), driver.indexOf('case \'scroll\': {'));
    expect(dragCase).toMatch(/const \{ broughtToFront \} = await ensureTabActive\(session\.tabId\);/);
    // Before the first Input.dispatchMouseEvent this case sends, not after.
    const activateAt = dragCase.indexOf('ensureTabActive(session.tabId)');
    // The literal call, not a comment mentioning the method — this file's own comments say
    // "Input.dispatchMouseEvent" in prose above the real call.
    const firstDispatchAt = dragCase.indexOf("send('Input.dispatchMouseEvent'");
    expect(activateAt).toBeGreaterThan(-1);
    expect(activateAt).toBeLessThan(firstDispatchAt);
  });

  it('never reports broughtToFront: true on the one path that never attempted it', () => {
    const body = driver.slice(driver.indexOf('async function ensureTabActive'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    // The undefined-windowId guard must return on its own, before the escalation call — not
    // fall through to it, and not fall through to the unconditional true at the end.
    expect(fn).toMatch(/if \(tab\.windowId === undefined\) return \{ broughtToFront: false \};/);
    const guardAt = fn.indexOf('tab.windowId === undefined');
    const updateAt = fn.indexOf('chrome.windows.update(tab.windowId');
    const finalReturnAt = fn.lastIndexOf('return { broughtToFront: true };');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(updateAt);
    expect(updateAt).toBeLessThan(finalReturnAt);
  });
});

describe('a driven tab group does not outlive the session that created it', () => {
  const driver = readFileSync(path.join(process.cwd(), 'extension/browser-driver.js'), 'utf8');
  const background = readFileSync(path.join(process.cwd(), 'extension/background.js'), 'utf8');

  it('sweeps stale groups before creating a new one, not after', () => {
    const body = driver.slice(driver.indexOf('async function groupDrivenTab'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    const sweepAt = fn.indexOf('await sweepStaleDrivenGroups()');
    const createAt = fn.indexOf('chrome.tabs.group(');
    expect(sweepAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeLessThan(createAt);
  });

  it('never ungroups the session it is currently running', () => {
    const body = driver.slice(driver.indexOf('export async function sweepStaleDrivenGroups'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toMatch(/if \(session && group\.id === session\.groupId\) continue;/);
    const guardAt = fn.indexOf('session.groupId) continue');
    const ungroupAt = fn.indexOf('chrome.tabs.ungroup(tabIds)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(ungroupAt);
  });

  it('never closes the tabs it ungroups, only the grouping', () => {
    const body = driver.slice(driver.indexOf('export async function sweepStaleDrivenGroups'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).not.toMatch(/chrome\.tabs\.remove/);
  });

  it('also runs on the extension\'s own wake timer, not only before a new attach', () => {
    const alarmHandler = background.slice(
      background.indexOf('webext.alarms.onAlarm.addListener'),
      background.indexOf('webext.alarms.onAlarm.addListener') + 800
    );
    expect(alarmHandler).toMatch(/browserDriverModule\.sweepStaleDrivenGroups\(\)/);
  });
});
