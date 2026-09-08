/** A renderer-only layout preference, independent of chat selection and app config. */
export function initSidebarResize(): void {
  const app = document.querySelector<HTMLElement>('.app')!;
  const sidebar = document.getElementById('sidebar')!;
  const handle = document.getElementById('sidebarResize')!;
  const toggle = document.getElementById('sidebarToggle')!;
  const menu = document.getElementById('viewMenu') as HTMLDetailsElement;
  const key = 'chat-on-steroids.sidebar-width';
  const minimum = 180;
  const maximum = () => Math.max(minimum, Math.min(480, window.innerWidth / 2));
  let preferred: number | null = null;
  let collapsed = false;
  let drag: { id: number; x: number; width: number } | null = null;
  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved >= minimum) preferred = Math.min(480, saved);
    collapsed = localStorage.getItem(`${key}.collapsed`) === 'true';
  } catch { /* Layout remains usable when storage is unavailable. */ }
  function render(): void {
    app.classList.toggle('is-sidebar-collapsed', collapsed);
    sidebar.inert = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    if (preferred === null) app.style.removeProperty('--sidebar-width');
    else app.style.setProperty('--sidebar-width', `${Math.min(maximum(), preferred)}px`);
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(maximum()));
    handle.setAttribute('aria-valuenow', String(Math.round(sidebar.getBoundingClientRect().width)));
  }
  function save(): void {
    try {
      if (preferred === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(preferred));
    } catch { /* Keep the current width for this window. */ }
  }
  function setWidth(width: number): void {
    preferred = Math.round(Math.max(minimum, Math.min(maximum(), width)));
    render();
  }
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return;
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width };
    app.classList.add('is-resizing-sidebar');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (drag?.id === event.pointerId) setWidth(drag.width + event.clientX - drag.x);
  });
  function finish(event: PointerEvent): void {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    app.classList.remove('is-resizing-sidebar');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    save();
  }
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('dblclick', () => { preferred = null; render(); save(); });
  handle.addEventListener('keydown', (event) => {
    const width = sidebar.getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') setWidth(width - 10);
    else if (event.key === 'ArrowRight') setWidth(width + 10);
    else if (event.key === 'Home') setWidth(minimum);
    else if (event.key === 'End') setWidth(maximum());
    else return;
    event.preventDefault();
    save();
  });
  function toggleSidebar(): void {
    collapsed = !collapsed;
    if (collapsed && sidebar.contains(document.activeElement)) toggle.focus();
    render();
    try { localStorage.setItem(`${key}.collapsed`, String(collapsed)); } catch { /* Optional persistence. */ }
  }
  toggle.addEventListener('click', toggleSidebar);
  document.getElementById('sidebarMenuToggle')!.addEventListener('click', toggleSidebar);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      if (!event.repeat) toggleSidebar();
    }
    if (event.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary')?.focus(); }
  });
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target as Node) || (event.target as Element).closest('button')) menu.open = false;
  });
  window.addEventListener('resize', render);
  render();
}
