import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { analyzeReadySheetFile, makeReadySheetPreview } from "./ready-sheet.js";

async function withImage(buffer, run) {
  const dir = await mkdtemp(join(tmpdir(), "bix-ready-test-"));
  const path = join(dir, "image.png");
  try {
    await writeFile(path, buffer);
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("counts binary and partial alpha and reports content bounds", async () => {
  const pixels = Buffer.alloc(4 * 4 * 4);
  const set = (x, y, alpha) => {
    const i = (y * 4 + x) * 4;
    pixels[i] = 200;
    pixels[i + 1] = 100;
    pixels[i + 2] = 50;
    pixels[i + 3] = alpha;
  };
  set(1, 1, 255);
  set(2, 1, 128);
  set(1, 2, 255);
  const png = await sharp(pixels, { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer();
  await withImage(png, async path => {
    const result = await analyzeReadySheetFile(path);
    assert.equal(result.transparentPixels, 13);
    assert.equal(result.semiTransparentPixels, 1);
    assert.equal(result.opaquePixels, 2);
    assert.deepEqual(result.contentBounds, { x: 1, y: 1, width: 2, height: 2 });
    assert.equal(result.hasTransparentMargins, true);
    const preview = await makeReadySheetPreview(path, { maxSide: 2 });
    const meta = await sharp(preview).metadata();
    assert.equal(meta.width, 2);
    assert.equal(meta.height, 2);
  });
});

test("opaque images skip alpha scan and retain full bounds", async () => {
  const png = await sharp({
    create: { width: 5, height: 3, channels: 3, background: "red" }
  }).png().toBuffer();
  await withImage(png, async path => {
    const result = await analyzeReadySheetFile(path);
    assert.equal(result.hasAlpha, false);
    assert.equal(result.semiTransparentPixels, 0);
    assert.equal(result.opaquePixels, 15);
    assert.deepEqual(result.contentBounds, { x: 0, y: 0, width: 5, height: 3 });
    assert.equal(result.hasTransparentMargins, false);
  });
});

test("rejects images above the configured pixel limit", async () => {
  const png = await sharp({
    create: { width: 5, height: 3, channels: 3, background: "red" }
  }).png().toBuffer();
  await withImage(png, async path => {
    await assert.rejects(analyzeReadySheetFile(path, { maxPixels: 10 }), { status: 413 });
  });
});
