import { describe, expect, it, vi } from 'vitest';
import { DICTATION } from '../src/shared/dictation.js';
import { transcribeDictation } from '../src/main/dictation.js';

const bytes = new Uint8Array([0x1a,0x45,0xdf,0xa3,1,2,3,4]);
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const args = () => ({ bytes, language:'', key:'fixture-only-not-a-real-api-key', signal:new AbortController().signal, progress:vi.fn() });
const response = (body: string, contentType = 'text/event-stream') => new Response(body, { headers:{'content-type':contentType} });

describe('explicit bounded dictation transport', () => {
  it('uses a fixed multipart endpoint and the dedicated key without chat context', async () => {
    const fetcher = vi.fn(async () => response(sse({type:'transcript.text.delta',delta:'Hello'}) + sse({type:'transcript.text.done',text:'Hello world.'})));
    const input = args(); expect(await transcribeDictation({...input, language:'fr',fetch:fetcher as typeof fetch})).toBe('Hello world.');
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(options).toMatchObject({ method:'POST',redirect:'error',headers:{Authorization:`Bearer ${input.key}`} });
    const form = options.body as FormData;
    expect([...form.keys()]).toEqual(['file','model','stream','response_format','language']);
    expect(form.get('model')).toBe(DICTATION.model); expect(form.get('language')).toBe('fr');
    expect((form.get('file') as File).name).toBe('dictation.webm');
    expect(input.progress).toHaveBeenLastCalledWith('Hello world.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reads UTF-8 and CRLF events across arbitrary byte boundaries', async () => {
    const source = new TextEncoder().encode(sse({type:'transcript.text.delta',delta:'你好'}).replaceAll('\n','\r\n') + sse({type:'transcript.text.done',text:'你好, café.'}));
    const body = new ReadableStream<Uint8Array>({start(controller){for(const byte of source)controller.enqueue(new Uint8Array([byte]));controller.close();}});
    expect(await transcribeDictation({...args(),fetch:vi.fn(async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})) as typeof fetch})).toBe('你好, café.');
  });
  it('accepts a complete JSON response without fabricating partial results', async () => {
    expect(await transcribeDictation({...args(),fetch:vi.fn(async()=>response('{"text":"A complete result."}','application/json')) as typeof fetch})).toBe('A complete result.');
  });
  it.each([
    ['missing completion',sse({type:'transcript.text.delta',delta:'Partial only'}),'without a complete'],
    ['service error',sse({type:'error',message:'PRIVATE_PROVIDER_ERROR'}),'could not finish'],
    ['empty speech',sse({type:'transcript.text.done',text:''}),'No speech'],
    ['invalid JSON','data: {broken}\n\n','incomplete'],
    ['oversized text',sse({type:'transcript.text.done',text:'x'.repeat(DICTATION.maxTextChars+1)}),'text limit'],
    ['late delta',sse({type:'transcript.text.done',text:'Final'})+sse({type:'transcript.text.delta',delta:'Late'}),'after completion'],
    ['contradictory final',sse({type:'transcript.text.done',text:'One'})+sse({type:'transcript.text.done',text:'Two'}),'contradictory']
  ])('rejects %s without accepting the transcript',async(_label,body,error)=>{
    await expect(transcribeDictation({...args(),fetch:vi.fn(async()=>response(body)) as typeof fetch})).rejects.toThrow(error);
  });
  it('rejects oversized response bytes even when individual events are small',async()=>{
    await expect(transcribeDictation({...args(),fetch:vi.fn(async()=>response(':'.repeat(DICTATION.maxResponseBytes+1))) as typeof fetch})).rejects.toThrow('size limit');
  });
  it.each([401,403,429,500])('redacts provider error bodies and does not retry HTTP %s',async status=>{
    const fetcher=vi.fn(async()=>new Response('PRIVATE_TRANSCRIPT_AND_KEY',{status}));
    await expect(transcribeDictation({...args(),fetch:fetcher as typeof fetch})).rejects.not.toThrow('PRIVATE_');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not expose network exceptions or attempt a replacement request',async()=>{
    const fetcher=vi.fn(async()=>{throw Error('Authorization: PRIVATE_KEY');});
    await expect(transcribeDictation({...args(),fetch:fetcher as typeof fetch})).rejects.toThrow('No automatic retry');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([new Uint8Array(),new Uint8Array([1,2,3,4]),new Uint8Array(DICTATION.maxAudioBytes+1)])('rejects invalid audio before the network',async audio=>{
    const fetcher=vi.fn(); await expect(transcribeDictation({...args(),bytes:audio,fetch:fetcher})).rejects.toThrow('WebM');expect(fetcher).not.toHaveBeenCalled();
  });
  it('cancellation makes a later result unusable',async()=>{
    const controller=new AbortController(); const fetcher=vi.fn(async()=>{controller.abort();return response(sse({type:'transcript.text.done',text:'Too late'}));});
    await expect(transcribeDictation({...args(),signal:controller.signal,fetch:fetcher as typeof fetch})).rejects.toThrow('cancelled');
  });
});
