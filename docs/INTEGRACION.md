# Integración con el Agente de Discovery

Escriba funciona solo. Esta integración quita el último paso manual: en vez de
descargar la transcripción y volverla a subir al panel, la llamada entra sola al
proyecto de discovery que corresponde.

## Qué hace, exactamente

Reproduce paso por paso lo que hace el panel web al subir un archivo, así que **el
backend no necesita ningún endpoint nuevo**:

1. Sube el `.txt` a Supabase Storage en `insumos/{agencia}/{proyecto}/{archivo}`.
2. Registra la fuente con `POST /proyectos/{id}/fuentes`.

A partir de ahí la transcripción es una fuente igual a cualquier otra: se ingiere a
fragmentos con hablante y timestamp como locator, y el pipeline puede citarla con
minuto y nombre.

## Autenticación: prestada del panel

No hay una segunda contraseña ni un token que copiar a mano. Si ya iniciaste sesión
en el panel con tu enlace mágico, Escriba lee esa sesión de Supabase y queda
vinculado. Hereda exactamente los mismos permisos que tiene el panel, ni uno más, y
renueva el token solo mientras el `refresh_token` siga vivo.

En la práctica: pulsas **Vincular con el panel**, se abre el panel, y listo.

## Configuración

En los ajustes de Escriba, con el destino en **Enviarla al Agente de Discovery**:

| Campo | Qué es |
|---|---|
| URL del backend | donde vive la API de FastAPI |
| URL del panel | el frontend, de donde se toma prestada la sesión |
| URL de Supabase | `https://<referencia>.supabase.co` |
| Llave pública de Supabase | la publishable/anon, **nunca** la service role |

Los tres orígenes se piden como permisos opcionales al vincular.

## Flujo de una llamada

1. Entras a la llamada de Meet.
2. Abres Escriba, eliges el proyecto de discovery en el selector y pulsas grabar.
3. Al detener, la transcripción se transcribe, se sube y se registra como fuente.
4. Entras al panel y corres el pipeline cuando ya tengas todos los insumos.

## Dos cosas que hay que saber

**Reenviar lo mismo no duplica.** `registrar_fuente` es idempotente por hash
SHA-256 del contenido: si mandas dos veces la misma transcripción, el backend
devuelve la fuente que ya existía.

**Renombrar un hablante después de enviar sí duplicaría.** Cambiar un nombre cambia
el contenido, y por lo tanto el hash, así que entraría como una fuente nueva y la
llamada quedaría contada dos veces en el análisis. El popup lo advierte cuando la
sesión ya fue enviada. Para corregirla: borra la fuente en el panel y vuelve a
enviarla.

Por eso conviene tener los subtítulos de Meet encendidos: con ellos los nombres
salen bien de entrada y no hay nada que renombrar.

## Si la entrega falla

La transcripción ya está guardada. Escriba la descarga como archivo para que no se
pierda y el popup ofrece **Reintentar sin regrabar**, que reutiliza la
transcripción guardada en vez de volver a llamar al motor. No se paga dos veces.
