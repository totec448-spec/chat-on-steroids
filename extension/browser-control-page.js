/** Executed only in a debugger-created isolated world. No extension token enters the page. */
export function browserPage(operation, args) {
  const key = '__cosBrowserControl';
  let state = globalThis[key];
  if (!state || state.pageId !== args.pageId) {
    const overlay = state?.overlay?.isConnected ? state.overlay : null;
    state = globalThis[key] = { pageId: args.pageId, refs: new Map(), next: 0, overlay };
  }
  const compact = (value, max = 200) => String(value ?? '').slice(0, max * 4).replace(/\s+/g, ' ').trim().slice(0, max);
  const textOf = element => {
    if (!element) return '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = '', node, count = 0;
    while (text.length < 800 && count++ < 100 && (node = walker.nextNode())) text += node.nodeValue.slice(0, 800 - text.length);
    return compact(text);
  };
  const fail = message => { throw new Error(message); };
  const visible = element => {
    const style = getComputedStyle(element);
    return !element.closest('[inert]') && style.display !== 'none' && style.visibility !== 'hidden' &&
      element.getClientRects().length > 0;
  };
  const resolve = ref => {
    const element = state.refs.get(ref);
    if (!element?.isConnected || !visible(element)) fail('BROWSER_REF_STALE: snapshot again; the element is gone or hidden.');
    if (element.matches(':disabled,[aria-disabled="true"]')) fail('BROWSER_ELEMENT_DISABLED');
    return element;
  };
  const label = element => {
    const ids = compact(element.getAttribute('aria-labelledby'), 500).split(' ').filter(Boolean);
    const labelled = ids.map(id => textOf(element.getRootNode().getElementById?.(id))).join(' ');
    return compact(element.getAttribute('aria-label') || labelled ||
      (element.labels ? Array.from(element.labels).slice(0, 5).map(textOf).join(' ') : '') ||
      element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') ||
      (element.tagName === 'INPUT' && ['button','submit','reset'].includes(element.type) ? element.value : '') || textOf(element));
  };

  if (operation === 'overlay') {
    state.overlay?.remove();
    const host = document.createElement('div');
    host.setAttribute('data-cos-browser-control', args.lease);
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const border = document.createElement('div');
    border.style.cssText = 'position:fixed;inset:0;border:3px solid #69a8ff;box-shadow:inset 0 0 22px #4c91ff55;pointer-events:none;border-radius:5px;';
    const chip = document.createElement('div');
    chip.style.cssText = 'position:fixed;right:14px;bottom:14px;background:#152c4f;color:#ddecff;border:1px solid #78b0ff;border-radius:9px;padding:7px 11px;font:12px/1.4 system-ui;box-shadow:0 3px 16px #10284a44;pointer-events:none;';
    chip.textContent = 'Chat On Steroids · Browser control';
    shadow.append(border, chip); document.documentElement.append(host); state.overlay = host;
    return true;
  }
  if (operation === 'removeOverlay') { state.overlay?.remove(); state.overlay = null; return true; }

  if (operation === 'snapshot') {
    // An explicit new snapshot replaces refs, preventing ref reuse after node replacement.
    state.refs.clear();
    const lines = []; let chars = 0, visited = 0, emitted = 0, truncated = false;
    const filter = (args.filter || '').toLocaleLowerCase();
    const implicit = { A: 'link', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox', IMG: 'img', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', SUMMARY: 'button' };
    const stack = [{ node: document.body || document.documentElement, depth: 0 }];
    while (stack.length) {
      if (++visited > 15000 || emitted >= args.maxNodes || chars >= args.maxChars) { truncated = true; break; }
      const { node, depth } = stack.pop();
      if (node.nodeType === Node.TEXT_NODE) {
        const text = compact(node.nodeValue, 500);
        if (text && (!filter || text.toLocaleLowerCase().includes(filter))) {
          const line = `${'  '.repeat(Math.min(depth, 16))}${text}`;
          if (chars + line.length + 1 > args.maxChars) { truncated = true; break; }
          lines.push(line); chars += line.length + 1; emitted++;
        }
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node === state.overlay ||
          ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD'].includes(node.tagName) || !visible(node)) continue;
      let role = compact(node.getAttribute('role'), 50) || implicit[node.tagName];
      if (node.tagName === 'INPUT') role = ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button' })[node.type] || 'textbox';
      if (!role && (node.isContentEditable || node.tabIndex >= 0 || node.hasAttribute('onclick'))) role = node.isContentEditable ? 'textbox' : 'interactive';
      const terminal = role && ['button','link','textbox','checkbox','radio','combobox','slider','img','heading','interactive'].includes(role);
      if (role) {
        const name = label(node);
        if (!filter || `${role} ${name}`.toLocaleLowerCase().includes(filter)) {
          const id = `${args.pageId}:${args.frameId}:e${++state.next}`;
          const flags = [node.matches(':disabled,[aria-disabled="true"]') ? 'disabled' : '', node.checked ? 'checked' : '', node.getAttribute('aria-expanded') ? `expanded=${node.getAttribute('aria-expanded')}` : '', document.activeElement === node ? 'focused' : ''].filter(Boolean);
          const value = ['INPUT','TEXTAREA','SELECT'].includes(node.tagName) && node.type !== 'password' ? compact(node.value, 200) : '';
          const href = node.tagName === 'A' ? compact(node.getAttribute('href'), 300) : '';
          const line = `${'  '.repeat(Math.min(depth, 16))}[${id}] ${role} ${JSON.stringify(name)}${value ? ` value=${JSON.stringify(value)}` : ''}${href ? ` href=${JSON.stringify(href)}` : ''}${flags.length ? ` (${flags.join(', ')})` : ''}`;
          if (chars + line.length + 1 > args.maxChars) { truncated = true; break; }
          state.refs.set(id, node); lines.push(line); chars += line.length + 1; emitted++;
        }
      }
      if (terminal) continue;
      if (depth >= 40) { truncated = true; continue; }
      // Reverse iteration avoids allocating a full array for a huge DOM parent.
      const roots = node.shadowRoot ? [node, node.shadowRoot] : [node];
      for (const root of roots) {
        let child = root.lastChild, count = 0;
        while (child && stack.length < 15000 && count++ < 15000) { stack.push({ node: child, depth: depth + (role ? 1 : 0) }); child = child.previousSibling; }
        if (child) truncated = true;
      }
    }
    return { title: compact(document.title, 500), url: location.href.slice(0, 8192), text: lines.join('\n'), truncated, visited, elements: state.refs.size, refs: [...state.refs.keys()] };
  }

  const element = resolve(args.ref);
  if (operation === 'point') {
    const before = element.getBoundingClientRect();
    if (!args.noScroll && (before.left < 0 || before.top < 0 || before.right > innerWidth || before.bottom > innerHeight)) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) fail('BROWSER_ELEMENT_OFFSCREEN: inspect the target before dragging.');
    const x = Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) / 2;
    const y = Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2;
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot?.elementFromPoint(x,y) && hit.shadowRoot.elementFromPoint(x,y) !== hit) hit = hit.shadowRoot.elementFromPoint(x,y);
    if (!hit || !(hit === element || element.contains(hit))) fail('BROWSER_ELEMENT_OBSTRUCTED: inspect a fresh screenshot.');
    return { x, y };
  }
  if (operation === 'focus') {
    if (!(element.matches('input,textarea') || element.isContentEditable)) fail('BROWSER_NOT_EDITABLE');
    if (element.readOnly) fail('BROWSER_ELEMENT_READONLY');
    if (element.matches('input[type="file"]')) fail('BROWSER_FILE_INPUT: use an explicit file upload workflow.');
    element.focus({ preventScroll: true });
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    if (focused !== element) fail('BROWSER_FOCUS_FAILED');
    if (args.replace) {
      if (element.matches('input,textarea') && typeof element.select === 'function') {
        try { element.select(); if (element.selectionStart !== 0 || element.selectionEnd !== element.value.length) fail('BROWSER_SELECTION_FAILED'); }
        catch { fail('BROWSER_INPUT_TYPE: this input cannot select text. Use browser_evaluate with its native setter.'); }
      } else {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }
    }
    return true;
  }
  if (operation === 'select') {
    if (element.tagName !== 'SELECT') fail('BROWSER_NOT_SELECT');
    const values = args.values;
    if (!element.multiple && values.length !== 1) fail('BROWSER_SELECT_VALUES');
    const options = Array.from(element.options);
    if (values.some(value => !options.some(option => option.value === value && !option.disabled && !option.parentElement?.disabled))) fail('BROWSER_OPTION_UNAVAILABLE');
    for (const option of options) option.selected = values.includes(option.value);
    element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
    return { values: options.filter(o => o.selected).map(o => o.value) };
  }
  fail('BROWSER_OPERATION_UNKNOWN');
}

