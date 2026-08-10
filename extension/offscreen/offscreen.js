/**
 * Punto de entrada del documento offscreen.
 *
 * Un solo despachador de mensajes para todo el trabajo pesado: capturar,
 * transcribir y entregar. Va aquí y no en el service worker por tres razones
 * concretas: WebAudio y MediaRecorder no existen en un service worker,
 * `URL.createObjectURL` tampoco, y el worker se apaga cuando queda inactivo,
 * mientras que este documento aguanta la llamada completa.
 */

import { estado, iniciar, detener } from "./captura.js";
import { transcribirSesion } from "../nucleo/transcribir.js";
import {
  guardarTranscripcion,
  leerTranscripcion,
  borrarAudioDeSesion,
} from "../nucleo/almacen.js";
import { aTextoTrazable } from "../nucleo/formatos.js";
import { descargar } from "../nucleo/destinos/descarga.js";
import { enviarADiscovery } from "../nucleo/destinos/discovery.js";

chrome.runtime.onMessage.addListener((msg, _remitente, responder) => {
  if (msg?.destino !== "offscreen") return false;
  manejar(msg)
    .then((r) => responder({ ok: true, ...r }))
    .catch((e) => {
      console.error("[escriba] offscreen", msg?.tipo, e);
      responder({ ok: false, error: String(e?.message ?? e) });
    });
  return true; // respuesta asíncrona
});

async function manejar(msg) {
  switch (msg.tipo) {
    case "iniciar":
      return iniciar(msg.streamId, msg.sesionId, msg.config);
    case "detener":
      return detener();
    case "estado":
      return estado();
    case "procesar":
      return { resultado: await procesar(msg.sesionId, msg.config, msg.sesion, msg.subtitulos) };
    default:
      throw new Error(`Mensaje desconocido para offscreen: ${msg.tipo}`);
  }
}

/**
 * Transcribe una sesión y la entrega a su destino.
 *
 * Args:
 *   sesionId: identificador de la sesión
 *   config: configuración de Escriba
 *   sesion: metadatos de la sesión (titulo, fecha, plataforma, proyectoId)
 *   subtitulos: línea de tiempo de quién habló, recogida durante la llamada
 * Returns:
 *   resultado: { resumen, archivo, motor, modelo, intervenciones, trozosFallidos }
 */
async function procesar(sesionId, config, sesion, subtitulos) {
  // Si ya hay transcripción guardada no se vuelve a transcribir. Es el caso del
  // reintento: cuando lo que falló fue la entrega, el motor ya cobró su trabajo y
  // repetirlo sería pagar dos veces por el mismo audio. Además el audio pudo
  // haberse borrado ya, así que reusar es también lo único que funciona.
  const guardada = await leerTranscripcion(sesionId);

  const transcripcion =
    guardada ??
    (await transcribirSesion(sesionId, config, subtitulos, (hechos, total) => {
      chrome.runtime.sendMessage({ destino: "sw", tipo: "progreso", hechos, total }).catch(() => {});
    }));

  const meta = guardada?.meta ?? {
    titulo: sesion.titulo,
    fecha: sesion.fecha,
    plataforma: sesion.plataforma,
    participantes: sesion.participantes,
    duracionMs: sesion.duracionMs,
    motor: transcripcion.motor,
    modelo: transcripcion.modelo,
  };

  if (!guardada) {
    await guardarTranscripcion(sesionId, {
      intervenciones: transcripcion.intervenciones,
      texto: aTextoTrazable(transcripcion.intervenciones, meta),
      motor: transcripcion.motor,
      modelo: transcripcion.modelo,
      meta,
    });

    // El audio ya cumplió su función. Se conserva solo si se pidió
    // explícitamente: son grabaciones de conversaciones de clientes y no deben
    // quedarse por descuido en el navegador.
    if (!config.conservarAudio) await borrarAudioDeSesion(sesionId);
  }

  const entrega =
    config.destino === "discovery"
      ? await entregarADiscovery(config, sesion, transcripcion, meta)
      : { archivo: await descargar(transcripcion.intervenciones, meta, "txt") };

  const fallidos = transcripcion.trozosFallidos ?? [];
  return {
    ...entrega,
    motor: transcripcion.motor,
    modelo: transcripcion.modelo,
    intervenciones: transcripcion.intervenciones.length,
    trozosFallidos: fallidos,
    resumen:
      `${transcripcion.intervenciones.length} intervenciones` +
      (fallidos.length > 0 ? `, ${fallidos.length} trozo(s) sin transcribir` : ""),
  };
}

/**
 * Entrega la transcripción al Agente de Discovery.
 *
 * Si la entrega falla, la transcripción ya quedó guardada: se descarga como
 * archivo para que el trabajo no se pierda, y el error se propaga para que la
 * interfaz ofrezca reintentar.
 */
async function entregarADiscovery(config, sesion, transcripcion, meta) {
  try {
    const r = await enviarADiscovery(
      config,
      sesion.proyectoId,
      transcripcion.intervenciones,
      meta,
    );
    return { archivo: r.archivo, enviadoA: sesion.proyectoId };
  } catch (e) {
    await descargar(transcripcion.intervenciones, meta, "txt");
    throw new Error(
      `${e.message} La transcripción se descargó como archivo para que no se pierda.`,
    );
  }
}
