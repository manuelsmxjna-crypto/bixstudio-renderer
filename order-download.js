import crypto from "node:crypto";

export const ORDER_LINK_PREFIX = "shopify-order-links/render-jobs";

export function orderLinkPath(renderJobId) {
  return `${ORDER_LINK_PREFIX}/${renderJobId}.json`;
}

export function verifyShopifyWebhook(rawBody, signature, secret) {
  if (!secret || !rawBody) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function safeFilenamePart(value, fallback = "Cliente") {
  const cleaned = String(value || "").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, 70);
  return cleaned || fallback;
}

function propertyEntries(properties) {
  if (Array.isArray(properties)) return properties.map(item => [String(item?.name || ""), item?.value]);
  if (properties && typeof properties === "object") return Object.entries(properties);
  return [];
}

export function extractOrderRenderLinks(order) {
  const billing = order?.billing_address || {};
  const firstName = String(billing.first_name || "").trim();
  const lastName = String(billing.last_name || "").trim();
  const orderNumber = String(order?.order_number || order?.name || order?.id || "Pedido").replace(/^#/, "").trim();
  const links = [];
  for (const item of Array.isArray(order?.line_items) ? order.line_items : []) {
    for (const [name, value] of propertyEntries(item?.properties)) {
      const match = /^_Gang Sheet (\d+) ID$/.exec(name);
      const renderJobId = String(value || "").trim();
      if (!match || !/^[0-9a-f-]{36}$/i.test(renderJobId)) continue;
      links.push({ renderJobId, orderId: String(order?.id || ""), orderNumber,
        firstName, lastName, sheetNumber: links.length + 1 });
    }
  }
  return links;
}

export function productionFilename(link, metadata = {}) {
  const order = safeFilenamePart(link?.orderNumber, "Pedido");
  const first = safeFilenamePart(link?.firstName, "");
  const last = safeFilenamePart(link?.lastName, "");
  const customer = [first, last].filter(Boolean).join("_") || "Cliente";
  const sheet = Math.max(1, Number(link?.sheetNumber) || 1);
  const width = String(metadata?.widthCm || "62").replace(/[^0-9.]+/g, "") || "62";
  const height = String(metadata?.heightCm || "").replace(/[^0-9.]+/g, "");
  const size = height ? `_${width}x${height}cm` : "";
  return `Pedido_${order}_${customer}_Hoja_${sheet}${size}_300dpi.png`;
}
