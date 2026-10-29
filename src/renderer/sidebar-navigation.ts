/** Inbox and Projects are separate views over the same durable sessions. */
const STORAGE_KEY = 'chat-on-steroids.sidebar-view';
type SidebarView = 'inbox' | 'projects';

export function initSidebarNavigation(): void {
  const inboxTab = document.getElementById('sidebarInboxTab') as HTMLButtonElement;
  const projectsTab = document.getElementById('sidebarProjectsTab') as HTMLButtonElement;
  const inboxPane = document.getElementById('inboxPane')!;
  const projectsPane = document.getElementById('projectsPane')!;
  const tabs = [inboxTab, projectsTab];
  let initial: SidebarView = 'inbox';
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === 'projects') initial = 'projects';
  } catch { /* Private or disabled storage keeps a working default. */ }

  const show = (view: SidebarView, persist = true): void => {
    const inbox = view === 'inbox';
    inboxPane.hidden = !inbox;
    projectsPane.hidden = inbox;
    for (const [tab, selected] of [[inboxTab, inbox], [projectsTab, !inbox]] as const) {
      tab.classList.toggle('is-sel', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    if (persist) {
      try { window.localStorage.setItem(STORAGE_KEY, view); }
      catch { /* In-memory navigation still works. */ }
    }
  };
  inboxTab.addEventListener('click', () => show('inbox'));
  projectsTab.addEventListener('click', () => show('projects'));
  for (const tab of tabs) tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'ArrowLeft' || event.key === 'Home' ? 0 : 1;
    show(next === 0 ? 'inbox' : 'projects');
    tabs[next]!.focus();
  });
  show(initial, false);
}
