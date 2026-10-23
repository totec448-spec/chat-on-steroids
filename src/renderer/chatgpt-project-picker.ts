import type { AppApi } from '../preload/index.js';
import type { ChatgptProjectChoice, LocalProject } from '../shared/projects.js';
import { icon } from './dom.js';
import { t } from './i18n.js';
import { createSearchPopup, type SearchPopup, type SearchPopupChoice } from './search-popup.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Choosing a project's ChatGPT Project (#1756): a new one, or one the account already has, as
 * ChatGPT's sidebar listed them. Right after a folder is added the choice decides what happens;
 * closing it then keeps today's default, a new ChatGPT Project. From a project's menu, closing it
 * changes nothing. A ChatGPT Project another project uses is shown but cannot be picked.
 */
export function createChatgptProjectPicker(deps: {
  api: Pick<AppApi, 'chatgptProjectChoices' | 'linkChatgptProject' | 'createChatgptProject'>;
  anchor: (projectId: string) => HTMLElement | null;
  onUpdated: (project: LocalProject) => void;
  onError: (message: string) => void;
}): { hasChoices(): Promise<boolean>; offer(project: LocalProject, mode: 'added' | 'menu'): Promise<void> } {
  let choices: ChatgptProjectChoice[] = [];
  let popup: SearchPopup | null = null;

  const load = async (): Promise<ChatgptProjectChoice[]> => {
    // No list (a failed read) only means the choice is not offered; adding works as before.
    const reply = await Promise.resolve().then(() => deps.api.chatgptProjectChoices()).catch(() => null);
    choices = reply?.ok && Array.isArray(reply.data) ? reply.data : [];
    return choices;
  };
  const settle = async (pending: Promise<Reply<LocalProject>>): Promise<void> => {
    const reply = await pending.catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    if (reply.ok) deps.onUpdated(reply.data); else deps.onError(reply.error);
  };

  return {
    /** True when ChatGPT has listed at least one Project no other project uses. */
    async hasChoices() {
      return (await load()).some(choice => !choice.linkedTo);
    },
    async offer(project, mode) {
      popup?.close();
      if (mode === 'menu') await load();
      let decided = false;
      const decide = (work: () => Promise<Reply<LocalProject>>) => { decided = true; void settle(work()); };
      const fresh: SearchPopupChoice[] = !project.chatgpt ? [{
        label: t('New ChatGPT Project “{0}”', [project.name]),
        // Long names are cut in the list; the whole label stays readable on hover.
        title: t('New ChatGPT Project “{0}”', [project.name]),
        lead: icon('i-plus'),
        pick: () => decide(() => deps.api.createChatgptProject(project.id))
      }] : [];
      popup = createSearchPopup({
        trigger: () => deps.anchor(project.id),
        className: 'file-branch',
        extraClass: 'inbox-project-picker chatgpt-project-picker',
        label: () => t('ChatGPT Project for {0}', [project.name]),
        heading: () => t('ChatGPT Project for {0}', [project.name]),
        placeholder: () => t('Search ChatGPT Projects'),
        choices: () => [...fresh, ...choices.map(choice => {
          const elsewhere = choice.linkedTo && choice.linkedTo.id !== project.id ? choice.linkedTo : null;
          return {
            label: choice.name,
            title: elsewhere ? `${choice.name}\n${t('Linked to {0}', [elsewhere.name])}` : choice.name,
            lead: icon('i-folder'),
            selected: choice.linkedTo?.id === project.id,
            disabled: !!elsewhere,
            ...(elsewhere ? { hint: t('Linked to {0}', [elsewhere.name]) } : {}),
            pick: () => decide(() => deps.api.linkChatgptProject(project.id, choice.id))
          } satisfies SearchPopupChoice;
        })],
        empty: () => t('No ChatGPT Project matches'),
        notes: () => [t('Missing one? Open chatgpt.com to refresh.')],
        // Right after adding, closing the choice keeps the default: a new ChatGPT Project.
        onDismiss: () => { if (mode === 'added' && !decided) decide(() => deps.api.createChatgptProject(project.id)); }
      });
      popup.show();
      // No row to open it from (the sidebar hides it): after an add, keep the default at once.
      if (!popup.open && mode === 'added' && !decided) decide(() => deps.api.createChatgptProject(project.id));
    }
  };
}
