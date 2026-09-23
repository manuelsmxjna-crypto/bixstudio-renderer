import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROJECT_UPLOAD_BYTES, MAX_PROJECT_UPLOAD_FILES, MAX_PROJECT_DRAFTS,
  reserveSecureProjectQuota, SecureQuotaError
} from "./secure-quota.js";

function fakeDb() {
  const documents = new Map();
  return {
    collection(name) {
      assert.equal(name, "secureProjectQuotas");
      return { doc: id => ({ id }) };
    },
    async runTransaction(callback) {
      return callback({
        get: async ref => ({ exists: documents.has(ref.id), data: () => documents.get(ref.id) }),
        set: (ref, data) => documents.set(ref.id, data)
      });
    },
    documents
  };
}

test("secure quota caps cumulative files and bytes per project", async () => {
  const db = fakeDb();
  await reserveSecureProjectQuota(db, "project-a", { files: MAX_PROJECT_UPLOAD_FILES - 1, bytes: MAX_PROJECT_UPLOAD_BYTES - 1 });
  await reserveSecureProjectQuota(db, "project-a", { files: 1, bytes: 1 });
  await assert.rejects(reserveSecureProjectQuota(db, "project-a", { files: 1, bytes: 1 }), SecureQuotaError);
  assert.equal(db.documents.get("project-a").uploadFiles, MAX_PROJECT_UPLOAD_FILES);
  assert.equal(db.documents.get("project-a").uploadBytes, MAX_PROJECT_UPLOAD_BYTES);
  await reserveSecureProjectQuota(db, "project-b", { files: 1, bytes: 1 });
});

test("secure quota caps drafts and rejects invalid reservations", async () => {
  const db = fakeDb();
  await reserveSecureProjectQuota(db, "project-a", { drafts: MAX_PROJECT_DRAFTS });
  await assert.rejects(reserveSecureProjectQuota(db, "project-a", { drafts: 1 }), SecureQuotaError);
  await assert.rejects(reserveSecureProjectQuota(db, "project-a", { bytes: -1 }), /inválida/);
});
