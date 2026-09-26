import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DictationApi, DictationEvent } from '../src/shared/dictation.js';
import { DICTATION } from '../src/shared/dictation.js';

let page: JSDOM, ui: ReturnType<typeof import('../src/renderer/dictation.js')['initDictation']> | undefined;
let scope: string, input: HTMLTextAreaElement, button: HTMLButtonElement, api: DictationApi;
let media: ReturnType<typeof vi.fn>, track: { stop:ReturnType<typeof vi.fn>; enabled:boolean; onended:Function|null };
let receive: (event:DictationEvent)=>void, recorders: FakeRecorder[];
class FakeRecorder {
  static isTypeSupported(){return true;}
  state='inactive'; ondataavailable:Function|null=null; onstop:Function|null=null; onerror:Function|null=null;
  constructor(..._args:unknown[]){recorders.push(this);}
  start(){this.state='recording';}
  pause(){this.state='paused';}
  resume(){this.state='recording';}
  stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob([new Uint8Array([0x1a,0x45,0xdf,0xa3,1])])});this.onstop?.();});}
}
const element=<T extends HTMLElement>(id:string)=>page.window.document.getElementById(id) as T;
const click=(id:string)=>element<HTMLButtonElement>(id).click();
const phase=()=>element('dictationDialog').dataset.phase;
async function open(){button.click();await vi.waitFor(()=>expect(phase()).toBe('ready'));}
async function record(){await open();click('dictationRecord');await vi.waitFor(()=>expect(phase()).toBe('recording'));}
beforeEach(async()=>{
  page=new JSDOM('<form><textarea id="input"></textarea><button type="button" id="voice">Voice</button></form>',{url:'https://fixture.invalid',pretendToBeVisual:true});
  vi.stubGlobal('window',page.window);vi.stubGlobal('document',page.window.document);vi.stubGlobal('Event',page.window.Event);
  vi.stubGlobal('DOMException',page.window.DOMException);vi.stubGlobal('requestAnimationFrame',vi.fn(()=>1));vi.stubGlobal('cancelAnimationFrame',vi.fn());
  Object.defineProperties(page.window.HTMLDialogElement.prototype,{
    showModal:{value:function(this:HTMLDialogElement){this.open=true;}},
    close:{value:function(this:HTMLDialogElement){this.open=false;queueMicrotask(()=>this.dispatchEvent(new page.window.Event('close')));}}
  });
  scope='draft-one:1';recorders=[];track={stop:vi.fn(),enabled:true,onended:null};
  media=vi.fn(async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]}));
  vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:media}});vi.stubGlobal('MediaRecorder',FakeRecorder);
  input=element('input');button=element('voice');input.value='My draft';input.setSelectionRange(8,8);
  api={dictationStatus:vi.fn(async()=>({ok:true as const,data:{configured:true,model:DICTATION.model,maxRecordingMs:DICTATION.maxRecordingMs}})),
    dictationSetKey:vi.fn(async()=>({ok:true as const,data:{configured:true,model:DICTATION.model,maxRecordingMs:DICTATION.maxRecordingMs}})),
    dictationBegin:vi.fn(async()=>({ok:true as const,data:undefined})),dictationCancel:vi.fn(async()=>({ok:true as const,data:undefined})),
    dictationTranscribe:vi.fn(async()=>({ok:true as const,data:'Recognized words.'})),onDictationEvent:fn=>{receive=fn;return()=>{};}};
  const {initDictation}=await import('../src/renderer/dictation.js');
  ui=initDictation({input,button,owner:()=>scope,api,copy:vi.fn(async()=>{})});
});
afterEach(()=>{ui?.dispose();page.window.close();vi.unstubAllGlobals();vi.restoreAllMocks();vi.resetModules();});

