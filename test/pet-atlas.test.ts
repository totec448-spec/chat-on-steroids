import {it,expect} from 'vitest';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import manifest from '../src/renderer/pet-assets/animations.json';

it('ships 96 distinct nonempty transparent atlas cells with no cut edge',async()=>{
  const {data,info}=await sharp('src/renderer/pet-assets/atlas.png').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  expect([info.width,info.height]).toEqual([manifest.width,manifest.height]);
  const hashes=new Set<string>(),idleBounds:number[][]=[];
  for(let frame=0;frame<96;frame++){
    const cell=Buffer.alloc(160*160*4);let pixels=0,minX=160,maxX=0,minY=160,maxY=0;
    for(let y=0;y<160;y++)for(let x=0;x<160;x++){
      const from=((Math.floor(frame/8)*160+y)*info.width+frame%8*160+x)*4;
      data.copy(cell,(y*160+x)*4,from,from+4);
      if(data[from+3]){pixels++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    }
    expect(pixels,`frame ${frame}`).toBeGreaterThan(400);
    expect(minX,`left edge ${frame}`).toBeGreaterThan(0);expect(maxX,`right edge ${frame}`).toBeLessThan(159);
    expect(minY,`top edge ${frame}`).toBeGreaterThan(0);expect(maxY,`bottom edge ${frame}`).toBeLessThan(159);
    hashes.add(createHash('sha256').update(cell).digest('hex'));
    if(frame>=4&&frame<=7)idleBounds.push([minX,maxX,minY,maxY]);
  }
  expect(hashes.size).toBe(96);
  for(let axis=0;axis<4;axis++)expect(Math.max(...idleBounds.map(b=>b[axis]!))-Math.min(...idleBounds.map(b=>b[axis]!)),`idle geometry axis ${axis}`).toBeLessThanOrEqual(1);
});

it('ships local transparent launcher, bat, and bin variants',async()=>{
  for(const name of ['launcher','bat','bin','bin-open','bin-hit']){
    const meta=await sharp(`src/renderer/pet-assets/${name}.png`).metadata();
    expect(meta.hasAlpha,name).toBe(true);expect(meta.width).toBeLessThanOrEqual(32);expect(meta.height).toBeLessThanOrEqual(49);
  }
});
