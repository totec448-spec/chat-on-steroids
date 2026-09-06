/** Capture the visible logical row for one synchronous reconciliation. No retained
 * state: selection changes and user scrolling naturally get a fresh anchor. */
export function preserveTimelineViewport(pane: HTMLElement, timeline: HTMLElement): () => void {
  const previous = pane.scrollTop;
  const following = previous + pane.clientHeight >= pane.scrollHeight - 40;
  const edge = pane.getBoundingClientRect().top;
  const rows = () => [...timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')]
    .filter(row => !row.matches('.tool-group[open]'));
  const anchor = following ? undefined : rows().find(row => {
    const rect = row.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > edge && rect.top < edge + pane.clientHeight;
  });
  const key = anchor?.dataset.timelineKey;
  const offset = anchor ? anchor.getBoundingClientRect().top - edge : 0;
  return () => {
    if (following) { pane.scrollTop = pane.scrollHeight; return; }
    const current = key ? rows().find(row => row.dataset.timelineKey === key) : undefined;
    const rect = current?.getBoundingClientRect();
    pane.scrollTop = rect && rect.height > 0
      ? pane.scrollTop + rect.top - pane.getBoundingClientRect().top - offset
      : previous;
  };
}
