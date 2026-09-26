import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DICTATION } from '../src/shared/dictation.js';

const h = vi.hoisted(() => ({ handlers:new Map<string,Function>(), check:null as Function|null, request:null as Function|null,
  has:vi.fn(async()=>true), get:vi.fn(async()=> 'only-dictation-key'), set:vi.fn(async()=>{}), consent:vi.fn(async()=>({response:0})),
  transcribe:vi.fn(async(_args:any)=>'Recognized speech'), app:new Map<string,Function>() }));
vi.mock('electron',()=>({
  app:{on:(name:string,fn:Function)=>h.app.set(name,fn)}, dialog:{showMessageBox:h.consent}, systemPreferences:{askForMediaAccess:async()=>true},
  ipcMain:{handle:(name:string,fn:Function)=>h.handlers.set(name,fn)},
  session:{defaultSession:{setPermissionCheckHandler:(fn:Function)=>{h.check=fn;},setPermissionRequestHandler:(fn:Function)=>{h.request=fn;}}}
}));
vi.mock('../src/main/secrets.js',()=>({hasSecret:h.has,getSecret:h.get,setSecret:h.set}));
vi.mock('../src/main/dictation.js',()=>({transcribeDictation:h.transcribe}));
const {registerDictationIpc}=await import('../src/main/dictation-ipc.js');
const id='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
let owner:any, window:any, event:any;
const invoke=(payload:unknown,source=event)=>h.handlers.get('dictation:request')!(source,payload);
const audio=()=>({action:'transcribe',id,bytes:new Uint8Array([0x1a,0x45,0xdf,0xa3]),mime:'audio/webm',language:''});
beforeEach(()=>{
  vi.useFakeTimers(); h.handlers.clear();h.app.clear();vi.clearAllMocks();
  h.has.mockResolvedValue(true);h.get.mockResolvedValue('only-dictation-key');h.consent.mockResolvedValue({response:0});h.transcribe.mockResolvedValue('Recognized speech');
  owner=Object.assign(new EventEmitter(),{mainFrame:{url:'file:///app/out/renderer/index.html'},isDestroyed:()=>false,send:vi.fn()});
  window=Object.assign(new EventEmitter(),{webContents:owner,isDestroyed:()=>false,isVisible:()=>true,isFocused:()=>true});
  event={sender:owner,senderFrame:owner.mainFrame};registerDictationIpc(()=>window);
});
afterEach(()=>{h.app.get('before-quit')?.();vi.useRealTimers();});
describe('dictation permission and delivery owner',()=>{
  it('denies microphone until an explicit begin and never grants camera/subframe/foreign-page permission',async()=>{
    const detail={isMainFrame:true,requestingUrl:owner.mainFrame.url,mediaType:'audio'};
    expect(h.check!(owner,'media','file://',detail)).toBe(false);
    expect(await invoke({action:'begin',id})).toEqual({ok:true,data:undefined});
    expect(h.has).toHaveBeenCalledWith('dictationApiKey');
    expect(h.check!(owner,'media','file://',detail)).toBe(true);
    for(const details of [{...detail,isMainFrame:false},{...detail,mediaType:'video'},{...detail,mediaType:'unknown'},{...detail,requestingUrl:'file:///other.html'}])expect(h.check!(owner,'media','file://',details)).toBe(false);
    expect(h.check!({},'media','file://',detail)).toBe(false);
    expect(h.check!(owner,'display-capture','file://',detail)).toBe(false);
    for(const mediaTypes of [['audio'],['video'],['audio','video'],[]]){
      const reply=vi.fn();h.request!(owner,'media',reply,{...detail,mediaTypes});expect(reply).toHaveBeenCalledWith(mediaTypes.length===1&&mediaTypes[0]==='audio');
    }
    await invoke({action:'cancel',id});expect(h.check!(owner,'media','file://',detail)).toBe(false);
  });
  it('rejects unowned IPC and audio before explicit permission',async()=>{
    expect((await invoke({action:'begin',id},{sender:owner,senderFrame:{}})).ok).toBe(false);
    expect((await invoke(audio())).ok).toBe(false);expect(h.transcribe).not.toHaveBeenCalled();
  });
  it('does not activate a late permission response after cancellation or consume a newer owner',async()=>{
    let allow!:(value:{response:number})=>void;
    h.consent.mockImplementationOnce(()=>new Promise(resolve=>{allow=resolve;}));
    const begun=invoke({action:'begin',id});await Promise.resolve();await Promise.resolve();
    await invoke({action:'cancel',id});expect((await invoke({action:'begin',id:other})).ok).toBe(true);
    allow({response:0});expect((await begun).ok).toBe(false);
    expect((await invoke({...audio(),id:other})).ok).toBe(true);
  });
  it('owns one upload, stops capture permission before network IO, and uses a separate key',async()=>{
    await invoke({action:'begin',id});let finish!:(text:string)=>void;
    h.transcribe.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=invoke(audio());await Promise.resolve();await Promise.resolve();
    expect((await invoke(audio())).ok).toBe(false);
    expect(h.check!(owner,'media','file://',{isMainFrame:true,requestingUrl:owner.mainFrame.url,mediaType:'audio'})).toBe(false);
    expect(h.get).toHaveBeenCalledExactlyOnceWith('dictationApiKey');
    finish('Dictated text');expect(await pending).toEqual({ok:true,data:'Dictated text'});
    expect(h.transcribe).toHaveBeenCalledTimes(1);
  });
  it.each(['cancel','hide','destroyed','did-start-loading','before-quit'])('aborts work on %s and rejects a late transcript',async action=>{
    await invoke({action:'begin',id});let done!:(s:string)=>void;let signal:AbortSignal|undefined;
    h.transcribe.mockImplementationOnce(args=>{signal=args.signal;return new Promise(resolve=>{done=resolve;});});
    const pending=invoke(audio());await Promise.resolve();await Promise.resolve();
    if(action==='cancel')await invoke({action,id});else if(action==='before-quit')h.app.get(action)!();else(action==='hide'?window:owner).emit(action);
    expect(signal?.aborted).toBe(true);done('Late result');expect((await pending).ok).toBe(false);
  });
  it('expires a recording instead of leaving media permission armed',async()=>{
    await invoke({action:'begin',id});await vi.advanceTimersByTimeAsync(DICTATION.maxRecordingMs);
    expect(owner.send).toHaveBeenCalledWith('dictation:event',expect.objectContaining({id,error:expect.stringContaining('limit')}));
    expect((await invoke(audio())).ok).toBe(false);
  });
  it('does not accept oversized or wrongly typed audio',async()=>{
    await invoke({action:'begin',id});
    for(const fields of [{bytes:new Uint8Array(DICTATION.maxAudioBytes+1)},{mime:'video/webm'},{language:'../../en'},{extra:'value'}])expect((await invoke({...audio(),...fields})).ok).toBe(false);
    expect(h.transcribe).not.toHaveBeenCalled();
  });
  it('does not start recording when the key or permission is absent',async()=>{
    h.has.mockResolvedValueOnce(false);expect((await invoke({action:'begin',id})).ok).toBe(false);
    h.consent.mockResolvedValueOnce({response:1});expect((await invoke({action:'begin',id})).ok).toBe(false);
    expect((await invoke(audio())).ok).toBe(false);
  });
});
