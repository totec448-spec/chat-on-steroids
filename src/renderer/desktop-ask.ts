/**
 * The ask-before-mouse-and-keyboard question (#1804). It shows only the texts the main process put
 * in its address and answers through the one call its preload offers.
 */
const query = new URLSearchParams(location.search);
const hex = (value: string | null, fallback: string): string => value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
const root = document.documentElement;
root.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
root.lang = /^[a-z]{2}(-[A-Z]{2})?$/.test(query.get('lang') ?? '') ? query.get('lang')! : 'en';
root.style.setProperty('--page', hex(query.get('background'), root.dataset.theme === 'dark' ? '#181818' : '#f4f4f5'));
root.style.setProperty('--accent', hex(query.get('accent'), root.dataset.theme === 'dark' ? '#b0cbed' : '#486f9d'));
// The app's readable ink for this background, high contrast included; the stylesheet's own as the fallback.
for (const name of ['ink', 'soft', 'edge', 'hover']) {
  const value = query.get(name);
  if (value && /^#[0-9a-f]{6}$/i.test(value)) root.style.setProperty(`--${name}`, value);
}
const text = (id: string, value: string | null): void => { document.getElementById(id)!.textContent = (value ?? '').slice(0, 200); };
for (const id of ['title', 'step', 'chat', 'go', 'notNow']) text(id, query.get(id));
document.getElementById('chat')!.hidden = !query.get('chat');
document.title = query.get('title')?.slice(0, 200) || 'Chat On Steroids';
const answer = (window as unknown as { cosAsk?: { answer(choice: 'go' | 'not-now'): void } }).cosAsk;
document.getElementById('go')!.addEventListener('click', () => answer?.answer('go'));
document.getElementById('notNow')!.addEventListener('click', () => answer?.answer('not-now'));
export {};
