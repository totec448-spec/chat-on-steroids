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

async function fixture() {
  const saved = {browserId:randomUUID(),epoch:'epoch',receipt:null,tabs:[{tabId:17,owner:'A',lease:'lease'}]};
  const chrome = {
    storage:{session:{get:vi.fn(async()=>({cosBrowserControl:saved})),set:vi.fn(async(_value:unknown)=>{})}},
    permissions:{contains:vi.fn(async()=>true)},
    tabs:{get:vi.fn(async()=>({id:17,url:'https://fixture.invalid/'}))},
    scripting:{executeScript:vi.fn(async()=>[])},
    debugger:{detach:vi.fn(async()=>{}),getTargets:vi.fn(async()=>[{tabId:17,attached:true}]),
      sendCommand:vi.fn(async(_target:unknown,method:string,_args:unknown):Promise<any>=>
        method === 'Network.streamResourceContent' ? {bufferedData:''} : method === 'Network.getResponseBody' ? {body:'legacy body',base64Encoded:false} : {})}
  };
  const create = runInNewContext(`${source};createBrowserControl`, {
    browserPage:()=>{},crypto:{randomUUID},navigator:{userAgent:'Chrome'},setTimeout,clearTimeout,TextEncoder,TextDecoder,URL,atob,btoa
  });
  let allowed = true;
  const transport = vi.fn(async()=>({ok:true,data:{allowed,epoch:'epoch',policy:{read:true,write:true},requests:[]}}));
  const control = create(chrome,transport,()=>false);
  await control.pump();
  const command = (tool:string,args:Record<string,unknown>,owner='A')=>({id:randomUUID(),epoch:'epoch',owner,conversationId:null,tool,args:{tabId:17,...args},expiresAt:Date.now()+25000});
  const call = async(args:Record<string,unknown>,owner='A') => (await control.execute(command('browser_network',args,owner))).value;
  const event = (method:string,params:Record<string,unknown>)=>control.event({tabId:17},method,params);
  const request = async(id='r',mimeType='text/event-stream')=> {
    await event('Network.requestWillBeSent',{requestId:id,timestamp:1,request:{url:'https://fixture.invalid/events',method:'POST',headers:{Authorization:'secret-fixture'},postData:'fixture'}});
    await event('Network.responseReceived',{requestId:id,response:{status:200,mimeType}});
    return `main:${id}`;
  };
  const chunk = (data:string,id='r')=>event('Network.dataReceived',{requestId:id,data,dataLength:Buffer.from(data,'base64').length});
  const finish = (id='r')=>event('Network.loadingFinished',{requestId:id,timestamp:2,encodedDataLength:1});
  return {chrome,control,command,call,event,request,chunk,finish,revokePermission:()=>{allowed=false;},restorePermission:()=>{allowed=true;}};
}

describe('explicit bounded browser SSE capture',()=>{
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
