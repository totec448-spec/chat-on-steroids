/**
 * What's New: the highlights of the version the app just updated to, once (#1172).
 *
 * The highlights are the release notes' own Highlights, shortened, and written in each release PR
 * next to the notes. Literal `t()` calls keep the catalog audit able to see each key, so every
 * language ships them like the rest of the interface. A version without an entry shows nothing.
 */
import { releaseNotesUrl, whatsNewAction } from '../shared/whats-new.js';
import { $, el, icon, run } from './dom.js';
import { t, ui } from './i18n.js';
import { primaryShortcut } from './shortcuts.js';

interface Highlight { icon: string; title: () => string; text: () => string }
interface Release { lead: () => string; highlights: Highlight[] }

const RELEASES: Readonly<Record<string, Release>> = {
  '2.1.44': {
    lead: () => t("Pictures with /image, keyboard shortcuts, and a quicker message after Stop."),
    highlights: [
      { icon: 'i-image', title: () => t("Ask for a picture"), text: () => t("Start a message with /image, and ChatGPT draws it with its own image tool.") },
      { icon: 'i-bolt', title: () => t("Keyboard shortcuts"), text: () => t("{0} starts a new chat, Ctrl+Tab moves between chats, and Esc twice stops an answer.", [primaryShortcut('N')]) },
      { icon: 'i-stop', title: () => t("Quicker after Stop"), text: () => t("A message you send right after Stop goes out at once.") },
      { icon: 'i-agents', title: () => t("Sub-agent chats tidy up"), text: () => t("With archiving on, a worker's chat is archived two minutes after its task is done.") }
    ]
  },
  '2.1.43': {
    lead: () => t("See what sub-agents do, long work that keeps going, and clearer Settings."),
    highlights: [
      { icon: 'i-agents', title: () => t("See what a sub-agent does"), text: () => t("Opening a sub-agent shows each action with its result and the files it changed.") },
      { icon: 'i-retry', title: () => t("Long work keeps going"), text: () => t("Compact & Resume steps in during long answers, and Goal and Loop continue in a fresh turn.") },
      { icon: 'i-gear', title: () => t("Clearer Settings"), text: () => t("Plain words throughout, and the sidebar layout picked from a picture.") },
      { icon: 'i-paw', title: () => t("Meet Whip"), text: () => t("A cheeky new pet that cracks its whip so the work goes faster.") }
    ]
  },
  '2.1.42': {
    lead: () => t('Bring back earlier messages, calmer answers, and long work that keeps going.'),
    highlights: [
      { icon: 'i-arrow-up', title: () => t('Bring back earlier messages'), text: () => t('Press Up in an empty message box to bring back what you sent in this chat.') },
      { icon: 'i-file-text', title: () => t('Answers that read calmly'), text: () => t('While ChatGPT writes, whole paragraphs fade in instead of the text jumping.') },
      { icon: 'i-retry', title: () => t('Long work keeps going'), text: () => t('A fresh turn now keeps every tool result and never runs a command twice.') },
      { icon: 'i-agents', title: () => t('Sub-agents start reliably'), text: () => t('Also on a slow computer, and with a second browser that is not updated yet.') }
    ]
  },
  '2.1.41': {
    lead: () => t('Edit your earlier messages, branch a chat, and sub-agents that start every time.'),
    highlights: [
      { icon: 'i-pencil', title: () => t('Edit your messages'), text: () => t('Change an earlier message and continue from it; what it replaces folds away, nothing is lost.') },
      { icon: 'i-git-branch', title: () => t('Branch in new chat'), text: () => t('Continue from any answer in a new chat, and keep the original chat exactly as it was.') },
      { icon: 'i-chat', title: () => t('Inbox sidebar'), text: () => t('Optional: all your chats together, active ones first. Under Appearance → Sidebar layout.') },
      { icon: 'i-agents', title: () => t('Sub-agents that start'), text: () => t('Reliable on a busy computer; one that starts late rejoins its run.') }
    ]
  },
  '2.1.40': {
    lead: () => t('Projects on a server, Skills and files anywhere in the composer, and a repair for Mac permissions.'),
    highlights: [
      { icon: 'i-terminal', title: () => t('Projects on a server'), text: () => t('Add a folder over SSH; ChatGPT reads, edits and runs commands there with your own SSH setup.') },
      { icon: 'i-skill', title: () => t('/ and @ anywhere'), text: () => t('Pick a Skill with / or a project file with @ at any point in a message.') },
      { icon: 'i-lock', title: () => t('Mac permissions repaired'), text: () => t('If an update left Desktop access broken on a Mac, one click repairs it.') },
      { icon: 'i-plug', title: () => t('Prefer Plugins'), text: () => t('If you like, messages the app sends use your Plugins app instead of Core.') }
    ]
  },
  '2.1.39': {
    lead: () => t('Fresh turns that work while ChatGPT thinks, and a fuller diagnostics report.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Fresh turns that hold'), text: () => t('Long work now also continues in a fresh turn while ChatGPT is thinking or running a tool.') },
      { icon: 'i-browser', title: () => t('No chats in incognito'), text: () => t('Chats the app opens go to your regular browser window, never an incognito one.') },
      { icon: 'i-check-circle', title: () => t('A fuller diagnostics report'), text: () => t('It also shows how the app is installed, the browser, crashes, frequent warnings and each chat\'s state, still without anything personal.') }
    ]
  },
  '2.1.38': {
    lead: () => t('Firefox, fresh turns for long work, and approvals you answer in the app.'),
    highlights: [
      { icon: 'i-globe', title: () => t('Firefox'), text: () => t('Choose Firefox as the ChatGPT browser. Its add-on is signed by Mozilla and updates itself.') },
      { icon: 'i-retry', title: () => t('Fresh turns for long work'), text: () => t('Long work continues in a fresh turn every 30 minutes, so it no longer breaks after about 40 minutes.') },
      { icon: 'i-check-circle', title: () => t('Approvals in the app'), text: () => t('Answer ChatGPT\'s tool approval cards with Deny or Allow once, right in the app.') },
      { icon: 'i-arrow-down', title: () => t('Update all'), text: () => t('Activity shows the app, the extension and each plugin with its status, and one button updates them.') },
      { icon: 'i-chart', title: () => t('Codex and Claude Code in Usage'), text: () => t('See Codex\'s limits and the tokens Codex and Claude Code used, and ask for your usage in a chat.') }
    ]
  },
  '2.1.37': {
    lead: () => t('Find in chat, slash commands, and messages that go where you want.'),
    highlights: [
      { icon: 'i-search', title: () => t('Find in chat'), text: () => t('{0} searches the whole chat, older messages included.', [primaryShortcut('F')]) },
      { icon: 'i-terminal', title: () => t('Slash commands'), text: () => t('Type / in the message box to pick a model, rename or pin the chat, see its status and more.') },
      { icon: 'i-bolt', title: () => t('Send now'), text: () => t('A queued message can join the running answer right away, and you choose what Enter does.') },
      { icon: 'i-check-circle', title: () => t('Told when a chat finishes'), text: () => t('A notification when a chat is done while the app is in the background, and the computer stays awake while it works.') },
      { icon: 'i-agents', title: () => t('Worker chats out of the way'), text: () => t('Turn it on, and worker chats are archived in ChatGPT once the app is done with them.') }
    ]
  },
  '2.1.36': {
    lead: () => t('Steadier long runs, a tunnel that works behind a proxy, and ChatGPT\'s own words.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Steadier long runs'), text: () => t('Chats recover more reliably, also after your computer sleeps, and the timeline keeps a long turn in order.') },
      { icon: 'i-globe', title: () => t('Works behind a proxy'), text: () => t('The tunnel to ChatGPT uses your system\'s proxy by itself.') },
      { icon: 'i-chat', title: () => t('Better dictation on Windows'), text: () => t('Dictation uses Windows\' own speech recognition, with punctuation and much better accuracy.') },
      { icon: 'i-plug', title: () => t('Plugins, as ChatGPT calls them'), text: () => t('The app now says plugin, like ChatGPT, and plugins with many tools can be installed.') },
      { icon: 'i-terminal', title: () => t('Start chats from your own tools'), text: () => t('The Local control API can start a new chat and send its events as they happen.') }
    ]
  },
  '2.1.35': {
    lead: () => t('ChatGPT Projects for your projects, workers in their own Git copy, and steadier long runs.'),
    highlights: [
      { icon: 'i-folder', title: () => t('Projects in ChatGPT'), text: () => t('New projects get their own ChatGPT Project, and their new chats open inside it.') },
      { icon: 'i-browser', title: () => t('Background chats in a tab group'), text: () => t('Background chats can stay in one collapsed tab group in your browser window instead of their own window.') },
      { icon: 'i-git-diff', title: () => t('Workers in their own Git copy'), text: () => t('When you turn it on, each new worker gets its own Git worktree and branch, away from your checkout.') },
      { icon: 'i-chat', title: () => t('Dictation on Windows'), text: () => t('The microphone button turns your speech into text in the message box, and you send it when you\'re ready.') },
      { icon: 'i-plug', title: () => t('Rename your plugins'), text: () => t('Chat On Steroids apps you rename in ChatGPT keep working.') }
    ]
  },
  '2.1.34': {
    lead: () => t('Goal on every plan, Compact & Resume in Projects, and a background window that stays.'),
    highlights: [
      { icon: 'i-target', title: () => t('Goal on every plan'), text: () => t('On plans without a model picker, such as Free, Goal and Loop follow-ups use the chat\'s current model instead of failing.') },
      { icon: 'i-steps', title: () => t('Compact & Resume in Projects'), text: () => t('Moving a chat inside a ChatGPT Project to a new chat now completes, and the new chat stays in that Project.') },
      { icon: 'i-browser', title: () => t('A background window that stays'), text: () => t('Background chats keep using the same window after the extension updates or reloads.') },
      { icon: 'i-plug', title: () => t('Clearer plugin hints'), text: () => t('When ChatGPT calls a tool its plugin doesn\'t have, the result names the plugin that has it.') },
      { icon: 'i-terminal', title: () => t('Fewer repeated commands'), text: () => t('When ChatGPT starts a command that is still running in that chat, the result points it to the running one.') }
    ]
  },
  '2.1.33': {
    lead: () => t('Reuse a saved summary, see why a message waits, and a background window that follows you.'),
    highlights: [
      { icon: 'i-steps', title: () => t('Reuse a saved summary'), text: () => t('If Compact & Resume stops after ChatGPT wrote its summary, open the new chat with that summary instead of starting over.') },
      { icon: 'i-clock', title: () => t('See why a message waits'), text: () => t('A queued message says when it is waiting for the browser extension or for a running tool call.') },
      { icon: 'i-browser', title: () => t('The background window follows you'), text: () => t('With Background chats on, the chat you select in the app is the one its background window shows.') },
      { icon: 'i-retry', title: () => t('Calmer when ChatGPT is busy'), text: () => t('When ChatGPT limits how fast history loads, recovery waits as long as ChatGPT asks instead of reloading again.') },
      { icon: 'i-bolt', title: () => t('Lighter on your computer'), text: () => t('Open ChatGPT chats use much less CPU while they wait.') }
    ]
  },
  '2.1.32': {
    lead: () => t('Messages that reach the running answer, the choices ChatGPT asks you about, and a Stop that sticks.'),
    highlights: [
      { icon: 'i-bolt', title: () => t('Messages reach the running answer'), text: () => t('Send directly puts your message into the running answer as a real ChatGPT message, even while a command runs, and the command keeps its result.') },
      { icon: 'i-check-circle', title: () => t("ChatGPT's choices in the timeline"), text: () => t('When ChatGPT asks you to pick an option, the timeline shows the question and its choices.') },
      { icon: 'i-ban', title: () => t('A Stop that sticks'), text: () => t('Stop ends the turn even when a late tool result reopens it, and the timeline says when it stopped.') },
      { icon: 'i-chart', title: () => t('A clearer Usage page'), text: () => t('Whole token counts, a lower bound for costs without a price, and the newest weeks of activity first.') },
      { icon: 'i-skill', title: () => t('Skills in your language'), text: () => t('The recommended skills describe themselves in the language of the app.') }
    ]
  },
  '2.1.31': {
    lead: () => t('GPT-6 support, a timeline that reads like ChatGPT, and a clearer view of your sub-agents.'),
    highlights: [
      { icon: 'i-sparkle', title: () => t('Ready for GPT-6'), text: () => t('Pick GPT-6, GPT-5.6 or GPT-5.5 with Instant, Medium or High. Goal, Loop and Compact & Resume work on GPT-6.') },
      { icon: 'i-steps', title: () => t('A timeline in rounds'), text: () => t("Each turn reads in rounds like ChatGPT's own, with the model's notes between steps, a live status line and formulas.") },
      { icon: 'i-agents', title: () => t('A clearer sub-agent list'), text: () => t('Each worker is named for its job and shows its task, its state and its model.') },
      { icon: 'i-lock', title: () => t('Setup asks what ChatGPT may do'), text: () => t('The same permission switches as in Workspace, and Setup tells you when access is limited.') },
      { icon: 'i-panel-right', title: () => t('Panels in the title bar'), text: () => t('The panel buttons moved to the title bar, and the right panel now runs the full height of the window.') }
    ]
  },
  '2.1.30': {
    lead: () => t('See what changed after each update, and long runs that stop and recover more calmly.'),
    highlights: [
      { icon: 'i-sparkle', title: () => t("What's new, after every update"), text: () => t('A short summary like this one shows once after each update, with a link to the full notes.') },
      { icon: 'i-retry', title: () => t('Clear stops for stuck messages'), text: () => t('If ChatGPT never picks up a queued message, the app tries three times, then tells you and keeps it queued.') },
      { icon: 'i-agents', title: () => t('Steadier sub-agents'), text: () => t('New worker tabs get more time on slow connections, and a worker no longer gets stuck behind its own unsent message.') },
      { icon: 'i-gear', title: () => t('Your settings stay put'), text: () => t("A settings file the app can't read no longer resets everything: the app reads it anyway or keeps a copy.") },
      { icon: 'i-loop', title: () => t('Recovery stays on'), text: () => t("When the app reuses a quiet chat's tab for a new chat, that chat keeps its automatic recovery.") }
    ]
  },
  '2.1.29': {
    lead: () => t('Pin your chats, search from anywhere, and know when ChatGPT is waiting for you.'),
    highlights: [
      { icon: 'i-pin', title: () => t('Pin chats'), text: () => t('Keep the chats you use most at the top of the sidebar.') },
      { icon: 'i-more', title: () => t('One menu for every chat'), text: () => t("Pin, rename, open or copy a chat's link from its ⋯ menu.") },
      { icon: 'i-search', title: () => t('Search from anywhere'), text: () => t('{0} finds any chat and opens it at the message that matched.', [primaryShortcut('K')]) },
      { icon: 'i-gear', title: () => t('Search your settings'), text: () => t('Type in Settings to find any setting on any page.') },
      { icon: 'i-lock', title: () => t('Know when ChatGPT is waiting'), text: () => t('When ChatGPT asks you to allow a tool, the chat tells you instead of standing still.') },
      { icon: 'i-plug', title: () => t('One connection control'), text: () => t('A small capsule in the sidebar shows the connection and tells you if it drops.') }
    ]
  }
};

