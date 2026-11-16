import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const geminiDom = require('../extension/gemini-dom.js');

describe('gemini-dom', () => {
  it('parses Gemini conversation URLs cleanly and ignores home/gem landing routes', () => {
    expect(geminiDom.conversationFromUrl('https://gemini.google.com/app')).toBeNull();
    expect(geminiDom.conversationFromUrl('https://gemini.google.com/u/1/app')).toBeNull();
    expect(geminiDom.conversationFromUrl('https://gemini.google.com/gem/coding-partner')).toBeNull();
    expect(geminiDom.conversationFromUrl('https://gemini.google.com/app/settings')).toBeNull();
    expect(geminiDom.conversationFromUrl('https://gemini.google.com/app/8f3b2c1d9e0a4567')).toBe('gemini-8f3b2c1d9e0a4567');
    expect(geminiDom.conversationFromUrl('https://gemini.google.com/u/0/app/AbCd1234EfGh5678')).toBe('gemini-AbCd1234EfGh5678');
    expect(geminiDom.conversationFromUrl('https://gemini.google.com/gem/my-gem/8f3b2c1d9e0a4567')).toBe('gemini-8f3b2c1d9e0a4567');
    expect(geminiDom.conversationFromUrl('https://chatgpt.com/c/12345678-1234-1234-1234-123456789012')).toBeNull();
  });

  it('extracts user and assistant turns without thinking accordion noise or sr-only labels', () => {
    const dom = new JSDOM(`<!doctype html><html><head><title>Refactor Notes - Google Gemini</title></head><body>
      <h1 data-test-id="conversation-title">Refactor Notes</h1>
      <button data-test-id="bard-mode-menu-button">2.5 Pro <span>keyboard_arrow_down</span></button>
      <div class="conversation-container" id="turn-a">
        <user-query>
          <span class="cdk-visually-hidden">You said</span>
          <div class="query-text"><p>Explain the caching bug</p></div>
        </user-query>
        <model-response>
          <model-thoughts><p>Internal reasoning should not leak</p></model-thoughts>
          <message-content>
            <div class="markdown">
              <p>Here is the fix.</p>
              <pre><code class="language-ts">const ok = true;</code></pre>
            </div>
          </message-content>
        </model-response>
      </div>
      <rich-textarea><div class="ql-editor ql-blank" contenteditable="true" role="textbox"></div></rich-textarea>
      <button class="send-button" aria-label="Send message" disabled></button>
    </body></html>`, { url: 'https://gemini.google.com/app/8f3b2c1d9e0a4567' });

    const { document } = dom.window;
    expect(geminiDom.conversationTitle(document)).toBe('Refactor Notes');
    expect(geminiDom.modelLabel(document)).toBe('2.5 Pro');
    const turns = geminiDom.extractTurns(document);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: 'user', messageId: 'gmsg-user-0', text: 'Explain the caching bug' });
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].messageId).toBe('gmsg-assistant-0');
    expect(turns[1].text).toContain('Here is the fix.');
    expect(turns[1].text).toContain('const ok = true;');
    expect(turns[1].text).not.toContain('Internal reasoning should not leak');
  });

  it('inserts multi-line prompt into rich-textarea Quill editor, clicks enabled send, and detects stop button', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <rich-textarea><div class="ql-editor ql-blank" contenteditable="true" role="textbox"></div></rich-textarea>
      <button class="send-button" aria-label="Send message"></button>
    </body></html>`, { url: 'https://gemini.google.com/app' });

    const { document } = dom.window;
    let clicked = 0;
    document.querySelector('button.send-button')!.addEventListener('click', () => { clicked += 1; });

    expect(geminiDom.insertPrompt('First line\n\nSecond line', document)).toBe(true);
    const editor = geminiDom.composer(document)!;
    expect(editor.classList.contains('ql-blank')).toBe(false);
    expect(geminiDom.readComposerText(editor)).toBe('First line\n\nSecond line');
    expect(geminiDom.send(document)).toBe(true);
    expect(clicked).toBe(1);

    const btn = document.querySelector('button.send-button')!;
    btn.classList.add('stop');
    btn.setAttribute('aria-label', 'Stop response');
    expect(geminiDom.generating(document)).toBe(true);
    expect(geminiDom.stopGeneration(document)).toBe(true);
  });

  it('parses validated [[COS_SPAWN_WORKERS]] blocks and ignores malformed ones', () => {
    const valid = `I will delegate this work.
[[COS_SPAWN_WORKERS]]
[
  {"label": "Researcher", "task": "Inspect src/shared/provider.ts", "provider": "gemini"},
  {"label": "Verifier", "task": "Run tests", "provider": "chatgpt"}
]
[[/COS_SPAWN_WORKERS]]`;
    expect(geminiDom.extractWorkerSpawnDirective(valid)).toEqual([
      { label: 'Researcher', task: 'Inspect src/shared/provider.ts', provider: 'gemini' },
      { label: 'Verifier', task: 'Run tests', provider: 'chatgpt' }
    ]);

    expect(geminiDom.extractWorkerSpawnDirective('[[COS_SPAWN_WORKERS]]{not json}[[/COS_SPAWN_WORKERS]]')).toBeNull();
  });

  it('inspects Gemini mode switcher options, ignores upgrade buttons, and closes cleanly', async () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <bard-mode-switcher>
        <button data-test-id="bard-mode-menu-button">Hızlı <span>keyboard_arrow_down</span></button>
      </bard-mode-switcher>
      <div class="cdk-overlay-container"></div>
    </body></html>`, { url: 'https://gemini.google.com/app' });

    const { document } = dom.window;
    const trigger = document.querySelector('[data-test-id="bard-mode-menu-button"]') as HTMLButtonElement;
    const overlay = document.querySelector('.cdk-overlay-container')!;
    trigger.addEventListener('click', () => {
      if (overlay.querySelector('[role="menu"]')) {
        overlay.replaceChildren();
        trigger.setAttribute('aria-expanded', 'false');
        return;
      }
      trigger.setAttribute('aria-expanded', 'true');
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      const makeOption = (testId: string, name: string, desc: string, opts: { selected?: boolean; disabled?: boolean; tag?: 'button' | 'a' } = {}) => {
        const el = document.createElement(opts.tag ?? 'button');
        el.setAttribute('role', 'menuitemradio');
        el.setAttribute('data-test-id', testId);
        if (opts.selected) el.setAttribute('aria-checked', 'true');
        if (opts.disabled) el.setAttribute('aria-disabled', 'true');
        const title = document.createElement('span');
        title.className = 'mode-title';
        title.textContent = name;
        const subtitle = document.createElement('span');
        subtitle.className = 'mode-description';
        subtitle.textContent = desc;
        el.append(title, subtitle);
        el.addEventListener('click', () => {
          trigger.textContent = name;
          overlay.replaceChildren();
          trigger.setAttribute('aria-expanded', 'false');
        });
        return el;
      };
      menu.append(
        makeOption('bard-mode-option-fast', 'Hızlı', 'Günlük işler için hızla yanıt verir', { selected: true }),
        makeOption('bard-mode-option-thinking', 'Düşünme', 'Karmaşık sorunları çözer'),
        makeOption('bard-mode-option-pro', '2.5 Pro', 'Gelişmiş matematik ve kodlama'),
        makeOption('bard-mode-option-locked', 'Ultra', 'Disabled plan item', { disabled: true }),
        makeOption('bard-mode-option-upgrade', 'Upgrade', 'Subscribe', { tag: 'a' })
      );
      overlay.append(menu);
    });
    document.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') {
        overlay.replaceChildren();
        trigger.setAttribute('aria-expanded', 'false');
      }
    });

    const inspected = await geminiDom.inspectModels(document);
    expect(inspected).toEqual({
      models: [
        { id: 'fast', label: 'Hızlı', description: 'Günlük işler için hızla yanıt verir' },
        { id: 'thinking', label: 'Düşünme', description: 'Karmaşık sorunları çözer' },
        { id: 'pro', label: '2.5 Pro', description: 'Gelişmiş matematik ve kodlama' }
      ]
    });
    expect(geminiDom.modelLabel(document)).toBe('Hızlı');
    expect(overlay.querySelector('[role="menu"]')).toBeNull();

    const selected = await geminiDom.selectModel('pro', () => true, document);
    expect(selected).toEqual({ ok: true, model: '2.5 Pro' });
    expect(geminiDom.modelLabel(document)).toBe('2.5 Pro');

    // Fast path when the requested model label is already active.
    const fastPath = await geminiDom.selectModel('2.5 Pro', () => true, document);
    expect(fastPath).toEqual({ ok: true, model: '2.5 Pro' });

    const missing = await geminiDom.selectModel('nonexistent', () => true, document);
    expect(missing).toEqual({ ok: false, error: 'model_unconfirmed' });
  });

  it('skips hidden duplicate mode trigger buttons and reads label from the visible trigger', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <bard-mode-switcher>
        <button data-test-id="bard-mode-menu-button" hidden>Hidden Old Label</button>
        <button data-test-id="bard-mode-menu-button" style="display:none">Display None Label</button>
        <button data-test-id="bard-mode-menu-button">2.5 Pro (experimental) <span>keyboard_arrow_down</span></button>
      </bard-mode-switcher>
    </body></html>`, { url: 'https://gemini.google.com/app' });

    expect(geminiDom.modelLabel(dom.window.document)).toBe('2.5 Pro (experimental)');
  });
});
