# Tab-group placement for background chats (#128) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in setting puts every ChatGPT tab the app opens in the background into a collapsed "Chat On Steroids" tab group in the user's last-focused browser window, instead of the app's own minimized window.

**Architecture:**
- The app owns the setting (`ui.backgroundPlacement`) and publishes it in `/status`.
- The extension worker caches it and, inside the existing serialized `inBackgroundWindow` queue, places background tabs into a group it creates once and then keeps using.
- Every failure falls back to today's window path, so a tab is never left loose in the user's tab strip.
- Window mode stays exactly today's code path.

**Tech Stack:**
- Electron main (TypeScript, zod config, vitest), renderer (TypeScript, i18n JSON catalogs);
- MV3 extension worker (`extension/background.js`, plain JS);
- Chrome `tabGroups` / `tabs.group` APIs.

**Spec:** `docs/superpowers/specs/2026-10-11-tab-group-placement-design.md`

## Global Constraints

- **Default and off-mode behavior.** The default is `'window'`. With `'window'`, or with no `tabGroups` API, no `chrome.tabGroups.*` or `chrome.tabs.group` call is made and every existing test stays green unchanged.
- **Group appearance.** The title is exactly `Chat On Steroids` (not translated: it is the product name), the color is `'grey'`, and `collapsed: true` is set only on a group the app just created.
- **The user's view is never changed.** In group mode a background tab is always created with `active: false`. The app never calls `chrome.windows.update` on a user window, never re-collapses an existing group, and never moves or ungroups a tab in group mode's reconcile.
- **Stored state.**
  - Group ID: `chrome.storage.session` key `chatBackgroundGroup`, mirrored in `chrome.storage.local` key `chatBackgroundGroupMirror`.
  - Placement: `chrome.storage.local` key `backgroundPlacement`.
- **Group work is serialized.** All group work runs inside `inBackgroundWindow(...)`.
- **Repo rules.**
  - Stage explicit paths only, never `git add -A` (the worktree has a symlinked `node_modules`).
  - Never stage `.superpowers/`.
  - Run `npm run typecheck` before every push.
  - No Claude attribution lines in commits or the PR.
- **Testing.** Every behavior change is test-first: watch RED, then GREEN.
- **Translations.** New UI strings go into all 12 catalogs in `src/renderer/locales/` (de, es, fr, ja, ko, pt-BR, pt-PT, ru, tr, vi, zh-CN, zh-TW).
- **Live checks** run on both VM 141 and the Mac, and follow the existing rules:
  - ≤1 new ChatGPT chat per minute, stop at the first 429;
  - explicit harmless prompts;
  - stop VM 141 afterwards;
  - English screenshots for the PR.

## Review Focus

1. **Collapse yanking the user's tab.** Calling `tabGroups.update({ collapsed: true })` on a group that holds the window's active tab makes Chrome switch the user's tab. Only a just-created group (whose one tab is inactive) may be collapsed. Pinned by test 4.2.
2. **Concurrent first tabs.** Two chats opening in the same millisecond must produce one group, not two. Pinned by test 4.7.
3. **A tab left loose in the user's strip after a failure.** A group that vanished mid-placement is retried once, then the tab moves to the minimized window. Pinned by tests 5.1–5.3.
4. **Reconcile must never move tabs in group mode.** The window-mode reconcile pulls every owned tab into the background window; group mode must not pull tabs into or out of the user's window. Pinned by test 6.5.
5. **Stale identity after an extension reload or browser restart.**
   - A renamed group must not be re-found by its mirror.
   - A group holding a personal tab must never be adopted.

   Pinned by tests 6.1–6.4 and 6.6.

---

## File map

| File | Change |
| --- | --- |
| `src/main/config.ts` | schema + default `backgroundPlacement` |
| `src/shared/types.ts` | `backgroundPlacement?: 'window' \| 'group'` on the UI config type |
| `src/main/ipc.ts` | settings schema + three-way `pick` |
| `src/main/bridge.ts` | `/status` field; follow gate |
| `src/renderer/index.html` | select + help text under Background chats |
| `src/renderer/main.ts` | collect + apply the select |
| `src/renderer/chat.ts` | add `'backgroundPlacement'` to `CHAT_INPUTS` |
| `src/renderer/locales/*.json` (12) | 4 strings |
| `extension/manifest.json` | `"tabGroups"` permission |
| `extension/background.js` | placement state, group helpers, `createChatTab`, reconcile, `followChat`, compaction focus, `onStartup`, `load()` |
| `test/config.test.ts`, `test/bridge.test.ts`, `test/renderer-state.test.ts` | app tests |
| `test/background-window.test.ts` | group harness + placement/identity/reconcile tests |
| `test/extension.test.ts` | worker-level tests (status intake, restore, follow, focus, startup, manifest) |
| `AGENTS.md`, `docs/setup.md` | documentation |

---

### Task 1: App setting, `/status` field and the follow gate

**Files:**
- Modify: `src/main/config.ts` (schema near line 339, defaults near line 557)
- Modify: `src/shared/types.ts:142`
- Modify: `src/main/ipc.ts` (schema near line 214, merge near line 379)
- Modify: `src/main/bridge.ts` (follow gate near lines 758 and 766; status body near line 2517)
- Test: `test/config.test.ts`, `test/bridge.test.ts`

**Interfaces:**
- Produces:
  - `Config['ui']['backgroundPlacement']: 'window' | 'group'` (always present after load, default `'window'`);
  - `/status` response field `backgroundPlacement: 'window' | 'group'`.

- [ ] **Step 1: Write the failing config test** (in `test/config.test.ts`, directly after the "defaults background chats on…" test):

```ts
  it('defaults background placement to a window and keeps a saved tab-group choice', async () => {
    expect(defaultConfig().ui.backgroundPlacement).toBe('window');
    const legacy = defaultConfig(); delete (legacy.ui as { backgroundPlacement?: string }).backgroundPlacement;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).ui.backgroundPlacement).toBe('window');
    for (const backgroundPlacement of ['group', 'window'] as const) {
      await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, backgroundPlacement } });
      expect((await loadConfig()).ui.backgroundPlacement).toBe(backgroundPlacement);
    }
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...defaultConfig(), ui: { ...defaultConfig().ui, backgroundPlacement: 'sidebar' } }), 'utf8');
    expect((await loadConfig()).ui.backgroundPlacement).toBe('window');
  });
```

The last assertion pins that an unknown value never reaches the extension. Before writing the GREEN code, check how `loadConfig` treats a schema failure today: it may reset the whole config, or reset the field via a per-field fallback. Pin whichever is the existing behavior for invalid enum values (grep `safeParse` in `config.ts`). If an invalid enum resets the whole config, replace the last two lines with an assertion that the loaded config equals the default, and record the ruling.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/config.test.ts -t "background placement"`
Expected: FAIL. `expected undefined to be 'window'`.

- [ ] **Step 3: Implement the config**

`src/main/config.ts`, in the `ui` schema right after `backgroundChats`:

```ts
    backgroundPlacement: z.enum(['window', 'group']).optional().default('window'),
```

In the `defaultConfig()` `ui` object, after `backgroundChats: true,` add `backgroundPlacement: 'window',`.

`src/shared/types.ts`, after `backgroundChats?: boolean;`:

```ts
  /** Where background tabs go: the app's minimized window, or a collapsed tab group in the user's window (#128). */
  backgroundPlacement?: 'window' | 'group';
```

`src/main/ipc.ts`, in the settings schema after `backgroundChats: z.boolean().optional(),`:

```ts
    backgroundPlacement: z.enum(['window', 'group']).optional(),
```

In the merge, after the `backgroundChats: pick(...)` line:

```ts
      backgroundPlacement: pick(current.ui.backgroundPlacement, base.ui.backgroundPlacement, wanted.ui.backgroundPlacement),
