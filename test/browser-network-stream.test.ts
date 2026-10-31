import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('extension/browser-control.js','utf8')
  .replace(/^import .*\n/, '').replace('export function ', 'function ');
const encoded = (bytes: string | Uint8Array) => Buffer.from(bytes).toString('base64');
function deferred<T>() {
  let resolve!: (value:T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise,resolve};
}

async function fixture(options: {url?:string; protected?:boolean; deferReady?:boolean; freshAttach?:boolean} = {}) {
  const saved = {browserId:randomUUID(),epoch:'epoch',receipt:null,
    tabs:options.freshAttach ? [] : [{tabId:17,owner:'A',lease:'lease'}]};
  const chrome = {
    storage:{session:{get:vi.fn(async()=>({cosBrowserControl:saved})),set:vi.fn(async(_value:unknown)=>{})}},
    permissions:{contains:vi.fn(async()=>true)},
    tabs:{get:vi.fn(async()=>({id:17,url:options.url ?? 'https://fixture.invalid/'}))},
    scripting:{executeScript:vi.fn(async()=>[])},
    debugger:{attach:vi.fn(async()=>{}),detach:vi.fn(async()=>{}),getTargets:vi.fn(async()=>[{tabId:17,attached:true}]),
      sendCommand:vi.fn(async(_target:unknown,method:string,_args:unknown):Promise<any>=>
        method === 'Network.streamResourceContent' ? {bufferedData:''}
          : method === 'Network.getResponseBody' ? {body:'legacy body',base64Encoded:false}
          : method === 'Page.getFrameTree' ? {frameTree:{frame:{id:'top-frame',url:options.url ?? 'https://fixture.invalid/'}}}
          : method === 'Page.createIsolatedWorld' ? {executionContextId:1}
          : method === 'Runtime.evaluate' ? {result:{value:{}}} : {})}
  };
  const create = runInNewContext(`${source};createBrowserControl`, {
    browserPage:()=>{},crypto:{randomUUID},navigator:{userAgent:'Chrome'},setTimeout,clearTimeout,TextEncoder,TextDecoder,URL,atob,btoa
  });
  let allowed = true;
  const transport = vi.fn(async()=>({ok:true,data:{allowed,epoch:'epoch',policy:{read:true,write:true},requests:[]}}));
  const control = create(chrome,transport,()=>options.protected === true);
  if(!options.deferReady) await control.pump();
  const command = (tool:string,args:Record<string,unknown>,owner='A')=>({id:randomUUID(),epoch:'epoch',owner,conversationId:null,tool,args:{tabId:17,...args},expiresAt:Date.now()+25000});
  const call = async(args:Record<string,unknown>,owner='A') => (await control.execute(command('browser_network',args,owner))).value;
  const event = (method:string,params:Record<string,unknown>)=>control.event({tabId:17},method,params);
  const request = async(id='r',mimeType='text/event-stream',url='https://fixture.invalid/events')=> {
    await event('Network.requestWillBeSent',{requestId:id,timestamp:1,request:{url,method:'POST',headers:{Authorization:'secret-fixture'},postData:'fixture'}});
    await event('Network.responseReceived',{requestId:id,response:{status:200,mimeType}});
    return `main:${id}`;
  };
  const chunk = (data:string,id='r')=>event('Network.dataReceived',{requestId:id,data,dataLength:Buffer.from(data,'base64').length});
  const finish = (id='r')=>event('Network.loadingFinished',{requestId:id,timestamp:2,encodedDataLength:1});
  return {chrome,control,command,call,event,request,chunk,finish,revokePermission:()=>{allowed=false;},restorePermission:()=>{allowed=true;}};
}

