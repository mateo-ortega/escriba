/**
 * Destino: descargar la transcripción como archivo.
 *
 * Es el destino por defecto y el que hace que Escriba sirva por sí solo, sin
 * backend, sin cuenta y sin depender de ningún servicio.
 *
 * Debe llamarse desde un documento (el popup o el documento offscreen), nunca
 * desde el service worker: `URL.createObjectURL` no existe en un service worker.
 */

import { aTextoTrazable, aVtt, nombreArchivo } from "../formatos.js";

/**
 * Descarga la transcripción en el formato pedido.
 *
 * Args:
 *   intervenciones: [{inicioMs, finMs, hablante, texto}]
 *   meta: metadatos de la sesión (titulo, fecha, plataforma, motor, modelo)
 *   formato: "txt" o "vtt"
 * Returns:
 *   nombre: el nombre del archivo descargado
 */
export async function descargar(intervenciones, meta, formato = "txt") {
  const contenido =
    formato === "vtt" ? aVtt(intervenciones) : aTextoTrazable(intervenciones, meta);
  const tipo = formato === "vtt" ? "text/vtt" : "text/plain";
  const nombre = nombreArchivo(meta, formato);

  const url = URL.createObjectURL(new Blob([contenido], { type: `${tipo};charset=utf-8` }));
  try {
    await chrome.downloads.download({ url, filename: nombre, saveAs: false });
  } finally {
    // Se libera con holgura: revocar de inmediato puede cancelar la descarga
    // antes de que Chrome termine de leer el blob.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return nombre;
}
