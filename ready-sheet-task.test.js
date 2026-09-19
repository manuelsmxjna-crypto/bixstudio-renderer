import assert from "node:assert/strict";
import test from "node:test";
import { buildReadySheetHttpRequest } from "./ready-sheet-task.js";

const serviceAccountEmail = "renderer-test@example.iam.gserviceaccount.com";

test("Cloud Tasks signs in to the private test service with an OIDC token", () => {
  const request = buildReadySheetHttpRequest({
    baseUrl: "https://renderer-test.example.run.app",
    serviceAccountEmail,
    bodyText: '{"jobId":"123"}',
    signature: "abc"
  });
  assert.equal(request.url, "https://renderer-test.example.run.app/ready-sheets/worker");
  assert.deepEqual(request.oidcToken, {
    serviceAccountEmail,
    audience: "https://renderer-test.example.run.app"
  });
  assert.equal(Buffer.from(request.body, "base64").toString(), '{"jobId":"123"}');
  assert.equal(request.headers["X-BixStudio-Task-Signature"], "abc");
});

test("rejects unsafe or missing task configuration", () => {
  const base = { serviceAccountEmail, bodyText: "{}", signature: "abc" };
  assert.throws(() => buildReadySheetHttpRequest({ ...base, baseUrl: "http://localhost" }), /HTTPS/);
  assert.throws(() => buildReadySheetHttpRequest({ ...base, baseUrl: "https://example.com/other" }), /raíz/);
  assert.throws(() => buildReadySheetHttpRequest({ ...base, baseUrl: "https://example.com", serviceAccountEmail: "" }), /READY_SHEET_TASK_SERVICE_ACCOUNT/);
});
