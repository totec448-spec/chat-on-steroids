import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
interface DomApi {
  errors(): Array<{ text: string; recoverable: boolean; blocking?: boolean }>;
  captureComposerDraft(text: string, current?: () => boolean): { clear(): Promise<boolean>; dispose(): void; attachments(nodes: Element[]): void };
  visibleModelSelection(): { model: string; reasoningEffort?: string } | null;
  hasComposerAttachments(): boolean;
  stopGeneration(current: () => boolean): boolean;
  inspectModelSettings(current?: () => boolean, failure?: (reason: string) => void): Promise<Array<{id: string; label: string; efforts: string[]}> | null>;
  send(options?: { acceptanceTimeoutMs?: number; stillCurrent?: () => boolean }): Promise<boolean>;
  selectModelSettings(model: string | null, effort: string | null, current?: () => boolean): Promise<boolean>;
  uploadImages(images: Array<{ name: string; dataUrl: string }>, current?: () => boolean, draft?: ReturnType<DomApi['captureComposerDraft']>): Promise<boolean>;
}
let dom: JSDOM;
let document: Document;
let api: DomApi;
let box: HTMLElement;
let button: HTMLButtonElement;
beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<form><div id="prompt-textarea" contenteditable="true">Exact app prompt</div><div data-testid="composer-trailing-actions"><button type="button" aria-haspopup="menu">Medium</button><button type="button" data-testid="send-button">Send</button></div></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  document = dom.window.document;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{ width: 10, height: 10 }]; } });
  dom.window.eval(source);
  api = (dom.window as unknown as { CLF_DOM: DomApi }).CLF_DOM;
  box = document.getElementById('prompt-textarea')!;
  button = document.querySelector('[data-testid="send-button"]')!;
});
afterEach(() => { dom.window.close(); vi.useRealTimers(); });
function user(text: string) {
  const section = document.createElement('section');
  section.setAttribute('data-testid', 'conversation-turn-1');
  section.setAttribute('data-turn', 'user');
  section.setAttribute('data-turn-id', 'turn-one');
  const message = document.createElement('div');
  message.setAttribute('data-message-id', 'message-one');
  message.setAttribute('data-message-author-role', 'user');
  message.textContent = text;
  section.append(message); document.body.append(section);
}

