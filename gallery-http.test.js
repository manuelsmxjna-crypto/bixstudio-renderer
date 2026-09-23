import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { Writable } from "node:stream";
import express from "express";
import sharp from "sharp";
import * as protection from "./gallery-production.js";

// Exercise production route bodies and the real Sharp renderer, with only cloud I/O replaced.
const source=fs.readFileSync(new URL("./server.js",import.meta.url),"utf8");
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
test("HTTP queue renders the clean source privately and public retrieval routes cannot expose it",async()=>{
 const originalPath="gallery/originals/design.png",uploadPath="projects/abc/assets/originals/source.png";
 const clean=await sharp({create:{width:80,height:120,channels:4,background:{r:230,g:40,b:20,alpha:.7}}}).png().toBuffer();
 const files=new Map([[originalPath,clean],[uploadPath,clean]]);
 const bucket={file:path=>({exists:async()=>[files.has(path)],download:async()=>{if(!files.has(path))throw Error("Missing source");return[files.get(path)]},save:async data=>{files.set(path,Buffer.from(data))},getMetadata:async()=>[{size:files.get(path)?.length||0}],createWriteStream:()=>{const chunks=[];return new Writable({write(chunk,enc,cb){chunks.push(chunk);cb()},final(cb){files.set(path,Buffer.concat(chunks));cb()}})},getSignedUrl:async()=>{throw Error("Private read URL must never be signed")}})};
 const jobs=new Map();let queued;const jobId="06b8d992-b5d0-4ddd-a9a0-bbfcd4423f98";
 const app=express();app.use(express.json());
 const context=vm.createContext({app,sharp,crypto,Buffer,console,bucket,DPI:300,PX_PER_CM:300/2.54,
   secureCheckoutEnabled:false,galleryWatermarkEnabled:true,galleryAdminUrl:"https://admin.example",PUBLIC_BASE_URL:"https://renderer.example",...protection,
   isUuid:id=>/^[0-9a-f-]{36}$/.test(id),
   galleryDb:{collection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>({published:true,objectPath:originalPath})})})})},
   ensureSheetRecord:async()=>({id:"sheet"}),createRenderJob:async()=>{const j={id:jobId,status:"queued"};jobs.set(jobId,j);return j},
   enqueueRenderTask:async p=>{queued=p;return"task"},updateRenderJob:async(id,fields)=>Object.assign(jobs.get(id),fields),getRenderJob:async id=>jobs.get(id),
   verifyTaskSignature:(_body,signature)=>signature==="test-worker-signature",signedReadUrl:async()=>{throw Error("Must not sign clean production")}
 });
 vm.runInContext(section("function cmToPx(",'app.get("/",'),context);
 vm.runInContext(section('app.post("/render-queue"','app.post("/render-sheet"'),context);
 vm.runInContext(section('app.post("/download-url"','app.post("/secure-orders/drafts"'),context);
 const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(path,body,headers={})=>fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
 try{
   const revision=crypto.createHash("sha256").update(originalPath).digest("hex").slice(0,24);
   const geometry={x:-.2,y:.1,width:1,height:1.4,rotation:90,flipX:true,flipY:true};
   const sheet={widthCm:2,heightCm:2,sheetNumber:1,name:"test"};
   const response=await post("/render-queue",{projectId:jobId,sheet,objects:[{...geometry,galleryId:"abcd1234",galleryRevision:revision}]});
   assert.equal(response.status,202);const payload=await response.json();
   assert.equal(payload.printFileUrl,`https://admin.example/production/${jobId}`);
   assert.equal(queued.objects[0].storagePath,originalPath);assert.equal(queued.privateGalleryJobId,jobId);
   assert.equal((await post("/render-worker",queued)).status,403);
   assert.equal((await post("/render-worker",queued,{"X-BixStudio-Task-Signature":"test-worker-signature"})).status,200);
   const receipt=JSON.parse(files.get(protection.galleryJobPath(jobId)));
   assert.equal(receipt.status,"completed");
   const privatePng=files.get(receipt.outputPath);assert.ok(privatePng.length>0);
   // Same renderer, same transforms, known clean uploaded source: output pixels must match.
   context.referenceInput={projectId:jobId,sheet,objects:[{...geometry,storagePath:uploadPath}]};
   const reference=await vm.runInContext("renderSheetToStorage(referenceInput)",context);
   assert.deepEqual(await sharp(privatePng).raw().toBuffer(),await sharp(files.get(reference.outputPath)).raw().toBuffer());
   assert.equal((await fetch(base+`/print-file/${jobId}`,{redirect:"manual"})).status,403);
   const status=await (await fetch(base+`/render-job/${jobId}`)).json();assert.equal(status.outputPath,null);
   assert.notEqual((await post("/download-url",{objectPath:receipt.outputPath})).status,200);
   assert.notEqual((await post("/download-url",{objectPath:originalPath})).status,200);
   assert.notEqual((await post("/render-queue",{projectId:jobId,sheet,objects:[{...geometry,storagePath:receipt.outputPath}]})).status,202);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
