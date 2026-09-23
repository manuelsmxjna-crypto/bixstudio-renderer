export const MAX_SECURE_UPLOAD_BYTES = 100 * 1024 * 1024;

export function validSecureUploadSizes(items) {
  return items.every(item => {
    const size = Number(item?.fileSizeBytes);
    return Number.isSafeInteger(size) && size >= 1 && size <= MAX_SECURE_UPLOAD_BYTES;
  });
}

export async function signedSecureUploadTarget(file, contentType, expiresAt) {
  // POST policies let Cloud Storage reject an oversized multipart request.
  // The small allowance accounts for the policy's form fields and boundaries.
  const [policy] = await file.generateSignedPostPolicyV4({
    expires: expiresAt,
    fields: { "Content-Type": contentType },
    conditions: [["content-length-range", 1, MAX_SECURE_UPLOAD_BYTES + 16384]]
  });
  return { uploadPostUrl: policy.url, uploadFields: policy.fields };
}
