import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import sharp from 'sharp';
import {writeFileSync} from 'node:fs';
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS);
const outs=[];
for (const f of ['public/assets/models/scenery/tree3.glb','public/assets/models/scenery/tree1.glb','public/assets/models/scenery/bush2.glb']) {
  const doc=await io.read(f); const r=doc.getRoot();
  for (const t of r.listTextures()) {
    const name=(t.getName()||'tex');
    if (!/base|color|albedo|diffuse/i.test(name) && r.listTextures().length>1) continue;
    const img=t.getImage(); if(!img) continue;
    const buf=await sharp(Buffer.from(img)).resize(230,230,{fit:'contain',background:'#4a6f9c'}).toBuffer();
    outs.push({buf, label:`${f.split('/').pop()} ${name}`});
  }
  // also report mesh tri counts + whether alpha is used
  for (const m of r.listMaterials()) console.log(f.split('/').pop(), '| mat', m.getName(), '| alphaMode', m.getAlphaMode(), '| baseColor', m.getBaseColorFactor().map(v=>+v.toFixed(2)).join(','));
}
const W=outs.length*240;
await sharp({create:{width:W,height:240,channels:3,background:'#111'}})
  .composite(outs.map((o,i)=>({input:o.buf, top:5, left:i*240+5}))).png().toFile(process.argv[2]);
console.log('panels:', outs.map(o=>o.label).join(' | '));
