import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync('extension/browser-control.js', 'utf8')
  .replace(/^import .*\n/, '').replace('export function ', 'function ');
type Tab = {id:number;url:string;pendingUrl?:string;status:string;title?:string;active?:boolean};
function event() {
  const listeners = new Set<(...args:any[])=>void>();
  return {addListener:(fn:(...args:any[])=>void)=>listeners.add(fn),removeListener:(fn:(...args:any[])=>void)=>listeners.delete(fn),
    fire:(...args:any[])=>{for(const fn of listeners)fn(...args);},listeners};
}
async function fixture(held: {tabId:number;owner:string}[] = []) {
  const browserId=randomUUID(), entries=new Map<number,Tab>();
  const saved={browserId,epoch:'epoch',receipt:null,tabs:held.map(t=>({...t,lease:randomUUID()}))};
  for(const row of held) entries.set(row.tabId,{id:row.tabId,url:'https://fixture.invalid/',status:'complete'});
  const chrome={
    storage:{session:{get:vi.fn(async()=>({cosBrowserControl:saved})),set:vi.fn(async()=>{})}},
    permissions:{contains:vi.fn(async()=>true)},
    tabs:{get:vi.fn(async(id:number)=>{const tab=entries.get(id);if(!tab)throw new Error('No tab with id');return tab;}),
      query:vi.fn(async()=>[...entries.values()]),onUpdated:event(),onRemoved:event(),
      create:vi.fn(async(args:{url:string;active:boolean})=>{const tab={id:99,url:args.url,status:'complete',active:args.active};entries.set(99,tab);return tab;}),
      remove:vi.fn(async(id:number)=>{entries.delete(id);})},
    scripting:{executeScript:vi.fn(async()=>[])},
    debugger:{attach:vi.fn(async()=>{}),detach:vi.fn(async()=>{}),getTargets:vi.fn(async()=>[]),
      sendCommand:vi.fn(async(target:{tabId:number},method:string)=>{
        if(method==='Page.getFrameTree') return {frameTree:{frame:{id:'frame',url:entries.get(target.tabId)?.url}}};
        if(method==='Page.createIsolatedWorld') return {executionContextId:1};
        if(method==='Runtime.evaluate') return {result:{value:true}};
        return {};
      })}
  };
  const create=runInNewContext(`${source};createBrowserControl`,{browserPage:()=>{},crypto:{randomUUID},navigator:{userAgent:'Chrome'},setTimeout,clearTimeout,TextEncoder,URL});
  let allowed=true;
  const transport=vi.fn(async()=>({ok:true,data:{allowed,epoch:'epoch',policy:{read:true,write:true},requests:[]}}));
  const control=create(chrome,transport,(id:number)=>id===7);
  await control.pump();
  const command=(action:string,args:Record<string,unknown>={})=>({id:randomUUID(),epoch:'epoch',owner:'session:owner',conversationId:null,tool:'browser_tabs',args:{action,...args},expiresAt:Date.now()+25000});
  return {chrome,control,entries,browserId,command,revoke:()=>{allowed=false;}};
}
afterEach(()=>vi.useRealTimers());

