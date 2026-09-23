import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SECURE_UPLOAD_BYTES, validSecureUploadSizes, signedSecureUploadTarget } from "./secure-upload.js";

test("secure uploads require declared positive sizes below the cap", () => {
  assert.equal(validSecureUploadSizes([{ fileSizeBytes: 112 }, { fileSizeBytes: MAX_SECURE_UPLOAD_BYTES }]), true);
  for (const value of [undefined, 0, -1, MAX_SECURE_UPLOAD_BYTES + 1, "not-a-size"]) {
    assert.equal(validSecureUploadSizes([{ fileSizeBytes: value }]), false);
  }
});

test("signed POST policy enforces content type and request-size range", async () => {
  let options;
  const file = {
    async generateSignedPostPolicyV4(input) {
      options = input;
      return [{ url: "https://storage.googleapis.com/example", fields: { key: "asset.png" } }];
    }
  };
  const target = await signedSecureUploadTarget(file, "image/png", 123456);
  assert.deepEqual(target, {
    uploadPostUrl: "https://storage.googleapis.com/example",
    uploadFields: { key: "asset.png" }
  });
  assert.equal(options.expires, 123456);
  assert.equal(options.fields["Content-Type"], "image/png");
  assert.deepEqual(options.conditions, [["content-length-range", 1, MAX_SECURE_UPLOAD_BYTES + 16384]]);
});
