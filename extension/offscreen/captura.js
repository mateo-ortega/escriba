/**
 * Captura de audio en el documento offscreen.
 *
 * Por qué aquí y no en el service worker: un service worker de MV3 no tiene DOM
 * ni WebAudio ni MediaRecorder, y además Chrome lo apaga cuando queda inactivo.
 * El documento offscreen sí tiene todo eso y, al declarar el motivo
 * AUDIO_PLAYBACK, sobrevive toda la llamada.
 *
 * Diseño de dos pistas independientes, no un archivo estéreo:
 *
 *   micrófono  ->  pista "mic"  ->  eres tú
 *   pestaña    ->  pista "tab"  ->  todos los demás
 *
 * Cada pista se graba por separado, así que quién habla no se deduce: se sabe
 * por construcción. Eso también evita depender de que el motor de transcripción
 * soporte multicanal o diarización, y funciona igual con cualquiera de ellos.
 *
 * El audio de la pestaña se devuelve a los parlantes: si no se hace, capturar
 * una pestaña la silencia y dejas de oír la llamada.
 *
 * Los Blobs no sobreviven a `chrome.runtime.sendMessage` (los mensajes se
 * serializan como JSON), así que este documento escribe el audio directo a
 * IndexedDB en vez de pasárselo al service worker.
 */

import { guardarTrozo } from "../nucleo/almacen.js";

/** Cada cuánto se mide energía y se revisa si toca rotar de trozo. */
const MS_MUESTREO = 500;
/** Cada cuánto se persiste el trozo en curso, para resistir una caída. */
const MS_PERSISTENCIA = 30_000;
/** Tipo MIME de grabación. Opus en WebM lo aceptan todos los motores. */
const MIME = "audio/webm;codecs=opus";
/** 32 kbps por pista de voz mono: inteligible y liviano (~14 MB por hora). */
const BITS_POR_SEGUNDO = 32_000;

/** Estado de la captura en curso. Nulo si no hay nada grabando. */
let captura = null;

/** Estado de la captura, para el popup. */
export function estado() {
  return {
    grabando: Boolean(captura),
    sesionId: captura?.sesionId ?? null,
    msGrabados: captura ? Date.now() - captura.inicioMs : 0,
  };
}

/**
 * Arranca la captura de una llamada.
 *
 * Args:
 *   streamId: id de flujo devuelto por chrome.tabCapture.getMediaStreamId
 *   sesionId: identificador de la sesión que se está grabando
 *   config: configuración de Escriba (minutosPorTrozo, cancelarEco, ...)
 * Returns:
 *   resumen: { pistas: string[], aviso?: string }
 */
export async function iniciar(streamId, sesionId, config) {
  if (captura) throw new Error("Ya hay una grabación en curso.");

  const ctx = new AudioContext();
  const pistas = {};
  // Los flujos originales se guardan aparte: son los únicos que, al detenerlos,
  // liberan de verdad el micrófono y la captura de la pestaña. Detener las pistas
  // del destino de audio no libera ningún dispositivo.
  const flujos = [];
  let aviso;

  // --- Pestaña: la voz de los demás ---
  const flujoTab = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
  });
  flujos.push(flujoTab);
  const fuenteTab = ctx.createMediaStreamSource(flujoTab);
  // Devolver el audio a los parlantes. Sin esto, la pestaña queda muda.
  fuenteTab.connect(ctx.destination);
  pistas.tab = prepararPista(ctx, fuenteTab);

  // --- Micrófono: tu voz ---
  // Si el permiso no está concedido, se degrada a grabar solo la pestaña en vez
  // de fallar: media llamada es mucho mejor que ninguna.
  try {
    const flujoMic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: config.cancelarEco,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    flujos.push(flujoMic);
    pistas.mic = prepararPista(ctx, ctx.createMediaStreamSource(flujoMic));
  } catch (e) {
    aviso =
      "Sin acceso al micrófono: se graba solo la voz de los demás. " +
      "Concede el permiso desde las opciones de Escriba.";
    console.warn("[escriba] micrófono no disponible:", e);
  }

  captura = {
    sesionId,
    ctx,
    pistas,
    flujos,
    inicioMs: Date.now(),
    // Se sanean los dos números: un valor inválido dejaría la rotación colgada en
    // un único trozo gigante que reventaría el límite de tamaño de los motores.
    msPorTrozo: Math.min(15, Math.max(1, Number(config.minutosPorTrozo) || 5)) * 60_000,
    umbralSilencio: Number.isFinite(Number(config.umbralSilencio))
      ? Number(config.umbralSilencio)
      : 0.004,
    intervalo: null,
  };

  for (const nombre of Object.keys(pistas)) abrirTrozo(nombre);
  captura.intervalo = setInterval(muestrear, MS_MUESTREO);

  return { pistas: Object.keys(pistas), aviso };
}

/**
 * Prepara una pista: reduce a mono y deja un analizador para medir energía.
 *
 * El paso a mono es explícito porque el audio de la pestaña suele venir en
 * estéreo y conectarlo directo a un grabador mono se quedaría con un solo
 * canal en vez de mezclar los dos.
 *
 * Args:
 *   ctx: AudioContext compartido
 *   fuente: MediaStreamAudioSourceNode de la pista
 * Returns:
 *   pista: { destino, analizador, muestras, grabador, trozo, indice }
 */
