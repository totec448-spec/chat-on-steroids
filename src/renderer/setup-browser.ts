import { isNewer, type AppState, type ChatBrowser } from '../shared/types.js';
import { $, run } from './dom.js';
import { t, ui } from './i18n.js';

type ExternalBrowser = Exclude<ChatBrowser, 'cos'>;
const icons = {
  chrome: new URL('./browser-icons/chrome.svg', import.meta.url).href,
  edge: new URL('./browser-icons/edge.svg', import.meta.url).href,
  brave: new URL('./browser-icons/brave.svg', import.meta.url).href
};

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
  const label = where === 'edge' ? 'Edge' : where === 'brave' ? 'Brave' : 'Chrome';
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
    ready = state.bridge.running && state.bridge.paired && (live || proof !== null) && knownVersion && !outdated;
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
    $('setupExtensionAddress').textContent = `${external === 'edge' ? 'edge' : external === 'brave' ? 'brave' : 'chrome'}://extensions`;
    const label = external === 'edge' ? 'Edge' : external === 'brave' ? 'Brave' : 'Chrome';
    ui($('setupExternalLabel'), 'textContent', () => t('Use {0} and your existing profile.', [label]));
    ui($('extensionStatus'), 'textContent', () => ready ? (live ? t('Extension connected and up to date') : t('Extension installed and up to date'))
      : outdated ? t('Update your extension')
      : live && !knownVersion ? t('Extension version could not be verified')
      : t('Waiting for the browser extension'));
    $('extensionStatusBox').dataset.tone = ready ? 'ok' : 'wait';
    ui($('extensionSetupDetail'), 'textContent', () => ready ? ''
      : !state.secureStorage?.available && state.secureStorage ? t('Secure credential storage is unavailable, so the extension cannot pair safely.')
      : !state.bridge.running ? t('Browser bridge could not start: {0}', [state.bridge.error ?? t('Not connected yet')])
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
  for (const [id, page] of [['openExtensionSettings', 'extensions'], ['openChatGptBrowser', 'chatgpt']] as const) {
    $(id).addEventListener('click', () => { void actions.open(external, page); });
  }
  $('openSelectedChatGpt').addEventListener('click', event => void run(
    (event.currentTarget as HTMLElement).dataset.signedIn === 'true' ? window.api.signOutChatGpt() : window.api.openChatGpt()));
  return { render };
}
