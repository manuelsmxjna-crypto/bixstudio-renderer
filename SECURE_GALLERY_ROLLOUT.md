# Galería protegida: despliegue por etapas

Esta rama prepara un flujo nuevo, pero **no se debe activar todavía en producción**. Los interruptores nacen apagados para conservar los pedidos actuales.

## Recorrido

1. El builder usa una vista previa de 320 px con marca de agua; el original no sale del servidor de la galería.
2. El cliente acomoda el diseño. El builder sube solo sus archivos propios y guarda un borrador con referencias a los diseños de galería.
3. El carrito recibe IDs de borradores, no enlaces de impresión.
4. Shopify envía `orders/paid`. El renderer comprueba el HMAC sobre el cuerpo crudo, el dominio de la tienda, el tema y el largo comprado.
5. Una tarea copia internamente los originales de galería a rutas privadas del proyecto y encola los renders. Los resultados aparecen en el panel administrativo de galería.

## Configuración necesaria

- App de Shopify instalada con `read_orders`; suscribirse a `orders/paid` con destino HTTPS `https://bixstudio-renderer-318403647962.us-central1.run.app/secure-orders/shopify-paid`. La app del Dev Dashboard puede vincularse a Shopify CLI para desplegar la suscripción.
- Renderer: `SHOPIFY_WEBHOOK_SECRET` desde Secret Manager (el **client secret** de la app, nunca en el repositorio), `SHOPIFY_SHOP_DOMAIN=whgcmj-0q.myshopify.com` (dominio exacto confirmado en Shopify), `SHOPIFY_DTF_VARIANT_ID=52961074610357`, y `SECURE_GALLERY_CHECKOUT_ENABLED=true` solo tras las pruebas.
- La cuenta de servicio del renderer necesita leer Firestore (`galleryImages`, `galleryCategories`, `secureOrderClaims`) y copiar objetos dentro del bucket. La del panel ya debe poder leer los recibos en `secure-orders/receipts/`.
- Galería: `GALLERY_SECURE_PREVIEW_ONLY=true` únicamente cuando el builder nuevo esté publicado. Esto elimina `imageUrl` del catálogo público y hace que los originales respondan 403 a visitantes anónimos.
- Builder: cambiar `SECURE_GALLERY_CHECKOUT` a `true` únicamente cuando el renderer y el webhook estén listos. Publicar primero el builder y después activar el modo seguro de la galería durante una ventana de baja actividad.

## Antes de activar

- Probar un pedido pagado de prueba con un diseño de galería y otro subido por el cliente.
- Confirmar que la cantidad cobrada coincide con el largo de las hojas y que el webhook no imprime si no coincide.
- Confirmar que repetir el webhook no crea otra impresión.
- Verificar que el panel administrativo abre cada hoja y que el cliente recibe 403 al solicitar un original publicado.
- Verificar que el bucket no tenga acceso público directo a `gallery/originals/` ni a `projects/*/renders/`.
- Conservar el flujo anterior hasta terminar estas pruebas; revertir los tres interruptores si falla el piloto.

Esto evita entregar el original por HTTP al cliente, pero no puede impedir que alguien guarde una captura o una miniatura de baja resolución. Los originales descargados **antes** del cambio tampoco pueden revocarse de dispositivos ajenos.
