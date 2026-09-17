import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('extension/browser-control.js','utf8')
  .replace(/^import .*\n/, '').replace('export function ', 'function ');

async function fixture() {
  const saved = {browserId:randomUUID(),epoch:'epoch',receipt:null,tabs:[{tabId:17,owner:'A',lease:'lease'}]};
  const chrome = {
    storage:{session:{get:vi.fn(async()=>({cosBrowserControl:saved})),set:vi.fn(async(_value:unknown)=>{})}},
    permissions:{contains:vi.fn(async()=>true)},
    tabs:{get:vi.fn(async()=>({id:17,url:'https://fixture.invalid/'})),remove:vi.fn(async()=>{})},
    scripting:{executeScript:vi.fn(async()=>[])},
    debugger:{detach:vi.fn(async()=>{}),sendCommand:vi.fn(async()=>({}))}
  };
  const create = runInNewContext(`${source};createBrowserControl`, {crypto:{randomUUID},navigator:{userAgent:'Chrome'},setTimeout,clearTimeout,TextEncoder,URL});
  const control = create(chrome,async()=>({ok:true,data:{epoch:'epoch',policy:{read:true,write:true},requests:[]}}),()=>true);
  await control.pump();
  const command = (action:string,owner='A')=>({id:'call',epoch:'epoch',owner,conversationId:null,tool:'browser_tabs',args:{action,tabId:17},expiresAt:Date.now()+25000});
  return {chrome,control,command};
}

describe('browser extension release custody',()=>{
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
