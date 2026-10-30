/** Ephemeral multi-selection; navigation and the active conversation are independent. */
export function createSidebarSelection() {
  const selected = new Set<string>();
  let anchor: string | null = null;
  return {
    get anchor(): string | null { return anchor; },
    has: (id: string): boolean => selected.has(id),
    ids: (): string[] => [...selected],
    clear(): void { selected.clear(); anchor = null; },
    navigate(id: string): void { selected.clear(); anchor = id; },
    toggle(id: string): void {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      anchor = id;
    },
    range(id: string, order: readonly string[]): void {
      const from = anchor ? order.indexOf(anchor) : -1;
      const to = order.indexOf(id);
      if (from < 0 || to < 0) {
        selected.add(id); anchor = id;
        return;
      }
      for (const key of order.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(key);
    },
    /** A hidden/removed row may not be acted on after pagination or a project switch. */
    retain(visible: ReadonlySet<string>): void {
      for (const id of selected) if (!visible.has(id)) selected.delete(id);
      if (anchor && !visible.has(anchor)) anchor = null;
    }
  };
}
