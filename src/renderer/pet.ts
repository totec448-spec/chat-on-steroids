import { t, ui } from './i18n.js';
import { PetMachine, PET_KEY, readPreference } from './pet-machine.js';
import manifest from './pet-assets/animations.json';
import { carriedText, thrownText, THROW_RELEASE } from './pet-choreography.js';
import './pet.css';

/** Renderer-local companion. No provider state, IPC, network or background timers. */
export function initPet(): () => void {
  const toolbar=document.querySelector('.composer-toolbar');if(!toolbar)return ()=>{};
  let saved:string|null=null;try{saved=localStorage.getItem(PET_KEY);}catch{/* Optional UI preference. */}
  const machine=new PetMachine(readPreference(saved,innerWidth,innerHeight),innerWidth,innerHeight);
  const lifetime=new AbortController(),signal=lifetime.signal;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');if(reduced.matches)machine.setReducedMotion(true);
  const launcher=document.createElement('button');launcher.type='button';launcher.id='petLauncher';launcher.className='pet-launcher';
  ui(launcher,'aria-label',()=>t('Tur Tur Sahur pet'));ui(launcher,'title',()=>t('Tur Tur Sahur pet'));
  const icon=document.createElement('img');icon.src=new URL('./pet-assets/launcher.png',import.meta.url).href;icon.alt='';launcher.append(icon);
  toolbar.insertBefore(launcher,toolbar.querySelector('.composer-options'));
  const layer=document.createElement('div');layer.className='pet-layer';layer.id='petLayer';
  const actor=document.createElement('button');actor.type='button';actor.className='pet-actor';actor.id='petActor';
  ui(actor,'aria-label',()=>t('Tur Tur Sahur: drag, click, or open the context menu'));
  const sprite=document.createElement('span');sprite.className='pet-sprite';sprite.setAttribute('aria-hidden','true');
  sprite.style.backgroundImage=`url("${new URL('./pet-assets/atlas.png',import.meta.url).href}")`;
  const bat=document.createElement('img');bat.className='pet-bat';bat.src=new URL('./pet-assets/bat.png',import.meta.url).href;bat.alt='';bat.draggable=false;
  actor.append(sprite,bat);layer.append(actor);document.body.append(layer);
  const props=document.createElement('div');props.className='pet-props';layer.append(props);
  const menu=document.createElement('div');menu.className='pet-menu';menu.setAttribute('role','menu');menu.hidden=true;layer.append(menu);
  let raf=0,last=0,ready=false,lastSaved='',propScene:object|null=null;
  let target:HTMLSpanElement|null=null,bin:HTMLSpanElement|null=null,spark:HTMLSpanElement|null=null,targetWidth=0;
  function persist():void { const value=JSON.stringify(machine.preference);if(value===lastSaved)return;try{localStorage.setItem(PET_KEY,value);lastSaved=value;}catch{/* Current interaction still works. */} }
  function clearProps():void { props.replaceChildren();target=null;bin=null;spark=null;propScene=null; }
  function closeMenu():void {menu.hidden=true;}
  function release():void {const id=machine.pointer?.id;if(id!==undefined){machine.endPointer(id,true);if(actor.hasPointerCapture(id))actor.releasePointerCapture(id);}}
  function hide():void {release();machine.hide();closeMenu();clearProps();persist();paint();stop();launcher.focus();}
  function addMenu(label:string,action:()=>void):void {const item=document.createElement('button');item.type='button';item.setAttribute('role','menuitem');ui(item,'textContent',()=>t(label));item.addEventListener('click',()=>{closeMenu();action();paint();wake();},{signal});menu.append(item);}
  addMenu('Hide pet',hide);
  addMenu('Reset position',()=>{release();machine.reset();clearProps();persist();});
  addMenu('OpenAI → ClosedAI',()=>{machine.startAction('openai');});
  addMenu('Anthropic → trash',()=>{machine.startAction('anthropic');});
  function place(el:HTMLElement,x:number,y:number,extra=''):void {el.style.transform=`translate(${Math.round(x)}px, ${Math.round(y)}px) ${extra}`;}
  function paintProps():void {
    const scene=machine.scene;if(!scene){if(propScene)clearProps();return;}
    if(propScene!==scene){
      clearProps();propScene=scene;target=document.createElement('span');target.className='pet-target';props.append(target);
      spark=document.createElement('span');spark.className='pet-hit';props.append(spark);
      if(scene.kind==='anthropic'){bin=document.createElement('span');bin.className='pet-bin';bin.setAttribute('aria-hidden','true');props.append(bin);}
    }
    const frame=machine.frame,dir=scene.facing;
    const label=scene.kind==='openai'?(machine.state==='celebrate' || machine.state==='heavy' && frame>=61?'ClosedAI':'OpenAI'):'Anthropic';
    if(target!.textContent!==label){target!.textContent=label;targetWidth=target!.offsetWidth;}
    target!.hidden=false;spark!.hidden=true;
    let x=scene.target.x,y=scene.target.y,rotation=0,scale=1;
    if(scene.kind==='openai'){
      const hit=machine.state==='punch' && [40,46,52].includes(frame) || machine.state==='heavy' && frame===61;
      spark!.hidden=!hit;place(spark!,x-dir*25,y-8,`scale(${frame===61?1.5:1})`);
      if(hit){x+=dir*7;rotation=dir*8;}
    }else{
      place(bin!,scene.bin.x-16,scene.bin.y-48);
      bin!.classList.toggle('is-open',machine.state==='throw');
      if(machine.state==='grab' && frame>=69 || machine.state==='carry'){
        const hand=carriedText(machine.state as 'grab'|'carry',machine.elapsed,targetWidth);
        const attachedX=machine.position.x+80+dir*(hand.x-80);
        const attachedY=machine.position.y+hand.y;
        const blend=machine.state==='grab'?Math.min(1,Math.max(0,(machine.elapsed-370)/320)):1;
        x+=(attachedX-x)*blend;y+=(attachedY-y)*blend;
      }
      if(machine.state==='throw'){
        const flight=thrownText(machine.position,dir,machine.elapsed,targetWidth,scene.bin),progress=flight.progress;
        x=flight.x;y=flight.y;
        if(machine.elapsed<THROW_RELEASE){const hand=carriedText('throw',machine.elapsed,targetWidth);x=machine.position.x+80+dir*(hand.x-80);y=machine.position.y+hand.y;}
        rotation=dir*progress*100;scale=1-progress*.7;target!.hidden=progress>=1;
        bin!.classList.toggle('is-hit',progress>=1 && machine.elapsed<THROW_RELEASE+600+230);
      }
      if(machine.state==='celebrate'){target!.hidden=true;bin!.classList.remove('is-hit');}
    }
    place(target!,x,y,`translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`);
  }
  function paint():void {
    layer.hidden=!machine.visible || !ready;launcher.setAttribute('aria-pressed',String(machine.visible));
    for(const item of [...menu.querySelectorAll('button')].slice(2))item.disabled=machine.reducedMotion||innerWidth<420||innerHeight<200;
    if(!machine.visible)return;
    actor.dataset.state=machine.state;actor.dataset.frame=String(machine.frame);layer.dataset.action=machine.scene?.kind??'';
    place(actor,machine.position.x,machine.position.y);
    sprite.style.transform=`scaleX(${machine.facing})`;
    sprite.style.backgroundPosition=`-${machine.frame%manifest.columns*manifest.cellWidth}px -${Math.floor(machine.frame/manifest.columns)*manifest.cellWidth}px`;
    // The bat remains a distinct rigid prop, parked behind him during actions.
    const parked=!!machine.scene || !['idle','look','spawn'].includes(machine.state);
    bat.hidden=machine.frame>=36;
    bat.classList.toggle('is-parked',parked);bat.style.left=machine.facing===1?(parked?'51px':'56px'):(parked?'97px':'92px');
    bat.style.top=parked?'67px':machine.frame===0?'112px':'104px';
    bat.style.transform=`rotate(${machine.facing*(parked?165:24)}deg)`;
    paintProps();
  }
  function stop():void {if(raf)cancelAnimationFrame(raf);raf=0;last=0;}
  function step(now:number):void {
    raf=0;if(!machine.visible || document.hidden || !ready)return;
    const before=machine.state;if(menu.hidden)machine.tick(last?now-last:0);last=now;paint();
    if(machine.state==='idle' && before!=='idle')persist();
    if(!machine.reducedMotion || machine.pointer || machine.state!=='idle')raf=requestAnimationFrame(step);
  }
  function wake():void {if(!raf && machine.visible && ready && !document.hidden)raf=requestAnimationFrame(step);}
  launcher.addEventListener('click',()=>{if(machine.visible)hide();else{machine.show();persist();paint();wake();}},{signal});
  actor.addEventListener('pointerdown',event=>{if(event.button!==0)return;if(machine.beginPointer(event.pointerId,{x:event.clientX,y:event.clientY})){closeMenu();actor.setPointerCapture(event.pointerId);event.preventDefault();wake();}},{signal});
  actor.addEventListener('pointermove',event=>{machine.movePointer(event.pointerId,{x:event.clientX,y:event.clientY});paint();},{signal});
  function finish(event:PointerEvent,cancelled=false):void {machine.endPointer(event.pointerId,cancelled);if(actor.hasPointerCapture(event.pointerId))actor.releasePointerCapture(event.pointerId);persist();paint();wake();}
  actor.addEventListener('pointerup',event=>finish(event),{signal});
  actor.addEventListener('pointercancel',event=>finish(event,true),{signal});
  actor.addEventListener('lostpointercapture',event=>{if(machine.pointer?.id===event.pointerId)finish(event,true);},{signal});
  actor.addEventListener('click',event=>{if(event.detail===0){machine.poke();paint();wake();}},{signal});
  function openMenu(x:number,y:number):void {release();menu.hidden=false;place(menu,Math.max(4,Math.min(x,innerWidth-menu.offsetWidth-4)),Math.max(4,Math.min(y,innerHeight-menu.offsetHeight-4)));menu.querySelector('button')?.focus();}
  actor.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();openMenu(event.clientX,event.clientY);},{signal});
  actor.addEventListener('keydown',event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();openMenu(machine.position.x,machine.position.y);}else if(event.key==='Escape')hide();},{signal});
  menu.addEventListener('keydown',event=>{const items=[...menu.querySelectorAll('button')];const at=items.indexOf(document.activeElement as HTMLButtonElement);if(event.key==='Escape'){closeMenu();actor.focus();}else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();items[(at+(event.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();}},{signal});
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target as Node))closeMenu();},{signal});
  document.addEventListener('visibilitychange',()=>{release();persist();if(document.hidden)stop();else wake();},{signal});
  window.addEventListener('blur',()=>{release();persist();},{signal});
  window.addEventListener('resize',()=>{release();machine.resize(innerWidth,innerHeight);clearProps();closeMenu();persist();paint();wake();},{signal});
  reduced.addEventListener('change',()=>{release();machine.setReducedMotion(reduced.matches);clearProps();paint();wake();},{signal});
  window.addEventListener('pagehide',()=>{persist();stop();},{signal});
  const atlas=new Image();atlas.onload=()=>{if(signal.aborted)return;ready=true;paint();wake();};atlas.onerror=()=>{launcher.disabled=true;launcher.title=t('Pet artwork could not be loaded');};atlas.src=new URL('./pet-assets/atlas.png',import.meta.url).href;
  paint();
  return ()=>{persist();stop();lifetime.abort();machine.hide();clearProps();layer.remove();launcher.remove();};
}
