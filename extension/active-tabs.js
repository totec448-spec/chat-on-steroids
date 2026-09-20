/** Lightweight rendering leases. The bridge/operation owns activity, never this module. */
export function createActiveTabs(chrome) {
  const KEY = 'cosActiveTabs';
  const scopes = new Map(), states = new Map(), retiring = new Set(), cancelled = new Map();
  let syncing = null, again = false;
  const valid = tab => Number.isInteger(tab?.id) && tab.id > 0 && typeof tab.url === 'string' &&
    tab.url.length <= 4096 && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url) && !tab.pendingUrl;
  const save = () => chrome.storage.session.set({ [KEY]: [...states.values(), ...retiring]
    .filter(s => s.attached || s.failed).map(s => ({ id: s.id, url: s.url, attached: s.attached, failed: s.failed === true })) });
  const loaded = (async () => {
    // Persisted attachment custody permits cleanup only. Fresh policy must earn a new lease.
    const stored = (await chrome.storage.session.get(KEY))[KEY];
    for (const tab of (Array.isArray(stored) ? stored : []).slice(0, 64)) {
      if (!valid(tab)) continue;
      if (tab.attached) retiring.add({ id: tab.id, url: tab.url, attached: true });
      if (tab.failed) cancelled.set(tab.id, tab.url);
    }
  })();
  async function detach(state) {
    if (!state.attached) return;
    try { await chrome.debugger.detach({ tabId: state.id }); }
    catch {
      const targets = await chrome.debugger.getTargets();
      if (targets.some(t => t.tabId === state.id && t.attached)) throw new Error('Active tab release remains pending');
    }
    state.attached = false;
  }
  function current(state) { return states.get(state.id) === state && !state.cancelled; }
  async function attach(state) {
    if (cancelled.get(state.id) === state.url) state.failed = true;
    if (state.attached || state.failed || !current(state)) return;
    const tab = await chrome.tabs.get(state.id).catch(() => null);
    if (!current(state) || !valid(tab) || tab.url !== state.url) return;
    // A foreign debugger (including the browser tools) keeps its own session. Never steal it.
    state.attaching = true;
    try { await chrome.debugger.attach({ tabId: state.id }, '1.3'); }
    catch { state.failed = true; return; }
    finally { state.attaching = false; }
    state.attached = true;
    try {
      await save();
      const latest = await chrome.tabs.get(state.id);
      if (!current(state) || !valid(latest) || latest.url !== state.url) throw new Error('Tab changed');
      await chrome.debugger.sendCommand({ tabId: state.id }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      if (!current(state)) throw new Error('Activity ended');
    } catch {
      state.failed = true;
      await detach(state);
    }
  }
  function sync() {
    if (syncing) { again = true; return syncing; }
    syncing = (async () => {
      await loaded;
      do {
        again = false;
        for (const state of retiring) {
          await detach(state);
          retiring.delete(state);
        }
        for (const [id, url] of cancelled) if (states.get(id)?.url !== url) cancelled.delete(id);
        // No DOM, Runtime, Network, screenshots, artificial input or polling domains.
        for (const state of states.values()) await attach(state);
        await save();
      } while (again);
    })().finally(() => { syncing = null; });
    return syncing;
  }
  function project() {
    const wanted = new Map();
    for (const scope of scopes.values()) for (const tab of scope.tabs) if (valid(tab) && wanted.size < 64) wanted.set(tab.id, tab);
    for (const [id, state] of states) {
      if (wanted.get(id)?.url === state.url) continue;
      state.cancelled = true;
      states.delete(id);
      if (state.attached || state.attaching) retiring.add(state);
    }
    for (const [id, tab] of wanted) if (!states.has(id)) states.set(id, { id, url: tab.url, attached: false, failed: false });
    return sync();
  }
  return {
    // These are projections of existing owners, not persisted activity or opening authority.
    set(scope, tabs, eligible = null) {
      if (tabs.length) scopes.set(scope, { tabs: tabs.filter(valid).slice(0, 64), eligible });
      else scopes.delete(scope);
      return project();
    },
    owns(id) { return states.has(id) || [...retiring].some(s => s.id === id); },
    revoke() { scopes.clear(); return project(); },
    navigation(id, tab = null) {
      if (!states.has(id) && ![...retiring].some(s => s.id === id)) return Promise.resolve();
      let retained = false;
      for (const scope of scopes.values()) {
        const keep = scope.tabs.some(previous => previous.id === id) && tab?.id === id && valid(tab) && scope.eligible?.(tab) === true;
        scope.tabs = scope.tabs.flatMap(previous => previous.id !== id ? [previous] : keep ? [tab] : []);
        retained ||= keep;
      }
      // SPA routing keeps the browser document. Its existing owner can approve
      // the new route without suspending rendering during native New Chat.
      // Full document loads pass no tab and always release the old lease.
      const state = states.get(id);
      if (retained && state) {
        if (cancelled.get(id) === state.url) cancelled.set(id, tab.url);
        state.url = tab.url;
      }
      return project();
    },
    detached({ tabId }) {
      // Our own release can notify before its promise settles. It belongs to the retired
      // attachment, never a freshly projected successor at the same tab id.
      const old = [...retiring].find(s => s.id === tabId && s.attached);
      if (old) { old.attached = false; return sync(); }
      // Chrome/user cancellation lasts until this activity scope ends. No attach loop.
      const state = states.get(tabId);
      if (!state) return Promise.resolve();
      state.attached = false; state.failed = true; cancelled.set(tabId, state.url);
      return sync();
    }
  };
}