```

- [ ] **Step 4: Run the config test and watch it pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Write the failing bridge tests** (in `test/bridge.test.ts`)

(a) In the describe block with the follow tests (near line 15435), add a helper and a test:

```ts
  const placement = async (value: 'window' | 'group') => {
    const config = getConfig();
    await saveConfig({ ...config, ui: { ...config.ui, backgroundPlacement: value } });
  };

  it('asks for no follow when background tabs go to a tab group', async () => {
    await pair();
    await background(true);
    await placement('group');
    const socket = await connect();
    try {
      await poll(BROWSER_B, [CHAT]);
      followChatInBackground(CHAT);
      expect((await poll(BROWSER_B, [CHAT])).follow).toBeUndefined();
    } finally { await close(socket); await placement('window'); }
  });

  it('drops a pending follow once the placement switches to a tab group', async () => {
    await pair();
    await background(true);
    const socket = await connect();
    try {
      await poll(BROWSER_B, [CHAT]);
      followChatInBackground(CHAT);
      await placement('group');
      expect((await poll(BROWSER_B, [CHAT])).follow).toBeUndefined();
    } finally { await close(socket); await placement('window'); }
  });

  it.each(['window', 'group'] as const)('publishes the background placement %s in /status', async (value) => {
    await pair();
    await placement(value);
    try {
      expect((await poll(BROWSER_B, [])).backgroundPlacement).toBe(value);
    } finally { await placement('window'); }
  });
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npx vitest run test/bridge.test.ts -t "tab group|background placement"`
Expected: FAIL. The follow tests receive `CHAT`, and `/status` lacks `backgroundPlacement`.

- [ ] **Step 7: Implement the bridge**

In `followChatInBackground`:

```ts
  if (getConfig().ui.backgroundChats !== true || getConfig().ui.backgroundPlacement === 'group' ||
      !browserWakeConnected() || !revealCapable()) return;
```

In `takeFollow`:

```ts
  if (Date.now() - entry.at > FOLLOW_TTL_MS || getConfig().ui.backgroundChats !== true ||
      getConfig().ui.backgroundPlacement === 'group') { pendingFollow = null; return null; }
```

In the `/status` body, after `background: getConfig().ui.backgroundChats === true,`:

```ts
        // #128: where the companion puts background tabs. Unknown or absent means the window.
        backgroundPlacement: getConfig().ui.backgroundPlacement === 'group' ? 'group' : 'window',
```

- [ ] **Step 8: Run and watch them pass**

Run: `npx vitest run test/bridge.test.ts test/config.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add src/main/config.ts src/shared/types.ts src/main/ipc.ts src/main/bridge.ts test/config.test.ts test/bridge.test.ts
git commit -m "feat(settings): background placement setting, published to the companion (#128)"
```

---

### Task 2: Settings select, help text and translations

**Files:**
- Modify: `src/renderer/index.html:1042` (after the Background chats label)
- Modify: `src/renderer/main.ts` (collect near line 689, apply near line 1559)
- Modify: `src/renderer/chat.ts:5232` (`CHAT_INPUTS`)
- Modify: `src/renderer/locales/{de,es,fr,ja,ko,pt-BR,pt-PT,ru,tr,vi,zh-CN,zh-TW}.json`
- Test: `test/renderer-state.test.ts`

**Interfaces:**
- Consumes: `Config['ui']['backgroundPlacement']` (Task 1).
- Produces: the DOM id `backgroundPlacement` (a `<select>` with values `window` and `group`).

- [ ] **Step 1: Write the failing renderer test** (in `test/renderer-state.test.ts`, after "saves the ChatGPT browser choice…"):

```ts
it('saves the background placement from its settings control and restores it on state push', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const placement = w.document.getElementById('backgroundPlacement') as HTMLSelectElement;
  expect(placement.value).toBe('window'); // older config has no field
  expect([...placement.options].map(option => option.value)).toEqual(['window', 'group']);
  placement.value = 'group';
  placement.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].ui.backgroundPlacement).toBe('group');
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, backgroundPlacement: 'window' } } });
  expect(placement.value).toBe('window');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/renderer-state.test.ts -t "background placement"`
Expected: FAIL. `placement` is null.

- [ ] **Step 3: Implement the markup, wiring and strings**

`src/renderer/index.html`, directly after the `backgroundChats` label:

```html
                  <label class="setting"><span class="setting-text"><b>Background tabs open in</b><em>The group stays collapsed in the window you used last. Chrome saves open tab groups automatically; the app's group closes with its last chat, so it is not kept. If you close that window while app chats are open, Chrome may keep the group in its saved groups, where you can delete it. Browsers without tab groups use a window.</em></span><select id="backgroundPlacement"><option value="window">Their own minimized window</option><option value="group">A tab group in your browser window</option></select></label>
```

`src/renderer/main.ts`, in the collected `ui` patch after `backgroundChats`:

```ts
      backgroundPlacement: $<HTMLSelectElement>('backgroundPlacement').value === 'group' ? 'group' : 'window',
```

In the apply block after the `backgroundChats` `applyChecked`:

```ts
  applyValue($<HTMLSelectElement>('backgroundPlacement'), config.ui.backgroundPlacement ?? 'window', previousState?.config.ui.backgroundPlacement ?? 'window');
