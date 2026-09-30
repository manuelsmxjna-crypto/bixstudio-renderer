import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAlphaCleanup, thresholdRgbaAlpha } from "./alpha-cleanup.js";

test("normalizes the requested per-object alpha cleanup", () => {
  assert.deepEqual(normalizeAlphaCleanup({ alphaCleanup: true, alphaThreshold: 18 }), {
    enabled: true,
    threshold: 18
  });
  assert.equal(normalizeAlphaCleanup({ alphaCleanup: true, alphaThreshold: 999 }).threshold, 254);
  assert.equal(normalizeAlphaCleanup({}).enabled, false);
});

test("thresholds only semi-transparent alpha values", () => {
  const rgba = Uint8Array.from([
    1, 2, 3, 0,
    1, 2, 3, 17,
    1, 2, 3, 18,
    1, 2, 3, 254,
    1, 2, 3, 255
  ]);
  thresholdRgbaAlpha(rgba, 18);
  assert.deepEqual([...rgba.filter((_, index) => index % 4 === 3)], [0, 0, 255, 255, 255]);
});
