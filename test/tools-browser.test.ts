import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '../src/shared/types.js';
import type { SurfaceRegistrar } from '../src/main/mcp/kernel.js';
import { z } from 'zod';

const state = vi.hoisted(() => ({
  caps: {screen:true,control:true}, unattributed:true,
  caller: null as null | {sessionId?:string;conversationId?:string;requestId?:string},
  proofs: new Map<string,{sessionId:string;conversationId:string}>(),
  attachment:'current', blocked:false, execute:vi.fn(), image:vi.fn(async()=> 'image/jpeg'), log:vi.fn()
}));
vi.mock('../src/main/config.js',()=>({getConfig:()=>({multiAgent:{allowUnattributedCalls:state.unattributed}}),effectiveCapabilities:()=>state.caps}));
vi.mock('../src/main/mcp/call-context.js',()=>({currentCall:()=>({caller:state.caller})}));
vi.mock('../src/main/mcp/kernel.js',()=>({fail:(text:string)=>({isError:true,content:[{type:'text',text}]}),failIdentity:(text:string)=>({isError:true,content:[{type:'text',text}]})}));
vi.mock('../src/main/browser-control.js',()=>({browserControl:{execute:state.execute}}));
vi.mock('../src/main/logger.js',()=>({logInfo:state.log}));
vi.mock('../src/main/session/store.js',()=>({conversationAttachment:async()=>state.attachment}));
vi.mock('../src/main/session/correlation.js',()=>({requestCorrelation:(id:string)=>state.proofs.get(id) ?? null}));
vi.mock('../src/main/session/blocked-chats.js',()=>({isChatBlocked:()=>state.blocked}));
vi.mock('../src/main/session/continuation.js',()=>({compactingConversation:()=>false}));
vi.mock('../src/main/agents.js',()=>({dormantWorkerNotice:()=>null,endedWorkerNotice:()=>null,retiredWorkerForConversation:()=>null}));
vi.mock('../src/main/codex/view-image.js',()=>({validateImageBytes:state.image}));
import { registerBrowserTools } from '../src/main/mcp/tools-browser.js';

function registrar() {
  const tools = new Map<string,{schema:z.ZodType;annotations:Record<string,unknown>;handler:(input:unknown)=>Promise<any>}>();
  registerBrowserTools({exposedCaps:{screen:true,control:true} as Capabilities,
    register:(name:string,definition:any,handler:any)=>{tools.set(name,{schema:definition.inputSchema,annotations:definition.annotations,handler});},
    guarded:async(cap:'screen'|'control',_name:string,fn:()=>Promise<unknown>)=>state.caps[cap]?fn():{isError:true,content:[{type:'text',text:'TOOL_DISABLED'}]}
  } as unknown as SurfaceRegistrar);
  return {tools,call:(name:string,input:unknown)=>{const tool=tools.get(name)!;return tool.handler(tool.schema.parse(input));}};
}
const tabId='11111111-1111-4111-8111-111111111111:12';
const pageId='22222222-2222-4222-8222-222222222222';
beforeEach(()=>{
  state.caps={screen:true,control:true};state.unattributed=true;state.caller=null;state.attachment='current';state.blocked=false;
  state.execute.mockReset().mockResolvedValue({value:{ok:true}});state.image.mockClear();state.log.mockClear();
  state.proofs.clear();
});