```

`src/renderer/chat.ts` `CHAT_INPUTS`: insert `'backgroundPlacement',` right after `'backgroundChats',`.

In each of the 12 catalogs, after the `"Keep app-created ChatGPT tabs in the background."` entry, add these four keys:

- `"Background tabs open in"`
- `"Their own minimized window"`
- `"A tab group in your browser window"`
- the help sentence exactly as in the HTML.

Translations (keep "Chat On Steroids" untranslated; follow each catalog's existing term for "Background chats"):

| Locale | Background tabs open in | Their own minimized window | A tab group in your browser window |
| --- | --- | --- | --- |
| de | Hintergrund-Tabs öffnen in | Einem eigenen minimierten Fenster | Einer Tabgruppe in deinem Browserfenster |
| es | Las pestañas en segundo plano se abren en | Su propia ventana minimizada | Un grupo de pestañas en tu ventana del navegador |
| fr | Les onglets en arrière-plan s'ouvrent dans | Leur propre fenêtre réduite | Un groupe d'onglets dans votre fenêtre de navigateur |
| ja | バックグラウンドのタブを開く場所 | 専用の最小化されたウィンドウ | ブラウザーウィンドウ内のタブグループ |
| ko | 백그라운드 탭 열기 위치 | 별도의 최소화된 창 | 브라우저 창의 탭 그룹 |
| pt-BR | Abas em segundo plano abrem em | Uma janela minimizada própria | Um grupo de abas na sua janela do navegador |
| pt-PT | Os separadores em segundo plano abrem em | Uma janela minimizada própria | Um grupo de separadores na sua janela do navegador |
| ru | Фоновые вкладки открываются | В отдельном свёрнутом окне | В группе вкладок в окне браузера |
| tr | Arka plan sekmeleri şurada açılır | Kendi küçültülmüş penceresinde | Tarayıcı pencerenizdeki bir sekme grubunda |
| vi | Thẻ nền mở trong | Cửa sổ thu nhỏ riêng | Một nhóm thẻ trong cửa sổ trình duyệt của bạn |
| zh-CN | 后台标签页打开位置 | 单独的最小化窗口 | 浏览器窗口中的标签页组 |
| zh-TW | 背景分頁開啟位置 | 獨立的最小化視窗 | 瀏覽器視窗中的分頁群組 |

Help sentence translations:
- **de:** "Die Gruppe bleibt eingeklappt in dem Fenster, das du zuletzt benutzt hast. Chrome speichert offene Tabgruppen automatisch; die Gruppe der App schließt sich mit ihrem letzten Chat und wird daher nicht behalten. Wenn du dieses Fenster schließt, während App-Chats offen sind, behält Chrome die Gruppe eventuell in den gespeicherten Gruppen; dort kannst du sie löschen. Browser ohne Tabgruppen verwenden ein Fenster."
- **es:** "El grupo permanece contraído en la última ventana que usaste. Chrome guarda automáticamente los grupos de pestañas abiertos; el grupo de la app se cierra con su último chat, así que no se conserva. Si cierras esa ventana mientras hay chats de la app abiertos, Chrome puede conservar el grupo entre sus grupos guardados, donde puedes eliminarlo. Los navegadores sin grupos de pestañas usan una ventana."
- **fr:** "Le groupe reste réduit dans la dernière fenêtre utilisée. Chrome enregistre automatiquement les groupes d'onglets ouverts ; le groupe de l'app se ferme avec son dernier chat, il n'est donc pas conservé. Si vous fermez cette fenêtre pendant que des chats de l'app sont ouverts, Chrome peut garder le groupe dans ses groupes enregistrés, où vous pouvez le supprimer. Les navigateurs sans groupes d'onglets utilisent une fenêtre."
- **ja:** "グループは最後に使ったウィンドウで折りたたまれたままになります。Chrome は開いているタブグループを自動的に保存しますが、アプリのグループは最後のチャットとともに閉じるため保存されません。アプリのチャットが開いている間にそのウィンドウを閉じると、Chrome が保存済みグループにグループを残すことがあります。その場合はそこで削除できます。タブグループのないブラウザーではウィンドウを使います。"
- **ko:** "그룹은 마지막으로 사용한 창에 접힌 상태로 유지됩니다. Chrome은 열린 탭 그룹을 자동으로 저장하지만, 앱의 그룹은 마지막 채팅과 함께 닫히므로 남지 않습니다. 앱 채팅이 열려 있는 동안 그 창을 닫으면 Chrome이 저장된 그룹에 그룹을 남길 수 있으며, 거기서 삭제할 수 있습니다. 탭 그룹이 없는 브라우저는 창을 사용합니다."
- **pt-BR:** "O grupo fica recolhido na última janela que você usou. O Chrome salva automaticamente os grupos de abas abertos; o grupo do app fecha com o último chat, então não fica salvo. Se você fechar essa janela com chats do app abertos, o Chrome pode manter o grupo nos grupos salvos, onde você pode excluí-lo. Navegadores sem grupos de abas usam uma janela."
- **pt-PT:** "O grupo fica fechado na última janela que utilizou. O Chrome guarda automaticamente os grupos de separadores abertos; o grupo da app fecha com o último chat, por isso não fica guardado. Se fechar essa janela com chats da app abertos, o Chrome pode manter o grupo nos grupos guardados, onde o pode eliminar. Os navegadores sem grupos de separadores usam uma janela."
- **ru:** "Группа остаётся свёрнутой в окне, которым вы пользовались последним. Chrome автоматически сохраняет открытые группы вкладок; группа приложения закрывается вместе с последним чатом, поэтому не сохраняется. Если закрыть это окно, пока открыты чаты приложения, Chrome может оставить группу в сохранённых группах — там её можно удалить. Браузеры без групп вкладок используют окно."
- **tr:** "Grup, en son kullandığınız pencerede daraltılmış olarak kalır. Chrome açık sekme gruplarını otomatik olarak kaydeder; uygulamanın grubu son sohbetiyle birlikte kapanır, bu yüzden saklanmaz. Uygulama sohbetleri açıkken o pencereyi kapatırsanız Chrome grubu kayıtlı gruplarında tutabilir; oradan silebilirsiniz. Sekme grubu olmayan tarayıcılar pencere kullanır."
- **vi:** "Nhóm luôn được thu gọn trong cửa sổ bạn dùng gần nhất. Chrome tự động lưu các nhóm thẻ đang mở; nhóm của ứng dụng đóng cùng cuộc trò chuyện cuối cùng nên không được giữ lại. Nếu bạn đóng cửa sổ đó khi các cuộc trò chuyện của ứng dụng còn mở, Chrome có thể giữ nhóm trong các nhóm đã lưu, nơi bạn có thể xóa nó. Trình duyệt không có nhóm thẻ sẽ dùng một cửa sổ."
- **zh-CN:** "该组会在你上次使用的窗口中保持折叠。Chrome 会自动保存打开的标签页组；应用的组会随最后一个聊天关闭，因此不会被保留。如果你在应用聊天仍打开时关闭该窗口，Chrome 可能会把该组保留在已保存的组中，你可以在那里删除它。不支持标签页组的浏览器会使用窗口。"
- **zh-TW:** "群組會在你上次使用的視窗中保持收合。Chrome 會自動儲存開啟中的分頁群組；應用程式的群組會隨最後一個聊天關閉，因此不會保留。如果你在應用程式聊天仍開啟時關閉該視窗，Chrome 可能會把群組保留在已儲存的群組中，你可以在那裡刪除它。不支援分頁群組的瀏覽器會使用視窗。"

Before writing, read 3 neighbouring entries in each catalog and match its formality (du/Sie, tu/vous). The German catalog uses "du", as above. Adjust the other rows to their catalog's register and record any change as a ruling.

- [ ] **Step 4: Run the renderer and i18n tests and watch them pass**

Run: `npx vitest run test/renderer-state.test.ts test/renderer-i18n.test.ts test/renderer-i18n-source.test.ts`
Expected: PASS. The new select works, and every new HTML string exists in every catalog.

- [ ] **Step 5: Typecheck, take before/after screenshots, commit**

```bash
npm run typecheck
git add src/renderer/index.html src/renderer/main.ts src/renderer/chat.ts src/renderer/locales/*.json test/renderer-state.test.ts
git commit -m "feat(settings): choose window or tab group for background tabs (#128)"
```

Screenshots of Settings → Browser in English, before (upstream/main build) and after, are saved to the scratchpad for the PR and for the user.

---

### Task 3: Extension placement state (manifest, intake, restore)

**Files:**
- Modify: `extension/manifest.json` (`permissions`)
- Modify: `extension/background.js`:
  - new state after `let backgroundWindowBounds` (inside the region `test/background-window.test.ts` slices: from `let backgroundWindowFlight = null;` to `\nasync function deliverDesktopInputs`);
  - `loadOnce` storage keys near line 323;
  - status handler near line 2850.
- Test: `test/extension.test.ts`

**Interfaces:**
- Produces, in `background.js`:
  - `let backgroundPlacement = 'window'`;
  - `function setBackgroundPlacement(value): boolean` (normalizes to `'window' | 'group'`, returns whether it changed);
  - `async function rememberBackgroundPlacement(value): Promise<void>` (sets and persists to `chrome.storage.local.backgroundPlacement` when it changed);
  - `function groupsAvailable(): boolean`.

- [ ] **Step 1: Write the failing tests** (in `test/extension.test.ts`, inside the describe block that holds the Background chats window tests, after "forgets the mirrored Background chats window when the browser starts"):

```ts
  it('requests the tabGroups permission without an install warning', () => {
    const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
    expect(manifest.permissions).toContain('tabGroups');
  });

  it.each([
    ['group', 'group'],
    ['window', 'window'],
    [undefined, 'window'],
    ['sidebar', 'window']
  ])('remembers the background placement %s from /status as %s', async (sent, kept) => {
    const local = new FakeStorageArea({ ...paired, backgroundPlacement: sent === 'window' ? 'group' : 'window' });
    const worker = loadWorker({
      local, session: new FakeStorageArea(),
      fetch: vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/status') return response(200, { ok: true, repairs: [], ...(sent === undefined ? {} : { backgroundPlacement: sent }) });
        return response(404, {});
      })
    });
    await worker.fireAlarm();
    await vi.waitFor(async () => expect((await local.get('backgroundPlacement')).backgroundPlacement).toBe(kept));
  });

  it('does not follow a selection in tab-group mode', async () => {
    const BACKGROUND = 9;
    const TARGET = 'dddddddd-eeee-4fff-8aaa-777777777777';
    const tabs = [{ id: 12, windowId: BACKGROUND, url: `https://chatgpt.com/c/${TARGET}`, status: 'complete', active: false }];
    const worker = loadWorker({
      local: new FakeStorageArea({ ...paired, backgroundPlacement: 'group' }),
      session: new FakeStorageArea({ chatBackgroundWindow: BACKGROUND }),
      fetch: vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/status') return response(200, { ok: true, repairs: [], backgroundPlacement: 'group', follow: TARGET });
        return response(404, {});
      }),
      tabsQuery: async () => tabs,
      windowsGet: async (windowId: number) => ({ id: windowId, type: 'normal', focused: false, tabs } as { focused?: boolean })
    });
    await worker.fireAlarm();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(worker.tabsUpdate.mock.calls.filter(([, change]) => (change as { active?: boolean }).active === true)).toEqual([]);
  });
```

If `readFileSync` is not yet imported in `test/extension.test.ts`, add it to the existing `node:fs` import.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/extension.test.ts -t "tabGroups permission|background placement|tab-group mode"`
Expected: FAIL.
- The manifest lacks `tabGroups`.
- `backgroundPlacement` is never written: the storage keeps the seeded opposite value.
- The follow selects tab 12.

- [ ] **Step 3: Implement**

`extension/manifest.json`: add `"tabGroups"` after `"tabs"` in `permissions`.

`extension/background.js`, right after `let backgroundWindowBounds = { width: 800, height: 600 };`:

```js
/**
 * Where background tabs go (#128): the app's own minimized window, or a collapsed tab group in the
 * user's last-focused window. The app publishes it in `/status`; it is kept in local storage so a
 * wake that arrives before this worker's first status pass already places tabs the chosen way.
 * Anything but 'group', including an app that does not send it, means the window.
 */
let backgroundPlacement = 'window';
function setBackgroundPlacement(value) {
  const next = value === 'group' ? 'group' : 'window';
  const changed = next !== backgroundPlacement;
  backgroundPlacement = next;
  return changed;
}
async function rememberBackgroundPlacement(value) {
  if (!setBackgroundPlacement(value)) return;
  try { await chrome.storage.local.set({ backgroundPlacement }); } catch { /* Kept in memory for this worker. */ }
}
/** Group mode needs the setting and the browser's tab-group API; anything else uses the window. */
function groupsAvailable() {
  return backgroundPlacement === 'group' && typeof chrome.tabs?.group === 'function' &&
    typeof chrome.tabGroups?.get === 'function' && typeof chrome.tabGroups?.update === 'function' &&
    typeof chrome.tabGroups?.query === 'function' && typeof chrome.windows?.getLastFocused === 'function' &&
    typeof chrome.windows?.getAll === 'function';
}
```

In `loadOnce`, add `'backgroundPlacement'` to the `chrome.storage.local.get([...])` key list. After `connectorNames = cleanConnectorNames(stored.connectorNames);` add:

```js
  setBackgroundPlacement(stored.backgroundPlacement);
