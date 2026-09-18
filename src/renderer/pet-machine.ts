import manifest from './pet-assets/animations.json';

export type PetAnimation = keyof typeof manifest.animations;
export type PetAction = 'openai' | 'anthropic';
export interface Point { x: number; y: number }
export interface PetPreference extends Point { visible: boolean }
export const PET_SIZE = 160;
export const PET_KEY = 'cos.ui.turTurPet.v1';
export const DRAG_DISTANCE = 6;
export const SPECIAL_COOLDOWN = 45_000;
export function clampPosition(p: Point, width: number, height: number): Point {
  return { x: Math.round(Math.max(0, Math.min(Number.isFinite(p.x) ? p.x : 0, Math.max(0,width-PET_SIZE)))),
    y: Math.round(Math.max(0, Math.min(Number.isFinite(p.y) ? p.y : 0, Math.max(0,height-PET_SIZE)))) };
}
export function readPreference(raw: string | null, width: number, height: number): PetPreference {
  const fallback = {visible:false,x:Math.max(0,width-200),y:Math.max(0,height-230)};
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || typeof value.visible !== 'boolean' || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return fallback;
    return {...clampPosition(value,width,height),visible:value.visible};
  } catch { return fallback; }
}
export function animationDuration(name: PetAnimation): number { return manifest.animations[name].ms.reduce((a,b)=>a+b,0); }
export function animationFrame(name: PetAnimation, elapsed: number, reduced=false): number {
  const clip = manifest.animations[name];
  if (reduced) return name === 'held' ? 23 : name === 'poke' ? 28 : name === 'angry' ? 32 : 7;
  let time = clip.loop ? elapsed % animationDuration(name) : Math.min(elapsed,animationDuration(name)-1);
  for(let i=0;i<clip.frames.length;i++) { time -= clip.ms[i]!; if(time<0) return clip.frames[i]!; }
  return clip.frames.at(-1)!;
}
function nextFrameIn(name: PetAnimation, elapsed: number): number {
  const clip=manifest.animations[name];
  let time=clip.loop?elapsed%animationDuration(name):elapsed;
  for(let i=0;i<clip.frames.length;i++){
    if(!clip.loop && i===clip.frames.length-1)return Infinity;
    if(time<clip.ms[i]!)return clip.ms[i]!-time;
    time-=clip.ms[i]!;
  }
  return Infinity;
}
interface Phase { animation: PetAnimation; duration: number; distance?: number }
export interface ActionScene { kind: PetAction; phase: number; target: Point; bin: Point; from: Point; facing: 1|-1 }
interface Pointer { id: number; start: Point; origin: Point; dragging: boolean }

