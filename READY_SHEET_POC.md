# Lienzo listo: prueba técnica de análisis

El flujo experimental está **desactivado por defecto**. Para habilitarlo en un entorno de prueba, configurar `READY_SHEET_ANALYSIS_ENABLED=true`. No forma parte todavía del checkout ni modifica `/render-queue`.

Además, `BIX_RENDERER_PUBLIC_URL` debe establecerse explícitamente a la URL del **servicio de pruebas**. La ruta de creación de trabajos rechaza solicitudes si esa URL no coincide con el host que recibió la solicitud; así la cola nunca apunta por accidente al renderer de producción.

El servicio de pruebas puede permanecer privado. Antes de habilitar trabajos, configurar `READY_SHEET_TASK_SERVICE_ACCOUNT` con la cuenta de servicio que Cloud Tasks usará para invocar `/ready-sheets/worker`. La tarea adjunta un token OIDC cuyo público es la URL raíz de `BIX_RENDERER_PUBLIC_URL`. Conceder a esa cuenta `roles/run.invoker` **solo en el servicio de pruebas**; la cuenta que crea tareas necesita `iam.serviceAccounts.actAs` sobre ella. También se requiere `READY_SHEET_TASK_SECRET`, un secreto nuevo y distinto de la clave de Supabase, para firmar el cuerpo de la tarea. Sin estas variables, `POST /ready-sheets/jobs` responde 503 antes de crear el trabajo.

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

Para una prueba de peso sin usar diseños de clientes, `npm run generate:heavy-fixture` crea `ready-sheet-heavy-test.png` (7323 × 11811 px, 300 DPI, cerca de 70 MB). La composición tiene exactamente 14,440,000 píxeles opacos, 1,440,000 semitransparentes y márgenes transparentes; el archivo generado queda fuera de Git. El color aleatorio dificulta la compresión para ejercitar también la transferencia del archivo, no solo el tamaño expandido en memoria.
