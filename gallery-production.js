import crypto from "node:crypto";

export const PRIVATE_GALLERY_ROOT = "private-gallery-production/";
export function isPrivateGalleryPath(path) {
  return String(path || "").startsWith(PRIVATE_GALLERY_ROOT);
}
export function galleryJobPath(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("ID de producción inválido.");
  return `${PRIVATE_GALLERY_ROOT}jobs/${id}.json`;
}
export function galleryOutputPath(id) {
  galleryJobPath(id);
  return `${PRIVATE_GALLERY_ROOT}outputs/${id}.png`;
}
export function assertPublicRenderObjects(objects) {
  if (!Array.isArray(objects) || !objects.length) throw new Error("Diseños inválidos.");
  for (const o of objects) {
    if (![o.x, o.y, o.width, o.height].every(v => Number.isFinite(Number(v))) || Number(o.width) <= 0 || Number(o.height) <= 0) throw new Error("Medidas inválidas.");
    if (o.galleryId) {
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(o.galleryId) || o.storagePath || !/^[a-f0-9]{24}$/.test(o.galleryRevision || "")) throw new Error("Referencia de galería inválida.");
    } else if (!/^projects\/[A-Za-z0-9_-]+\/assets\/originals\/[A-Za-z0-9_.-]+$/.test(o.storagePath || "")) {
      // Do not accept gallery originals or production outputs as arbitrary inputs.
      throw new Error("Ruta de diseño no permitida.");
    }
  }
}
export async function resolveGalleryObjects(objects, db) {
  assertPublicRenderObjects(objects);
  const resolved = new Map();
  const output = [];
  for (const o of objects) {
    if (!o.galleryId) { output.push(o); continue; }
    const key = `${o.galleryId}:${o.galleryRevision}`;
    if (!resolved.has(key)) {
      const doc = await db.collection("galleryImages").doc(o.galleryId).get();
      if (!doc.exists || !doc.data().published) throw new Error("Diseño de galería no disponible.");
      const data = doc.data();
      if (!/^gallery\/originals\/[A-Za-z0-9_.-]+$/.test(data.objectPath || "")) throw new Error("Original inválido.");
      const revision = crypto.createHash("sha256").update(data.objectPath).digest("hex").slice(0, 24);
      if (revision !== o.galleryRevision) throw new Error("El diseño de galería cambió. Vuelve a añadirlo.");
      if (data.categoryId) {
        const category = await db.collection("galleryCategories").doc(data.categoryId).get();
        if (!category.exists || !category.data().published) throw new Error("Categoría no disponible.");
      }
      resolved.set(key, data.objectPath);
    }
    // Copy only geometry plus the path resolved by the server.
    output.push({ id: o.id, x: o.x, y: o.y, width: o.width, height: o.height,
      rotation: o.rotation, flipX: !!o.flipX, flipY: !!o.flipY, storagePath: resolved.get(key) });
  }
  return output;
}