```

Also make the stored value always match the in-memory one: when storage holds `'window'` but `setBackgroundPlacement` reports no change, nothing is written, which is fine.

In the status handler, directly after `if (!reply.ok || !reply.data) { await activeTabs?.revoke(); return; }`:

```js
  await rememberBackgroundPlacement(reply.data.backgroundPlacement);
```

In `followChat`, as the first statement:

```js
  // #128: in tab-group mode a selection in the app never changes the user's window.
  if (backgroundPlacement === 'group') return;
```

Restoring from storage on worker start (`setBackgroundPlacement(stored.backgroundPlacement)` in `loadOnce`) has no worker-level observable before the first status pass, which immediately overrides it. It is pinned by a source-level guard in the same describe block. Write it together with Step 1's tests, so that it is watched failing in Step 2 too:

```ts
  it('restores the background placement before the first status pass', () => {
    const source = readFileSync('extension/background.js', 'utf8');
    const loadOnce = source.slice(source.indexOf('async function loadOnce'), source.indexOf('\n}\n', source.indexOf('async function loadOnce')));
    expect(loadOnce).toContain("'backgroundPlacement'");
    expect(loadOnce).toContain('setBackgroundPlacement(stored.backgroundPlacement)');
  });
```

- [ ] **Step 4: Fix the remembered-value test semantics, then watch the tests pass**

The test seeds the opposite value so that a write is observable. For the `undefined` and `'sidebar'` rows (seed `'window'`, expected `'window'`), the assertion holds without a write. That is correct: those rows pin "never stores anything but window or group".

Run: `npx vitest run test/extension.test.ts`
Expected: PASS, all tests (existing ones included).

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json extension/background.js test/extension.test.ts
git commit -m "feat(extension): keep the app's background placement; no follow in group mode (#128)"
```

---

### Task 4: Placing background tabs in the group

**Files:**
- Modify: `extension/background.js`: group helpers after `storedBackgroundWindow`; `createChatTab`.
- Test: `test/background-window.test.ts`

**Interfaces:**
- Consumes: `backgroundPlacement`, `setBackgroundPlacement`, `groupsAvailable` (Task 3).
- Produces:
  - constants `BACKGROUND_GROUP_TITLE = 'Chat On Steroids'` and `BACKGROUND_GROUP_MIRROR = 'chatBackgroundGroupMirror'`;
  - `async function rememberBackgroundGroup(id)` and `async function forgetBackgroundGroup()`;
  - `async function storedBackgroundGroup(): Promise<chrome.tabGroups.TabGroup | null>`;
  - `async function groupTargetWindow(): Promise<number | null>`;
  - `async function createGroupedTab(url): Promise<Tab | null>` (null means window mode);
  - `async function moveToBackgroundWindow(tab): Promise<Tab>` (used by Task 5);
  - `createChatTab(url, background, active)`: same signature, group mode when `groupsAvailable()`.

- [ ] **Step 1: Add the group harness** to `test/background-window.test.ts`, below the existing `harness` and `policy`:

```ts
type GTab = Tab & { groupId?: number; index?: number; incognito?: boolean; active?: boolean };
type Win = { id: number; type?: string; incognito?: boolean };
type Group = { id: number; windowId: number; title?: string; collapsed?: boolean; color?: string };
function groupHarness(options: { tabs?: GTab[]; windows?: Win[]; lastFocused?: number | null; groups?: Group[];
  session?: Record<string, unknown>; local?: Record<string, unknown>; noGroupsApi?: boolean; placement?: string } = {}) {
  const tabs = new Map((options.tabs ?? []).map(tab => [tab.id, { groupId: -1, ...tab }]));
  const windows = new Map((options.windows ?? [{ id: 1 }]).map(window => [window.id, { type: 'normal', ...window }]));
  const groups = new Map((options.groups ?? []).map(group => [group.id, { title: '', collapsed: false, color: 'grey', ...group }]));
  const session: Record<string, unknown> = { ...(options.session ?? {}) };
  const local: Record<string, unknown> = { ...(options.local ?? {}) };
  let next = 100;
  const nextIndex = (windowId: number) => [...tabs.values()].filter(tab => tab.windowId === windowId).length;
  const create = vi.fn(async (o: { url: string; windowId?: number; active?: boolean; index?: number }) => {
    const windowId = o.windowId ?? [...windows.keys()][0]!;
    if (!windows.has(windowId)) throw new Error(`No window with id: ${windowId}.`);
    const tab = { id: next++, windowId, url: o.url, groupId: -1, index: o.index ?? nextIndex(windowId), active: o.active === true };
    tabs.set(tab.id, tab);
    return { ...tab, pendingUrl: o.url };
  });
  const group = vi.fn(async (o: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }) => {
    let id = o.groupId;
    if (id !== undefined && !groups.has(id)) throw new Error(`No group with id: ${id}.`);
    for (const tabId of o.tabIds) if (!tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
    if (id === undefined) {
      id = next++;
      groups.set(id, { id, windowId: o.createProperties?.windowId ?? tabs.get(o.tabIds[0]!)!.windowId, title: '', collapsed: false, color: 'grey' });
    }
    for (const tabId of o.tabIds) Object.assign(tabs.get(tabId)!, { groupId: id, windowId: groups.get(id)!.windowId });
    return id;
  });
  const groupGet = vi.fn(async (id: number) => {
    if (!groups.has(id)) throw new Error(`No group with id: ${id}.`);
    return { ...groups.get(id)! };
  });
  const groupUpdate = vi.fn(async (id: number, props: object) => {
    if (!groups.has(id)) throw new Error(`No group with id: ${id}.`);
    Object.assign(groups.get(id)!, props); return { ...groups.get(id)! };
  });
  const groupQuery = vi.fn(async (q: { title?: string } = {}) =>
    [...groups.values()].filter(g => q.title === undefined || g.title === q.title).map(g => ({ ...g })));
  const query = vi.fn(async (q: { groupId?: number } = {}) =>
    [...tabs.values()].filter(tab => q.groupId === undefined || tab.groupId === q.groupId).map(tab => ({ ...tab })));
  const get = vi.fn(async (id: number) => {
    if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
    return { ...tabs.get(id)! };
  });
  const move = vi.fn(async (id: number, o: { windowId: number }) => {
    Object.assign(tabs.get(id)!, { windowId: o.windowId, groupId: -1 }); return { ...tabs.get(id)! };
  });
  const update = vi.fn(async (id: number, props: object) => ({ ...tabs.get(id)!, ...props }));
  const windowCreate = vi.fn(async (o: { url?: string; tabId?: number }) => {
    if (o.tabId !== undefined && !tabs.has(o.tabId)) throw new Error(`No tab with id: ${o.tabId}.`);
    const id = next++; windows.set(id, { id, type: 'normal' });
    if (o.tabId !== undefined) {
      Object.assign(tabs.get(o.tabId)!, { windowId: id, groupId: -1 });
      return { id, tabs: [{ ...tabs.get(o.tabId)! }] };
    }
    return { id, tabs: [await create({ url: o.url!, windowId: id })] };
  });
  const windowUpdate = vi.fn(async (id: number) => ({ id }));
  const lastFocused = vi.fn(async () => {
    const id = options.lastFocused === undefined ? [...windows.keys()][0] : options.lastFocused;
    if (id === null || id === undefined || !windows.has(id)) throw new Error('No last-focused window');
    return { ...windows.get(id)! };
  });
  const getAll = vi.fn(async () => [...windows.values()].map(window => ({ ...window })));
  const area = (store: Record<string, unknown>) => ({
    get: async () => ({ ...store }),
    set: async (values: object) => { Object.assign(store, values); },
    remove: async (key: string) => { delete store[key]; }
  });
  const chrome: Record<string, unknown> = {
    storage: { session: area(session), local: area(local) },
    tabs: { query, create, move, get, update, ...(options.noGroupsApi ? {} : { group }) },
    windows: { create: windowCreate, update: windowUpdate, getLastFocused: lastFocused, getAll,
      get: async (id: number, o?: { populate?: boolean }) => {
        if (!windows.has(id)) throw new Error(`No window with id: ${id}.`);
        return { ...windows.get(id)!, ...(o?.populate ? { tabs: [...tabs.values()].filter(tab => tab.windowId === id) } : {}) };
      } }
  };
  if (!options.noGroupsApi) chrome.tabGroups = { get: groupGet, update: groupUpdate, query: groupQuery };
  const api = vm.runInNewContext(`${code}\n({ createChatTab, reconcileBackgroundWindow, setBackgroundPlacement })`, {
    URL, URLSearchParams, Promise, isChatGptUrl: (value: string) => /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(value),
    cleanConversationId: (value: unknown) => typeof value === 'string' ? value : null,
    conversationForTab: (tab: Tab) => new URL(tab.url).pathname.match(/^\/c\/(.+)$/)?.[1] ?? null,
    chrome
  }) as { createChatTab(url: string, background: boolean, active?: boolean): Promise<GTab>;
    reconcileBackgroundWindow(policy: object): Promise<boolean>; setBackgroundPlacement(value: unknown): boolean };
  api.setBackgroundPlacement(options.placement ?? 'group');
  return { ...api, tabs, windows, groups, session, local, create, group, groupGet, groupUpdate, groupQuery, query, get, move, update,
    windowCreate, windowUpdate, lastFocused, getAll };
}
const TITLE = 'Chat On Steroids';
```

