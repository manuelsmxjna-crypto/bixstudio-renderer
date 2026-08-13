import express from "express";
import multer from "multer";
import sharp from "sharp";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 250 * 1024 * 1024
  }
});

app.use(express.json({ limit: "20mb" }));

const DPI = 300;
const PX_PER_CM = DPI / 2.54;

function cmToPx(cm) {
  return Math.round(Number(cm) * PX_PER_CM);
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

  if (widthCm > 62) {
    throw new Error("El ancho máximo es 62 cm");
  }

  if (heightCm > 310) {
    throw new Error("El largo máximo es 310 cm");
  }
}

// --------------------------------------------------
// STATUS
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "BixStudio Renderer",
    version: "1.1.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    sharp: sharp.versions.sharp,
    node: process.version
  });
});

// --------------------------------------------------
// TEST: EMPTY 300 DPI SHEET
// --------------------------------------------------

app.post("/render-test", async (req, res) => {
  try {
    const widthCm = Number(req.body.widthCm ?? 62);
    const heightCm = Number(req.body.heightCm ?? 30);

    validateSheet(widthCm, heightCm);

    const widthPx = cmToPx(widthCm);
    const heightPx = cmToPx(heightCm);

    const png = await sharp({
      create: {
        width: widthPx,
        height: heightPx,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .png({ compressionLevel: 6 })
      .withMetadata({ density: DPI })
      .toBuffer();

    res.type("png");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="BixStudio_${widthCm}x${heightCm}cm_300dpi.png"`
    );
    res.send(png);
  } catch (error) {
    console.error(error);
    res.status(400).json({
      ok: false,
      error: error.message
    });
  }
});

// --------------------------------------------------
// TEST: ONE REAL IMAGE
//
// multipart/form-data fields:
// file      -> PNG/JPG/WEBP
// sheetW    -> cm
// sheetH    -> cm
// x         -> cm
// y         -> cm
// width     -> cm
// height    -> cm
// rotation  -> degrees
// --------------------------------------------------

app.post("/render-one", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Falta el archivo"
      });
    }

    const sheetW = Number(req.body.sheetW ?? 62);
    const sheetH = Number(req.body.sheetH ?? 30);

    const xCm = Number(req.body.x ?? 0);
    const yCm = Number(req.body.y ?? 0);
    const widthCm = Number(req.body.width ?? 20);
    const heightCm = Number(req.body.height ?? 20);
    const rotation = Number(req.body.rotation ?? 0);

    validateSheet(sheetW, sheetH);

    if (
      !Number.isFinite(xCm) ||
      !Number.isFinite(yCm) ||
      !Number.isFinite(widthCm) ||
      !Number.isFinite(heightCm) ||
      widthCm <= 0 ||
      heightCm <= 0
    ) {
      throw new Error("Datos del diseño inválidos");
    }

    const sheetWidthPx = cmToPx(sheetW);
    const sheetHeightPx = cmToPx(sheetH);

    const targetW = Math.max(1, cmToPx(widthCm));
    const targetH = Math.max(1, cmToPx(heightCm));

    let design = sharp(req.file.buffer)
      .resize(targetW, targetH, {
        fit: "fill"
      });

    if (rotation) {
      design = design.rotate(rotation, {
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      });
    }

    const designPng = await design
      .png()
      .toBuffer();

    const designMeta = await sharp(designPng).metadata();

    // x/y represent the top-left of the unrotated object's visual box.
    // For this first test we simply place the final rotated bitmap at x/y.
    const left = cmToPx(xCm);
    const top = cmToPx(yCm);

    if (
      left < 0 ||
      top < 0 ||
      left + Number(designMeta.width || 0) > sheetWidthPx ||
      top + Number(designMeta.height || 0) > sheetHeightPx
    ) {
      throw new Error("El diseño queda fuera de la hoja");
    }

    const output = await sharp({
      create: {
        width: sheetWidthPx,
        height: sheetHeightPx,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([
        {
          input: designPng,
          left,
          top
        }
      ])
      .png({ compressionLevel: 6 })
      .withMetadata({ density: DPI })
      .toBuffer();

    res.type("png");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="BixStudio_render_one_${sheetW}x${sheetH}cm_300dpi.png"`
    );
    res.send(output);

  } catch (error) {
    console.error("render-one:", error);

    res.status(400).json({
      ok: false,
      error: error.message
    });
  }
});

const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BixStudio Renderer iniciado en puerto ${PORT}`);
});
