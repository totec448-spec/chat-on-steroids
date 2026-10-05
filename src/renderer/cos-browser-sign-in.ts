/** Google sign-in card over a CoS browser tab. It only paints state from main and reports clicks. */
import { currentLanguage, setLanguage, t, type Language } from './i18n.js';

type BrowserId = 'chrome' | 'edge' | 'brave';
interface SignInState {
  phase: 'choose' | 'waiting' | 'done';
  browsers: Array<{ id: BrowserId; label: string; icon: string | null }>;
  browser: BrowserId | null;
  launching: boolean;
  notice: 'launch_failed' | 'ended' | null;
  appIcon: string | null;
  language: string;
  tokens: Record<string, string>;
}
type SignInAction = 'choose' | 'reopen' | 'back' | 'cancel';

const api = (window as unknown as {
  cosSignIn: {
    act(action: SignInAction, value?: string): void;
    onState(listener: (state: SignInState) => void): void;
    onLeave(listener: () => void): void;
  };
}).cosSignIn;

const $ = (id: string) => document.getElementById(id)!;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
let latest: SignInState | null = null;

function icon(source: string | null): HTMLElement {
  if (source) return Object.assign(document.createElement('img'), { src: source, alt: '', draggable: false });
  const glyph = document.createElement('i');
  glyph.className = 'ph ph-browser';
  glyph.setAttribute('aria-hidden', 'true');
  return glyph;
}

function paintOptions(state: SignInState): void {
  const options = state.phase === 'choose' ? state.browsers : [];
  $('options').replaceChildren(...options.map(browser => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'option';
    option.disabled = state.launching;
    option.addEventListener('click', () => api.act('choose', browser.id));
    option.append(icon(browser.icon), Object.assign(document.createElement('span'), { textContent: browser.label }));
    return option;
  }));
  $('options').hidden = options.length === 0;
}

function paint(state: SignInState): void {
  latest = state;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(state.tokens)) root.style.setProperty(name, value);
  if (state.language !== currentLanguage()) setLanguage(state.language as Language);
  document.title = t('Sign in with Google');

  const waiting = state.phase === 'waiting';
  const done = state.phase === 'done';
  const chosen = state.browsers.find(browser => browser.id === state.browser);
  // Replay the entrance of the words when the step changes; first paint has the card's own.
  const card = $('card');
  if (!card.hidden && (card.classList.contains('is-waiting') !== waiting || card.classList.contains('is-done') !== done)) {
    card.classList.remove('swap');
    void card.offsetWidth;
    card.classList.add('swap');
  }
  card.classList.toggle('is-waiting', waiting);
  card.classList.toggle('is-done', done);

  const app = $('appIcon') as HTMLImageElement;
  app.hidden = !state.appIcon;
  if (state.appIcon && app.src !== state.appIcon) app.src = state.appIcon;
  const browser = $('browserIcon') as HTMLImageElement;
  browser.hidden = !(waiting && chosen?.icon);
  if (waiting && chosen?.icon) browser.src = chosen.icon;
  $('browserGlyph').hidden = !browser.hidden;

  $('title').textContent = done ? t('You’re signed in')
    : waiting ? t('Finish signing in with {0}', [chosen?.label ?? '']) : t('Sign in with Google');
  $('lead').textContent = done ? '' : waiting ? t('When you finish, the extension brings the session here.')
    : t('Google blocks sign-in here. Continue in your browser.');
  $('lead').hidden = done;
  paintOptions(state);
  $('empty').hidden = waiting || state.browsers.length > 0;
  $('empty').textContent = t('Install Chrome, Edge or Brave with the Chat On Steroids extension, then try again.');

  $('notice').hidden = state.notice === null;
  $('notice').textContent = state.notice === 'launch_failed'
    ? t('The browser could not open. Try again or choose another one.')
    : state.notice === 'ended' ? t('The sign-in request ended. Choose a browser to start again.') : '';

  button('reopen').hidden = !waiting;
  button('back').hidden = !waiting;
  button('reopen').textContent = t('Open again');
  button('back').textContent = t('Switch browser');
  button('cancel').textContent = t('Cancel');
  $('foot').hidden = done;
  for (const id of ['reopen', 'back', 'cancel']) button(id).disabled = state.launching;
  $('card').hidden = false;
}

api.onState(paint);
api.onLeave(() => document.body.classList.add('leaving'));
button('reopen').addEventListener('click', () => api.act('reopen'));
button('back').addEventListener('click', () => api.act('back'));
button('cancel').addEventListener('click', () => api.act('cancel'));
// Clicking the dimmed page leaves the choice, as any dialog in the app; while the person signs in
// elsewhere, a stray click must not drop the request they are about to complete.
$('scrim').addEventListener('click', () => { if (latest?.phase === 'choose' && !latest.launching) api.act('cancel'); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && latest && !latest.launching) api.act('cancel');
});
