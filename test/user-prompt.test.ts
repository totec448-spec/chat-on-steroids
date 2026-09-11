import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { prependUserPrompt, userPromptText } from '../src/shared/user-prompt.js';

it('preserves the entire Unicode prompt and literal boundary-like user text across both readers', () => {
  const page = new JSDOM('', { runScripts: 'outside-only' });
  try {
    page.window.eval(readFileSync('extension/chatgpt-dom.js', 'utf8'));
    const api = (page.window as unknown as { CLF_DOM: typeof import('../src/shared/user-prompt.js') }).CLF_DOM;
    const instructions = 'First\n\n' + 'ä 🐱 [[/COS_CONTEXT]]\n'.repeat(3000) + 'Last';
    const authored = 'My request\n[[/COS_CONTEXT]]\n\nKeep this literally.';
    const sent = prependUserPrompt(authored, instructions);
    expect(sent).toContain(instructions);
    expect(userPromptText(sent)).toBe(authored);
    expect(api.userPromptText(sent)).toBe(authored);
    expect(api.userPromptText(sent.replace(/\n/g, '\r\n'))).toBe(authored);
    expect(prependUserPrompt('User\r\nrequest', 'Full\r\nprompt')).toBe(prependUserPrompt('User\nrequest', 'Full\nprompt'));
    expect(prependUserPrompt(sent, instructions)).toBe(sent);
    expect(prependUserPrompt(sent, 'Updated')).toBe(prependUserPrompt(authored, 'Updated'));
    for (const mode of ['HANDOFF', 'RESUME']) {
      const task = `[[CLF-${mode}:token_0123456789abcdef]]\n\n${authored}`;
      const framed = prependUserPrompt(task, instructions);
      expect(framed.startsWith(`[[CLF-${mode}:`)).toBe(true);
      expect(userPromptText(framed)).toBe(task);
      expect(api.userPromptText(framed)).toBe(task);
      expect(prependUserPrompt(framed, instructions)).toBe(framed);
    }
    for (const text of [authored, sent.slice(0, 80), sent.replace('COS_CONTEXT:', 'COS_CONTEXT:9')]) {
      expect(userPromptText(text)).toBeNull();
      expect(api.userPromptText(text)).toBeNull();
    }
  } finally { page.window.close(); }
});

it('hides only the framed prefix while preserving native message bytes and controls through repaint', () => {
  const page = new JSDOM('<section data-testid="conversation-turn-0"><div data-message-id="user-1" data-message-author-role="user"><div class="whitespace-pre-wrap"></div><button>Copy</button></div></section>', { runScripts: 'outside-only' });
  try {
    page.window.eval(readFileSync('extension/chatgpt-dom.js', 'utf8'));
    const api = (page.window as any).CLF_DOM;
    const raw = page.window.document.querySelector('.whitespace-pre-wrap')!;
    const copy = page.window.document.querySelector('button');
    const sent = prependUserPrompt('Visible request\nSecond line', 'Full hidden guidance');
    raw.textContent = sent;
    api.presentUserPrompts(); api.presentUserPrompts();
    expect(raw.hasAttribute('data-clf-prompt-hidden')).toBe(true);
    expect(raw.textContent).toBe(sent);
    expect(page.window.document.querySelectorAll('[data-clf-user-text]')).toHaveLength(1);
    expect(page.window.document.querySelector('[data-clf-user-text]')?.textContent).toBe('Visible request\nSecond line');
    expect(page.window.document.querySelector('button')).toBe(copy);
    expect(api.messages()[0].text).toBe(sent);
    raw.textContent = 'Edited plain request';
    api.presentUserPrompts();
    expect(raw.hasAttribute('data-clf-prompt-hidden')).toBe(false);
    expect(page.window.document.querySelector('[data-clf-user-text]')).toBeNull();
  } finally { page.window.close(); }
});

