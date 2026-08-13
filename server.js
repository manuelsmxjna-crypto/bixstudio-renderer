import express from "express";
import sharp from "sharp";
import { Storage } from "@google-cloud/storage";
import crypto from "node:crypto";

const app = express();
const storage = new Storage();

app.use(express.json({ limit: "5mb" }));

const VERSION = "2.1.0";
const DPI = 300;
const PX_PER_CM = DPI / 2.54;
const BUCKET_NAME =
  process.env.BIXSTUDIO_BUCKET || "bixstudio-files-318403647962";

const bucket = storage.bucket(BUCKET_NAME);

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || "");

function getSupabaseRestRoot() {
  if (!SUPABASE_URL) throw new Error("Falta SUPABASE_URL");
  const url = new URL(SUPABASE_URL);

  if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co")) {
    throw new Error("SUPABASE_URL no es una URL válida de Supabase");
  }

  return `${url.origin}/rest/v1/`;
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,X-BixStudio-Project"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function cmToPx(cm) {
  return Math.round(Number(cm) * PX_PER_CM);
}

function safeFilePart(value, fallback = "file") {
  const s = String(value || fallback)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return s || fallback;
}

function randomId(prefix = "") {
  return prefix + crypto.randomBytes(12).toString("hex");
}

function validateSheet(widthCm, heightCm) {
  if (
    !Number.isFinite(widthCm) ||
    !Number.isFinite(heightCm) ||
    widthCm <= 0 ||
    heightCm <= 0
  ) {
    throw new Error("Dimensiones inválidas");
  }

  if (widthCm > 62.001) throw new Error("El ancho máximo es 62 cm");
  if (heightCm > 310.001) throw new Error("El largo máximo es 310 cm");
}

function validateObjectPath(path) {
  const value = String(path || "");
  if (!value.startsWith("projects/") || value.includes("..")) {
    throw new Error("Ruta de archivo inválida");
  }
  return value;
}

function normalizeContentType(type) {
  const t = String(type || "application/octet-stream").toLowerCase();
  const allowed = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/svg+xml",
    "application/octet-stream"
  ]);
  if (!allowed.has(t)) throw new Error("Tipo de archivo no permitido");
  return t;
}

async function downloadStorageObject(objectPath) {
  const path = validateObjectPath(objectPath);
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) throw new Error(`No existe el recurso ${path}`);
  const [buffer] = await file.download();
  return buffer;
}

async function rasterizeObject(o) {
  const src = await downloadStorageObject(o.storagePath);
  const targetW = Math.max(1, cmToPx(o.width));
  const targetH = Math.max(1, cmToPx(o.height));

  let img = sharp(src, { failOn: "none" }).resize(targetW, targetH, {
    fit: "fill",
    kernel: sharp.kernel.lanczos3
  });

  if (o.flipY) img = img.flip();
  if (o.flipX) img = img.flop();

  const rotation = ((Number(o.rotation) || 0) % 360 + 360) % 360;
  if (rotation) {
    img = img.rotate(rotation, {
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });
  }

  const png = await img.png({ compressionLevel: 4 }).toBuffer();
  const meta = await sharp(png).metadata();

  return {
    png,
    width: Number(meta.width) || targetW,
    height: Number(meta.height) || targetH
  };
}

async function renderSheetToStorage({ projectId, sheet, objects }) {
  const widthCm = Number(sheet.widthCm);
  const heightCm = Number(sheet.heightCm);

  validateSheet(widthCm, heightCm);
  if (!Array.isArray(objects) || !objects.length) {
    throw new Error("La hoja no contiene diseños.");
  }

  const canvasW = cmToPx(widthCm);
  const canvasH = cmToPx(heightCm);
  const composites = [];

  for (const o of objects) {
    if (!o?.storagePath) continue;

    const width = Number(o.width);
    const height = Number(o.height);
    const x = Number(o.x);
    const y = Number(o.y);

    if (
      ![width, height, x, y].every(Number.isFinite) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error("Un diseño tiene medidas inválidas.");
    }

    const r = await rasterizeObject(o);
    const cx = cmToPx(x + width / 2);
    const cy = cmToPx(y + height / 2);
    const left = Math.round(cx - r.width / 2);
    const top = Math.round(cy - r.height / 2);

    if (
      left < 0 ||
      top < 0 ||
      left + r.width > canvasW ||
      top + r.height > canvasH
    ) {
      throw new Error("Un diseño queda fuera de la hoja al renderizarlo.");
    }

    composites.push({
      input: r.png,
      left,
      top,
      blend: "over"
    });
  }

  if (!composites.length) {
    throw new Error("No hay recursos válidos para renderizar.");
  }

  const sheetNumber = Math.max(1, Number(sheet.sheetNumber) || 1);

  const filename =
    `${safeFilePart(sheet.name || `Gang_Sheet_${sheetNumber}`)}` +
    `_${widthCm.toFixed(0)}x${heightCm.toFixed(1)}cm_300dpi.png`;

  const outputPath =
    `projects/${safeFilePart(projectId)}/renders/` +
    `sheet_${sheetNumber}_${filename}`;

  const outputFile = bucket.file(outputPath);

  const pipeline = sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(composites)
    .png({
      compressionLevel: 4,
      adaptiveFiltering: true
    })
    .withMetadata({ density: DPI });

  await new Promise((resolve, reject) => {
    const writeStream = outputFile.createWriteStream({
      resumable: true,
      contentType: "image/png",
      metadata: {
        cacheControl: "private, max-age=0, no-store",
        metadata: {
          projectId: String(projectId),
          sheetNumber: String(sheetNumber),
          dpi: String(DPI),
          widthCm: String(widthCm),
          heightCm: String(heightCm)
        }
      }
    });

    pipeline.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("finish", resolve);

    pipeline.pipe(writeStream);
  });

  const [metadata] = await outputFile.getMetadata();

  return {
    outputPath,
    filename,
    widthPx: canvasW,
    heightPx: canvasH,
    dpi: DPI,
    bytes: Number(metadata.size || 0)
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "BixStudio API + Renderer",
    version: VERSION,
    bucket: BUCKET_NAME
  });
});

