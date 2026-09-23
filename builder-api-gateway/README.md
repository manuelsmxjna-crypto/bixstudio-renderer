# Gateway público del builder (preparación; no desplegar aún en producción)

Este servicio expone solo `POST /projects`, `/upload-urls`, `/assets-confirm`,
`/download-url` y `/secure-orders/drafts`. Obtiene un token de identidad de Google
para llamar al renderer privado. Nunca expone `/render-queue`, `/render-sheet`,
`/render-worker`, `/print-file` ni el webhook de Shopify.

Variables obligatorias:

- `PRIVATE_RENDERER_URL`: URL base HTTPS del renderer privado.
- `BUILDER_GATEWAY_SECRET`: secreto aleatorio de al menos 32 caracteres, guardado
  en Secret Manager y distinto del secreto de Shopify.
- `BUILDER_ALLOWED_ORIGINS`: orígenes HTTPS exactos, separados por comas. El
  iframe actual se sirve desde `https://bixstudio-builder.pages.dev`; confirmar
  el origen de cualquier vista previa antes de agregarlo.

`/projects` entrega un token de 30 días para el proyecto nuevo. Las otras rutas
requieren `X-BixStudio-Project-Token` y comprueban que las rutas de archivos sean
de `assets/originals` de ese proyecto. El builder guarda token y vencimiento en
su sesión. En modo seguro `/upload-urls` entrega una política V4 de formulario
POST de diez minutos y tamaño acotado (máximo nominal de 100 MiB por archivo),
en vez de una URL PUT. El bucket debe permitir `POST` desde el origen del iframe.
Un origen CORS permitido **no es autenticación**: un cliente HTTP puede
falsificar `Origin`. Antes de publicar, añadir controles de abuso/costos (por
ejemplo Cloud Armor y cuotas), comprobar el límite real de las políticas POST y
verificar el CORS del bucket para el origen del iframe. El gateway no debe tener
acceso directo a Storage, Supabase ni Firestore; su cuenta solo invoca al renderer.

Para producción, usar un renderer privado nuevo y mantener el renderer legado
durante la transición de sesiones antiguas. El modo seguro del renderer rechaza
los endpoints de render inmediato; no activar ese modo en el servicio legado que
todavía atiende sesiones abiertas.
