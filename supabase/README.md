# Supabase aislado para probar el checkout seguro

1. Crear **un proyecto nuevo** de Supabase, por ejemplo `bixstudio-checkout-test`. No usar ni clonar el proyecto que recibe pedidos reales.
2. En el proyecto nuevo, abrir **SQL Editor** y ejecutar íntegro [`staging-schema.sql`](staging-schema.sql). El SQL crea únicamente cuatro tablas vacías y niega acceso a los roles `anon` y `authenticated`.
3. En **Connect** o **Settings → API Keys**, obtener la URL `https://<ref>.supabase.co` y una clave **secret** (`sb_secret_...`) de este proyecto nuevo. Nunca enviar la clave por chat, guardarla en Git ni ponerla en el armador.
4. Almacenar URL y clave por separado en Google Secret Manager. Vincularlos solo al servicio privado `bixstudio-renderer-test` como `SUPABASE_URL` y `SUPABASE_SECRET_KEY`; no cambiar el renderer de producción.
5. Con `SECURE_GALLERY_CHECKOUT_ENABLED=false`, comprobar `/supabase-health`, crear un proyecto ficticio, registrar una hoja y un render de prueba. Solo después probar un webhook pagado simulado. Este esquema se infirió del código del renderer; cualquier diferencia de API deberá resolverse aquí, nunca en producción.

La clave secreta permite saltar RLS y pertenece solo al servidor. El gateway público no recibe URL ni clave de Supabase.