describe('one native Send and bounded acceptance observation', () => {
  it('recognizes the live Stop answering composer-submit control without treating Start Voice as Stop', () => {
    button.dataset.testid = 'composer-submit-button'; button.setAttribute('aria-label', 'Stop answering');
    const clicked = vi.fn(); button.addEventListener('click', clicked);
    expect(api.stopGeneration(() => true)).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    button.setAttribute('aria-label', 'Start Voice');
    expect(api.stopGeneration(() => true)).toBe(false);
  });
  it.each(['Remove file:', 'Remove file 1:'])('recognizes %s attachment-only drafts before helper cleanup', (label) => {
    box.textContent = '';
    expect(api.hasComposerAttachments()).toBe(false);
    const tile = document.createElement('button'); tile.setAttribute('aria-label', `${label} user.webp`);
    document.querySelector('form')!.append(tile);
    expect(api.hasComposerAttachments()).toBe(true);
    tile.remove();
    const upload = document.createElement('span'); upload.setAttribute('data-inline-file-uploading', '');
    document.querySelector('form')!.append(upload);
    expect(api.hasComposerAttachments()).toBe(true);
  });
  it('stops only a visible enabled native control while exact ownership remains current', () => {
    button.dataset.testid = 'stop-button';
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    expect(api.stopGeneration(() => false)).toBe(false);
    button.disabled = true;
    expect(api.stopGeneration(() => true)).toBe(false);
    button.disabled = false; button.hidden = true;
    expect(api.stopGeneration(() => true)).toBe(false);
    button.hidden = false;
    let checks = 0;
    expect(api.stopGeneration(() => ++checks === 1)).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(api.stopGeneration(() => true)).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });
  it('accepts a composer clear after the old 3-second deadline without sending twice', async () => {
    const clicks = vi.fn(() => dom.window.setTimeout(() => { box.textContent = ''; }, 3200));
    button.addEventListener('click', clicks);
    const result = api.send();
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(3100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('times out once after 30 seconds and refuses an already disabled Send', async () => {
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    const result = api.send({ acceptanceTimeoutMs: Infinity });
    await vi.advanceTimersByTimeAsync(30000);
    expect(await result).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
    button.disabled = true;
    expect(await api.send()).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('allows fresh conversation assignment only with a new exact user message', async () => {
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      user('Exact app prompt');
    });
    expect(await api.send()).toBe(true);
  });

  it('does not accept navigation to an unrelated conversation with an empty composer', async () => {
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      box.textContent = ''; user('An unrelated user message');
    });
    const result = api.send({ acceptanceTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });

  it('fails closed when target ownership is revoked before late acceptance', async () => {
    let current = true;
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    const result = api.send({ stillCurrent: () => current });
    current = false; box.textContent = '';
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('does not retarget an existing conversation even when the new page contains matching text', async () => {
    dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff' });
      user('Exact app prompt');
    });
    expect(await api.send()).toBe(false);
  });

  it('does not confuse missing word boundaries with exact submitted text', async () => {
    box.textContent = 'a b';
    button.addEventListener('click', () => user('ab'));
    const result = api.send({ acceptanceTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });

  it('preserves adjacent rich-editor paragraphs when matching the submitted message', async () => {
    box.innerHTML = '<p>first line</p><p>second line</p>';
    button.addEventListener('click', () => user('first line\nsecond line'));
    expect(await api.send()).toBe(true);
  });

  it('does not mistake a remounted historical message for the newly submitted prompt', async () => {
    user('Exact app prompt');
    button.addEventListener('click', () => {
      document.querySelector('section')!.remove();
      user('Exact app prompt');
    });
    const result = api.send({ acceptanceTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });
});

function picker() {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup]')!;
  const container = document.createElement('div');
  container.setAttribute('data-testid', 'composer-intelligence-picker-content');
  container.innerHTML = '<button type="button" role="menuitem" aria-label="Select model">Select model</button><button type="button" role="menuitemradio" aria-checked="false">GPT Example</button><button type="button" role="menuitem" aria-label="Power" aria-describedby="power-description">Power</button><span id="power-description">Medium, 2 of 5</span>';
  // Native Radix model radio rows activate on Enter; jsdom has no keyboard default action.
  container.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (event.key === 'Enter' && target.getAttribute('role') === 'menuitemradio') target.click();
  });
  trigger.addEventListener('keydown', event => { if (event.key === 'Enter') document.body.append(container); });
  return { container, radio: container.querySelector('[role="menuitemradio"]')!, power: container.querySelector('[aria-label="Power"]')!, description: container.querySelector('span')! };
}
describe('actual visible model and reasoning selection', () => {
  it('recognizes only the visible provider access-limit dialog as a blocking nontransport error', () => {
    const notice = document.createElement('div');
    notice.innerHTML = '<h2>Too many requests</h2><p>We have temporarily limited access to conversations to protect your data. Please wait a few minutes.</p>';
    document.body.append(notice);
    expect(api.errors()).toEqual([]);
    notice.setAttribute('role', 'dialog');
    expect(api.errors()).toEqual([expect.objectContaining({ blocking: true, recoverable: false, text: expect.stringContaining('Too many requests') })]);
    notice.querySelector('p')!.setAttribute('role', 'alert');
    expect(api.errors()).toHaveLength(1);
    notice.setAttribute('aria-hidden', 'true'); expect(api.errors()).toEqual([]);
    notice.querySelector('p')!.removeAttribute('role');
    notice.removeAttribute('aria-hidden'); notice.querySelector('p')!.textContent = 'An article about rate limits';
    expect(api.errors()).toEqual([]);
  });
  it('observes only a visible checked model without opening or changing the picker', () => {
    const controls = picker();
    controls.radio.textContent = 'GPT-6 Pro'; controls.radio.setAttribute('aria-checked', 'true');
    expect(api.visibleModelSelection()).toBeNull();
    document.body.append(controls.container);
    expect(api.visibleModelSelection()).toMatchObject({ model: 'GPT-6 Pro' });
    controls.radio.setAttribute('aria-checked', 'false');
    expect(api.visibleModelSelection()).toBeNull();
    controls.radio.setAttribute('aria-checked', 'true'); controls.container.setAttribute('aria-hidden', 'true');
    expect(api.visibleModelSelection()).toBeNull();
  });
  it('finds the model outside a nested voice wrapper with description children', async () => {
    const controls = picker();
    button.remove();
    const trailing = document.querySelector('[data-testid="composer-trailing-actions"]')!;
    trailing.removeAttribute('data-testid');
    trailing.className = 'flex items-center gap-1 [grid-area:trailing]';
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<div><button type="button" aria-label="Start Voice">Voice</button><span>Voice description</span></div>';
    trailing.append(wrapper);
    controls.radio.setAttribute('aria-checked', 'true');
    expect(await api.selectModelSettings('gpt-example', 'medium')).toBe(true);
    expect(document.querySelector('[data-testid="composer-intelligence-picker-content"]')).not.toBeNull();
  });

  it('expands collapsed model rows even when they retain layout rectangles', async () => {
    const controls = picker();
    const toggle = controls.container.querySelector('[aria-label="Select model"]')!;
    toggle.setAttribute('aria-expanded', 'false');
    const expanded = vi.fn(() => toggle.setAttribute('aria-expanded', 'true'));
    toggle.addEventListener('click', expanded);
    controls.radio.addEventListener('click', () => {
      if (toggle.getAttribute('aria-expanded') !== 'true') return;
      controls.radio.setAttribute('aria-checked', 'true');
      toggle.setAttribute('aria-expanded', 'false');
    });
    expect(await api.selectModelSettings('gpt-example', null)).toBe(true);
    expect(expanded).toHaveBeenCalledTimes(2);
    expect(controls.radio.getAttribute('aria-checked')).toBe('true');
  });

  it('requires checked model evidence and moves effort independently without selecting Pro', async () => {
    const controls = picker();
    const selected = vi.fn(() => controls.radio.setAttribute('aria-checked', 'true'));
    controls.radio.addEventListener('click', selected);
    const keys: string[] = [];
    controls.power.addEventListener('keydown', event => {
      keys.push((event as KeyboardEvent).key);
      const position = Number(controls.description.textContent!.match(/(\d) of/)![1]) + ((event as KeyboardEvent).key === 'ArrowRight' ? 1 : -1);
      controls.description.textContent = `${['Instant', 'Medium', 'High', 'Extra High', 'Pro'][position - 1]}, ${position} of 5`;
    });
    expect(await api.selectModelSettings('gpt-example', 'high')).toBe(true);
    expect(selected).toHaveBeenCalledTimes(2);
    expect(keys).toEqual(['ArrowLeft', 'ArrowRight', 'ArrowRight']);
  });

  it.each([false, true])('keeps already-selected High and refuses it when unavailable (%s)', async (unavailable) => {
    const controls = picker();
    controls.radio.setAttribute('aria-checked', 'true');
    controls.description.textContent = `High, 3 of 5.${unavailable ? ' Upgrade required.' : ''}`;
    const changedPower = vi.fn(); controls.power.addEventListener('keydown', changedPower);
    expect(await api.selectModelSettings('gpt-example', 'high')).toBe(!unavailable);
    expect(changedPower).not.toHaveBeenCalled();
  });

  it('targets the nested Power slider rather than the surrounding menu item', async () => {
    const controls = picker();
    const slider = document.createElement('span');
    slider.setAttribute('role', 'slider'); slider.tabIndex = 0;
    controls.power.append(slider);
    let position = 2;
    slider.addEventListener('keydown', event => {
      event.stopPropagation();
      position += (event as KeyboardEvent).key === 'ArrowRight' ? 1 : -1;
      controls.description.textContent = `${['Instant', 'Medium', 'High', 'Extra High', 'Pro'][position - 1]}, ${position} of 5`;
    });
    expect(await api.selectModelSettings(null, 'high')).toBe(true);
    expect(position).toBe(3);
  });

  it('fails when a model click never becomes checked and refuses unsupported effort', async () => {
    picker();
    const result = api.selectModelSettings('gpt-example', null);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toBe(false);
    expect(await api.selectModelSettings(null, 'ultra')).toBe(false);
  });

  it('does not click a picker after target ownership is lost', async () => {
    const controls = picker();
    const clicked = vi.fn(); controls.radio.addEventListener('click', clicked);
    expect(await api.selectModelSettings('gpt-example', 'high', () => false)).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
  });
});

function upload() {
  const input = document.createElement('input');
  input.id = 'upload-photos'; input.type = 'file'; input.accept = 'image/*';
  Object.defineProperty(input, 'files', { writable: true, value: [] });
  document.querySelector('form')!.append(input);
  class Transfer {
    files: File[] = [];
    items = { add: (file: File) => { this.files.push(file); } };
  }
  Object.defineProperty(dom.window, 'DataTransfer', { value: Transfer });
  return input;
}
describe('native image readiness', () => {
  it('withdraws only the exact prepared app text and ready attachment nodes before Send', async () => {
    const input = upload();
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    const draft = api.captureComposerDraft('Exact app prompt');
    const tile = document.createElement('button'); tile.type = 'button'; tile.setAttribute('aria-label', 'Remove file 1: app.webp');
    tile.addEventListener('click', () => tile.remove());
    input.addEventListener('change', () => document.querySelector('form')!.append(tile));
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }], () => true, draft)).toBe(true);
    expect(await draft.clear()).toBe(true);
    expect(tile.isConnected).toBe(false); expect(box.textContent).toBe(''); draft.dispose();
  });
  it.each(['edited text', 'extra attachment', 'replacement attachment', 'navigation'])('preserves the entire draft after %s breaks exact ownership', async reason => {
    const input = upload();
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    let current = true;
    const draft = api.captureComposerDraft('Exact app prompt', () => current);
    const tile = document.createElement('button'); tile.type = 'button'; tile.setAttribute('aria-label', 'Remove file 1: app.webp');
    const removed = vi.fn(); tile.addEventListener('click', removed);
    input.addEventListener('change', () => document.querySelector('form')!.append(tile));
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }], () => current, draft)).toBe(true);
    if (reason === 'edited text') box.textContent += ' user change';
    if (reason === 'extra attachment') tile.after(tile.cloneNode(true));
    if (reason === 'replacement attachment') tile.replaceWith(tile.cloneNode(true));
    if (reason === 'navigation') current = false;
    expect(await draft.clear()).toBe(false);
    expect(removed).not.toHaveBeenCalled(); expect(box.textContent).not.toBe(''); draft.dispose();
  });
  it.each(['Remove file:', 'Remove file 1:'])('waits for matching %s attachment and upload completion before Send', async (label) => {
    const input = upload();
    const tile = document.createElement('button'); tile.type = 'button';
    tile.setAttribute('aria-label', `${label} example.webp`); tile.setAttribute('aria-busy', 'true');
    input.addEventListener('change', () => document.querySelector('form')!.append(tile));
    const result = api.uploadImages([{ name: 'example.webp', dataUrl: 'data:image/webp;base64,YQ==' }]);
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    tile.removeAttribute('aria-busy');
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
  });

  it('rejects invalid attachments before changing the native file input', async () => {
    const input = upload(); const changed = vi.fn(); input.addEventListener('change', changed);
    expect(await api.uploadImages([{ name: 'bad.webp', dataUrl: 'data:image/png;base64,YQ==' }])).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not add app images to an existing attachment-only draft', async () => {
    const input = upload(); const changed = vi.fn(); input.addEventListener('change', changed);
    const tile = document.createElement('button'); tile.setAttribute('aria-label', 'Remove file: personal.webp');
    document.querySelector('form')!.append(tile);
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }])).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(tile.isConnected).toBe(true);
  });

  it('refuses extra attachments added while the requested upload is completing', async () => {
    const input = upload();
    input.addEventListener('change', () => {
      for (const name of ['app.webp', 'personal.webp']) {
        const tile = document.createElement('button'); tile.setAttribute('aria-label', `Remove file: ${name}`);
        document.querySelector('form')!.append(tile);
      }
    });
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }])).toBe(false);
    expect(document.querySelectorAll('[aria-label^="Remove file:"]')).toHaveLength(2);
  });

  it('requires distinct new tiles with exact filenames rather than substring matches', async () => {
    const input = upload();
    const form = document.querySelector('form')!;
    const old = document.createElement('button'); old.setAttribute('aria-label', 'Other action'); form.append(old);
    const tile = document.createElement('button'); tile.setAttribute('aria-label', 'Remove file: data.webp');
    input.addEventListener('change', () => form.append(tile));
    const result = api.uploadImages(Array.from({ length: 2 }, () => ({ name: 'a.webp', dataUrl: 'data:image/webp;base64,YQ==' })));
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    tile.setAttribute('aria-label', 'Remove file: a.webp');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    const second = document.createElement('button'); second.setAttribute('aria-label', 'Remove file: a.webp'); form.append(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
  });
});