describe('Desktop browser invocation boundary',()=>{
  it.each([
    [{overflow:true},'retention_limit_exceeded'],
    [{invalidBytes:true},'invalid_stream_bytes'],
    [{pending:true},'awaiting_buffered_prefix'],
    [{error:'private failure detail'},'capture_error'],
    [{complete:true,terminal:true},'all_response_bytes_retained'],
    [{terminal:true},'terminal_capture_incomplete'],
    [{terminal:false},'response_still_in_flight']
  ])('logs bounded stream decisions without response content (%j)',async(flags,reason)=>{
    const value={url:'https://private.example/secret',requestId:'private-request',body:{base64:'private-bytes'},stream:{complete:false,...flags}};
    state.execute.mockResolvedValue({value});
    const result=await registrar().call('browser_network',{tabId,requestId:'private-request',body:true});
    expect(result.structuredContent.value).toEqual(value);
    expect(state.log).toHaveBeenCalledExactlyOnceWith(`browser_network stream reason=${reason} complete=${value.stream.complete}`);
    expect(JSON.stringify(state.log.mock.calls)).not.toMatch(/private|secret|example|base64/);
  });
  it('logs an aborted stream without exposing its browser error and leaves finite reads to the kernel',async()=>{
    const reg=registrar();
    state.execute.mockResolvedValueOnce({value:{failed:'private network error',stream:{terminal:true,complete:false,error:'private network error'}}});
    await reg.call('browser_network',{tabId,requestId:'r'});
    expect(state.log).toHaveBeenCalledExactlyOnceWith('browser_network stream reason=network_request_failed complete=false');
    state.log.mockClear();state.execute.mockResolvedValueOnce({value:{body:{text:'private finite body'}}});
    await reg.call('browser_network',{tabId,requestId:'r',body:true});
    expect(state.log).not.toHaveBeenCalled();
  });
  it('admits stream capture and byte pages through the actual strict schema',async()=>{
    const reg=registrar();state.caps.control=false;
    await reg.call('browser_network',{tabId,requestId:'main:42',stream:true,body:true,bodyOffset:65536,bodyBytes:262144});
    expect(state.execute.mock.calls[0]![1]).toMatchObject({requestId:'main:42',stream:true,body:true,bodyOffset:65536,bodyBytes:262144});
    state.caps.screen=false;
    expect((await reg.call('browser_network',{tabId,requestId:'main:42',stream:true})).isError).toBe(true);
    expect(state.execute).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid stream page inputs while preserving legacy network calls',()=>{
    const schema=registrar().tools.get('browser_network')!.schema;
    for(const args of [{stream:true},{bodyBytes:1},{requestId:'r',bodyBytes:1},{requestId:'r',body:true,bodyOffset:-1},{requestId:'r',body:true,bodyOffset:0.5},{requestId:'r',body:true,bodyBytes:0},{requestId:'r',body:true,bodyBytes:262145},{requestId:'r',stream:true,clear:true},{requestId:'r',body:true,unknown:true}]) expect(schema.safeParse({tabId,...args}).success).toBe(false);
    for(const args of [{},{clear:true},{requestId:'r',body:true},{requestId:'r',stream:true},{requestId:'r',body:true,bodyOffset:0,bodyBytes:1}]) expect(schema.safeParse({tabId,...args}).success).toBe(true);
  });
  it('admits bounded DOM detail inspection with screen permission alone',async()=>{
    const reg=registrar();state.caps.control=false;
    expect((await reg.call('browser_snapshot',{tabId,mode:'inspect',format:'dom',selector:'main',maxNodes:30,maxChars:4000})).isError).not.toBe(true);
    expect(state.execute.mock.calls[0]![0]).toBe('browser_snapshot');
    expect(state.execute.mock.calls[0]![1]).toMatchObject({format:'dom',selector:'main',maxNodes:30,maxChars:4000});
    const schema=reg.tools.get('browser_snapshot')!.schema;
    expect(schema.safeParse({tabId,format:'script'}).success).toBe(false);
    expect(schema.safeParse({tabId,format:'dom',maxChars:24001}).success).toBe(false);
  });

  it('applies live input policy to new/close even though tabs also has read operations',async()=>{
    const reg=registrar();state.caps.control=false;
    expect((await reg.call('browser_tabs',{action:'list'})).isError).not.toBe(true);
    expect((await reg.call('browser_tabs',{action:'new'})).isError).toBe(true);
    expect((await reg.call('browser_tabs',{action:'close',tabId})).isError).toBe(true);
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(reg.tools.get('browser_tabs')!.annotations.idempotentHint).toBe(false);
  });
  it('keeps unattributed permission explicit and checks it again at dispatch',async()=>{
    const reg=registrar();state.unattributed=false;
    expect((await reg.call('browser_tabs',{action:'list'})).content[0].text).toContain('IDENTITY_REQUIRED');
    expect(state.execute).not.toHaveBeenCalled();state.unattributed=true;
    await reg.call('browser_tabs',{action:'list'});
    const call=state.execute.mock.calls[0]!;expect(call[2]).toBe('unattributed');
    expect(await call[4]()).toBe(true);state.unattributed=false;expect(await call[4]()).toBe(false);
  });
  it('retains exact session ownership and refuses superseded or blocked caller execution',async()=>{
    state.caller={sessionId:'session-a',conversationId:'chat-a'};
    await registrar().call('browser_tabs',{action:'attach',tabId});
    const call=state.execute.mock.calls[0]!;expect(call.slice(2,4)).toEqual(['session:session-a','chat-a']);
    expect(await call[4]()).toBe(true);state.attachment='superseded';expect(await call[4]()).toBe(false);
    state.attachment='current';state.blocked=true;expect(await call[4]()).toBe(false);
  });
  it('gives unresolved requests their own browser principal and upgrades only with exact proof',async()=>{
    const reg=registrar();
    state.caller={requestId:'request-a'};
    await reg.call('browser_tabs',{action:'attach',tabId});
    const original=state.execute.mock.calls[0]!;
    expect(original[2]).toBe('request:request-a');
    expect(await original[4]()).toBe(true);
    state.caller={requestId:'request-b'};
    await reg.call('browser_tabs',{action:'attach',tabId});
    expect(state.execute.mock.calls[1]![2]).toBe('request:request-b');
    state.proofs.set('request-a',{sessionId:'session-a',conversationId:'chat-a'});
    state.caller={requestId:'request-a'};
    await reg.call('browser_tabs',{action:'attach',tabId});
    expect(state.execute.mock.calls[2]!.slice(2,4)).toEqual(['session:session-a','chat-a']);
    state.blocked=true;
    expect(await original[4]()).toBe(false);
  });
  it('validates action targets and required values before admitting a command',()=>{
    const schema=registrar().tools.get('browser_action')!.schema;
    expect(schema.safeParse({tabId,pageId,action:'click',x:20,y:20}).success).toBe(false);
    expect(schema.safeParse({tabId,pageId,action:'fill',ref:'r'}).success).toBe(false);
    expect(schema.safeParse({tabId,pageId,action:'fill',ref:'r',text:''}).success).toBe(true);
    expect(schema.safeParse({tabId,pageId,action:'click',x:20,y:20,screenshotId:'s'}).success).toBe(true);
    const confused=schema.safeParse({tabId,pageId:`${pageId}:frame`,action:'key',key:'ENTER'});
    expect(confused.success).toBe(false);
    if (!confused.success) expect(confused.error.issues[0]?.message).toContain('top-level pageId');
    expect(schema.safeParse({tabId,pageId,action:'key',key:'w',holdMs:300}).success).toBe(true);
    expect(schema.safeParse({tabId,pageId,action:'key',key:'w',holdMs:2001}).success).toBe(false);
    expect(schema.safeParse({tabId,pageId,action:'click',ref:'r',holdMs:300}).success).toBe(false);
  });
  it('returns screenshots once as native image blocks after invoking the pixel validator',async()=>{
    const data=Buffer.from('fixture bytes').toString('base64');
    state.execute.mockResolvedValue({value:{width:2,height:2},image:{mimeType:'image/jpeg',data}});
    const result=await registrar().call('browser_screenshot',{tabId});
    expect(result.content).toEqual([{type:'text',text:'{"width":2,"height":2}'},{type:'image',mimeType:'image/jpeg',data}]);
    expect(JSON.stringify(result.structuredContent)).not.toContain(data);
    expect(state.image).toHaveBeenCalledWith(Buffer.from('fixture bytes'));
  });
});