describe('explicit bounded browser SSE capture',()=>{
  it('attaches an ordinary ChatGPT tab and drops its iframe request before navigation away',async()=>{
    const f=await fixture({url:'https://chatgpt.com/c/fixture',freshAttach:true});
    expect((await f.control.execute(f.command('browser_tabs',{action:'attach'}))).value)
      .toMatchObject({attached:true,url:'https://chatgpt.com/c/fixture'});
    expect(f.chrome.debugger.attach).toHaveBeenCalledWith({tabId:17},'1.3');
    await f.event('Target.attachedToTarget',{
      sessionId:'iframe-session',targetInfo:{type:'iframe',url:'https://embedded.invalid/frame'}
    });
    await f.control.event({tabId:17,sessionId:'iframe-session'},'Network.requestWillBeSent',{
      requestId:'iframe-private',timestamp:1,documentURL:'https://embedded.invalid/frame',
      request:{url:'https://api.embedded.invalid/private',method:'POST',headers:{'X-Fixture':'synthetic'},postData:'fixture-private'}
    });
    await f.control.event({tabId:17,sessionId:'iframe-session'},'Network.responseReceived',{
      requestId:'iframe-private',response:{status:200,mimeType:'text/event-stream'}
    });
    f.chrome.tabs.get.mockResolvedValue({id:17,url:'https://fixture.invalid/'});
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',url:'https://fixture.invalid/'}});
    expect((await f.call({})).entries).toHaveLength(0);
    await expect(f.call({requestId:'iframe-session:iframe-private'})).rejects.toThrow(/REQUEST_EXPIRED/);
  });
  it('reseeds the top-level origin when navigation happens between preflight and debugger attach',async()=>{
    const options={url:'https://safe.invalid/',freshAttach:true};
    const f=await fixture(options);
    const attachStarted=deferred<void>(),finishAttach=deferred<void>();
    let currentUrl='https://safe.invalid/';
    f.chrome.tabs.get.mockImplementation(async()=>({id:17,url:currentUrl,status:'complete'}));
    f.chrome.debugger.attach.mockImplementation(async()=>{
      attachStarted.resolve();
      await finishAttach.promise;
    });
    const attaching=f.control.execute(f.command('browser_tabs',{action:'attach'}));
    await attachStarted.promise;
    // The navigation occurs while Chrome has not yet attached the debugger, so
    // this controller cannot receive Page.frameNavigated for the ChatGPT page.
    currentUrl='https://chatgpt.com/c/fixture';
    options.url=currentUrl;
    finishAttach.resolve();
    expect((await attaching).value).toMatchObject({attached:true,url:'https://chatgpt.com/c/fixture'});
    await f.event('Target.attachedToTarget',{
      sessionId:'late-chatgpt-iframe',targetInfo:{type:'iframe',url:'https://embedded.invalid/frame'}
    });
    await f.control.event({tabId:17,sessionId:'late-chatgpt-iframe'},'Network.requestWillBeSent',{
      requestId:'late-private',timestamp:1,documentURL:'https://embedded.invalid/frame',
      request:{url:'https://api.embedded.invalid/private',method:'POST',headers:{'X-Fixture':'synthetic'},postData:'fixture-private'}
    });
    await f.control.event({tabId:17,sessionId:'late-chatgpt-iframe'},'Network.responseReceived',{
      requestId:'late-private',response:{status:200,mimeType:'text/event-stream'}
    });
    currentUrl='https://safe-after.invalid/';
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',url:currentUrl}});
    expect((await f.call({})).entries).toHaveLength(0);
    await expect(f.call({requestId:'late-chatgpt-iframe:late-private'})).rejects.toThrow(/REQUEST_EXPIRED/);
  });
  it('rejects response bytes from ChatGPT tabs even when the tab is already owned',async()=>{
    const f=await fixture({url:'https://chatgpt.com/c/fixture',protected:true});
    const requestId=await f.request();
    await expect(f.call({requestId,stream:true})).rejects.toThrow(/PROTECTED|CHATGPT|EXECUTOR_TAB/);
    await expect(f.call({requestId,body:true})).rejects.toThrow(/PROTECTED|CHATGPT|EXECUTOR_TAB/);
    expect(f.chrome.debugger.sendCommand.mock.calls.some(c=>c[1]==='Network.streamResourceContent'||c[1]==='Network.getResponseBody')).toBe(false);
  });
  it('rejects a non-ChatGPT tab reserved by CoS orchestration',async()=>{
    const f=await fixture({url:'https://fixture.invalid/',protected:true}),requestId=await f.request();
    await expect(f.call({requestId,stream:true})).rejects.toThrow(/NETWORK_PROTECTED/);
    await expect(f.call({requestId,body:true})).rejects.toThrow(/NETWORK_PROTECTED/);
    expect(f.chrome.debugger.sendCommand.mock.calls.some(c=>c[1]==='Network.streamResourceContent'||c[1]==='Network.getResponseBody')).toBe(false);
  });
  it('resumes ordinary network capture when non-ChatGPT orchestration protection ends',async()=>{
    const options={protected:true};
    const f=await fixture(options);
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',url:'https://fixture.invalid/'}});
    options.protected=false;
    const requestId=await f.request('resumed');
    expect((await f.call({})).entries).toHaveLength(1);
    expect((await f.call({requestId})).requestId).toBe(requestId);
  });
  it.each(['https://chatgpt.com/c/fixture','https://chat.openai.com/c/fixture','https://chatgpt.com./c/fixture','https://www.chatgpt.com./c/fixture','https://chat.openai.com./c/fixture'])('blocks %s even without a protected-tab marker',async(url)=>{
    const f=await fixture({url});
    const requestId=await f.request();
    await expect(f.call({requestId,stream:true})).rejects.toThrow(/NETWORK_PROTECTED/);
    await expect(f.call({requestId,body:true})).rejects.toThrow(/NETWORK_PROTECTED/);
    expect(f.chrome.debugger.sendCommand.mock.calls.some(c=>c[1]==='Network.streamResourceContent'||c[1]==='Network.getResponseBody')).toBe(false);
  });
  it('blocks an already-owned tab after it navigates to ChatGPT',async()=>{
    const f=await fixture(),requestId=await f.request();
    f.chrome.tabs.get.mockResolvedValue({id:17,url:'https://chatgpt.com/c/fixture'});
    await expect(f.call({requestId,stream:true})).rejects.toThrow(/NETWORK_PROTECTED/);
    expect(f.chrome.debugger.sendCommand.mock.calls.some(c=>c[1]==='Network.streamResourceContent')).toBe(false);
  });
  it('never retains ChatGPT request metadata or body from a different page',async()=>{
    const f=await fixture(),requestId=await f.request('chatgpt','text/event-stream','https://chatgpt.com/backend-api/conversation');
    await expect(f.call({requestId,stream:true})).rejects.toThrow(/REQUEST_EXPIRED/);
    await expect(f.call({requestId,body:true})).rejects.toThrow(/REQUEST_EXPIRED/);
    expect(JSON.stringify(await f.call({}))).not.toContain('chatgpt.com');
    expect(f.chrome.debugger.sendCommand.mock.calls.some(c=>c[1]==='Network.streamResourceContent'||c[1]==='Network.getResponseBody')).toBe(false);
  });
  it('excludes a ChatGPT request using the terminal-dot FQDN spelling',async()=>{
    const f=await fixture(),requestId=await f.request('fqdn','text/event-stream','https://chatgpt.com./backend-api/conversation');
    expect((await f.call({})).entries).toHaveLength(0);
    await expect(f.call({requestId,body:true})).rejects.toThrow(/REQUEST_EXPIRED/);
  });
  it('drops third-party requests carrying a ChatGPT document URL before frame navigation arrives',async()=>{
    const f=await fixture();
    await f.event('Network.requestWillBeSent',{requestId:'third-party',timestamp:1,documentURL:'https://chatgpt.com/c/fixture',request:{url:'https://external.invalid/private',method:'GET'}});
    await f.event('Network.responseReceived',{requestId:'third-party',response:{status:200,mimeType:'text/event-stream'}});
    expect((await f.call({})).entries).toHaveLength(0);
  });
  it('does not retain third-party traffic from an already-open ChatGPT tab without a documentURL',async()=>{
    const f=await fixture({url:'https://chatgpt.com/c/fixture'});
    await f.event('Network.requestWillBeSent',{requestId:'third-party',timestamp:1,request:{url:'https://external.invalid/private',method:'GET'}});
    await f.event('Network.responseReceived',{requestId:'third-party',response:{status:200,mimeType:'text/event-stream'}});
    f.chrome.tabs.get.mockResolvedValue({id:17,url:'https://fixture.invalid/'});
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',url:'https://fixture.invalid/'}});
    expect((await f.call({})).entries).toHaveLength(0);
  });
  it('does not admit an old ChatGPT event that arrived before restored tab provenance settled',async()=>{
    const f=await fixture({url:'https://chatgpt.com/c/fixture',deferReady:true});
    const origin=deferred<{id:number;url:string}>();
    f.chrome.tabs.get.mockImplementation(async()=>origin.promise);
    const pending=f.event('Network.requestWillBeSent',{requestId:'startup-private',timestamp:1,
      documentURL:'https://embedded.invalid/app',
      request:{url:'https://api.embedded.invalid/private',method:'POST',postData:'fixture-private'}});
    const navigated=f.event('Page.frameNavigated',{frame:{id:'top-frame',url:'https://fixture.invalid/'}});
    origin.resolve({id:17,url:'https://fixture.invalid/'});
    await Promise.all([pending,navigated]);await f.control.pump();
    expect((await f.call({})).entries).toHaveLength(0);
  });
  it('rejects a cross-origin child request from an already-open ChatGPT tab after leaving it',async()=>{
    const f=await fixture({url:'https://chatgpt.com/c/fixture'});
    await f.event('Target.attachedToTarget',{sessionId:'child-session',targetInfo:{type:'iframe',url:'https://embedded.invalid/app'}});
    await f.control.event({tabId:17,sessionId:'child-session'},'Network.requestWillBeSent',{
      requestId:'private',timestamp:1,documentURL:'https://embedded.invalid/app',
      request:{url:'https://api.embedded.invalid/private',method:'POST',headers:{'X-Private':'synthetic-secret'},postData:'fixture-private'}
    });
    f.chrome.tabs.get.mockResolvedValue({id:17,url:'https://fixture.invalid/'});
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',url:'https://fixture.invalid/'}});
    expect((await f.call({})).entries).toHaveLength(0);
    await expect(f.call({requestId:'child-session:private'})).rejects.toThrow(/REQUEST_EXPIRED/);
  });
  it('rejects an old ChatGPT child-session event after the top document commits a safe page',async()=>{
    const f=await fixture({url:'https://chatgpt.com/c/fixture'});
    await f.event('Target.attachedToTarget',{sessionId:'child-old',targetInfo:{type:'iframe',url:'https://embedded.invalid/app'}});
    f.chrome.tabs.get.mockResolvedValue({id:17,url:'https://fixture.invalid/'});
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',url:'https://fixture.invalid/'}});
    await f.control.event({tabId:17,sessionId:'child-old'},'Network.requestWillBeSent',{
      requestId:'stale',timestamp:1,documentURL:'https://embedded.invalid/app',
      request:{url:'https://api.embedded.invalid/private',method:'POST',headers:{'X-Private':'fixture-secret'},postData:'fixture-private'}
    });
    expect((await f.call({})).entries).toHaveLength(0);
    await expect(f.call({requestId:'child-old:stale'})).rejects.toThrow(/REQUEST_EXPIRED/);
    await f.event('Target.attachedToTarget',{sessionId:'child-new',targetInfo:{type:'iframe',url:'https://safe-child.invalid/app'}});
    await f.control.event({tabId:17,sessionId:'child-new'},'Network.requestWillBeSent',{
      requestId:'good',timestamp:2,request:{url:'https://safe-child.invalid/data',method:'GET'}
    });
    expect((await f.call({})).entries).toHaveLength(1);
  });
  it('does not accept requests from a child debugger session whose initialization failed',async()=>{
    const f=await fixture();
    f.chrome.debugger.sendCommand.mockRejectedValueOnce(new Error('synthetic session initialization failure'));
    await f.event('Target.attachedToTarget',{sessionId:'child-failed',targetInfo:{type:'iframe',url:'https://child.invalid/'}});
    await f.control.event({tabId:17,sessionId:'child-failed'},'Network.requestWillBeSent',{
      requestId:'not-authorized',timestamp:1,request:{url:'https://child.invalid/private',method:'GET'}
    });
    expect((await f.call({})).entries).toHaveLength(0);
  });
  it('retains no child request while its debugger initialization is pending and later fails',async()=>{
    const f=await fixture(),opened=deferred<void>(),fail=deferred<void>();
    const original=f.chrome.debugger.sendCommand.getMockImplementation()!;
    f.chrome.debugger.sendCommand.mockImplementation(async(target,method,args)=>{
      if(method==='Page.enable' && (target as {sessionId?:string}).sessionId==='child-pending'){
        opened.resolve();await fail.promise;throw new Error('synthetic child initialization rejected');
      }
      return original(target,method,args);
    });
    const attaching=f.event('Target.attachedToTarget',{
      sessionId:'child-pending',targetInfo:{type:'iframe',url:'https://child.invalid/app'}
    });
    await opened.promise;
    await f.control.event({tabId:17,sessionId:'child-pending'},'Network.requestWillBeSent',{
      requestId:'during-init',timestamp:1,request:{url:'https://api.child.invalid/private',method:'POST',postData:'synthetic-private'}
    });
    await f.control.event({tabId:17,sessionId:'child-pending'},'Network.responseReceived',{
      requestId:'during-init',response:{status:200,mimeType:'text/event-stream'}
    });
    const whilePending=(await f.call({})).entries;
    fail.resolve();await attaching;
    expect(whilePending).toHaveLength(0);
    expect((await f.call({})).entries).toHaveLength(0);
    await expect(f.call({requestId:'child-pending:during-init'})).rejects.toThrow(/REQUEST_EXPIRED/);
  });
  it('does not admit a protected request whose tab lookup finishes after navigation',async()=>{
    const f=await fixture({url:'https://chatgpt.com/c/fixture'});
    await f.event('Target.attachedToTarget',{sessionId:'child-session',targetInfo:{type:'iframe',url:'https://embedded.invalid/app'}});
    const lookup=deferred<{id:number;url:string}>();
    f.chrome.tabs.get.mockImplementation(async()=>lookup.promise);
    const pending=f.control.event({tabId:17,sessionId:'child-session'},'Network.requestWillBeSent',{
      requestId:'private-late',timestamp:1,documentURL:'https://embedded.invalid/app',
      request:{url:'https://api.embedded.invalid/private',method:'POST',headers:{'X-Private':'synthetic-secret'},postData:'fixture-private'}
    });
    await Promise.resolve();
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',url:'https://fixture.invalid/'}});
    lookup.resolve({id:17,url:'https://fixture.invalid/'});
    await pending;
    expect((await f.call({})).entries).toHaveLength(0);
    await expect(f.call({requestId:'child-session:private-late'})).rejects.toThrow(/REQUEST_EXPIRED/);
  });
  it('preserves responseReceived ordering without waiting on a tab lookup per request',async()=>{
    const f=await fixture(),lookup=deferred<{id:number;url:string}>();
    f.chrome.tabs.get.mockImplementation(async()=>lookup.promise);
    const sent=f.event('Network.requestWillBeSent',{
      requestId:'ordered',timestamp:1,request:{url:'https://fixture.invalid/events',method:'GET'}
    });
    await Promise.resolve();
    await f.event('Network.responseReceived',{requestId:'ordered',response:{status:200,mimeType:'text/event-stream'}});
    lookup.resolve({id:17,url:'https://fixture.invalid/'});await sent;
    expect(await f.call({requestId:'main:ordered'})).toMatchObject({status:200,mimeType:'text/event-stream'});
  });
  it('rejects a late legacy response body after read permission is revoked',async()=>{
    const f=await fixture(),requestId=await f.request(),started=deferred<void>(),response=deferred<{body:string;base64Encoded:boolean}>();
    f.chrome.debugger.sendCommand.mockImplementation(async(_target,method)=>{
      if(method==='Network.getResponseBody'){started.resolve();return response.promise;}
      return {};
    });
    const pending=f.call({requestId,body:true});await started.promise;
    f.revokePermission();
    const rejected=expect(pending).rejects.toThrow(/PERMISSION_REVOKED/);
    response.resolve({body:'SECRET_AFTER_REVOKE',base64Encoded:false});await rejected;
  });
  it('rejects a retained stream byte page when permission is revoked during the final tab check',async()=>{
    const f=await fixture(),requestId=await f.request(),started=deferred<void>(),lookup=deferred<{id:number;url:string}>();
    await f.call({requestId,stream:true});await f.chunk(encoded('SECRET_STREAM_BYTES'));await f.finish();
    let lookups=0;
    f.chrome.tabs.get.mockImplementation(async()=>{
      if(++lookups===2){started.resolve();return lookup.promise;}
      return {id:17,url:'https://fixture.invalid/'};
    });
    const pending=f.call({requestId,body:true});await started.promise;
    f.revokePermission();
    const rejected=expect(pending).rejects.toThrow(/PERMISSION_REVOKED/);
    lookup.resolve({id:17,url:'https://fixture.invalid/'});await rejected;
  });
  it('disposes existing response buffers when the main frame enters ChatGPT',async()=>{
    const f=await fixture(),requestId=await f.request();
    await f.call({requestId,stream:true});await f.chunk(encoded('prior bytes'));
    expect((await f.call({requestId})).stream.retainedBytes).toBeGreaterThan(0);
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',url:'https://chatgpt.com/c/fixture'}});
    await expect(f.call({requestId,body:true})).rejects.toThrow(/REQUEST_EXPIRED/);
    expect((await f.call({})).entries).toHaveLength(0);
  });
  it('discards third-party requests made by a ChatGPT page even after navigation away',async()=>{
    const f=await fixture();
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',url:'https://chatgpt.com/c/fixture'}});
    const requestId=await f.request('third-party','text/event-stream','https://external.invalid/private');
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',url:'https://fixture.invalid/'}});
    expect((await f.call({})).entries).toHaveLength(0);
    await expect(f.call({requestId,body:true})).rejects.toThrow(/REQUEST_EXPIRED/);
    expect(f.chrome.debugger.sendCommand.mock.calls.some(c=>c[1]==='Network.getResponseBody')).toBe(false);
  });
  it('rejects a late legacy body after navigation invalidates the original page',async()=>{
    const f=await fixture(),requestId=await f.request(),started=deferred<void>(),response=deferred<{body:string;base64Encoded:boolean}>();
    f.chrome.debugger.sendCommand.mockImplementation(async(_target,method)=>{
      if(method==='Network.getResponseBody'){started.resolve();return response.promise;}
      return {};
    });
    const pending=f.call({requestId,body:true});await started.promise;
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',url:'https://chatgpt.com/c/fixture'}});
    const rejected=expect(pending).rejects.toThrow(/REQUEST_EXPIRED|NETWORK_PROTECTED/);
    response.resolve({body:'SECRET_RESPONSE_BYTES',base64Encoded:false});await rejected;
  });
  it('rejects late stream enabling when the tab becomes ChatGPT while CDP is pending',async()=>{
    const f=await fixture(),requestId=await f.request(),opened=deferred<void>(),enable=deferred<{bufferedData:string}>();
    f.chrome.debugger.sendCommand.mockImplementation(async(_target,method)=>{
      if(method==='Network.streamResourceContent'){opened.resolve();return enable.promise;}
      return {};
    });
    const pending=f.call({requestId,stream:true});await opened.promise;
    f.chrome.tabs.get.mockResolvedValue({id:17,url:'https://chatgpt.com/c/fixture'});
    const rejected=expect(pending).rejects.toThrow(/NETWORK_PROTECTED/);
    enable.resolve({bufferedData:encoded('PRIVATE_RESPONSE')});await rejected;
  });
  it('does not claim complete if live bytes are missing while SSE enable is pending',async()=>{
    const f=await fixture(),requestId=await f.request(),opened=deferred<void>(),enable=deferred<{bufferedData:string}>();
    f.chrome.debugger.sendCommand.mockImplementation(async(_target,method)=>{
      if(method==='Network.streamResourceContent'){opened.resolve();return enable.promise;}
      return {};
    });
    const pending=f.call({requestId,stream:true});await opened.promise;
    await f.event('Network.dataReceived',{requestId:'r',dataLength:12});
    await f.finish();
    enable.resolve({bufferedData:''});await pending;
    expect((await f.call({requestId})).stream).toMatchObject({terminal:true,complete:false,invalidBytes:true});
  });
  it('frees stale stream allocation when pageId changes on ordinary navigation',async()=>{
    const f=await fixture(),requestId=await f.request('old');
    await f.call({requestId,stream:true});await f.chunk(encoded('x'.repeat(4*1024*1024)),'old');await f.finish('old');
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',url:'https://another.invalid/'}});
    const next=await f.request('next');await f.call({requestId:next,stream:true});await f.chunk(encoded('next'),'next');await f.finish('next');
    expect((await f.call({requestId:next})).stream).toMatchObject({overflow:false,retainedBytes:4,complete:true});
  });
  it.each(['subframe','same-document'])('retains a main-page SSE across unrelated %s navigation',async(kind)=>{
    const f=await fixture(),requestId=await f.request();
    await f.call({requestId,stream:true});
    await f.chunk(encoded('before-'));
    if(kind==='subframe') await f.event('Page.frameNavigated',{frame:{id:'child-frame',parentId:'main-frame',url:'https://child.invalid/'}});
    else await f.event('Page.navigatedWithinDocument',{frameId:'main-frame',url:'https://fixture.invalid/#next'});
    await f.chunk(encoded('after'));await f.finish();
    const page=await f.call({requestId,body:true});
    expect(page.stream).toMatchObject({retainedBytes:12,terminal:true,complete:true});
    expect(Buffer.from(page.body.base64,'base64').toString()).toBe('before-after');
  });
  it.each(['child-navigation','child-detach'])('expires the child response byte buffer on %s without affecting the main tab',async(action)=>{
    const f=await fixture(),child='child-session:child-request';
    await f.event('Target.attachedToTarget',{sessionId:'child-session',targetInfo:{type:'iframe',url:'https://child.invalid/'}});
    await f.control.event({tabId:17,sessionId:'child-session'},'Network.requestWillBeSent',{
      requestId:'child-request',frameId:'child-frame',timestamp:1,
      request:{url:'https://child.invalid/sse',method:'GET'}
    });
    await f.control.event({tabId:17,sessionId:'child-session'},'Network.responseReceived',{
      requestId:'child-request',response:{status:200,mimeType:'text/event-stream'}
    });
    await f.call({requestId:child,stream:true});
    await f.control.event({tabId:17,sessionId:'child-session'},'Network.dataReceived',{
      requestId:'child-request',data:encoded('child-data'),dataLength:10
    });
    if(action==='child-navigation') await f.control.event({tabId:17,sessionId:'child-session'},'Page.frameNavigated',{
      frame:{id:'child-frame',parentId:'main-frame',url:'https://next-child.invalid/'}
    });
    else await f.event('Target.detachedFromTarget',{sessionId:'child-session'});
    await expect(f.call({requestId:child,body:true})).rejects.toThrow(/REQUEST_EXPIRED/);
  });
  it('excludes third-party responses from a ChatGPT child frame on an otherwise safe tab',async()=>{
    const f=await fixture();
    await f.event('Page.frameNavigated',{frame:{id:'child-frame',parentId:'main-frame',url:'https://chatgpt.com/c/fixture'}});
    await f.event('Network.requestWillBeSent',{requestId:'child-private',frameId:'child-frame',timestamp:1,
      request:{url:'https://api.child.invalid/private',method:'GET'}
    });
    expect((await f.call({})).entries).toHaveLength(0);
  });
  it('preserves the destination document body across its own frame commit without reviving an older page',async()=>{
    const f=await fixture(),old=await f.request('old');
    await f.event('Network.requestWillBeSent',{requestId:'document',frameId:'top-frame',loaderId:'new-loader',type:'Document',timestamp:2,
      request:{url:'https://new-safe.invalid/',method:'GET'}});
    await f.event('Page.frameNavigated',{frame:{id:'top-frame',loaderId:'new-loader',url:'https://new-safe.invalid/'}});
    await f.event('Network.responseReceived',{requestId:'document',response:{status:200,mimeType:'text/html'}});
    await f.finish('document');
    await expect(f.call({requestId:old,body:true})).rejects.toThrow(/REQUEST_EXPIRED/);
    expect((await f.call({requestId:'main:document',body:true})).body).toMatchObject({text:'legacy body',base64Encoded:false});
    expect(JSON.stringify(await f.call({}))).not.toContain('new-loader');
  });

  it('preserves legacy body reads and does not implicitly retain streams',async()=>{
    const f=await fixture(),requestId=await f.request();
    expect(await f.call({requestId,body:true})).toMatchObject({body:{text:'legacy body',base64Encoded:false,truncated:false}});
    expect(f.chrome.debugger.sendCommand.mock.calls.some(c=>c[1]==='Network.streamResourceContent')).toBe(false);
    await expect(f.call({requestId,body:true,bodyOffset:0})).rejects.toThrow(/STREAM_REQUIRED/);
  });

  it('admits only in-flight SSE and preserves exact owner and permission checks',async()=>{
    const f=await fixture(),json=await f.request('json','application/json');
    await expect(f.call({requestId:json,stream:true})).rejects.toThrow(/IN_FLIGHT_SSE/);
    const ended=await f.request('ended');await f.finish('ended');
    await expect(f.call({requestId:ended,stream:true})).rejects.toThrow(/IN_FLIGHT_SSE/);
    const requestId=await f.request();
    await expect(f.call({requestId,stream:true},'B')).rejects.toThrow(/TAB_OWNED/);
    f.revokePermission();
    await expect(f.call({requestId,stream:true})).rejects.toThrow(/PERMISSION_REVOKED/);
    expect(f.chrome.debugger.sendCommand.mock.calls.some(c=>c[1]==='Network.streamResourceContent')).toBe(false);
  });

  it('prepends buffered bytes once before racing live chunks and pages across UTF-8 boundaries',async()=>{
    const f=await fixture(),requestId=await f.request(),opened=deferred<void>(),enable=deferred<{bufferedData:string}>();
    const data=Buffer.from('data: Việt 😀\n\n');
    const split=data.indexOf(Buffer.from('ệ'))+1;
    f.chrome.debugger.sendCommand.mockImplementation(async(_target,method)=>{
      if(method==='Network.streamResourceContent'){opened.resolve();return enable.promise;}return {};
    });
    const pending=f.call({requestId,stream:true});await opened.promise;
    await f.chunk(encoded(data.subarray(split)));
    await f.finish();
    enable.resolve({bufferedData:encoded(data.subarray(0,split))});
    expect(await pending).toMatchObject({stream:{pending:false,terminal:true,complete:true,retainedBytes:data.length}});
    const pages:Buffer[]=[];let offset=0;
    do {
      const value=await f.call({requestId,body:true,bodyOffset:offset,bodyBytes:1});
      pages.push(Buffer.from(value.body.base64,'base64'));
      expect(value.body).toMatchObject({offsetBytes:offset,returnedBytes:1,complete:true});
      if(value.body.nextOffsetBytes===null)break;
      offset=value.body.nextOffsetBytes;
    } while(offset<data.length);
    expect(Buffer.concat(pages)).toEqual(data);
    expect(await f.call({requestId,stream:true})).toMatchObject({stream:{complete:true}});
    expect(f.chrome.debugger.sendCommand.mock.calls.filter(c=>c[1]==='Network.streamResourceContent')).toHaveLength(1);
    const listed=await f.call({});
    expect(JSON.stringify(listed)).not.toContain('chunks');
    expect(JSON.stringify(listed)).not.toContain(encoded(data));
    expect(await f.call({requestId})).toMatchObject({requestHeaders:{Authorization:'[redacted]'}});
  });

  it('distinguishes a currently empty page from terminal completion and validates byte bounds',async()=>{
    const f=await fixture(),requestId=await f.request();await f.call({requestId,stream:true});
    expect(await f.call({requestId,body:true})).toMatchObject({body:{base64:'',returnedBytes:0,nextOffsetBytes:null,terminal:false,complete:false}});
    for(const args of [{bodyOffset:-1},{bodyOffset:1},{bodyBytes:0},{bodyBytes:262145},{bodyBytes:1.5}]) {
      await expect(f.call({requestId,body:true,...args})).rejects.toThrow(/STREAM_(PAGE|OFFSET)_INVALID/);
    }
    await f.chunk(encoded('data: ok\n\n'));await f.finish();
    expect(await f.call({requestId,body:true})).toMatchObject({body:{terminal:true,complete:true}});
  });

  it.each(['%%%=', 'YR=='])('does not claim complete for invalid base64 %s',async(bad)=>{
    const f=await fixture(),requestId=await f.request();await f.call({requestId,stream:true});
    await f.chunk(bad);await f.finish();
    expect(await f.call({requestId,body:true})).toMatchObject({stream:{terminal:true,complete:false,invalidBytes:true}});
  });

  it('does not claim complete when UTF-8 is malformed or ends mid-character',async()=>{
    for(const bytes of [Uint8Array.from([0xff]),Uint8Array.from([0xf0,0x9f])]) {
      const f=await fixture(),requestId=await f.request();await f.call({requestId,stream:true});
      await f.chunk(encoded(bytes));await f.finish();
      expect(await f.call({requestId})).toMatchObject({stream:{terminal:true,complete:false,invalidBytes:true}});
    }
  });

  it('marks an aborted request terminal but incomplete',async()=>{
    const f=await fixture(),requestId=await f.request();await f.call({requestId,stream:true});
    await f.chunk(encoded('data: partial\n\n'));
    await f.event('Network.loadingFailed',{requestId:'r',errorText:'net::ERR_ABORTED'});
    expect(await f.call({requestId,body:true})).toMatchObject({stream:{terminal:true,complete:false,error:'net::ERR_ABORTED'}});
  });

  it('does not claim complete when a live event omits bytes or a failure omits error text',async()=>{
    const f=await fixture(),requestId=await f.request();await f.call({requestId,stream:true});
    await f.event('Network.dataReceived',{requestId:'r',dataLength:12});await f.finish();
    expect(await f.call({requestId})).toMatchObject({stream:{terminal:true,complete:false,invalidBytes:true}});
    const other=await f.request('failed');await f.call({requestId:other,stream:true});
    await f.event('Network.loadingFailed',{requestId:'failed'});
    expect(await f.call({requestId:other})).toMatchObject({stream:{terminal:true,complete:false,error:'Network request failed.'}});
    const empty=await f.request('empty');await f.call({requestId:empty,stream:true});
    await f.event('Network.loadingFailed',{requestId:'empty',errorText:''});
    expect(await f.call({requestId:empty})).toMatchObject({stream:{terminal:true,complete:false,error:'Network request failed.'}});
  });

  it.each(['',encoded('short')])('rejects an event whose declared byte length exceeds its data',async(data)=>{
    const f=await fixture(),requestId=await f.request();await f.call({requestId,stream:true});
    await f.event('Network.dataReceived',{requestId:'r',dataLength:20,data});await f.finish();
    expect(await f.call({requestId})).toMatchObject({stream:{terminal:true,complete:false,invalidBytes:true}});
  });

  it('discards a racing suffix if the buffered prefix cannot fit, never labelling the suffix byte zero',async()=>{
    const f=await fixture(),requestId=await f.request(),opened=deferred<void>(),enable=deferred<{bufferedData:string}>();
    f.chrome.debugger.sendCommand.mockImplementation(async(_target,method)=>{
      if(method==='Network.streamResourceContent'){opened.resolve();return enable.promise;}return {};
    });
    const pending=f.call({requestId,stream:true});await opened.promise;
    await f.chunk(encoded('s'.repeat(3*1024*1024)));
    enable.resolve({bufferedData:encoded('p'.repeat(2*1024*1024))});await pending;await f.finish();
    expect(await f.call({requestId,body:true})).toMatchObject({stream:{retainedBytes:0,overflow:true,complete:false},body:{base64:'',offsetBytes:0,returnedBytes:0,complete:false}});
    const next=await f.request('next');
    f.chrome.debugger.sendCommand.mockImplementation(async()=>({bufferedData:''}));
    await f.call({requestId:next,stream:true});await f.chunk(encoded('x'.repeat(4*1024*1024)),'next');await f.finish('next');
    expect(await f.call({requestId:next})).toMatchObject({stream:{retainedBytes:4*1024*1024,complete:true}});
  });

  it('shares a 4 MiB retained byte budget across requests and releases it on clear',async()=>{
    const f=await fixture(),a=await f.request('a'),b=await f.request('b');
    await f.call({requestId:a,stream:true});await f.call({requestId:b,stream:true});
    await f.chunk(encoded('x'.repeat(4*1024*1024)),'a');
    await f.chunk(encoded('overflow'),'b');await f.finish('a');await f.finish('b');
    expect(await f.call({requestId:a})).toMatchObject({stream:{retainedBytes:4*1024*1024,complete:true}});
    expect(await f.call({requestId:b})).toMatchObject({stream:{retainedBytes:0,overflow:true,complete:false}});
    const page=await f.call({requestId:a,body:true});
    expect(page.body.returnedBytes).toBe(64*1024);
    expect((await f.call({requestId:a,body:true,bodyBytes:256*1024})).body.returnedBytes).toBe(256*1024);
    await f.call({clear:true});
    await expect(f.call({requestId:a})).rejects.toThrow(/REQUEST_EXPIRED/);
    const next=await f.request('next');await f.call({requestId:next,stream:true});
    await f.chunk(encoded('y'.repeat(4*1024*1024)),'next');await f.finish('next');
    expect(await f.call({requestId:next})).toMatchObject({stream:{retainedBytes:4*1024*1024,complete:true}});
  });

  it('bounds tiny/empty event metadata as well as byte storage',async()=>{
    const f=await fixture(),requestId=await f.request();await f.call({requestId,stream:true});
    for(let i=0;i<4097;i++)await f.chunk(encoded('a'));
    await f.finish();
    expect(await f.call({requestId})).toMatchObject({stream:{overflow:true,complete:false,retainedBytes:4096}});
  });

  it.each(['clear','replace','evict','release'] as const)('never republishes an enable result after %s',async(action)=>{
    const f=await fixture(),requestId=await f.request(),opened=deferred<void>(),enable=deferred<{bufferedData:string}>();
    f.chrome.debugger.sendCommand.mockImplementation(async(_target,method)=>{
      if(method==='Network.streamResourceContent'){opened.resolve();return enable.promise;}return {};
    });
    const pending=f.call({requestId,stream:true});await opened.promise;
    await f.chunk(encoded('suffix'));
    if(action==='clear')await f.call({clear:true});
    if(action==='replace')await f.request();
    if(action==='evict')for(let i=0;i<200;i++)await f.request(`other-${i}`);
    if(action==='release')await f.control.execute(f.command('browser_tabs',{action:'release'}));
    const rejected=expect(pending).rejects.toThrow(/STREAM_EXPIRED|DETACHED/);
    enable.resolve({bufferedData:encoded('prefix')});await rejected;
    if(action==='replace')expect(await f.call({requestId})).not.toHaveProperty('stream');
    else await expect(f.call({requestId})).rejects.toThrow(/REQUEST_EXPIRED|TAB_NOT_OWNED/);
  });

  it('drops capture when permission is revoked during asynchronous enable',async()=>{
    const f=await fixture(),requestId=await f.request(),opened=deferred<void>(),enable=deferred<{bufferedData:string}>();
    f.chrome.debugger.sendCommand.mockImplementation(async(_target,method)=>{
      if(method==='Network.streamResourceContent'){opened.resolve();return enable.promise;}return {};
    });
    const pending=f.call({requestId,stream:true});await opened.promise;
    await f.chunk(encoded('suffix'));f.revokePermission();
    const rejected=expect(pending).rejects.toThrow(/PERMISSION_REVOKED/);
    enable.resolve({bufferedData:encoded('prefix')});await rejected;
    f.restorePermission();
    expect(await f.call({requestId})).not.toHaveProperty('stream');
  });

  it('reports unsupported CDP instead of inventing a retained or complete stream',async()=>{
    const f=await fixture(),requestId=await f.request();
    f.chrome.debugger.sendCommand.mockImplementation(async(_target,method)=>{
      if(method==='Network.streamResourceContent')throw new Error('Method not found');return {};
    });
    await expect(f.call({requestId,stream:true})).rejects.toThrow(/Method not found/);
    expect(await f.call({requestId})).not.toHaveProperty('stream');
  });
});