- [ ] **Step 2: Write the failing placement tests** (same file, below the harness):

```ts
it('4.1 creates one collapsed titled group in the last-focused window for the first background tab', async () => {
  const app = groupHarness({ windows: [{ id: 1 }, { id: 2 }], lastFocused: 2,
    tabs: [{ id: 1, windowId: 2, url: 'https://example.com/', active: true }] });
  const tab = await app.createChatTab('https://chatgpt.com/?cos-input=a', true);
  expect(app.create).toHaveBeenCalledWith({ url: 'https://chatgpt.com/?cos-input=a', windowId: 2, active: false });
  expect(app.group).toHaveBeenCalledWith({ tabIds: [tab.id], createProperties: { windowId: 2 } });
  const groupId = app.tabs.get(tab.id)!.groupId!;
  expect(app.groupUpdate).toHaveBeenCalledExactlyOnceWith(groupId, { title: TITLE, color: 'grey', collapsed: true });
  expect(app.session.chatBackgroundGroup).toBe(groupId);
  expect(app.local.chatBackgroundGroupMirror).toBe(groupId);
  expect(app.windowCreate).not.toHaveBeenCalled();
  expect(app.windowUpdate).not.toHaveBeenCalled();
  expect(app.update).not.toHaveBeenCalled();
});

it('4.2 adds later tabs right after the group without re-collapsing a group the user expanded', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], tabs: [{ id: 1, windowId: 1, url: 'https://example.com/', index: 0 }] });
  const first = await app.createChatTab('https://chatgpt.com/?cos-input=a', true);
  const groupId = app.tabs.get(first.id)!.groupId!;
  app.groups.get(groupId)!.collapsed = false; // the user expanded it and is reading
  const second = await app.createChatTab('https://chatgpt.com/?cos-input=b', true);
  expect(app.create).toHaveBeenLastCalledWith({ url: 'https://chatgpt.com/?cos-input=b', windowId: 1, active: false,
    index: app.tabs.get(first.id)!.index! + 1 });
  expect(app.group).toHaveBeenLastCalledWith({ groupId, tabIds: [second.id] });
  expect(app.groupUpdate).toHaveBeenCalledTimes(1);
  expect(app.groups.get(groupId)!.collapsed).toBe(false);
});

it('4.3 never creates an active tab in group mode, even when a caller asks for one', async () => {
  const app = groupHarness();
  await app.createChatTab('https://chatgpt.com/c/recovered', true, true);
  expect(app.create).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
  expect(app.update).not.toHaveBeenCalled();
});

it.each([
  ['the background window', 5],
  ['an incognito window', 6]
])('4.4 never places the group in %s', async (_name, focused) => {
  const app = groupHarness({ windows: [{ id: 5 }, { id: 6, incognito: true }, { id: 7 }], lastFocused: focused,
    session: { chatBackgroundWindow: 5 } });
  await app.createChatTab('https://chatgpt.com/?cos-input=a', true);
  expect(app.create).toHaveBeenCalledWith(expect.objectContaining({ windowId: 7 }));
  expect(app.group).toHaveBeenCalledWith(expect.objectContaining({ createProperties: { windowId: 7 } }));
});

it('4.5 uses the background window when it is the only normal window', async () => {
  const app = groupHarness({ windows: [{ id: 5 }], lastFocused: 5, session: { chatBackgroundWindow: 5 } });
  await app.createChatTab('https://chatgpt.com/?cos-input=a', true);
  expect(app.create).toHaveBeenCalledWith({ url: 'https://chatgpt.com/?cos-input=a', windowId: 5, active: false });
  expect(app.group).not.toHaveBeenCalled();
  expect(app.groupUpdate).not.toHaveBeenCalled();
});

it.each([
  ['no normal window at all', { windows: [], lastFocused: null }],
  ['no tab-group API', { noGroupsApi: true }],
  ['the window placement', { placement: 'window' }],
  ['an unknown placement', { placement: 'sidebar' }]
])('4.6 opens the minimized background window with %s', async (_name, options) => {
  const app = groupHarness(options as Parameters<typeof groupHarness>[0]);
  const tab = await app.createChatTab('https://chatgpt.com/?cos-input=a', true);
  expect(app.windowCreate).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://chatgpt.com/?cos-input=a', focused: false }));
  expect(app.windowUpdate).toHaveBeenCalledWith(tab.windowId, { state: 'minimized', focused: false });
  expect(app.group).not.toHaveBeenCalled();
});

it('4.7 serializes concurrent first tabs into one group', async () => {
  const app = groupHarness();
  const [a, b] = await Promise.all([app.createChatTab('https://chatgpt.com/?a', true), app.createChatTab('https://chatgpt.com/?b', true)]);
  expect(app.group.mock.calls.filter(([o]) => o.createProperties)).toHaveLength(1);
  expect(app.tabs.get(a.id)!.groupId).toBe(app.tabs.get(b.id)!.groupId);
  expect(app.groupUpdate).toHaveBeenCalledTimes(1);
});

it('4.8 follows the group to the window the user dragged it to', async () => {
  const app = groupHarness({ windows: [{ id: 1 }, { id: 3 }], lastFocused: 1 });
  const first = await app.createChatTab('https://chatgpt.com/?a', true);
  const groupId = app.tabs.get(first.id)!.groupId!;
  app.groups.get(groupId)!.windowId = 3; app.tabs.get(first.id)!.windowId = 3;
  await app.createChatTab('https://chatgpt.com/?b', true);
  expect(app.create).toHaveBeenLastCalledWith(expect.objectContaining({ windowId: 3 }));
  expect(app.group).toHaveBeenLastCalledWith(expect.objectContaining({ groupId }));
});

it('4.9 leaves foreground tabs alone in group mode', async () => {
  const app = groupHarness();
  await app.createChatTab('https://chatgpt.com/?cos-input=a', false, true);
  expect(app.create).toHaveBeenCalledWith({ url: 'https://chatgpt.com/?cos-input=a', active: true });
  expect(app.group).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run test/background-window.test.ts`
Expected:
- the new tests FAIL: the slice has no `setBackgroundPlacement` until Task 3 lands, and after it, `createChatTab` still opens a window;
- 4.6 and 4.9 may already pass, which is fine: they pin unchanged behavior;
- the existing tests PASS.

- [ ] **Step 4: Implement the group helpers and placement.** In `extension/background.js`, after `storedBackgroundWindow`:

