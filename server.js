import express from "express";
import sharp from "sharp";

const app = express();

app.use(express.json({
  limit: "20mb"
}));

// ---------------------------------------------
// BIXSTUDIO RENDERER
// ---------------------------------------------

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "BixStudio Renderer",
    version: "1.0.0"
  });
});

// ---------------------------------------------
// PRUEBA DE GENERACIÓN 300 DPI
// ---------------------------------------------

app.post("/render-test", async (req, res) => {
  try {
    const widthCm = Number(req.body.widthCm ?? 62);
    const heightCm = Number(req.body.heightCm ?? 30);
    const dpi = 300;

    if (
      !Number.isFinite(widthCm) ||
      !Number.isFinite(heightCm) ||
      widthCm <= 0 ||
      heightCm <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "Dimensiones inválidas"
      });
    }

    if (widthCm > 62) {
      return res.status(400).json({
        ok: false,
        error: "El ancho máximo es 62 cm"
      });
    }

    if (heightCm > 310) {
      return res.status(400).json({
        ok: false,
        error: "El largo máximo es 310 cm"
      });
    }

    const pixelsPerCm = dpi / 2.54;
    const widthPx = Math.round(widthCm * pixelsPerCm);
    const heightPx = Math.round(heightCm * pixelsPerCm);

    console.log(`Generando ${widthCm} × ${heightCm} cm`);
    console.log(`${widthPx} × ${heightPx} px`);

    const png = await sharp({
      create: {
        width: widthPx,
        height: heightPx,
        channels: 4,
        background: {
          r: 0,
          g: 0,
          b: 0,
          alpha: 0
        }
      }
    })
      .png({
        compressionLevel: 6
      })
      .withMetadata({
        density: dpi
      })
      .toBuffer();

    console.log(`PNG generado: ${(png.length / 1024 / 1024).toFixed(2)} MB`);

    res.setHeader("Content-Type", "image/png");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="BixStudio_${widthCm}x${heightCm}cm_300dpi.png"`
    );
    res.setHeader("X-BixStudio-DPI", String(dpi));
    res.setHeader("X-BixStudio-Width-Px", String(widthPx));
    res.setHeader("X-BixStudio-Height-Px", String(heightPx));

    res.send(png);

  } catch (error) {
    console.error("Error renderizando:", error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ---------------------------------------------
// HEALTH CHECK
// ---------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    sharp: sharp.versions.sharp,
    node: process.version
  });
});

// ---------------------------------------------
// CLOUD RUN
// ---------------------------------------------

const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BixStudio Renderer iniciado en puerto ${PORT}`);
});

// Cloud Run deployment test
