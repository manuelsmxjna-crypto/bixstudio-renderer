import { randomFillSync } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

// A reproducible layout with incompressible colors: exercises upload size as
// well as decoding/alpha scanning without using any customer artwork.
const args = process.argv.slice(2);
const quick = args.includes("--quick");
const outputPath = args.find(arg => arg !== "--quick") || "ready-sheet-heavy-test.png";
const scale = quick ? 0.01 : 1;
const n = value => Math.max(1, Math.round(value * scale));
const width = n(7323);
const height = n(11811);
const opaque = { x: n(200), y: n(500), width: n(3800), height: n(3800) };
const partial = { x: n(3000), y: n(7000), width: n(1200), height: n(1200) };

const png = sharp({ raw: { width, height, channels: 4 } })
  .png({ compressionLevel: 1 })
  .withMetadata({ density: 300 });
const writing = pipeline(png, createWriteStream(outputPath));
const colors = Buffer.allocUnsafe(opaque.width * 3);

for (let y = 0; y < height; y++) {
  const row = Buffer.alloc(width * 4); // Transparent outside the two test bands.
  const band = y >= opaque.y && y < opaque.y + opaque.height ? opaque
    : y >= partial.y && y < partial.y + partial.height ? partial : null;
  if (band) {
    randomFillSync(colors, 0, band.width * 3);
    for (let x = 0; x < band.width; x++) {
      const src = x * 3;
      const dst = (band.x + x) * 4;
      row[dst] = colors[src];
      row[dst + 1] = colors[src + 1];
      row[dst + 2] = colors[src + 2];
      row[dst + 3] = band === opaque ? 255 : 128;
    }
  }
  if (!png.write(row)) await once(png, "drain");
}
png.end();
await writing;
const { size } = await stat(outputPath);
console.log(JSON.stringify({ file: outputPath, width, height, bytes: size,
  opaquePixels: opaque.width * opaque.height,
  semiTransparentPixels: partial.width * partial.height }));
