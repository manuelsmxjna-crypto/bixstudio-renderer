import express from "express";
import sharp from "sharp";
import { Storage } from "@google-cloud/storage";
import crypto from "node:crypto";
import { CloudTasksClient } from "@google-cloud/tasks";

const app = express();
const storage = new Storage();

app.use(express.json({ limit: "5mb" }));

const VERSION = "2.5.0";
const DPI = 300;
const PX_PER_CM = DPI / 2.54;
const BUCKET_NAME =
  process.env.BIXSTUDIO_BUCKET || "bixstudio-files-318403647962";

const bucket = storage.bucket(BUCKET_NAME);

const tasksClient = new CloudTasksClient();
const TASKS_LOCATION = process.env.TASKS_LOCATION || "us-central1";
const TASKS_QUEUE = process.env.TASKS_QUEUE || "bixstudio-render";
const PUBLIC_BASE_URL = (
  process.env.BIX_RENDERER_PUBLIC_URL ||
  "https://bixstudio-renderer-318403647962.us-central1.run.app"
).replace(/\/$/, "");

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

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

async function supabaseRequest(path, {
  method = "GET",
  body,
  prefer,
  timeoutMs = 10000
} = {}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error("Supabase no está configurado en Cloud Run.");
  }

  const headers = {
    apikey: SUPABASE_SECRET_KEY,
    Accept: "application/json"
  };

  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;

  const response = await fetch(`${getSupabaseRestRoot()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
  }

  if (!response.ok) {
    const err = new Error(
      data?.message ||
      data?.error ||
      data?.hint ||
      `Supabase respondió HTTP ${response.status}`
    );
    err.status = response.status;
    err.details = data;
    throw err;
  }

  return data;
}


function signTaskBody(bodyText) {
  return crypto
    .createHmac("sha256", SUPABASE_SECRET_KEY)
    .update(bodyText)
    .digest("hex");
}

function verifyTaskSignature(bodyText, signature) {
  const expected = signTaskBody(bodyText);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function enqueueRenderTask(payload) {
  const projectId =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT;

  if (!projectId) {
    throw new Error("No se pudo determinar GOOGLE_CLOUD_PROJECT.");
  }

  const parent = tasksClient.queuePath(
    projectId,
    TASKS_LOCATION,
    TASKS_QUEUE
  );

  const bodyText = JSON.stringify(payload);
  const signature = signTaskBody(bodyText);

  const task = {
    httpRequest: {
      httpMethod: "POST",
      url: `${PUBLIC_BASE_URL}/render-worker`,
      headers: {
        "Content-Type": "application/json",
        "X-BixStudio-Task-Signature": signature
      },
      body: Buffer.from(bodyText).toString("base64")
    },
    dispatchDeadline: {
      seconds: 1800
    }
  };

  const [created] = await tasksClient.createTask({ parent, task });
  return created?.name || null;
}

async function getRenderJob(jobId) {
  if (!isUuid(jobId)) throw new Error("renderJobId inválido.");
  const rows = await supabaseRequest(
    `render_jobs?id=eq.${encodeURIComponent(jobId)}&select=*`
  );
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

async function signedReadUrl(objectPath, expiresMs = 60 * 60 * 1000) {
  const path = validateObjectPath(objectPath);
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) throw new Error("El archivo final todavía no existe.");
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + expiresMs
  });
  return url;
}

async function ensureSheetRecord({
  projectId,
  sheetNumber,
  widthCm,
  heightCm,
  layout
}) {
  if (!isUuid(projectId)) throw new Error("projectId debe ser un UUID válido.");

  const number = Math.max(1, Number(sheetNumber) || 1);
  const width = Number(widthCm);
  const height = Number(heightCm);

  validateSheet(width, height);

  if (!Array.isArray(layout)) {
    throw new Error("layout debe ser un arreglo JSON.");
  }

  const query =
    `sheets?project_id=eq.${encodeURIComponent(projectId)}` +
    `&sheet_number=eq.${encodeURIComponent(number)}` +
    `&select=*`;

  const existing = await supabaseRequest(query);
  const now = new Date().toISOString();

  if (Array.isArray(existing) && existing[0]?.id) {
    const rows = await supabaseRequest(
      `sheets?id=eq.${encodeURIComponent(existing[0].id)}&select=*`,
      {
        method: "PATCH",
        prefer: "return=representation",
        body: {
          width_cm: width,
          height_cm: height,
          layout,
          updated_at: now
        }
      }
    );

    return Array.isArray(rows) ? rows[0] : rows;
  }

  const rows = await supabaseRequest("sheets?select=*", {
    method: "POST",
    prefer: "return=representation",
    body: {
      project_id: projectId,
      sheet_number: number,
      width_cm: width,
      height_cm: height,
      layout
    }
  });

  return Array.isArray(rows) ? rows[0] : rows;
}

async function createRenderJob(projectId, sheetId) {
  const rows = await supabaseRequest("render_jobs?select=*", {
    method: "POST",
    prefer: "return=representation",
    body: {
      project_id: projectId,
      sheet_id: sheetId,
      status: "queued",
      attempts: 0
    }
  });

  return Array.isArray(rows) ? rows[0] : rows;
}

async function updateRenderJob(jobId, patch) {
  if (!jobId) return null;

  try {
    const rows = await supabaseRequest(
      `render_jobs?id=eq.${encodeURIComponent(jobId)}&select=*`,
      {
        method: "PATCH",
        prefer: "return=representation",
        body: patch
      }
    );
    return Array.isArray(rows) ? rows[0] : rows;
  } catch (error) {
    console.error("render_jobs update:", error);
    return null;
  }
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

app.post("/projects", async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res.status(503).json({
        ok: false,
        error: "Supabase no está configurado en Cloud Run."
      });
    }

    const totalWidthCmRaw = req.body?.totalWidthCm;
    const totalHeightCmRaw = req.body?.totalHeightCm;

    const totalWidthCm =
      totalWidthCmRaw === undefined || totalWidthCmRaw === null
        ? null
        : Number(totalWidthCmRaw);

    const totalHeightCm =
      totalHeightCmRaw === undefined || totalHeightCmRaw === null
        ? null
        : Number(totalHeightCmRaw);

    if (totalWidthCm !== null && !Number.isFinite(totalWidthCm)) {
      return res.status(400).json({
        ok: false,
        error: "totalWidthCm debe ser numérico."
      });
    }

    if (totalHeightCm !== null && !Number.isFinite(totalHeightCm)) {
      return res.status(400).json({
        ok: false,
        error: "totalHeightCm debe ser numérico."
      });
    }

    const payload = {
      status: "editing"
    };

    if (totalWidthCm !== null) payload.total_width_cm = totalWidthCm;
    if (totalHeightCm !== null) payload.total_height_cm = totalHeightCm;

    const response = await fetch(`${getSupabaseRestRoot()}projects`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });

    const text = await response.text();

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }

    if (!response.ok) {
      console.error("projects insert:", response.status, text);
      return res.status(502).json({
        ok: false,
        error: "No se pudo crear el proyecto en Supabase.",
        status: response.status,
        supabaseError:
          data?.message ||
          data?.error ||
          data?.hint ||
          (typeof data === "string" ? data : null)
      });
    }

    const row = Array.isArray(data) ? data[0] : data;

    if (!row?.id) {
      return res.status(502).json({
        ok: false,
        error: "Supabase creó el registro pero no devolvió el ID."
      });
    }

    res.json({
      ok: true,
      projectId: row.id,
      status: row.status || "editing",
      createdAt: row.created_at || null
    });
  } catch (error) {
    console.error("projects:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});


app.post("/upload-urls", async (req, res) => {
  try {
    const projectId = String(req.body?.projectId || "");
    const items = Array.isArray(req.body?.assets) ? req.body.assets : [];

    if (!isUuid(projectId)) {
      return res.status(400).json({
        ok: false,
        error: "projectId debe ser un UUID válido."
      });
    }

    if (!items.length || items.length > 50) {
      return res.status(400).json({
        ok: false,
        error: "assets debe contener entre 1 y 50 elementos."
      });
    }

    const prepared = items.map((item, index) => {
      const originalName = safeFilePart(item?.filename || `asset_${index + 1}.png`);
      const contentType = normalizeContentType(item?.contentType);
      const assetId = crypto.randomUUID();
      const objectPath =
        `projects/${projectId}/assets/originals/` +
        `${assetId}_${originalName}`;

      const finiteOrNull = value => {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      };

      return {
        clientId: item?.clientId || null,
        assetId,
        objectPath,
        originalName,
        contentType,
        widthPx: finiteOrNull(item?.widthPx),
        heightPx: finiteOrNull(item?.heightPx),
        dpiX: finiteOrNull(item?.dpiX),
        dpiY: finiteOrNull(item?.dpiY),
        fileSizeBytes: finiteOrNull(item?.fileSizeBytes)
      };
    });

    const expiresAt = Date.now() + 30 * 60 * 1000;

    const uploadUrls = await Promise.all(
      prepared.map(async item => {
        const [uploadUrl] = await bucket.file(item.objectPath).getSignedUrl({
          version: "v4",
          action: "write",
          expires: expiresAt,
          contentType: item.contentType
        });
        return uploadUrl;
      })
    );

    await supabaseRequest("assets", {
      method: "POST",
      prefer: "return=minimal",
      body: prepared.map(item => ({
        id: item.assetId,
        project_id: projectId,
        original_name: item.originalName,
        storage_path: item.objectPath,
        thumbnail_path: null,
        mime_type: item.contentType,
        width_px: item.widthPx,
        height_px: item.heightPx,
        dpi_x: item.dpiX,
        dpi_y: item.dpiY,
        file_size_bytes: item.fileSizeBytes,
        upload_status: "pending"
      }))
    });

    res.json({
      ok: true,
      projectId,
      expiresAt,
      assets: prepared.map((item, index) => ({
        clientId: item.clientId,
        assetId: item.assetId,
        objectPath: item.objectPath,
        storagePath: item.objectPath,
        contentType: item.contentType,
        uploadUrl: uploadUrls[index]
      }))
    });
  } catch (error) {
    console.error("upload-urls:", error);
    res.status(error?.status ? 502 : 500).json({
      ok: false,
      error: error?.message || String(error),
      supabaseStatus: error?.status || null
    });
  }
});

app.post("/assets-confirm", async (req, res) => {
  try {
    const objectPaths = Array.isArray(req.body?.objectPaths)
      ? [...new Set(req.body.objectPaths.map(String))]
      : [];

    if (!objectPaths.length || objectPaths.length > 100) {
      return res.status(400).json({
        ok: false,
        error: "objectPaths debe contener entre 1 y 100 rutas."
      });
    }

    const results = await Promise.all(
      objectPaths.map(async objectPath => {
        try {
          const path = validateObjectPath(objectPath);
          const file = bucket.file(path);
          const [exists] = await file.exists();
          if (!exists) return { objectPath: path, exists: false };

          const [metadata] = await file.getMetadata();
          const bytes = Number(metadata.size || 0);
          const contentType = metadata.contentType || null;

          try {
            await supabaseRequest(
              `assets?storage_path=eq.${encodeURIComponent(path)}`,
              {
                method: "PATCH",
                prefer: "return=minimal",
                body: {
                  upload_status: "uploaded",
                  file_size_bytes: bytes || null,
                  mime_type: contentType
                }
              }
            );
          } catch (dbError) {
            console.error("assets-confirm db:", dbError);
          }

          return {
            objectPath: path,
            exists: true,
            bytes,
            contentType
          };
        } catch (error) {
          return {
            objectPath,
            exists: false,
            error: error?.message || String(error)
          };
        }
      })
    );

    res.json({
      ok: true,
      confirmed: results.filter(x => x.exists).length,
      total: results.length,
      results
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

app.post("/upload-url", async (req, res) => {
  try {
    const projectId = String(req.body?.projectId || "");

    if (!isUuid(projectId)) {
      return res.status(400).json({
        ok: false,
        error: "projectId debe ser un UUID válido creado por /projects."
      });
    }

    const originalName = safeFilePart(
      req.body?.filename || "artwork.png"
    );

    const contentType = normalizeContentType(req.body?.contentType);
    const assetId = crypto.randomUUID();

    const objectPath =
      `projects/${projectId}/assets/originals/` +
      `${assetId}_${originalName}`;

    const widthPx =
      Number.isFinite(Number(req.body?.widthPx)) ? Number(req.body.widthPx) : null;
    const heightPx =
      Number.isFinite(Number(req.body?.heightPx)) ? Number(req.body.heightPx) : null;
    const dpiX =
      Number.isFinite(Number(req.body?.dpiX)) ? Number(req.body.dpiX) : null;
    const dpiY =
      Number.isFinite(Number(req.body?.dpiY)) ? Number(req.body.dpiY) : null;
    const fileSizeBytes =
      Number.isFinite(Number(req.body?.fileSizeBytes))
        ? Math.max(0, Math.round(Number(req.body.fileSizeBytes)))
        : null;

    const file = bucket.file(objectPath);
    const expiresAt = Date.now() + 15 * 60 * 1000;

    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType
    });

    await supabaseRequest("assets?select=*", {
      method: "POST",
      prefer: "return=representation",
      body: {
        id: assetId,
        project_id: projectId,
        original_name: originalName,
        storage_path: objectPath,
        thumbnail_path: null,
        mime_type: contentType,
        width_px: widthPx,
        height_px: heightPx,
        dpi_x: dpiX,
        dpi_y: dpiY,
        file_size_bytes: fileSizeBytes,
        upload_status: "pending"
      }
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
    res.status(error?.status === 403 ? 502 : 500).json({
      ok: false,
      error: error?.message || String(error),
      supabaseStatus: error?.status || null
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
    const bytes = Number(metadata.size || 0);
    const contentType = metadata.contentType || null;

    let asset = null;
    try {
      const rows = await supabaseRequest(
        `assets?storage_path=eq.${encodeURIComponent(objectPath)}&select=*`,
        {
          method: "PATCH",
          prefer: "return=representation",
          body: {
            upload_status: "uploaded",
            file_size_bytes: bytes || null,
            mime_type: contentType
          }
        }
      );
      asset = Array.isArray(rows) ? rows[0] : rows;
    } catch (error) {
      console.error("asset-status db update:", error);
    }

    res.json({
      ok: true,
      exists: true,
      objectPath,
      bytes,
      contentType,
      assetId: asset?.id || null,
      uploadStatus: asset?.upload_status || "uploaded"
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

app.post("/sheets", async (req, res) => {
  try {
    const projectId = String(req.body?.projectId || "");
    const sheetNumber = Math.max(1, Number(req.body?.sheetNumber) || 1);
    const widthCm = Number(req.body?.widthCm);
    const heightCm = Number(req.body?.heightCm);
    const layout = Array.isArray(req.body?.layout) ? req.body.layout : [];

    const sheet = await ensureSheetRecord({
      projectId,
      sheetNumber,
      widthCm,
      heightCm,
      layout
    });

    res.json({
      ok: true,
      projectId,
      sheetId: sheet?.id || null,
      sheetNumber: sheet?.sheet_number ?? sheetNumber,
      widthCm: Number(sheet?.width_cm ?? widthCm),
      heightCm: Number(sheet?.height_cm ?? heightCm),
      updatedAt: sheet?.updated_at || null
    });
  } catch (error) {
    console.error("sheets:", error);
    res.status(error?.status ? 502 : 400).json({
      ok: false,
      error: error?.message || String(error),
      supabaseStatus: error?.status || null
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


app.post("/render-queue", async (req, res) => {
  try {
    const projectId = String(req.body?.projectId || "");
    if (!isUuid(projectId)) {
      return res.status(400).json({
        ok: false,
        error: "projectId debe ser un UUID válido."
      });
    }

    const sheet = req.body?.sheet || {};
    const objects = Array.isArray(req.body?.objects) ? req.body.objects : [];
    const sheetNumber = Math.max(1, Number(sheet.sheetNumber) || 1);
    const widthCm = Number(sheet.widthCm);
    const heightCm = Number(sheet.heightCm);

    if (!objects.length) {
      return res.status(400).json({
        ok: false,
        error: "La hoja no contiene diseños."
      });
    }

    const sheetRow = await ensureSheetRecord({
      projectId,
      sheetNumber,
      widthCm,
      heightCm,
      layout: objects
    });

    if (!sheetRow?.id) {
      throw new Error("No se pudo crear/actualizar la hoja.");
    }

    const renderJob = await createRenderJob(projectId, sheetRow.id);
    if (!renderJob?.id) {
      throw new Error("No se pudo crear render_job.");
    }

    const taskPayload = {
      renderJobId: renderJob.id,
      projectId,
      sheetId: sheetRow.id,
      sheet: {
        ...sheet,
        sheetNumber,
        widthCm,
        heightCm
      },
      objects
    };

    let taskName = null;
    try {
      taskName = await enqueueRenderTask(taskPayload);
    } catch (queueError) {
      await updateRenderJob(renderJob.id, {
        status: "failed",
        error_message: `No se pudo encolar: ${queueError?.message || queueError}`,
        finished_at: new Date().toISOString()
      });
      throw queueError;
    }

    res.status(202).json({
      ok: true,
      queued: true,
      projectId,
      sheetId: sheetRow.id,
      renderJobId: renderJob.id,
      taskName,
      printFileUrl: `${PUBLIC_BASE_URL}/print-file/${renderJob.id}`
    });
  } catch (error) {
    console.error("render-queue:", error);
    res.status(error?.status ? 502 : 500).json({
      ok: false,
      error: error?.message || String(error),
      supabaseStatus: error?.status || null
    });
  }
});

app.post("/render-worker", async (req, res) => {
  const bodyText = JSON.stringify(req.body || {});
  const signature = req.get("X-BixStudio-Task-Signature");

  if (!verifyTaskSignature(bodyText, signature)) {
    return res.status(403).json({
      ok: false,
      error: "Firma de tarea inválida."
    });
  }

  const payload = req.body || {};
  const renderJobId = String(payload.renderJobId || "");

  if (!isUuid(renderJobId)) {
    return res.status(400).json({
      ok: false,
      error: "renderJobId inválido."
    });
  }

  try {
    await updateRenderJob(renderJobId, {
      status: "processing",
      attempts: 1,
      started_at: new Date().toISOString(),
      error_message: null
    });

    const rendered = await renderSheetToStorage({
      projectId: payload.projectId,
      sheet: payload.sheet,
      objects: Array.isArray(payload.objects) ? payload.objects : []
    });

    await updateRenderJob(renderJobId, {
      status: "completed",
      output_path: rendered.outputPath,
      error_message: null,
      finished_at: new Date().toISOString()
    });

    res.json({
      ok: true,
      renderJobId,
      outputPath: rendered.outputPath
    });
  } catch (error) {
    console.error("render-worker:", error);
    await updateRenderJob(renderJobId, {
      status: "failed",
      error_message: String(error?.message || error).slice(0, 2000),
      finished_at: new Date().toISOString()
    });

    res.status(500).json({
      ok: false,
      renderJobId,
      error: error?.message || String(error)
    });
  }
});

app.get("/render-job/:id", async (req, res) => {
  try {
    const job = await getRenderJob(req.params.id);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "Render job no encontrado."
      });
    }

    res.json({
      ok: true,
      renderJobId: job.id,
      status: job.status,
      attempts: job.attempts,
      outputPath: job.output_path,
      error: job.error_message,
      createdAt: job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      printFileUrl: `${PUBLIC_BASE_URL}/print-file/${job.id}`
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

app.get("/print-file/:id", async (req, res) => {
  try {
    const job = await getRenderJob(req.params.id);
    if (!job) {
      return res.status(404).type("html").send(
        "<!doctype html><meta charset='utf-8'><title>Archivo no encontrado</title><h2>Archivo no encontrado</h2>"
      );
    }

    if (job.status === "completed" && job.output_path) {
      const url = await signedReadUrl(job.output_path);
      return res.redirect(302, url);
    }

    const failed = job.status === "failed";
    const title = failed ? "No se pudo procesar el archivo" : "Tu archivo se está procesando";
    const detail = failed
      ? "El procesamiento encontró un error. BixPrint puede reintentar el trabajo desde el panel."
      : "El pedido ya fue recibido. El archivo de impresión se está generando y esta página se actualizará automáticamente.";

    const refresh = failed ? "" : "<meta http-equiv='refresh' content='5'>";

    return res.status(failed ? 500 : 202).type("html").send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh}
<title>${title}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f6f8;color:#111827;margin:0;display:grid;place-items:center;min-height:100vh}
.card{width:min(560px,calc(100% - 32px));background:white;border:1px solid #e5e7eb;border-radius:16px;padding:28px;box-shadow:0 12px 36px rgba(15,23,42,.08)}
h1{font-size:22px;margin:0 0 10px}p{color:#64748b;line-height:1.55}.status{display:inline-block;background:#f1f5f9;padding:7px 10px;border-radius:999px;font-size:13px;font-weight:700}
</style>
</head>
<body><div class="card">
<div class="status">${String(job.status || "queued")}</div>
<h1>${title}</h1>
<p>${detail}</p>
<p><small>ID: ${job.id}</small></p>
</div></body></html>`);
  } catch (error) {
    res.status(500).type("html").send(
      `<!doctype html><meta charset="utf-8"><title>Error</title><h2>Error</h2><p>${String(error?.message || error)}</p>`
    );
  }
});

