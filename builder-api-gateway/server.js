import crypto from "node:crypto";
import express from "express";
import { GoogleAuth } from "google-auth-library";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const ROUTES = ["/projects", "/upload-urls", "/assets-confirm", "/download-url", "/secure-orders/drafts"];
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstileToken(token, secret, hostname, verifyFetch = fetch) {
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token });
  const response = await verifyFetch(TURNSTILE_VERIFY_URL, {
    method: "POST", body, signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Turnstile no respondió correctamente.");
  const result = await response.json();
  return result.success === true && result.hostname === hostname && result.action === "create_project";
}

function privateRendererOrigin(value) {
  const url = new URL(value || "https://invalid.example");
  if (url.protocol !== "https:" || !url.hostname.endsWith(".run.app") || url.pathname !== "/" || url.search || url.hash || url.username || url.password || url.port) {
    throw new Error("PRIVATE_RENDERER_URL debe ser una URL base HTTPS de Cloud Run.");
  }
  return url.origin;
}

function originalProjectId(path) {
  const value = String(path || "");
  const match = /^projects\/([0-9a-f-]{36})\/assets\/originals\/[^/]+$/i.exec(value);
  return match && UUID.test(match[1]) && !value.includes("..") ? match[1] : null;
}

function requestProjectId(route, body) {
  if (route === "/assets-confirm") {
    const paths = body?.objectPaths;
    if (!Array.isArray(paths) || !paths.length || paths.length > 100) return null;
    const ids = paths.map(originalProjectId);
    return ids.every(id => id && id === ids[0]) ? ids[0] : null;
  }
  if (route === "/download-url") return originalProjectId(body?.objectPath);
  return UUID.test(body?.projectId || "") ? body.projectId : null;
}

export function issueProjectToken(projectId, secret, now = Date.now()) {
  if (!UUID.test(projectId) || !secret) throw new Error("No se puede emitir el token de proyecto.");
  const payload = Buffer.from(JSON.stringify({ projectId, expiresAt: now + TOKEN_LIFETIME_MS })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyProjectToken(token, projectId, secret, now = Date.now()) {
  if (!UUID.test(projectId) || !secret || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const expected = crypto.createHmac("sha256", secret).update(parts[0]).digest();
  let received;
  try { received = Buffer.from(parts[1], "base64url"); } catch { return false; }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return data.projectId === projectId && Number.isFinite(data.expiresAt) && data.expiresAt > now && data.expiresAt <= now + TOKEN_LIFETIME_MS;
  } catch { return false; }
}

export function createGateway({ rendererUrl, tokenSecret, allowedOrigins, getIdToken, forwardFetch = fetch, now = Date.now, turnstileSecret, turnstileHostname, turnstileFetch = fetch }) {
  const audience = privateRendererOrigin(rendererUrl);
  if (!tokenSecret || tokenSecret.length < 32) throw new Error("BUILDER_GATEWAY_SECRET debe tener al menos 32 caracteres.");
  const origins = new Set(String(allowedOrigins || "").split(",").map(x => x.trim()).filter(Boolean));
  if (!origins.size || [...origins].some(origin => {
    try {
      const url = new URL(origin);
      return url.protocol !== "https:" || url.origin !== origin;
    } catch { return true; }
  })) throw new Error("BUILDER_ALLOWED_ORIGINS debe contener orígenes HTTPS exactos.");
  if (typeof getIdToken !== "function") throw new Error("Falta el proveedor de identidad.");
  if (turnstileSecret && (!turnstileHostname || !origins.has(`https://${turnstileHostname}`))) {
    throw new Error("TURNSTILE_HOSTNAME debe coincidir con un origen permitido.");
  }

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const origin = req.get("Origin");
    res.set("Vary", "Origin");
    if (origin && origins.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, X-BixStudio-Project-Token, X-BixStudio-Turnstile-Token");
      res.set("Access-Control-Max-Age", "3600");
    }
    if (req.method === "OPTIONS") return res.sendStatus(origin && origins.has(origin) ? 204 : 403);
    next();
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(express.json({ limit: "1mb" }));

  for (const route of ROUTES) app.post(route, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!origins.has(req.get("Origin"))) return res.status(403).json({ ok: false, error: "Origen no permitido." });
    if (!req.is("application/json") || !req.body || typeof req.body !== "object") return res.sendStatus(415);
    const projectId = route === "/projects" ? null : requestProjectId(route, req.body);
    if (route !== "/projects" && !projectId) return res.status(400).json({ ok: false, error: "Proyecto o ruta inválidos." });
    if (projectId && !verifyProjectToken(req.get("X-BixStudio-Project-Token"), projectId, tokenSecret, now())) {
      return res.status(403).json({ ok: false, error: "Token de proyecto inválido o vencido." });
    }
    if (route === "/projects" && turnstileSecret) {
      try {
        const valid = await verifyTurnstileToken(req.get("X-BixStudio-Turnstile-Token"), turnstileSecret, turnstileHostname, turnstileFetch);
        if (!valid) return res.status(403).json({ ok: false, error: "Verificación de seguridad inválida o vencida." });
      } catch (error) {
        console.error("Turnstile verification failed:", error.message);
        return res.status(503).json({ ok: false, error: "No se pudo verificar el acceso." });
      }
    }
    try {
      const token = await getIdToken(audience);
      const upstream = await forwardFetch(`${audience}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(30000)
      });
      const data = await upstream.json();
      if (route === "/projects" && upstream.ok) {
        if (!data?.ok || !UUID.test(data.projectId || "")) return res.status(502).json({ ok: false, error: "El renderer no creó el proyecto." });
        const issuedAt = now();
        data.projectToken = issueProjectToken(data.projectId, tokenSecret, issuedAt);
        data.projectTokenExpiresAt = issuedAt + TOKEN_LIFETIME_MS;
      }
      return res.status(upstream.status).json(data);
    } catch (error) {
      console.error("Builder gateway forwarding failed:", error.message);
      return res.status(503).json({ ok: false, error: "No se pudo conectar con el renderer privado." });
    }
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.BUILDER_REQUIRE_TURNSTILE === "true" && (!process.env.BUILDER_TURNSTILE_SECRET || !process.env.BUILDER_TURNSTILE_HOSTNAME)) {
    throw new Error("El gateway público requiere BUILDER_TURNSTILE_SECRET y BUILDER_TURNSTILE_HOSTNAME.");
  }
  const auth = new GoogleAuth();
  const app = createGateway({
    rendererUrl: process.env.PRIVATE_RENDERER_URL,
    tokenSecret: process.env.BUILDER_GATEWAY_SECRET,
    allowedOrigins: process.env.BUILDER_ALLOWED_ORIGINS,
    turnstileSecret: process.env.BUILDER_TURNSTILE_SECRET,
    turnstileHostname: process.env.BUILDER_TURNSTILE_HOSTNAME,
    getIdToken: async audience => {
      const client = await auth.getIdTokenClient(audience);
      return client.idTokenProvider.fetchIdToken(audience);
    }
  });
  app.listen(Number(process.env.PORT) || 8080, "0.0.0.0");
}
