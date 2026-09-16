import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '../src/shared/types.js';
import type { SurfaceRegistrar } from '../src/main/mcp/kernel.js';
import { z } from 'zod';

const state = vi.hoisted(() => ({
  caps: {screen:true,control:true}, unattributed:true,
  caller: null as null | {sessionId:string;conversationId:string},
  attachment:'current', blocked:false, execute:vi.fn(), image:vi.fn(async()=> 'image/jpeg')
}));
vi.mock('../src/main/config.js',()=>({getConfig:()=>({multiAgent:{allowUnattributedCalls:state.unattributed}}),effectiveCapabilities:()=>state.caps}));
vi.mock('../src/main/mcp/call-context.js',()=>({currentCall:()=>({caller:state.caller})}));
vi.mock('../src/main/mcp/kernel.js',()=>({fail:(text:string)=>({isError:true,content:[{type:'text',text}]}),failIdentity:(text:string)=>({isError:true,content:[{type:'text',text}]})}));
vi.mock('../src/main/browser-control.js',()=>({browserControl:{execute:state.execute}}));
vi.mock('../src/main/session/store.js',()=>({conversationAttachment:async()=>state.attachment}));
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
beforeEach(()=>{
  state.caps={screen:true,control:true};state.unattributed=true;state.caller=null;state.attachment='current';state.blocked=false;
  state.execute.mockReset().mockResolvedValue({value:{ok:true}});state.image.mockClear();
});

describe('Desktop browser invocation boundary',()=>{
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
  it('validates action targets and required values before admitting a command',()=>{
    const schema=registrar().tools.get('browser_action')!.schema;
    expect(schema.safeParse({tabId,pageId:'p',action:'click',x:20,y:20}).success).toBe(false);
    expect(schema.safeParse({tabId,pageId:'p',action:'fill',ref:'r'}).success).toBe(false);
    expect(schema.safeParse({tabId,pageId:'p',action:'fill',ref:'r',text:''}).success).toBe(true);
    expect(schema.safeParse({tabId,pageId:'p',action:'click',x:20,y:20,screenshotId:'s'}).success).toBe(true);
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