it('presents the live native Markdown user renderer without changing its text or recording the display copy', () => {
  const page = new JSDOM('<section data-testid="conversation-turn-0"><div data-message-id="user-1" data-message-author-role="user"><div data-testid="collapsible-user-message-content"><div class="markdown"></div></div><button>Copy</button></div></section>', { runScripts: 'outside-only' });
  try {
    page.window.eval(readFileSync('extension/chatgpt-dom.js', 'utf8'));
    const api = (page.window as any).CLF_DOM;
    const raw = page.window.document.querySelector('.markdown')!;
    // The observed renderer wraps paragraphs in p and converts newlines to br.
    // It also consumes trailing Markdown spaces, invalidating wire lengths.
    const sent = prependUserPrompt('Visible request\nSecond line', 'Full guidance.  \n\nLast sentence.');
    for (const paragraph of sent.replace('guidance.  ', 'guidance.').split('\n\n')) {
      const p = page.window.document.createElement('p');
      for (const [index, line] of paragraph.split('\n').entries()) {
        if (index) p.append(page.window.document.createElement('br'));
        p.append(line);
      }
      raw.append(p);
    }
    const before = raw.innerHTML;
    const recorded = api.messages()[0].text;
    // Display HTML cannot establish a transport boundary. The exact native
    // message source also preserves literal marker-like authored text.
    api.presentUserPrompts();
    expect(raw.hasAttribute('data-clf-prompt-hidden')).toBe(false);
    const source = (message: { id: string }) => message.id === 'user-1' ? sent : null;
    api.presentUserPrompts(source); api.presentUserPrompts(source);
    expect(raw.hasAttribute('data-clf-prompt-hidden')).toBe(true);
    expect(raw.innerHTML).toBe(before);
    expect(page.window.document.querySelectorAll('[data-clf-user-text]')).toHaveLength(1);
    expect(page.window.document.querySelector('[data-clf-user-text]')?.textContent).toBe('Visible request\nSecond line');
    expect(api.messages()[0].text).toBe(recorded);
    raw.textContent = 'Edited plain request';
    api.presentUserPrompts();
    expect(raw.hasAttribute('data-clf-prompt-hidden')).toBe(false);
    expect(page.window.document.querySelector('[data-clf-user-text]')).toBeNull();
  } finally { page.window.close(); }
});

it('hides a provider-prefixed blank paragraph using exact source, retaining strict frames and authored whitespace', () => {
  const page = new JSDOM('<section data-testid="conversation-turn-0"><div data-message-id="user-1" data-message-author-role="user"><div class="whitespace-pre-wrap"></div><button>Copy</button></div></section>', { runScripts: 'outside-only' });
  try {
    page.window.eval(readFileSync('extension/chatgpt-dom.js', 'utf8'));
    const api = (page.window as any).CLF_DOM;
    const raw = page.window.document.querySelector('.whitespace-pre-wrap')!;
    const copy = page.window.document.querySelector('button');
    const authored = '  My request\n\n[[/COS_CONTEXT]]\n\nKeep this literal.  ';
    const framed = prependUserPrompt(authored, 'System guidance.  \n\n# AGENTS.md\nProject instructions.');
    // Live ChatGPT: the source acquires a leading newline; rendered text also
    // loses trailing spaces within instructions, so DOM lengths cannot be used.
    let source = '\n' + framed;
    raw.textContent = source.replace('guidance.  ', 'guidance.');
    const native = raw.innerHTML;
    const recorded = api.messages()[0].text;
    api.presentUserPrompts(() => source); api.presentUserPrompts(() => source);
    expect(raw.hasAttribute('data-clf-prompt-hidden')).toBe(true);
    expect(page.window.document.querySelectorAll('[data-clf-user-text]')).toHaveLength(1);
    expect(page.window.document.querySelector('[data-clf-user-text]')?.textContent).toBe(authored);
    expect(raw.innerHTML).toBe(native);
    expect(page.window.document.querySelector('button')).toBe(copy);
    expect(api.messages()[0].text).toBe(recorded);
    expect(api.userPromptText(source)).toBeNull();
    expect(userPromptText(source)).toBeNull();
    for (const invalid of [source.replace('COS_CONTEXT:', 'COS_CONTEXT:9'), source.slice(0, 70), '  Ordinary request\n[[/COS_CONTEXT]]']) {
      source = invalid;
      api.presentUserPrompts(() => source);
      expect(raw.hasAttribute('data-clf-prompt-hidden')).toBe(false);
      expect(page.window.document.querySelector('[data-clf-user-text]')).toBeNull();
    }
  } finally { page.window.close(); }
});