function catalogPicker(labels: string[], hiddenModels = false) {
  const controls = picker();
  let position = 2;
  const radios = [controls.radio];
  controls.radio.setAttribute('aria-checked', 'true');
  const other = controls.radio.cloneNode(true) as HTMLElement;
  other.textContent = 'Sol Example'; other.setAttribute('aria-checked', 'false');
  controls.radio.after(other); radios.push(other);
  const render = () => { controls.description.textContent = `${labels[position - 1]}, ${position} of ${labels.length}`; };
  render();
  for (const radio of radios) radio.addEventListener('click', () => {
    for (const entry of radios) entry.setAttribute('aria-checked', String(entry === radio));
    position = 1; render();
  });
  const keys: string[] = [];
  controls.power.addEventListener('keydown', event => {
    const key = (event as KeyboardEvent).key; keys.push(key);
    position += key === 'ArrowRight' ? 1 : -1; render();
  });
  if (hiddenModels) {
    for (const radio of radios) (radio as HTMLElement).hidden = true;
    controls.container.querySelector('[aria-label="Select model"]')!.addEventListener('click', () => {
      for (const radio of radios) (radio as HTMLElement).hidden = false;
    });
  }
  return { ...controls, keys, radios };
}
describe('read-only picker catalog', () => {
  function latestPicker(generation = '6') {
    const controls = catalogPicker(['Instant', 'Medium', 'High', 'Extra High', 'Pro']);
    controls.radios[0]!.textContent = 'Latest';
    controls.radios[1]!.textContent = 'GPT-5.6 Sol';
    const badge = controls.container.querySelector('[aria-label="Select model"]')!;
    const renderBadge = () => {
      const latest = controls.radios[0]!.getAttribute('aria-checked') === 'true';
      badge.textContent = controls.description.textContent?.startsWith('Pro,') ? `${latest ? generation : '5.6'}Pro` : 'High';
    };
    for (const radio of controls.radios) radio.addEventListener('click', renderBadge);
    controls.power.addEventListener('keydown', renderBadge);
    renderBadge();
    return controls;
  }
  it('resolves Latest Pro from its native generation badge and keeps explicit 5.6 Pro separate', async () => {
    const controls = latestPicker();
    expect(await api.inspectModelSettings()).toEqual([
      { id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['pro'] },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['none', 'medium', 'high', 'xhigh', 'pro'] }
    ]);
    expect(controls.radios[0]!.getAttribute('aria-checked')).toBe('true');
    expect(controls.description.textContent).toBe('Medium, 2 of 5');
    expect(await api.selectModelSettings('gpt-6-pro', 'pro')).toBe(true);
    expect(api.visibleModelSelection()).toEqual({ model: 'GPT-6 Pro', reasoningEffort: 'pro' });
    expect(await api.selectModelSettings('gpt-5.6-sol', 'pro')).toBe(true);
    expect(controls.radios[1]!.getAttribute('aria-checked')).toBe('true');
    expect(controls.container.querySelector('[aria-label="Select model"]')!.textContent).toBe('5.6Pro');
  });
  it('refuses a stale Latest Pro identity if the native badge now names another generation', async () => {
    latestPicker('5.6');
    expect(await api.selectModelSettings('gpt-6-pro', 'pro')).toBe(false);
  });
  it('does not invent Latest identity from an effort-only badge', async () => {
    latestPicker('');
    const models = await api.inspectModelSettings();
    expect(models?.map(model => model.id)).toEqual(['gpt-5.6-sol']);
  });
  it('opens the native menu with Enter rather than relying on a click-only fixture', async () => {
    const controls = catalogPicker(['Instant', 'Medium', 'High']);
    controls.container.remove();
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    const click = vi.fn(); trigger.addEventListener('click', click);
    trigger.addEventListener('keydown', event => { if (event.key === 'Enter') document.body.append(controls.container); });
    const result = api.inspectModelSettings();
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toHaveLength(2);
    expect(click).not.toHaveBeenCalled();
  });
  it('reports unsupported model labels instead of silently returning an empty catalog', async () => {
    const controls = catalogPicker(['Instant', 'Medium', 'High']);
    for (const radio of controls.radios) radio.textContent = 'Unknown / model';
    const failure = vi.fn();
    expect(await api.inspectModelSettings(() => true, failure)).toBeNull();
    expect(failure).toHaveBeenCalledWith('model_unconfirmed');
  });
  it('waits for a helper composer and its Power row to hydrate in the same document', async () => {
    const controls = catalogPicker(['Instant', 'Medium', 'High', 'Extra High']);
    const form = document.querySelector('form')!;
    form.remove(); controls.power.remove();
    const result = api.inspectModelSettings();
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    document.body.prepend(form);
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    controls.container.append(controls.power);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toHaveLength(2);
  });
  it('reads a menu that replaces Power and Select model with radio choices', async () => {
    const controls = catalogPicker(['Instant', 'Medium', 'High', 'Extra High'], true);
    const toggle = controls.container.querySelector('[aria-label="Select model"]')!;
    const expand = () => {
      controls.power.remove(); toggle.remove();
      for (const radio of controls.radios) radio.removeAttribute('hidden');
    };
    toggle.addEventListener('click', expand);
    for (const radio of controls.radios) radio.addEventListener('click', () => {
      for (const sibling of controls.radios) sibling.setAttribute('hidden', '');
      controls.container.append(toggle, controls.power);
    });
    const result = await api.inspectModelSettings();
    expect(result).toHaveLength(2);
    expect(controls.description.textContent).toBe('Medium, 2 of 4');
    expect(controls.power.isConnected).toBe(true);
    expect(controls.radio.getAttribute('aria-checked')).toBe('true');
  });
  it('omits upgrade-only effort slots and refuses selecting them', async () => {
    const controls = catalogPicker(['Instant', 'Medium', 'High', 'Pro']);
    const markUpgrade = () => {
      if (controls.description.textContent?.startsWith('Pro,')) controls.description.textContent += ' Upgrade required.';
    };
    controls.power.addEventListener('keydown', markUpgrade);
    const result = await api.inspectModelSettings();
    expect(result?.map(model => model.efforts)).toEqual([['none', 'medium', 'high'], ['none', 'medium', 'high']]);
    expect(await api.selectModelSettings('gpt-example', 'pro')).toBe(false);
  });
  it('captures the original effort before the model submenu unmounts Power', async () => {
    const controls = catalogPicker(['Instant', 'Medium', 'High', 'Extra High'], true);
    const toggle = controls.container.querySelector('[aria-label="Select model"]')!;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      toggle.setAttribute('aria-expanded', 'true');
      controls.power.remove();
    });
    for (const radio of controls.radios) radio.addEventListener('click', () => {
      toggle.setAttribute('aria-expanded', 'false');
      controls.container.append(controls.power);
    });
    const result = await api.inspectModelSettings();
    expect(result).toHaveLength(2);
    expect(controls.radio.getAttribute('aria-checked')).toBe('true');
    expect(controls.description.textContent).toBe('Medium, 2 of 4');
  });
  it.each([
    ['Instant', 'Medium', 'High', 'Extra High'],
    ['Instant', 'Medium', 'High', 'Extra High', 'Pro']
  ])('reads actual %j slots and restores model and effort', async (...labels) => {
    const controls = catalogPicker(labels, true);
    const result = await api.inspectModelSettings();
    expect(result).toEqual([
      { id: 'gpt-example', label: 'GPT Example', efforts: ['none', 'medium', 'high', 'xhigh', ...(labels.includes('Pro') ? ['pro'] : [])] },
      { id: 'sol-example', label: 'Sol Example', efforts: ['none', 'medium', 'high', 'xhigh', ...(labels.includes('Pro') ? ['pro'] : [])] }
    ]);
    expect(controls.radio.getAttribute('aria-checked')).toBe('true');
    expect(controls.description.textContent).toBe(`Medium, 2 of ${labels.length}`);
    expect(box.textContent).toBe('Exact app prompt');
  });
  it('returns unknown when restoring the original model is no longer possible', async () => {
    const controls = catalogPicker(['Instant', 'Medium', 'High', 'Extra High']);
    controls.radios[1]!.addEventListener('click', () => controls.radio.setAttribute('aria-disabled', 'true'));
    expect(await api.inspectModelSettings()).toBeNull();
  });
  it('stops immediately after ownership changes and does not restore in another document', async () => {
    const controls = catalogPicker(['Instant', 'Medium', 'High', 'Extra High']);
    let owned = true;
    controls.power.addEventListener('keydown', () => { owned = false; });
    expect(await api.inspectModelSettings(() => owned)).toBeNull();
    expect(controls.keys).toHaveLength(1);
  });
  it('reports unknown if native power has no exact ordinal proof', async () => {
    const controls = catalogPicker(['Instant', 'Medium', 'High', 'Extra High']);
    controls.description.textContent = 'Thinking';
    const result = api.inspectModelSettings();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toBeNull();
    expect(controls.keys).toEqual([]);
  });
});
