/** Main-process sidebar bridge fixture for isolated, real-Electron renderer tests only.
 * The production durable store's concurrency and write-failure contracts have separate tests. */
function fixtureSidebarShelvesSource() {
  return String.raw`(() => {
    const STORAGE = 'chat-on-steroids.fixture-sidebar-shelves';
    const old = localStorage.getItem(STORAGE);
    let state;
    try { state = old ? JSON.parse(old) : null; } catch { state = null; }
    if (!state || !state.records) state = { records: {}, revision: 0, migrated: false };
    const subscribers = { one: [], many: [] };
    const ok = data => Promise.resolve({ ok: true, data: structuredClone(data) });
    const save = () => localStorage.setItem(STORAGE, JSON.stringify(state));
    const nextWake = () => Math.min(Infinity, ...Object.values(state.records).filter(entry => entry.shelf === 'snoozed').map(entry => entry.until));
    const list = () => ok({ records: state.records, revision: state.revision, nextWake: Number.isFinite(nextWake()) ? nextWake() : null });
    function update(changes, expectedRevision, restore = false) {
      if (expectedRevision !== state.revision) return Promise.reject(new Error('Sidebar changed in another window'));
      const next = structuredClone(state.records);
      const result = [];
      for (const change of changes) {
        const before = next[change.id] || { shelf: 'active' };
        const current = restore ? change.snapshot : (change.shelf === 'snoozed'
          ? { shelf: 'snoozed', until: change.until, snoozedAt: Date.now(), ...(change.attention ? {
            userMessages: change.attention.userMessages, errors: change.attention.errors } : {}) }
          : { shelf: change.shelf });
        if (current.shelf === 'active') delete next[change.id];
        else next[change.id] = current;
        if (JSON.stringify(before) !== JSON.stringify(current)) result.push({ id: change.id, before, current });
      }
      if (!result.length) return ok({ revision: state.revision, changes: [] });
      state.records = next; state.revision++; save();
      const batch = { revision: state.revision, changes: result };
      for (const subscriber of subscribers.many) subscriber(structuredClone(batch));
      return ok(batch);
    }
    const methods = {
      getSidebarShelves: list,
      getSidebarShelf: id => ok(state.records[id] || { shelf: 'active' }),
      migrateLegacySidebarShelves: rows => {
        if (!state.migrated) {
          let added = false;
          for (const [id, record] of Object.entries(rows || {})) {
            if (!state.records[id] && record.shelf !== 'active') { state.records[id] = record; added = true; }
          }
          state.migrated = true;
          if (added) state.revision++;
          save();
        }
        return list();
      },
      setSidebarShelves: (changes, expectedRevision) => update(changes, expectedRevision),
      restoreSidebarShelves: (snapshots, expectedRevision) => update(snapshots, expectedRevision, true),
      onSidebarShelvesChanged: cb => { subscribers.one.push(cb); return () => { subscribers.one = subscribers.one.filter(x => x !== cb); }; },
      onSidebarShelvesBatchChanged: cb => { subscribers.many.push(cb); return () => { subscribers.many = subscribers.many.filter(x => x !== cb); }; }
    };
    window.sidebarShelfFixture = { methods, records: () => structuredClone(state.records), revision: () => state.revision };
  })();`;
}
module.exports = { fixtureSidebarShelvesSource };
