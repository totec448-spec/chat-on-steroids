// Slice six chronological ImageGen poses; preserve raw crops for the next input.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const [batchArg, source, startArg] = process.argv.slice(2);
const batch = Number(batchArg);
assert.ok(Number.isInteger(batch) && batch >= 0 && batch < 16 && source);
const first=startArg===undefined?batch*6:Number(startArg);
assert.ok(Number.isInteger(first)&&first>=0&&first+5<96);
const dir = path.join(root, 'docs/pet');
await fs.mkdir(path.join(dir, 'batches'), {recursive:true});
await fs.mkdir(path.join(dir, 'frames'), {recursive:true});
const name = startArg===undefined?`batch-${String(batch).padStart(2,'0')}.png`:`repair-${String(first).padStart(3,'0')}.png`;
if(path.resolve(source)!==path.join(dir,'batches',name))await fs.copyFile(source, path.join(dir,'batches',name));
const meta = await sharp(source).metadata();
assert.equal(meta.width % 3,0); assert.equal(meta.height % 2,0);
assert.equal(meta.width / 3,meta.height / 2, 'Expected a 3x2 square-cell sheet');
const size = meta.width / 3;
const {data}=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
const width=meta.width,height=meta.height,seen=new Uint8Array(width*height),groups=[];
for(let p=0;p<seen.length;p++){
  if(seen[p]||data[p*4+3]<128)continue;
  const pixels=[p];seen[p]=1;let minX=p%width,maxX=minX,minY=Math.floor(p/width),maxY=minY;
  for(let n=0;n<pixels.length;n++){
    const at=pixels[n],x=at%width,y=Math.floor(at/width);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const xx=x+dx,yy=y+dy;if(xx<0||xx>=width||yy<0||yy>=height)continue;
      const next=yy*width+xx;if(!seen[next]&&data[next*4+3]>=128){seen[next]=1;pixels.push(next);}
    }
  }if(pixels.length>500)groups.push({pixels,minX,maxX,minY,maxY});
}
groups.sort((a,b)=>b.pixels.length-a.pixels.length);assert.ok(groups.length>=6,'Six separate characters required');
const subjects=groups.slice(0,6).sort((a,b)=>(a.minY+a.maxY)-(b.minY+b.maxY));
const ordered=[...subjects.slice(0,3).sort((a,b)=>a.minX-b.minX),...subjects.slice(3).sort((a,b)=>a.minX-b.minX)];
const canvas=size+64;
for(let n=0;n<6;n++){
  const g=ordered[n];assert.ok(g.maxX-g.minX<canvas && g.maxY-g.minY<canvas,`Pose ${batch*6+n} too large: ${g.maxX-g.minX}x${g.maxY-g.minY}`);
  const left=Math.min(g.minX,Math.max(n%3*size-32,g.maxX-canvas+1));
  const top=Math.min(g.minY,Math.max(Math.floor(n/3)*size-32,g.maxY-canvas+1));
  const crop=Buffer.alloc(canvas*canvas*4);
  for(const p of g.pixels){const x=p%width-left,y=Math.floor(p/width)-top;data.copy(crop,(y*canvas+x)*4,p*4,p*4+4);}
  await sharp(crop,{raw:{width:canvas,height:canvas,channels:4}}).png().toFile(path.join(dir,'frames',`frame-${String(first+n).padStart(3,'0')}.png`));
}
console.log(JSON.stringify({batch,layout:'3x2',first,last:first+5,sourceSize:[meta.width,meta.height]}));