/** One clock and owner for animation, gestures, autonomous decisions and props. */
export class PetMachine {
  state: PetAnimation | 'hidden';
  elapsed = 0;
  position: Point;
  facing: 1|-1 = 1;
  scene: ActionScene | null = null;
  pointer: Pointer | null = null;
  reducedMotion = false;
  clock = 0;
  nextSpecial = SPECIAL_COOLDOWN;
  nextDecision = 2500;
  nextKind: PetAction = 'openai';
  private clicks: number[] = [];
  private phases: Phase[] = [];
  private walkOrigin: Point;
  private walkDistance = 0;
  private walkDuration = 0;
  private mood = 0;
  constructor(preference: PetPreference, public width: number, public height: number, private random: ()=>number=Math.random) {
    this.position = clampPosition(preference,width,height); this.walkOrigin = {...this.position};
    this.state = preference.visible ? 'spawn' : 'hidden';
  }
  get visible(): boolean { return this.state !== 'hidden'; }
  get frame(): number { return this.state==='hidden' ? 7 : animationFrame(this.state,this.elapsed,this.reducedMotion); }
  get preference(): PetPreference { return {...this.position,visible:this.visible}; }
  /** Zero needs continuous motion; Infinity is static until an interaction.
   * Otherwise the authored frame, phase or autonomous decision owns the wake. */
  get nextUpdateIn(): number {
    if(this.state==='hidden' || this.pointer && !this.pointer.dragging)return Infinity;
    if(this.state==='walk' || this.scene && ['grab','carry','throw'].includes(this.state))return 0;
    const frame=this.reducedMotion?Infinity:nextFrameIn(this.state,this.elapsed);
    if(this.scene)return Math.max(0,Math.min(frame,this.phases[this.scene.phase]!.duration-this.elapsed));
    if(this.state==='held')return frame;
    if(this.state!=='idle')return Math.max(0,Math.min(frame,animationDuration(this.state)-this.elapsed));
    return this.reducedMotion?Infinity:Math.max(0,Math.min(frame,this.nextDecision-this.clock,this.nextSpecial-this.clock));
  }
  private enter(state: PetAnimation): void { this.state=state; this.elapsed=0; }
  private cancel(): void { this.scene=null; this.phases=[]; this.walkDistance=0; }
  private rest(): void { this.enter('idle'); this.nextDecision=this.clock+2500+this.random()*3500; }
  show(): void { if(this.visible)return; this.cancel(); this.clicks=[]; this.enter('spawn'); this.nextSpecial=this.clock+SPECIAL_COOLDOWN; }
  hide(): void { this.cancel(); this.pointer=null; this.clicks=[]; this.state='hidden';this.elapsed=0; }
  reset(): void { this.cancel();this.pointer=null;this.position=clampPosition({x:this.width-200,y:this.height-230},this.width,this.height);if(this.visible)this.rest(); }
  resize(width:number,height:number): void { this.width=width;this.height=height;this.position=clampPosition(this.position,width,height);this.cancel();this.pointer=null;if(this.visible)this.rest(); }
  setReducedMotion(value:boolean): void { this.reducedMotion=value;this.cancel();this.pointer=null;if(this.visible)this.rest(); }
  beginPointer(id:number,p:Point): boolean { if(!this.visible || this.pointer)return false;this.pointer={id,start:p,origin:{...this.position},dragging:false};return true; }
  movePointer(id:number,p:Point): void {
    const pointer=this.pointer;if(pointer?.id!==id)return;
    const dx=p.x-pointer.start.x,dy=p.y-pointer.start.y;
    if(!pointer.dragging && Math.hypot(dx,dy)<DRAG_DISTANCE)return;
    if(!pointer.dragging){pointer.dragging=true;this.cancel();this.clicks=[];this.enter('held');}
    this.position=clampPosition({x:pointer.origin.x+dx,y:pointer.origin.y+dy},this.width,this.height);
  }
  endPointer(id:number,cancelled=false): void {
    const pointer=this.pointer;if(pointer?.id!==id)return;this.pointer=null;
    if(pointer.dragging){this.enter('landing');this.nextSpecial=this.clock+SPECIAL_COOLDOWN;}
    else if(!cancelled)this.poke();
  }
  poke(): void {
    if(!this.visible || this.pointer)return;
    this.cancel();this.clicks=this.clicks.filter(t=>this.clock-t<1600);this.clicks.push(this.clock);
    this.enter(this.clicks.length>=4?'angry':'poke');if(this.clicks.length>=4)this.clicks=[];
    this.nextSpecial=this.clock+SPECIAL_COOLDOWN;
  }
  startAction(kind:PetAction): boolean {
    if(!this.visible || this.pointer || this.reducedMotion || this.width<420 || this.height<200)return false;
    this.cancel();this.clicks=[];
    // All scene geometry is chosen once in viewport coordinates, never retargeted mid-flight.
    const center=this.position.x+80,right=center<this.width/2;this.facing=right?1:-1;
    const start=this.position.x;
    // Adapt the stage to the room on this side. Never teleport the character.
    const space=right?this.width-center-36:center-36;
    const stageScale=Math.min(1,space/225);
    this.scene={kind,phase:0,from:{...this.position},facing:this.facing,
      target:{x:start+80+this.facing*(kind==='openai'?145:100)*stageScale,y:this.position.y+(kind==='openai'?100:90)},bin:{x:start+80+this.facing*225*stageScale,y:this.position.y+137}};
    this.phases=kind==='openai'
      ? [{animation:'walk',duration:1520,distance:55*stageScale},{animation:'angry',duration:animationDuration('angry')},{animation:'punch',duration:animationDuration('punch')},
        {animation:'heavy',duration:animationDuration('heavy')},{animation:'celebrate',duration:animationDuration('celebrate')+550}]
      : [{animation:'walk',duration:1520,distance:55*stageScale},{animation:'grab',duration:animationDuration('grab')},
        {animation:'carry',duration:1760,distance:75*stageScale},{animation:'throw',duration:animationDuration('throw')+550},
        {animation:'celebrate',duration:animationDuration('celebrate')}];
    this.enter('walk');this.nextSpecial=this.clock+SPECIAL_COOLDOWN;this.nextKind=kind==='openai'?'anthropic':'openai';return true;
  }
  tick(milliseconds:number): void {
    if(!this.visible)return;
    // A deliberate frame hold (e.g. 600 ms breathing) is elapsed animation time.
    // Keep the existing 100 ms stall allowance beyond the requested wake; normal
    // continuous movement still cannot jump across a long renderer suspension.
    const dt=Math.max(0,Math.min(Number.isFinite(milliseconds)?milliseconds:0,this.nextUpdateIn+100));this.clock+=dt;
    if(this.pointer && !this.pointer.dragging)return;
    this.elapsed+=dt;
    if(this.scene){
      const phase=this.phases[this.scene.phase]!;
      if(phase.distance)this.position=clampPosition({x:this.scene.from.x+this.facing*phase.distance*Math.min(1,this.elapsed/phase.duration),y:this.position.y},this.width,this.height);
      if(this.elapsed>=phase.duration){
        this.scene.phase++;this.scene.from={...this.position};const next=this.phases[this.scene.phase];
        if(next)this.enter(next.animation);else{this.cancel();this.rest();}
      }return;
    }
    if(this.state==='held')return;
    if(this.state==='walk'){
      this.position=clampPosition({x:this.walkOrigin.x+this.walkDistance*Math.min(1,this.elapsed/this.walkDuration),y:this.position.y},this.width,this.height);
      if(this.elapsed>=this.walkDuration)this.rest();return;
    }
    if(this.state!=='idle') { if(this.elapsed>=animationDuration(this.state as PetAnimation))this.rest();return; }
    if(this.reducedMotion || this.pointer)return;
    if(this.clock>=this.nextSpecial){
      this.nextSpecial=this.clock+SPECIAL_COOLDOWN+this.random()*20_000;
      if(this.startAction(this.nextKind))return;
    }
    if(this.clock>=this.nextDecision){
      this.mood=(this.mood+1)%3;
      if(this.mood===1)this.enter('look');
      else if(this.mood===2){
        this.facing=this.random()<.5?-1:1;this.walkOrigin={...this.position};
        const end=clampPosition({x:this.position.x+this.facing*(28+this.random()*42),y:this.position.y},this.width,this.height);
        this.walkDistance=end.x-this.position.x;this.walkDuration=760*2;this.enter('walk');
      } else this.rest();
    }
  }
}