export function hasHighlights(version: string): boolean {
  return Object.hasOwn(RELEASES, version);
}

/** Paints the dialog for one version; separate from showing it so a check can paint any entry. */
export function paintWhatsNew(version: string): boolean {
  const release = RELEASES[version];
  if (!release) return false;
  ui($('whatsNewVersion'), 'textContent', () => t('Version {0}', [version]));
  ui($('whatsNewLead'), 'textContent', release.lead);
  $('whatsNewList').replaceChildren(...release.highlights.map((item, index) => {
    const row = el('li', 'whats-new-item');
    // The rows arrive one after another, after the card and its tile.
    row.style.setProperty('--i', String(index));
    const badge = el('span', 'whats-new-icon');
    badge.append(icon(item.icon));
    const words = el('div', 'whats-new-words');
    words.append(el('b', '', item.title), el('span', '', item.text));
    row.append(badge, words);
    return row;
  }));
  $<HTMLButtonElement>('whatsNewNotes').dataset.version = version;
  return true;
}

/**
 * Centred in a window of odd width or height, the dialog starts half a pixel off the pixel grid
 * and every icon in it blurs and drifts by that half pixel. Its own size is whole pixels, so
 * whole-pixel margins keep it centred within half a pixel and crisp. Margins, not a transform:
 * a fractional transform rasterises the glyphs off the grid all the same.
 */