/** Bounded serialization runs at the producer, before CDP copies a value into the worker. */
export function boundedBrowserValue(value) {
  let budget = 20000;
  const seen = new WeakSet();
  const read = (v, depth) => {
    if (budget <= 0) return '[truncated]';
    if (v === null || typeof v === 'boolean' || typeof v === 'number') { budget -= 20; return v; }
    if (typeof v === 'string') { const result = v.slice(0, Math.max(0, Math.min(budget, 12000))); budget -= result.length; return result.length < v.length ? result + '…[truncated]' : result; }
    if (typeof v !== 'object') return String(v).slice(0, 100);
    if (seen.has(v)) return '[circular]';
    if (depth >= 5) return '[depth limit]';
    seen.add(v);
    if (v instanceof Node) return { node: v.nodeName, text: read(v.nodeValue?.slice(0,1000), depth + 1) };
    const result = Array.isArray(v) ? [] : Object.create(null);
    let count = 0;
    for (const key in v) {
      if (!Object.prototype.hasOwnProperty.call(v,key)) continue;
      if (++count > 100 || budget <= 0) { result[Array.isArray(v) ? result.length : '__truncated'] = true; break; }
      const descriptor = Object.getOwnPropertyDescriptor(v,key);
      budget -= key.length + 4;
      const item = descriptor && 'value' in descriptor ? read(descriptor.value, depth + 1) : '[accessor]';
      // Never assign an attacker-controlled sparse array index (JSON would expand its holes).
      if (Array.isArray(result)) result.push(item);
      else result[key.slice(0,200)] = item;
    }
    return result;
  };
  return { value: read(value,0), truncated: budget <= 0 };
}

/** Called on the actual iframe element in its parent's isolated world. */
export function browserFramePoint(point) {
  if (!point) { this.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); return true; }
  const rect = this.getBoundingClientRect();
  const transform = getComputedStyle(this).transform;
  if (transform !== 'none') {
    const matrix = new DOMMatrixReadOnly(transform);
    if (!matrix.is2D || matrix.b || matrix.c || matrix.a <= 0 || matrix.d <= 0) throw new Error('BROWSER_FRAME_TRANSFORM: use screenshot coordinates for this transformed frame.');
  }
  const x = rect.left + (this.clientLeft + point.x) * rect.width / this.offsetWidth;
  const y = rect.top + (this.clientTop + point.y) * rect.height / this.offsetHeight;
  let hit = document.elementFromPoint(x,y);
  while (hit?.shadowRoot?.elementFromPoint(x,y) && hit.shadowRoot.elementFromPoint(x,y) !== hit) hit = hit.shadowRoot.elementFromPoint(x,y);
  if (hit !== this || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('BROWSER_FRAME_OBSTRUCTED: inspect a fresh screenshot.');
  return {x,y};
}
