/** Capture the visible logical row for one synchronous reconciliation. No retained
 * state: selection changes and user scrolling naturally get a fresh anchor. */
export function preserveTimelineViewport(pane: HTMLElement, timeline: HTMLElement, followBottom = true): () => void {
  const previous = pane.scrollTop;
  const following = followBottom && previous + pane.clientHeight >= pane.scrollHeight - 40;
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
      const reserve = Math.ceil(top - Math.max(0, pane.scrollHeight - pane.clientHeight));
      if (reserve > 0) timeline.style.setProperty('--timeline-scroll-reserve', `${reserve}px`);
      pane.scrollTop = top;
      return;
    }
    pane.scrollTop = previous;
  };
}
