import { isNewer, type AppState, type ChatBrowser } from '../shared/types.js';
import { $, run } from './dom.js';
import { onLanguageChange, t, ui } from './i18n.js';
import { extensionPicture, quoted, renderExtensionPicture } from './extension-pictures.js';

type ExternalBrowser = Exclude<ChatBrowser, 'cos'>;
const icons = {
  chrome: new URL('./browser-icons/chrome.svg', import.meta.url).href,
  edge: new URL('./browser-icons/edge.svg', import.meta.url).href,
  brave: new URL('./browser-icons/brave.svg', import.meta.url).href,
  firefox: new URL('./browser-icons/firefox.svg', import.meta.url).href
};
const LABELS: Record<ExternalBrowser, string> = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave', firefox: 'Firefox' };

/** signedIn: ChatGPT surely has an account there. done adds that it is connected to this app. */
type Login = { done: boolean; signedIn: boolean; text(): string };

/**
 * Whether ChatGPT is signed in where it runs. Each path asks only its own browser: the built-in
 * browser's cookie jar and its own copy of the extension, or ChatGPT's answer in Chrome, Edge or
 * Brave. Being signed in on the other one changes nothing. Yes, no and "not known" stay apart, so
 * the status never claims a sign-out it did not see.
 */
export function signInState(state: AppState, where: ChatBrowser, live: boolean,
  proof: { signedIn: boolean | null } | null): Login {
  if (where === 'cos') {
    const signedIn = state.cosBrowserSignedIn ?? null;
    // Any extension is not enough: Chrome's would answer for a CoS browser that is not connected.
    const connected = state.bridge.cosExtension?.present === true;
    if (signedIn === null) return { done: false, signedIn: false, text: () => t('Starting the built-in browser…') };
    if (!signedIn) return { done: false, signedIn: false, text: () => t('Not signed in yet.') };
    return connected ? { done: true, signedIn: true, text: () => t('Signed in. ChatGPT is connected.') }
      : { done: false, signedIn: true, text: () => t('Signed in. Connecting to ChatGPT…') };
  }
  const label = LABELS[where];
  // ChatGPT's own answer while a tab is open there wins, so signing in or out shows at once. With
  // no tab, or the browser closed, the last answer stands in: a logout stays a logout.
  const liveAnswer = live ? state.bridge.externalExtension?.signedIn ?? null : null;
  const answer = liveAnswer !== null ? liveAnswer : proof?.signedIn ?? null;
  if (answer === false) return { done: false, signedIn: false, text: () => t('Not signed in to ChatGPT in {0}.', [label]) };
  if (answer === true) return { done: true, signedIn: true, text: () => live ? t('Signed in. ChatGPT is connected.') : t('Signed in.') };
  return { done: false, signedIn: false, text: () => t('Open ChatGPT in {0} to check the sign-in.', [label]) };
}

