import test from "node:test";
import assert from "node:assert/strict";
import { createGateway, issueProjectToken, verifyProjectToken } from "./server.js";

const projectId = "d1e9189a-1acf-4c13-9fc7-844c4140479b";
const otherProjectId = "208dad8b-c3cf-40e1-9b61-503d7f511c94";
const origin = "https://bixstudio-builder.pages.dev";
const secret = "a-private-test-secret-with-at-least-32-characters";

async function withGateway(run) {
  const forwarded = [];
  const app = createGateway({
    rendererUrl: "https://bixstudio-renderer-test-318403647962.us-central1.run.app",
    tokenSecret: secret,
    allowedOrigins: origin,
    getIdToken: async () => "google-id-token",
    forwardFetch: async (url, options) => {
      forwarded.push({ url, options });
      return Response.json(url.endsWith("/projects") ? { ok: true, projectId } : { ok: true, accepted: true });
    }
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    await run(`http://127.0.0.1:${server.address().port}`, forwarded);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function post(url, path, body, token, requestOrigin = origin) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      Origin: requestOrigin,
      "Content-Type": "application/json",
      ...(token ? { "X-BixStudio-Project-Token": token } : {})
    },
    body: JSON.stringify(body)
  });
}

test("project token is scoped to one project and expires", () => {
  const token = issueProjectToken(projectId, secret, 1000);
  assert.equal(verifyProjectToken(token, projectId, secret, 1000), true);
  assert.equal(verifyProjectToken(token, otherProjectId, secret, 1000), false);
  assert.equal(verifyProjectToken(token, projectId, secret, 31 * 24 * 60 * 60 * 1000), false);
  assert.equal(verifyProjectToken(`${token}x`, projectId, secret, 1000), false);
});

test("only approved origin and paths reach the private renderer", async () => {
  await withGateway(async (url, forwarded) => {
    assert.equal((await post(url, "/projects", {}, null, "https://attacker.example")).status, 403);
    assert.equal((await post(url, "/render-queue", { projectId }, null)).status, 404);
    const response = await post(url, "/projects", { totalWidthCm: 62 });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    const data = await response.json();
    assert.equal(verifyProjectToken(data.projectToken, projectId, secret), true);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].options.headers.Authorization, "Bearer google-id-token");
  });
});

test("asset and draft calls require the matching project token", async () => {
  await withGateway(async (url, forwarded) => {
    const token = issueProjectToken(projectId, secret);
    assert.equal((await post(url, "/upload-urls", { projectId, assets: [] })).status, 403);
    assert.equal((await post(url, "/upload-urls", { projectId, assets: [] }, token)).status, 200);
    assert.equal((await post(url, "/secure-orders/drafts", { projectId }, token)).status, 200);
    assert.equal((await post(url, "/download-url", { objectPath: `projects/${otherProjectId}/assets/originals/file.png` }, token)).status, 403);
    assert.equal((await post(url, "/download-url", { objectPath: "gallery/originals/secret.png" }, token)).status, 400);
    assert.equal((await post(url, "/assets-confirm", { objectPaths: [`projects/${projectId}/assets/originals/a.png`, `projects/${otherProjectId}/assets/originals/b.png`] }, token)).status, 400);
    assert.equal(forwarded.length, 2);
  });
});

test("CORS preflight only approves configured origin", async () => {
  await withGateway(async url => {
    const approved = await fetch(`${url}/upload-urls`, { method: "OPTIONS", headers: { Origin: origin } });
    assert.equal(approved.status, 204);
    assert.match(approved.headers.get("access-control-allow-headers"), /X-BixStudio-Project-Token/);
    const denied = await fetch(`${url}/upload-urls`, { method: "OPTIONS", headers: { Origin: "https://attacker.example" } });
    assert.equal(denied.status, 403);
  });
});
