export const MAX_PROJECT_UPLOAD_FILES = 100;
export const MAX_PROJECT_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_PROJECT_DRAFTS = 100;

export class SecureQuotaError extends Error {
  constructor() {
    super("Este proyecto alcanzó el límite de archivos o composiciones. Inicia un lienzo nuevo.");
  }
}

export async function reserveSecureProjectQuota(db, projectId, addition) {
  const files = addition.files || 0;
  const bytes = addition.bytes || 0;
  const drafts = addition.drafts || 0;
  if (![files, bytes, drafts].every(value => Number.isSafeInteger(value) && value >= 0) || files + bytes + drafts === 0) {
    throw new Error("Reserva de cuota inválida.");
  }
  const ref = db.collection("secureProjectQuotas").doc(projectId);
  await db.runTransaction(async transaction => {
    const current = await transaction.get(ref);
    const used = current.exists ? current.data() : {};
    const nextFiles = (used.uploadFiles || 0) + files;
    const nextBytes = (used.uploadBytes || 0) + bytes;
    const nextDrafts = (used.drafts || 0) + drafts;
    if (nextFiles > MAX_PROJECT_UPLOAD_FILES || nextBytes > MAX_PROJECT_UPLOAD_BYTES || nextDrafts > MAX_PROJECT_DRAFTS) {
      throw new SecureQuotaError();
    }
    transaction.set(ref, {
      uploadFiles: nextFiles,
      uploadBytes: nextBytes,
      drafts: nextDrafts,
      updatedAt: Date.now()
    });
  });
}
