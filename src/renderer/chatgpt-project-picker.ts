import type { AppApi } from '../preload/index.js';
import type { ChatgptProjectChoice, LocalProject } from '../shared/projects.js';
import { icon } from './dom.js';
import { t } from './i18n.js';
import { createSearchPopup, type SearchPopup, type SearchPopupChoice } from './search-popup.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Choosing a project's ChatGPT Project (#1756): a new one, or one the account already has, as
 * ChatGPT's sidebar listed them. Closing the choice changes nothing, right after a folder is added
 * too: the project then has no ChatGPT Project until one is chosen from its menu, and nothing is
 * created behind the person's back (Haz on #1757). From the menu a linked project can change to
 * another one or a new one. A ChatGPT Project another project uses is shown but cannot be picked.
 */
export function createChatgptProjectPicker(deps: {
  api: Pick<AppApi, 'chatgptProjectChoices' | 'linkChatgptProject' | 'createChatgptProject'>;
  anchor: (projectId: string) => HTMLElement | null;
  onUpdated: (project: LocalProject) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
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
      const link = project.chatgpt;
      // A new one in place of a linked or failed one only from the menu; never over a creation in flight.
      const replaceable = !link || link.state === 'linked' || link.state === 'failed' || link.state === 'uncertain';
      const fresh: SearchPopupChoice[] = replaceable ? [{
        label: t('New ChatGPT Project “{0}”', [project.name]),
        // Long names are cut in the list; the whole label stays readable on hover.
        title: t('New ChatGPT Project “{0}”', [project.name]),
        lead: icon('i-plus'),
        // Its label holds the local project's name, so a search for a Project with that name also matches it.
        fallback: true,
        pick: () => decide(() => deps.api.createChatgptProject(project.id, link ? { replace: true } : {}))
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
        notes: () => [t('Missing one? Open chatgpt.com to refresh.'),
          ...(mode === 'added' ? [t('Or choose later from the ⋯ menu.')] : [])]
      });
      popup.show();
      // No row to open the choice from (the sidebar hides it): after an add, nothing is created either;
      // the person learns where to choose instead.
      if (!popup.open && mode === 'added' && !decided) deps.onNotice(t('Choose its ChatGPT Project later from the project’s ⋯ menu.'));
    }
  };
}