```js
/**
 * The app's tab group in tab-group mode (#128). Like the window, its id is kept in session storage
 * and mirrored to local storage, because every self-update reloads this worker. A mirrored id is
 * only trusted while the group still carries the app's title: group ids are per browser session,
 * onStartup drops the mirror, and a group the user renamed is theirs now.
 */
const BACKGROUND_GROUP_TITLE = 'Chat On Steroids';
const BACKGROUND_GROUP_MIRROR = 'chatBackgroundGroupMirror';
async function rememberBackgroundGroup(id) {
  await chrome.storage.session.set({ chatBackgroundGroup: id });
  await chrome.storage.local.set({ [BACKGROUND_GROUP_MIRROR]: id });
}
async function forgetBackgroundGroup() {
  await chrome.storage.session.remove('chatBackgroundGroup');
  await chrome.storage.local.remove(BACKGROUND_GROUP_MIRROR);
}
async function storedBackgroundGroup() {
  const { chatBackgroundGroup: current } = await chrome.storage.session.get('chatBackgroundGroup');
  const id = Number.isInteger(current) ? current : (await chrome.storage.local.get(BACKGROUND_GROUP_MIRROR))[BACKGROUND_GROUP_MIRROR];
  if (!Number.isInteger(id)) return null;
  try {
    const group = await chrome.tabGroups.get(id);
    if (!Number.isInteger(group?.windowId)) throw new Error('group_without_window');
    if (!Number.isInteger(current)) {
      if (group.title !== BACKGROUND_GROUP_TITLE) { await chrome.storage.local.remove(BACKGROUND_GROUP_MIRROR); return null; }
      await chrome.storage.session.set({ chatBackgroundGroup: id });
    }
    return group;
  } catch { await forgetBackgroundGroup(); return null; }
}
/**
 * Where a new group goes: the user's last-focused normal window, never the app's own background
 * window and never an incognito one. Otherwise the lowest such window, otherwise none (window mode).
 */
async function groupTargetWindow() {
  const excluded = (await storedBackgroundWindow())?.id;
  const eligible = window => Number.isInteger(window?.id) && window.type === 'normal' && window.incognito !== true && window.id !== excluded;
  try {
    const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (eligible(last)) return last.id;
  } catch { /* No focused window yet; fall through to any eligible one. */ }
  const all = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
  const [first] = (Array.isArray(all) ? all : []).filter(eligible).sort((a, b) => a.id - b.id);
  return first?.id ?? null;
}
/**
 * One inactive tab in the app's group, creating the group collapsed the first time. Only a group
 * made here is collapsed: collapsing one that holds the window's active tab would switch the
 * user's tab. Null hands the tab to window mode before anything was created.
 */
async function createGroupedTab(url) {
  let group = await storedBackgroundGroup();
  const windowId = group ? group.windowId : await groupTargetWindow();
  if (!Number.isInteger(windowId)) return null;
  const members = group ? await chrome.tabs.query({ groupId: group.id }).catch(() => []) : [];
  const indexes = (Array.isArray(members) ? members : []).filter(tab => tab.windowId === windowId && Number.isInteger(tab.index)).map(tab => tab.index);
  const tab = await chrome.tabs.create({ url, windowId, active: false, ...(indexes.length ? { index: Math.max(...indexes) + 1 } : {}) });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (group) {
        await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] });
        return { ...tab, windowId: group.windowId };
      }
      const created = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId ?? windowId } });
      await rememberBackgroundGroup(created);
      const titled = await chrome.tabGroups.update(created, { title: BACKGROUND_GROUP_TITLE, color: 'grey', collapsed: true });
      return { ...tab, windowId: titled?.windowId ?? tab.windowId ?? windowId };
    } catch {
      // The group vanished or moved under us. Start one fresh in the tab's window, once.
      await forgetBackgroundGroup().catch(() => undefined);
      group = null;
    }
  }
  return moveToBackgroundWindow(tab);
}
```

Task 4 adds `moveToBackgroundWindow` too, because `createGroupedTab` references it. Task 5 tests it:

```js
/** Last resort for a tab grouping could not place: the app's minimized window, never the user's strip. */
async function moveToBackgroundWindow(tab) {
  const existing = await storedBackgroundWindow();
  if (existing) {
    await chrome.tabs.move(tab.id, { windowId: existing.id, index: -1 });
    return { ...tab, windowId: existing.id };
  }
  const window = await chrome.windows.create({ tabId: tab.id, type: 'normal', ...backgroundWindowBounds, focused: false });
  if (!Number.isInteger(window?.id)) throw new Error('background_window_not_ready');
  await rememberBackgroundWindow(window.id);
  await chrome.windows.update(window.id, { state: 'minimized', focused: false });
  return { ...tab, windowId: window.id };
}
```

`createChatTab` becomes:

```js
/** Only app-owned windows are sized; no tab placement changes window focus/state. */
async function createChatTab(url, background = false, active = !background) {
  if (!background) return chrome.tabs.create({ url, active });
  return inBackgroundWindow(async () => {
    if (groupsAvailable()) {
      // A grouped tab is always inactive: selecting it would switch the user's own window.
      const grouped = await createGroupedTab(url);
      if (grouped) return grouped;
    }
    const existing = await storedBackgroundWindow();
    ...unchanged...
  });
}
```

- [ ] **Step 5: Run and watch all background-window tests pass**

Run: `npx vitest run test/background-window.test.ts`
Expected: PASS, the new tests and the existing ones.

- [ ] **Step 6: Commit**

```bash
git add extension/background.js test/background-window.test.ts
git commit -m "feat(extension): put background tabs into a collapsed tab group in group mode (#128)"
```

---

### Task 5: Failure handling during placement

**Files:**
- Test: `test/background-window.test.ts`
- Modify: `extension/background.js` only if a test exposes a gap. The code from Task 4 is expected to satisfy these tests. They pin it, and they are watched RED by temporarily breaking the guarded line (the step says which).

**Interfaces:**
- Consumes: `createGroupedTab`, `moveToBackgroundWindow` (Task 4).

- [ ] **Step 1: Write the tests**

```ts
it('5.1 starts a fresh group once when the stored group vanished mid-placement', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 50, windowId: 1, title: TITLE }],
    session: { chatBackgroundGroup: 50 }, local: { chatBackgroundGroupMirror: 50 } });
  app.group.mockImplementationOnce(async () => { app.groups.delete(50); throw new Error('No group with id: 50.'); });
  const tab = await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.group.mock.calls.map(([o]) => o.groupId ?? 'new')).toEqual([50, 'new']);
  const fresh = app.tabs.get(tab.id)!.groupId!;
  expect(fresh).not.toBe(50);
  expect(app.session.chatBackgroundGroup).toBe(fresh);
  expect(app.local.chatBackgroundGroupMirror).toBe(fresh);
  expect(app.groups.get(fresh)).toMatchObject({ title: TITLE, collapsed: true });
});

it('5.2 moves the tab into a new minimized window when grouping fails twice', async () => {
  const app = groupHarness({ windows: [{ id: 1 }] });
  app.group.mockRejectedValue(new Error('Grouping is not supported in this window.'));
  const tab = await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.windowCreate).toHaveBeenCalledWith({ tabId: tab.id, type: 'normal', width: 800, height: 600, focused: false });
  expect(app.windowUpdate).toHaveBeenCalledWith(tab.windowId, { state: 'minimized', focused: false });
  expect(app.tabs.get(tab.id)!.windowId).toBe(tab.windowId);
  expect(tab.windowId).not.toBe(1);
  expect(app.session.chatBackgroundWindow).toBe(tab.windowId);
  expect(app.session.chatBackgroundGroup).toBeUndefined();
});

it('5.3 moves the tab into the existing background window when grouping fails twice', async () => {
  const app = groupHarness({ windows: [{ id: 1 }, { id: 5 }], lastFocused: 1, session: { chatBackgroundWindow: 5 } });
  app.group.mockRejectedValue(new Error('Grouping is not supported in this window.'));
  const tab = await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.move).toHaveBeenCalledWith(tab.id, { windowId: 5, index: -1 });
  expect(app.windowCreate).not.toHaveBeenCalled();
  expect(app.windowUpdate).not.toHaveBeenCalled();
});

it('5.4 reports a tab that vanished before it could be placed', async () => {
  const app = groupHarness({ windows: [{ id: 1 }] });
  app.group.mockImplementation(async ({ tabIds }) => { app.tabs.delete(tabIds[0]); throw new Error(`No tab with id: ${tabIds[0]}.`); });
  await expect(app.createChatTab('https://chatgpt.com/?a', true)).rejects.toThrow(/No tab with id/);
});

it('5.5 recovers from a failed title update by starting a fresh group in the same window', async () => {
  const app = groupHarness({ windows: [{ id: 1 }] });
  app.groupUpdate.mockImplementationOnce(async (id: number) => { app.groups.delete(id); throw new Error(`No group with id: ${id}.`); });
  const tab = await app.createChatTab('https://chatgpt.com/?a', true);
  const groupId = app.tabs.get(tab.id)!.groupId!;
  expect(app.groups.get(groupId)).toMatchObject({ title: TITLE, collapsed: true });
  expect(app.session.chatBackgroundGroup).toBe(groupId);
});
```

Add one more:

```ts
it('5.6 forgets a stored group that refused a tab, so the next placement does not retry it', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 50, windowId: 1, title: TITLE }],
    session: { chatBackgroundGroup: 50 }, local: { chatBackgroundGroupMirror: 50 } });
  app.group.mockRejectedValue(new Error('Grouping is not supported in this window.'));
  await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.session.chatBackgroundGroup).toBeUndefined();
  expect(app.local.chatBackgroundGroupMirror).toBeUndefined();
});
```

