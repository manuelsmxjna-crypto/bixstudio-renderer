import sharp from "sharp";

export const READY_SHEET_MAX_PIXELS = 350_000_000;
// Cloud Run's default writable file system uses instance memory. Keep this
// proof-of-concept limit conservative until an ephemeral disk is configured.
export const READY_SHEET_MAX_BYTES = 128 * 1024 * 1024;

/** Analyze a local image without materializing the entire decoded bitmap. */
export async function analyzeReadySheetFile(path, { maxPixels = READY_SHEET_MAX_PIXELS } = {}) {
  const metadata = await sharp(path, { limitInputPixels: false, failOn: "error" }).metadata();
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || width < 1 || height < 1 || pixels > maxPixels) {
    const error = new Error(`La imagen supera el límite experimental de ${maxPixels.toLocaleString("es-MX")} píxeles.`);
    error.status = 413;
    throw error;
  }
  if (metadata.pages && metadata.pages !== 1) {
    const error = new Error("Por ahora se admite una sola página por archivo.");
    error.status = 400;
    throw error;
  }

  let transparentPixels = 0;
  let semiTransparentPixels = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;

  // Images without alpha are entirely opaque. This also avoids unnecessary
  // decoding for large JPEGs and flat TIFFs.
  if (!metadata.hasAlpha) {
    minX = minY = 0;
    maxX = width - 1;
    maxY = height - 1;
  } else {
    const image = sharp(path, { limitInputPixels: false, failOn: "error" })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw();
    let consumedBytes = 0;
    let remainder = Buffer.alloc(0);
    for await (const nextChunk of image) {
      const chunk = remainder.length ? Buffer.concat([remainder, nextChunk]) : nextChunk;
      const completeBytes = chunk.length - (chunk.length % 4);
      for (let i = 0; i < completeBytes; i += 4) {
        const pixelIndex = (consumedBytes + i) / 4;
        const alpha = chunk[i + 3];
        if (alpha === 0) {
          transparentPixels++;
          continue;
        }
        if (alpha < 255) semiTransparentPixels++;
        const x = pixelIndex % width;
        const y = Math.floor(pixelIndex / width);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      consumedBytes += completeBytes;
      remainder = chunk.subarray(completeBytes);
    }
    if (remainder.length || consumedBytes !== pixels * 4) {
      throw new Error("La decodificación no produjo RGBA completo.");
    }
  }

  const contentBounds = maxX < 0 ? null : {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
  return {
    widthPx: width,
    heightPx: height,
    format: metadata.format,
    densityDpi: Number.isFinite(metadata.density) ? metadata.density : null,
    hasAlpha: !!metadata.hasAlpha,
    transparentPixels,
    semiTransparentPixels,
    opaquePixels: pixels - transparentPixels - semiTransparentPixels,
    contentBounds,
    hasTransparentMargins: !!contentBounds && (
      minX > 0 || minY > 0 || maxX < width - 1 || maxY < height - 1
    )
  };
}

/** A bounded preview; no full-resolution RGBA output is created. */
export async function makeReadySheetPreview(path, { maxSide = 1200 } = {}) {
  return sharp(path, { limitInputPixels: false, failOn: "error" })
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 6 })
    .toBuffer();
}
