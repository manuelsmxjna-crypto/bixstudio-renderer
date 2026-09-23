import crypto from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function verifyShopifyWebhook(rawBody, received, secret) {
  if (!Buffer.isBuffer(rawBody) || !secret || typeof received !== "string") return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const actual = Buffer.from(received, "utf8");
  const calculated = Buffer.from(expected, "utf8");
  return actual.length === calculated.length && crypto.timingSafeEqual(actual, calculated);
}

export function readPaidDrafts(order, variantId) {
  if (!order || order.financial_status !== "paid") return [];
  const target = String(variantId);
  if (!/^\d+$/.test(target)) throw new Error("SHOPIFY_DTF_VARIANT_ID no está configurado.");
  const entries = [];
  const seen = new Set();
  for (const line of order.line_items || []) {
    if (String(line.variant_id) !== target) continue;
    const property = (line.properties || []).find(item => item.name === "_BixStudio Draft IDs");
    if (!property?.value) continue;
    const ids = String(property.value).split(",").map(id => id.trim()).filter(Boolean);
    if (!ids.length || ids.some(id => !UUID.test(id) || seen.has(id)) || new Set(ids).size !== ids.length) {
      throw new Error("Las referencias del pedido no son válidas.");
    }
    ids.forEach(id => seen.add(id));
    entries.push({ ids, quantity: Number(line.quantity) });
  }
  return entries;
}

export function validateSecureSheet(sheet, objects, projectId) {
  if (!UUID.test(projectId)) throw new Error("Proyecto inválido.");
  const width = Number(sheet?.widthCm), height = Number(sheet?.heightCm);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || width > 62.001 || height <= 0 || height > 310.001) {
    throw new Error("Medidas de hoja inválidas.");
  }
  if (!Array.isArray(objects) || !objects.length || objects.length > 500) throw new Error("La hoja no contiene una composición válida.");
  for (const object of objects) {
    const box = [object.x, object.y, object.width, object.height].map(Number);
    if (!box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) throw new Error("Hay un diseño con medidas inválidas.");
    const gallery = typeof object.galleryId === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(object.galleryId);
    const uploaded = typeof object.storagePath === "string" && object.storagePath.startsWith(`projects/${projectId}/assets/originals/`) && !object.storagePath.includes("..");
    if (gallery === uploaded) throw new Error("Cada diseño debe tener exactamente una fuente válida.");
  }
  return Math.max(1, Math.ceil(height - 1e-9));
}
