import {JSDOM} from 'jsdom';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
let dom:JSDOM,dispose:(()=>void)|undefined;
beforeEach(()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
  dom=new JSDOM('<body><div class="composer-toolbar"><div class="composer-options"></div></div></body>',{url:'https://pet.test',pretendToBeVisual:true});
  const w=dom.window;
  const media={matches:false,addEventListener:vi.fn()};
  const capture=new Set<number>();
  w.HTMLElement.prototype.setPointerCapture=id=>{capture.add(id);};
  w.HTMLElement.prototype.hasPointerCapture=id=>capture.has(id);
  w.HTMLElement.prototype.releasePointerCapture=id=>{capture.delete(id);};
  for(const [key,value] of Object.entries({window:w,document:w.document,localStorage:w.localStorage,innerWidth:1000,innerHeight:800,
    AbortController:w.AbortController,matchMedia:()=>media,
    requestAnimationFrame:vi.fn((callback:FrameRequestCallback)=>w.setTimeout(()=>callback(performance.now()),5)),
    cancelAnimationFrame:vi.fn((id:number)=>w.clearTimeout(id)),
    Image:class{onload:(()=>void)|null=null;onerror:null=null;set src(_value:string){queueMicrotask(()=>this.onload?.());}}}))vi.stubGlobal(key,value);
});
afterEach(()=>{dispose?.();dispose=undefined;dom.window.close();vi.unstubAllGlobals();vi.useRealTimers();vi.resetModules();});
async function boot(){const {initPet}=await import('../src/renderer/pet.js');dispose=initPet();await Promise.resolve();}
const click=(selector:string)=>(dom.window.document.querySelector(selector) as HTMLButtonElement).click();
it('mounts one launcher and synchronously removes special props on hide',async()=>{
  await boot();click('#petLauncher');click('.pet-menu button:nth-child(3)');
  expect(dom.window.document.querySelector('.pet-target')?.textContent).toBe('OpenAI');
  click('.pet-menu button:first-child');expect(dom.window.document.querySelector('.pet-props')?.childElementCount).toBe(0);
  expect((dom.window.document.getElementById('petLayer') as HTMLElement).hidden).toBe(true);
  expect(JSON.parse(dom.window.localStorage.getItem('cos.ui.turTurPet.v1')!).visible).toBe(false);
  click('#petLauncher');expect(dom.window.document.querySelector('.pet-props')?.childElementCount).toBe(0);
});
it('wires pointer capture, drag cancellation, landing, and disposal',async()=>{
  await boot();click('#petLauncher');click('.pet-menu button:nth-child(4)');
  const actor=dom.window.document.getElementById('petActor')!;
  function pointer(type:string,x:number,y:number){const e=new dom.window.MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});Object.defineProperty(e,'pointerId',{value:1});actor.dispatchEvent(e);}
  pointer('pointerdown',20,20);pointer('pointermove',80,30);
  expect(actor.dataset.state).toBe('held');expect(dom.window.document.querySelector('.pet-props')?.childElementCount).toBe(0);
  pointer('pointerup',80,30);expect(actor.dataset.state).toBe('landing');
  dispose!();dispose=undefined;expect(dom.window.document.getElementById('petLayer')).toBeNull();expect(dom.window.document.getElementById('petLauncher')).toBeNull();
  expect(cancelAnimationFrame).toHaveBeenCalled();
});

it('sleeps between authored idle frames without changing their timing or rewriting the DOM',async()=>{
  await boot();click('#petLauncher');await vi.advanceTimersByTimeAsync(500);
  const actor=dom.window.document.getElementById('petActor')!;
  expect(actor.dataset.state).toBe('idle');expect(actor.dataset.frame).toBe('4');
  const mutations:MutationRecord[]=[];
  const observer=new dom.window.MutationObserver(records=>mutations.push(...records));
  observer.observe(dom.window.document.body,{attributes:true,childList:true,subtree:true});
  vi.mocked(requestAnimationFrame).mockClear();
  await vi.advanceTimersByTimeAsync(400);
  expect(requestAnimationFrame).not.toHaveBeenCalled();expect(mutations).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(200);
  expect(actor.dataset.frame).toBe('5');
  await vi.advanceTimersByTimeAsync(200);expect(actor.dataset.frame).toBe('6');
  observer.disconnect();
});

it('parks the animation while its menu is open and resumes from the same pose',async()=>{
  await boot();click('#petLauncher');await vi.advanceTimersByTimeAsync(650);
  const actor=dom.window.document.getElementById('petActor')!;
  actor.dispatchEvent(new dom.window.MouseEvent('contextmenu',{clientX:100,clientY:100,bubbles:true}));
  const frame=actor.dataset.frame;vi.mocked(requestAnimationFrame).mockClear();
  await vi.advanceTimersByTimeAsync(10000);
  expect(requestAnimationFrame).not.toHaveBeenCalled();expect(actor.dataset.frame).toBe(frame);
  dom.window.document.querySelector('.pet-menu')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await vi.advanceTimersByTimeAsync(500);
  expect(actor.dataset.state).toBe('idle');expect(actor.dataset.frame).toBe('5');
});

it('cancels a sleeping frame on hide, visibility loss and disposal',async()=>{
  await boot();click('#petLauncher');await vi.advanceTimersByTimeAsync(650);
  Object.defineProperty(dom.window.document,'hidden',{configurable:true,value:true});
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  vi.mocked(requestAnimationFrame).mockClear();await vi.advanceTimersByTimeAsync(10000);
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  Object.defineProperty(dom.window.document,'hidden',{configurable:true,value:false});
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(500);
  expect(dom.window.document.getElementById('petActor')!.dataset.state).toBe('idle');
  click('#petLauncher');vi.mocked(requestAnimationFrame).mockClear();await vi.advanceTimersByTimeAsync(5000);
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  click('#petLauncher');dispose!();dispose=undefined;
  vi.mocked(requestAnimationFrame).mockClear();await vi.advanceTimersByTimeAsync(5000);
  expect(requestAnimationFrame).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});

it('keeps continuous travel between sprite changes and replaces a sleep when poked',async()=>{
  await boot();click('#petLauncher');await vi.advanceTimersByTimeAsync(650);
  click('#petActor');expect(dom.window.document.getElementById('petActor')!.dataset.state).toBe('poke');
  await vi.advanceTimersByTimeAsync(900);expect(dom.window.document.getElementById('petActor')!.dataset.state).toBe('idle');
  click('.pet-menu button:nth-child(4)');await vi.advanceTimersByTimeAsync(20);
  const actor=dom.window.document.getElementById('petActor')!,frame=actor.dataset.frame,position=actor.style.transform;
  await vi.advanceTimersByTimeAsync(50);
  expect(actor.dataset.frame).toBe(frame);expect(actor.style.transform).not.toBe(position);
});
