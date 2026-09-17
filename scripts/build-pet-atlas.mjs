import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {manifest,animations} from './pet-plan.mjs';
const root=path.resolve(import.meta.dirname,'..'),docs=path.join(root,'docs/pet'),output=path.join(root,'src/renderer/pet-assets');
const preview=process.argv.includes('--preview');
const frames=[],checks=[];
for(let i=0;i<96;i++){
  const file=path.join(docs,'frames',`frame-${String(i).padStart(3,'0')}.png`);
  try{await fs.access(file);}catch(error){if(preview)break;throw error;}
  const source=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let minX=576,minY=576,maxX=0,maxY=0;
  for(let p=0;p<576*576;p++)if(source.data[p*4+3]>=128){minX=Math.min(minX,p%576);maxX=Math.max(maxX,p%576);minY=Math.min(minY,Math.floor(p/576));maxY=Math.max(maxY,Math.floor(p/576));}
  let footLeft=576,footRight=0;
  for(let y=maxY-18;y<=maxY;y++)for(let x=0;x<576;x++)if(source.data[(y*576+x)*4+3]>=128){footLeft=Math.min(footLeft,x);footRight=Math.max(footRight,x);}
  const rootX=(footLeft+footRight)/2;
  const airborne=i>=20&&i<=23||i>=90&&i<=92;
  const ground=airborne?512:maxY;
  const scale=i>=3&&i<=11?90/(maxY-minY+1):112/576;
  const resizedSize=Math.round(576*scale);
  const resized=await sharp(file).resize(resizedSize,resizedSize,{kernel:'nearest'}).ensureAlpha().raw().toBuffer();
  const registered=Buffer.alloc(160*160*4);
  const offsetX=Math.round(80-rootX*scale),offsetY=Math.round(136-ground*scale);
  for(let y=0;y<resizedSize;y++)for(let x=0;x<resizedSize;x++){
    const xx=x+offsetX,yy=y+offsetY;if(xx<0||xx>=160||yy<0||yy>=160)continue;
    resized.copy(registered,(yy*160+xx)*4,(y*resizedSize+x)*4,(y*resizedSize+x)*4+4);
  }
  const {data,info}=await sharp(registered,{raw:{width:160,height:160,channels:4}}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(info.channels,4);
  for(let p=3;p<data.length;p+=4)data[p]=data[p]>=128?255:0;
  // Retain the connected character; discard separate presentation particles/halos.
  const seen=new Uint8Array(160*160),groups=[];
  for(let p=0;p<seen.length;p++){
    if(seen[p]||!data[p*4+3])continue;
    const group=[p];seen[p]=1;
    for(let n=0;n<group.length;n++){
      const at=group[n],x=at%160,y=Math.floor(at/160);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const xx=x+dx,yy=y+dy;if(xx<0||xx>=160||yy<0||yy>=160)continue;
        const next=yy*160+xx;if(!seen[next]&&data[next*4+3]){seen[next]=1;group.push(next);}
      }
    }groups.push(group);
  }
  groups.sort((a,b)=>b.length-a.length);assert.ok(groups[0]?.length>400,`Empty or damaged frame ${i}`);
  for(const group of groups.slice(1))for(const p of group)data[p*4+3]=0;
  const frame=await sharp(data,{raw:{width:160,height:160,channels:4}}).png().toBuffer();
  frames.push(frame);checks.push({frame:i,opaquePixels:groups[0].length,registration:{rootX,ground,scale,offsetX,offsetY},discardedParticles:groups.slice(1).map(g=>g.length),sha256:createHash('sha256').update(frame).digest('hex')});
}
assert.ok(frames.length>0);
await fs.mkdir(output,{recursive:true});await fs.mkdir(path.join(docs,'previews'),{recursive:true});
if(!preview){
  assert.equal(frames.length,96);assert.equal(new Set(checks.map(c=>c.sha256)).size,96,'Duplicate authored frames');
  await sharp({create:{width:manifest.width,height:manifest.height,channels:4,background:'#00000000'}})
    .composite(frames.map((input,i)=>({input,left:i%8*160,top:Math.floor(i/8)*160})))
    .png({palette:true,colours:32,dither:0}).toFile(path.join(output,'atlas.png'));
  await fs.writeFile(path.join(output,'animations.json'),JSON.stringify(manifest,null,2)+'\n');
  await sharp(frames[7]).trim().resize(24,32,{fit:'contain',kernel:'nearest',background:'#00000000'}).png().toFile(path.join(output,'launcher.png'));
}
const contact=await sharp({create:{width:960,height:Math.ceil(frames.length/6)*160,channels:4,background:'#364152'}})
  .composite(frames.map((input,i)=>({input,left:i%6*160,top:Math.floor(i/6)*160}))).png().toBuffer();
await fs.writeFile(path.join(docs,preview?'progress-contact.png':'contact-sheet.png'),contact);
async function gif(name,ids,delays){
  if(ids.some(id=>id>=frames.length))return;
  const raw=await Promise.all(ids.map(id=>sharp(frames[id]).flatten({background:'#364152'}).resize(256,256,{kernel:'nearest'}).raw().toBuffer()));
  await sharp(Buffer.concat(raw),{raw:{width:256,height:256*raw.length,channels:3,pageHeight:256}}).gif({loop:0,delay:delays}).toFile(path.join(docs,'previews',name+'.gif'));
}
for(const [name,a] of Object.entries(animations))await gif(name,a.frames,a.ms);
await gif('chronological',frames.map((_,i)=>i),frames.map(()=>110));
await fs.writeFile(path.join(docs,preview?'progress-validation.json':'atlas-validation.json'),JSON.stringify({structurallyValid:true,visualAcceptance:'pending animation review',expectedFrames:96,actualFrames:frames.length,checks},null,2)+'\n');
console.log(JSON.stringify({frames:frames.length,mode:preview?'work-in-progress':'production-export',unique:new Set(checks.map(c=>c.sha256)).size}));
