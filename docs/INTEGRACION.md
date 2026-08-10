# Integración con el Agente de Discovery

Escriba funciona solo. Esta integración quita el último paso manual: en vez de
descargar la transcripción y volverla a subir al panel, la llamada entra sola al
proyecto de discovery que corresponde.

## Qué hace, exactamente

Reproduce el mismo reparto que ya usa el panel web, así que **el backend no
necesita ningún endpoint nuevo**:

| Paso | Contra qué | Por qué así |
|---|---|---|
| Leer tu agencia y tus proyectos | Supabase, filtrado por RLS | Son lecturas: la base ya sabe qué puedes ver |
| Subir el `.txt` a Storage | Supabase | Igual que el panel, con `upsert` |
| Registrar la fuente | Backend, `POST /proyectos/{id}/fuentes` | No es escribir una fila: dispara la ingesta a fragmentos |

Que las lecturas no pasen por el backend tiene una consecuencia práctica: **elegir
el proyecto de destino funciona con solo Supabase en pie**. Si el backend no está
desplegado, el fallo queda localizado en el último paso y todo lo demás sigue
sirviendo.

A partir de ahí la transcripción es una fuente igual a cualquier otra: se ingiere a
fragmentos con hablante y timestamp como locator, y el pipeline puede citarla con
minuto y nombre.

## Autenticación: prestada del panel

No hay una segunda contraseña ni un token que copiar a mano. Si ya iniciaste sesión
en el panel con tu enlace mágico, Escriba lee esa sesión de Supabase y queda
vinculado. Hereda exactamente los mismos permisos que tiene el panel, ni uno más, y
renueva el token solo mientras el `refresh_token` siga vivo.

## Configuración: un solo campo

En los ajustes de Escriba, con el destino en **Enviarla al Agente de Discovery**,
solo se escribe **la URL del panel**. Todo lo demás lo entrega el panel.

Al pulsar **Vincular con el panel**, Escriba abre `/panel/escriba` y de una sola
visita saca dos cosas:

- **La configuración**, de un bloque `<script type="application/json">` que esa
  página publica: URL del backend, URL de Supabase y su llave publishable.
- **La sesión**, del almacenamiento local del panel.

El bloque va en el DOM y no en una variable de JavaScript por una razón técnica: un
script inyectado por una extensión corre en un mundo aislado donde no ve las
variables de la página, pero sí ve el DOM. El almacenamiento local, en cambio, sí
se comparte porque pertenece al origen.

Antes había que copiar cinco campos de infraestructura a mano. Un consultor de una
agencia no tiene por qué saber cuál es la URL de Supabase de su propio panel.

## Saber si está conectada, desde el panel

Una página web no puede preguntar si cierta extensión existe, así que el canal va al
revés: al vincular, Escriba registra un script de contenido en el origen del panel
cuyo único trabajo es dejar `data-escriba` en el elemento raíz. La página
`/panel/escriba` observa ese atributo y por eso puede decir "Escriba está instalado
y vinculado" en vez de mostrar instrucciones a ciegas.

Si el registro de ese script falla, la vinculación sigue siendo válida: la marca es
una cortesía para la interfaz, no parte del camino de datos.

## Flujo de una llamada

1. Entras a la llamada de Meet y enciendes los subtítulos.
2. Abres Escriba, eliges el proyecto de discovery en el selector y pulsas grabar.
3. Al detener, la transcripción se transcribe, se sube y se registra como fuente.
4. En la página del proyecto, la llamada aparece en la lista de fuentes con la
   etiqueta "llamada" y su cobertura.
5. Corres el pipeline cuando ya tengas todos los insumos.

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
