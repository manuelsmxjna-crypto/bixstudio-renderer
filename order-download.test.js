import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { extractOrderRenderLinks, productionFilename, verifyShopifyWebhook } from "./order-download.js";

test("accepts only a valid Shopify HMAC over the raw body", () => {
  const body = Buffer.from('{"id":99}');
  const signature = crypto.createHmac("sha256", "secret").update(body).digest("base64");
  assert.equal(verifyShopifyWebhook(body, signature, "secret"), true);
  assert.equal(verifyShopifyWebhook(body, signature, "wrong"), false);
  assert.equal(verifyShopifyWebhook(Buffer.from('{"id":100}'), signature, "secret"), false);
});

test("extracts billing name and hidden gang sheet ids", () => {
  const links = extractOrderRenderLinks({ id: 99, order_number: 1048,
    billing_address: { first_name: "Juan", last_name: "Pérez López" },
    line_items: [{ properties: [
      { name: "_Gang Sheet 1 ID", value: "ce4cdcb9-7c9b-430d-b7c2-a9b2b55b86bb" },
      { name: "_Gang Sheet 2 ID", value: "05f79988-31dc-40f1-a957-3c849c4dcec5" }
    ] }] });
  assert.equal(links.length, 2);
  assert.equal(links[0].firstName, "Juan");
  assert.equal(links[0].lastName, "Pérez López");
  assert.equal(productionFilename(links[0], { widthCm: "62", heightCm: "114.4" }),
    "Pedido_1048_Juan_Perez_Lopez_Hoja_1_62x114.4cm_300dpi.png");
});

test("uses Cliente when billing name is unavailable", () => {
  assert.equal(productionFilename({ orderNumber: "#5", sheetNumber: 2 }),
    "Pedido_5_Cliente_Hoja_2_300dpi.png");
});
