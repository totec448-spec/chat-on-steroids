import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
for(const name of ['openai','anthropic']){
  const folder=path.join(root,'outputs/tur-tur-pet/electron',name+'-frames');
  const sequence=JSON.parse(await fs.readFile(path.join(folder,'sequence.json'),'utf8'));
  const frames=[];
  for(const file of sequence.files) frames.push(await sharp(path.join(folder,file)).extract({left:150,top:160,width:520,height:240}).resize(780,360,{kernel:'nearest'}).removeAlpha().raw().toBuffer());
  await sharp(Buffer.concat(frames),{raw:{width:780,height:360*frames.length,channels:3,pageHeight:360}}).gif({loop:0,delay:Math.round(sequence.elapsed/frames.length)}).toFile(path.join(root,'docs/pet/previews',name+'-live.gif'));
}