function snapToPixels(dialog: HTMLDialogElement): void {
  if (!dialog.open) return;
  const x = (window.innerWidth - dialog.offsetWidth) / 2;
  const y = (window.innerHeight - dialog.offsetHeight) / 2;
  dialog.style.margin = x < 0 || y < 0 ? '' : `${Math.floor(y)}px ${Math.ceil(x)}px ${Math.ceil(y)}px ${Math.floor(x)}px`;
}

let wired = false;
function wire(dialog: HTMLDialogElement): void {
  if (wired) return;
  wired = true;
  window.addEventListener('resize', () => snapToPixels(dialog));
  const close = (): void => {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.add('is-closing');
    const done = (): void => { dialog.classList.remove('is-closing'); if (dialog.open) dialog.close(); };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else { dialog.addEventListener('animationend', done, { once: true }); window.setTimeout(done, 280); }
  };
  $('whatsNewDone').addEventListener('click', close);
  $('whatsNewNotes').addEventListener('click', () => {
    const version = $<HTMLButtonElement>('whatsNewNotes').dataset.version;
    if (version) void run(window.api.openLink(releaseNotesUrl(version), { external: true }));
  });
  // Escape and a click on the backdrop dismiss it like the button does, with the same motion.
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
}

/**
 * Decides once per start: shows the dialog after a real update to a version with highlights and
 * records the version once it has been shown, so it never shows twice; any other version change is
 * recorded at once. A fresh install has already recorded
 * its version in the main process, before anything here runs.
 */
export function initWhatsNew(current: string | null, lastSeen: string | undefined): void {
  if (!current) return;
  const action = whatsNewAction(current, lastSeen, hasHighlights);
  if (action === 'none') return;
  if (action !== 'show' || !paintWhatsNew(current)) { void run(window.api.markWhatsNewSeen()); return; }
  const dialog = $<HTMLDialogElement>('whatsNewDialog');
  wire(dialog);
  // After the window has painted its first state, so the dialog opens over a settled app. Another
  // open dialog wins; the version is recorded only once this one has really been shown.
  window.setTimeout(() => {
    if (dialog.open || document.querySelector('dialog[open]')) return;
    dialog.showModal();
    snapToPixels(dialog);
    // Enter answers it at once; the focus ring appears only once the keyboard is used.
    $('whatsNewDone').focus({ focusVisible: false } as FocusOptions);
    void run(window.api.markWhatsNewSeen());
  }, 600);
}
