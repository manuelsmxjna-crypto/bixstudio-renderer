import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createGateway } from "./server.js";

const secret = "test-only-secret";
const shopDomain = "whgcmj-0q.myshopify.com";
const rendererUrl = "https://bixstudio-renderer-test-318403647962.us-central1.run.app";
const eventId = "11111111-1111-4111-8111-111111111111";

async function withServer(app, fn) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function signedHeaders(body, overrides = {}) {
  return {
    "Content-Type": "application/json",
    "X-Shopify-Hmac-Sha256": crypto.createHmac("sha256", secret).update(body).digest("base64"),
    "X-Shopify-Topic": "orders/paid",
    "X-Shopify-Shop-Domain": shopDomain,
    "X-Shopify-Webhook-Id": eventId,
    ...overrides
  };
}

test("invalid signatures never reach the private renderer", async () => {
  let forwarded = false;
  const app = createGateway({ shopDomain, secret, rendererUrl, getIdToken: async () => "token", forwardFetch: async () => { forwarded = true; } });
  await withServer(app, async url => {
    const response = await fetch(`${url}/webhooks/orders-paid`, { method: "POST", headers: signedHeaders("{}", { "X-Shopify-Hmac-Sha256": "wrong" }), body: "{}" });
    assert.equal(response.status, 401);
  });
  assert.equal(forwarded, false);
});

test("valid Shopify delivery is forwarded byte-for-byte with Google identity", async () => {
  const body = Buffer.from('{"id":123,"financial_status":"paid"}');
  let forwarded;
  const app = createGateway({ shopDomain, secret, rendererUrl, getIdToken: async audience => {
    assert.equal(audience, rendererUrl);
    return "test-id-token";
  }, forwardFetch: async (url, options) => {
    forwarded = { url, options };
    return { ok: true, status: 202 };
  } });
  await withServer(app, async url => {
    const response = await fetch(`${url}/webhooks/orders-paid`, { method: "POST", headers: signedHeaders(body), body });
    assert.equal(response.status, 202);
  });
  assert.equal(forwarded.url, `${rendererUrl}/secure-orders/shopify-paid`);
  assert.equal(forwarded.options.headers.Authorization, "Bearer test-id-token");
  assert.deepEqual(forwarded.options.body, body);
});

test("unexpected shop is rejected after authenticating the signature", async () => {
  const app = createGateway({ shopDomain, secret, rendererUrl, getIdToken: async () => "token" });
  await withServer(app, async url => {
    const response = await fetch(`${url}/webhooks/orders-paid`, { method: "POST", headers: signedHeaders("{}", { "X-Shopify-Shop-Domain": "another.myshopify.com" }), body: "{}" });
    assert.equal(response.status, 403);
  });
});
