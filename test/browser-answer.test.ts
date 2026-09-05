import { describe, expect, it } from 'vitest';
import { renderBrowserAction } from '../src/main/mcp/tools-desktop';

/**
 * The layer that lost three fixes.
 *
 * The driver had a suite proving it returns `hit`, `covered` and its own build; the macOS helper
 * had one too. Between them sat the rendering, reachable only through a live extension and a real
 * browser, and it replaced every reply but observe and status with the word `ok`. Two QA runs
 * reported working fixes as missing, and one of them I answered by blaming their browser — which
 * was wrong, and cost them a round.
 *
 * These tests call the rendering directly. Each one fails against the code as it was.
 */
describe('a browser answer carries what the driver answered', () => {
  it('keeps the fields that say where a click actually landed', () => {
    const { lines } = renderBrowserAction('click_ref', {
      clicked: { x: 12, y: 34 },
      hit: 'a#result',
      covered: true
    });
    expect(lines[0]).toContain('hit=a#result');
    expect(lines[0]).toContain('covered=true');
  });

  it('keeps them for a hover too, which is a different action and the same question', () => {
    const { lines } = renderBrowserAction('move_ref', { moved: { x: 5, y: 6 }, hit: 'button#menu', covered: false });
    expect(lines[0]).toContain('hit=button#menu');
    expect(lines[0]).toContain('covered=false');
  });

  it('says when a click opened a new ordinary tab', () => {
    // QA check 45: a target="_blank" click succeeded, but status kept naming only the original
    // tab and nothing in the click's own answer said a second tab now existed. createdTab is
    // driver-supplied, generic-field passthrough; this proves the renderer actually surfaces it.
    const { lines } = renderBrowserAction('click_ref', {
      clicked: { x: 12, y: 34 },
      hit: 'a#newTab',
      covered: false,
      createdTab: { tabId: 99, url: 'https://example.com/new', title: 'New tab' }
    });
    expect(lines[0]).toContain('createdTab={"tabId":99,"url":"https://example.com/new","title":"New tab"}');
  });

  /**
   * Passing a field through is not the same as passing it through whole.
   *
   * The generic renderer above truncates any value past 200 characters with an ellipsis, which is
   * right for a page title or a long url and wrong for a sentence written to be read. The
   * swallowed-click note was drafted at 315 and lost its second half at exactly that cut — the
   * caller would have been told a click reached nothing and not what to do about it, which is the
   * half worth having. Nothing below the MCP layer could see that: the driver's own suite proved
   * the field was set, and it was, in full.
   *
   * So this asserts the remedy survives rendering, not merely that the field appears.
   */
  it('renders the swallowed-click note whole, remedy included', () => {
    const note =
      'delivered, but the page did not go there. A Chrome password or permission dialog in ' +
      'front of the tab can swallow a click invisibly. Check the screen, or use navigate ' +
      'to reach the address directly.';
    const { lines } = renderBrowserAction('click_ref', {
      clicked: { x: 12, y: 34 },
      hit: 'i',
      covered: false,
      navigated: false,
      expected: 'https://example.com/secure',
      note
    });
    expect(lines[0]).toContain('navigated=false');
    expect(lines[0]).toContain('expected=https://example.com/secure');
    // The whole sentence, and no ellipsis: the actionable clause is the last one.
    expect(lines[0]).toContain('use navigate to reach the address directly.');
    expect(lines[0]).not.toContain('…');
  });

  it('carries a field nobody has thought of yet', () => {
    // The point of reading the answer rather than listing its fields: this test passes without
    // anyone editing the renderer, which is exactly what did not happen for hit and covered.
    const { lines } = renderBrowserAction('navigate', { navigated: 'https://example.com', somethingNew: 7 });
    expect(lines[0]).toContain('somethingNew=7');
  });

  it('names the running driver on the answer a run reads before it starts', () => {
    const held = renderBrowserAction('status', {
      attached: true, tabId: 42, title: 'Example', url: 'https://example.com', groupId: 9, build: 'a40c45c0ba34'
    });
    expect(held.lines[0]).toContain('driver build a40c45c0ba34');
    // Including the branch that holds nothing, which is the one a run reads first.
    const idle = renderBrowserAction('status', { attached: false, build: 'a40c45c0ba34' });
    expect(idle.lines[0]).toContain('no tab is under control');
    expect(idle.lines[0]).toContain('driver build a40c45c0ba34');
  });

  it('names the driver on a detach that actually let a tab go', () => {
    // The branch a review found bare. `status` had the build on both of its branches and detach
    // on only one, so the answer that reports a real release printed the one phrase the QA
    // instructions tell a run to treat as a finding.
    const { lines } = renderBrowserAction('detach', {
      attached: false,
      released: { tabId: 7, url: 'https://example.com', title: 'Example' },
      build: 'a40c45c0ba34'
    });
    expect(lines[0]).toContain('let go of tab 7');
    expect(lines[0]).toContain('driver build a40c45c0ba34');
    expect(lines[0]).not.toContain('unreported');
  });

  it('says so plainly when the driver did not name itself', () => {
    // Silence here is what made a stale extension indistinguishable from a fresh one.
    const { lines } = renderBrowserAction('status', { attached: false });
    expect(lines[0]).toContain('driver build unreported');
  });

  it('still answers ok when the driver genuinely said nothing', () => {
    expect(renderBrowserAction('reload', {}).lines[0]).toBe('reload: ok');
  });

  it('says a control is unticked, and stays silent where there is nothing to tick', () => {
    // Printing `checked=false` beside every text field was a regression the moment the field was
    // first rendered: `el.checked` is a boolean on every input, and the string 'false' is truthy.
    // On a settings page that is noise on nearly every line, and it buries the one case the field
    // exists for. An unticked checkbox must still say so — that is the useful half.
    const { lines } = renderBrowserAction('observe', {
      url: 'https://example.com', title: 'Settings',
      elements: [
        { ref: 'e1', role: 'textbox', name: 'Search', value: '', checked: '', x: 1, y: 2 },
        { ref: 'e2', role: 'checkbox', name: 'Remember me', value: '', checked: 'false', x: 3, y: 4 },
        { ref: 'e3', role: 'checkbox', name: 'Notify', value: '', checked: 'true', x: 5, y: 6 },
        { ref: 'e4', role: 'checkbox', name: 'Partly', value: '', checked: 'mixed', x: 7, y: 8 }
      ]
    });
    expect(lines.find((l) => l.startsWith('e1'))).not.toContain('checked');
    expect(lines.find((l) => l.startsWith('e2'))).toContain('checked=false');
    expect(lines.find((l) => l.startsWith('e3'))).toContain('checked=true');
    expect(lines.find((l) => l.startsWith('e4'))).toContain('checked=mixed');
  });

  it('hands back the observation screenshot, and only a real one', () => {
    const withShot = renderBrowserAction('observe', {
      url: 'https://example.com', title: 'Example', elements: [],
      screenshot: { data: 'AAAA', width: 800, height: 600 }
    });
    expect(withShot.observed).toBe(true);
    expect(withShot.screenshot).toEqual({ data: 'AAAA', width: 800, height: 600 });
    expect(renderBrowserAction('observe', { url: '', title: '', elements: [], screenshot: null }).screenshot).toBeUndefined();
  });
});