/** Presentation only. The bridge owns connection evidence; Settings owns where ChatGPT runs. */
export function initBrowserSetup(actions: {
  choose(browser: ChatBrowser): void;
  repaint(): void;
  open(browser: ExternalBrowser, page: 'extensions' | 'chatgpt'): Promise<unknown>;
}): { render(state: AppState): { ready: boolean; choosingLocation: boolean } } {
  let current: AppState | null = null;
  let phase: 'extension' | 'location' = 'extension';
  /**
   * Until the person moves between the two parts themselves, the part on screen follows the facts:
   * install while the extension is not there, then on to where ChatGPT runs once it is, also
   * when that happens while they watch. A launch whose first state arrives before the bridge is
   * up still lands in the right place.
   */
  let steered = false;
  let external: ExternalBrowser = 'chrome';
  let initialized = false;
  let savedBrowser: ChatBrowser | null = null;
  let ready = false;

  let copiedAt = 0;
  /**
   * The install steps in the words and pictures of the chosen browser, in the app's language: its own
   * labels for Developer mode and Load unpacked, and where they are on its page. Repainted on a
   * language change through ui(), like every other text.
   */
  const paintInstallSteps = (label: string): void => {
    // Firefox installs the signed add-on from this version's release: no Developer mode, no folder.
    const gecko = external === 'firefox';
    for (const step of $('browserExtensionStage').querySelectorAll<HTMLElement>('[data-install-engine]')) {
      step.hidden = step.dataset.installEngine !== (gecko ? 'gecko' : 'chromium');
    }
    $('browserExtensionStage').querySelector<HTMLElement>('.extension-help')!.hidden = gecko;
    ui($('extensionStepChatGpt'), 'textContent', () => t('Open ChatGPT in {0}', [label]));
    if (external === 'firefox') return;
    const chromium = external;
    ui($('extensionStepOpen'), 'textContent', () => t('Open the extensions page in {0}', [label]));
    ui($('extensionStepOpenHint'), 'textContent', () => Date.now() - copiedAt < 60_000
      ? t('Copied. Paste it into the address bar in {0} and press Enter.', [label])
      : t('Click the address to copy it, then paste it into the address bar in {0} and press Enter.', [label]));
    ui($('extensionStepDev'), 'textContent', () => {
      const picture = extensionPicture(chromium, 'dev');
      return t('Turn on {0}', [quoted(picture?.label ?? t('Developer mode'))]);
    });
    const where = $('extensionStepDevWhere');
    where.hidden = external !== 'edge';
    ui(where, 'textContent', () => external === 'edge' ? t('Edge shows it at the bottom of the left sidebar. In a narrow window, open the ☰ menu first.') : '');
    ui($('extensionStepLoad'), 'textContent', () => {
      const picture = extensionPicture(chromium, 'load');
      return t('Click {0} and choose the extension folder', [quoted(picture?.label ?? t('Load unpacked'))]);
    });
    const paintPictures = (): void => {
      const dev = extensionPicture(chromium, 'dev');
      const load = extensionPicture(chromium, 'load');
      renderExtensionPicture($('extensionPictureDev'), dev, t('The extensions page in {0}, with {1} outlined', [label, quoted(dev?.label ?? t('Developer mode'))]));
      renderExtensionPicture($('extensionPictureLoad'), load, t('The extensions page in {0}, with {1} outlined', [label, quoted(load?.label ?? t('Load unpacked'))]));
    };
    paintPictures();
  };
  // The pictures show the browser in the app's language, so a language change repaints them.
  onLanguageChange(() => { if (current) render(current); });

  const render = (state: AppState): { ready: boolean; choosingLocation: boolean } => {
    current = state;
    const browser = state.config.ui.chatBrowser ?? 'chrome';
    if (!initialized || browser !== savedBrowser) {
      if (browser !== 'cos') external = browser;
      initialized = true;
      savedBrowser = browser;
    }
    // Installed: the extension in the person's own browser, in a version this app expects. A live
    // sighting wins; with that browser closed, the lasting proof stands in, because the built-in
    // browser does not need Chrome open once signed in. A live old version always asks to update.
    const observation = state.bridge.externalExtension;
    const proof = observation?.proof ?? null;
    const live = observation?.present === true;
    const shownVersion = live ? observation!.version : proof?.version ?? null;
    const knownVersion = !!shownVersion && /^\d+\.\d+\.\d+$/.test(shownVersion);
    const outdated = knownVersion && isNewer(state.update.current, shownVersion!);
    // The browser keeps the extension off chatgpt.com (site access "On click", a revoked Firefox
    // permission): it can pair, but nothing could ever run on a ChatGPT page.
    const blocked = live && observation?.chatgptAccess === false;
    ready = state.bridge.running && state.bridge.paired && (live || proof !== null) && knownVersion && !outdated && !blocked;
    if (!steered) phase = ready ? 'location' : 'extension';
    const cos = browser === 'cos';
    $('browserExtensionStage').hidden = phase !== 'extension';
    $('browserLocationStage').hidden = phase !== 'location';
    $('browserPhaseExtension').setAttribute('aria-current', phase === 'extension' ? 'step' : 'false');
    $('browserPhaseLocation').setAttribute('aria-current', phase === 'location' ? 'step' : 'false');
    $('browserPhaseExtension').classList.toggle('is-complete', ready);
    $<HTMLButtonElement>('browserContinue').disabled = !ready;
    $('browserConnectionLost').hidden = ready;
    for (const segment of document.querySelectorAll<HTMLButtonElement>('[data-external-browser]')) {
      const selected = segment.dataset.externalBrowser === external;
      segment.setAttribute('aria-checked', String(selected));
      segment.tabIndex = selected ? 0 : -1;
    }
    for (const option of document.querySelectorAll<HTMLButtonElement>('[data-browser-choice]')) {
      const selected = option.dataset.browserChoice === (cos ? 'cos' : 'extension');
      option.setAttribute('aria-checked', String(selected));
      option.tabIndex = selected ? 0 : -1;
    }
    for (const variant of $('browserLocationStage').querySelectorAll<HTMLElement>('[data-browser-variant]')) {
      variant.hidden = variant.dataset.browserVariant !== (cos ? 'cos' : 'extension');
    }
    $<HTMLImageElement>('setupExternalIcon').src = icons[external];
    const address = `${external}://extensions`;
    $('setupExtensionAddress').textContent = address;
    const label = LABELS[external];
    paintInstallSteps(label);
    ui($('setupExternalLabel'), 'textContent', () => t('Use {0} and your existing profile.', [label]));
    ui($('extensionStatus'), 'textContent', () => ready ? (live ? t('Extension connected and up to date') : t('Extension installed and up to date'))
      : blocked ? t('The extension may not open ChatGPT')
      : outdated ? t('Update your extension')
      : live && !knownVersion ? t('Extension version could not be verified')
      : t('Waiting for the browser extension'));
    $('extensionStatusBox').dataset.tone = ready ? 'ok' : 'wait';
    ui($('extensionSetupDetail'), 'textContent', () => ready ? ''
      : !state.secureStorage?.available && state.secureStorage ? t('Secure credential storage is unavailable, so the extension cannot pair safely.')
      : !state.bridge.running ? t('Browser bridge could not start: {0}', [state.bridge.error ?? t('Not connected yet')])
      : blocked ? t('{0} keeps the extension off chatgpt.com. In the extension’s details, allow it on chatgpt.com (“Site access” in Chrome, Edge and Brave, “Permissions” in Firefox), then reload ChatGPT.', [label])
      : outdated || (live && !knownVersion) ? t('Load the extension from this app’s folder, then reload it in your browser.')
      : '');
    $('extensionSetupDetail').hidden = !$('extensionSetupDetail').textContent;
    const login = signInState(state, browser === 'cos' ? 'cos' : external, live, proof);
    const statusNode = $(cos ? 'cosBrowserState' : 'externalBrowserState');
    ui(statusNode, 'textContent', () => login.text());
    statusNode.dataset.tone = login.done ? 'ok' : 'wait';
    // Surely signed in, the same button becomes the way out. An unknown answer keeps "Sign in",
    // which also checks.
    const button = $(cos ? 'showCosBrowser' : 'openSelectedChatGpt');
    button.dataset.signedIn = String(login.signedIn);
    button.querySelector('i')!.className = login.signedIn ? 'ico ph ph-sign-out' : 'ico ph ph-sign-in';
    ui(button.querySelector('span')!, 'textContent', () => login.signedIn ? t('Sign out of ChatGPT') : t('Sign in to ChatGPT'));
    // Done is a fact about the person's setup, not about which part of the step is on screen.
    return { ready: ready && login.done, choosingLocation: phase === 'location' };
  };
  const changePhase = (next: typeof phase): void => {
    if (next === 'location' && !ready) return;
    steered = true;
    phase = next;
    actions.repaint();
    $(next === 'extension' ? 'browserExtensionTitle' : 'browserLocationTitle').focus();
  };
  $('browserContinue').addEventListener('click', () => changePhase('location'));
  $('browserBack').addEventListener('click', () => changePhase('extension'));
  $('browserReviewExtension').addEventListener('click', () => changePhase('extension'));
  $('useCosBrowser').addEventListener('click', () => actions.choose('cos'));
  $('useExtensionBrowser').addEventListener('click', () => actions.choose(external));
  for (const segment of document.querySelectorAll<HTMLButtonElement>('[data-external-browser]')) {
    segment.addEventListener('click', () => {
      external = segment.dataset.externalBrowser as ExternalBrowser;
      if (current) render(current);
    });
  }
  // Standard radio keyboard behavior, with focus following the selected item.
  for (const group of document.querySelectorAll<HTMLElement>('.browser-setup [role="radiogroup"]')) {
    group.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const options = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
      const at = options.indexOf(document.activeElement as HTMLButtonElement);
      const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (at + delta + options.length) % options.length;
      event.preventDefault(); options[index]!.click(); options[index]!.focus();
    });
  }
  // Browsers refuse to open their own extensions page when another program asks (measured with
  // Chrome and Edge, 2026-10-12): the address is copied and the browser brought up to paste it into.
  $('openExtensionSettings').addEventListener('click', () => void (async () => {
    if (await actions.open(external, 'extensions') === false) return;
    copiedAt = Date.now();
    if (current) render(current);
  })());
  $('openFirefoxAddon').addEventListener('click', () => { void actions.open('firefox', 'extensions'); });
  $('openChatGptBrowser').addEventListener('click', () => { void actions.open(external, 'chatgpt'); });
  $('openSelectedChatGpt').addEventListener('click', event => void run(
    (event.currentTarget as HTMLElement).dataset.signedIn === 'true' ? window.api.signOutChatGpt() : window.api.openChatGpt()));
  return { render };
}
