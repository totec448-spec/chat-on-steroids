import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync('extension/browser-control.js','utf8')
  .replace(/^import .*\n/, '').replace('export function ', 'function ');

async function fixture(owner = 'A', protectedPage = true) {
  const saved = {browserId:randomUUID(),epoch:'epoch',receipt:null,tabs:[{tabId:17,owner,lease:'lease'}]};
  const chrome = {
    storage:{session:{get:vi.fn(async()=>({cosBrowserControl:saved})),set:vi.fn(async(_value:unknown)=>{})}},
    permissions:{contains:vi.fn(async()=>true)},
    tabs:{get:vi.fn(async()=>({id:17,url:'https://fixture.invalid/'})),remove:vi.fn(async()=>{})},
    scripting:{executeScript:vi.fn(async(_args:unknown)=>[{frameId:0,documentId:String(randomUUID()),result:{text:'Visible update',refs:[],elements:0}}])},
    debugger:{attach:vi.fn(async()=>{}),detach:vi.fn(async()=>{}),sendCommand:vi.fn(async()=>({}))}
  };
  const create = runInNewContext(`${source};createBrowserControl`, {browserPage:()=>{},crypto:{randomUUID},navigator:{userAgent:'Chrome'},setTimeout,clearTimeout,TextEncoder,URL});
  const transport = vi.fn(async()=>({ok:true,data:{allowed:true,epoch:'epoch',policy:{read:true,write:true},requests:[]}}));
  const control = create(chrome,transport,()=>protectedPage);
  await control.pump();
  const command = (action:string,owner='A')=>({id:'call',epoch:'epoch',owner,conversationId:null,tool:'browser_tabs',args:{action,tabId:17},expiresAt:Date.now()+25000});
  return {chrome,control,command,transport};
}
afterEach(()=>vi.useRealTimers());

describe('browser extension release custody',()=>{
  it('reads an unclaimed protected tab without attaching, detaching or taking input ownership',async()=>{
    const {chrome,control,command}=await fixture();
    const inspect={...command('list'),tool:'browser_snapshot',args:{tabId:18,selector:'main',maxNodes:30,maxChars:2000}};
    expect(await control.execute(inspect)).toMatchObject({value:{text:'Visible update',inspectionOnly:true}});
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({world:'ISOLATED',target:{tabId:18,frameIds:[0]}}));
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    await expect(control.execute({...inspect,tool:'browser_action',args:{tabId:18,action:'click',ref:'invented'}})).rejects.toThrow(/TAB_NOT_OWNED/);
  });

  it('does not detach the orchestration debugger when attachment is refused before acquisition',async()=>{
    const {chrome,control,command}=await fixture();
    await expect(control.execute({...command('attach'),args:{action:'attach',tabId:18}})).rejects.toThrow(/EXECUTOR_TAB/);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('round-trips opaque Chrome document ids without imposing the page UUID grammar',async()=>{
    const {chrome,control,command}=await fixture();
    const documentId='AABBCCDDEEFF00112233445566778899';
    chrome.scripting.executeScript.mockResolvedValueOnce([{frameId:0,documentId,result:{text:'Exact document',refs:[],elements:0}}]);
    const args={tabId:18,frameId:`document:${documentId}`};
    expect(await control.execute({...command('list'),tool:'browser_snapshot',args}))
      .toMatchObject({value:{documentId,frameId:`document:${documentId}`,inspectionOnly:true}});
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({target:{tabId:18,documentIds:[documentId]}}));
    chrome.scripting.executeScript.mockResolvedValueOnce([{frameId:0,documentId:'another-document',result:{text:'Other document',refs:[],elements:0}}]);
    await expect(control.execute({...command('list'),tool:'browser_snapshot',args})).rejects.toThrow(/FRAME_UNAVAILABLE/);
  });

  it('does not detach a foreign debugger when Chrome rejects attachment',async()=>{
    const {chrome,control,command}=await fixture('A',false);
    chrome.debugger.attach.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    await expect(control.execute({...command('attach'),args:{action:'attach',tabId:18}})).rejects.toThrow(/Another debugger/);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('retains request custody and lets only its proved durable session release it',async()=>{
    const {chrome,control,command}=await fixture('request:original');
    for (const owner of ['request:other','unattributed','session:other']) {
      await expect(control.execute(command('release',owner))).rejects.toThrow(/TAB_OWNED/);
    }
    await expect(control.execute(command('release','session:owner'))).rejects.toThrow(/TAB_OWNED/);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(await control.execute({...command('release','session:owner'),ownerAliases:['request:original']}))
      .toMatchObject({value:{released:true}});
    expect(chrome.debugger.detach).toHaveBeenCalledExactlyOnceWith({tabId:17});
  });

  it('never adopts legacy anonymous custody through a request alias',async()=>{
    const {chrome,control,command}=await fixture('unattributed');
    await expect(control.execute({...command('release','session:owner'),ownerAliases:['unattributed']})).rejects.toThrow(/TAB_OWNED/);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
  });

  it('rechecks permission after an inspection and does not publish a late result',async()=>{
    const {chrome,control,command,transport}=await fixture();
    chrome.scripting.executeScript.mockImplementationOnce(async()=>{
      transport.mockResolvedValue({ok:true,data:{allowed:false,epoch:'epoch',policy:{read:true,write:true},requests:[]}});
      return [{frameId:0,documentId:randomUUID(),result:{text:'Private observation',refs:[],elements:0}}];
    });
    await expect(control.execute({...command('list'),tool:'browser_snapshot',args:{tabId:18}})).rejects.toThrow(/PERMISSION_REVOKED/);
  });

  it('bounds an inspection that Chrome never completes without changing debugger custody',async()=>{
    vi.useFakeTimers();
    const {chrome,control,command}=await fixture();
    chrome.scripting.executeScript.mockImplementationOnce(()=>new Promise(()=>{}));
    const result=control.execute({...command('list'),tool:'browser_snapshot',args:{tabId:18},expiresAt:Date.now()+50});
    const rejected=expect(result).rejects.toThrow(/INSPECTION_TIMEOUT/);
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
  });

  it('releases its exact lease even when the page becomes protected, without touching page content',async()=>{
    const {chrome,control,command}=await fixture();
    await expect(control.execute(command('close'))).rejects.toThrow(/EXECUTOR_TAB/);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    chrome.tabs.get.mockClear();
    expect(await control.execute(command('release'))).toMatchObject({value:{released:true}});
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
    expect(chrome.debugger.detach).toHaveBeenCalledExactlyOnceWith({tabId:17});
    expect(chrome.storage.session.set.mock.lastCall?.[0]).toMatchObject({cosBrowserControl:{tabs:[]}});
  });

  it('does not let another caller release a protected lease',async()=>{
    const {chrome,control,command}=await fixture();
    await expect(control.execute(command('release','B'))).rejects.toThrow(/TAB_OWNED/);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(await control.execute(command('release'))).toMatchObject({value:{released:true}});
  });
});