it('opens settings without recording or uploading and requires a separate key',async()=>{
  vi.mocked(api.dictationStatus).mockResolvedValueOnce({ok:true,data:{configured:false,model:DICTATION.model,maxRecordingMs:DICTATION.maxRecordingMs}});
  await open();expect(element('dictationRecord').hidden).toBe(true);expect(media).not.toHaveBeenCalled();expect(api.dictationBegin).not.toHaveBeenCalled();
  expect(element('dictationDialog').textContent).toContain('Separate API billing');
  element<HTMLInputElement>('dictationKey').value='synthetic-separate-key';click('dictationSaveKey');
  await vi.waitFor(()=>expect(api.dictationSetKey).toHaveBeenCalledWith('synthetic-separate-key'));
  await vi.waitFor(()=>expect(element<HTMLInputElement>('dictationKey').value).toBe(''));
  expect(media).not.toHaveBeenCalled();
});
it('records audio only, stops tracks on Finish and does not submit the composer',async()=>{
  const submitted=vi.fn();page.window.document.querySelector('form')!.addEventListener('submit',submitted);
  await record();expect(media).toHaveBeenCalledWith(expect.objectContaining({video:false}));
  expect(input.value).toBe('My draft');click('dictationFinish');await vi.waitFor(()=>expect(phase()).toBe('review'));
  expect(track.stop).toHaveBeenCalledTimes(1);expect(api.dictationTranscribe).toHaveBeenCalledTimes(1);expect(input.value).toBe('My draft');
  click('dictationInsert');await Promise.resolve();
  expect(input.value).toBe('My draft Recognized words.');expect(submitted).not.toHaveBeenCalled();
  expect(page.window.document.activeElement).toBe(input);
});
it('updates a streaming preview without changing the authored draft',async()=>{
  let finish!:(value:any)=>void;vi.mocked(api.dictationTranscribe).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  await record();click('dictationFinish');await vi.waitFor(()=>expect(api.dictationTranscribe).toHaveBeenCalledTimes(1));
  const id=vi.mocked(api.dictationTranscribe).mock.calls[0]![0].id;
  receive({id,text:'Words arriving'});expect(element<HTMLTextAreaElement>('dictationPreview').value).toBe('Words arriving');expect(input.value).toBe('My draft');
  receive({id:'foreign',text:'Wrong transcript'});expect(element<HTMLTextAreaElement>('dictationPreview').value).toBe('Words arriving');
  finish({ok:true,data:'Complete transcript.'});await vi.waitFor(()=>expect(phase()).toBe('review'));
  element<HTMLTextAreaElement>('dictationPreview').value='Edited transcript.';click('dictationInsert');expect(input.value).toContain('Edited transcript.');
});
it('updates language labels without replacing the language control or authored transcript',async()=>{
  await record();click('dictationFinish');await vi.waitFor(()=>expect(phase()).toBe('review'));
  const language=element<HTMLSelectElement>('dictationLanguage');
  const {setLanguage}=await import('../src/renderer/i18n.js');
  const {default:fr}=await import('../src/renderer/locales/fr.json');
  setLanguage('fr');
  expect(page.window.document.querySelector('.dictation-language')?.firstChild?.textContent).toBe(fr['Speech language']);
  expect(element('dictationLanguage')).toBe(language);
  expect(element<HTMLTextAreaElement>('dictationPreview').value).toBe('Recognized words.');
  expect(input.value).toBe('My draft');
  expect(api.dictationTranscribe).toHaveBeenCalledTimes(1);
});