- [ ] **Step 2: Watch each fail for the right reason** by temporarily breaking the guarded code, one at a time. Revert each break before the next.
  - Change `attempt < 2` to `attempt < 1`. Expect 5.1 and 5.5 FAIL (the tab moves to a window instead).
  - Replace `return moveToBackgroundWindow(tab);` with `return tab;`. Expect 5.2 and 5.3 FAIL.
  - Remove `await forgetBackgroundGroup()...` in the catch. Expect 5.6 FAIL (50 stays stored).

  Run each time: `npx vitest run test/background-window.test.ts -t "^5\."`

- [ ] **Step 3: Restore the code and watch everything pass**

Run: `npx vitest run test/background-window.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/background-window.test.ts extension/background.js
git commit -m "test(extension): pin tab-group placement fallbacks (#128)"
```

---

### Task 6: Identity across reloads and restarts; reconcile in group mode

**Files:**
- Modify: `extension/background.js`:
  - `reconcileBackgroundWindow`;
  - new `adoptBackgroundGroup`;
  - the `onStartup` listener (near line 5031).
- Test: `test/background-window.test.ts`, `test/extension.test.ts`

**Interfaces:**
- Consumes: `storedBackgroundGroup`, `rememberBackgroundGroup`, `BACKGROUND_GROUP_TITLE`, `BACKGROUND_GROUP_MIRROR`, `groupsAvailable`.
- Produces:
  - `async function adoptBackgroundGroup(owns): Promise<boolean>`;
  - `reconcileBackgroundWindow(policy)` returns `true` when a group is stored or adopted, in group mode.

- [ ] **Step 1: Write the failing tests** (`test/background-window.test.ts`):

```ts
const MAIN = 'https://chatgpt.com/c/main';
it('6.1 keeps using a mirrored group after an extension reload while it carries the title', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 50, windowId: 1, title: TITLE }],
    tabs: [{ id: 1, windowId: 1, url: MAIN, groupId: 50, index: 0 }], local: { chatBackgroundGroupMirror: 50 } });
  await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.group).toHaveBeenCalledWith({ groupId: 50, tabIds: [expect.any(Number)] });
  expect(app.session.chatBackgroundGroup).toBe(50);
});

it('6.2 lets go of a mirrored group the user renamed and starts its own', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 50, windowId: 1, title: 'Research' }],
    tabs: [{ id: 1, windowId: 1, url: MAIN, groupId: 50, index: 0 }], local: { chatBackgroundGroupMirror: 50 } });
  const tab = await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.tabs.get(tab.id)!.groupId).not.toBe(50);
  expect(app.groups.get(50)!.title).toBe('Research');
  expect(app.local.chatBackgroundGroupMirror).toBe(app.tabs.get(tab.id)!.groupId);
});

it('6.3 adopts a restored all-app titled group after a browser restart', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 60, windowId: 1, title: TITLE }],
    tabs: [{ id: 1, windowId: 1, url: MAIN, groupId: 60, index: 0 }, { id: 2, windowId: 1, url: 'https://example.com/', index: 1 }] });
  expect(await app.reconcileBackgroundWindow(policy)).toBe(true);
  expect(app.session.chatBackgroundGroup).toBe(60);
  await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.group).toHaveBeenCalledExactlyOnceWith({ groupId: 60, tabIds: [expect.any(Number)] });
});

it.each([
  ['holds a personal tab', [{ id: 1, windowId: 1, url: MAIN, groupId: 60 }, { id: 2, windowId: 1, url: 'https://example.com/', groupId: 60 }], TITLE],
  ['carries another title', [{ id: 1, windowId: 1, url: MAIN, groupId: 60 }], 'Chat On Steroids (2)'],
  ['is empty', [], TITLE]
])('6.4 never adopts a group that %s', async (_name, tabs, title) => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 60, windowId: 1, title }], tabs: tabs as GTab[] });
  expect(await app.reconcileBackgroundWindow(policy)).toBe(false);
  expect(app.session.chatBackgroundGroup).toBeUndefined();
});

it('6.5 never moves or regroups tabs in group mode, even with an old background window around', async () => {
  const app = groupHarness({ windows: [{ id: 1 }, { id: 9 }], lastFocused: 1, groups: [{ id: 60, windowId: 1, title: TITLE }],
    session: { chatBackgroundWindow: 9, chatBackgroundGroup: 60 },
    tabs: [{ id: 1, windowId: 1, url: MAIN, groupId: 60 }, { id: 2, windowId: 9, url: 'https://chatgpt.com/c/worker' },
      { id: 3, windowId: 1, url: 'https://chatgpt.com/c/worker' }] });
  expect(await app.reconcileBackgroundWindow(policy)).toBe(true);
  expect(app.move).not.toHaveBeenCalled();
  expect(app.group).not.toHaveBeenCalled();
});

it('6.6 adopts in group mode even with Background chats off, so helper tabs reuse the group', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 60, windowId: 1, title: TITLE }],
    tabs: [{ id: 1, windowId: 1, url: 'https://chatgpt.com/?cos-model-catalog=11111111-1111-1111-1111-111111111111', groupId: 60 }] });
  expect(await app.reconcileBackgroundWindow({ background: false })).toBe(true);
  expect(app.session.chatBackgroundGroup).toBe(60);
});

it('6.7 adopts the lowest of two qualifying groups', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 61, windowId: 1, title: TITLE }, { id: 60, windowId: 1, title: TITLE }],
    tabs: [{ id: 1, windowId: 1, url: MAIN, groupId: 61 }, { id: 2, windowId: 1, url: 'https://chatgpt.com/c/worker', groupId: 60 }] });
  await app.reconcileBackgroundWindow(policy);
  expect(app.session.chatBackgroundGroup).toBe(60);
});

it('6.8 keeps today\'s window reconcile with the window placement', async () => {
  const app = groupHarness({ placement: 'window', windows: [{ id: 9 }, { id: 10 }], session: { chatBackgroundWindow: 10 },
    tabs: [{ id: 1, windowId: 9, url: MAIN }, { id: 2, windowId: 10, url: 'https://chatgpt.com/c/worker' }] });
  await app.reconcileBackgroundWindow(policy);
  expect(app.move).toHaveBeenCalledWith(1, { windowId: 10, index: -1 });
  expect(app.groupQuery).not.toHaveBeenCalled();
});
```

In `test/extension.test.ts`, next to "forgets the mirrored Background chats window when the browser starts":

```ts
  it('forgets the mirrored tab group when the browser starts', async () => {
    const local = new FakeStorageArea({ ...paired, chatBackgroundGroupMirror: 50 });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: vi.fn(async () => response(404, {})) });
    await worker.startup();
    expect((await local.get('chatBackgroundGroupMirror')).chatBackgroundGroupMirror).toBeUndefined();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/background-window.test.ts -t "^6\." && npx vitest run test/extension.test.ts -t "mirrored tab group"`
Expected:
- 6.3, 6.6 and 6.7 FAIL (no adoption);
- 6.5 FAILS (the window reconcile moves tab 3 into window 9);
- the startup test FAILS;
- 6.1, 6.2, 6.4 and 6.8 may pass already (Task 4 code), which is fine: they pin it.

- [ ] **Step 3: Implement.** Replace the start of `reconcileBackgroundWindow`:

```js
async function reconcileBackgroundWindow(policy) {
  const grouped = groupsAvailable();
  // Helper tabs (model catalog, successor chats) are background even with Background chats off,
  // so group mode re-finds its group either way. Window mode keeps today's gate.
  if (policy.background !== true && !grouped) return;
  const managed = ...unchanged...
  const inputIds = ...unchanged...
  const owns = ...unchanged...
  // #128: group mode never moves tabs. Tabs the user dragged out stay out, and nothing is pulled
  // into or out of the user's own window; only the group itself is re-found.
  if (grouped) return inBackgroundWindow(() => adoptBackgroundGroup(owns));
  return inBackgroundWindow(async () => { ...unchanged... });
}

/** Re-finds the app's group after an extension reload or a browser restart that restored it. */
async function adoptBackgroundGroup(owns) {
  if (await storedBackgroundGroup()) return true;
  let groups = [];
  try { groups = await chrome.tabGroups.query({ title: BACKGROUND_GROUP_TITLE }); } catch { return false; }
  const tabs = await chrome.tabs.query({});
  // Chrome matches the title as a pattern; only the exact title counts, and the oldest group wins.
  for (const group of (Array.isArray(groups) ? groups : []).filter(group => group?.title === BACKGROUND_GROUP_TITLE).sort((a, b) => a.id - b.id)) {
    const members = tabs.filter(tab => tab.groupId === group.id);
    // Any tab the app does not own makes it the user's group.
    if (!members.length || members.some(tab => tab.incognito === true || !owns(tab))) continue;
    const window = await chrome.windows.get(group.windowId).catch(() => null);
    if (window?.type !== 'normal' || window.incognito === true) continue;
    await rememberBackgroundGroup(group.id);
    return true;
  }
  return false;
}
```

