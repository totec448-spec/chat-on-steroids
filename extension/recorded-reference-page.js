/** Fixed user-gesture operation. No evaluation string, filesystem access or guessed download endpoint. */
export async function openRecordedReferencePage(args) {
  const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
  const ref = args?.reference;
  if (!uuid.test(args?.conversationId || '') || !uuid.test(args?.messageId || '') || ref?.type !== 'file' ||
      !Number.isSafeInteger(ref.index) || ref.index < 0 || ref.index >= 64 || typeof ref.path !== 'string' ||
      !ref.path.startsWith('/mnt/data/') || /[\\?#\u0000-\u001f]/.test(ref.path) || ref.path.split('/').some(p => p === '..' || p === '.') ||
      !uuid.test(ref.sourceMessageId || '')) return { error: 'Invalid recorded reference' };
  const route = () => /^\/(?:g\/[^/]+\/)?c\/([a-f\d-]{36})(?:\/|$)/i.exec(location.pathname)?.[1];
  const own = '.clf-stream,.clf-stage,.clf-composer,.clf-boot';
  const fiber = node => { const key = node && Object.keys(node).find(k => k.startsWith('__reactFiber$')); return key ? node[key] : null; };
  const sameFile = candidate => candidate?.type === 'file' && candidate.message_id === ref.sourceMessageId &&
    candidate.sandbox_path === ref.path && (candidate.file_name || candidate.name) === ref.name;
  const locate = () => {
    if (Number.isFinite(args.expiresAt) && Date.now() >= args.expiresAt) return { error: 'The file preview request expired.' };
    if (route() !== args.conversationId) return { error: 'The conversation changed; no file was opened.' };
    const matches = new Set();
    // Native code chips and ordinary file cards use different preview controls.
    // The label only nominates candidates; exact provider object identity below
    // is mandatory and never replaced by filename equality.
    for (const control of [...document.querySelectorAll('[data-file-reference],button[aria-label^="Open preview of "]')].slice(0, 256)) {
      if (control.closest(own) || control.closest('[hidden],[inert],[aria-hidden="true"]') || !control.getClientRects().length) continue;
      if (!control.hasAttribute('data-file-reference') && control.getAttribute('aria-label') !== `Open preview of ${ref.name}`) continue;
      let reference = null, item = null;
      const conversationIds = new Set();
      for (let f = fiber(control), depth = 0; f && depth < 100; f = f.return, depth++) {
        const p = f.memoizedProps;
        if (!p || typeof p !== 'object') continue;
        if (p.contentReferenceIndex === ref.index && p.reference?.type === 'file') {
          if (!sameFile(p.reference)) { reference = null; break; }
          reference = p.reference;
        }
        for (const id of [p.conversationId, p.entry?.conversationId]) if (typeof id === 'string' && uuid.test(id)) conversationIds.add(id);
        const items = p.turn?.items || p.entry?.turn?.items;
        if (Array.isArray(items) && items.length <= 400) {
          const found = items.filter(i => i?.type === 'assistant-message' && i.messageId === args.messageId);
          if (found.length === 1) item = found[0];
          else if (found.length > 1) return { error: 'Ambiguous native message identity' };
        }
      }
      if (conversationIds.size !== 1 || !conversationIds.has(args.conversationId) || !item ||
          !reference || !Array.isArray(item.contentReferences) || item.contentReferences.length > 64 ||
          !sameFile(item.contentReferences[ref.index])) continue;
      // The ordinary file-card renderer copies its reference object. A clone
      // needs the exact native message wrapper plus a unique canonical file
      // tuple; matching a filename or position alone still grants no action.
      if (item.contentReferences[ref.index] !== reference) {
        const holder = control.closest('[data-chatgpt-selection-message-id]');
        if (holder?.getAttribute('data-chatgpt-selection-message-id') !== args.messageId ||
            item.contentReferences.filter(sameFile).length !== 1) continue;
        const holderConversation = holder.getAttribute('data-chatgpt-selection-conversation-id');
        if (uuid.test(holderConversation || '') && holderConversation !== args.conversationId) continue;
      }
      matches.add(control);
    }
    if (matches.size > 1) return { error: 'Multiple native controls claim this file; open it in ChatGPT directly.' };
    return matches.size === 1 ? { control: matches.values().next().value } : null;
  };
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); resolve(value); };
    const check = () => {
      if (done) return;
      const found = locate();
      if (found?.error) return finish(found);
      if (!found?.control || route() !== args.conversationId) {
        if (args.openNow === true) finish({ error: 'The native file control changed before opening.' });
        return;
      }
      if (args.waitOnly === true) return finish({ ready: true });
      // Dispatch once, then retire. Losing the browser RPC result never repeats this click.
      try { found.control.scrollIntoView({ block: 'nearest' }); found.control.click(); finish({ requested: true }); }
      catch { finish({ error: 'The native preview control rejected the request.' }); }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const timer = setTimeout(() => finish({ error: 'The exact file control is not loaded. Open that message in ChatGPT and retry.' }),
      Math.max(1, Math.min(8000, Number.isFinite(args.expiresAt) ? args.expiresAt - Date.now() : 8000)));
    check();
  });
}
