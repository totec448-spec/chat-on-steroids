/**
 * The "Installing" window's page. It shows only what the main process put in its address and,
 * later, each handoff step through `cosUpdateStep`; it has no preload and asks for nothing.
 */
const query = new URLSearchParams(location.search);
const hex = (value: string | null, fallback: string): string => value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
const root = document.documentElement;
root.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
root.lang = /^[a-z]{2}(-[A-Z]{2})?$/.test(query.get('lang') ?? '') ? query.get('lang')! : 'en';
root.style.setProperty('--page', hex(query.get('background'), root.dataset.theme === 'dark' ? '#181818' : '#f4f4f5'));
root.style.setProperty('--accent', hex(query.get('accent'), root.dataset.theme === 'dark' ? '#b0cbed' : '#486f9d'));
const text = (id: string, value: string | null): void => { document.getElementById(id)!.textContent = (value ?? '').slice(0, 200); };
text('title', query.get('title'));
text('version', query.get('version'));
text('step', query.get('step'));
document.title = query.get('title')?.slice(0, 200) || 'Chat On Steroids';
(window as unknown as { cosUpdateStep: (value: string) => void }).cosUpdateStep = value => text('step', value);
