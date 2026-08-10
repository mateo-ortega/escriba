# Arquitectura de Escriba

Este documento explica **por qué** está hecho así, no solo cómo. Las decisiones
que parecen raras suelen ser respuestas a una restricción real de Chrome.

## 1. Reparto de responsabilidades

```
                     ┌──────────────────────────────┐
   pestaña de Meet   │  script de contenido         │
   o de Zoom web ────┤  título, subtítulos, aviso,  │
                     │  indicador de grabación      │
                     └──────────────┬───────────────┘
                                    │ lotes de subtítulos
                                    ▼
   popup ◄─── estado ───┐  ┌────────────────────────┐
   opciones             ├──┤  service worker        │
                        │  │  decide y guarda       │
                        │  │  el estado             │
                        │  └───────────┬────────────┘
                        │              │ iniciar, detener, procesar
                        │              ▼
                        │  ┌────────────────────────┐
                        └──┤  documento offscreen   │
                           │  captura, transcribe   │
                           │  y entrega             │
                           └───────────┬────────────┘
                                       │
                          ┌────────────┴────────────┐
                          ▼                         ▼
                   motor de transcripción     destino final
                   (Deepgram, Groq, local)    (archivo o discovery)
```

## 2. Por qué existe el documento offscreen

Un service worker de MV3 no tiene DOM, ni WebAudio, ni `MediaRecorder`, ni
`URL.createObjectURL`, y además Chrome lo apaga cuando queda inactivo. Grabar una
llamada de una hora ahí es imposible.

El documento offscreen sí tiene todo eso y sobrevive a la llamada completa. Se
declara con los motivos `USER_MEDIA` y `AUDIO_PLAYBACK`: el segundo importa porque
el documento devuelve el audio de la pestaña a los parlantes, y eso lo mantiene
vivo.

Consecuencia de diseño: **el estado de la sesión no vive en variables del service
worker** sino en `chrome.storage.local`. Si Chrome apaga el worker en mitad de una
llamada, al despertar sigue sabiendo qué estaba haciendo.

Segunda consecuencia: los Blobs no sobreviven a `chrome.runtime.sendMessage`,
porque los mensajes se serializan como JSON. Por eso el documento offscreen escribe
el audio directo a IndexedDB en vez de pasárselo al worker.

## 3. Dos pistas separadas, no un archivo estéreo

La alternativa obvia era mezclar micrófono y pestaña en un archivo estéreo (uno por
canal) y pedirle al motor una transcripción multicanal. Se descartó:

- Obliga a que el motor soporte multicanal, y varios no lo hacen (los endpoints
  compatibles con Whisper, por ejemplo).
- Separar canales después implica decodificar el audio completo en memoria. Una
  hora en estéreo son más de mil millones de valores en coma flotante.

Grabar dos pistas independientes desde el principio elimina las dos cosas: cada
trozo va tal cual al motor, cualquier motor sirve, y la atribución del hablante es
un dato de la grabación en vez de una inferencia.

El precio es que se facturan el doble de minutos. Se mitiga midiendo la energía de
cada pista durante la captura: los trozos por debajo del umbral se marcan como
silencio y no se mandan a transcribir. Como cada interlocutor calla mientras habla
el otro, eso recorta la mayor parte del sobrecosto.

En la cadena de audio hay un detalle que no es cosmético: cada pista pasa por un
nodo con `channelCount = 1` y `channelCountMode = "explicit"`. Sin eso, el audio
estéreo de la pestaña conectado a un destino mono se quedaría con un solo canal en
vez de mezclar los dos, y el destino volvería a subir la señal mono a dos canales
idénticos, duplicando el peso del archivo.

Y el audio de la pestaña se reconecta a `ctx.destination`: capturar una pestaña la
silencia, así que sin ese cable dejas de oír la llamada.

## 4. Trozos independientes

La grabación se corta cada cinco minutos (configurable) en archivos WebM completos
e independientes. Tres razones:

1. **Resiliencia.** Si el navegador muere, los trozos anteriores ya están en
   IndexedDB y son válidos por sí mismos. Además, dentro del trozo en curso se
   persiste cada 30 segundos: la primera parte trae la cabecera WebM y las
   siguientes la continúan, así que concatenar lo recibido produce un archivo
   utilizable.
2. **Límites de los proveedores.** OpenAI y Groq topan en 25 MB por archivo. Un
   trozo de cinco minutos a 32 kbps pesa alrededor de 1,2 MB: nunca se llega cerca.
