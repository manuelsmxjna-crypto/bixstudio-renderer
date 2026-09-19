# Lienzo listo: prueba técnica de análisis

El flujo experimental está **desactivado por defecto**. Para habilitarlo en un entorno de prueba, configurar `READY_SHEET_ANALYSIS_ENABLED=true`. No forma parte todavía del checkout ni modifica `/render-queue`.

`POST /ready-sheets/jobs` recibe un archivo ya subido por las rutas existentes:

```json
{
  "projectId": "UUID devuelto por /projects",
  "objectPath": "projects/UUID/assets/originals/archivo.png"
}
```

Responde HTTP 202 con `jobId` y `statusUrl`. El cliente consulta `GET /ready-sheets/jobs/:jobId?projectId=UUID`, que devuelve `queued`, `processing`, `completed` o `failed`. Al terminar incluye dimensiones en píxeles, DPI incrustado cuando existe, cantidades exactas de píxeles transparentes/semitransparentes/opacos, límites del contenido y una URL temporal a una vista previa de hasta 1200 px. El original no se cambia. El análisis de alfa se hace en un flujo RGBA de una sola pasada; no se crea un buffer RGBA de la imagen completa. Los estados se guardan como pequeños manifiestos JSON en Cloud Storage y el trabajo se ejecuta con la cola Cloud Tasks ya existente.

Límites iniciales: PNG, JPG, WEBP o TIFF de una sola página; máximo 128 MB comprimidos y 350 millones de píxeles. PDF, limpieza de alfa, subida reanudable, cotización y cola de trabajos quedan fuera de esta prueba.

**Antes de habilitarlo en Cloud Run:** el archivo original se descarga a un temporal. El sistema de archivos escribible de Cloud Run normalmente consume memoria de la instancia, así que esta ruta requiere una instancia con memoria suficiente o un disco efímero configurado y pruebas de concurrencia. No habilitarlo en producción con el límite actual sin esas verificaciones. La cola puede reintentar fallos transitorios; el trabajo completado es idempotente.

Pruebas locales: `npm test`.
