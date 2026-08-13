import express from "express";
import sharp from "sharp";

const app = express();
app.use(express.json({ limit: "20mb" }));

const DPI = 300;
const PX_PER_CM = DPI / 2.54;
const FINAL_UPLOAD_URL = "https://qrpxaqvybfmpkkkgqaoe.supabase.co/functions/v1/rapid-function";

app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.sendStatus(204);
  next();
});

function cmToPx(cm){ return Math.round(Number(cm)*PX_PER_CM); }
function safeFilePart(value,fallback="Gang_Sheet"){
  const s=String(value||fallback)
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-zA-Z0-9_-]+/g,"_")
    .replace(/^_+|_+$/g,"");
  return s||fallback;
}
function validateSheet(widthCm,heightCm){
  if(!Number.isFinite(widthCm)||!Number.isFinite(heightCm)||widthCm<=0||heightCm<=0) throw new Error("Dimensiones inválidas");
  if(widthCm>62.001) throw new Error("El ancho máximo es 62 cm");
  if(heightCm>310.001) throw new Error("El largo máximo es 310 cm");
}
async function fetchBuffer(url){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),120000);
  try{
    const r=await fetch(url,{signal:controller.signal,cache:"no-store"});
    if(!r.ok) throw new Error(`No se pudo descargar un recurso (HTTP ${r.status})`);
    const ab=await r.arrayBuffer();
    return Buffer.from(ab);
  }finally{ clearTimeout(timer); }
}

async function rasterizeObject(o){
  const src=await fetchBuffer(o.url);
  const targetW=Math.max(1,cmToPx(o.width));
  const targetH=Math.max(1,cmToPx(o.height));

  let img=sharp(src,{failOn:"none"}).resize(targetW,targetH,{
    fit:"fill",
    kernel:sharp.kernel.lanczos3
  });

  // Browser transform order is local flip first, then rotation around center.
  if(o.flipY) img=img.flip();
  if(o.flipX) img=img.flop();
  const rotation=((Number(o.rotation)||0)%360+360)%360;
  if(rotation){
    img=img.rotate(rotation,{background:{r:0,g:0,b:0,alpha:0}});
  }

  const png=await img.png({compressionLevel:6}).toBuffer();
  const meta=await sharp(png).metadata();
  return {png,width:Number(meta.width)||targetW,height:Number(meta.height)||targetH};
}

async function uploadFinalPng(buffer,sheet){
  const filename=`${safeFilePart(sheet.name)}_${Number(sheet.widthCm).toFixed(0)}x${Number(sheet.heightCm).toFixed(1)}cm_300dpi.png`;
  const form=new FormData();
  form.append("file",new Blob([buffer],{type:"image/png"}),filename);

  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10*60*1000);
  try{
    const response=await fetch(FINAL_UPLOAD_URL,{method:"POST",body:form,signal:controller.signal,cache:"no-store"});
    let data={};
    try{ data=await response.json(); }catch(_){ }
    if(!response.ok || !data?.ok) throw new Error(data?.error||`No se pudo guardar el PNG final (HTTP ${response.status})`);
    if(!data.id || !data.downloadUrl) throw new Error("Supabase no devolvió la referencia del PNG final.");
    return data;
  }finally{ clearTimeout(timer); }
}

app.get("/",(req,res)=>res.json({ok:true,service:"BixStudio Renderer",version:"1.2.0"}));
app.get("/health",(req,res)=>res.json({ok:true,sharp:sharp.versions.sharp,node:process.version,version:"1.2.0"}));

app.post("/render-test",async(req,res)=>{
  try{
    const widthCm=Number(req.body.widthCm??62),heightCm=Number(req.body.heightCm??30);
    validateSheet(widthCm,heightCm);
    const png=await sharp({create:{width:cmToPx(widthCm),height:cmToPx(heightCm),channels:4,background:{r:0,g:0,b:0,alpha:0}}})
      .png({compressionLevel:6}).withMetadata({density:DPI}).toBuffer();
    res.type("png").send(png);
  }catch(e){res.status(400).json({ok:false,error:e.message});}
});

app.post("/render-sheet",async(req,res)=>{
  const started=Date.now();
  try{
    const sheet=req.body?.sheet||{};
    const objects=Array.isArray(req.body?.objects)?req.body.objects:[];
    const widthCm=Number(sheet.widthCm),heightCm=Number(sheet.heightCm);
    validateSheet(widthCm,heightCm);
    if(!objects.length) throw new Error("La hoja no contiene diseños.");

    const canvasW=cmToPx(widthCm),canvasH=cmToPx(heightCm);
    const composites=[];

    // Sequential on purpose: keeps peak memory predictable for huge gang sheets.
    for(const o of objects){
      if(!o?.url) continue;
      const width=Number(o.width),height=Number(o.height),x=Number(o.x),y=Number(o.y);
      if(![width,height,x,y].every(Number.isFinite)||width<=0||height<=0) throw new Error("Un diseño tiene medidas inválidas.");
      const r=await rasterizeObject(o);
      const cx=cmToPx(x+width/2),cy=cmToPx(y+height/2);
      const left=Math.round(cx-r.width/2),top=Math.round(cy-r.height/2);
      if(left<0||top<0||left+r.width>canvasW||top+r.height>canvasH){
        throw new Error("Un diseño queda fuera de la hoja al renderizarlo.");
      }
      composites.push({input:r.png,left,top,blend:"over"});
    }

    const finalPng=await sharp({
      create:{width:canvasW,height:canvasH,channels:4,background:{r:0,g:0,b:0,alpha:0}}
    })
      .composite(composites)
      .png({compressionLevel:6,adaptiveFiltering:true})
      .withMetadata({density:DPI})
      .toBuffer();

    const upload=await uploadFinalPng(finalPng,{...sheet,widthCm,heightCm});
    res.json({
      ...upload,
      ok:true,
      widthPx:canvasW,
      heightPx:canvasH,
      dpi:DPI,
      bytes:finalPng.length,
      renderMs:Date.now()-started
    });
  }catch(error){
    console.error("render-sheet:",error);
    res.status(400).json({ok:false,error:error?.message||String(error)});
  }
});

const PORT=Number(process.env.PORT)||8080;
app.listen(PORT,"0.0.0.0",()=>console.log(`BixStudio Renderer v1.2.0 en puerto ${PORT}`));
