# Agregar un motor de transcripción

Agregar un proveedor es un módulo nuevo y una línea en el registro. Nada más del
código sabe qué motor está en uso.

## El contrato

Un motor exporta un objeto con esta forma:

```js
export const miMotor = {
  id: "mi-motor",              // estable: es lo que se guarda en la configuración
  etiqueta: "Mi Motor",        // lo que ve el usuario
  necesitaLlave: true,         // muestra el campo de llave de API
  necesitaBaseUrl: false,      // muestra el campo de URL base
  origenes: ["https://api.mimotor.com/*"],  // permiso de host que hay que pedir
  modeloPorDefecto: "modelo-1",
  ayuda: "Una línea sobre cuándo elegirlo.",

  /**
   * Args:
   *   blob: audio WebM/Opus mono de una sola pista
   *   opciones: { llave, baseUrl, modelo, idioma }
   * Returns:
   *   { segmentos: [{inicio, fin, texto}], modelo }
   */
  async transcribir(blob, { llave, baseUrl, modelo, idioma }) {
    // ...
  },
};
```

Reglas del contrato:

- `inicio` y `fin` van en **segundos relativos al trozo**, no a la llamada. El
  orquestador los traslada al tiempo absoluto.
- Si la respuesta no trae tiempos, devuelve un único segmento con todo el texto. Se
  pierde precisión dentro del trozo, pero el trozo sigue ubicado en la llamada.
- Lanza un error con mensaje legible si el proveedor responde mal. El orquestador
  reintenta dos veces con espera creciente y, si el trozo se pierde, sigue con los
  demás: un error de red no debe costar la llamada completa.
- **No** te preocupes por la diarización ni por saber quién habla. Eso ya está
  resuelto por la forma de capturar: cada trozo pertenece a una sola pista, y el
  motor solo tiene que devolver texto con tiempos.

## Registrarlo

En [`extension/nucleo/motores/registro.js`](../extension/nucleo/motores/registro.js):

```js
import { miMotor } from "./mi_motor.js";

export const MOTORES = {
  [deepgram.id]: deepgram,
  [openaiCompatible.id]: openaiCompatible,
  [miMotor.id]: miMotor,
};
```

Eso es todo: la página de opciones se pinta desde el registro y el selector aparece
solo.

## Antes de escribir un módulo nuevo

Comprueba si el proveedor ya habla el dialecto de OpenAI en
`POST {baseUrl}/audio/transcriptions`. Si lo hace, no hace falta código: basta con
elegir el motor compatible con OpenAI y poner la URL base. Ese único módulo ya
cubre OpenAI, Groq y cualquier Whisper propio.

## Detalles que hay que tener presentes

**Permisos.** Sin declarar `origenes` (o sin una URL base configurada), la llamada
al proveedor queda sujeta a CORS y será rechazada. El permiso se solicita al guardar
los ajustes.

**Tamaño.** Los trozos rondan 1,2 MB por cada cinco minutos a 32 kbps, así que los
límites por archivo de los proveedores no se alcanzan. Si tu motor tiene un límite
mucho más bajo, reduce los minutos por trozo en los ajustes en vez de partir el
audio dentro del motor.

**Formato.** El audio llega como `audio/webm;codecs=opus` mono. Si tu proveedor no
lo acepta, es señal de que hace falta convertir, y eso pertenece al motor, no al
orquestador.

**Idioma.** Pasa siempre `idioma` al proveedor cuando lo admita. Con audio en
español, dejar que el modelo lo detecte solo empeora los resultados y a veces
devuelve texto traducido al inglés.
