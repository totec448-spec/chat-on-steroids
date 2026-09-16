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
