# Escriba

Extensión de Chrome que transcribe tus videollamadas de Google Meet y Zoom web
**sin meter un bot a la reunión**. Tú eliges el motor de transcripción, incluido
uno local donde el audio nunca sale de tu máquina.

Un clic para empezar, un clic para terminar. Al colgar tienes la transcripción con
nombres, minuto a minuto.

```
[00:04:12] Mateo Ortega: ¿Cómo manejan hoy la agenda de citas?
[00:04:19] Diana Restrepo: El 30% de los pacientes no aparece a la cita.
```

## Por qué no un bot que entre a la llamada

Casi todas las herramientas de este tipo meten un participante extra a la reunión.
Eso obliga a que el anfitrión lo admita, aparece en la lista de asistentes, cuesta
por hora de bot y se rompe cada vez que la plataforma cambia su interfaz.

Escriba no entra a la llamada. Captura el audio de la pestaña que ya tienes
abierta, más tu micrófono, desde tu propio navegador. Cero infraestructura, cero
costo fijo y nada que explicarle a la otra parte sobre quién es ese asistente
silencioso.

La contrapartida es honesta y está en la sección de límites: solo funciona con
llamadas en el navegador, y solo mientras tú estés en ellas.

## Cómo sabe quién habla

Aquí está la parte interesante. La atribución no se adivina, se sabe por
construcción, porque se graban dos pistas separadas:

| Pista | Fuente | Quién es |
|---|---|---|
| `mic` | tu micrófono | tú |
| `tab` | el audio de la pestaña | la otra parte |

Con eso ya queda la división que de verdad importa en una llamada:
quién preguntó y quién respondió. Encima de eso, en Google Meet, si los subtítulos
están encendidos, Escriba lee la línea de tiempo de nombres del propio Meet y le
pone nombre propio a cada interlocutor. **El audio da el texto bueno, los
subtítulos dan los nombres.**

Si no hay subtítulos, la otra parte queda como un único hablante genérico que
puedes renombrar desde el popup antes de exportar.

## Instalación

No hay que compilar nada: no tiene dependencias ni paso de construcción.

1. Clona el repositorio.
2. Abre `chrome://extensions` (o `brave://extensions`).
3. Activa **Modo de desarrollador**.
4. **Cargar descomprimida** y elige la carpeta `extension/`.

Requiere Chrome o cualquier navegador basado en Chromium, versión 116 o superior.

## Configuración, una sola vez

Abre los ajustes de la extensión y haz tres cosas:

1. **Concede el micrófono.** Chrome solo permite pedirlo desde una página visible,
   por eso hay un botón para eso en los ajustes. Sin él se graba únicamente la voz
   de los demás.
2. **Escribe tu nombre.** Es la etiqueta de tu pista en la transcripción.
3. **Elige el motor y pega su llave.** La llave se guarda solo en tu navegador y
   viaja únicamente al proveedor que elegiste. Escriba no tiene servidor propio:
   no hay ningún sitio por donde pase tu audio salvo el motor que tú configures.

### Motores disponibles

| Motor | Cuándo elegirlo | Costo aproximado por hora de audio |
|---|---|---|
| **Deepgram** | Mejor calidad en español y tiempos finos | unas décimas de dólar |
| **OpenAI, Groq o Whisper local** | Groq es lo más barato en la nube; un servidor local deja el audio en tu máquina | de centavos a cero |

Con la opción compatible con OpenAI, la URL base decide el proveedor:

- OpenAI: `https://api.openai.com/v1`
- Groq: `https://api.groq.com/openai/v1`
- Whisper propio (speaches, faster-whisper-server): `http://localhost:8000/v1`

Agregar otro proveedor es un módulo y una línea en un registro. Ver
[docs/MOTORES.md](docs/MOTORES.md).

## Uso

