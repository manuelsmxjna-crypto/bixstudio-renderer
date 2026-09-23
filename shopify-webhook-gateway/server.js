import express from "express";
import crypto from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { pathToFileURL } from "node:url";

const TARGET_PATH = "/secure-orders/shopify-paid";

function verifiedHmac(rawBody, received, secret) {
  if (!Buffer.isBuffer(rawBody) || !secret || typeof received !== "string") return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(rawBody).digest("base64"));
  const actual = Buffer.from(received);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createGateway({ shopDomain, secret, rendererUrl, getIdToken, forwardFetch = fetch }) {
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shopDomain || "")) throw new Error("SHOPIFY_SHOP_DOMAIN inválido.");
  if (!secret) throw new Error("Falta SHOPIFY_WEBHOOK_SECRET.");
  const parsed = new URL(rendererUrl || "https://invalid.example");
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".run.app") || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) {
    throw new Error("PRIVATE_RENDERER_URL debe ser la URL base HTTPS de Cloud Run.");
  }
  if (typeof getIdToken !== "function") throw new Error("Falta el proveedor de identidad.");
  const audience = parsed.origin;
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.post("/webhooks/orders-paid", express.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
    if (!verifiedHmac(req.body, req.get("X-Shopify-Hmac-Sha256"), secret)) return res.sendStatus(401);
    if (req.get("X-Shopify-Topic") !== "orders/paid" || req.get("X-Shopify-Shop-Domain") !== shopDomain) return res.sendStatus(403);
    if (!/^[0-9a-f-]{36}$/i.test(req.get("X-Shopify-Webhook-Id") || "")) return res.sendStatus(400);
    try {
      const token = await getIdToken(audience);
      const upstream = await forwardFetch(`${audience}${TARGET_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Shopify-Hmac-Sha256": req.get("X-Shopify-Hmac-Sha256"),
          "X-Shopify-Topic": req.get("X-Shopify-Topic"),
          "X-Shopify-Shop-Domain": req.get("X-Shopify-Shop-Domain"),
          "X-Shopify-Webhook-Id": req.get("X-Shopify-Webhook-Id")
        },
        body: req.body,
        signal: AbortSignal.timeout(15000)
      });
      // Shopify retries non-2xx deliveries; the private renderer deduplicates them.
      if (!upstream.ok) {
        console.error("Private renderer rejected Shopify webhook:", upstream.status);
        return res.sendStatus(upstream.status >= 500 ? 503 : upstream.status);
      }
      return res.sendStatus(upstream.status === 202 ? 202 : 200);
    } catch (error) {
      console.error("Shopify webhook forwarding failed:", error.message);
      return res.sendStatus(503);
    }
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const auth = new GoogleAuth();
  const app = createGateway({
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
    secret: process.env.SHOPIFY_WEBHOOK_SECRET,
    rendererUrl: process.env.PRIVATE_RENDERER_URL,
    getIdToken: async audience => {
      const client = await auth.getIdTokenClient(audience);
      return client.idTokenProvider.fetchIdToken(audience);
    }
  });
  app.listen(Number(process.env.PORT) || 8080, "0.0.0.0");
}
