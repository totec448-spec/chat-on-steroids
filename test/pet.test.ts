import {describe,it,expect} from 'vitest';
import {PetMachine,clampPosition,readPreference,animationFrame,animationDuration,SPECIAL_COOLDOWN} from '../src/renderer/pet-machine.js';
import manifest from '../src/renderer/pet-assets/animations.json';
const create=()=>new PetMachine({visible:true,x:180,y:300},1000,800,()=>.5);
const advance=(pet:PetMachine,ms:number)=>{while(ms>0){const dt=Math.min(ms,100);pet.tick(dt);ms-=dt;}};
describe('Tur Tur Sahur animation owner',()=>{
  it('spawns into idle and uses authored per-frame durations',()=>{
    const pet=create();expect(pet.frame).toBe(0);advance(pet,500);expect(pet.state).toBe('idle');
    expect(animationFrame('punch',0)).toBe(38);expect(animationFrame('punch',210)).toBe(40);
    expect(animationFrame('heavy',animationDuration('heavy')+100)).toBe(65);
    expect(animationFrame('walk',animationDuration('walk'))).toBe(12);
  });
  it('advances a deliberate long hold in full and parks settled held/reduced poses',()=>{
    const pet=create();
    for(const duration of manifest.animations.spawn.ms)pet.tick(duration);
    expect(pet.state).toBe('idle');expect(pet.nextUpdateIn).toBe(600);
    pet.tick(600);expect(pet.frame).toBe(5);expect(pet.nextUpdateIn).toBe(200);
    pet.beginPointer(1,{x:0,y:0});expect(pet.nextUpdateIn).toBe(Infinity);
    pet.movePointer(1,{x:20,y:0});
    for(const duration of manifest.animations.held.ms)pet.tick(duration);
    expect(pet.frame).toBe(23);expect(pet.nextUpdateIn).toBe(Infinity);
    pet.setReducedMotion(true);expect(pet.nextUpdateIn).toBe(Infinity);
    pet.poke();expect(pet.nextUpdateIn).toBe(animationDuration('poke'));
    pet.tick(pet.nextUpdateIn);expect(pet.state).toBe('idle');expect(pet.nextUpdateIn).toBe(Infinity);
  });
  it.each(['openai','anthropic'] as const)('deadline-driven %s retains every authored non-looping action frame',kind=>{
    const pet=create();pet.startAction(kind);
    const seen=new Map<string,number[]>();
    for(let steps=0;pet.scene && steps<5000;steps++){
      const frames=seen.get(pet.state)??[];if(frames.at(-1)!==pet.frame)frames.push(pet.frame);seen.set(pet.state,frames);
      const delay=pet.nextUpdateIn;expect(Number.isFinite(delay)).toBe(true);
      pet.tick(delay===0?5:delay);
    }
    expect(pet.scene).toBeNull();
    for(const [state,frames] of seen){
      const clip=manifest.animations[state as keyof typeof manifest.animations];
      if(!clip.loop)expect(frames,state).toEqual(clip.frames);
    }
  });
  it('still bounds an unexpected stall during continuous motion',()=>{
    const pet=create();pet.startAction('openai');pet.tick(60000);
    expect(pet.clock).toBe(100);expect(pet.state).toBe('walk');expect(pet.position.x-180).toBeLessThan(5);
  });
  it('distinguishes jitter clicks from drags, and rejects foreign pointer events',()=>{
    const pet=create();pet.beginPointer(1,{x:10,y:10});pet.movePointer(9,{x:200,y:10});
    pet.movePointer(1,{x:13,y:12});pet.endPointer(1);expect(pet.state).toBe('poke');expect(pet.position.x).toBe(180);
    pet.beginPointer(2,{x:10,y:10});pet.movePointer(2,{x:40,y:20});expect(pet.state).toBe('held');
    pet.endPointer(2);expect(pet.state).toBe('landing');expect(pet.position).toEqual({x:210,y:310});
  });
  it('cancelled pointer events never turn into pokes',()=>{
    const pet=create();advance(pet,500);pet.beginPointer(1,{x:0,y:0});pet.endPointer(1,true);expect(pet.state).toBe('idle');
  });
  it('four recent clicks cause anger but old clicks do not accumulate',()=>{
    const pet=create();for(let n=0;n<4;n++)pet.poke();expect(pet.state).toBe('angry');
    advance(pet,1700);pet.poke();expect(pet.state).toBe('poke');
  });
  it.each(['openai','anthropic'] as const)('hiding during %s retires the entire action',kind=>{
    const pet=create();pet.startAction(kind);advance(pet,1600);expect(pet.scene).not.toBeNull();pet.hide();
    expect(pet.scene).toBeNull();expect(pet.pointer).toBeNull();advance(pet,60000);expect(pet.state).toBe('hidden');
    pet.show();expect(pet.state).toBe('spawn');expect(pet.scene).toBeNull();
  });
  it('dragging interrupts a combo without resurrecting it on release',()=>{
    const pet=create();pet.startAction('openai');advance(pet,3000);expect(pet.state).toBe('punch');
    pet.beginPointer(3,{x:100,y:100});pet.movePointer(3,{x:110,y:100});expect(pet.scene).toBeNull();
    pet.endPointer(3);advance(pet,1000);expect(pet.state).toBe('idle');expect(pet.scene).toBeNull();
  });
  it('completes both action phase sequences in order',()=>{
    for(const kind of ['openai','anthropic'] as const){
      const pet=create();pet.startAction(kind);const states:string[]=[];
      for(let n=0;n<150 && pet.scene;n++){if(states.at(-1)!==pet.state)states.push(pet.state);pet.tick(100);}
      expect(states).toEqual(kind==='openai'?['walk','angry','punch','heavy','celebrate']:['walk','grab','carry','throw','celebrate']);
      expect(pet.state).toBe('idle');expect(pet.scene).toBeNull();
    }
  });
  it('clamps positions including corrupt input and tiny viewports',()=>{
    expect(clampPosition({x:999,y:-20},800,600)).toEqual({x:640,y:0});
    expect(clampPosition({x:NaN,y:Infinity},20,20)).toEqual({x:0,y:0});
    const pet=create();pet.startAction('openai');pet.resize(150,150);expect(pet.position).toEqual({x:0,y:0});expect(pet.scene).toBeNull();
  });
  it('round-trips only validated visibility and position preferences',()=>{
    const pet=create();pet.hide();expect(readPreference(JSON.stringify(pet.preference),1000,800)).toEqual(pet.preference);
    expect(readPreference('{bad',1000,800).visible).toBe(false);
    expect(readPreference('{"visible":"yes","x":1,"y":2}',1000,800).visible).toBe(false);
    expect(readPreference('{"visible":true,"x":9000,"y":9000}',1000,800)).toEqual({visible:true,x:840,y:640});
  });
  it('schedules occasional alternating actions with cooldown after interaction',()=>{
    const pet=create();advance(pet,SPECIAL_COOLDOWN-1000);expect(pet.scene).toBeNull();
    advance(pet,1000);expect(pet.scene?.kind).toBe('openai');advance(pet,10000);expect(pet.scene).toBeNull();
    pet.poke();advance(pet,SPECIAL_COOLDOWN-100);expect(pet.scene).toBeNull();
    // Cooldown is a lower bound; finish the current short walk before a special.
    advance(pet,2100);expect(pet.scene?.kind).toBe('anthropic');
  });
  it('reduced motion cancels travel and prevents autonomous actions',()=>{
    const pet=create();pet.startAction('anthropic');pet.setReducedMotion(true);expect(pet.scene).toBeNull();
    advance(pet,100000);expect(pet.state).toBe('idle');expect(pet.frame).toBe(7);expect(pet.startAction('openai')).toBe(false);
    pet.beginPointer(1,{x:0,y:0});pet.movePointer(1,{x:20,y:20});expect(pet.frame).toBe(23);
  });
  it('starts either action without teleporting and keeps its stage in the viewport',()=>{
    for(const width of [420,700,1000])for(const x of [0,width/2-80,width-160])for(const kind of ['openai','anthropic'] as const){
      const pet=new PetMachine({visible:true,x,y:100},width,800);
      const origin={...pet.position};expect(pet.startAction(kind)).toBe(true);expect(pet.position).toEqual(origin);
      expect(pet.scene!.bin.x).toBeGreaterThanOrEqual(16);expect(pet.scene!.bin.x).toBeLessThanOrEqual(width-16);
      advance(pet,100);expect(Math.abs(pet.position.x-origin.x)).toBeLessThan(5);
    }
  });
  it('declares 96 unique bounded frames and valid timings, independent of batches',()=>{
    const frames=Object.values(manifest.animations).flatMap(a=>a.frames);
    expect(new Set(frames).size).toBe(96);expect(frames.toSorted((a,b)=>a-b)).toEqual(Array.from({length:96},(_,i)=>i));
    for(const clip of Object.values(manifest.animations)){expect(clip.frames.length).toBe(clip.ms.length);expect(clip.ms.every(ms=>ms>0)).toBe(true);}
    expect(manifest.animations.punch.frames.length).toBe(18);expect(manifest.animations.heavy.frames.length).toBe(10);
    expect(manifest.width).toBe(manifest.columns*manifest.cellWidth);expect(manifest.height/manifest.cellHeight*manifest.columns).toBe(96);
  });
});
