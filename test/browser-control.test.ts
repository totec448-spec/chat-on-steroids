import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserControlBroker } from '../src/main/browser-control.js';
import { browserToolWrites } from '../src/shared/browser-control.js';

const browser = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const brokers: BrowserControlBroker[] = [];
function setup() {
  const wake = vi.fn(), broker = new BrowserControlBroker(wake); brokers.push(broker);
  const {epoch} = broker.poll(browser,'Test Chrome',true);
  return {broker,wake,epoch};
}
afterEach(() => { brokers.splice(0).forEach(b => b.reset()); vi.useRealTimers(); });

describe('browser RPC custody', () => {
  it('hands out one exact browser/principal claim, never a duplicate', async () => {
    const {broker,epoch,wake} = setup();
    const work = broker.execute('browser_action',{tabId:`${browser}:12`,action:'click'},'session:A','chat-A',async () => true);
    const [request] = broker.poll(browser,'Test Chrome',true).requests;
    expect(wake).toHaveBeenCalledOnce();
    expect(await broker.claim(other,request!,epoch)).toBeNull();
    const command = await broker.claim(browser,request!,epoch);
    expect(command).toMatchObject({owner:'session:A',conversationId:'chat-A',args:{tabId:12}});
    expect(await broker.claim(browser,request!,epoch)).toBeNull();
    expect(broker.poll(browser,'Test Chrome',true).requests).toEqual([]);
    expect(broker.result(other,request!,epoch,{value:'foreign'})).toBe(false);
    expect(broker.result(browser,request!,epoch,{value:{accepted:true}})).toBe(true);
    expect(await work).toEqual({value:{accepted:true}});
    expect(broker.result(browser,request!,epoch,{value:'duplicate'})).toBe(false);
  });

  it('does not publish a claim after revocation or an A/B lifecycle replacement', async () => {
    const {broker,epoch} = setup(); let allow!: (value:boolean) => void;
    const work = broker.execute('browser_tabs',{action:'new'},'A',null,() => new Promise(resolve => {allow = resolve;}));
    const [request] = broker.poll(browser,'Chrome',true).requests;
    const claim = broker.claim(browser,request!,epoch);
    broker.reset(); broker.poll(browser,'Chrome',true); allow(true);
    expect(await claim).toBeNull();
    expect(await work).toMatchObject({error:expect.stringContaining('NOT_DISPATCHED')});
  });
  it('aliases only request owners with exact proof for the current durable session', async () => {
    const {broker,epoch}=setup();
    const work=broker.execute('browser_tabs',{action:'list'},'session:A','chat-A',async()=>true);
    const [request]=broker.poll(browser,'Chrome',true).requests;
    const command=await broker.claim(browser,request!,epoch,[
      {owner:'request:old-turn',sessionId:'A'}, {owner:'request:foreign',sessionId:'B'},
      {owner:'unattributed',sessionId:'A'}, {owner:'session:B',sessionId:'A'}
    ]);
    expect(command?.ownerAliases).toEqual(['request:old-turn']);
    expect(command?.owner).toBe('session:A');
    broker.result(browser,request!,epoch,{value:true});await work;
  });

  it('rechecks current permission after handout before page input', async () => {
    const {broker,epoch} = setup(); let allowed = true;
    const work = broker.execute('browser_evaluate',{tabId:`${browser}:3`},'A',null,async () => allowed);
    const [request] = broker.poll(browser,'Chrome',true).requests;
    await broker.claim(browser,request!,epoch);
    expect(await broker.check(browser,request!,epoch)).toBe(true);
    allowed = false;
    expect(await broker.check(browser,request!,epoch)).toBe(false);
    broker.result(browser,request!,epoch,{error:'revoked'}); await work;
  });

  it('distinguishes timeout before dispatch from an unconfirmed action without replay', async () => {
    vi.useFakeTimers(); const {broker,epoch} = setup();
    const first = broker.execute('browser_tabs',{action:'new'},'A',null,async () => true);
    await vi.advanceTimersByTimeAsync(25000);
    expect(await first).toMatchObject({error:expect.stringContaining('NOT_DISPATCHED')});
    const second = broker.execute('browser_tabs',{action:'new'},'A',null,async () => true);
    const [request] = broker.poll(browser,'Chrome',true).requests;
    await broker.claim(browser,request!,epoch);
    await vi.advanceTimersByTimeAsync(25000);
    expect(await second).toMatchObject({error:expect.stringContaining('UNCONFIRMED')});
    expect(broker.poll(browser,'Chrome',true).requests).toEqual([]);
  });

  it('lists competing browsers instead of guessing one and rejects old tab handles', async () => {
    const {broker} = setup(); broker.poll(other,'Edge',true);
    const list = await broker.execute('browser_tabs',{action:'list'},'A',null,async () => true);
    expect(list.value).toMatchObject({browsers:expect.arrayContaining([{id:browser,name:'Test Chrome',enabled:true,host:'unknown'},{id:other,name:'Edge',enabled:true,host:'unknown'}])});
    expect(await broker.execute('browser_action',{tabId:'123'},'A',null,async () => true)).toMatchObject({error:expect.stringContaining('TAB_INVALID')});
  });

  // #482: an external organizer needs to know which listed browser is the built-in one. Read-only discovery:
  // the value is what the browser's own extension build reports, so it says which kind of browser, never who controls it.
  it('says whether each listed browser is the built-in one or an ordinary browser (#482)', async () => {
    const {broker} = setup(); broker.poll(browser,'Built-in',true,'cos'); broker.poll(other,'Edge',true,'browser');
    const list = await broker.execute('browser_tabs',{action:'list'},'A',null,async () => true);
    expect(list.value).toMatchObject({browsers:expect.arrayContaining([{id:browser,name:'Built-in',enabled:true,host:'cos'},{id:other,name:'Edge',enabled:true,host:'browser'}])});
  });
  it('calls a browser that reports no host, or an unknown one, unknown instead of guessing', async () => {
    const {broker} = setup(); broker.poll(browser,'Old build',true); broker.poll(other,'Odd',true,'something-else' as never);
    expect(broker.browsers().map(b => b.host)).toEqual(['unknown','unknown']);
  });
  it('names the browser that answered a tab list, also when only one is connected (#482)', async () => {
    const {broker,epoch} = setup(); broker.poll(browser,'Built-in',true,'cos');
    const work = broker.execute('browser_tabs',{action:'list'},'A',null,async () => true);
    const [request] = broker.poll(browser,'Built-in',true,'cos').requests;
    await broker.claim(browser,request!,epoch);
    broker.result(browser,request!,epoch,{value:{browserId:browser,tabs:[],total:0}});
    expect(await work).toEqual({value:{browserId:browser,tabs:[],total:0,browser:{id:browser,name:'Built-in',host:'cos'}}});
  });
  it('does not add the browser to results that are not a tab list, and keeps the extension\'s own fields', async () => {
    const {broker,epoch} = setup(); broker.poll(browser,'Built-in',true,'browser');
    const work = broker.execute('browser_tabs',{action:'attach',tabId:`${browser}:3`},'A',null,async () => true);
    const [request] = broker.poll(browser,'Built-in',true,'browser').requests;
    await broker.claim(browser,request!,epoch);
    broker.result(browser,request!,epoch,{value:{attached:true}});
    expect(await work).toEqual({value:{attached:true}});
  });
  it('treats JavaScript, new tabs and close as writes and bounds result bytes', async () => {
    expect(browserToolWrites('browser_tabs',{action:'list'})).toBe(false);
    expect(browserToolWrites('browser_tabs',{action:'new'})).toBe(true);
    expect(browserToolWrites('browser_tabs',{action:'close'})).toBe(true);
    expect(browserToolWrites('browser_evaluate',{})).toBe(true);
    const {broker,epoch} = setup();
    const work = broker.execute('browser_snapshot',{tabId:`${browser}:1`},'A',null,async () => true);
    const [request] = broker.poll(browser,'Chrome',true).requests;
    await broker.claim(browser,request!,epoch);
    broker.result(browser,request!,epoch,{value:'x'.repeat(1_800_001)});
    expect(await work).toMatchObject({error:expect.stringContaining('TOO_LARGE')});
  });
});