function prepararPista(ctx, fuente) {
  const mono = ctx.createGain();
  mono.channelCount = 1;
  mono.channelCountMode = "explicit";
  mono.channelInterpretation = "speakers";
  fuente.connect(mono);

  const analizador = ctx.createAnalyser();
  analizador.fftSize = 2048;
  mono.connect(analizador);

  const destino = ctx.createMediaStreamDestination();
  // Sin forzar un canal, el destino toma los dos por defecto y la señal mono se
  // duplicaría en ambos: el mismo audio pesando el doble.
  destino.channelCount = 1;
  destino.channelCountMode = "explicit";
  mono.connect(destino);

  return {
    destino,
    analizador,
    muestras: new Float32Array(analizador.fftSize),
    grabador: null,
    trozo: null,
    indice: 0,
  };
}

/**
 * Abre un trozo nuevo en una pista y arranca su grabador.
 *
 * Cada trozo es un archivo WebM completo e independiente: se puede transcribir
 * solo, y una caída del navegador no invalida los anteriores.
 *
 * Args:
 *   nombre: "mic" o "tab"
 */
function abrirTrozo(nombre) {
  const pista = captura.pistas[nombre];
  // El trozo lleva consigo el origen de tiempos y el umbral porque se cierra de
  // forma asíncrona: cuando corren `onstop` y la persistencia final, el estado
  // global de la captura puede haber quedado ya en nulo.
  const trozo = {
    sesionId: captura.sesionId,
    pista: nombre,
    indice: pista.indice++,
    inicioSesionMs: captura.inicioMs,
    umbral: captura.umbralSilencio,
    inicioMs: Date.now() - captura.inicioMs,
    finMs: null,
    partes: [],
    rmsMaximo: 0,
    ultimaPersistencia: 0,
    completo: false,
  };
  pista.trozo = trozo;

  const grabador = new MediaRecorder(pista.destino.stream, {
    mimeType: MIME,
    audioBitsPerSecond: BITS_POR_SEGUNDO,
  });
  // El corte cada 2 s hace que los datos ya emitidos se puedan persistir: la
  // primera parte trae la cabecera WebM y las siguientes la continúan, así que
  // concatenar lo recibido hasta el momento produce un archivo válido.
  grabador.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) trozo.partes.push(ev.data);
    const ahora = Date.now();
    if (ahora - trozo.ultimaPersistencia > MS_PERSISTENCIA) {
      trozo.ultimaPersistencia = ahora;
      persistir(trozo, false);
    }
  };
  grabador.onstop = () => {
    trozo.finMs = Date.now() - trozo.inicioSesionMs;
    trozo.completo = true;
    persistir(trozo, true);
  };
  grabador.onerror = (ev) => console.error("[escriba] grabador", nombre, ev.error);
  grabador.start(2000);
  pista.grabador = grabador;
}

/**
 * Escribe un trozo en IndexedDB.
 *
 * Args:
 *   trozo: trozo en curso o cerrado
 *   final: verdadero si el trozo ya está completo
 */
async function persistir(trozo, final) {
  if (trozo.partes.length === 0) return;
  const blob = new Blob(trozo.partes, { type: MIME });
  try {
    await guardarTrozo({
      sesionId: trozo.sesionId,
      pista: trozo.pista,
      indice: trozo.indice,
      inicioMs: trozo.inicioMs,
      // Mientras el trozo sigue abierto el fin es "ahora"; al cerrarlo queda fijo.
      finMs: trozo.finMs ?? Date.now() - trozo.inicioSesionMs,
      silencioso: final ? trozo.rmsMaximo < trozo.umbral : false,
      rmsMaximo: trozo.rmsMaximo,
      completo: final,
      blob,
    });
  } catch (e) {
    console.error("[escriba] no se pudo persistir el trozo", e);
  }
}

/**
 * Late cada MS_MUESTREO: mide la energía de cada pista y rota los trozos
 * cuando toca.
 *
 * La energía sirve para marcar como silenciosos los trozos donde esa persona no
 * habló. Esos trozos no se mandan a transcribir, que es lo que hace asumible el
 * costo de grabar dos pistas en paralelo.
 */
function muestrear() {
  if (!captura) return;
  const transcurrido = Date.now() - captura.inicioMs;

  for (const [nombre, pista] of Object.entries(captura.pistas)) {
    pista.analizador.getFloatTimeDomainData(pista.muestras);
    let suma = 0;
    for (const v of pista.muestras) suma += v * v;
    const rms = Math.sqrt(suma / pista.muestras.length);
    if (pista.trozo && rms > pista.trozo.rmsMaximo) pista.trozo.rmsMaximo = rms;

    if (pista.trozo && transcurrido - pista.trozo.inicioMs >= captura.msPorTrozo) {
      rotar(nombre);
    }
  }
}

/** Cierra el trozo en curso de una pista y abre el siguiente. */
function rotar(nombre) {
  const pista = captura.pistas[nombre];
  if (pista.grabador?.state === "recording") pista.grabador.stop();
  abrirTrozo(nombre);
}

/**
 * Detiene la captura y libera el micrófono y la pestaña.
 *
 * Returns:
 *   resumen: { sesionId, duracionMs }
 */
export async function detener() {
  if (!captura) return { sesionId: null, duracionMs: 0 };
  const { sesionId, inicioMs } = captura;

  clearInterval(captura.intervalo);
  for (const pista of Object.values(captura.pistas)) {
    if (pista.grabador?.state === "recording") pista.grabador.stop();
  }
  // Margen para que el último `ondataavailable` y el `onstop` de cada grabador
  // alcancen a escribir antes de soltar el audio.
  await new Promise((r) => setTimeout(r, 400));

  // Ahora sí se liberan los dispositivos: el micrófono deja de aparecer como en
  // uso y la pestaña recupera su audio.
  for (const flujo of captura.flujos) {
    for (const t of flujo.getTracks()) t.stop();
  }
  await captura.ctx.close();

  const duracionMs = Date.now() - inicioMs;
  captura = null;
  return { sesionId, duracionMs };
}