describe('browser creation and usable tab discovery',()=>{
  it('opens the requested destination even if the debugger refuses, and reports the created tab once',async()=>{
    const {chrome,control,entries,command,browserId}=await fixture();
    chrome.debugger.attach.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    const result=await control.execute(command('new',{url:'https://fixture.invalid/task'}));
    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({url:'https://fixture.invalid/task',active:false});
    expect(entries.get(99)?.url).toBe('https://fixture.invalid/task');
    expect(result).toMatchObject({value:{tabId:`${browserId}:99`,created:true,attached:false,navigationRequested:'https://fixture.invalid/task',attachmentError:expect.stringContaining('Another debugger')}});
    expect(result.error).toBeUndefined();
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('attaches to a committed destination without waiting for all of its subresources',async()=>{
    vi.useFakeTimers();
    const {chrome,control,entries,command}=await fixture();
    chrome.tabs.create.mockImplementationOnce(async args=>{const tab={id:99,url:args.url,status:'loading',active:false};entries.set(99,tab);return tab;});
    const result=control.execute(command('new',{url:'https://fixture.invalid/slow-assets'}));
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({value:{created:true,attached:true,url:'https://fixture.invalid/slow-assets'}});
    expect(chrome.debugger.sendCommand.mock.calls.some(([,method])=>method==='Page.navigate')).toBe(false);
  });

  it('waits on the one created tab while its URL is pending, then attaches to that same destination',async()=>{
    vi.useFakeTimers();
    const {chrome,control,entries,command}=await fixture();
    chrome.tabs.create.mockImplementationOnce(async args=>{const tab={id:99,url:'about:blank',pendingUrl:args.url,status:'loading',active:false};entries.set(99,tab);return tab;});
    const result=control.execute(command('new',{url:'https://fixture.invalid/pending'}));
    await vi.advanceTimersByTimeAsync(50);
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    entries.set(99,{id:99,url:'https://fixture.invalid/pending',status:'loading'});
    chrome.tabs.onUpdated.fire(99,{},entries.get(99));
    expect(await result).toMatchObject({value:{created:true,attached:true}});
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.onUpdated.listeners.size).toBe(0);
    expect(chrome.tabs.onRemoved.listeners.size).toBe(0);
  });

  it('retains the creation receipt when the user closes the pending tab',async()=>{
    vi.useFakeTimers();
    const {chrome,control,entries,command}=await fixture();
    chrome.tabs.create.mockImplementationOnce(async args=>{const tab={id:99,url:'',pendingUrl:args.url,status:'loading',active:false};entries.set(99,tab);return tab;});
    const result=control.execute(command('new',{url:'https://fixture.invalid/pending'}));
    await vi.advanceTimersByTimeAsync(50);
    entries.delete(99);chrome.tabs.onRemoved.fire(99,{});
    // Drive the existing timeout too, so this regression fails instead of hanging on old source.
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toMatchObject({value:{created:true,attached:false,attachmentError:expect.stringContaining('BROWSER_TAB_CLOSED')}});
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.onUpdated.listeners.size).toBe(0);
    expect(chrome.tabs.onRemoved.listeners.size).toBe(0);
  });

  it('rechecks current permission after creation before taking the debugger',async()=>{
    const {chrome,control,entries,command,revoke}=await fixture();
    chrome.tabs.create.mockImplementationOnce(async args=>{const tab={id:99,url:args.url,status:'complete',active:false};entries.set(99,tab);revoke();return tab;});
    const result=await control.execute(command('new',{url:'https://fixture.invalid/'}));
    expect(result).toMatchObject({value:{created:true,attached:false,attachmentError:expect.stringContaining('PERMISSION_REVOKED')}});
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it('refuses a known full attachment limit before opening another tab',async()=>{
    const {chrome,control,command}=await fixture(Array.from({length:32},(_,i)=>({tabId:100+i,owner:'session:owner'})));
    await expect(control.execute(command('new',{url:'https://fixture.invalid/'}))).rejects.toThrow(/TAB_LIMIT/);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('keeps unsupported destinations from creating any tab',async()=>{
    const {chrome,control,command}=await fixture();
    await expect(control.execute(command('new',{url:'file:///private.txt'}))).rejects.toThrow(/URL_UNSUPPORTED/);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('lists the pending destination and explains the next usable operation for each tab',async()=>{
    const {control,entries,command}=await fixture([{tabId:8,owner:'session:foreign'},{tabId:11,owner:'session:owner'}]);
    entries.set(7,{id:7,url:'https://fixture.invalid/chat',status:'complete'});
    entries.set(9,{id:9,url:'https://fixture.invalid/unclaimed',status:'complete'});
    entries.set(10,{id:10,url:'',pendingUrl:'https://fixture.invalid/loading',status:'loading'});
    const result=await control.execute(command('list'));
    const access=(id:number)=>result.value.tabs.find((t:{tabId:string})=>t.tabId.endsWith(`:${id}`))?.access;
    expect(access(7)).toEqual({snapshot:'inspect',input:'protected'});
    expect(access(8)).toEqual({snapshot:'inspect',input:'other-owner'});
    expect(access(9)).toEqual({snapshot:'inspect',input:'attach-required'});
    expect(access(11)).toEqual({snapshot:'interactive',input:'available'});
    expect(access(10)).toEqual({snapshot:'loading',input:'loading'});
    const filtered=await control.execute(command('list',{filter:'loading'}));
    expect(filtered.value.tabs).toEqual([expect.objectContaining({pendingUrl:'https://fixture.invalid/loading',status:'loading'})]);
  });
});