it('cancels capture without uploading or erasing the draft',async()=>{
  await record();click('dictationClose');await Promise.resolve();expect(track.stop).toHaveBeenCalledTimes(1);
  expect(api.dictationTranscribe).not.toHaveBeenCalled();expect(api.dictationCancel).toHaveBeenCalledTimes(1);expect(input.value).toBe('My draft');
});
it('stops a microphone that resolves after the modal was cancelled',async()=>{
  let ready!:(value:any)=>void;media.mockImplementationOnce(()=>new Promise(resolve=>{ready=resolve;}));
  await open();click('dictationRecord');await vi.waitFor(()=>expect(media).toHaveBeenCalledTimes(1));click('dictationClose');
  ready({getTracks:()=>[track],getAudioTracks:()=>[track]});await vi.waitFor(()=>expect(track.stop).toHaveBeenCalledTimes(1));expect(recorders).toHaveLength(0);
});
it('does not overwrite a newer draft or an A-B-A owner',async()=>{
  await record();click('dictationFinish');await vi.waitFor(()=>expect(phase()).toBe('review'));
  input.value='New user text';click('dictationInsert');expect(input.value).toBe('New user text');expect(element('dictationStatus').textContent).toContain('original draft changed');
  input.value='My draft';scope='draft-one:3';click('dictationInsert');expect(input.value).toBe('My draft');
});
it('pauses actual recording and microphone tracks rather than faking a paused indicator',async()=>{
  await record();click('dictationPause');expect(recorders[0]!.state).toBe('paused');expect(track.enabled).toBe(false);
  click('dictationPause');expect(recorders[0]!.state).toBe('recording');expect(track.enabled).toBe(true);
});
it('discards late transcriptions after the draft owner is replaced',async()=>{
  let finish!:(value:any)=>void;vi.mocked(api.dictationTranscribe).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  await record();click('dictationFinish');await vi.waitFor(()=>expect(api.dictationTranscribe).toHaveBeenCalledTimes(1));
  scope='other:2';ui!.cancel();finish({ok:true,data:'Do not insert'});await Promise.resolve();await Promise.resolve();
  expect(input.value).toBe('My draft');expect(phase()).toBe('error');expect(element('dictationInsert').hidden).toBe(true);
});
it('reports denied microphone access and never uploads',async()=>{
  media.mockRejectedValueOnce(new page.window.DOMException('denied','NotAllowedError'));await open();click('dictationRecord');
  await vi.waitFor(()=>expect(phase()).toBe('error'));expect(element('dictationStatus').textContent).toContain('denied');expect(api.dictationTranscribe).not.toHaveBeenCalled();
});
it('rejects oversized capture before preparing an upload',async()=>{
  await record();recorders[0]!.ondataavailable!({data:{size:DICTATION.maxAudioBytes+1}});
  expect(phase()).toBe('error');expect(track.stop).toHaveBeenCalled();expect(api.dictationTranscribe).not.toHaveBeenCalled();
});
it('replaces only the explicitly selected draft range',async()=>{
  const {insertDictation}=await import('../src/renderer/dictation.js');input.value='Hello OLD world';
  expect(insertDictation(input,scope,{owner:scope,text:input.value,start:6,end:9},'new')).toBe(true);
  expect(input.value).toBe('Hello new world');
});

it.each([
  ['Hello OLD, please', 6, 9, 'new words', 'Hello new words, please'],
  ['(OLD)', 1, 4, 'new words', '(new words)'],
  ['Topic:OLD', 6, 9, 'new words', 'Topic: new words']
])('preserves surrounding punctuation when inserting into %s', async (value,start,end,transcript,expected) => {
  const {insertDictation}=await import('../src/renderer/dictation.js');input.value=value;
  expect(insertDictation(input,scope,{owner:scope,text:value,start,end},transcript)).toBe(true);
  expect(input.value).toBe(expected);
});

it('a retired Blob read cannot erase the next recording header or early speech',async()=>{
  const nativeRead=Blob.prototype.arrayBuffer;let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const held=vi.spyOn(Blob.prototype,'arrayBuffer').mockImplementationOnce(function(this:Blob){
    const own=nativeRead.call(this);return gate.then(()=>own);
  });
  await record();click('dictationFinish');await vi.waitFor(()=>expect(held).toHaveBeenCalledTimes(1));
  click('dictationClose');await record();
  const firstBytes=new Uint8Array([0x1a,0x45,0xdf,0xa3,9,9,9]);
  recorders[1]!.ondataavailable!({data:new Blob([firstBytes])});
  release();await Promise.resolve();await Promise.resolve();await Promise.resolve();
  expect(api.dictationTranscribe).not.toHaveBeenCalled();
  click('dictationFinish');await vi.waitFor(()=>expect(api.dictationTranscribe).toHaveBeenCalledTimes(1));
  const uploaded=vi.mocked(api.dictationTranscribe).mock.calls[0]![0].bytes;
  expect([...uploaded.slice(0,firstBytes.length)]).toEqual([...firstBytes]);
});