app.post("/render-sheet", async (req, res) => {
  const started = Date.now();
  let renderJob = null;

  try {
    const projectId = String(req.body?.projectId || "");

    if (!isUuid(projectId)) {
      return res.status(400).json({
        ok: false,
        error: "projectId debe ser un UUID válido."
      });
    }

    const sheet = req.body?.sheet || {};
    const objects = Array.isArray(req.body?.objects)
      ? req.body.objects
      : [];

    const sheetNumber = Math.max(1, Number(sheet.sheetNumber) || 1);
    const widthCm = Number(sheet.widthCm);
    const heightCm = Number(sheet.heightCm);

    const sheetRow = await ensureSheetRecord({
      projectId,
      sheetNumber,
      widthCm,
      heightCm,
      layout: objects
    });

    if (!sheetRow?.id) {
      throw new Error("No se pudo obtener el sheet_id de Supabase.");
    }

    renderJob = await createRenderJob(projectId, sheetRow.id);

    await updateRenderJob(renderJob?.id, {
      status: "processing",
      attempts: Math.max(1, Number(renderJob?.attempts || 0) + 1),
      started_at: new Date().toISOString(),
      error_message: null
    });

    const rendered = await renderSheetToStorage({
      projectId,
      sheet: {
        ...sheet,
        sheetNumber,
        widthCm,
        heightCm
      },
      objects
    });

    await updateRenderJob(renderJob?.id, {
      status: "completed",
      output_path: rendered.outputPath,
      finished_at: new Date().toISOString(),
      error_message: null
    });

    res.json({
      ok: true,
      projectId,
      sheetId: sheetRow.id,
      renderJobId: renderJob?.id || null,
      ...rendered,
      renderMs: Date.now() - started
    });
  } catch (error) {
    console.error("render-sheet:", error);

    if (renderJob?.id) {
      await updateRenderJob(renderJob.id, {
        status: "failed",
        error_message: String(error?.message || error).slice(0, 2000),
        finished_at: new Date().toISOString()
      });
    }

    res.status(error?.status ? 502 : 400).json({
      ok: false,
      renderJobId: renderJob?.id || null,
      error: error?.message || String(error),
      supabaseStatus: error?.status || null
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
