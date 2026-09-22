import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { preserveTimelineViewport } from '../src/renderer/timeline-scroll.js';

it('anchors the logical reader row across late growth and replacement, while retaining nested tool scroll', () => {
  const dom = new JSDOM('<div id="pane"><div id="timeline"><div data-timeline-key="reader"><details open><p>Tool result</p></details></div></div></div>');
  try {
    const pane = dom.window.document.getElementById('pane')!;
    const timeline = dom.window.document.getElementById('timeline')!;
    let row = timeline.firstElementChild as HTMLElement;
    let documentTop = 450;
    pane.scrollTop = 400;
    Object.defineProperties(pane, { clientHeight: { value: 200 }, scrollHeight: { value: 1500 } });
    pane.getBoundingClientRect = () => ({ top: 20 } as DOMRect);
    const measure = () => ({ top: 20 + documentTop - pane.scrollTop, bottom: 220 + documentTop - pane.scrollTop, height: 200 } as DOMRect);
    row.getBoundingClientRect = measure;
    const result = row.querySelector('p')!;
    result.scrollTop = 75;
    let restore = preserveTimelineViewport(pane, timeline);
    documentTop += 180;
    restore();
    expect(pane.scrollTop).toBe(580);
    expect(measure().top).toBe(70);
    expect(result.scrollTop).toBe(75);
    expect(row.querySelector('details')!.open).toBe(true);

    restore = preserveTimelineViewport(pane, timeline);
    const replacement = row.cloneNode(true) as HTMLElement;
    replacement.getBoundingClientRect = measure;
    row.replaceWith(replacement); row = replacement;
    documentTop += 90;
    restore();
    expect(pane.scrollTop).toBe(670);
    expect(measure().top).toBe(70);

    restore = preserveTimelineViewport(pane, timeline);
    row.remove(); restore();
    expect(pane.scrollTop).toBe(670);
    pane.scrollTop = 1300;
    restore = preserveTimelineViewport(pane, timeline);
    restore();
    expect(pane.scrollTop).toBe(1500); // Browser clamps to the new bottom.
  } finally { dom.window.close(); }
});

it.each([2, 20, 39])('does not reclaim bottom-following after the reader scrolls %s pixels away', distance => {
  const dom = new JSDOM('<div id="pane"><div id="timeline"><div data-timeline-key="reader"></div></div></div>');
  try {
    const pane = dom.window.document.getElementById('pane')!;
    const timeline = dom.window.document.getElementById('timeline')!;
    const reader = timeline.firstElementChild as HTMLElement;
    let height = 1500;
    Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { get: () => height } });
    pane.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    timeline.getBoundingClientRect = () => ({ height } as DOMRect);
    reader.getBoundingClientRect = () => ({ top: 1000 - pane.scrollTop, bottom: 1500 - pane.scrollTop, height: 500 } as DOMRect);
    pane.scrollTop = 1100 - distance;
    for (let index = 0; index < 4; index++) preserveTimelineViewport(pane, timeline)();
    expect(pane.scrollTop).toBe(1100 - distance);
    const restore = preserveTimelineViewport(pane, timeline);
    height += 200;
    restore();
    expect(pane.scrollTop).toBe(1100 - distance);
    pane.scrollTop = height - pane.clientHeight - 0.5;
    const follow = preserveTimelineViewport(pane, timeline);
    height += 100;
    follow();
    expect(pane.scrollTop).toBe(height);
  } finally { dom.window.close(); }
});

it('uses another visible row when a paged activity group loses its old key', () => {
  const dom = new JSDOM('<div id="pane"><div id="timeline"><div data-timeline-key="old-group"></div><div data-timeline-key="message"></div></div></div>');
  try {
    const pane = dom.window.document.getElementById('pane')!;
    const timeline = dom.window.document.getElementById('timeline')!;
    const group = timeline.children[0] as HTMLElement, message = timeline.children[1] as HTMLElement;
    let added = 0;
    pane.scrollTop = 0;
    Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 4000 } });
    pane.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    group.getBoundingClientRect = () => ({ top: added - pane.scrollTop, bottom: added + 30 - pane.scrollTop, height: 30 } as DOMRect);
    message.getBoundingClientRect = () => ({ top: added + 30 - pane.scrollTop, bottom: added + 100 - pane.scrollTop, height: 70 } as DOMRect);
    const restore = preserveTimelineViewport(pane, timeline, false);
    group.remove(); added = 2000;
    restore();
    expect(message.getBoundingClientRect().top).toBe(30);
    expect(pane.scrollTop).toBe(2000);
  } finally { dom.window.close(); }
});

it('preserves a visible row when the page shrinks below the scrollHeight viewport floor', () => {
  const dom = new JSDOM('<div id="pane"><div id="timeline"><div data-timeline-key="reader"></div></div></div>');
  try {
    const pane = dom.window.document.getElementById('pane')!;
    const timeline = dom.window.document.getElementById('timeline')!;
    const reader = timeline.firstElementChild as HTMLElement;
    let contentHeight = 1300, rowTop = 20, scrollTop = 0;
    const reserve = () => Number.parseFloat(timeline.style.getPropertyValue('--timeline-scroll-reserve')) || 0;
    Object.defineProperties(pane, {
      clientHeight: { value: 778 },
      scrollHeight: { get: () => Math.max(778, contentHeight + reserve()) },
      scrollTop: { get: () => scrollTop, set: value => { scrollTop = Math.max(0, Math.min(value, pane.scrollHeight - pane.clientHeight)); } }
    });
    pane.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    timeline.getBoundingClientRect = () => ({ height: contentHeight + reserve() } as DOMRect);
    reader.getBoundingClientRect = () => ({ top: rowTop - scrollTop, bottom: rowTop + 200 - scrollTop, height: 200 } as DOMRect);
    const restore = preserveTimelineViewport(pane, timeline, false);
    contentHeight = 520;
    rowTop = 122.25;
    restore();
    expect(reader.getBoundingClientRect().top).toBe(20);
    expect(pane.scrollTop).toBe(102.25);
    expect(reserve()).toBe(361);
    const again = preserveTimelineViewport(pane, timeline, false);
    again();
    expect(reader.getBoundingClientRect().top).toBe(20);
  } finally { dom.window.close(); }
});
