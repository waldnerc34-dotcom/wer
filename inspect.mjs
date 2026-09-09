import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const f of process.argv.slice(2)) {
  try {
    const doc = await io.read(f); const r = doc.getRoot();
    let tris=0, verts=0;
    for (const m of r.listMeshes()) for (const p of m.listPrimitives()) {
      const pos=p.getAttribute('POSITION'); verts+=pos?pos.getCount():0;
      tris += p.getIndices()? p.getIndices().getCount()/3 : (pos?pos.getCount()/3:0);
    }
    const texs=r.listTextures().map(t=>`${t.getName()||'?'}:${t.getMimeType()}`);
    const mats=r.listMaterials().map(m=>m.getName()||'?');
    console.log(`\n### ${f.split('/').pop()}`);
    console.log(`  tris=${Math.round(tris)} verts=${verts} meshes=${r.listMeshes().length} mats=${mats.length} texs=${texs.length}`);
    console.log(`  materials: ${mats.slice(0,12).join(', ')}`);
    console.log(`  textures : ${texs.slice(0,12).join(', ')}`);
    console.log(`  nodes    : ${r.listNodes().map(n=>n.getName()||'?').slice(0,14).join(', ')}`);
  } catch(e){ console.log(`\n### ${f} ERROR ${e.message}`); }
}
