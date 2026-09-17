// Authored animation timing; generation batches are independent of clip lengths.
const clip = (start, count, ms, loop=false) => ({frames:Array.from({length:count},(_,i)=>start+i),ms:Array.isArray(ms)?ms:Array(count).fill(ms),loop});
export const animations = {
  spawn:clip(0,4,[130,110,100,140]), idle:clip(4,4,[600,200,220,650],true),
  look:clip(8,4,[90,100,330,200]), walk:clip(12,8,95,true), held:clip(20,4,[100,100,160,200]),
  landing:clip(24,4,[70,100,130,170]), poke:clip(28,4,[130,180,260,300]), angry:clip(32,6,[150,110,90,180,150,200]),
  punch:clip(38,18,[140,70,65,80,100,90,130,70,65,80,100,90,150,70,65,80,100,120]),
  heavy:clip(56,10,[110,150,180,140,70,90,100,120,150,180]),
  grab:clip(66,6,[100,120,150,160,140,170]), carry:clip(72,8,110,true),
  throw:clip(80,8,[150,150,190,100,90,130,160,180]), celebrate:clip(88,8,[140,120,100,150,100,110,250,250])
};
// Hand-tip coordinates measured in the registered atlas, facing right.
const hands = {69:[106,90,1],70:[106,80,1],71:[104,91,1],72:[104,90,1],73:[98,93,1],74:[106,90,1],75:[109,90,1],76:[107,92,1],77:[106,92,1],78:[99,92,1],79:[103,92,1],80:[80,100,1],81:[62,75,-1],82:[59,53,-1],83:[115,90,1],84:[115,92,1]};
export const manifest = {version:1,image:'atlas.png',width:1280,height:1920,columns:8,cellWidth:160,cellHeight:160,frameCount:96,anchor:[80,136],animations,hands};