1. Entra a la llamada en Google Meet o en Zoom web.
2. En Meet, enciende los subtítulos si quieres los nombres propios.
3. Abre Escriba y pulsa **Grabar y transcribir**.
4. Al terminar, **Detener**. La transcripción se descarga sola, o se va directo a
   tu proyecto del Agente de Discovery si configuraste ese destino.

Mientras graba se muestra un indicador en tu pestaña. Solo lo ves tú, y está ahí
justamente para que no se te olvide.

## Aviso a los participantes

Capturar el audio de una pestaña **no deja ninguna marca visible para los demás**.
Que nadie lo note es precisamente la razón para avisar.

En Colombia, grabar una conversación en la que participas es legal. Pero esto son
llamadas de negocio sobre información de un cliente, y el aviso es parte del
oficio, no un trámite. Escriba trae dos ayudas para eso: el indicador permanente
en tu pestaña, y la opción de escribir el aviso automáticamente en el chat de Meet
al empezar. La segunda viene apagada, porque la decisión es tuya.

## Privacidad

- El audio se guarda en IndexedDB, en tu navegador, y **se borra en cuanto
  termina la transcripción** salvo que pidas conservarlo.
- La transcripción se queda en tu navegador hasta que la descargues o la envíes.
- La única salida de red es hacia el motor que configuraste, y hacia tu propio
  backend si eliges ese destino.
- Las llaves de API viven en `chrome.storage.local`. No hay telemetría ni
  analítica de ningún tipo.

## Límites, sin adornos

- **Solo llamadas en el navegador.** Zoom o Teams en su aplicación de escritorio
  no se capturan: para eso hace falta una aplicación de escritorio, que es otro
  proyecto.
- **Tienes que estar en la llamada.** Escriba graba desde tu navegador; no cubre
  reuniones a las que no asistes.
- **Los nombres propios dependen del DOM de Meet.** Google lo cambia sin avisar.
  Todo el lector de subtítulos falla en blando: si deja de encontrarlos, la
  transcripción sigue saliendo completa y solo se pierde el nombre propio, que
  puedes poner a mano. Los selectores están juntos en una sola lista para poder
  actualizarlos rápido.
- **Zoom web no da nombres por intervención**, solo la división entre tú y la
  otra parte.
- **Usa audífonos si puedes.** Con parlantes, la voz de la otra parte entra
  también por tu micrófono. La cancelación de eco está activada por defecto y lo
  atenúa, pero los audífonos lo resuelven de raíz.
- **Se pierden milésimas al rotar de trozo.** La grabación se corta cada cinco
  minutos en archivos independientes para resistir una caída del navegador; en cada
  corte se van unas decenas de milisegundos.
- **Grabar dos pistas duplica los minutos facturados**, aunque los trozos
  silenciosos no se mandan a transcribir y eso recorta la mayor parte del sobrecosto.

## Integración con el Agente de Discovery

Escriba funciona solo, pero también puede entregar cada llamada directamente a un
proyecto del Agente de Discovery, sin descargar ni volver a subir nada. Ver
[docs/INTEGRACION.md](docs/INTEGRACION.md).

## Desarrollo

```bash
node herramientas/validar.mjs   # pruebas de los módulos puros
```

Sin dependencias, sin bundler, sin paso de compilación: se carga tal cual en el
navegador. Es una decisión deliberada, explicada en
[docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

```
extension/
├── manifest.json
├── background/service_worker.js   decide y guarda el estado
├── offscreen/                     captura, transcribe y entrega
├── contenido/                     lee Meet y Zoom (subtítulos, título, aviso)
├── nucleo/
│   ├── motores/                   un módulo por proveedor de transcripción
│   ├── destinos/                  a dónde va la transcripción
│   ├── hablantes.js               atribución de hablantes
│   └── formatos.js                salida en texto trazable y WebVTT
├── popup/                         la única superficie de uso
└── opciones/                      configuración
```

## Licencia

MIT. Ver [LICENSE](LICENSE).
