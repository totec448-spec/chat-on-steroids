// The 160-row resident window plus one incoming 30-row stage and a small margin.
// Cap raw journal counts here: streaming revisions are not separate visible rows.
const VIRTUAL_WINDOW_RECORDS = 200;

export interface TimelineExtent {
  session: string;
  selection: number;
  average: number;
  height: number;
}

/** Keep the scroll range stable while bounded history pages replace one another.
 * The estimate is visual only: it never decides which event to fetch or retain. */
export function projectTimelineExtent(
  previous: TimelineExtent | null,
  input: { session: string; selection: number; total: number; resident: number;
    before: number; after: number; renderedHeight: number }
): { extent: TimelineExtent; before: number; after: number } {
  const renderedHeight = Math.max(0, input.renderedHeight);
  const total = Math.max(0, input.total);
  const same = previous?.session === input.session && previous.selection === input.selection;
  const average = same ? previous.average : Math.max(24, Math.min(180, renderedHeight / Math.max(1, input.resident)));
  const height = Math.max(renderedHeight,
    same ? previous.height : Math.min(total, VIRTUAL_WINDOW_RECORDS) * average);
  const extent = { session: input.session, selection: input.selection, average, height };
  const before = Math.max(0, input.before), after = Math.max(0, input.after);
  const missing = before + after;
  if (!missing) return { extent, before: 0, after: 0 };
  const reserve = Math.max(0, height - renderedHeight);
  const top = Math.round(reserve * before / missing);
  return { extent, before: top, after: reserve - top };
}

/** Capture the visible logical row for one synchronous reconciliation. No retained
 * state: selection changes and user scrolling naturally get a fresh anchor. */
export function preserveTimelineViewport(pane: HTMLElement, timeline: HTMLElement, followBottom = true): () => void {
  const previous = pane.scrollTop;
  // Only rounding tolerance belongs here. A small deliberate scroll away from the
  // tail must survive unrelated session/status repaints and later answer growth.
  const following = followBottom && previous + pane.clientHeight >= pane.scrollHeight - 1;
  const previousReserve = Number.parseFloat(timeline.style.getPropertyValue('--timeline-scroll-reserve')) || 0;
  const previousContentHeight = timeline.getBoundingClientRect().height - previousReserve;
  const edge = pane.getBoundingClientRect().top;
  const rows = () => [...timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')]
    .filter(row => !row.matches('.tool-group[open]'));
  const anchors: Array<{ key: string | undefined; offset: number }> = [];
  if (!following) for (const row of rows()) {
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.top >= edge + pane.clientHeight) break;
    if (rect.bottom > edge) anchors.push({ key: row.dataset.timelineKey, offset: rect.top - edge });
  }
  return () => {
    timeline.style.removeProperty('--timeline-scroll-reserve');
    if (following) {
      const growth = Math.max(0, timeline.getBoundingClientRect().height - previousContentHeight);
      const reserve = Math.max(0, previousReserve - growth);
      if (reserve > 0) timeline.style.setProperty('--timeline-scroll-reserve', `${reserve}px`);
      pane.scrollTop = pane.scrollHeight;
      return;
    }
    const currentRows = new Map(rows().map(row => [row.dataset.timelineKey, row]));
    for (const anchor of anchors) {
      const rect = currentRows.get(anchor.key)?.getBoundingClientRect();
      if (!rect || rect.height <= 0) continue;
      const top = pane.scrollTop + rect.top - pane.getBoundingClientRect().top - anchor.offset;
      // An underfilled tail has real blank space below its last row. Prepending
      // must preserve that space too, otherwise Chromium clamps the restored
      // anchor to the new bottom and moves every visible message. Recompute the
      // reserve on each paint so later content naturally consumes it.
      let reserve = Math.ceil(top - Math.max(0, pane.scrollHeight - pane.clientHeight));
      if (reserve > 0) {
        // scrollHeight is floored at clientHeight. When eviction leaves less than
        // one viewport of content, it hides the additional blank-space deficit.
        // Measure with one viewport of temporary padding, then remove the excess;
        // both writes happen before paint and leave only the required reserve.
        reserve += pane.clientHeight;
        timeline.style.setProperty('--timeline-scroll-reserve', `${reserve}px`);
        reserve = Math.max(0, reserve - (pane.scrollHeight - pane.clientHeight - top));
        timeline.style.setProperty('--timeline-scroll-reserve', `${Math.ceil(reserve)}px`);
      }
      pane.scrollTop = top;
      return;
    }
    pane.scrollTop = previous;
  };
}