3. **Paralelismo.** Los trozos se transcriben de tres en tres.

El costo es que en cada corte se pierden unas decenas de milisegundos. Se aceptó:
con trozos de cinco minutos son unos doce cortes por hora, y alternar dos grabadores
con solape para evitarlo introduciría palabras duplicadas, que es peor.

## 5. Reintentar no vuelve a pagar

Si la transcripción salió bien pero la entrega falló, reintentar **reutiliza la
transcripción guardada** en vez de volver a llamar al motor. Repetirla sería pagar
dos veces por el mismo audio, y además el audio ya pudo haberse borrado.

Cuando la entrega al Agente de Discovery falla, la transcripción se descarga como
archivo antes de propagar el error, para que el trabajo no se pierda nunca.

## 6. Sin dependencias y sin compilación

JavaScript plano con módulos ES, cargado tal cual por el navegador. No hay
TypeScript, ni bundler, ni `npm install`.

Es deliberado. Una extensión de MV3 ya corre módulos ES de forma nativa, así que un
paso de compilación solo agregaría una capa entre el código y lo que se ejecuta.
Cualquiera puede clonar el repositorio y cargarlo en treinta segundos, y lo que se
lee en el editor es exactamente lo que corre en el navegador.

El único `package.json` del proyecto existe para que Node trate los módulos como
ESM al correr las pruebas. No declara dependencias.

## 7. Permisos: lo mínimo de entrada

El manifiesto solo declara acceso a `meet.google.com` y a `*.zoom.us`. El origen
del motor de transcripción **no** va en el manifiesto: se pide como permiso
opcional al elegir ese motor en los ajustes. Así, quien use un Whisper local nunca
concede acceso a la nube de nadie.

Esto es funcionalmente necesario, no solo higiénico: sin permiso de host, una
petición de la extensión queda sujeta a las reglas normales de CORS y la API del
proveedor la rechaza. Con el permiso, el documento offscreen habla directo con el
motor y el audio no pasa por ningún intermediario.

El micrófono se pide desde la página de opciones porque Chrome exige un gesto en
una página visible. Concedido una vez, el documento offscreen lo hereda.

## 8. El formato de salida no es una elección estética

```
[00:04:12] Diana Restrepo: el 30% de los pacientes no aparece a la cita.
```

Ese patrón es exactamente el que el pipeline del Agente de Discovery reconoce para
quedarse con hablante y timestamp como locator, y el locator es lo que permite que
un hallazgo cite su evidencia con minuto y nombre en vez de resumir sin fuente. La
misma línea sirve leída por una persona y parseada por una máquina.

De ahí salen dos reglas que el código respeta a propósito:

- Los nombres de hablante se sanean: sin dos puntos, sin saltos de línea, máximo 60
  caracteres. Un nombre con dos puntos rompería el parseo de su propia línea.
- El texto de cada intervención se aplana a una sola línea. Un salto interno
  partiría la intervención en dos y la segunda mitad perdería su locator.

## 9. Verificación

Lo que se puede romper en silencio está cubierto por pruebas:

```bash
node herramientas/validar.mjs
```

19 pruebas sobre la atribución de hablantes y el formato de salida, incluida una que
comprueba cada línea generada contra una copia literal del patrón que usa el
pipeline del Agente de Discovery.

Además, la salida se verificó pasándola por el parser Python real del backend: una
transcripción de ejemplo produjo cinco fragmentos con locator de hablante y
timestamp, más uno de encabezado, con tildes intactas y con un nombre problemático
(`Dr: Andrés Muñoz`) correctamente saneado.

Lo que **no** está cubierto por pruebas automáticas, porque depende del navegador y
de servicios externos: la captura de audio, los motores y el lector de subtítulos de
Meet. Eso se verifica con una llamada real.

### Lista de verificación manual

1. Cargar la extensión y conceder el micrófono desde los ajustes.
2. Entrar a una llamada de Meet con otra persona, encender los subtítulos.
3. Grabar dos minutos hablando por turnos y luego los dos a la vez.
4. Detener y revisar: que la voz propia salga con tu nombre, que la otra salga con
   su nombre real, que los tiempos correspondan y que el audio se haya borrado.
5. Comprobar que se siguió oyendo la llamada durante toda la grabación (si no, el
   cable de retorno a los parlantes se rompió).
