(bridge, entriesJson, windowsDesktop, methodsJson) => {
  // QuickJS-ng adds these globals. The TypeScript runtime's QuickJS (2025-09-13) has none, and a
  // script must see the same global object on either.
  for (const name of ["AsyncDisposableStack", "Atomics", "DOMException", "DisposableStack", "SuppressedError", "atob", "btoa", "performance", "queueMicrotask"]) delete globalThis[name];
  const stringify = JSON.stringify, parse = JSON.parse, String_ = String;
  const waiting = new Map();
  const call = json => { const id = bridge("call", json); return new Promise(resolve => { waiting.set(id, resolve); }); };
  const tools = Object.create(null);
  const entries = parse(entriesJson);
  for (const entry of entries) { Object.freeze(entry); tools[entry.name] = args => call(stringify({name:entry.name,args})).then(parse); }
  Object.defineProperties(globalThis, {
    tools: {value:Object.freeze(tools)}, ALL_TOOLS:{value:Object.freeze(entries)},
    text:{value:value => bridge("text", stringify(typeof value === "string" ? value : (stringify(value) ?? String_(value))))},
    image:{value:value => bridge("image", stringify(value))},
    exit:{value:() => { bridge("exit", "null"); throw undefined; }}
  });
  if (windowsDesktop) {
    const sky = Object.create(null);
    for (const name of parse(methodsJson)) { if (!tools[name]) continue;
      sky[name] = async (args = {}) => { const result = await tools[name](args);
        if (result.isError) { const message = (result.content || []).filter(item => item.type === "text").map(item => item.text).join("\n");
          text(message); throw new Error(message || "Desktop operation failed"); }
        if (!result.structuredContent || !("value" in result.structuredContent)) throw new Error("Invalid Desktop result");
        const value = result.structuredContent.value;
        if (name === "get_window_state") { for (const part of result.content) { if (part.type === "image") image(part); } }
        return value === null ? undefined : value; }; }
    sky.target = "windows"; Object.defineProperties(globalThis, {sky:{value:Object.freeze(sky)}, nodeRepl:{value:Object.freeze({write:text})}});
  }
  return (id, json) => { const resolve = waiting.get(id); waiting.delete(id); if (resolve) resolve(json); };
}