In the `onStartup` listener, next to the window mirror removal:

```js
    // Tab-group ids are per browser session too (#128).
    void chrome.storage.local.remove(BACKGROUND_GROUP_MIRROR).catch(() => undefined);
```

- [ ] **Step 4: Run and watch them pass, plus the whole extension suite**

Run: `npx vitest run test/background-window.test.ts test/extension.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/background.js test/background-window.test.ts test/extension.test.ts
git commit -m "feat(extension): re-find the app's tab group after reloads and restarts; never move tabs in group mode (#128)"
```

---

### Task 7: Compaction focus in group mode

**Files:**
- Modify: `extension/background.js` (repair loop, `if (target && focus)` near line 3071)
- Test: `test/extension.test.ts`

**Interfaces:**
- Consumes: `backgroundPlacement`, `storedBackgroundWindow`.

- [ ] **Step 1: Write the failing test** (in `test/extension.test.ts`, right after "selects the repair tab before reload without activating the Chrome window", whose fixture it follows; the harness puts registered tabs in window 7):

```ts
  it.each([
    ['window placement selects the tab, as before', 'window', 9, true],
    ['group placement leaves a tab in the user\'s window unselected', 'group', 9, false],
    ['group placement still selects a tab inside the background window', 'group', 7, true]
  ])('compaction repair focus: %s (#128)', async (_name, placement, backgroundWindow, selected) => {
    let token = '';
    let done = false;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/closed') return response(200, { ok: true });
      if (url.pathname === '/status') {
        if (token && url.searchParams.get('repaired') === token) done = true;
        if (done) return response(200, { ok: true, repairs: [], backgroundPlacement: placement });
        token = 'tok-1';
        return response(200, { ok: true, repairs: [{ conversationId: CHAT, token, focus: true }], backgroundPlacement: placement });
      }
      return response(404, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ chatBackgroundWindow: backgroundWindow }),
      fetch,
      windowsGet: async (windowId: number) => ({ id: windowId, type: 'normal', focused: false } as { focused?: boolean })
    });
    await worker.registerTab(51);
    await worker.send({ type: 'bind', conversationId: CHAT }, 51);
    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledWith(51);
    expect(worker.tabsUpdate.mock.calls.some(([id, change]) => id === 51 && (change as { active?: boolean }).active === true)).toBe(selected);
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/extension.test.ts -t "compaction repair focus"`
Expected: row 2 FAILS (the tab is selected); rows 1 and 3 PASS (they pin today's behavior and the background-window exception).

- [ ] **Step 3: Implement**

```js
      // Select the working tab within Chrome without stealing OS focus from the
      // desktop app. Tab selection and window activation are separate operations.
      // In tab-group mode the tab sits in the user's own window, where selecting it would switch
      // what they are looking at (#128); only the app's background window is ours to select in.
      if (target && focus && (backgroundPlacement !== 'group' ||
          target.windowId === (await storedBackgroundWindow().catch(() => null))?.id)) {
        await chrome.tabs.update(target.id, { active: true });
      }
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run test/extension.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/background.js test/extension.test.ts
git commit -m "fix(extension): compaction never selects a tab in the user's window in group mode (#128)"
```

---

### Task 8: Documentation, full suite, UI checks

**Files:**
- Modify: `AGENTS.md`:
  - the defaults table row "Background chats" (line ~212);
  - the follow paragraph (~2342);
  - the background-window paragraph (~2367).
- Modify: `docs/setup.md`: the Background chats mention (grep first; if absent, add one short paragraph under the browser section).

- [ ] **Step 1: AGENTS.md.** After the Background chats row, add a row:

```markdown
| Background placement | Window. | `ui.backgroundPlacement` `'window'` / `'group'`, published in `/status`. Group mode puts every background tab in one collapsed "Chat On Steroids" tab group in the last-focused normal window (never the background window, never incognito), then keeps using it; failures fall back to the minimized window. No follow and no compaction tab selection in the user's window. |
```

Append to the follow paragraph: "With `backgroundPlacement: 'group'` the app sends no follow and the extension ignores one (#128)."

After the background-window paragraph, add a short paragraph on group identity:
- session ID plus local mirror with a title check;
- dropped `onStartup`;
- re-adoption only of an exactly titled, all-app-owned group in a normal window;
- reconcile never moves tabs in group mode;
- the group closes with its last tab, which deletes Chrome's saved copy.

- [ ] **Step 2: docs/setup.md.** One paragraph: what the option does, the auto-save note, the fallback.

- [ ] **Step 3: Full verification**

```bash
npm run typecheck
npx vitest run > .superpowers/sdd/2026-10-11-tab-group-placement/suite.log 2>&1; tail -5 .superpowers/sdd/2026-10-11-tab-group-placement/suite.log
npm run build && npm run verify:ui
```

Expected:
- typecheck is clean;
- every test passes (8121+ as on the app-ID branch, plus the new ones);
- `50 of 50 UI checks passed`.

Any failure is investigated before Task 9. A pre-existing failure counts only after a clean upstream/main run in a fresh worktree.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/setup.md
git commit -m "docs: tab-group placement (#128)"
```

---

### Task 9: Live verification on both platforms

No product code changes unless a check fails. Each failure gets a RED test first, then a fix, then the check is re-run. Every check is logged in the ledger with its result.

**Setup:**
- Build the dev app on the Mac and deploy it to VM 141 the usual way (install-canary flow, with the tunnels from the windows-test-vm memory, never Mac port 9333).
- After the deploy, reload the extension on both machines (on the Mac, also in normal Chrome Profile 1).
- On the Mac, use the user's real Chrome:
  - restore the setting to "window" at the end;
  - do not touch the user's own tabs or groups beyond observing them;
  - close any test group the checks create.

The checks, on each platform:
1. **Setting and first worker.** Set "A tab group in your browser window" and start one worker with an explicit harmless prompt ("Reply with the word grouped-1 and nothing else.").
   - Expected: a collapsed grey "Chat On Steroids" group in the last-focused window;
   - the user's active tab is unchanged (screenshot before and after);
   - the worker answers.
2. **Goal and Compact & Resume.** Run a Goal end to end with a harmless goal, and a Compact & Resume on that chat, all in group mode.
   - Expected: identical to window mode, and no tab selection in the user's window.
3. **Two workers at once.** Expected: one group with two tabs.
4. **Expanded group.** Expand the group and click a chat in it, then start another worker.
   - Expected: the new tab joins, nothing re-collapses, and the active tab stays the one clicked.
5. **Idle closing.** Wait until the chats are done and more than 5 minutes have passed.
   - Expected: the tabs close and the group disappears;
   - Chrome's tab-groups menu (and the bookmarks bar "Tab groups" item) shows no saved "Chat On Steroids";
   - screenshot.
6. **Drag out, drag in.** Drag one app tab out of the group (it stays out, then closes by idle), and drag a personal tab in (the app never closes it).
7. **Close the window mid-run.** Close the group's window during a run.
   - Expected: the app reports a user close, as when the background window closes;
   - the next worker creates a new group in the now last-focused window.
8. **Extension reload.** Reload the extension during a session with an open group.
   - Expected: the next worker joins the same group (log or screenshot).
9. **Browser restart with restore.** Restart the browser with "Continue where you left off".
   - Expected: the group is re-adopted, with no second group.
10. **Long idle.** Leave the collapsed group idle for at least 10 minutes, then wake a worker.
    - Expected: it sends (via the frozen-tab path if needed).
11. **The 188 s outlier.** Run 10 back-to-back first sends right after group creation (each a new worker, ≥1 min apart for pacing), and record each send time.
    - Expected: all within the window-mode range (≤ 30 s).
    - Any outlier gets traced (extension worker network log and tab console) before anything else continues.
12. **Back to window mode.** Expected: new tabs go to the minimized window as before.

Before the PR: English before/after screenshots of Settings → Browser (VM app switched to English, then back to de), plus a screenshot of the collapsed group in the tab strip. Show them to the user before merging.

---

## Execution notes

- **Ledger:** `.superpowers/sdd/2026-10-11-tab-group-placement/progress.md`. It is not git-ignored in this repo, so never stage it.
- **Final whole-branch review:** after Task 8, before Task 9, with the review package. Findings get fixed RED→GREEN before the live round.
- **Merge:** the PR goes up only after Haz4rdovisk has approved the design (asked on GitHub before building) and the user has seen the screenshots.
