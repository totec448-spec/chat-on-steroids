import {JSDOM} from 'jsdom';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
let dom:JSDOM,dispose:(()=>void)|undefined;
beforeEach(()=>{
  dom=new JSDOM('<body><div class="composer-toolbar"><div class="composer-options"></div></div></body>',{url:'https://pet.test',pretendToBeVisual:true});
  const w=dom.window;
  const media={matches:false,addEventListener:vi.fn()};
  const capture=new Set<number>();
  w.HTMLElement.prototype.setPointerCapture=id=>{capture.add(id);};
  w.HTMLElement.prototype.hasPointerCapture=id=>capture.has(id);
  w.HTMLElement.prototype.releasePointerCapture=id=>{capture.delete(id);};
  for(const [key,value] of Object.entries({window:w,document:w.document,localStorage:w.localStorage,innerWidth:1000,innerHeight:800,
    AbortController:w.AbortController,matchMedia:()=>media,requestAnimationFrame:vi.fn(()=>1),cancelAnimationFrame:vi.fn(),
    Image:class{onload:(()=>void)|null=null;onerror:null=null;set src(_value:string){queueMicrotask(()=>this.onload?.());}}}))vi.stubGlobal(key,value);
});
afterEach(()=>{dispose?.();dispose=undefined;dom.window.close();vi.unstubAllGlobals();vi.resetModules();});
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
