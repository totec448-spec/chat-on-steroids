import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const source = readFileSync('extension/browser-control-page.js','utf8').replaceAll('export function ','function ');
const windows: JSDOM[] = [];
interface Snapshot {text:string;truncated:boolean;elements:number}
function page(html: string) {
  const dom = new JSDOM(html,{url:'https://fixture.invalid/',runScripts:'outside-only',pretendToBeVisual:true});
  windows.push(dom);
  const w = dom.window;
  const rect = {left:10,top:10,right:210,bottom:90,width:200,height:80};
  Object.defineProperty(w.HTMLElement.prototype,'getClientRects',{value:()=>[rect]});
  Object.defineProperty(w.HTMLElement.prototype,'getBoundingClientRect',{value:()=>rect});
  w.eval(source);
  const run = <T = unknown>(operation: string, args: Record<string,unknown> = {}) => w.eval(`browserPage(${JSON.stringify(operation)},${JSON.stringify({pageId:'page',frameId:'frame',maxNodes:100,maxChars:10000,...args})})`) as T;
  const ref = (snapshot: {text:string}, text: string) => /^\s*\[([^\]]+)\]/.exec(snapshot.text.split('\n').find(line=>line.includes(text))!)![1];
  return {w,run,ref};
}
afterEach(()=>{for(const dom of windows.splice(0))dom.window.close();});