app.get("/supabase-health", async (req, res) => {
  const configured = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);

  if (!configured) {
    return res.status(503).json({
      ok: false,
      supabaseConfigured: false,
      databaseReachable: false,
      error: "Faltan SUPABASE_URL o SUPABASE_SECRET_KEY en Cloud Run."
    });
  }

  try {
    const response = await fetch(getSupabaseRestRoot(), {
      method: "GET",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
      },
      signal: AbortSignal.timeout(10000)
    });

    return res.status(response.ok ? 200 : 502).json({
      ok: response.ok,
      supabaseConfigured: true,
      databaseReachable: response.ok,
      status: response.status
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      supabaseConfigured: true,
      databaseReachable: false,
      error: error?.message || String(error)
    });
  }
});

app.get("/health", async (req, res) => {
  try {
    const [exists] = await bucket.exists();
    res.json({
      ok: true,
      version: VERSION,
      sharp: sharp.versions.sharp,
      node: process.version,
      bucket: BUCKET_NAME,
      bucketExists: exists
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: VERSION,
      error: error?.message || String(error)
    });
  }
});

app.post("/projects", (req, res) => {
  const projectId = randomId("bix_");
  res.json({ ok: true, projectId });
});

app.post("/upload-url", async (req, res) => {
  try {
    const projectId = safeFilePart(
      req.body?.projectId || randomId("bix_")
    );

    const assetId = safeFilePart(
      req.body?.assetId || randomId("asset_")
    );

    const originalName = safeFilePart(
      req.body?.filename || "artwork.png"
    );

    const contentType = normalizeContentType(req.body?.contentType);

    const objectPath =
      `projects/${projectId}/assets/originals/` +
      `${assetId}_${originalName}`;

    const file = bucket.file(objectPath);
    const expiresAt = Date.now() + 15 * 60 * 1000;

    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType
    });

    res.json({
      ok: true,
      projectId,
      assetId,
      objectPath,
      contentType,
      expiresAt,
      uploadUrl
    });
  } catch (error) {
    console.error("upload-url:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

app.post("/asset-status", async (req, res) => {
  try {
    const objectPath = validateObjectPath(req.body?.objectPath);
    const file = bucket.file(objectPath);
    const [exists] = await file.exists();

    if (!exists) {
      return res.json({ ok: true, exists: false, objectPath });
    }

    const [metadata] = await file.getMetadata();

    res.json({
      ok: true,
      exists: true,
      objectPath,
      bytes: Number(metadata.size || 0),
      contentType: metadata.contentType || null
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

app.post("/download-url", async (req, res) => {
  try {
    const objectPath = validateObjectPath(req.body?.objectPath);
    const file = bucket.file(objectPath);
    const [exists] = await file.exists();

    if (!exists) {
      return res.status(404).json({
        ok: false,
        error: "El archivo no existe."
      });
    }

    const expiresAt = Date.now() + 60 * 60 * 1000;

    const [downloadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: expiresAt
    });

    res.json({
      ok: true,
      objectPath,
      expiresAt,
      downloadUrl
    });
  } catch (error) {
    console.error("download-url:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

app.post("/render-sheet", async (req, res) => {
  const started = Date.now();

  try {
    const projectId = safeFilePart(
      req.body?.projectId || "test_project"
    );

    const sheet = req.body?.sheet || {};
    const objects = Array.isArray(req.body?.objects)
      ? req.body.objects
      : [];

    const rendered = await renderSheetToStorage({
      projectId,
      sheet,
      objects
    });

    res.json({
      ok: true,
      projectId,
      ...rendered,
      renderMs: Date.now() - started
    });
  } catch (error) {
    console.error("render-sheet:", error);
    res.status(400).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

app.post("/render-test", async (req, res) => {
  try {
    const widthCm = Number(req.body.widthCm ?? 62);
    const heightCm = Number(req.body.heightCm ?? 30);

    validateSheet(widthCm, heightCm);

    const png = await sharp({
      create: {
        width: cmToPx(widthCm),
        height: cmToPx(heightCm),
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .png({ compressionLevel: 4 })
      .withMetadata({ density: DPI })
      .toBuffer();

    res.type("png").send(png);
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BixStudio Renderer v${VERSION} en puerto ${PORT}`);
});
