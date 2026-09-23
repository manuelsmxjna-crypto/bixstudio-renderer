import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { assertPublicRenderObjects, resolveGalleryObjects, galleryOutputPath } from "./gallery-production.js";

const original="gallery/originals/abc-original.png";
const revision=crypto.createHash("sha256").update(original).digest("hex").slice(0,24);
const object={galleryId:"abcd1234",galleryRevision:revision,x:2,y:3,width:10,height:15,rotation:90,flipX:true};
const database=(published=true,category=true)=>({collection:name=>({doc:()=>({get:async()=>({exists:true,data:()=>name==="galleryImages"?{objectPath:original,published,categoryId:"cat"}:{published:category}})})})});
test("private source is resolved server-side and transforms survive",async()=>{
 const [resolved]=await resolveGalleryObjects([object],database());
 assert.equal(resolved.storagePath,original);assert.equal(resolved.rotation,90);assert.equal(resolved.flipX,true);assert.equal(resolved.x,2);assert.equal(resolved.galleryId,undefined);
});
test("reject substitution, unpublished categories, stale revisions and raw private paths",async()=>{
 await assert.rejects(resolveGalleryObjects([object],database(false)));
 await assert.rejects(resolveGalleryObjects([object],database(true,false)));
 await assert.rejects(resolveGalleryObjects([{...object,galleryRevision:"f".repeat(24)}],database()));
 assert.throws(()=>assertPublicRenderObjects([{...object,storagePath:original}]));
 for(const storagePath of [original,"private-gallery-production/outputs/x.png","projects/a/renders/clean.png","projects/a/assets/originals/../../clean.png"]){assert.throws(()=>assertPublicRenderObjects([{x:0,y:0,width:10,height:10,storagePath}]))}
});
test("ordinary customer sources remain accepted and private output is outside public projects",()=>{
 assert.doesNotThrow(()=>assertPublicRenderObjects([{x:0,y:0,width:10,height:10,storagePath:"projects/abc/assets/originals/upload.png"}]));
 assert.match(galleryOutputPath("06b8d992-b5d0-4ddd-a9a0-bbfcd4423f98"),/^private-gallery-production\/outputs\//);
});
