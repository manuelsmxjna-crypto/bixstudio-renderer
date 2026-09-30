export function normalizeAlphaCleanup(object) {
  return {
    enabled: object?.alphaCleanup === true,
    threshold: Number.isFinite(Number(object?.alphaThreshold))
      ? Math.max(1, Math.min(254, Math.round(Number(object.alphaThreshold))))
      : 128
  };
}

export function thresholdRgbaAlpha(data, threshold = 128) {
  const limit = Math.max(1, Math.min(254, Math.round(Number(threshold) || 128)));
  for (let index = 3; index < data.length; index += 4) {
    const alpha = data[index];
    if (alpha > 0 && alpha < 255) data[index] = alpha < limit ? 0 : 255;
  }
  return data;
}
