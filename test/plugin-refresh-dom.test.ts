import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';
const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
let dom: JSDOM;
afterEach(() => dom?.window.close());
const tool = { name: 'read', description: 'Read an exact file.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'A path with {braces} and "quotes"' } }, required: ['path'] } };
function page() {
  dom = new JSDOM('<button id="plugins-tab">Plugins</button><section role="tabpanel" aria-labelledby="plugins-tab"><h2>Chat On Steroids Core</h2><div class="actions"><article><h3>read</h3>\nPUBLIC WRITE\n<p>Read an exact file.</p>\nINPUT SCHEMA\n<button>Copy input schema</button><pre></pre>\nMETADATA\nVisibility public</article></div><footer>Information\n<button>Refresh</button>\nApp Id asdk_app_synthetic\nVersion Id asdk_app_v_synthetic</footer></section>', { runScripts: 'outside-only', url: 'https://chatgpt.com/plugins' });
  dom.window.document.querySelector('pre')!.textContent = JSON.stringify(tool.inputSchema);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return [{}]; } });
  dom.window.eval(source);
  return (dom.window as any).CLF_DOM;
}
it('reads exact visible plugin identity and full schema without treating a refresh button as success', () => {
  const api = page();
  const view = api.pluginRefreshView('Chat On Steroids Core', [tool]);
  expect(view).toMatchObject({ appId: 'asdk_app_synthetic', versionId: 'asdk_app_v_synthetic', tools: [tool] });
  expect(view.refresh.textContent).toBe('Refresh');
  expect(view).not.toHaveProperty('success');
});
it('refuses duplicate app identity and does not substitute expected text for a changed description', () => {
  const api = page();
  dom.window.document.querySelector('p')!.textContent = 'Read an exact file. And write it.';
  expect(api.pluginRefreshView('Chat On Steroids Core', [tool]).tools[0].description).toBe('Read an exact file. And write it.');
  dom.window.document.querySelector('footer')!.append(' App Id asdk_app_other');
  expect(api.pluginRefreshView('Chat On Steroids Core', [tool])).toBeNull();
});
it('reads removed tool declarations without inventing their identity, but refuses the wrong Plugins heading', () => {
  const api = page();
  expect(api.pluginRefreshView('Chat On Steroids Desktop', [tool])).toBeNull();
  dom.window.document.querySelector('h3')!.textContent = 'another_tool';
  expect(api.pluginRefreshView('Chat On Steroids Core', [tool]).tools).toEqual([{ ...tool, name: 'another_tool' }]);
  // A mapped connector may still expose a tool that the new schema removed. Identity
  // and Refresh remain observable; initial enrollment still rejects the unknown set.
  expect(api.pluginRefreshView('Chat On Steroids Core', [tool], 'asdk_app_synthetic').refresh.textContent).toBe('Refresh');
});
it('distinguishes the loading plugin index from a settled missing installation', () => {
  const api = page();
  const panel = dom.window.document.querySelector('section')!;
  panel.innerHTML = '<a href="/plugins">Browse plugins</a>';
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toBeNull();
  panel.insertAdjacentHTML('beforeend', '<button><span data-testid="plugin-icon-wrapper"></span><div>Chat On Steroids Desktop</div><span>Allow all</span></button>');
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toEqual([]);
  panel.insertAdjacentHTML('beforeend', '<button><span data-testid="plugin-icon-wrapper"></span><div>Chat On Steroids Core</div><span>Allow all</span></button>');
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toEqual([panel.querySelectorAll('button')[1]]);
});
it('uses a mapped App ID before a renamed display name and refuses another App ID', () => {
  const api = page();
  dom.window.document.querySelector('h2')!.textContent = 'My renamed connector';
  expect(api.pluginRefreshView('Chat On Steroids Core', [tool], 'asdk_app_synthetic')?.appId).toBe('asdk_app_synthetic');
  expect(api.pluginRefreshView('Chat On Steroids Core', [tool], 'asdk_app_other')).toBeNull();
});
it('reads the live adjacent settings labels and ignores provider schema recommendation badges', () => {
  const api = page();
  const panel = dom.window.document.querySelector('section')!;
  const article = dom.window.document.querySelector('article')!;
  Object.defineProperty(panel, 'innerText', { value: 'Chat On Steroids Core\nApp Id\nasdk_app_synthetic\nVersion Id\nasdk_app_v_synthetic' });
  dom.window.document.querySelector('footer')!.textContent = 'App Idasdk_app_syntheticVersion Idasdk_app_v_synthetic';
  Object.defineProperty(article, 'innerText', { value: `read\nREAD\nOUTPUT SCHEMA RECOMMENDED\nRead an exact file.\nINPUT SCHEMA\n${JSON.stringify(tool.inputSchema)}` });
  expect(api.pluginRefreshView('Chat On Steroids Core', [tool])).toMatchObject({ appId: 'asdk_app_synthetic', tools: [tool] });
});
it('exposes duplicate installed names as ambiguous instead of picking a row', () => {
  const api = page();
  const panel = dom.window.document.querySelector('section')!;
  panel.innerHTML = '<button><span data-testid="plugin-icon-wrapper"></span><div>Chat On Steroids Core</div></button>'.repeat(2);
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toHaveLength(2);
});