describe('browser DOM observations and exact targets',()=>{
  it('reads element attributes, layout and styles without acquiring or replacing input refs',()=>{
    const {run,ref,w}=page('<main id="chat" data-turn-id="turn-42"><button id="stop" class="primary" aria-expanded="false" style="position:fixed">Stop</button></main>');
    const target=ref(run<Snapshot>('snapshot'),'button "Stop"');
    const before=w.document.activeElement;
    const details=run<Snapshot>('inspect',{selector:'main',format:'dom'});
    expect(details.text).toContain('<main id="chat" data-turn-id="turn-42">');
    expect(details.text).toContain('<button id="stop" class="primary" aria-expanded="false">');
    expect(details.text).toContain('rect=[10,10,200,80]');
    expect(details.text).toContain('position=fixed');
    expect(details.text).not.toContain('[page:frame:');
    expect(w.document.activeElement).toBe(before);
    expect(run('focus',{ref:target,keyTarget:true})).toBe(true);
  });

  it('bounds DOM details, filters attributes and never emits password values or inline scripts',()=>{
    const {run}=page('<main><input id="secret" type="password" value="never-emit-secret" onclick="never-emit-handler()"><button data-testid="exact-target">Run</button></main>');
    const details=run<Snapshot>('inspect',{format:'dom'});
    expect(details.text).not.toContain('never-emit');
    expect(run<Snapshot>('inspect',{format:'dom',filter:'exact-target'}).text).toContain('data-testid="exact-target"');
    const huge=page(`<main id="${'x'.repeat(10000)}">${'<div data-state="ready">Text</div>'.repeat(100)}</main>`).run<Snapshot>('inspect',{format:'dom',maxNodes:3,maxChars:1000});
    expect(huge.truncated).toBe(true);
    expect(huge.text.length).toBeLessThanOrEqual(1000);
    expect(huge.text.split('\n').length).toBeLessThanOrEqual(3);
  });

  it('inspects a scoped subtree without replacing interactive refs or changing focus',()=>{
    const {run,ref,w}=page('<aside>Unrelated history</aside><main><button>Review target</button><p>Visible update</p></main>');
    const target=ref(run<Snapshot>('snapshot'),'Review target');
    const before=w.document.activeElement;
    const inspection=run<Snapshot & {refs:string[]}>('inspect',{selector:'main',pageId:'inspection'});
    expect(inspection.text).toContain('Visible update');
    expect(inspection.text).not.toContain('Unrelated history');
    expect(inspection.text).not.toContain('[inspection:');
    expect(inspection.elements).toBe(1);
    expect(inspection.refs).toEqual([]);
    expect(w.document.activeElement).toBe(before);
    expect(run('focus',{ref:target,keyTarget:true})).toBe(true);
  });

  it('reports missing or invalid snapshot scopes without widening to the whole document',()=>{
    const {run}=page('<main><button>Target</button></main>');
    expect(run('inspect',{selector:'#missing'})).toMatchObject({error:expect.stringContaining('SELECTOR_NOT_FOUND')});
    expect(run('inspect',{selector:'['})).toMatchObject({error:expect.stringContaining('SELECTOR_INVALID')});
    expect(()=>run('snapshot',{selector:'#missing'})).toThrow(/SELECTOR_NOT_FOUND/);
    expect(()=>run('snapshot',{selector:'['})).toThrow(/SELECTOR_INVALID/);
    const scoped=run<Snapshot>('snapshot',{selector:'main'});
    expect(scoped.text).toContain('button "Target"');
  });

  it('exposes an editing host once rather than inventing textboxes for inherited editable children',()=>{
    const {run,w}=page('<div contenteditable="true" aria-label="Composer"><p>First line</p><p>Second line</p></div>');
    Object.defineProperty(w.HTMLElement.prototype,'isContentEditable',{get(){return this.closest('[contenteditable]')?.getAttribute('contenteditable')==='true';}});
    const snapshot=run<Snapshot>('snapshot');
    expect(snapshot.text.match(/textbox/g)).toHaveLength(1);
    expect(snapshot.text).toContain('First line');
    expect(snapshot.text).toContain('Second line');
  });

  it('traverses layoutless display:contents wrappers without exposing hidden or inert subtrees',()=>{
    const {run,ref,w}=page('<div style="display:contents"><div role="textbox" contenteditable="true" aria-label="Composer">Draft</div></div><div style="display:none"><button>Hidden</button></div><div inert><button>Inert</button></div>');
    Object.defineProperty(w.document.body.firstElementChild!,'getClientRects',{value:()=>[]});
    const snapshot=run<Snapshot>('snapshot',{filter:'textbox'});
    expect(ref(snapshot,'textbox "Composer"')).toBeTruthy();
    const full=run<Snapshot>('snapshot');
    expect(full.text).not.toContain('Hidden');
    expect(full.text).not.toContain('Inert');
    expect(full.text).toContain('Draft');
  });

  it('reports value truncation for per-string, property-count, key and depth limits',()=>{
    const {w}=page('');
    for(const expression of ['"x".repeat(12001)','Object.fromEntries(Array.from({length:101},(_,i)=>[i,i]))','({a:{b:{c:{d:{e:{f:1}}}}}})','({["k".repeat(201)]:1})']) {
      expect((w.eval(`boundedBrowserValue(${expression})`) as {truncated:boolean}).truncated).toBe(true);
    }
    expect(w.eval('boundedBrowserValue({ok:true})')).toEqual({value:{ok:true},truncated:false});
  });

  it('preserves visible content of explicitly named containers and exposes canvas targets',()=>{
    const {run,ref}=page('<div tabindex="0" aria-label="Account card"><p>Balance: 42 credits</p><button>Confirm</button></div><canvas aria-label="Preview canvas"></canvas>');
    const snapshot=run<Snapshot>('snapshot');
    expect(snapshot.text).toContain('Balance: 42 credits');
    expect(ref(snapshot,'button "Confirm"')).toBeTruthy();
    expect(ref(snapshot,'canvas "Preview canvas"')).toBeTruthy();
  });

  it('names native selects without option text and reports exact option values and state',()=>{
    const {run,ref}=page('<label>Plan<select><option value="basic">Basic plan</option><option value="team">Team plan</option><optgroup label="Legacy" disabled><option value="old">Old plan</option></optgroup></select></label>');
    const snapshot=run<Snapshot>('snapshot');
    const select=ref(snapshot,'combobox "Plan"');
    expect(snapshot.text).toContain('option "Basic plan" value="basic" (selected)');
    expect(snapshot.text).toContain('option "Team plan" value="team"');
    expect(snapshot.text).toContain('option "Old plan" value="old" (disabled)');
    expect(run('select',{ref:select,values:['team']})).toEqual({values:['team']});
    expect(()=>run('select',{ref:select,values:['old']})).toThrow(/OPTION_UNAVAILABLE/);
    const filtered=run<Snapshot>('snapshot',{filter:'Team plan'});
    expect(ref(filtered,'combobox "Plan"')).toBeTruthy();
    expect(filtered.text).toContain('value="team"');
    expect(run<Snapshot>('snapshot',{maxNodes:2}).truncated).toBe(true);
  });

  it('preserves opaque option values and bounds oversized option lists',()=>{
    const {run,ref}=page('<select aria-label="Opaque"><option value="  team  x  ">Team</option><option value="">None</option></select>');
    const snapshot=run<Snapshot>('snapshot');
    expect(snapshot.text).toContain('value="  team  x  "');
    expect(snapshot.text).toContain('option "None" value=""');
    expect(run('select',{ref:ref(snapshot,'combobox "Opaque"'),values:['  team  x  ']})).toEqual({values:['  team  x  ']});
    const huge=page(`<select aria-label="Huge">${'<option>Choice</option>'.repeat(250)}</select>`).run<Snapshot>('snapshot',{maxNodes:1000,maxChars:24000});
    expect(huge.truncated).toBe(true);
    expect(huge.text.match(/option /g)).toHaveLength(200);
    const clipped=page(`<select aria-label="Long"><option value="${'x'.repeat(1001)}">Long</option></select>`).run<Snapshot>('snapshot');
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).toContain('value truncated');
  });

  it('retains nested links and editors under named cards without duplicate label text',()=>{
    const {run,ref}=page('<h2><a href="/next">Read next</a></h2><div tabindex="0" aria-label="Note card"><label>Body<textarea></textarea></label></div>');
    const snapshot=run<Snapshot>('snapshot');
    expect(ref(snapshot,'link "Read next"')).toBeTruthy();
    expect(ref(snapshot,'textbox "Body"')).toBeTruthy();
    expect(snapshot.text.split('\n').filter((line:string)=>line.trim()==='Read next')).toHaveLength(0);
    expect(snapshot).toMatchObject({truncated:false,visibility:'visible',pointerLocked:false});
  });

  it('replaces refs at observation and refuses old keyboard focus targets',()=>{
    const {run,ref,w}=page('<button>Outside</button><label>Field<input></label>');
    const old=ref(run<Snapshot>('snapshot'),'textbox "Field"');
    const current=ref(run<Snapshot>('snapshot'),'textbox "Field"');
    w.document.querySelector('button')!.focus();
    expect(()=>run('focus',{ref:old,keyTarget:true})).toThrow(/REF_STALE/);
    expect(w.document.activeElement?.tagName).toBe('BUTTON');
    expect(run('focus',{ref:current,keyTarget:true})).toBe(true);
    expect(w.document.activeElement?.tagName).toBe('INPUT');
  });

  it('finds an exposed point within a partly covered target and refuses a fully covered one',()=>{
    const {run,ref,w}=page('<button>Target</button><div aria-label="Dialog cover"></div>');
    const button=w.document.querySelector('button')!,cover=w.document.querySelector('div')!;
    const target=ref(run<Snapshot>('snapshot'),'button "Target"');
    Object.defineProperty(w.document,'elementFromPoint',{configurable:true,value:(x:number)=>x<80?button:cover});
    expect(run('point',{ref:target})).toEqual({x:50,y:26});
    Object.defineProperty(w.document,'elementFromPoint',{value:()=>cover});
    expect(()=>run('point',{ref:target})).toThrow(/OBSTRUCTED.*Dialog cover.*No click/);
  });

  it('keeps traversal and text limits explicit while descending interactive containers',()=>{
    const {run}=page(`<div tabindex="0" aria-label="Many controls">${'<button>Item</button>'.repeat(200)}</div>`);
    const snapshot=run<Snapshot>('snapshot',{maxNodes:4,maxChars:200});
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text.length).toBeLessThanOrEqual(200);
    expect(snapshot.elements).toBeLessThanOrEqual(4);
  });
});
