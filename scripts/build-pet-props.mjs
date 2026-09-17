import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const source=path.join(root,'docs/pet/props.png');
if(process.argv[2]) await fs.copyFile(process.argv[2],source);
const names=['bat','bin','bin-open','bin-hit','hit','hit-heavy'];
for(let i=0;i<6;i++){
  const {data,info}=await sharp(source).extract({left:i%3*512,top:Math.floor(i/3)*512,width:512,height:512}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let minX=512,minY=512,maxX=0,maxY=0;
  for(let p=0;p<512*512;p++){
    data[p*4+3]=data[p*4+3]>=128?255:0;
    if(data[p*4+3]){minX=Math.min(minX,p%512);maxX=Math.max(maxX,p%512);minY=Math.min(minY,Math.floor(p/512));maxY=Math.max(maxY,Math.floor(p/512));}
  }
  // Bin variants share the source registration so opening does not resize the can.
  const rect=i>=1&&i<=3?{left:100,top:24,width:312,height:472}:{left:minX,top:minY,width:maxX-minX+1,height:maxY-minY+1};
  await sharp(data,{raw:info}).extract(rect).resize(i===0?12:32,i===0?49:48,{fit:'contain',kernel:'nearest',background:'#00000000'}).png({palette:true,colours:24,dither:0}).toFile(path.join(root,'src/renderer/pet-assets',names[i]+'.png'));
}
console.log('Exported six original props; character frame count remains 96.');
